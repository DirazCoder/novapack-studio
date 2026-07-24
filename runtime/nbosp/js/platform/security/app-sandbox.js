/**
 * NovaByte — App Sandbox
 *
 * Creates secure execution environments for apps using sandboxed webviews with
 * process isolation. Each app gets its own renderer process, storage partition,
 * and a capability-scoped IPC bridge to host OS services (filesystem, network,
 * notifications, window manager, etc.).
 *
 * @module app-sandbox
 */

const AppSandbox = (() => {
  'use strict';

  // Module state

  // Active sandboxes keyed by sandboxId. Each value holds the webview element,
  // app metadata, window state, WebSocket connections, and a teardown function.
  const activeSandboxes = new Map();

  // Event subscriptions keyed by sandboxId, then event name -> handler.
  // Kept in a separate map so cleanup can iterate without touching the sandbox
  // object's other fields.
  const eventSubscriptions = new Map();

  // Open file dialogs keyed by sandboxId, so we can tear them down when a
  // sandbox is destroyed mid-dialog (prevents orphaned overlays in the DOM).
  const openDialogs = new Map();

  // Constants

  const API_PREFIX = 'nova:';
  // Allow word chars, dash, dot, space. Anything else (slashes, colons) is
  // rejected to prevent key injection across app namespaces.
  const STORAGE_KEY_REGEX = /^[\w\-. ]+$/;
  const STORAGE_VALUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per single value
  const STORAGE_APP_QUOTA_BYTES = 25 * 1024 * 1024; // 25 MB total per app
  const CLIPBOARD_HISTORY_MAX = 30;
  const ALLOWED_HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  ]);
  const ALLOWED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
  // Hostnames that count as "internal" for permission gating, beyond
  // whatever isInternalHost's IP-range checks already catch. Named
  // first-party internal services live here since they don't resolve to
  // a fixed literal IP we could range-check.
  const INTERNAL_HOSTS = new Set([
    'localhost', 'api.novabyte.internal',
  ]);
  const DEFAULT_WINDOW_WIDTH = 800;
  const DEFAULT_WINDOW_HEIGHT = 600;
  const MIN_WINDOW_DIMENSION = 100;
  const DIALOG_FOCUS_DELAY_MS = 50;
  const DOWNLOAD_DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap on save dialog
  const CLEAR_PARTITION_TIMEOUT_MS = 4000;

  // Notification gateway
  // Sandboxed apps never touch Notify.show() directly — everything funnels
  // through handleNotificationsShow, which enforces the limits below. This is
  // the actual security boundary: Notify.show() itself will happily execute a
  // function passed as `action` (trusted first-party callers rely on that),
  // so an app-facing payload must never pass anything but plain data through.
  const NOTIF_TITLE_MAX_LEN = 120;
  const NOTIF_BODY_MAX_LEN = 500;
  const NOTIF_ACTION_LABEL_MAX_LEN = 40;
  const ALLOWED_NOTIF_TYPES = new Set(['info', 'success', 'warning', 'error']);
  // Matches the icon set actually implemented by svgIcon() elsewhere in the
  // OS; anything else falls back to the default rather than being passed
  // through to markup/attribute contexts uninspected.
  const ALLOWED_NOTIF_ICONS = new Set([
    'archive', 'bell', 'bookmark', 'box', 'clock', 'file', 'folder', 'globe',
    'image', 'layout', 'lock', 'monitor', 'music', 'package', 'play', 'refresh',
    'search', 'sound', 'star', 'unlock', 'users', 'x',
  ]);
  // Built-in action strings handleable by Notify.showToast()'s action-button
  // switch statement. Anything else is dropped rather than forwarded, since
  // an unrecognized string is silently ignored downstream anyway (console.warn)
  // but there's no reason to let an app probe for future built-ins.
  const ALLOWED_NOTIF_ACTIONS = new Set(['settings', 'open-settings', 'openSettings']);
  // Sliding-window rate limit: N notifications per app per window.
  const NOTIF_RATE_LIMIT_MAX = 10;
  const NOTIF_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  // appId -> array of timestamps (ms) within the current window.
  const notifRateLimitLog = new Map();

  // Built-in apps allowed to use allow-same-origin in their sandbox attr
  // without a separate permission grant. These are audited first-party apps
  // whose code ships with the OS, so the same-origin risk is acceptable.
  const SYSTEM_SANDBOX_APPS = new Set([
    'nook', 'app-manager', 'browser', 'nbosp-email', 'nbosp-gallery',
    'nbosp-downloads', 'nbosp-search', 'nbosp-music', 'nbosp-contacts',
    'calendar-app', 'calculator', 'nbosp-clock', 'quill', 'vault', 'shell',
  ]);

  // Shared TextEncoder for the base64 helpers — cheap to construct, but no
  // reason to allocate a new one per call when IPC traffic is high-frequency.
  const sharedTextEncoder = new TextEncoder();
  const sharedTextDecoder = new TextDecoder();

  // Utility helpers

  // Generate a unique request ID for IPC correlation. Prefers crypto.randomUUID
  // when available; falls back to timestamp + random otherwise.
  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `req_${crypto.randomUUID()}`;
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  // Generate a unique sandbox ID. Uses crypto.randomUUID for collision
  // resistance — Date.now() alone can collide if two sandboxes are created
  // in the same millisecond.
  function generateSandboxId(appId) {
    const unique = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    return `sandbox_${appId}_${unique}`;
  }

  // Escape a string for safe HTML interpolation. Used whenever app-supplied
  // metadata (name, author, etc.) is embedded into the default shell or error
  // page. Without this, a malicious package could inject <script> tags.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // UTF-8 safe base64 encoding. btoa() throws on non-Latin1 characters, so app
  // HTML containing emoji or CJK content would crash the loader. We go through
  // TextEncoder so the full Unicode range survives the round-trip.
  function encodeBase64Utf8(text) {
    const bytes = sharedTextEncoder.encode(text);
    if (typeof bytes.toBase64 === 'function') {
      return bytes.toBase64();
    }
    // Legacy fallback for runtimes without Uint8Array.toBase64 (pre-ES2026).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // Inverse of encodeBase64Utf8.
  function decodeBase64Utf8(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return sharedTextDecoder.decode(Uint8Array.fromBase64(b64));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return sharedTextDecoder.decode(bytes);
  }

  // Structured logger. Debug-level messages are gated on a window flag so
  // production builds stay quiet unless an operator opts in.
  function log(level, message, ...rest) {
    const prefix = '[AppSandbox]';
    if (level === 'error') console.error(prefix, message, ...rest);
    else if (level === 'warn') console.warn(prefix, message, ...rest);
    else if (level === 'debug') {
      if (typeof window !== 'undefined' && window.__NOVA_SANDBOX_DEBUG__) {
        console.debug(prefix, message, ...rest);
      }
    } else {
      console.log(prefix, message, ...rest);
    }
  }

  // Resolve a URL string against the current origin and classify it as
  // internal or external. Handles protocol-relative URLs (//host/path) safely
  // by always resolving through new URL(rawUrl, window.location.origin).
  //
  // Without this, an app could pass "//evil.com/foo" to net:fetch and have it
  // treated as internal because the original check only looked at the leading
  // "/" character.
  function resolveAndClassifyUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return { valid: false, error: 'Invalid URL' };
    }
    let resolved;
    try {
      resolved = new URL(rawUrl, window.location.origin);
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
    if (!ALLOWED_WEB_PROTOCOLS.has(resolved.protocol)) {
      return { valid: false, error: 'Only http and https URLs are allowed' };
    }
    return {
      valid: true,
      url: resolved.href,
      isInternal: isInternalHost(resolved.hostname),
    };
  }

  // Parse a dotted-decimal IPv4 string into 4 octets, or null if it isn't
  // one. `URL` already normalizes alternate encodings (hex, octal, decimal-
  // integer, short forms like "127.1") into plain dotted-decimal before this
  // ever sees the hostname, so a strict dotted-decimal parse here is safe —
  // it's not re-opening the encodings URL already collapsed.
  function parseIPv4(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const octets = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      octets.push(n);
    }
    return octets;
  }

  // True if the given IPv4 octets fall in a loopback/private/link-local
  // range — i.e. anything that isn't routable "external" address space.
  // Covers: 127.0.0.0/8 (all loopback, not just .1), 10.0.0.0/8,
  // 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local, which
  // includes the 169.254.169.254 cloud metadata endpoint), and 0.0.0.0.
  function isPrivateIPv4(octets) {
    const [a, b] = octets;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true;
    return false;
  }

  // True if a normalized IPv6 literal (no brackets, lowercase — which is
  // what URL.hostname already gives us) is loopback/private/link-local, or
  // wraps an internal IPv4 address (IPv4-mapped ::ffff:a.b.c.d or the
  // legacy IPv4-compatible ::a.b.c.d form).
  function isPrivateIPv6(hostname) {
    if (hostname === '::1' || hostname === '::') return true;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — the
    // embedded IPv4 address is what actually gets routed to, so classify
    // by that.
    const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(hostname);
    if (mapped) {
      const octets = parseIPv4(mapped[1]);
      return octets ? isPrivateIPv4(octets) : false;
    }
    return false;
  }

  function isInternalHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (INTERNAL_HOSTS.has(h)) return true;

    const v4 = parseIPv4(h);
    if (v4) return isPrivateIPv4(v4);

    // URL.hostname strips brackets from IPv6 literals, but check both
    // forms defensively in case this is ever called with a raw value.
    const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    if (v6.includes(':')) return isPrivateIPv6(v6);

    return false;
  }

  // Validate that a value is a positive integer within optional bounds.
  // Returns the parsed integer or the fallback when invalid.
  function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  // Sanitize an app id for safe interpolation into a /data/ path segment.
  // Strips anything that isn't word char, dash, dot, or underscore.
  function sanitizeAppIdSegment(appId) {
    return String(appId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  // Notification gateway helpers

  // Strictly whitelist and clamp an app-supplied notification payload before
  // it ever reaches Notify.show(). This is the actual security boundary:
  // Notify.show() itself will call `action` if it's a function (trusted
  // first-party callers rely on that), so nothing but plain, bounded data
  // may cross from a sandboxed app into that call.
  function sanitizeNotificationPayload(payload, appName, appId) {
    const raw = payload ?? {};

    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.slice(0, NOTIF_TITLE_MAX_LEN)
      : 'Notification';
    const body = typeof raw.body === 'string'
      ? raw.body.slice(0, NOTIF_BODY_MAX_LEN)
      : '';
    const type = ALLOWED_NOTIF_TYPES.has(raw.type) ? raw.type : 'info';
    const icon = ALLOWED_NOTIF_ICONS.has(raw.icon) ? raw.icon : null;

    // `action` must never be forwarded as anything but a plain, known string.
    // A function reference (or any other type) is dropped entirely rather
    // than coerced, since coercion here is exactly how a sandbox escape
    // would sneak through.
    const action = typeof raw.action === 'string' && ALLOWED_NOTIF_ACTIONS.has(raw.action)
      ? raw.action
      : null;
    const actionLabel = action && typeof raw.actionLabel === 'string'
      ? raw.actionLabel.slice(0, NOTIF_ACTION_LABEL_MAX_LEN)
      : null;

    return {
      title,
      body,
      type,
      // Clamp appName too — a malicious manifest could declare an absurdly
      // long name that would blow past Notify's layout assumptions.
      appName: typeof appName === 'string' ? appName.slice(0, NOTIF_TITLE_MAX_LEN) : 'App',
      appId,
      icon,
      action,
      actionLabel,
      category: 'app',
    };
  }

  // Sliding-window rate limit: returns true if `appId` is still under
  // NOTIF_RATE_LIMIT_MAX notifications within the last
  // NOTIF_RATE_LIMIT_WINDOW_MS, recording this attempt if so. Returns false
  // (and does not record) if the app is over the limit.
  function checkNotificationRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - NOTIF_RATE_LIMIT_WINDOW_MS;
    const timestamps = (notifRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);

    if (timestamps.length >= NOTIF_RATE_LIMIT_MAX) {
      notifRateLimitLog.set(appId, timestamps);
      return false;
    }

    timestamps.push(now);
    notifRateLimitLog.set(appId, timestamps);
    return true;
  }

  // Drop the rate-limit entry for an app. Called on uninstall so the log
  // doesn't grow unbounded across the app's install/uninstall lifecycle.
  function clearNotificationRateLimit(appId) {
    notifRateLimitLog.delete(appId);
  }

  // Response helpers

  // Send a response back to the sandboxed app.
  //
  // <webview> guests have no parent/embedder window reference at all
  // (window.parent === window for a <webview> guest — confirmed empirically,
  // and matches spec: a window with no parent has parent === itself).
  // postMessage from the host to some captured "source" reference was never
  // reachable, because no such reference is ever set — the guest can't
  // postMessage to the host either, for the same reason (see setupAPIBridge,
  // which reads guest->host messages via the webview's 'consolemessage' DOM
  // event instead).
  //
  // For host->guest, webview.executeScript(...) is a real, confirmed-working
  // NW.js API already used elsewhere in this codebase (see browser.js's
  // URL/title polling and context-menu injection). This pushes the response
  // directly into a well-known array (window.__novaInbox), which the
  // isolated-world transport script's poller drains and relays on to the
  // main-world capability shim via postMessage.
  //
  // Deliberately NOT { mainWorld: true } here — window.__novaInbox now
  // lives inside the isolated-world transport script injected via
  // addContentScripts (see buildIsolatedTransportScript), not on the
  // guest's own main-world window. executeScript's default (mainWorld:
  // false / omitted) targets that same isolated world, which is exactly
  // where this needs to land. A guest page's own script — including one
  // that has redefined window.__novaInbox, Array.prototype methods, or
  // anything else in its own main-world realm — cannot see or interfere
  // with this call, because isolated and main worlds share the DOM but
  // not JS globals.
  //
  // Data is passed as base64-encoded JSON rather than interpolated directly
  // into the injected code string. JSON.stringify does not escape backticks
  // or `${...}`, so an app-supplied value living inside `result` (e.g. an
  // echoed filename) could otherwise break out of the template literal below
  // and run arbitrary code in the target context. Base64's alphabet
  // (A-Za-z0-9+/=) can't contain any of those characters, so splicing it in
  // needs no further escaping. We embed it via JSON.stringify so the JS
  // string literal is well-formed regardless of base64 padding characters.
  function respond(webview, type, requestId, result, error = null) {
    try {
      const json = JSON.stringify({ type: `${type}:response`, requestId, result, error });
      const b64 = encodeBase64Utf8(json);
      const b64Literal = JSON.stringify(b64);
      // The injected code returns true on success / false on a caught parse
      // error, so the executeScript callback's results array actually means
      // something. executeScript's callback is (results), not (err); the
      // injected push statement returns undefined either way, so we wrap it
      // in a try/catch that returns a boolean.
      const code = `(function(){try{window.__novaInbox=window.__novaInbox||[];window.__novaInbox.push(JSON.parse(atob(${b64Literal})));return true;}catch(e){return false;}})();`;
      if (typeof webview?.executeScript !== 'function') {
        log('warn', `Cannot respond to ${type}: webview executeScript unavailable`);
        return;
      }
      webview.executeScript({ code }, (results) => {
        const delivered = Array.isArray(results) ? results[0] : results;
        if (delivered !== true) {
          log('error', `Failed to respond to ${type} (guest-side delivery failed or webview unavailable)`);
        }
      });
    } catch (e) {
      log('error', `Failed to respond to ${type}:`, e);
    }
  }

  // Error codes worth surfacing in the Events app. NOT_FOUND / UNAVAILABLE are
  // routine and would just add noise; PERMISSION_DENIED, RATE_LIMITED, and
  // anything else (unrecognized codes lean toward "new/unexpected", so they're
  // included by default) are the ones a dev actually wants to see happen live.
  const IPC_ERROR_LOG_SKIP = new Set(['NOT_FOUND', 'UNAVAILABLE']);

  function respondError(webview, type, requestId, code, message) {
    if (typeof EventLog !== 'undefined' && !IPC_ERROR_LOG_SKIP.has(code)) {
      const appId = webview?.dataset?.appId || 'unknown';
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: code === 'PERMISSION_DENIED' || code === 'RATE_LIMITED' ? 'warn' : 'error',
        message: `${appId}: ${type} → ${code}${message ? ' — ' + message : ''}`,
        data: { appId, type, code },
      });
    }
    respond(webview, type, requestId, null, { code, message });
  }

  // Filesystem helpers

  // Resolve a payload (with either `path` or `id`) to a file node.
  // Any /data/<segment>/... path belongs to whichever app's id that
  // segment is — this is the convention every fs:write/mkdir path-rewrite
  // already relies on. Re-derived from the node's own canonical path
  // (FS.getPath), never from whatever the caller claims, since an app
  // could otherwise resolve by raw id and bypass a path-based check
  // entirely.
  function ownerAppIdForPath(canonicalPath) {
    const m = /^\/data\/([^/]+)(?:\/|$)/.exec(canonicalPath || '');
    return m ? m[1] : null;
  }

  // requireOwnAppData: true for write/delete/rename/move — these can only
  // ever touch the calling app's own /data/<appId>/ subtree, full stop.
  // false for read — apps can see the shared/general tree (anything not
  // under any app's /data/ prefix) plus their own /data/<appId>/, but
  // never another app's /data/<otherAppId>/. This mirrors how mobile
  // scoped storage splits "your own sandboxed folder" from "the general
  // shared area" without handing out unrestricted access to other apps'
  // private data either way.
  //
  // Resolving by raw `id` used to skip this check entirely — any granted
  // vfs:read/write/delete could reach any file's node directly as long as
  // it knew (or guessed/enumerated) an id, regardless of which app's
  // /data/ folder it actually lived in. That's the bug this closes.
  function resolveFile(payload, appId, requireOwnAppData) {
    const { path, id } = payload ?? {};
    let node = null;
    if (id) {
      node = FS.files.get(id) || null;
    } else if (path) {
      const rewritten = String(path).startsWith('/data/')
        ? '/data/' + sanitizeAppIdSegment(appId) + String(path).slice('/data'.length)
        : path;
      node = FS.getByPath(rewritten);
    } else {
      return null;
    }
    if (!node) return null;

    const canonicalPath = FS.getPath(node.id);
    const ownerAppId = ownerAppIdForPath(canonicalPath);
    const safeAppId = sanitizeAppIdSegment(appId);

    if (ownerAppId !== null) {
      // Node lives under some app's /data/ folder. Only that app may
      // touch it, for read or otherwise.
      if (ownerAppId !== safeAppId) return null;
    } else if (requireOwnAppData) {
      // Shared/general-area node, but this call is a mutation
      // (write/delete/rename/move) — those are restricted to the
      // calling app's own /data/<appId>/ subtree only, never the
      // shared area, regardless of what vfs:read would allow.
      return null;
    }
    return node;
  }

  // Convert a file node to a safe serializable object.
  function fileToJSON(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size,
      path: FS.getPath(node.id),
      parentId: node.parentId,
      created: node.created,
      modified: node.modified,
      accessed: node.accessed,
      permissions: node.permissions,
      sha256: node.sha256,
      tags: node.tags || [],
    };
  }

  // Rewrite a /data/-prefixed path so the segment immediately after /data/
  // is the calling app's own id. Returns the original path unchanged if it
  // doesn't start with /data/. Used by the write/mkdir/move handlers to
  // normalize before FS.getByPath.
  function rewriteDataPath(rawPath, appId) {
    const p = String(rawPath || '');
    if (!p.startsWith('/data/')) return p;
    return '/data/' + sanitizeAppIdSegment(appId) + p.slice('/data'.length);
  }

  // File dialog

  // Show a file open/save dialog. The dialog is a custom overlay so it matches
  // the NovaByte visual style. The visuals are kept identical to the original
  // implementation — only internal cleanup wiring has changed.
  function showFileDialog(mode, webview, type, requestId, app, payload) {
    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.zIndex = '100001';

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #0e121c; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 24px; max-width: 620px; width: 92%;
      max-height: 80vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      font-family: var(--font-ui, system-ui, sans-serif);
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'color: #e6edf3; margin: 0 0 4px; font-size: 16px; font-weight: 700;';
    title.textContent = mode === 'open' ? '📂 Open File' : '💾 Save File';
    dialog.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'color: #8b949e; margin: 0 0 12px; font-size: 12px;';
    subtitle.textContent = payload.title || `Select a ${mode === 'open' ? 'file to open' : 'location to save'}`;
    dialog.appendChild(subtitle);

    const filter = payload.filter || payload.accept || null;
    if (filter) {
      const filterEl = document.createElement('p');
      filterEl.style.cssText = 'color: #d29922; margin: 0 0 12px; font-size: 11px;';
      filterEl.textContent = `Filter: ${Array.isArray(filter) ? filter.join(', ') : filter}`;
      dialog.appendChild(filterEl);
    }

    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;';
    dialog.appendChild(pathBar);

    const fileList = document.createElement('div');
    fileList.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.02);';

    let currentFolderId = FS.rootId;
    let selectedFile = null;

    function renderFileList() {
      fileList.innerHTML = '';
      const children = FS.listDir(currentFolderId);

      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 24px; text-align: center; color: #8b949e; font-size: 13px;';
        empty.textContent = '(empty folder)';
        fileList.appendChild(empty);
      }

      for (const item of children) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 4px; transition: background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(88,166,255,0.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

        const icon = document.createElement('span');
        icon.textContent = item.type === 'folder' ? '📁' : '📄';
        icon.style.fontSize = '16px';

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; color: #e6edf3; font-size: 13px;';
        name.textContent = item.name;

        const meta = document.createElement('span');
        meta.style.cssText = 'color: #8b949e; font-size: 11px; font-family: monospace;';
        if (item.type === 'file') {
          const size = item.size || 0;
          meta.textContent = size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(meta);

        if (item.type === 'folder') {
          row.addEventListener('click', () => {
            currentFolderId = item.id;
            renderBreadcrumb();
            renderFileList();
            selectedFile = null;
            updateConfirmState();
          });
        } else {
          row.addEventListener('click', () => {
            if (selectedFile === item.id) {
              selectedFile = null;
              row.style.background = 'transparent';
            } else {
              selectedFile = item.id;
              fileList.querySelectorAll('[data-selected]').forEach(el => {
                el.style.background = 'transparent';
                el.removeAttribute('data-selected');
              });
              row.style.background = 'rgba(88,166,255,0.15)';
              row.setAttribute('data-selected', 'true');
            }
            updateConfirmState();
          });

          if (mode === 'save' && item.name === (payload.suggestedName || '')) {
            selectedFile = item.id;
            row.style.background = 'rgba(88,166,255,0.15)';
            row.setAttribute('data-selected', 'true');
          }
        }

        fileList.appendChild(row);
      }
    }

    function renderBreadcrumb() {
      pathBar.innerHTML = '';
      const parts = [];
      let node = FS.files.get(currentFolderId);
      while (node) {
        parts.unshift(node);
        node = FS.files.get(node.parentId);
      }

      parts.forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.style.cssText = 'color: #8b949e;';
          sep.textContent = '/';
          pathBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.style.cssText = 'background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 3px;';
        btn.textContent = part.name;
        btn.addEventListener('click', () => {
          currentFolderId = part.id;
          renderBreadcrumb();
          renderFileList();
        });
        if (i === parts.length - 1) {
          btn.style.color = '#e6edf3';
          btn.style.fontWeight = '600';
          btn.style.cursor = 'default';
        }
        pathBar.appendChild(btn);
      });
    }

    let filenameInput = null;
    if (mode === 'save') {
      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';

      const label = document.createElement('label');
      label.style.cssText = 'color: #8b949e; font-size: 12px; white-space: nowrap;';
      label.textContent = 'Filename:';

      filenameInput = document.createElement('input');
      filenameInput.type = 'text';
      filenameInput.value = payload.suggestedName || '';
      filenameInput.placeholder = 'Enter filename...';
      filenameInput.style.cssText = 'flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e6edf3; font-size: 13px;';
      filenameInput.addEventListener('input', () => {
        selectedFile = null;
        updateConfirmState();
      });

      inputRow.appendChild(label);
      inputRow.appendChild(filenameInput);
      // Insert the filename row before the file list so the visual order is
      // breadcrumb → filename input → file list → buttons.
      dialog.appendChild(inputRow);
    }

    dialog.appendChild(fileList);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 8px 18px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; transition: all 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'rgba(255,255,255,0.05)'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
    cancelBtn.addEventListener('click', () => {
      closeDialog();
      respond(webview, type, requestId, { cancelled: true });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = mode === 'open' ? 'Open' : 'Save';
    confirmBtn.style.cssText = 'padding: 8px 18px; border: none; border-radius: 6px; background: #58a6ff; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s;';
    confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3a8be6'; });
    confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#58a6ff'; });
    confirmBtn.disabled = mode === 'open';

    function updateConfirmState() {
      if (mode === 'open') {
        confirmBtn.disabled = !selectedFile;
      } else {
        confirmBtn.disabled = !(filenameInput && filenameInput.value.trim());
      }
    }

    confirmBtn.addEventListener('click', async () => {
      if (mode === 'open') {
        if (!selectedFile) return;
        const node = FS.files.get(selectedFile);
        if (!node || node.type === 'folder') return;
        closeDialog();
        respond(webview, type, requestId, {
          success: true,
          file: {
            id: node.id,
            name: node.name,
            content: node.content || '',
            mimeType: node.mimeType || 'text/plain',
            size: node.size || 0,
            path: FS.getPath(node.id),
          },
        });
      } else {
        const name = filenameInput.value.trim();
        if (!name) return;
        const content = payload.content || '';
        const mimeType = payload.mimeType || 'text/plain';
        try {
          const newNode = await FS.createFile(currentFolderId, name, content, mimeType);
          closeDialog();
          respond(webview, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id),
            },
          });
        } catch (e) {
          closeDialog();
          respondError(webview, type, requestId, 'WRITE_ERROR', e.message || 'Failed to write file');
        }
      }
    });

    // Closes the dialog overlay and unregisters it from the openDialogs map
    // so destroy() knows it's no longer pending.
    function closeDialog() {
      overlay.remove();
      const sid = webview.dataset.sandboxId;
      if (sid && openDialogs.get(sid) === overlay) {
        openDialogs.delete(sid);
      }
    }

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Track the open dialog so destroy() can clean it up if the sandbox is
    // torn down while the user is still picking a file.
    const sandboxId = webview.dataset.sandboxId;
    if (sandboxId) openDialogs.set(sandboxId, overlay);

    renderBreadcrumb();
    renderFileList();

    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), DIALOG_FOCUS_DELAY_MS);
    }
  }

  // IPC handlers
  //
  // Each handler is a named async function that receives a context object
  // with { payload, requestId, app, webview, sandbox }. Handlers that respond
  // synchronously call respond/respondError before returning; async handlers
  // (geolocation, websocket, file dialog) return without responding and send
  // the response later from a callback.

  // Filesystem

  async function handleFsRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:vfs:read', requestId, 'PERMISSION_DENIED', 'vfs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:read', requestId, 'NOT_FOUND', 'File or folder not found');
    if (node.type === 'folder') {
      const children = FS.listDir(node.id);
      return respond(webview, 'nova:vfs:read', requestId, {
        success: true,
        isFolder: true,
        name: node.name,
        id: node.id,
        path: FS.getPath(node.id),
        children: children.map(c => ({
          id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
          size: c.size, modified: c.modified, created: c.created,
        })),
      });
    }
    return respond(webview, 'nova:vfs:read', requestId, {
      success: true,
      data: node.content,
      mimeType: node.mimeType,
      name: node.name,
      size: node.size,
      id: node.id,
      path: FS.getPath(node.id),
      modified: node.modified,
      created: node.created,
    });
  }

  async function handleFsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    const { path, content, mimeType } = payload ?? {};
    if (!path || content === undefined) {
      return respondError(webview, 'nova:vfs:write', requestId, 'INVALID_ARGS', 'path and content are required');
    }
    const resolvedPath = rewriteDataPath(path, app.id);
    let node = FS.getByPath(resolvedPath);
    if (node) {
      if (node.type === 'folder') {
        return respondError(webview, 'nova:vfs:write', requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
      }
      // Same ownership rule resolveFile enforces for write/delete/rename/
      // move: a write can only ever land inside the calling app's own
      // /data/<appId>/ subtree. The /data/-prefix rewrite above already
      // forces the caller's own id in for /data/-prefixed input, but a
      // resolved node reached some other way (e.g. matching an existing
      // path that happens to fall under a *different* app's /data/
      // folder despite the caller not prefixing with /data/ at all)
      // wasn't re-checked before this fix.
      if (!resolveFile({ id: node.id }, app.id, true)) {
        return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'Path is outside this app\'s data directory');
      }
      await FS.writeFile(node.id, content);
      return respond(webview, 'nova:vfs:write', requestId, { success: true, id: node.id });
    }
    const parts = resolvedPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:write', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    if (!resolveFile({ id: parent.id }, app.id, true)) {
      return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'Parent folder is outside this app\'s data directory');
    }
    // Coerce content to a string for FS.createFile. Strings pass through;
    // anything else is JSON-stringified so structured data round-trips
    // cleanly rather than becoming "[object Object]".
    const fileContent = typeof content === 'string' ? content : JSON.stringify(content);
    const newNode = await FS.createFile(parent.id, fileName, fileContent, mimeType || 'text/plain');
    return respond(webview, 'nova:vfs:write', requestId, {
      success: true,
      id: newNode.id,
      path: FS.getPath(newNode.id),
    });
  }

  async function handleFsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:delete', app.id)) {
      return respondError(webview, 'nova:vfs:delete', requestId, 'PERMISSION_DENIED', 'vfs:delete permission required');
    }
    const node = resolveFile(payload, app.id, true);
    if (!node) return respondError(webview, 'nova:vfs:delete', requestId, 'NOT_FOUND', 'File not found');
    if (payload.permanent) {
      await FS.permanentDelete(node.id);
    } else {
      await FS.deleteToTrash(node.id);
    }
    return respond(webview, 'nova:vfs:delete', requestId, { success: true });
  }

  async function handleFsList({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:vfs:list', requestId, 'PERMISSION_DENIED', 'vfs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:list', requestId, 'NOT_FOUND', 'Folder not found');
    if (node.type !== 'folder') {
      return respondError(webview, 'nova:vfs:list', requestId, 'INVALID_OPERATION', 'Path is not a folder');
    }
    const children = FS.listDir(node.id);
    return respond(webview, 'nova:vfs:list', requestId, {
      success: true,
      path: FS.getPath(node.id),
      files: children.map(c => ({
        id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
        size: c.size, modified: c.modified, created: c.created,
      })),
    });
  }

  async function handleFsMkdir({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    const { path, name } = payload ?? {};
    if (!name) {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'INVALID_ARGS', 'name is required');
    }
    const resolvedPath = rewriteDataPath(path, app.id);
    let parent;
    if (resolvedPath) {
      parent = FS.getByPath(resolvedPath);
    } else {
      parent = FS.files.get(FS.rootId);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    // Same mutation-scoping rule as write/delete/rename/move — a new
    // folder can only be created inside the calling app's own
    // /data/<appId>/ subtree.
    if (!resolveFile({ id: parent.id }, app.id, true)) {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'PERMISSION_DENIED', 'Parent folder is outside this app\'s data directory');
    }
    const newFolder = await FS.createFolder(parent.id, name);
    return respond(webview, 'nova:vfs:mkdir', requestId, {
      success: true,
      id: newFolder.id,
      path: FS.getPath(newFolder.id),
    });
  }

  async function handleFsStat({ payload, requestId, app, webview }) {
    // vfs:metadata is the narrower, lower-risk permission this channel is
    // actually meant to gate on — it existed in PERMISSION_TYPES/
    // PERMISSION_CATEGORIES as a real, distinct entry but this handler was
    // never updated to check it, so it was silently dead. vfs:read still
    // satisfies this too, since full read access is a superset of
    // metadata-only access.
    const hasMetadata = AppPermissionManager.isGranted('vfs:metadata', app.id);
    const hasRead = AppPermissionManager.isGranted('vfs:read', app.id);
    if (!hasMetadata && !hasRead) {
      return respondError(webview, 'nova:vfs:stat', requestId, 'PERMISSION_DENIED', 'vfs:metadata or vfs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:stat', requestId, 'NOT_FOUND', 'File not found');
    return respond(webview, 'nova:vfs:stat', requestId, { success: true, stat: fileToJSON(node) });
  }

  async function handleFsRename({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:vfs:rename', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    const node = resolveFile(payload, app.id, true);
    if (!node) return respondError(webview, 'nova:vfs:rename', requestId, 'NOT_FOUND', 'File not found');
    if (!payload.name) {
      return respondError(webview, 'nova:vfs:rename', requestId, 'INVALID_ARGS', 'name is required');
    }
    await FS.rename(node.id, payload.name);
    return respond(webview, 'nova:vfs:rename', requestId, { success: true, name: payload.name });
  }

  async function handleFsMove({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:vfs:move', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    const node = resolveFile(payload, app.id, true);
    if (!node) return respondError(webview, 'nova:vfs:move', requestId, 'NOT_FOUND', 'File not found');
    const destPath = rewriteDataPath(payload.destPath, app.id);
    const destParent = destPath ? FS.getByPath(destPath) : null;
    if (!destParent || destParent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:move', requestId, 'NOT_FOUND', 'Destination folder not found');
    }
    // Same requireOwnAppData=true rule applies to the destination: a move
    // is still a mutation even though it only touches the target folder's
    // listing, not the target's own content — an app moving its own file
    // into another app's /data/<otherAppId>/ would otherwise be able to
    // plant files there despite never having write access to that folder
    // directly.
    if (!resolveFile({ id: destParent.id }, app.id, true)) {
      return respondError(webview, 'nova:vfs:move', requestId, 'PERMISSION_DENIED', 'Destination folder is outside this app\'s data directory');
    }
    await FS.move(node.id, destParent.id);
    return respond(webview, 'nova:vfs:move', requestId, { success: true, path: FS.getPath(node.id) });
  }

  // Notifications

  async function handleNotificationsShow({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Notify may be absent in headless test environments. Report UNAVAILABLE
    // rather than silently claiming success — apps deserve to know.
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') {
      return respondError(webview, 'nova:notifications:show', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    if (!checkNotificationRateLimit(app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'RATE_LIMITED', `Max ${NOTIF_RATE_LIMIT_MAX} notifications per minute`);
    }
    Notify.show(sanitizeNotificationPayload(payload, app.name, app.id));
    return respond(webview, 'nova:notifications:show', requestId, { success: true });
  }

  async function handleNotificationsClear({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:clear', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.clearForApp !== 'function') {
      return respondError(webview, 'nova:notifications:clear', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.clearForApp(app.id);
    return respond(webview, 'nova:notifications:clear', requestId, { success: true });
  }

  // Background wake (system:background)
  //
  // Lets a wake handler signal early completion — see AppScheduler.wake,
  // which is the only thing that ever creates the kind of sandbox this
  // gets called from. No permission check needed here: by the time this
  // sandbox exists at all, the scheduler has already verified
  // system:background before spinning it up, and this call does nothing
  // more than flip a flag the scheduler is already polling for.
  async function handleBackgroundWakeDone({ requestId, app, webview }) {
    if (typeof AppScheduler !== 'undefined' && AppScheduler._markWakeDone) {
      AppScheduler._markWakeDone(webview.dataset.sandboxId);
    }
    return respond(webview, 'nova:background:wake-done', requestId, { success: true });
  }

  // Background live (system:background:live)
  //
  // Opts a sandbox into being kept alive if its window closes. This is
  // the piece that was missing: closeWindow() previously backgrounded
  // *any* app holding system:background:live on every close, purely
  // because the grant existed — with no way for the app (or the user, via
  // some in-app "run in background" toggle) to say whether this
  // particular session actually wants that. Holding the permission is
  // necessary but was wrongly being treated as sufficient. Now
  // closeWindow checks this per-sandbox flag in addition to the grant.
  //
  // Deliberately session-only (not persisted): the app calls this each
  // time it wants the current session kept alive, e.g. right when the
  // user clicks its own "run in background" button. Nothing carries over
  // to the next launch automatically.
  async function handleBackgroundStayAlive({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:background:live', app.id)) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'PERMISSION_DENIED', 'system:background:live permission required');
    }
    const sandboxId = webview.dataset.sandboxId;
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'UNAVAILABLE', 'Sandbox not found');
    }
    // enabled defaults true — nova.stayAliveInBackground() with no args
    // means "yes, keep me alive"; passing { enabled: false } lets an app
    // change its mind before it actually closes.
    sandbox.wantsBackgroundLive = payload?.enabled !== false;
    return respond(webview, 'nova:background:stay-alive', requestId, { success: true, enabled: sandbox.wantsBackgroundLive });
  }

  // Settings

  async function handleSettingsGet({ payload, requestId, app, webview }) {
    // system:info gates read access — otherwise any app could read credentials
    // or other sensitive settings keys.
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const value = OS?.settings?.get(payload.key);
    return respond(webview, 'nova:settings:get', requestId, { success: true, value });
  }

  async function handleSettingsSet({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:settings', app.id)) {
      return respondError(webview, 'nova:settings:set', requestId, 'PERMISSION_DENIED', 'system:settings permission required');
    }
    OS?.settings?.set(payload.key, payload.value);
    return respond(webview, 'nova:settings:set', requestId, { success: true });
  }

  // Permission requests

  async function handleRequestPermission({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:request-permission', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const granted = await AppPermissionManager.requestPermission(permission, app.id, {
        reason: payload.reason || `${app.name} wants to access this permission.`,
        permanent: payload.permanent !== false,
      });
      return respond(webview, 'nova:request-permission', requestId, { granted });
    } catch (e) {
      return respondError(webview, 'nova:request-permission', requestId, 'ERROR', e.message || 'Permission request failed');
    }
  }

  // Lets a caller check rate-limit/cooldown status for a permission without
  // triggering a new prompt — e.g. the Permissions app showing "try again in
  // Ns" instead of blindly calling requestPermission and eating a silent deny.
  async function handlePermissionRateLimited({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const status = AppPermissionManager.isRateLimited(permission, app.id);
      return respond(webview, 'nova:permission-rate-limited', requestId, status);
    } catch (e) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'ERROR', e.message || 'Rate limit check failed');
    }
  }

  // Window management
  //
  // These all no-op silently when WM or the window state is missing, then
  // return success. This matches the original behaviour — window operations
  // are best-effort from the app's perspective.

  async function handleWindowClose({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
      WM.closeWindow(windowId);
    }
    return respond(webview, 'nova:window:close', requestId, { success: true });
  }

  async function handleWindowMinimize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.minimizeWindow === 'function') {
      WM.minimizeWindow(windowId);
    }
    return respond(webview, 'nova:window:minimize', requestId, { success: true });
  }

  async function handleWindowMaximize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.toggleMaximize === 'function') {
      WM.toggleMaximize(windowId);
    }
    return respond(webview, 'nova:window:maximize', requestId, { success: true });
  }

  async function handleWindowSetTitle({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId) {
      const state = OS.windows.get(windowId);
      if (state && state.titleText) {
        state.titleText.textContent = String(payload?.title ?? '');
      }
    }
    return respond(webview, 'nova:window:setTitle', requestId, { success: true });
  }

  async function handleWindowResize({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId) {
      const state = OS.windows.get(windowId);
      if (state && state.element) {
        // parseInt with explicit radix and a minimum bound to prevent
        // zero/negative sizes that would render the window unusable.
        const w = parsePositiveInt(payload?.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_DIMENSION);
        const h = parsePositiveInt(payload?.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_DIMENSION);
        state.element.style.width = w + 'px';
        state.element.style.height = h + 'px';
        state.width = w;
        state.height = h;
        if (state.maximized) {
          state.maximized = false;
          state.element.classList.remove('maximized');
        }
      }
    }
    return respond(webview, 'nova:window:resize', requestId, { success: true });
  }

  async function handleWindowGetState({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    const state = windowId ? OS.windows.get(windowId) : null;
    if (!state) {
      return respondError(webview, 'nova:window:getState', requestId, 'NOT_FOUND', 'Window not found');
    }
    return respond(webview, 'nova:window:getState', requestId, {
      success: true,
      id: state.id,
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      maximized: !!state.maximized,
      minimized: !!state.minimized,
    });
  }

  // Clipboard

  async function handleClipboardRead({ requestId, app, webview }) {
    // Clipboard is gated on vfs:read — intentional design choice from the
    // original code (clipboard contents often include file paths).
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:read', requestId, 'PERMISSION_DENIED', 'vfs:read permission required for clipboard access');
    }
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // No permission / no focus / insecure context — fall back to the
      // last value this OS instance itself wrote, rather than failing
      // outright, so same-session copy/paste inside Nova still works.
      text = OS.clipboard || null;
    }
    return respond(webview, 'nova:clipboard:read', requestId, {
      success: true,
      text: text,
    });
  }

  async function handleClipboardWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:write', requestId, 'PERMISSION_DENIED', 'vfs:read permission required for clipboard access');
    }
    const text = payload.text || '';
    try {
      // Actually write to the real system clipboard. navigator.clipboard
      // requires a secure context + (usually) a recent user gesture; if it
      // rejects (no focus, no gesture, permission denied), fall back to the
      // legacy execCommand path before giving up entirely.
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // try/finally ensures the textarea is always removed from the DOM
      // even if select() or execCommand throws — the previous version
      // leaked the element on a select() failure.
      let ok = false;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
      if (!ok) {
        return respondError(webview, 'nova:clipboard:write', requestId, 'CLIPBOARD_UNAVAILABLE', 'Could not write to the system clipboard: ' + (err && err.message ? err.message : String(err)));
      }
    }
    OS.clipboard = text;
    if (!OS.clipboardHistory) OS.clipboardHistory = [];
    if (typeof text === 'string' && text && !OS.clipboardHistory.includes(text)) {
      OS.clipboardHistory.unshift(text);
      if (OS.clipboardHistory.length > CLIPBOARD_HISTORY_MAX) OS.clipboardHistory.pop();
    }
    return respond(webview, 'nova:clipboard:write', requestId, { success: true });
  }

  // Downloads
  //
  // <webview> guests can't reach the host's real filesystem or trigger a
  // native save dialog directly (they're intentionally non-Node frames —
  // see nodeintegration=false above). The capability shim in a guest
  // intercepts <a download> clicks on blob: URLs, reads the blob bytes,
  // and ships them here as base64. This handler is what actually shows
  // the native "Save As" dialog and writes the bytes to disk — it only
  // runs in the top-level shell window, which IS a Node frame, so
  // nwsaveas and Node's fs module both work here.
  //
  // No standing permission is required for this — the native save dialog
  // itself is the control: the app can propose a filename and bytes, but
  // the user always sees and confirms the real destination before
  // anything touches disk. That mirrors how a normal browser download
  // works, and is a deliberate departure from the vfs:write pattern
  // above, which writes into novabyte-os's own virtual FS without a
  // per-write prompt.
  const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB — generous for a
  // vault export or similar; guards against a runaway/misbehaving app
  // trying to stream something enormous through the IPC bridge.

  function sanitizeDownloadFilename(name) {
    const fallback = 'download';
    if (!name || typeof name !== 'string') return fallback;
    // Strip any path components — this is a filename, not a path. Also
    // strip null bytes and other control characters some OSes mishandle.
    let base = name.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
    base = base.replace(/^\.+/, ''); // no leading dots (hidden files / '..' games)
    if (!base) return fallback;
    return base.slice(0, 255); // filesystem-safe length cap
  }

  async function handleDownload({ payload, requestId, app, webview }) {
    const { filename, mimeType, base64Data } = payload ?? {};
    if (typeof base64Data !== 'string' || !base64Data) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is required');
    }
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is not valid base64');
    }
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', `Download exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
    }

    const safeName = sanitizeDownloadFilename(filename);

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('nwsaveas', safeName);
      input.style.display = 'none';
      document.body.appendChild(input);

      // Cap how long we wait for the save dialog — if the user walks away
      // without dismissing it, the IPC call would otherwise hang forever
      // (the guest's shim has its own 10-min timeout, but the host-side
      // promise has none). 5 minutes is generous for a save decision and
      // short enough that a truly forgotten dialog surfaces as an error
      // rather than a zombie promise.
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        input.remove();
        respondError(webview, 'nova:download', requestId, 'TIMEOUT', 'Save dialog timed out');
        resolve();
      }, DOWNLOAD_DIALOG_TIMEOUT_MS);

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        input.remove();
        fn();
        resolve();
      };

      input.addEventListener('change', () => {
        const savePath = input.value;
        if (!savePath) {
          finish(() => respond(webview, 'nova:download', requestId, { success: false, cancelled: true }));
          return;
        }
        require('fs').writeFile(savePath, buffer, (err) => {
          if (err) {
            finish(() => respondError(webview, 'nova:download', requestId, 'IO_ERROR', err.message || 'Failed to write file'));
          } else {
            if (typeof EventLog !== 'undefined') {
              EventLog.log({
                app: 'AppSandbox',
                category: 'downloads',
                severity: 'info',
                message: `${app?.id || 'unknown'}: saved download "${safeName}" (${buffer.length} bytes)`,
                data: { appId: app?.id, filename: safeName, size: buffer.length, mimeType: mimeType || null },
              });
            }
            finish(() => respond(webview, 'nova:download', requestId, { success: true }));
          }
        });
      }, { once: true });

      // 'cancel' fires if the user dismisses the dialog without choosing a path.
      input.addEventListener('cancel', () => {
        finish(() => respond(webview, 'nova:download', requestId, { success: false, cancelled: true }));
      }, { once: true });

      input.click();
    });
  }

  // App lifecycle

  async function handleAppLaunch({ payload, requestId, app, webview }) {
    // system:apps gates cross-app launches — otherwise any app could spawn
    // any other app (privilege escalation surface).
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId, options } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (!OS.settings.get('devMode')) {
      const target = OS.apps[appId];
      if (target?.devOnly) {
        return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
      }
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow(appId, options || {});
      return respond(webview, 'nova:app:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:launch', requestId, 'ERROR', e.message);
    }
  }

  async function handleAppInfo({ requestId, app, webview }) {
    return respond(webview, 'nova:app:info', requestId, {
      success: true,
      id: app.id,
      name: app.name,
      version: app.version,
      icon: app.icon,
      type: app.type,
      permissions: app.permissions || [],
      optionalPermissions: app.optionalPermissions || [],
    });
  }

  // Admin: audit / system / apps / users
  //
  // admin:* is the only permission category gated by something below the
  // app-permission layer — /api/security/* checks req.user.role === 'admin'
  // server-side, which reflects a real local admin-state flag (see
  // server/security/admin-state.js) instead of being permanently false.
  // Two gates have to agree: AppPermissionManager (per-app grant, same as
  // every other permission) AND the local admin flag (per-machine, off by
  // default, toggled in Settings). An app can be granted admin:audit and
  // still get nothing back if the machine itself isn't in admin mode —
  // that's intentional, not a bug: granting an app the permission means
  // "if this machine is ever in admin mode, this app may use it," not
  // "make this machine an admin machine."
  //
  // There's no user-account CRUD anywhere in this codebase (no
  // create/delete/edit-user route exists), so admin:users maps to session
  // management (list/revoke active sessions) rather than invented account
  // operations. admin:apps has no dedicated route of its own in
  // security/routes.js; it's folded into admin:system's settings surface
  // for now since nothing else under /api/security exists for it.

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  // Shared helper for admin and mail proxies — both need the same
  // JSON-in/JSON-out shape with a CSRF header. Previously duplicated as
  // adminFetch and mailFetch with identical bodies.
  async function authedJsonFetch(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken(),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error page, fall through */ }
    return { status: res.status, ok: res.ok, json };
  }

  async function handleAdminAudit({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:audit', app.id)) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'admin:audit permission required');
    }
    if (!(await isAdminEnabledClient())) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const q = payload ?? {};
    const params = new URLSearchParams();
    for (const k of ['userId', 'action', 'resource', 'ipAddress', 'success', 'startDate', 'endDate', 'level', 'limit', 'offset']) {
      if (q[k] !== undefined && q[k] !== null) params.set(k, String(q[k]));
    }
    try {
      const { status, json } = await authedJsonFetch(`/api/security/audit?${params.toString()}`);
      if (status === 403) {
        return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', json?.message || 'Failed to query audit log');
      }
      return respond(webview, 'nova:admin:audit', requestId, { success: true, logs: json.data, pagination: json.pagination, statistics: json.statistics });
    } catch (e) {
      return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', e.message || 'Audit request failed');
    }
  }

  async function handleAdminSystem({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:system', app.id)) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'admin:system permission required');
    }
    if (!(await isAdminEnabledClient())) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const action = payload?.action === 'set' ? 'set' : 'get';
    try {
      if (action === 'get') {
        const { status, json } = await authedJsonFetch('/api/security/settings');
        if (status === 403) {
          return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to read security settings');
        }
        return respond(webview, 'nova:admin:system', requestId, { success: true, settings: json.data });
      }
      // action === 'set'
      const updates = payload?.settings;
      if (!updates || typeof updates !== 'object') {
        return respondError(webview, 'nova:admin:system', requestId, 'INVALID_ARGS', 'settings object is required for action "set"');
      }
      const { status, json } = await authedJsonFetch('/api/security/settings', { method: 'PUT', body: updates });
      if (status === 403) {
        return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to update security settings');
      }
      return respond(webview, 'nova:admin:system', requestId, { success: true, updated: json.updated });
    } catch (e) {
      return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', e.message || 'Admin system request failed');
    }
  }

  async function handleAdminUsers({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:users', app.id)) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'admin:users permission required');
    }
    if (!(await isAdminEnabledClient())) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    // No account system exists in this codebase — this maps to session
    // management (list/revoke), the closest real equivalent to "manage
    // other users' access" that /api/security actually implements.
    const action = payload?.action === 'revoke' ? 'revoke' : 'list';
    try {
      if (action === 'list') {
        const { status, json } = await authedJsonFetch('/api/security/sessions');
        if (status === 401) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', 'No active session');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to list sessions');
        }
        return respond(webview, 'nova:admin:users', requestId, { success: true, sessions: json.data });
      }
      // action === 'revoke'
      const sessionId = payload?.sessionId;
      if (!sessionId) {
        return respondError(webview, 'nova:admin:users', requestId, 'INVALID_ARGS', 'sessionId is required for action "revoke"');
      }
      const { status, json } = await authedJsonFetch(`/api/security/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (status === 403) {
        return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'Not permitted to revoke this session');
      }
      if (status === 404) {
        return respondError(webview, 'nova:admin:users', requestId, 'NOT_FOUND', 'Session not found');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to revoke session');
      }
      return respond(webview, 'nova:admin:users', requestId, { success: true, revoked: true });
    } catch (e) {
      return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', e.message || 'Admin users request failed');
    }
  }

  async function handleAdminApps({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:apps', app.id)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'admin:apps permission required');
    }
    // There's no dedicated /api/security route for app management — the
    // real, non-sandboxed app inventory already lives behind system:apps
    // (nova:app:list/install/uninstall). What system:apps:list can't show
    // is what's actually been *granted* at runtime — a manifest can
    // declare permissions it was never given, or the user may have
    // revoked something after install. admin:apps' real, distinguishing
    // scope is that runtime grant state: "an admin-mode app can audit
    // what every installed app can actually do right now," not just what
    // it asked for. If real admin-only mutating operations (force-
    // uninstall another app, disable an app fleet-wide) get built later,
    // they belong here too.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    if (!(await isAdminEnabledClient())) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const apps = APP_REGISTRY.map(a => {
      const granted = (typeof AppPermissionManager.getAppPermissions === 'function')
        ? AppPermissionManager.getAppPermissions(a.id).map(g => g.permission)
        : [];
      // Built-in apps never declare permissions on their registerApp()
      // config — that's not a gap in this handler, it's a real second
      // source of truth: js/platform/security/app-permissions-bootstrap.js
      // defines a separate NORMAL/DANGEROUS permission map
      // (window.AppPermissionsMap) per built-in app id, auto-granting
      // NORMAL ones and prompting for DANGEROUS ones on first use. A
      // file-installed .novaapp, by contrast, genuinely does declare
      // permissions/optionalPermissions on its manifest, which is what
      // ends up on the registry config object. Report whichever source
      // actually applies rather than showing an always-empty array for
      // every built-in app.
      const bootstrapEntry = (typeof window.AppPermissionsMap === 'object' && window.AppPermissionsMap)
        ? window.AppPermissionsMap[a.id]
        : null;
      const declaredPermissions = bootstrapEntry
        ? [...(bootstrapEntry.normal || [])]
        : (a.permissions || []);
      const declaredOptionalPermissions = bootstrapEntry
        ? [...(bootstrapEntry.dangerous || [])]
        : (a.optionalPermissions || []);
      return {
        id: a.id, name: a.name, version: a.version || '1.0.0',
        source: a.source || 'local', builtin: a.source !== 'file',
        declaredPermissions, declaredOptionalPermissions,
        declaredVia: bootstrapEntry ? 'permissions-bootstrap' : 'manifest',
        grantedPermissions: granted,
      };
    });
    return respond(webview, 'nova:admin:apps', requestId, { success: true, apps });
  }

  // admin:apps has no server route to 403 against (unlike the other three,
  // which proxy to /api/security and get a real 403 from there), so it
  // needs its own client-side admin-mode check. Reuses the same signal:
  // GET /api/security/settings returns a *limited* payload for non-admins
  // (no _meta.editable, no full settings) but always 200s, so the leanest
  // honest check is a settings fetch and looking at whether the admin-only
  // fields came back.
  async function isAdminEnabledClient() {
    try {
      const { json } = await authedJsonFetch('/api/security/settings');
      return !!(json && json.success && json.data && json.data._meta);
    } catch {
      return false;
    }
  }

  function mailNotConnectedError(webview, channel, requestId) {
    return respondError(webview, channel, requestId, 'UNAVAILABLE', 'No email account connected — open the Email app and connect an account first');
  }

  // mail:read — folders, message lists, single messages, search. All GET,
  // no mutation of mailbox state.
  async function handleMailRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:read', app.id)) {
      return respondError(webview, 'nova:mail:read', requestId, 'PERMISSION_DENIED', 'mail:read permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'folders' ? 'folders'
      : q.action === 'message' ? 'message'
      : q.action === 'search' ? 'search'
      : q.action === 'account' ? 'account'
      : 'messages';
    try {
      let url;
      if (action === 'account') {
        url = '/api/email/restore';
      } else if (action === 'folders') {
        url = '/api/email/folders';
      } else if (action === 'message') {
        if (!q.uid) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'uid is required for action "message"');
        const p = new URLSearchParams();
        p.set('uid', String(q.uid));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/message?${p.toString()}`;
      } else if (action === 'search') {
        if (!q.query) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'query is required for action "search"');
        const p = new URLSearchParams();
        p.set('q', String(q.query));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/search?${p.toString()}`;
      } else {
        const p = new URLSearchParams();
        if (q.folder) p.set('folder', String(q.folder));
        if (q.page) p.set('page', String(q.page));
        if (q.limit) p.set('limit', String(q.limit));
        url = `/api/email/messages?${p.toString()}`;
      }
      const { status, json } = await authedJsonFetch(url);
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:read', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', json?.error || 'Mail read request failed');
      }
      return respond(webview, 'nova:mail:read', requestId, { success: true, action, data: json });
    } catch (e) {
      return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', e.message || 'Mail read request failed');
    }
  }

  // mail:write — batch mutations that aren't deletion (mark-read, move)
  // plus HTML preview rendering. Deliberately excludes batch delete,
  // which is mail:delete's job even though both go through /api/email/batch.
  async function handleMailWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:write', app.id)) {
      return respondError(webview, 'nova:mail:write', requestId, 'PERMISSION_DENIED', 'mail:write permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'preview' ? 'preview' : 'batch';
    try {
      if (action === 'preview') {
        if (typeof q.html !== 'string') return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'html string is required for action "preview"');
        const { status, json } = await authedJsonFetch('/api/email/preview', { method: 'POST', body: { html: q.html } });
        if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Preview request failed');
        }
        return respond(webview, 'nova:mail:write', requestId, { success: true, action, token: json.token });
      }
      // action === 'batch', op must be 'read' or 'move' — 'delete' isn't
      // allowed through this handler, that's mail:delete's surface.
      const op = q.op === 'move' ? 'move' : 'read';
      const uids = Array.isArray(q.uids) ? q.uids : [];
      if (!uids.length) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'uids array is required');
      if (op === 'move' && !q.dest) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'dest is required for op "move"');
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        body: { op, uids, folder: q.folder || 'INBOX', dest: q.dest },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Mail batch request failed');
      }
      return respond(webview, 'nova:mail:write', requestId, { success: true, action, op });
    } catch (e) {
      return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', e.message || 'Mail write request failed');
    }
  }

  // mail:send — SMTP send via the connected account's credentials.
  // The server has no way to know the account's real SMTP host/port on its
  // own: /connect only stores the IMAP/POP3/EWS host (e.g. imap.gmail.com),
  // which is frequently a *different* host than SMTP (smtp.gmail.com) —
  // silently reusing the IMAP host caused real send failures (TLS cert
  // mismatch) before this was required explicitly. The Email app's own UI
  // has a dedicated SMTP Host/Port field for exactly this reason; a
  // sandboxed app calling mail:send needs to supply the same thing rather
  // than have this handler guess at it.
  async function handleMailSend({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:send', app.id)) {
      return respondError(webview, 'nova:mail:send', requestId, 'PERMISSION_DENIED', 'mail:send permission required');
    }
    const q = payload ?? {};
    if (!q.to) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'to is required');
    if (!q.smtpHost) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)');
    try {
      const { status, json } = await authedJsonFetch('/api/email/send', {
        method: 'POST',
        body: { to: q.to, cc: q.cc, bcc: q.bcc, subject: q.subject, text: q.text, html: q.html, host: q.smtpHost, port: q.smtpPort },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:send', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', json?.error || 'Send failed');
      }
      return respond(webview, 'nova:mail:send', requestId, { success: true, messageId: json.messageId });
    } catch (e) {
      return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', e.message || 'Send request failed');
    }
  }

  // mail:delete — batch delete only.
  async function handleMailDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:delete', app.id)) {
      return respondError(webview, 'nova:mail:delete', requestId, 'PERMISSION_DENIED', 'mail:delete permission required');
    }
    const q = payload ?? {};
    const uids = Array.isArray(q.uids) ? q.uids : [];
    if (!uids.length) return respondError(webview, 'nova:mail:delete', requestId, 'INVALID_ARGS', 'uids array is required');
    try {
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        body: { op: 'delete', uids, folder: q.folder || 'INBOX' },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:delete', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', json?.error || 'Mail delete request failed');
      }
      return respond(webview, 'nova:mail:delete', requestId, { success: true, deleted: uids.length });
    } catch (e) {
      return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', e.message || 'Mail delete request failed');
    }
  }

  // App list / install / uninstall
  //
  // These, together with launch (above) and info, are what 'system:apps'
  // actually gates. list/uninstall are straightforward reads/writes on
  // AppRegistry. install is the interesting one: appmanager.js's real
  // install flow (processFile in js/apps/appmanager.js) can require up to
  // three human confirmation dialogs — untrusted signer, tampered
  // contents, or "already installed, replace?" — none of which a
  // sandboxed app calling this over IPC can click through. Rather than
  // silently bypassing a security gate a human would otherwise have to
  // consciously approve, this handler fails closed: it only succeeds for
  // a package that is fully signed, trust-store-verified, and unmodified,
  // with no existing install of the same app id already present. Anything
  // that would need a dialog is rejected with a message telling the
  // caller to have the user install manually via App Manager instead.

  async function handleAppList({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:list', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    // AppRegistry.installedApps is NOT what built-in apps register into —
    // all 22+ built-in apps (calendar-app, nbosp-contacts, etc.) call the
    // global registerApp() in js/core/services/registry.js, which writes
    // to OS.apps + the module-level APP_REGISTRY array. AppRegistry's own
    // store only ever gets entries from its initialize() localStorage
    // restore, so it's effectively empty for the running OS's actual app
    // set. APP_REGISTRY is the real, live list everything else (launchpad,
    // taskbar, App Manager) reads from.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:list', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const apps = APP_REGISTRY.map(a => ({
      id: a.id,
      name: a.name,
      version: a.version || '1.0.0',
      icon: a.icon || null,
      description: a.description || '',
      categories: a.categories || [],
      verified: !!a.verified,
      source: a.source || 'local',
      builtin: a.source !== 'file',
    }));
    return respond(webview, 'nova:app:list', requestId, { success: true, apps });
  }

  async function handleAppUninstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (appId === app.id) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'An app cannot uninstall itself');
    }
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const target = APP_REGISTRY.find(a => a.id === appId);
    if (!target) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_FOUND', `No installed app with id ${appId}`);
    }
    // Built-in apps (source !== 'file') were never installed as a
    // .novaapp package — there's no package files, storage partition, or
    // app-data directory to clean up, and appmanager.js's own uninstall
    // UI has no path for removing them either. Refuse rather than
    // half-uninstall something that isn't really an installed package.
    if (target.source !== 'file') {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_UNINSTALLABLE', `"${target.name}" is a built-in system app and cannot be uninstalled`);
    }

    // Mirrors appmanager.js's doUninstall(): close open windows, then
    // clean up package files, the app's storage partition, and its app
    // data directory, then remove from every registry/list that tracks
    // it. Each cleanup step is independently best-effort (matching the
    // manual path's own try/catch-per-step), since a failure in one
    // (e.g. partition already cleared) shouldn't block the others.
    if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === appId) openWindowIds.push(wid);
      }
      await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
    }
    try {
      if (typeof PackageStore !== 'undefined' && PackageStore?.removeApp) {
        await PackageStore.removeApp(appId, { updateRegistry: false });
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to remove stored package files for', appId, e);
    }
    try {
      if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
        await AppSandbox.clearAppPartition(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear storage partition for', appId, e);
    }
    try {
      if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
        await AppDirs.removeAppData(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear app data for', appId, e);
    }
    // Drop the notification rate-limit entry so it doesn't leak across
    // an uninstall/reinstall cycle for the same app id.
    clearNotificationRateLimit(appId);

    delete OS.apps[appId];
    const ri = APP_REGISTRY.findIndex(a => a.id === appId);
    if (ri > -1) APP_REGISTRY.splice(ri, 1);

    // appmanager.js's own local installedApps array + its persisted copy
    // is a THIRD place tracking installed-from-file apps, independent of
    // APP_REGISTRY/OS.apps — remove from there too if it's reachable from
    // this scope, same as the manual uninstall path does.
    try {
      if (typeof installedApps !== 'undefined' && Array.isArray(installedApps)) {
        const ii = installedApps.findIndex(a => a.id === appId);
        if (ii > -1) installedApps.splice(ii, 1);
        if (typeof saveStoredApps === 'function') saveStoredApps(installedApps);
      }
    } catch (e) {
      // appmanager.js's local state isn't in scope here — APP_REGISTRY/
      // OS.apps removal above is the part that actually matters.
      log('debug', 'nova:app:uninstall — could not sync appmanager.js local state for', appId, e);
    }

    OS.settings?.set?.('pinnedApps', (OS.settings?.get?.('pinnedApps') || []).filter(id => id !== appId));
    if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
    if (typeof renderDesktopIcons === 'function') {
      try { renderDesktopIcons(); } catch (e) { log('debug', 'renderDesktopIcons threw during uninstall', e); }
    }

    return respond(webview, 'nova:app:uninstall', requestId, { success: true, removed: true });
  }

  async function handleAppInstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:install', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { package: pkg } = payload ?? {};
    if (!pkg || typeof pkg !== 'object') {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_ARGS', 'package (a parsed .novaapp object) is required');
    }
    if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_PACKAGE', 'Missing required manifest fields (id, name, version)');
    }

    // Malware/heuristic scan — same as the manual install path, and
    // equally non-negotiable: no override, no "proceed anyway".
    if (window.Scanner?.scanBase64 && pkg.files && typeof pkg.files === 'object') {
      for (const [relPath, rawB64] of Object.entries(pkg.files)) {
        if (typeof rawB64 !== 'string') continue;
        try {
          const verdict = await window.Scanner.scanBase64(relPath, rawB64);
          if (!verdict.safe) {
            return respondError(webview, 'nova:app:install', requestId, 'MALICIOUS_PACKAGE',
              `File "${relPath}" was flagged and installation was blocked: ${verdict.reason || 'matched a pattern associated with malicious files'}`);
          }
        } catch (err) {
          // Scanner error is treated as inconclusive, not a pass — the
          // manual path silently continues past scanner errors (best
          // effort, since a human is still there to react to whatever
          // comes next), but this unattended path has no human backstop,
          // so an inconclusive scan blocks install instead.
          return respondError(webview, 'nova:app:install', requestId, 'SCAN_FAILED', `Could not scan "${relPath}": ${err.message}`);
        }
      }
    }

    // Integrity — must be present and must pass. No informational-only
    // path here (the manual flow can warn-and-proceed via a dialog; this
    // one can't warn anyone, so a failed or missing integrity check is a
    // hard stop).
    if (!pkg.integrity || typeof AppPackage === 'undefined' || typeof AppPackage.verifyIntegrity !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNVERIFIED', 'Package has no integrity record — install manually via App Manager');
    }
    let integrityOk = false;
    try { integrityOk = await AppPackage.verifyIntegrity(pkg); } catch (e) {
      log('warn', 'nova:app:install — integrity verification threw for', pkg.manifest.id, e);
    }
    if (!integrityOk) {
      return respondError(webview, 'nova:app:install', requestId, 'TAMPERED', 'Package contents do not match their recorded integrity hashes — install manually via App Manager to review');
    }

    // Trust — must be signed and the signature must resolve to a trusted
    // entry in the trust store, not revoked. This is the check that
    // rejects unsigned packages by design, same as the manual flow would
    // show "Unverified" for one.
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyAgainstTrustStore !== 'function' || typeof TrustStore === 'undefined') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'Trust store not available');
    }
    let trustResult;
    try {
      const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
      trustResult = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
    } catch (e) {
      log('warn', 'nova:app:install — trust verification threw for', pkg.manifest.id, e);
      trustResult = { trusted: false, signer: null };
    }
    if (!trustResult.trusted) {
      const reason = trustResult.revoked ? 'the signature is on the revocation list' : 'the package is unsigned or not from a trusted publisher';
      return respondError(webview, 'nova:app:install', requestId, 'UNTRUSTED', `Install blocked — ${reason}. Install manually via App Manager to review and confirm.`);
    }

    // Already-installed — the manual flow asks "replace?"; this path has
    // no one to ask, so it refuses rather than silently overwriting an
    // existing install (which could be a downgrade, or could clobber user
    // data tied to the old version).
    if (typeof AppRegistry === 'undefined' || typeof AppRegistry.getApp !== 'function' || typeof AppRegistry.registerApp !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const existing = AppRegistry.getApp(pkg.manifest.id);
    if (existing) {
      return respondError(webview, 'nova:app:install', requestId, 'ALREADY_INSTALLED', `"${pkg.manifest.name}" (${pkg.manifest.id}) is already installed — install manually via App Manager to replace it`);
    }

    // All gates passed: signed, trusted, unmodified, not a duplicate.
    // Register it the same way appmanager.js's manual path ultimately
    // does — via AppRegistry, not by hand-rolling a second code path.
    try {
      const appData = {
        ...pkg.manifest,
        files: pkg.files,
        signature: pkg.signature,
        integrity: pkg.integrity,
        verified: true,
        signer: trustResult.signer,
        source: 'file',
        installedDate: new Date().toISOString(),
      };
      const registered = AppRegistry.registerApp(appData);
      return respond(webview, 'nova:app:install', requestId, {
        success: true,
        id: registered.id,
        name: registered.name,
        version: registered.version,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:install', requestId, 'ERROR', e.message);
    }
  }

  // Events

  async function handleEventsSubscribe({ payload, requestId, app, webview, sandbox }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    if (!event) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', 'event name is required');
    }
    const sandboxId = webview.dataset.sandboxId;
    const subs = eventSubscriptions.get(sandboxId);
    if (subs && subs.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
    }
    const handler = (data) => {
      respond(webview, 'nova:events:event', generateRequestId(), { event, data });
    };
    // Only register and record the subscription if OS.events actually
    // exists — otherwise we'd record a handler that never fires and
    // silently mislead the app into thinking it's subscribed.
    if (!OS?.events?.on) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'UNAVAILABLE', 'Event bus not available');
    }
    OS.events.on(event, handler);
    if (subs) subs.set(event, handler);
    return respond(webview, 'nova:events:subscribe', requestId, { success: true, subscribed: event });
  }

  async function handleEventsUnsubscribe({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:unsubscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      const handler = subs.get(event);
      OS?.events?.off(event, handler);
      subs.delete(event);
    }
    return respond(webview, 'nova:events:unsubscribe', requestId, { success: true, unsubscribed: event });
  }

  // Network: fetch

  async function handleNetFetch({ payload, requestId, app, webview }) {
    const { url: rawUrl, method, headers, body } = payload ?? {};
    if (!rawUrl) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'url is required');
    }
    const safeMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(safeMethod)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', `Method not allowed: ${safeMethod}`);
    }
    // Resolve and classify the URL in one pass. This catches protocol-relative
    // URLs (//evil.com) that the old leading-slash check missed.
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', classified.error);
    }
    const netPerm = classified.isInternal ? 'net:internal' : 'net:external';
    if (!AppPermissionManager.isGranted(netPerm, app.id)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
    }
    try {
      let resStatus, resStatusText, resHeaders, resBody;

      if (classified.isInternal) {
        // Same-origin requests don't hit CORS, so go direct.
        const res = await fetch(classified.url, {
          method: safeMethod,
          headers: headers || {},
          body: body || null,
        });
        resBody = await res.text();
        resStatus = res.status;
        resStatusText = res.statusText;
        resHeaders = Object.fromEntries(res.headers.entries());
      } else {
        // External requests go through the server-side proxy. A direct fetch()
        // from this document would be subject to the target server's CORS
        // policy (most external APIs don't allow browser-origin requests),
        // so we hand the request to /api/proxy, which makes it server-to-server.
        const { status: proxyStatus, ok, json: proxyJson } = await authedJsonFetch('/api/proxy', {
          method: 'POST',
          body: { url: classified.url, method: safeMethod, headers: headers || {}, body: body || null },
        });
        if (!ok) {
          return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', proxyJson?.error || `Proxy request failed (${proxyStatus})`);
        }
        resStatus = proxyJson.status;
        resStatusText = proxyJson.statusText;
        resHeaders = proxyJson.headers || {};
        resBody = proxyJson.body || '';
      }

      return respond(webview, 'nova:net:fetch', requestId, {
        success: true,
        status: resStatus,
        statusText: resStatusText,
        headers: resHeaders,
        body: resBody,
      });
    } catch (e) {
      return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', e.message);
    }
  }

  // Network: WebSocket

  async function handleNetWebsocket({ payload, requestId, app, webview, sandbox }) {
    const { url, protocols } = payload ?? {};
    if (!url) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', 'url is required');
    }
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:websocket', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!AppPermissionManager.isGranted('net:websocket', app.id)) {
      return respondError(webview, 'nova:net:websocket', requestId, 'PERMISSION_DENIED', 'net:websocket permission required');
    }
    let ws;
    try {
      ws = protocols?.length
        ? new WebSocket(url, protocols)
        : new WebSocket(url);
    } catch (e) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', e.message);
    }
    const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Track the WebSocket so destroy() can close it when the sandbox is torn
    // down. Without this, sockets would outlive their app and leak.
    if (sandbox) {
      if (!sandbox.wsConnections) sandbox.wsConnections = new Map();
      sandbox.wsConnections.set(wsId, { ws, appId: app.id });
    }
    ws.onopen = () => respond(webview, 'nova:net:websocket', requestId, { success: true, wsId, readyState: ws.readyState });
    ws.onmessage = (e) => {
      respond(webview, 'nova:net:ws:message', generateRequestId(), { wsId, data: e.data });
    };
    ws.onerror = () => {
      respond(webview, 'nova:net:ws:error', generateRequestId(), { wsId, error: 'WebSocket error' });
    };
    ws.onclose = (e) => {
      respond(webview, 'nova:net:ws:close', generateRequestId(), {
        wsId, code: e.code, reason: e.reason, clean: e.wasClean,
      });
      sandbox?.wsConnections?.delete(wsId);
    };
    // Response is sent asynchronously via onopen; nothing to return here.
  }

  async function handleNetWsSend({ payload, requestId, sandbox, webview }) {
    const { wsId, data } = payload ?? {};
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (!wsState) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'NOT_FOUND', 'WebSocket connection not found');
    }
    if (wsState.ws.readyState !== WebSocket.OPEN) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', 'WebSocket is not open');
    }
    wsState.ws.send(data ?? '');
    return respond(webview, 'nova:net:ws:send', requestId, { success: true });
  }

  async function handleNetWsClose({ payload, requestId, sandbox, webview }) {
    const { wsId, code, reason } = payload ?? {};
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (wsState) {
      try { wsState.ws.close(code ?? 1000, reason); } catch { /* already closed */ }
      sandbox?.wsConnections?.delete(wsId);
    }
    return respond(webview, 'nova:net:ws:close', requestId, { success: true });
  }

  // Storage
  //
  // Backed by a single host-side IndexedDB database (NovaByte_AppStorage),
  // NOT localStorage. localStorage lives on the shared shell origin and is
  // readable by anything with same-origin access — a string key prefix
  // isn't real isolation, it just stops accidental collisions. IndexedDB
  // here still lives in the host's origin, but every record is keyed by
  // [appId, key] and every operation is scoped with an IDBKeyRange bound
  // to the calling app's own appId, so one app's IPC calls can never read,
  // enumerate, or clear another app's rows even if it somehow forged a
  // request. Key characters are also restricted to prevent path-like
  // injection confusing downstream consumers of the raw key string.

  const STORAGE_DB_NAME = 'NovaByte_AppStorage';
  const STORAGE_DB_VERSION = 1;
  const STORAGE_STORE = 'kv';
  let storageDbPromise = null;

  function openStorageDB() {
    if (storageDbPromise) return storageDbPromise;
    storageDbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORAGE_STORE)) {
          // Composite keyPath so [appId, key] is unique and directly
          // addressable; the appId index lets clear/keys range-scan just
          // that app's rows instead of iterating every app's data.
          const store = d.createObjectStore(STORAGE_STORE, { keyPath: ['appId', 'key'] });
          store.createIndex('by_appId', 'appId');
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('Failed to open storage database'));
    });
    // If opening fails, drop the cached promise so the next caller can retry
    // rather than permanently rejecting forever.
    storageDbPromise.catch(() => { storageDbPromise = null; });
    return storageDbPromise;
  }

  function storageAppRange(appId) {
    return IDBKeyRange.bound([appId, ''], [appId, '\uffff'], false, false);
  }

  async function storageGet(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get([appId, key]);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  // Look up the existing byteSize for a key in a single read, used by
  // storageSet's quota check. Returns 0 if the key doesn't exist yet.
  function storageExistingByteSize(db, appId, key) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get([appId, key]);
      req.onsuccess = () => resolve(req.result ? (req.result.byteSize || 0) : 0);
      req.onerror = () => resolve(0);
    });
  }

  async function storageAppUsageBytes(appId, db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const idx = tx.objectStore(STORAGE_STORE).index('by_appId');
      const req = idx.openCursor(IDBKeyRange.only(appId));
      let total = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          total += cursor.value.byteSize || 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function storageSet(appId, key, value, valueBytes) {
    const db = await openStorageDB();
    // Check quota against existing usage for this app minus whatever this
    // key already costs (so overwriting an existing key isn't double-counted).
    // Previously this made two redundant storageGet round-trips — one
    // discarded, one that only read byteSize. Now it's a single read.
    const [usage, existing] = await Promise.all([
      storageAppUsageBytes(appId, db),
      storageExistingByteSize(db, appId, key),
    ]);
    if (usage - existing + valueBytes > STORAGE_APP_QUOTA_BYTES) {
      const err = new Error('Storage quota exceeded');
      err.code = 'STORAGE_FULL';
      throw err;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).put({ appId, key, value, byteSize: valueBytes });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageDelete(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).delete([appId, key]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageClear(appId) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).index('by_appId').openCursor(IDBKeyRange.only(appId)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Wipe every row in the nova:storage store, regardless of appId. For
  // factory-reset / "Wipe All Data" — unlike storageClear(appId), this
  // isn't scoped to one app because a factory reset needs to clear
  // everything, including any rows left behind by an app that's since
  // been uninstalled (an already-cleaned entry wouldn't appear in
  // OS.apps for a per-appId sweep to find). Goes through the same
  // cached connection as every other storage* function rather than
  // indexedDB.deleteDatabase(STORAGE_DB_NAME) directly, since a raw
  // delete call would block on this module's own open connection
  // (storageDbPromise) for the lifetime of the session.
  async function clearAllStorage() {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageKeys(appId) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).index('by_appId').openCursor(IDBKeyRange.only(appId));
      const keys = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          keys.push(cursor.value.key);
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function validateStorageKey(rawKey) {
    const key = String(rawKey ?? '');
    if (!key || !STORAGE_KEY_REGEX.test(key)) return null;
    return key;
  }

  async function handleStorageGet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:get', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      const value = await storageGet(app.id, rawKey);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value });
    } catch (e) {
      // IndexedDB can throw if disabled/unavailable (e.g. private browsing
      // in some browsers). Treat as "no value" rather than crashing the IPC call.
      log('debug', 'storageGet failed, returning null', e);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value: null });
    }
  }

  async function handleStorageSet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    // Enforce a per-value size cap, and storageSet enforces the per-app quota
    // against real existing usage in the DB (not just a per-call check).
    const value = payload?.value ?? '';
    const valueBytes = sharedTextEncoder.encode(String(value)).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', `Value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit`);
    }
    try {
      await storageSet(app.id, rawKey, value, valueBytes);
      return respond(webview, 'nova:storage:set', requestId, { success: true });
    } catch (e) {
      if (e && e.code === 'STORAGE_FULL') {
        return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Per-app storage quota exceeded');
      }
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Failed to write to storage');
    }
  }

  async function handleStorageDelete({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:delete', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      await storageDelete(app.id, rawKey);
      return respond(webview, 'nova:storage:delete', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:delete', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageClear({ requestId, app, webview }) {
    try {
      await storageClear(app.id);
      return respond(webview, 'nova:storage:clear', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:clear', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageKeys({ requestId, app, webview }) {
    try {
      const keys = await storageKeys(app.id);
      return respond(webview, 'nova:storage:keys', requestId, { success: true, keys });
    } catch (e) {
      return respondError(webview, 'nova:storage:keys', requestId, 'ERROR', e.message);
    }
  }

  // Device: geolocation

  async function handleDeviceGeolocation({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'UNAVAILABLE', 'Geolocation not available');
    }
    // Response is sent from one of the two callbacks below; we don't respond
    // here because getCurrentPosition returns immediately.
    navigator.geolocation.getCurrentPosition(
      (pos) => respond(webview, 'nova:device:geolocation', requestId, {
        success: true,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      }),
      (err) => respondError(webview, 'nova:device:geolocation', requestId, 'GEOLOCATION_ERROR', err.message),
      payload.options || {}
    );
  }

  // Device: camera / microphone
  //
  // Unlike geolocation, a getUserMedia() MediaStream can't cross the IPC
  // bridge at all — it isn't serializable, and this handler runs in the
  // host shell's own document, not inside the guest webview that would
  // actually consume the stream. So these two handlers are
  // authorization-only: they check AppPermissionManager and report
  // whether the app is allowed to use the camera/microphone. The guest is
  // expected to then call navigator.mediaDevices.getUserMedia() itself,
  // inside its own document — see window.nova.getUserMedia in the
  // capability shim below, which calls this check first and only then
  // makes the real getUserMedia() call. That real call still goes through
  // the webview's own permissionrequest gate (setupPermissionRequestGate,
  // 'media' branch) as the actual browser-level enforcement point; this
  // handler is the app-level permission gate, a separate decision the
  // browser-level gate doesn't know about on its own.

  async function handleDeviceCamera({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:camera', app.id)) {
      return respondError(webview, 'nova:device:camera', requestId, 'PERMISSION_DENIED', 'device:camera permission required');
    }
    return respond(webview, 'nova:device:camera', requestId, { success: true, authorized: true });
  }

  async function handleDeviceMicrophone({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:microphone', app.id)) {
      return respondError(webview, 'nova:device:microphone', requestId, 'PERMISSION_DENIED', 'device:microphone permission required');
    }
    return respond(webview, 'nova:device:microphone', requestId, { success: true, authorized: true });
  }

  // Calendar
  //
  // Same host-shell context as nova:storage: this handler runs in the shell,
  // reading/writing the SAME localStorage key ('calendar_events_v2') the
  // first-party Calendar app (id 'calendar-app') uses — this is the shared,
  // real user calendar, not a per-app isolated store, per product decision.
  // Sanitization mirrors js/apps/calendar.js's sanitizeEvent() exactly so a
  // sandboxed app can't write a malformed/malicious event (e.g. a bad
  // `color` value) that the host Calendar UI would then render unsafely.

  const CALENDAR_STORE_KEY = 'calendar_events_v2';
  const CALENDAR_COLORS = Object.freeze(['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364']);

  function sanitizeCalendarEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (typeof ev.title !== 'string' || !ev.title.trim()) return null;
    if (typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
    return {
      id:        typeof ev.id === 'string' && ev.id ? ev.id : cryptoRandomId(),
      title:     ev.title.trim(),
      date:      ev.date,
      timeStart: typeof ev.timeStart === 'string' ? ev.timeStart : '',
      timeEnd:   typeof ev.timeEnd   === 'string' ? ev.timeEnd   : '',
      desc:      typeof ev.desc      === 'string' ? ev.desc      : '',
      color:     CALENDAR_COLORS.includes(ev.color) ? ev.color : CALENDAR_COLORS[0],
    };
  }

  function cryptoRandomId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadCalendarEvents() {
    try {
      const raw = JSON.parse(localStorage.getItem(CALENDAR_STORE_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.map(sanitizeCalendarEvent).filter(Boolean) : [];
    } catch { return []; }
  }

  function saveCalendarEvents(evs) {
    localStorage.setItem(CALENDAR_STORE_KEY, JSON.stringify(evs));
  }

  async function handleCalendarRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:read', app.id)) {
      return respondError(webview, 'nova:calendar:read', requestId, 'PERMISSION_DENIED', 'calendar:read permission required');
    }
    return respond(webview, 'nova:calendar:read', requestId, { success: true, events: loadCalendarEvents() });
  }

  async function handleCalendarWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:write', app.id)) {
      return respondError(webview, 'nova:calendar:write', requestId, 'PERMISSION_DENIED', 'calendar:write permission required');
    }
    const incoming = sanitizeCalendarEvent(payload && payload.event);
    if (!incoming) {
      return respondError(webview, 'nova:calendar:write', requestId, 'INVALID_EVENT', 'Event must have a title and a YYYY-MM-DD date');
    }
    const events = loadCalendarEvents();
    const idx = events.findIndex(e => e.id === incoming.id);
    if (idx >= 0) events[idx] = incoming; else events.push(incoming);
    saveCalendarEvents(events);
    return respond(webview, 'nova:calendar:write', requestId, { success: true, event: incoming });
  }

  async function handleCalendarDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:delete', app.id)) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'PERMISSION_DENIED', 'calendar:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const events = loadCalendarEvents();
    const next = events.filter(e => e.id !== id);
    const removed = next.length !== events.length;
    saveCalendarEvents(next);
    return respond(webview, 'nova:calendar:delete', requestId, { success: true, removed });
  }

  // Contacts
  //
  // Same shared-host-storage model as Calendar above; mirrors
  // js/apps/contacts.js's isValidContact() sanitization exactly.

  const CONTACTS_STORE_KEY = 'nova_contacts';

  function isValidContact(c) {
    return c !== null && typeof c === 'object' &&
      typeof c.id === 'string' && c.id.length > 0 &&
      typeof c.name === 'string' &&
      typeof c.email === 'string' &&
      typeof c.phone === 'string' &&
      typeof c.notes === 'string';
  }

  function loadContacts() {
    try {
      const raw = localStorage.getItem(CONTACTS_STORE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(isValidContact).map(c => ({
        id: String(c.id), name: String(c.name), email: String(c.email),
        phone: String(c.phone), notes: String(c.notes),
      }));
    } catch { return []; }
  }

  function saveContacts(arr) {
    localStorage.setItem(CONTACTS_STORE_KEY, JSON.stringify(arr));
  }

  async function handleContactsRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:read', app.id)) {
      return respondError(webview, 'nova:contacts:read', requestId, 'PERMISSION_DENIED', 'contacts:read permission required');
    }
    return respond(webview, 'nova:contacts:read', requestId, { success: true, contacts: loadContacts() });
  }

  async function handleContactsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:write', app.id)) {
      return respondError(webview, 'nova:contacts:write', requestId, 'PERMISSION_DENIED', 'contacts:write permission required');
    }
    const incoming = payload && payload.contact;
    if (!incoming || typeof incoming !== 'object' || typeof incoming.name !== 'string' || !incoming.name.trim()) {
      return respondError(webview, 'nova:contacts:write', requestId, 'INVALID_CONTACT', 'Contact must have at least a name');
    }
    const contact = {
      id: typeof incoming.id === 'string' && incoming.id ? incoming.id : cryptoRandomId(),
      name: incoming.name.trim(),
      email: typeof incoming.email === 'string' ? incoming.email : '',
      phone: typeof incoming.phone === 'string' ? incoming.phone : '',
      notes: typeof incoming.notes === 'string' ? incoming.notes : '',
    };
    const contacts = loadContacts();
    const idx = contacts.findIndex(c => c.id === contact.id);
    if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
    saveContacts(contacts);
    return respond(webview, 'nova:contacts:write', requestId, { success: true, contact });
  }

  async function handleContactsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:delete', app.id)) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'PERMISSION_DENIED', 'contacts:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const contacts = loadContacts();
    const next = contacts.filter(c => c.id !== id);
    const removed = next.length !== contacts.length;
    saveContacts(next);
    return respond(webview, 'nova:contacts:delete', requestId, { success: true, removed });
  }

  // System info

  async function handleSystemInfo({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:system:info', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    return respond(webview, 'nova:system:info', requestId, {
      success: true,
      os: {
        version: OS.version,
        securityPatch: OS.securityPatch,
        username: OS.username,
        uptime: Date.now() - (OS._bootTime || Date.now()),
      },
    });
  }

  // Ready handshake

  async function handleReady({ requestId, app, webview }) {
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const granted = mgr
      ? (app.permissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.permissions || []);
    const optionalGranted = mgr
      ? (app.optionalPermissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.optionalPermissions || []);
    const payload = {
      success: true,
      appId: app.id,
      permissions: granted,
      optionalPermissions: optionalGranted,
      osVersion: OS.version,
      securityPatch: OS.securityPatch,
    };
    // Some apps (see the capability shim / createDefaultAppShell) read the
    // handshake fields directly off the top-level response object rather
    // than through the generic `result` wrapper. The guest-side shim's
    // inbox poller merges `result` fields onto the top level of what it
    // hands back to app code, so a single respond() call covers both
    // shapes — no separate legacy send needed.
    respond(webview, 'nova:ready', requestId, payload);
  }

  // File dialogs

  async function handleDialogOpen({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:dialog:open', requestId, 'PERMISSION_DENIED', 'vfs:read permission required');
    }
    showFileDialog('open', webview, 'nova:dialog:open', requestId, app, payload);
    // Response is sent from the dialog's confirm/cancel handler.
  }

  async function handleDialogSave({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:dialog:save', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    showFileDialog('save', webview, 'nova:dialog:save', requestId, app, payload);
  }

  // New, additional dialog pair: delegates to SystemDialogs — the same
  // shared, Files-app-styled VFS browser that first-party apps (TextEdit,
  // etc.) use. Kept entirely separate from handleDialogOpen/handleDialogSave
  // above (the native-styled dialog), so existing .novaapp callers of
  // nova:dialog:open/save are completely unaffected. Still gated behind the
  // same vfs:read/vfs:write permissions as the native pair — this is a new
  // *visual style* of the same capability, not a new capability.
  async function handleSysDialogOpen({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:read', app.id)) {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'PERMISSION_DENIED', 'vfs:read permission required');
    }
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    try {
      const node = await window.SystemDialogs.open({
        title: payload?.title,
        startFolderId: payload?.startFolderId || FS.rootId,
      });
      if (!node) return respond(webview, 'nova:sysdialog:open', requestId, { cancelled: true });
      respond(webview, 'nova:sysdialog:open', requestId, {
        success: true,
        file: {
          id: node.id,
          name: node.name,
          content: node.content || '',
          mimeType: node.mimeType || 'text/plain',
          size: node.size || 0,
          path: FS.getPath(node.id),
        },
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:open', requestId, 'DIALOG_ERROR', e?.message || 'Dialog failed');
    }
  }

  async function handleSysDialogSave({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:write', app.id)) {
      return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'vfs:write permission required');
    }
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:save', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    try {
      const picked = await window.SystemDialogs.save({
        title: payload?.title,
        suggestedName: payload?.suggestedName || '',
        startFolderId: payload?.startFolderId || FS.rootId,
      });
      if (!picked) return respond(webview, 'nova:sysdialog:save', requestId, { cancelled: true });
      const content = payload?.content || '';
      const mimeType = payload?.mimeType || 'text/plain';
      const newNode = await FS.createFile(picked.folderId, picked.name, content, mimeType);
      respond(webview, 'nova:sysdialog:save', requestId, {
        success: true,
        file: { id: newNode.id, name: newNode.name, path: FS.getPath(newNode.id) },
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:save', requestId, 'WRITE_ERROR', e?.message || 'Failed to write file');
    }
  }

  // Audit: eval
  //
  // Sent by the capability shim whenever an app calls eval(). Historically
  // this only logged, since the CSP allowed 'unsafe-eval' by design — but
  // 'unsafe-eval' has since been removed from RELAXED_CSP_META (see that
  // constant below), so the browser now blocks eval()/new Function() before
  // this handler would ever fire from a real call. This audit path is kept
  // for observability/back-compat only; it does not mean eval is permitted.
  // The shim uses fire-and-forget for this so it doesn't wait on a response,
  // but we send one anyway so any caller using the regular ipc() path
  // (rather than ipcFireAndForget) gets an ack instead of timing out after
  // 30 seconds.

  async function handleAuditEval({ app, payload, requestId, webview }) {
    log('warn', `${app.name} called eval():`, payload?.preview);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: 'warn',
        message: `${app.name} called eval()`,
        data: { appId: app.id, preview: payload?.preview },
      });
    }
    return respond(webview, 'nova:audit:eval', requestId, { success: true });
  }

  // Handler table
  //
  // Maps API type strings to their handler functions. Using a table instead
  // of a long if/else chain makes the dispatch O(1) and lets new APIs be
  // added by appending a single entry.

  const API_HANDLERS = {
    'nova:vfs:read': handleFsRead,
    'nova:vfs:write': handleFsWrite,
    'nova:vfs:delete': handleFsDelete,
    'nova:vfs:list': handleFsList,
    'nova:vfs:mkdir': handleFsMkdir,
    'nova:vfs:stat': handleFsStat,
    'nova:vfs:rename': handleFsRename,
    'nova:vfs:move': handleFsMove,
    'nova:notifications:show': handleNotificationsShow,
    'nova:notifications:clear': handleNotificationsClear,
    'nova:settings:get': handleSettingsGet,
    'nova:settings:set': handleSettingsSet,
    'nova:request-permission': handleRequestPermission,
    'nova:permission-rate-limited': handlePermissionRateLimited,
    'nova:window:close': handleWindowClose,
    'nova:window:minimize': handleWindowMinimize,
    'nova:window:maximize': handleWindowMaximize,
    'nova:window:setTitle': handleWindowSetTitle,
    'nova:window:resize': handleWindowResize,
    'nova:window:getState': handleWindowGetState,
    'nova:clipboard:read': handleClipboardRead,
    'nova:clipboard:write': handleClipboardWrite,
    'nova:app:launch': handleAppLaunch,
    'nova:app:info': handleAppInfo,
    'nova:app:list': handleAppList,
    'nova:app:install': handleAppInstall,
    'nova:app:uninstall': handleAppUninstall,
    'nova:admin:audit': handleAdminAudit,
    'nova:admin:system': handleAdminSystem,
    'nova:admin:users': handleAdminUsers,
    'nova:admin:apps': handleAdminApps,
    'nova:mail:read': handleMailRead,
    'nova:mail:write': handleMailWrite,
    'nova:mail:send': handleMailSend,
    'nova:mail:delete': handleMailDelete,
    'nova:events:subscribe': handleEventsSubscribe,
    'nova:events:unsubscribe': handleEventsUnsubscribe,
    'nova:background:wake-done': handleBackgroundWakeDone,
    'nova:background:stay-alive': handleBackgroundStayAlive,
    'nova:net:fetch': handleNetFetch,
    'nova:net:websocket': handleNetWebsocket,
    'nova:net:ws:send': handleNetWsSend,
    'nova:net:ws:close': handleNetWsClose,
    'nova:storage:get': handleStorageGet,
    'nova:storage:set': handleStorageSet,
    'nova:storage:delete': handleStorageDelete,
    'nova:storage:clear': handleStorageClear,
    'nova:storage:keys': handleStorageKeys,
    'nova:device:geolocation': handleDeviceGeolocation,
    'nova:device:camera': handleDeviceCamera,
    'nova:device:microphone': handleDeviceMicrophone,
    'nova:calendar:read': handleCalendarRead,
    'nova:calendar:write': handleCalendarWrite,
    'nova:calendar:delete': handleCalendarDelete,
    'nova:contacts:read': handleContactsRead,
    'nova:contacts:write': handleContactsWrite,
    'nova:contacts:delete': handleContactsDelete,
    'nova:system:info': handleSystemInfo,
    'nova:ready': handleReady,
    'nova:dialog:open': handleDialogOpen,
    'nova:dialog:save': handleDialogSave,
    'nova:sysdialog:open': handleSysDialogOpen,
    'nova:sysdialog:save': handleSysDialogSave,
    'nova:audit:eval': handleAuditEval,
    'nova:download': handleDownload,
  };

  // Dispatch an incoming IPC message to its handler. Catches sync throws and
  // async rejections so a single misbehaving handler can't take down the
  // bridge. Unknown types get an UNKNOWN_API error response.
  async function handleAPICall(type, payload, requestId, app, webview, sandbox) {
    try {
      const handler = API_HANDLERS[type];
      if (!handler) {
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }
      await handler({ payload, requestId, app, webview, sandbox });
    } catch (err) {
      log('error', `Error handling ${type}:`, err);
      // Guard against a webview that's been destroyed between the call
      // arriving and an async handler throwing — respond would log a
      // spurious error on top of the real one.
      if (webview && typeof webview.executeScript === 'function') {
        respondError(webview, type, requestId, 'INTERNAL_ERROR', err.message || 'Internal error');
      }
    }
  }

  // API bridge setup

  // Marker prefix for guest->host IPC messages sent over console.log. Kept
  // deliberately weird/specific so an ordinary page's own console output
  // (or a malicious app trying to guess it) can't accidentally collide.
  // This is the same mechanism NB Browser already uses for its right-click
  // context menu (see browser.js's _CTX_MARKER + 'consolemessage' listener)
  // — a real, confirmed-working <webview> DOM event for guest->host data on
  // this exact NW.js build, unlike window.parent.postMessage which never
  // reaches the host at all (window.parent === window for a <webview>
  // guest; there is no cross-process parent reference to send to).
  const IPC_MARKER = '__NOVA_IPC__:';

  // Wire up the API bridge for a sandbox.
  //
  // Guest -> host: the guest's shim calls console.log(IPC_MARKER + JSON)
  // instead of window.parent.postMessage. The host listens on the
  // webview's own 'consolemessage' DOM event (fired for every console.*
  // call inside that specific guest — this is scoped per-webview-element,
  // not a global listener, so there's no cross-app source-pinning problem
  // to solve at all: only messages from *this* webview ever reach this
  // handler).
  //
  // Host -> guest: unchanged in shape, still via webview.executeScript
  // (see respond()), since that direction already works.
  //
  // Every message off the wire is treated as untrusted input from
  // app-controlled content and validated before it's allowed to reach
  // handleAPICall:
  //   - must parse as JSON matching the exact expected shape
  //   - `type` must be an exact, known key in API_HANDLERS (an allowlist,
  //     not just "starts with the right prefix" — a made-up type is
  //     rejected outright rather than silently reaching a handler)
  //   - `requestId` must be a non-empty string
  //   - payload validation is then left to each individual handler
  //
  // setupAPIBridge returns an array of teardown steps that createSandbox
  // collects alongside the other setup functions. destroy() runs them all.
  function setupAPIBridge(webview, app, sandboxId) {
    const teardown = [];

    const consoleHandler = (event) => {
      const msg = event?.message;
      if (typeof msg !== 'string' || !msg.startsWith(IPC_MARKER)) return;

      let data;
      try {
        data = JSON.parse(msg.slice(IPC_MARKER.length));
      } catch {
        return; // malformed payload — drop silently, nothing to act on
      }
      if (!data || typeof data !== 'object') return;

      // Note: only {type, requestId} travel over the visible console
      // channel now. The actual payload (which may contain secrets — API
      // keys, auth headers, file bytes) never does; it's pulled back out
      // of the guest's in-memory stash via executeScript below, a
      // host-initiated read that doesn't land in the visible log stream
      // the way console.log broadcasts do.
      const { type, requestId } = data;
      if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(API_HANDLERS, type)) {
        log('warn', `Rejected IPC message with unknown/disallowed type from ${app?.id || 'unknown app'}: ${String(type)}`);
        return;
      }
      if (typeof requestId !== 'string' || !requestId) return;

      // Deliberately NOT { mainWorld: true } — window.__novaOutboxPull now
      // lives inside the isolated-world transport script (see
      // buildIsolatedTransportScript), which is also the only realm that
      // could have produced this console.log message in the first place
      // (the guest's own main-world code never touches console.log or
      // __novaOutboxPull directly anymore). executeScript's default
      // (isolated world) is what reaches it.
      const idLiteral = JSON.stringify(requestId);
      webview.executeScript({
        code: `(function(){ var m = window.__novaOutboxPull || {}; var p = m[${idLiteral}]; delete m[${idLiteral}]; return JSON.stringify(p === undefined ? null : p); })()`,
      }, (results) => {
        let payload = null;
        try {
          const raw = Array.isArray(results) ? results[0] : results;
          payload = raw ? JSON.parse(raw) : null;
        } catch (e) {
          log('warn', `Failed to retrieve IPC payload for ${type} from ${app?.id || 'unknown app'}: ${e.message}`);
          return;
        }
        const sandbox = activeSandboxes.get(sandboxId);
        handleAPICall(type, payload, requestId, app, webview, sandbox);
      });
    };

    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      // Detach OS event subscriptions.
      const subs = eventSubscriptions.get(sandboxId);
      if (subs) {
        for (const [eventName, handler] of subs) {
          try { OS?.events?.off(eventName, handler); } catch { /* best-effort */ }
        }
        subs.clear();
      }
      eventSubscriptions.delete(sandboxId);

      // Close any lingering WebSockets so they don't outlive the sandbox.
      const sandbox = activeSandboxes.get(sandboxId);
      if (sandbox?.wsConnections) {
        for (const [, wsState] of sandbox.wsConnections) {
          try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
        }
        sandbox.wsConnections.clear();
      }

      // Close any open file dialog so the overlay doesn't linger in the DOM.
      const dialog = openDialogs.get(sandboxId);
      if (dialog) {
        dialog.remove();
        openDialogs.delete(sandboxId);
      }

      // Run the collected teardown steps (listeners removed above).
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'teardown step threw', e); }
      }
    };
  }

  // Error handling

  function setupErrorHandling(webview, app) {
    const teardown = [];

    // loadabort fires when webview navigation is cancelled (network error,
    // blocked URL, etc.). Surface it so we can see why apps fail to load.
    const loadAbortHandler = (event) => {
      log('error', `Load aborted in ${app.name}:`, event.reason);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Load aborted in ${app.name}: ${event.reason}`, data: { appId: app.id } });
      }
    };
    webview.addEventListener('loadabort', loadAbortHandler);
    teardown.push(() => webview.removeEventListener('loadabort', loadAbortHandler));

    // consolemessage proxies console output from the webview's separate
    // renderer process. We can't attach to contentWindow directly due to
    // process isolation, so this is the only surface for runtime visibility.
    const consoleHandler = (event) => {
      // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error.
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        log(level, `${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    };
    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'error-handling teardown step threw', e); }
      }
    };
  }

  // Permission request gate (webview-level device permissions)
  //
  // Gate webview-level permission requests (geolocation, media) against
  // AppPermissionManager. The sandboxed webview's permissionrequest event is
  // the only enforcement surface for these device features at the
  // renderer-process boundary. Unrecognised permissions are denied by
  // default — fail-closed is the safe choice.
  function setupPermissionRequestGate(webview, app) {
    const handler = (e) => {
      if (e.permission === 'geolocation') {
        if (AppPermissionManager?.isGranted('device:geolocation', app.id)) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      if (e.permission === 'media') {
        // Chromium's MediaPermissionRequest carries no audio/video sub-type
        // (confirmed against the chrome.webviewTag reference — it's just
        // { url, allow, deny }), so this layer can't tell a camera-only
        // getUserMedia({video:true}) call apart from a mic-only or
        // combined one. Requiring BOTH device:camera AND device:microphone
        // would wrongly block an app that's only been granted (and only
        // asked for) one of the two. Allowing on EITHER being granted is
        // the correct trade-off here: the actual audio/video split is
        // still enforced by whatever constraints the guest's own
        // getUserMedia() call passes — this gate only decides whether the
        // app may use the media permission surface at all.
        const camOk = AppPermissionManager?.isGranted('device:camera', app.id);
        const micOk = AppPermissionManager?.isGranted('device:microphone', app.id);
        if (camOk || micOk) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      // Default-deny any permission we don't explicitly handle. The previous
      // implementation left these to the webview's default, which is
      // non-portable and can silently allow access.
      if (typeof e.request.deny === 'function') e.request.deny();
    };
    webview.addEventListener('permissionrequest', handler);
    return () => webview.removeEventListener('permissionrequest', handler);
  }

  // Capability shim
  //
  // Injected as the first <script> in every packaged app's HTML. Overrides
  // fetch / XHR / eval / sendBeacon so apps that use standard web APIs work
  // transparently — all network goes through the IPC bridge where
  // permissions are enforced. connect-src 'none' in the served CSP ensures
  // nothing bypasses this at the browser level.
  //
  // The shim also exposes window.nova for apps that want to call the IPC
  // bridge directly (e.g. to request permissions or subscribe to events).

  // Whether this app's guest content is allowed to instantiate its own
  // nested <webview> tag. System apps (SYSTEM_SANDBOX_APPS) are exempt by
  // appId, same as the allow-same-origin exemption below — everyone else
  // (i.e. every .novaapp third-party package) needs the manifest to opt in
  // AND hold the 'sandbox:nested-webview' permission, checked fresh at
  // load time. Fail-closed: any error, missing manager, or ungranted state
  // defaults to blocked.
  function isNestedWebviewPermitted(app) {
    if (!app) return false;
    if (SYSTEM_SANDBOX_APPS.has(app.id)) return true;
    // NOTE: flattened top-level field (app.allowNestedWebview), matching how
    // `sandbox`/`permissions`/etc. are flattened onto the sandboxApp object
    // in appmanager.js's buildNovaAppConfig() — NOT app.manifest.allowNestedWebview.
    // The app object AppSandbox.launch() receives is built from an explicit
    // field allowlist there and never carries a `manifest` property, so
    // checking app.manifest would always silently read undefined and fail
    // closed. See appmanager.js's sandboxApp construction.
    const manifestOptIn = app.allowNestedWebview === true;
    if (!manifestOptIn) return false;
    try {
      return AppPermissionManager?.isGranted('sandbox:nested-webview', app.id) === true;
    } catch (_) {
      return false;
    }
  }

  // Marker used on the postMessage bridge between the isolated transport
  // script and the main-world capability shim. Deliberately distinct from
  // IPC_MARKER (the guest->host console.log marker) — this one never
  // leaves the guest's own window, it just tags same-window postMessage
  // traffic so the transport/shim pair can tell their own messages apart
  // from anything else that might call postMessage on this window.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  // Builds the isolated-world transport content script. This owns the
  // ONLY code path that can produce a valid guest->host IPC message
  // (console.log(IPC_MARKER + ...)) or read a host->guest response
  // (window.__novaInbox). It is injected via webview.addContentScripts()
  // at run_at: 'document_start', which — unlike a <script> spliced into
  // the guest's own HTML — runs in a separate JS realm (Chromium's
  // "isolated world", same mechanism as Chrome extension content
  // scripts) that the guest's own page script cannot reach, patch, or
  // race against. See JavaScript Contexts in NW.js docs: isolated and
  // main-world scripts share the DOM but not JS globals, so this talks
  // to the main-world capability shim (buildCapabilityShim below) purely
  // via same-window postMessage, tagged with BRIDGE_MARKER.
  //
  // Concretely, this closes two things the old single-realm shim could
  // not: (1) a guest page redefining console.log before the shim's IIFE
  // ran could previously blind or spoof the IPC channel — now that
  // channel lives in a realm the guest's console.log override never
  // touches; (2) window.__novaInbox / window.__novaOutboxPull used to be
  // plain globals on the guest's own window, readable/writable by any
  // guest script — now they're closures inside this isolated script,
  // invisible to window.* lookups from the main world.
  function buildIsolatedTransportScript() {
    return `(function() {
  'use strict';
  const IPC_MARKER = ${JSON.stringify(IPC_MARKER)};
  const BRIDGE_MARKER = ${JSON.stringify(BRIDGE_MARKER)};

  // Host->guest responses land here, pushed to by respond() in
  // app-sandbox.js via executeScript targeting this isolated world
  // specifically (not mainWorld: true — see respond()'s comments).
  window.__novaInbox = window.__novaInbox || [];
  // Guest->host request payloads (may contain secrets) live here,
  // pulled by the host via a host-initiated executeScript read — never
  // broadcast, so never visible in the console stream. Same shape as
  // the pre-split design; only WHERE it lives has changed (isolated
  // world instead of the guest's own main-world window object).
  window.__novaOutboxPull = window.__novaOutboxPull || {};
  const pendingPayloads = window.__novaOutboxPull;

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'xport_' + window.crypto.randomUUID();
    }
    return 'xport_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Relay a request from the main-world shim out to the host. Only the
  // {type, requestId} pair ever appears in the visible console stream —
  // matches the guarantee the original single-realm shim made.
  function sendToHost(type, payload, requestId) {
    try {
      pendingPayloads[requestId] = payload;
      console.log(IPC_MARKER + JSON.stringify({ type: type, requestId: requestId }));
    } catch (e) {
      // Deliver a synthetic error back to the main world so its pending
      // promise doesn't hang forever if console.log itself throws.
      deliverToMainWorld({ __novaBridge: BRIDGE_MARKER, kind: 'response', requestId: requestId,
        type: type + ':response', result: null, error: { code: 'TRANSPORT_ERROR', message: String(e && e.message || e) } });
    }
  }

  // Forward a host response (or pushed event) to the main-world shim.
  function deliverToMainWorld(msg) {
    try { window.postMessage(msg, window.location.origin); }
    catch (e) { /* best-effort — a torn-down guest window can throw here */ }
  }

  // Same idle-backoff poller design as the original shim, just relocated:
  // drains window.__novaInbox (host responses / pushed events) and
  // forwards each message to the main world over postMessage instead of
  // resolving a same-realm Promise map directly.
  const POLL_BASELINE_MS = 50;
  const POLL_IDLE_MS = 250;
  const POLL_IDLE_THRESHOLD = 20;
  let pollInterval = POLL_BASELINE_MS;
  let emptyPolls = 0;

  function drainInbox() {
    const inbox = window.__novaInbox;
    if (!inbox || !inbox.length) {
      emptyPolls++;
      if (emptyPolls > POLL_IDLE_THRESHOLD && pollInterval < POLL_IDLE_MS) pollInterval = POLL_IDLE_MS;
      return;
    }
    emptyPolls = 0;
    if (pollInterval !== POLL_BASELINE_MS) pollInterval = POLL_BASELINE_MS;

    const drained = inbox.splice(0, inbox.length);
    for (let i = 0; i < drained.length; i++) {
      const msg = drained[i];
      if (!msg || typeof msg.type !== 'string') continue;
      deliverToMainWorld(Object.assign({ __novaBridge: BRIDGE_MARKER, kind: 'response' }, msg));
    }
  }

  function scheduleNextPoll() {
    setTimeout(function() { drainInbox(); scheduleNextPoll(); }, pollInterval);
  }
  scheduleNextPoll();

  // Requests arrive from the main-world shim via postMessage. event.source
  // === window is the load-bearing check here: this isolated script and
  // the main-world shim share the same window object (same document,
  // different JS realm), so a same-window, same-origin postMessage is
  // exactly what a legitimate call from our own shim looks like. Nothing
  // outside this window (no nested iframe, no opener) can produce an
  // event.source === window match against this window's own identity.
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'request') return;
    if (typeof data.type !== 'string' || typeof data.requestId !== 'string') return;
    sendToHost(data.type, data.payload, data.requestId);
  });
})();`;
  }

  // Builds the capability shim string for a given app. `nestedWebviewAllowed`
  // is baked in as a literal at injection time (not re-checked async inside
  // the guest — permission grants are host-side and the guest has no safe
  // synchronous way to ask), so this must be regenerated per-app/per-load
  // rather than reused as a static constant.
  function buildCapabilityShim(nestedWebviewAllowed) {
  return `<script>
(function() {
  'use strict';
  const REQUEST_TIMEOUT_MS = 30000;
  // Baked in at injection time from the host-side permission check —
  // see isNestedWebviewPermitted() in app-sandbox.js. Never trust a guest
  // to self-report this.
  const __NOVA_NESTED_WEBVIEW_ALLOWED__ = ${nestedWebviewAllowed ? 'true' : 'false'};

  // A handful of channels block on a human making a decision in a native
  // OS dialog (choosing where to save, which file to open) rather than on
  // a normal async operation — 30s is fine for everything else, but too
  // short here: someone can take well over 30 seconds browsing folders
  // and typing a filename, and hitting the generic timeout mid-decision
  // produced a real bug (a stale "IPC request timed out" rejection while
  // the dialog was still legitimately open, unrelated to the user
  // actually cancelling). These get a much longer timeout instead of
  // none at all, so a truly stuck/never-resolving call still eventually
  // surfaces as an error rather than hanging the caller forever.
  const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const INTERACTIVE_CHANNELS = {
    'nova:download': true,
    'nova:dialog:open': true,
    'nova:dialog:save': true,
    'nova:sysdialog:open': true,
    'nova:sysdialog:save': true,
  };
  const pendingRequests = new Map();
  // Must exactly match BRIDGE_MARKER in app-sandbox.js's
  // buildIsolatedTransportScript(). This shim never touches IPC_MARKER or
  // console.log directly anymore — that channel now lives entirely inside
  // the isolated-world transport script (injected separately via
  // addContentScripts), which this shim can only reach by postMessage.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'shim_' + window.crypto.randomUUID();
    }
    return 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Send a nova: IPC message and resolve on response. Rejects on timeout or
  // when the host returns an error.
  //
  // This posts the request to the isolated-world transport script rather
  // than touching console.log or window.__novaOutboxPull itself. Those now
  // live in a separate JS realm this main-world code cannot reach — which
  // is deliberate: it means nothing running in this document (including a
  // malicious app that has otherwise fully compromised this realm, e.g. by
  // patching Object.prototype or console.log) can forge, read, or tamper
  // with the actual privileged channel. The public contract of ipc() is
  // unchanged: same Promise, same resolve/reject shape, same timeouts —
  // only the transport underneath moved.
  //
  // event.source === window is the check that matters on the receiving
  // end (see the 'message' listener below and the isolated script's own
  // listener) — a same-window postMessage can only originate from code
  // that shares this exact window object, i.e. this shim or the isolated
  // transport script, never a nested iframe or external page.
  function ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      const id = generateId();
      const timeoutMs = INTERACTIVE_CHANNELS[type] ? INTERACTIVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new TypeError('IPC request timed out: ' + type));
        }
      }, timeoutMs);
      pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        window.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'request', type: type, payload: payload, requestId: id }, window.location.origin);
      } catch (e) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  // Responses (and pushed events) arrive via postMessage from the
  // isolated-world transport script — see buildIsolatedTransportScript()
  // in app-sandbox.js, which drains window.__novaInbox on its own poll
  // loop and forwards each message here. This shim no longer touches
  // window.__novaInbox itself (it lives in a different JS realm now), so
  // there's nothing left to poll on this side — just a listener.
  //
  // Same event.source === window check as ipc()'s send path: only
  // same-window postMessage traffic is accepted, which in practice means
  // only the isolated transport script (or this shim itself) can be the
  // source, since both share this window object but nothing outside it
  // does.
  function handleInboxMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    // Pushed events (unprompted, no requestId round-trip) — dispatched
    // to onEvent listeners registered for this event name.
    if (msg.type === 'nova:events:event:response' && msg.result && msg.result.event) {
      const listeners = eventListeners[msg.result.event] || [];
      for (let j = 0; j < listeners.length; j++) {
        try { listeners[j](msg.result.data); } catch (_) {}
      }
      return;
    }

    // Pushed WebSocket events (message/error/close) — also unprompted,
    // sent with a fresh requestId that was never registered in
    // pendingRequests, so without this branch they'd hit the
    // "!entry -> return" fallthrough below and silently vanish.
    // Dispatched to listeners registered per-wsId via window.nova.websocket().
    if ((msg.type === 'nova:net:ws:message:response' || msg.type === 'nova:net:ws:error:response' || msg.type === 'nova:net:ws:close:response')
        && msg.result && msg.result.wsId) {
      const wsListeners = wsEventListeners[msg.result.wsId];
      if (wsListeners) {
        const kind = msg.type === 'nova:net:ws:message:response' ? 'message'
          : msg.type === 'nova:net:ws:error:response' ? 'error' : 'close';
        const cbs = wsListeners[kind] || [];
        for (let k = 0; k < cbs.length; k++) {
          try { cbs[k](msg.result); } catch (_) {}
        }
        if (kind === 'close') delete wsEventListeners[msg.result.wsId];
      }
      return;
    }

    // Pushed background wake calls (system:background scheduled wake) —
    // also unprompted, same shape as the events branch above. Dispatched
    // to listeners registered via window.nova.onBackgroundWake(). The
    // host only ever sends this to a sandbox it started specifically for
    // a wake cycle (see AppScheduler.wake in app-sandbox.js) — there's no
    // separate permission check needed here on the guest side, since the
    // host already gated the wake itself on system:background before
    // this sandbox was even created.
    if (msg.type === 'nova:background:wake:response') {
      for (let w = 0; w < backgroundWakeListeners.length; w++) {
        try { backgroundWakeListeners[w](msg.result || {}); } catch (_) {}
      }
      return;
    }

    if (typeof msg.requestId !== 'string') return;
    const entry = pendingRequests.get(msg.requestId);
    if (!entry) return;
    pendingRequests.delete(msg.requestId);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(Object.assign(new Error(msg.error.message || 'IPC error'), msg.error));
      return;
    }

    // Merge result fields onto the top level too, since some app code
    // (see createDefaultAppShell) reads handshake fields directly off
    // the response rather than through a result wrapper.
    const out = Object.assign({}, msg.result, { result: msg.result, type: msg.type });
    entry.resolve(out);

    // Ready-handshake fix: surface permissions on window for
    // late-loading scripts, and re-render the calendar once DOM is
    // ready, same as the old dedicated 'nova:ready:response' handler
    // used to do before nova:ready went through the normal ipc() path.
    if (msg.type === 'nova:ready:response' && msg.result) {
      try {
        window.__novaPermResponse = {
          permissions: msg.result.permissions || [],
          optionalPermissions: msg.result.optionalPermissions || [],
        };
      } catch (_) {}
      let renderFn = null;
      try { renderFn = (typeof renderCalendar === 'function') ? renderCalendar : null; } catch (_) {}
      if (renderFn) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function _rr() {
            document.removeEventListener('DOMContentLoaded', _rr);
            try { renderFn(); } catch (_) {}
          });
        } else {
          try { renderFn(); } catch (_) {}
        }
      }
    }
  }

  // Listens for postMessage traffic from the isolated-world transport
  // script. Replaces the old setInterval-based drainInbox() poller — this
  // is push-based now (the transport script only posts when it actually
  // has something), so there's no idle-backoff tuning needed on this side
  // anymore; that trade lives in the transport script's own poll of
  // window.__novaInbox, which this shim can no longer see directly.
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'response') return;
    handleInboxMessage(data);
  });

  // Download interceptor
  // <webview> tags can't hand a blob: URL to the host — blob URLs are
  // memory-backed and scoped to the browsing context that created them,
  // so window.parent has no way to dereference one even if it has the
  // string. What CAN cross the boundary is the blob's actual bytes.
  //
  // We override the native click() on <a download> elements pointing at
  // blob: URLs: read the blob back out with fetch() (same-context, so
  // this works), base64-encode it, and ship the bytes to the host over
  // the existing IPC bridge. The host does the real save-as. Apps using
  // the standard createObjectURL + <a download> + click() pattern need
  // no changes — this is transparent.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  // Captured here, before the network-permission override further down
  // replaces window.fetch with a version that routes everything through
  // nova:net:fetch. blob: URLs aren't network requests — routing them
  // through that bridge sends the literal string "blob:..." to the host
  // as if it were a fetchable resource, which always fails. This
  // interceptor needs the real, unpatched fetch to read blob bytes
  // in-context, so grab it now while it's still native.
  const nativeFetchForDownloads = window.fetch.bind(window);
  HTMLAnchorElement.prototype.click = function() {
    const href = this.href || '';
    const filename = this.download;
    if (filename && href.indexOf('blob:') === 0) {
      nativeFetchForDownloads(href)
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
          const reader = new FileReader();
          reader.onload = function() {
            // reader.result is a data URL: "data:<mime>;base64,<data>"
            const result = String(reader.result || '');
            const commaIdx = result.indexOf(',');
            const base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
            ipc('nova:download', {
              filename: filename,
              mimeType: blob.type || 'application/octet-stream',
              base64Data: base64Data
            }).catch(function(err) {
              console.error('Download interceptor: download failed', err);
            });
          };
          reader.onerror = function() {
            console.error('Download interceptor: failed to read blob for download');
          };
          reader.readAsDataURL(blob);
        })
        .catch(function(err) {
          console.error('Download interceptor: failed to fetch blob for download', err);
        });
      return; // suppress the native click — it would just navigate/no-op
    }
    return nativeAnchorClick.call(this);
  };

  // Registered onEvent callbacks, checked by the inbox poller whenever a
  // pushed 'nova:events:event' notification arrives (the host pushes
  // these unprompted, not in response to a specific ipc() call, so they
  // need their own dispatch rather than the requestId-keyed one above).
  const eventListeners = {}; // eventName -> [callback, ...]

  // Callbacks registered via window.nova.onBackgroundWake(). Plain array,
  // not keyed by name — there's exactly one wake channel per sandbox
  // instance (this whole sandbox exists only for the duration of one wake
  // cycle; see AppScheduler.wake), unlike eventListeners above which fans
  // out across many different named OS events in a long-lived window.
  const backgroundWakeListeners = [];

  // wsId -> { message: [cb,...], error: [cb,...], close: [cb,...] }
  // Populated by window.nova.websocket(); read by the inbox poller above.
  const wsEventListeners = {};

  // Public API for apps that want to use the bridge directly.
  window.nova = {
    ipc: ipc,
    requestPermission: function(permission, reason) {
      return ipc('nova:request-permission', { permission: permission, reason: reason });
    },
    onEvent: function(eventName, callback) {
      if (!eventListeners[eventName]) eventListeners[eventName] = [];
      eventListeners[eventName].push(callback);
      return ipc('nova:events:subscribe', { event: eventName });
    },
    // system:background scheduled-wake support. The host only ever spins
    // up a sandbox for a wake cycle if the app holds system:background —
    // there's no separate permission call needed here, unlike most of the
    // rest of this API, since the wake happening at all IS the permission
    // check having already passed (see AppScheduler.wake). The callback
    // gets a bounded window (see wakeInfo.deadlineMs, matching the same
    // clock the host is timing the wake against) to do its work before the
    // host tears this sandbox down regardless — this is a brief scheduled
    // wake, not a way to stay alive; apps wanting to persist need
    // system:background:live instead, which is a different, bigger grant.
    onBackgroundWake: function(callback) {
      backgroundWakeListeners.push(callback);
    },
    // Lets a wake handler tell the host it finished early, so the host
    // doesn't have to sit through the full deadline before tearing the
    // sandbox down. Optional — if never called, the host just waits out
    // the deadline and tears down anyway.
    backgroundWakeDone: function() {
      return ipc('nova:background:wake-done', {});
    },
    // Opt this session into staying alive if the window closes (requires
    // system:background:live). Call with no args to enable, or
    // stayAliveInBackground(false) to change your mind before closing.
    // Session-only — call again next launch if you want it again.
    stayAliveInBackground: function(enabled) {
      return ipc('nova:background:stay-alive', { enabled: enabled !== false });
    },
    // Convenience wrapper around nova:net:websocket + ws:send/ws:close so
    // apps don't have to hand-roll requestId bookkeeping. Returns a promise
    // that resolves once the socket is open (mirrors host's onopen-only
    // response — see NOTE below) with a small handle object.
    //
    // NOTE: the host only ever resolves this ipc() call from the socket's
    // onopen handler. If the connection never opens (bad host, connection
    // refused, TLS failure before handshake), there is no host-side
    // reject path — the call will sit until the shim's own IPC timeout
    // fires and rejects with a generic "IPC request timed out" error
    // rather than a specific connection-failure reason. Callers should
    // treat that timeout as a real (if under-specific) connection failure,
    // not assume something is hung on the guest side.
    websocket: function(url, protocols) {
      return ipc('nova:net:websocket', { url: url, protocols: protocols }).then(function(res) {
        const wsId = res.wsId || (res.result && res.result.wsId);
        if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
        wsEventListeners[wsId] = { message: [], error: [], close: [] };
        return {
          wsId: wsId,
          readyState: res.readyState,
          onMessage: function(cb) { wsEventListeners[wsId].message.push(cb); },
          onError: function(cb) { wsEventListeners[wsId].error.push(cb); },
          onClose: function(cb) { wsEventListeners[wsId].close.push(cb); },
          send: function(data) { return ipc('nova:net:ws:send', { wsId: wsId, data: data }); },
          close: function(code, reason) { return ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }); },
        };
      });
    },
    // Camera/microphone can't be proxied through the IPC bridge like
    // geolocation coordinates — a MediaStream isn't serializable, and
    // nova:device:camera/microphone only check AppPermissionManager, they
    // don't (and can't) hand back a stream. So this wrapper does the
    // app-level check first, and only calls the real getUserMedia() here
    // in the guest's own document if that check passes. The browser-level
    // decision still happens separately, via this document's own
    // permissionrequest gate (see setupPermissionRequestGate's 'media'
    // branch in app-sandbox.js) when getUserMedia() itself is called.
    getUserMedia: function(constraints) {
      constraints = constraints || {};
      const needsCamera = !!constraints.video;
      const needsMic = !!constraints.audio;
      const checks = [];
      if (needsCamera) checks.push(ipc('nova:device:camera', {}));
      if (needsMic) checks.push(ipc('nova:device:microphone', {}));
      if (checks.length === 0) {
        return Promise.reject(new TypeError('getUserMedia requires at least one of video/audio in constraints'));
      }
      return Promise.all(checks).then(function() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          return Promise.reject(new TypeError('getUserMedia not available in this environment'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });
      // Any PERMISSION_DENIED from the ipc() calls above rejects here
      // naturally (ipc() rejects on error responses), so callers see the
      // same app-level denial they'd get from any other nova:* call,
      // before ever reaching the browser's own permission prompt.
    },
    // Calendar/contacts read/write the SAME shared data the host
    // Calendar/Contacts apps use (not a per-app isolated store) — see the
    // handleCalendar*/handleContacts* comments in app-sandbox.js for why.
    calendar: {
      list: function() { return ipc('nova:calendar:read', {}); },
      save: function(event) { return ipc('nova:calendar:write', { event: event }); },
      remove: function(id) { return ipc('nova:calendar:delete', { id: id }); }
    },
    contacts: {
      list: function() { return ipc('nova:contacts:read', {}); },
      save: function(contact) { return ipc('nova:contacts:write', { contact: contact }); },
      remove: function(id) { return ipc('nova:contacts:delete', { id: id }); }
    },
    // list/uninstall are plain reads/writes on the app registry.
    // install fails closed on anything a human would normally need to
    // click through (untrusted signer, tampered contents, already
    // installed) — see the handleAppInstall comment in app-sandbox.js.
    apps: {
      list: function() { return ipc('nova:app:list', {}); },
      launch: function(appId, options) { return ipc('nova:app:launch', { appId: appId, options: options || {} }); },
      install: function(pkg) { return ipc('nova:app:install', { package: pkg }); },
      uninstall: function(appId) { return ipc('nova:app:uninstall', { appId: appId }); }
    },
    // admin:* — requires both the per-app permission grant AND the
    // machine's local admin flag to be on (set in Settings). Granting an
    // app one of these permissions doesn't put the machine in admin mode
    // by itself.
    admin: {
      auditQuery: function(filters) { return ipc('nova:admin:audit', filters || {}); },
      systemGet: function() { return ipc('nova:admin:system', { action: 'get' }); },
      systemSet: function(settings) { return ipc('nova:admin:system', { action: 'set', settings: settings }); },
      usersList: function() { return ipc('nova:admin:users', { action: 'list' }); },
      usersRevoke: function(sessionId) { return ipc('nova:admin:users', { action: 'revoke', sessionId: sessionId }); },
      appsList: function() { return ipc('nova:admin:apps', {}); }
    },
    // mail:* reuses whatever account is connected in the host shell's
    // Email app (session-scoped) — there's no separate per-app mail
    // identity. Fails with UNAVAILABLE if nothing is connected.
    mail: {
      account: function() { return ipc('nova:mail:read', { action: 'account' }); },
      folders: function() { return ipc('nova:mail:read', { action: 'folders' }); },
      messages: function(opts) { return ipc('nova:mail:read', Object.assign({ action: 'messages' }, opts || {})); },
      message: function(uid, folder) { return ipc('nova:mail:read', { action: 'message', uid: uid, folder: folder }); },
      search: function(query, folder) { return ipc('nova:mail:read', { action: 'search', query: query, folder: folder }); },
      preview: function(html) { return ipc('nova:mail:write', { action: 'preview', html: html }); },
      markRead: function(uids, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'read', uids: uids, folder: folder }); },
      move: function(uids, dest, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'move', uids: uids, dest: dest, folder: folder }); },
      send: function(msg) { return ipc('nova:mail:send', msg || {}); }, // msg: { to, cc, bcc, subject, text, html, smtpHost, smtpPort }
      remove: function(uids, folder) { return ipc('nova:mail:delete', { uids: uids, folder: folder }); }
    }
  };

  // Self-triggered handshake — every app gets this automatically on load,
  // rather than needing to remember to call it. Runs the same
  // ready-handshake side effects (permissions surfaced on window,
  // calendar re-render) via the __novaInbox poller above once the
  // response arrives.
  ipc('nova:ready', {}).catch(function(e) {
    console.error('nova:ready handshake failed:', e);
  });

  // Override fetch — route through the IPC bridge.
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    const headers = init.headers || (input && input.headers) || {};
    const headerObj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(v, k) { headerObj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function(pair) { headerObj[pair[0]] = pair[1]; });
    } else if (headers && typeof headers === 'object') {
      for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) headerObj[k] = headers[k];
    }
    const body = init.body != null ? init.body : null;
    let bodyStr = null;
    if (typeof body === 'string') bodyStr = body;
    else if (body instanceof ArrayBuffer) bodyStr = new TextDecoder().decode(body);
    else if (body instanceof Uint8Array) bodyStr = new TextDecoder().decode(body);
    else if (body == null) bodyStr = null;
    else bodyStr = String(body);

    return ipc('nova:net:fetch', { url: url, method: method, headers: headerObj, body: bodyStr })
      .then(function(res) {
        if (!res || !res.success) throw new TypeError('Fetch failed');
        const responseInit = { status: res.status, statusText: res.statusText, headers: new Headers(res.headers || {}) };
        return new Response(res.body || '', responseInit);
      });
  };

  // Minimal XMLHttpRequest override that routes through the fetch shim.
  // Covers the common API surface (open/send/setRequestHeader/onload/onerror/
  // onreadystatechange/status/responseText). Advanced features (upload
  // events, progress, responseType blob) are not implemented — apps needing
  // those should use fetch directly.
  function NovaXHR() {
    const xhr = this;
    let method = 'GET', url = '', headers = {}, body = null;
    let state = 0;
    // aborted flag tracks whether the caller cancelled the request so
    // the late-arriving fetch callback can short-circuit instead of
    // mutating state and firing load/error listeners on a dead object
    // (the previous version's abort() set state=0 but the fetch still
    // resolved and overwrote everything, so abort was effectively a no-op
    // for any request that had already been sent).
    let aborted = false;
    const listeners = { load: [], error: [], readystatechange: [], loadend: [], abort: [], timeout: [] };

    Object.defineProperty(this, 'readyState', { get: function() { return state; }, configurable: true });
    Object.defineProperty(this, 'status', { get: function() { return xhr._status || 0; }, configurable: true });
    Object.defineProperty(this, 'statusText', { get: function() { return xhr._statusText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseText', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'response', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseURL', { get: function() { return url; }, configurable: true });

    this.open = function(m, u) { method = (m || 'GET').toUpperCase(); url = u || ''; state = 1; };
    this.setRequestHeader = function(k, v) { headers[k] = v; };
    this.getAllResponseHeaders = function() { return xhr._responseHeaders || ''; };
    this.getResponseHeader = function(k) { return (xhr._responseHeaderMap || {})[k.toLowerCase()] || null; };
    this.abort = function() {
      aborted = true;
      state = 0;
      listeners.abort.forEach(function(h) { h.call(xhr); });
    };
    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };

    this.send = function(b) {
      body = b;
      window.fetch(url, { method: method, headers: headers, body: typeof body === 'string' ? body : null })
        .then(function(res) {
          if (aborted) return; // caller cancelled — drop silently
          state = 2;
          xhr._status = res.status;
          xhr._statusText = res.statusText;
          const headerMap = {};
          const headerLines = [];
          res.headers.forEach(function(v, k) { headerMap[k.toLowerCase()] = v; headerLines.push(k + ': ' + v); });
          xhr._responseHeaderMap = headerMap;
          xhr._responseHeaders = headerLines.join('\\r\\n');
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          return res.text();
        })
        .then(function(text) {
          if (aborted) return;
          xhr._responseText = text;
          state = 3;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          state = 4;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          listeners.load.forEach(function(h) { h.call(xhr); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        })
        .catch(function(err) {
          if (aborted) return;
          xhr._error = err;
          state = 4;
          listeners.error.forEach(function(h) { h.call(xhr, err); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        });
    };
  }
  window.XMLHttpRequest = NovaXHR;

  // Fire-and-forget send: same postMessage bridge as ipc(), but with no
  // pendingRequests entry since nothing here waits on a reply.
  function ipcFireAndForget(type, payload) {
    try {
      const id = generateId();
      window.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'request', type: type, payload: payload, requestId: id }, window.location.origin);
    } catch { /* best-effort */ }
  }

  // Audit eval calls. This wrapper is now effectively dead code for direct
  // eval() — the CSP no longer includes 'unsafe-eval', so the browser
  // itself throws a CSP violation before this function body ever runs.
  // Left in place (harmless) in case CSP is ever relaxed again; if you're
  // reading this because eval() calls aren't being logged, check whether
  // 'unsafe-eval' is back in RELAXED_CSP_META first.
  // NOTE: this only ever wrapped window.eval — new Function(...) is a
  // separate code-execution path that was never audited here, and is now
  // blocked by the same CSP change rather than logged.
  const originalEval = window.eval;
  window.eval = function(code) {
    const preview = String(code).slice(0, 200);
    ipcFireAndForget('nova:audit:eval', { preview: preview });
    // Wrapping eval in a function makes this indirect eval regardless of
    // how it's called — direct eval's special-case only applies to a
    // bare eval(...) call, not to a function wrapper. Indirect eval
    // runs in global scope, which is what we want here since the audit
    // hook shouldn't capture the calling function's local scope.
    return (0, originalEval)(code);
  };

  // Override sendBeacon — fire-and-forget POST through the IPC bridge.
  // Returns true synchronously to match the native API contract; the actual
  // permission check happens host-side and the result is dropped.
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try {
        const body = typeof data === 'string' ? data : (data && data.toString ? data.toString() : '');
        ipcFireAndForget('nova:net:fetch', { url: url, method: 'POST', headers: {}, body: body });
        return true;
      } catch {
        return false;
      }
    };
  }

  // Nested <webview> lockdown
  //
  // A <webview> tag the guest's OWN content creates is a second, independent
  // renderer process this guest would control directly — a much bigger
  // capability than anything else this shim gates, since none of the outer
  // sandbox's own webview attributes (nodeintegration, partition, sandbox
  // tokens) apply to a tag the guest instantiates itself. Blocked by
  // default; only bypassed when the host baked in
  // __NOVA_NESTED_WEBVIEW_ALLOWED__ = true for this specific app (system
  // apps, or a .novaapp that both declared allowNestedWebview in its
  // manifest AND holds the 'sandbox:nested-webview' grant — see
  // isNestedWebviewPermitted() host-side).
  //
  // Three insertion paths are covered, since blocking only one leaves the
  // others wide open:
  //   1. document.createElement('webview') — the normal, scriptable path.
  //   2. innerHTML / outerHTML / insertAdjacentHTML — the HTML parser can
  //      create a <webview> without ever calling createElement.
  //   3. A MutationObserver backstop — catches anything that slips past
  //      1/2 (e.g. a future API, or a parser edge case), by removing any
  //      <webview> element the instant it's actually attached to the DOM.
  if (!__NOVA_NESTED_WEBVIEW_ALLOWED__) {
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'createElement' });
        // Return an inert, disconnected <span> rather than throwing — a
        // throw here would crash whatever app code called createElement
        // (often inside a try/catch-less render path), turning a security
        // block into an unrelated-looking app crash. An inert element that
        // silently does nothing when appended is a much smaller surprise.
        return originalCreateElement.call(this, 'span');
      }
      return originalCreateElement.call(this, tagName, options);
    };

    // Covers innerHTML/outerHTML — both funnel through the same setter,
    // which is what we patch here rather than trying to catch every
    // possible property name.
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerHTMLDesc && innerHTMLDesc.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: innerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'innerHTML' });
            value = value.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
          }
          return innerHTMLDesc.set.call(this, value);
        },
        configurable: true,
      });
    }

    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (typeof text === 'string' && /<webview[\\s>]/i.test(text)) {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'insertAdjacentHTML' });
        text = text.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
      }
      return originalInsertAdjacentHTML.call(this, position, text);
    };

    // Backstop: if a <webview> still makes it into the live DOM through
    // some path the above didn't anticipate, rip it out immediately rather
    // than letting it sit there and load. Runs for the lifetime of the
    // document — cheap, since <webview> insertion is not a hot path.
    const nestedWebviewObserver = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'WEBVIEW') {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer' });
            node.remove();
            continue;
          }
          if (typeof node.querySelectorAll === 'function') {
            const nested = node.querySelectorAll('webview');
            if (nested.length) {
              ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer-descendant' });
              nested.forEach((n) => n.remove());
            }
          }
        }
      }
    });
    // documentElement always exists by the time this inline script runs
    // (it's injected right after <head>), so no readiness check needed.
    nestedWebviewObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
\x3C/script>`;
  }

  // CSP meta tag injected into app HTML. Allows inline scripts/styles (apps
  // need this) and eval (the audit hook catches abuse), but blocks all direct
  // network access via connect-src 'none' — forcing network through the IPC
  // bridge where permissions are enforced.
  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\'; script-src \'self\' blob: \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob: http://localhost:* https://localhost:*">';

  // Prepend the capability shim as the very first bytes of the app's HTML,
  // unconditionally — not after a regex-matched <head> tag.
  //
  // The old version replaced the first /<head(\s[^>]*)?>/i match, which
  // means the insertion point depended on how the app's own (untrusted)
  // HTML happened to be written: a document with no <head> tag, a
  // malformed one the regex didn't match, or one wrapped in something
  // that shifted where the match landed, could all change where the shim
  // ended up relative to the app's own inline scripts — and script tags
  // execute in document order, so losing the "first" guarantee here would
  // let an app's own script run before the shim's, which is exactly the
  // race this rewrite is closing. Unconditional prepend removes that
  // dependency on the input entirely: whatever the app's HTML contains,
  // the shim is textually first, full stop. Browsers parse and execute a
  // leading <script> correctly even before a <head>/<html> tag appears
  // (they're implied), so this doesn't require well-formed input either.
  //
  // `app` is required to decide the nested-<webview> grant for THIS app —
  // see isNestedWebviewPermitted(). Passing no app is treated as no app
  // (fails closed to "not permitted"), it does not fall back to some
  // shared/cached shim from a previous call.
  function injectCapabilityShim(html, app) {
    if (typeof html !== 'string') return html;
    const shim = buildCapabilityShim(isNestedWebviewPermitted(app));
    return shim + '\n' + RELAXED_CSP_META + '\n' + html;
  }

  // App loading

  // Load app content into a sandbox. For webapps (external URLs), validates
  // the protocol before assigning to webview.src — without this, a malicious
  // manifest could specify javascript: or file: URLs.
  async function loadAppContent(webview, app, state) {
    if (app.type === 'webapp' && app.url) {
      const classified = resolveAndClassifyUrl(app.url);
      if (!classified.valid) {
        log('error', `Invalid webapp URL for ${app.name}: ${classified.error}`);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'error', message: `Rejected invalid webapp URL for ${app.name}: ${classified.error}`, data: { appId: app.id, url: app.url } });
        }
        showErrorPage(webview, app, `Invalid URL: ${classified.error}`);
        return;
      }
      webview.src = classified.url;
      return;
    }

    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const sandboxId = webview.dataset.sandboxId;
        // Inject the capability shim into the entry HTML before registering.
        // Use UTF-8-safe base64 so non-ASCII content survives the round-trip.
        const shimmedFiles = Object.assign({}, app.files);
        const rawHtml = decodeBase64Utf8(shimmedFiles[app.entry]);
        shimmedFiles[app.entry] = encodeBase64Utf8(injectCapabilityShim(rawHtml, app));

        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId, files: shimmedFiles }),
        });
        if (!regRes.ok) throw new Error(`File registration failed: ${regRes.status}`);
        const { baseUrl } = await regRes.json();
        webview.src = window.location.origin + baseUrl + '/' + app.entry;
      } catch (error) {
        log('error', `Failed to load app content for ${app.name}:`, error);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Failed to load content for ${app.name}: ${error?.message || error}`, data: { appId: app.id } });
        }
        showErrorPage(webview, app, 'Failed to load app content');
      }
    } else {
      createDefaultAppShell(webview, app, state);
    }
  }

  // Build the default app shell for apps without content. Uses
  // JSON.stringify for the app.id interpolation into the inline script —
  // escapeHtml is wrong for JS string context (it would insert HTML entities
  // literally inside a JS string).
  async function createDefaultAppShell(webview, app, state) {
    const safeAppId = JSON.stringify(app.id || '');
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${RELAXED_CSP_META}
        <title>${escapeHtml(app.name)}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container { text-align: center; max-width: 600px; }
          .app-icon { font-size: 64px; margin-bottom: 20px; }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${escapeHtml(app.icon || '📱')}</div>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description || 'A NovaByte Application')}</p>
          <div class="status">
            <strong>Version:</strong> ${escapeHtml(app.version)}<br>
            <strong>Author:</strong> ${escapeHtml(app.author)}<br>
            <strong>Type:</strong> ${escapeHtml(app.type)}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          // The capability shim (injected into <head> above) fires
          // nova:ready automatically on load. This script just listens
          // for the resulting bridge-ready signal and updates the status
          // indicator — it does NOT fire a second nova:ready (the old
          // version did, which raced the shim's own ready call and
          // produced a duplicate handshake on every launch).
          (function() {
            function markReady(ok) {
              var el = document.getElementById('apiStatus');
              if (el) el.textContent = ok ? 'API Bridge: Connected ✓' : 'API Bridge: Connection failed';
            }
            if (window.nova && window.nova.ipc) {
              // The shim already fired nova:ready; just listen for its
              // resolution via the shared __novaPermResponse surface the
              // shim populates when the ready response arrives.
              var checkReady = function() {
                if (window.__novaPermResponse) {
                  markReady(true);
                } else {
                  setTimeout(checkReady, 100);
                }
              };
              setTimeout(checkReady, 100);
            } else {
              markReady(false);
            }
          })();
        </script>
      </body>
      </html>
    `;

    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'index.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/index.html';
    } catch (error) {
      log('error', `Failed to create default shell for ${app.name}:`, error);
    }
  }

  // Show an error page in the sandbox when app content fails to load.
  async function showErrorPage(webview, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        ${RELAXED_CSP_META}
        <title>Error - ${escapeHtml(app.name)}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${escapeHtml(app.name)}</strong></p>
        <p>${escapeHtml(message)}</p>
        <p><small>App ID: ${escapeHtml(app.id)}</small></p>
      </body>
      </html>
    `;
    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'error.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/error.html';
    } catch (e) {
      log('error', `Could not show error page for ${app.name}:`, e);
    }
  }

  // Sandbox attribute sanitisation

  // Build a safe sandbox attribute string from an app's sandbox config.
  //
  // allow-same-origin is NOT included by default for third-party apps. Including
  // it lets the guest access its own cookies, localStorage, and sessionStorage
  // on the shared origin — increasing the blast radius of any XSS inside the
  // sandbox. The same-document <iframe> sandbox-escape also applies when
  // combined with allow-scripts.
  //
  // In a <webview>, the real isolation boundary is the separate renderer
  // process, so the DOM-level escape risk is lower than for a same-document
  // iframe. However, the IPC bridge depends on `window.location.origin` matching
  // between the parent and the webview. Without allow-same-origin the origin
  // becomes opaque and postMessage silently drops.
  //
  // To balance these concerns:
  //   - System apps (in the audited allowlist) receive allow-same-origin for IPC.
  //   - Third-party apps must explicitly opt in via `allowSameOrigin: true` in
  //     their manifest AND hold the `sandbox:same-origin` permission, so the
  //     user has a real opportunity to deny the elevated trust. Previously
  //     the manifest flag alone bypassed the permission system entirely.
  function sanitizeSandboxAttr(sandboxConfig, appId) {
    const isSystemApp = SYSTEM_SANDBOX_APPS.has(appId);
    const isExplicitOptIn = sandboxConfig && typeof sandboxConfig === 'object' && sandboxConfig.allowSameOrigin === true;
    const sameOriginPermitted = isSystemApp
      || (isExplicitOptIn && AppPermissionManager?.isGranted('sandbox:same-origin', appId));

    const tokens = new Set();
    if (sameOriginPermitted) {
      tokens.add('allow-same-origin');
    }

    // Parse the manifest's sandbox config into a token set so we can
    // match exact tokens rather than substring-contains (which would
    // wrongly accept e.g. "allow-scripts-foo" as "allow-scripts").
    const requestedTokens = new Set();
    if (sandboxConfig && typeof sandboxConfig === 'object') {
      if (sandboxConfig.allowScripts === true) requestedTokens.add('allow-scripts');
      if (sandboxConfig.allowForms === true) requestedTokens.add('allow-forms');
      if (sandboxConfig.allowPopups === true) requestedTokens.add('allow-popups');
      if (sandboxConfig.allowPopupsToEscapeSandbox === true) requestedTokens.add('allow-popups-to-escape-sandbox');
      if (sandboxConfig.allowModals === true) requestedTokens.add('allow-modals');
    } else if (typeof sandboxConfig === 'string') {
      for (const tok of sandboxConfig.split(/\s+/)) {
        if (tok) requestedTokens.add(tok);
      }
    }

    // Only forward tokens we explicitly recognize — a manifest that asks
    // for "allow-top-navigation" or other exotic tokens gets them dropped
    // rather than passed through uninspected.
    const KNOWN_TOKENS = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals'];
    for (const tok of KNOWN_TOKENS) {
      if (requestedTokens.has(tok)) tokens.add(tok);
    }

    // allow-downloads: without this token, Chromium silently drops any
    // download triggered inside the webview (blob URL + <a download>,
    // navigation to a Content-Disposition: attachment response, etc).
    // It's a per-click, user-gesture-gated action — the OS-native save
    // dialog is the actual security boundary, not this token — so it's
    // safe to include in the default set alongside the other baseline
    // interaction tokens rather than gating it behind a manifest
    // permission the user has to grant separately.
    if (tokens.size === 0) {
      tokens.add('allow-scripts');
      tokens.add('allow-forms');
      tokens.add('allow-popups');
      tokens.add('allow-modals');
      tokens.add('allow-downloads');
    } else if (!tokens.has('allow-downloads')) {
      tokens.add('allow-downloads');
    }

    const attr = Array.from(tokens).join(' ');
    log('debug', `sandbox attrs for ${appId || 'unknown'}: ${attr}`);
    return attr;
  }

  // Sandbox creation

  // Create a sandboxed webview for app execution. The webview runs in a
  // separate renderer process — true process isolation. It cannot access
  // main page JS, DOM, or memory regardless of app content.
  function createSandbox(app, container, state) {
    const webview = document.createElement('webview');

    // nodeintegration=false means the app cannot require() Node.js modules
    // even if the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Sandbox tracking id — unique per launch, used only to key
    // activeSandboxes/eventSubscriptions/etc. so concurrent or repeated
    // launches of the same app don't collide with each other. Uses
    // crypto.randomUUID for collision resistance — Date.now() alone can
    // collide if two sandboxes are created in the same millisecond.
    const sandboxId = generateSandboxId(app.id);

    // Isolated storage partition, keyed by app.id ONLY (not sandboxId).
    // The 'persist:' prefix makes a given partition NAME durable across
    // that partition's own lifetime — it does nothing to unify two
    // different partition names. Keying by app.id alone means every
    // launch of the same app resolves to the same on-disk partition.
    const partitionId = `app_${app.id}`;
    webview.setAttribute('partition', `persist:${partitionId}`);

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    }

    // Register the isolated-world IPC transport before any navigation
    // happens on this webview (loadAppContent, called below, is what
    // first sets webview.src). addContentScripts + run_at: 'document_start'
    // guarantees this runs before the guest's own <head> content —
    // including the main-world capability shim prepended into the app's
    // HTML — ever gets a chance to execute, and it runs in a separate JS
    // realm the guest's own scripts cannot reach (see
    // buildIsolatedTransportScript for why that matters).
    //
    // Scoped to this host's own origin — every app's served files live
    // under window.location.origin + a per-sandbox baseUrl path (see
    // loadAppContent), so this never needs to match external content.
    // webapp-type apps (external URLs) don't get this at all: they
    // navigate to classified.url directly and were never given
    // window.nova capabilities in the first place.
    if (typeof webview.addContentScripts === 'function') {
      try {
        webview.addContentScripts([{
          name: `nova-ipc-transport-${sandboxId}`,
          matches: [`${window.location.origin}/*`],
          js: { code: buildIsolatedTransportScript() },
          run_at: 'document_start',
          all_frames: false,
        }]);
      } catch (e) {
        log('warn', `Failed to register isolated IPC transport for ${app?.id || 'unknown app'}:`, e);
      }
    } else {
      log('warn', `webview.addContentScripts unavailable — IPC transport will not be isolated for ${app?.id || 'unknown app'}`);
    }

    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    // Collect per-sandbox teardown functions. Each setup function returns
    // a cleanup function; createSandbox stitches them into a single
    // sandbox.cleanup that destroy() runs. This replaces the previous
    // pattern where setupAPIBridge wrote sandbox.cleanup directly (so
    // error-handling and permission-gate listeners were never removed —
    // a real leak for backgrounded sandboxes whose webview element
    // survives in #background-app-host).
    const teardownFns = [];

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map(),
      cleanup: null, // populated below after all setup runs
    });

    // Fullscreen support — toggle window maximise when the webview enters or
    // exits fullscreen so the app fills the screen.
    if (state && state.element) {
      // Capture the maximized state at the time of fullscreen entry,
      // not at sandbox creation — the previous version captured it once
      // at creation and then compared against the current state on exit,
      // so if the user manually maximized before entering fullscreen we
      // would wrongly unmaximize on exit.
      let maximizedForFullscreen = false;
      const fullscreenHandler = () => {
        if (document.fullscreenElement === webview) {
          maximizedForFullscreen = !!state.maximized;
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !maximizedForFullscreen && state.maximized) {
            WM.toggleMaximize(state.id);
          }
          maximizedForFullscreen = false;
        }
      };
      webview.addEventListener('fullscreenchange', fullscreenHandler, false);
      teardownFns.push(() => webview.removeEventListener('fullscreenchange', fullscreenHandler));
    }

    eventSubscriptions.set(sandboxId, new Map());

    teardownFns.push(setupAPIBridge(webview, app, sandboxId));
    teardownFns.push(setupErrorHandling(webview, app));
    teardownFns.push(setupPermissionRequestGate(webview, app));

    // Compose all teardowns into the sandbox's cleanup function.
    activeSandboxes.get(sandboxId).cleanup = () => {
      for (const fn of teardownFns) {
        try { fn(); } catch (e) { log('debug', 'sandbox cleanup step threw', e); }
      }
    };

    log('debug', `Created webview sandbox for ${app.name} (${sandboxId})`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Created sandbox for ${app.name}`, data: { appId: app.id, sandboxId } });
    }

    return webview;
  }

  // Public lifecycle

  // Launch an app in a sandboxed environment.
  function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    // Clear container — any previous webview (and its listeners) goes away.
    container.innerHTML = '';

    const webview = createSandbox(app, container, state);
    container.appendChild(webview);

    // loadAppContent is async (registers files with the server) — fire and
    // let errors surface in the webview via showErrorPage.
    loadAppContent(webview, app, state);

    log('debug', `Launched ${app.name} in sandbox`);

    const sandboxId = webview.dataset.sandboxId;
    return {
      success: true,
      sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: webview, // backward-compat alias
      webview: webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  // Destroy a sandbox by ID. Tears down listeners, WebSockets, event
  // subscriptions, open dialogs, and unregisters app files from the serve
  // route. Safe to call multiple times — second call is a no-op.
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    // sandbox.cleanup (set up in createSandbox) does the actual teardown:
    // aborts the message listener, detaches OS event subs, closes WebSockets,
    // removes any open file dialog overlay, and detaches the error-handling
    // / permission-gate / fullscreen listeners.
    if (typeof sandbox.cleanup === 'function') {
      sandbox.cleanup();
    }

    // Remove the webview element from the DOM. Without this, a backgrounded
    // sandbox (whose webview lives in #background-app-host) would leak the
    // element and its renderer process forever, even after destroy().
    const webview = sandbox.webview;
    if (webview && webview.parentNode) {
      webview.parentNode.removeChild(webview);
    }

    // Unregister app files from the Express serve route. Best-effort —
    // failures here don't affect the sandbox teardown.
    fetch(`/api/apps/serve/unregister/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' })
      .catch(() => {});

    // Same-origin gating (sanitizeSandboxAttr, above) only controls whether
    // the guest's raw cookies/localStorage/sessionStorage land on a real,
    // stable origin vs an opaque one — it does NOT stop those DOM storage
    // APIs from writing to disk. The persist:app_<appId> partition is a
    // separate Chromium mechanism, set unconditionally in createSandbox(),
    // so an opaque-origin (unpermissioned) app's raw storage writes still
    // survive relaunch under that same reused partition. That's the actual
    // gap sandbox:same-origin's wording ("cookies/localStorage/sessionStorage
    // on the shared origin") implies should NOT persist for these apps.
    //
    // nova:storage:* is unaffected by this — it's a completely separate,
    // host-shell-side IndexedDB, isolated by [appId, key], not by this
    // partition. Wiping the partition here never touches it.
    //
    // Only wipe for apps that weren't granted allow-same-origin at
    // creation. Best-effort: a failure here shouldn't block teardown.
    const appId = sandbox.appId;
    const isSystemApp = SYSTEM_SANDBOX_APPS.has(appId);
    // sanitizeSandboxAttr() only adds 'allow-same-origin' when isSystemApp
    // OR (manifest allowSameOrigin===true AND the permission is granted) —
    // so the token's presence on the actual webview is a direct readout of
    // that combined decision. Reading it back here (rather than
    // re-deriving the rule with a second isGranted() check, which is what
    // caused the original bug: it dropped the manifest-opt-in half, so an
    // app with a stale/leftover grant but no opt-in — which never got the
    // token at creation and is genuinely opaque-origin — was wrongly
    // treated as exempt and skipped the wipe below) means the two checks
    // can't drift apart again, since this one isn't a second copy of the
    // logic at all.
    const webviewHasSameOrigin = !!sandbox.webview
      && typeof sandbox.webview.getAttribute === 'function'
      && (sandbox.webview.getAttribute('sandbox') || '').split(/\s+/).includes('allow-same-origin');
    const sameOriginPermitted = isSystemApp || webviewHasSameOrigin;
    if (appId && !sameOriginPermitted) {
      clearAppPartition(appId).catch(e => {
        log('warn', 'destroy() — failed to clear storage partition for', appId, e);
      });
    }

    activeSandboxes.delete(sandboxId);
    log('debug', `Destroyed sandbox: ${sandboxId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Destroyed sandbox ${sandboxId}`, data: { appId: sandbox.appId, sandboxId } });
    }

    return true;
  }

  // Push a background-wake event into a specific sandbox's guest page.
  // Narrow, purpose-built wrapper around the internal respond() push
  // mechanism — not a general "send anything into any sandbox" API, since
  // that would let a caller forge arbitrary IPC responses. This only ever
  // sends the one wake payload shape AppScheduler produces, to a sandbox
  // that scheduler itself just created or already knows about.
  function dispatchBackgroundWake(sandboxId, payload) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    respond(sandbox.webview, 'nova:background:wake', generateRequestId(), payload || {});
    return true;
  }

  // Get active sandbox info by ID.
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  // Keep a sandbox's webview (and the process behind it) alive after its
  // window has been closed, for apps holding system:background:live.
  //
  // This does NOT touch activeSandboxes, the API bridge, or any of the
  // sandbox's live state (WebSocket connections, event subscriptions,
  // etc.) — none of that is torn down, unlike a real destroy(). All this
  // does is reparent the webview element out of the closing window's DOM
  // subtree (which is about to be removed) into the hidden
  // #background-app-host, so the element survives `state.element.remove()`
  // and keeps running invisibly.
  function detachToBackground(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    const host = document.getElementById('background-app-host');
    if (!host) {
      log('warn', `detachToBackground: #background-app-host not found, cannot keep ${sandboxId} alive`);
      return false;
    }

    const webview = sandbox.webview;
    if (webview && webview.parentNode !== host) {
      host.appendChild(webview);
    }

    sandbox.backgrounded = true;
    sandbox.backgroundedAt = new Date().toISOString();
    // Distinct from backgrounded/backgroundedAt: this never gets cleared
    // by reattachFromBackground(), so wm.js can tell "first time going to
    // background" (show the 'started running' toast) apart from "resuming
    // background mode after a reattach-then-close cycle" (skip the toast —
    // it never actually stopped).
    sandbox.everBackgrounded = true;
    // windowId no longer refers to a live window once the window is gone —
    // keep the old value around under a different key for diagnostics
    // (Inspector, EventLog) rather than silently dropping it.
    sandbox.lastWindowId = sandbox.windowId;
    sandbox.windowId = null;

    log('debug', `Detached sandbox ${sandboxId} to background host`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} kept alive in background`, data: { appId: sandbox.appId, sandboxId } });
    }
    return true;
  }

  // Fully stop a backgrounded sandbox — the Terminate action's actual
  // effect. This is just destroy(): once a sandbox is in the background
  // host rather than a window, ending it is identical to a normal
  // teardown, since there's no window to also close.
  function terminateBackground(sandboxId) {
    return destroy(sandboxId);
  }

  // Move a backgrounded sandbox's webview back into a freshly-created
  // window's content area, and clear its backgrounded state. This is the
  // counterpart to detachToBackground() — without it, reopening an app
  // that's currently alive in the background just launches a second,
  // independent sandbox via the normal launch() path, leaving the
  // original running invisibly with two instances of the same app now
  // open (one live in #background-app-host, one in the new window).
  //
  // The webview element itself, its IPC bridge (setupAPIBridge is keyed
  // to the webview/sandboxId, not to any particular window state), and
  // its in-page JS state all survive the move untouched — only the DOM
  // parent changes. What we do need to refresh is sandbox.state and
  // sandbox.windowId, since detachToBackground() nulled/staled those when
  // the original window closed, and closeWindow() (if this window closes
  // again later) reads the window's own state.appId, not the sandbox's,
  // so this mainly keeps AppSandbox's own bookkeeping (Inspector,
  // getAllSandboxes()) accurate rather than gating any security check.
  function reattachFromBackground(sandboxId, container, state) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    if (!container) return false;

    container.innerHTML = '';
    container.appendChild(sandbox.webview);

    sandbox.backgrounded = false;
    sandbox.backgroundedAt = null;
    sandbox.state = state;
    sandbox.windowId = state?.id;
    // Deliberately NOT resetting wantsBackgroundLive here. The process
    // never stopped and its intent to stay alive was already established
    // this continuous session (via nova.stayAliveInBackground()) — that
    // doesn't need to be re-asked just because the user glanced at the
    // window and closed it again. Resetting it would force every
    // reattach-then-close cycle to silently drop back to foreground-only,
    // which is a worse failure mode than the one this whole feature
    // exists to prevent: an app the user believes is still running
    // quietly stops being kept alive with no signal that anything
    // changed. If an app wants OUT of background mode, it calls
    // nova.stayAliveInBackground(false) itself.

    log('debug', `Reattached sandbox ${sandboxId} from background host to window ${state?.id}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} reattached from background`, data: { appId: sandbox.appId, sandboxId, windowId: state?.id } });
    }
    return true;
  }

  // Get all active sandboxes as an array.
  function getAllSandboxes() {
    // Spread the map key in as `sandboxId` on each entry — callers like
    // WM.closeWindow() need to look up a sandbox by windowId/appId and then
    // act on that specific instance (detachToBackground/terminateBackground),
    // and both of those take a sandboxId string, not the object itself.
    return Array.from(activeSandboxes.entries()).map(([sandboxId, sandbox]) => ({ sandboxId, ...sandbox }));
  }

  // Clear the on-disk storage partition for a given app id
  // (persist:app_<appId> — see createSandbox() above). This is a
  // separate Chromium storage partition from the host window's
  // localStorage/IndexedDB/OPFS, and from the app's FS/OPFS data
  // folder cleaned up elsewhere — none of those touch this partition.
  //
  // Callers that fully remove an app's data (uninstall, "wipe all
  // data", factory reset) must call this too, or the app's cookies,
  // IndexedDB, cache, etc. from its own webview silently survive on
  // disk under a partition nothing else references anymore.
  //
  // Safe to call even if the app was never launched (partition simply
  // doesn't exist yet, and gets created+immediately-cleared, which is
  // harmless).
  async function clearAppPartition(appId) {
    if (!appId) return;

    // clearData() only actually reaches a partition's real storage once a
    // webview on that partition has completed a genuine same-origin
    // navigation — about:blank never establishes a session against this
    // partition, so clearData silently no-ops against it. So we register
    // a minimal blank page through the same /api/apps/serve/register
    // mechanism real app launches use (see loadAppContent above), giving
    // the webview a real same-origin page inside the correct partition
    // before calling clearData.
    let baseUrl;
    try {
      const sandboxId = `sandbox_clr_${appId.replace(/[^\w.-]/g, '_')}_${Date.now()}`;
      const files = { 'index.html': btoa('<!doctype html><html><body></body></html>') };
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files }),
      });
      if (!regRes.ok) throw new Error(`register failed: ${regRes.status}`);
      ({ baseUrl } = await regRes.json());
    } catch {
      // Registration failed — fall back to about:blank rather than
      // hard-failing; clearData will likely no-op, but this keeps the
      // caller's Promise resolving instead of hanging or throwing.
      baseUrl = null;
    }

    return new Promise(resolve => {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', `persist:app_${appId}`);
      wv.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      // Correct key set for this NW.js build's <webview> clearData(), confirmed
      // by testing against real data: 'filesystem' must be 'fileSystems'
      // (capitalized S), and 'serviceWorkers'/'cacheStorage' are rejected
      // outright on this build ("Unexpected property") — the webview tag's
      // ClearDataTypeSet here is a narrower, older subset than the full
      // chrome.browsingData schema.
      const clearTypes = { appcache: true, cache: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, webSQL: true };
      // settled flag guards against the loadstop clearData callback and
      // the safety timeout both firing — the second call would otherwise
      // try to wv.remove() an already-removed element (caught by the
      // try/catch, but noisy in logs and conceptually wrong).
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { wv.remove(); } catch { /* already removed */ }
        resolve();
      };
      wv.addEventListener('loadstop', () => {
        try { wv.clearData({}, clearTypes, finish); } catch { finish(); }
      });
      wv.addEventListener('loadabort', finish);
      document.body.appendChild(wv);
      wv.src = baseUrl ? (window.location.origin + baseUrl + '/index.html') : 'about:blank';
      setTimeout(finish, CLEAR_PARTITION_TIMEOUT_MS);
    });
  }

  // Clear storage partitions for multiple apps in parallel. Used by
  // bulk operations (wipe all data, factory reset).
  function clearAppPartitions(appIds) {
    return Promise.all((appIds || []).map(clearAppPartition)).then(() => {});
  }

  // Public API

  return {
    createSandbox,
    launch,
    destroy,
    getSandbox,
    getAllSandboxes,
    clearAppPartition,
    clearAppPartitions,
    // storageClear/clearAllStorage clear nova:storage (a separate,
    // host-shell-side IndexedDB keyed by [appId, key] — see storageClear
    // above) which clearAppPartition(s) never touches, since that only
    // wipes the webview's own persist:app_<appId> partition. Uninstall
    // and factory-reset callers need both: clearAppPartition(appId) for
    // the webview partition, storageClear(appId) or clearAllStorage()
    // for this store.
    storageClear,
    clearAllStorage,
    detachToBackground,
    terminateBackground,
    dispatchBackgroundWake,
    reattachFromBackground,

    // Internal exports for testing and advanced consumers. Not covered by
    // stability guarantees — do not depend on these in production code.
    _internal: {
      escapeHtml,
      sanitizeSandboxAttr,
      injectCapabilityShim,
      encodeBase64Utf8,
      decodeBase64Utf8,
      generateRequestId,
      resolveAndClassifyUrl,
      isInternalHost,
      parsePositiveInt,
      validateStorageKey,
      handleAPICall,
      API_HANDLERS,
      buildCapabilityShim,
      buildIsolatedTransportScript,
      isNestedWebviewPermitted,
      RELAXED_CSP_META,
      // Test-only helpers for resetting module state between tests.
      _resetState() {
        activeSandboxes.clear();
        eventSubscriptions.clear();
        openDialogs.clear();
        notifRateLimitLog.clear();
        storageDbPromise = null;
      },
      _activeSandboxes: activeSandboxes,
      _eventSubscriptions: eventSubscriptions,
      _openDialogs: openDialogs,
    },
  };
})();

// CommonJS export for Node.js test runners and bundlers that expect it.
// In the browser, the module attaches as a global `AppSandbox`.
if (typeof window !== 'undefined') {
  window.AppSandbox = AppSandbox;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}