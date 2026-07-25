/**
 * NovaByte — App Permission Manager
 *
 * Android-style permission system with sequential prompt queue,
 * persistent grants, and automatic 30-day unused-app expiry.
 *
 * @module js/platform/security/app-permission-manager
 */

const AppPermissionManager = (() => {
  'use strict';

  // Permission catalogue

  const PERMISSION_TYPES = Object.freeze({
    FS_READ           : 'vfs:read',       FS_WRITE          : 'vfs:write',
    FS_DELETE         : 'vfs:delete',     FS_METADATA       : 'vfs:metadata',
    NET_INTERNAL      : 'net:internal',   NET_EXTERNAL      : 'net:external',
    NET_WEBSOCKET     : 'net:websocket',
    MAIL_READ         : 'mail:read',      MAIL_WRITE        : 'mail:write',
    MAIL_SEND         : 'mail:send',      MAIL_DELETE       : 'mail:delete',
    CALENDAR_READ     : 'calendar:read',  CALENDAR_WRITE    : 'calendar:write',
    CALENDAR_DELETE   : 'calendar:delete',
    CONTACTS_READ     : 'contacts:read',  CONTACTS_WRITE    : 'contacts:write',
    CONTACTS_DELETE   : 'contacts:delete',
    DEVICE_NOTIFICATIONS: 'device:notifications',
    DEVICE_GEOLOCATION: 'device:geolocation',
    DEVICE_CAMERA     : 'device:camera',
    DEVICE_MICROPHONE : 'device:microphone',
    // Split from FS_READ (vfs:read) — clipboard is a shared, ambient,
    // cross-app channel, not a file. See handleClipboardRead/Write in
    // app-sandbox.js for the full rationale. vfs:read is kept as a fallback
    // there for apps already granted it before this split, so an app can
    // still function on either grant during the transition; new/re-consented
    // apps should be prompted for these instead.
    CLIPBOARD_READ    : 'clipboard:read',  CLIPBOARD_WRITE   : 'clipboard:write',
    SYSTEM_INFO       : 'system:info',    SYSTEM_SETTINGS   : 'system:settings',
    SYSTEM_APPS       : 'system:apps',    SYSTEM_EVENTS     : 'system:events',
    // Background execution is split into two independent grants on purpose:
    // SYSTEM_BACKGROUND covers scheduled wake-ups (the app doesn't need to be
    // open at all for the host to run it briefly), while
    // SYSTEM_BACKGROUND_LIVE covers staying alive as a running process after
    // the user closes its window — a strictly bigger ask, since the process
    // keeps consuming resources indefinitely rather than waking briefly.
    // Neither implies device:notifications — an app with either background
    // grant still can't call nova:notifications:show without that grant too.
    // SYSTEM_AUTOSTART is a third, separate thing again: launching the app
    // at OS boot/login with no user action at all in that session, which is
    // a bigger trust ask than either background tier and must be granted
    // explicitly rather than folded into SYSTEM_BACKGROUND.
    SYSTEM_BACKGROUND      : 'system:background',
    SYSTEM_BACKGROUND_LIVE : 'system:background:live',
    SYSTEM_AUTOSTART       : 'system:autostart',
    ADMIN_APPS        : 'admin:apps',     ADMIN_USERS       : 'admin:users',
    ADMIN_SYSTEM      : 'admin:system',   ADMIN_AUDIT       : 'admin:audit',
    // Lets a .novaapp's own guest content instantiate a nested <webview>
    // tag (a second, separate renderer process the app controls directly —
    // e.g. an in-app browser feature). This is NOT about the outer sandbox
    // webview app-sandbox.js already creates for every app (that one isn't
    // gated by permission at all, it's how apps run). This is specifically
    // for third-party app HTML that wants to create its OWN <webview>
    // inside that sandbox. Deliberately excluded from SYSTEM_SANDBOX_APPS'
    // same-origin exemption pattern: system apps are skipped entirely by
    // appId allowlist in app-sandbox.js (see SYSTEM_SANDBOX_APPS), not by
    // holding this permission, so this entry only ever applies to
    // .novaapp third-party packages.
    SANDBOX_NESTED_WEBVIEW : 'sandbox:nested-webview',
    // Lets a third-party .novaapp's outer sandbox webview receive
    // allow-same-origin, giving the guest access to its own cookies,
    // localStorage, and sessionStorage on the shared origin. System apps
    // never need this entry — they're exempted by appId via
    // SYSTEM_SANDBOX_APPS in app-sandbox.js, not by holding this
    // permission. For everyone else, sanitizeSandboxAttr() requires BOTH
    // `allowSameOrigin: true` in the manifest AND this grant before adding
    // allow-same-origin to the sandbox attribute — see app-sandbox.js.
    SANDBOX_SAME_ORIGIN : 'sandbox:same-origin',
    // Same double-gate pattern as SANDBOX_SAME_ORIGIN just above: system
    // apps are exempted by appId (SYSTEM_SANDBOX_APPS), everyone else needs
    // BOTH `allowPopupsToEscapeSandbox: true` in the manifest AND this grant
    // before sanitizeSandboxAttr() adds allow-popups-to-escape-sandbox to
    // the sandbox attribute. Previously the manifest flag alone was enough —
    // a popup that escapes the sandbox is a fully unrestricted browsing
    // context, comparable risk to allow-same-origin, with none of the same
    // gating. See app-sandbox.js.
    SANDBOX_ESCAPE_POPUPS : 'sandbox:escape-popups',
  });

  const PERMISSION_CATEGORIES = Object.freeze({
    // Renamed from fs:* — this is NovaByte's own OS-managed virtual
    // filesystem (the Files app / vault, worker+IndexedDB-backed), never
    // real Node fs/real host disk. "fs:*" read as raw Node fs access to
    // anyone coming in fresh, which it never was; "vfs:*" says what it
    // actually is. Real host-disk access, if built, is reserved for a
    // future picker-mediated fs:* (single user-chosen file via native
    // dialog, not free-roam path access) — a categorically different,
    // much higher-risk capability that deliberately isn't this.
    'vfs:read'          : { category: 'filesystem', risk: 'medium',   label: 'Read files' },
    'vfs:write'         : { category: 'filesystem', risk: 'high',     label: 'Write files' },
    'vfs:delete'        : { category: 'filesystem', risk: 'critical', label: 'Delete files' },
    'vfs:metadata'      : { category: 'filesystem', risk: 'low',      label: 'File metadata' },
    'net:internal'      : { category: 'network',    risk: 'high',     label: 'Internal network' },
    'net:external'      : { category: 'network',    risk: 'medium',   label: 'External network' },
    'net:websocket'     : { category: 'network',    risk: 'medium',   label: 'WebSocket connections' },
    'mail:read'         : { category: 'email',      risk: 'high',     label: 'Read emails' },
    'mail:write'        : { category: 'email',      risk: 'critical', label: 'Compose emails' },
    'mail:send'         : { category: 'email',      risk: 'critical', label: 'Send emails' },
    'mail:delete'       : { category: 'email',      risk: 'critical', label: 'Delete emails' },
    'calendar:read'     : { category: 'calendar',   risk: 'medium',   label: 'Read calendar' },
    'calendar:write'    : { category: 'calendar',   risk: 'high',     label: 'Edit calendar' },
    'calendar:delete'   : { category: 'calendar',   risk: 'high',     label: 'Delete calendar events' },
    'contacts:read'     : { category: 'contacts',   risk: 'medium',   label: 'Read contacts' },
    'contacts:write'    : { category: 'contacts',   risk: 'high',     label: 'Edit contacts' },
    'contacts:delete'   : { category: 'contacts',   risk: 'high',     label: 'Delete contacts' },
    'device:notifications': { category: 'device',   risk: 'low',      label: 'Send notifications' },
    'device:geolocation': { category: 'device',     risk: 'high',     label: 'Access location' },
    'device:camera'     : { category: 'device',     risk: 'critical', label: 'Access camera' },
    'device:microphone' : { category: 'device',     risk: 'critical', label: 'Access microphone' },
    // 'high', matching mail:read/device:geolocation rather than vfs:read's
    // 'medium' — the clipboard is a shared, ambient, cross-app channel that
    // can contain whatever any other app (or the user) copied moments ago,
    // not scoped to this app's own data the way most 'medium' grants are.
    // Split out from vfs:read; see handleClipboardRead/Write in
    // app-sandbox.js for the full rationale.
    'clipboard:read'    : { category: 'device',     risk: 'high',     label: 'Read clipboard' },
    'clipboard:write'   : { category: 'device',     risk: 'medium',   label: 'Write clipboard' },
    // 'medium', not 'low' — this gates both nova:system:info (OS version,
    // security patch level, username, uptime) and handleSettingsGet's
    // SETTINGS_READABLE_KEYS allowlist (username, region, timezone,
    // devMode, browserPartitionId, and 24 other real settings values — see
    // app-sandbox.js). That's substantive personal/system data, not just
    // inert metadata; closer in shape to vfs:read or calendar:read (both
    // 'medium') than to vfs:metadata or device:notifications (both 'low',
    // and genuinely lower-stakes: filenames only, or send-only with no
    // data exposure).
    'system:info'       : { category: 'system',     risk: 'medium',   label: 'System information' },
    'system:settings'   : { category: 'system',     risk: 'medium',   label: 'System settings' },
    'system:apps'       : { category: 'system',     risk: 'medium',   label: 'Manage apps' },
    'system:events'     : { category: 'system',     risk: 'medium',   label: 'System events' },
    'system:background' : { category: 'system',     risk: 'medium',   label: 'Run scheduled background tasks' },
    'system:background:live': { category: 'system', risk: 'high',     label: 'Keep running after you close it' },
    'system:autostart'  : { category: 'system',     risk: 'high',     label: 'Start automatically when NovaByte starts' },
    'admin:apps'        : { category: 'admin',      risk: 'high',     label: 'Manage apps (admin)' },
    'admin:users'       : { category: 'admin',      risk: 'critical', label: 'Manage users' },
    'admin:system'      : { category: 'admin',      risk: 'critical', label: 'System administration' },
    'admin:audit'       : { category: 'admin',      risk: 'high',     label: 'Audit logs' },
    // 'critical' because a nested <webview> is a second, independent
    // renderer process the app's own guest code controls directly — it can
    // navigate anywhere, load arbitrary remote content, and (depending on
    // whatever attributes the app sets on ITS webview) potentially run with
    // its own node integration / partition, none of which the outer
    // sandbox's own webview attrs constrain. Never auto-granted, never
    // implied by any other permission.
    'sandbox:nested-webview': { category: 'sandbox', risk: 'critical', label: 'Embed live web content (nested browser view)' },
    // 'high', not 'critical': unlike nested-webview (a whole second
    // uncontained renderer), this only widens what an existing XSS inside
    // the guest can reach — shared cookies/localStorage/sessionStorage on
    // the origin — rather than handing the guest a fresh escape surface.
    // Still a real privilege step up from the sandboxed default, so it's
    // not 'medium' either. See sanitizeSandboxAttr() in app-sandbox.js for
    // the actual gate this backs.
    'sandbox:same-origin': { category: 'sandbox', risk: 'high', label: 'Access shared cookies & storage' },
    // 'high', same as sandbox:same-origin just above — a popup that escapes
    // the sandbox is a fully unrestricted browsing context, which the
    // comment on SANDBOX_ESCAPE_POPUPS above already calls "comparable risk
    // to allow-same-origin." See sanitizeSandboxAttr() in app-sandbox.js for
    // the actual gate this backs.
    'sandbox:escape-popups': { category: 'sandbox', risk: 'high', label: 'Open unrestricted popup windows' },
  });

  const STORAGE_KEY = 'nova_app_permissions';
  const SWEEP_KEY   = 'nova_perm_last_sweep';
  const UNUSED_DAYS = 30;
  const MS_PER_DAY  = 86_400_000;

  // Rate limiting for requestPermission(). Denied grants no longer
  // short-circuit the dialog (see requestPermission()), so an app could
  // otherwise call requestPermission() in a tight loop and re-show the live
  // dialog every time — a prompt-bombing DoS that also pressures the user
  // into eventually clicking Allow just to make it stop. This tracks, per
  // `${appId}:${permission}`, recent request timestamps and the current
  // cooldown, which backs off further on each consecutive denial. Once an
  // app hits the burst cap within the window, further requests are
  // auto-denied with no dialog shown until the cooldown clears.
  const RATE_WINDOW_MS       = 60_000;
  const RATE_MAX_BURST       = 3;
  const RATE_BASE_COOLDOWN_MS = 5_000;
  const RATE_MAX_COOLDOWN_MS  = 15 * 60_000;
  const RATE_MAX_DENIAL_STREAK = 20; // caps the exponent so backoff math never runs away

  let permissionGrants = new Map(); // key: `${appId}:${permission}`
  const consentLog      = [];
  const rateLimitState  = new Map(); // key: `${appId}:${permission}` -> { attempts, cooldownUntil, denialStreak }

  // Tracks every open dialog's teardown function so a caller (or a future
  // "close all dialogs" action) can force-resolve them instead of leaving
  // requestPermission() awaiting forever if the dialog is torn down some
  // other way (e.g. the host shell clears document.body during a route
  // change while a prompt is still up).
  const openDialogs = new Set();

  function makeAppScopedKey(appId, permission) {
    return `${appId}:${permission}`;
  }

  // Building keys as `${appId}:${permission}` only stays collision-free if
  // appId itself never contains a colon — otherwise app "a" and app "a:b"
  // could shadow each other's keys. Guard here so a malformed appId fails
  // loudly instead of silently corrupting someone else's grants.
  function assertValidAppId(appId) {
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new TypeError(`Invalid appId: expected non-empty string, got ${typeof appId}`);
    }
    if (appId.includes(':')) {
      throw new TypeError(`Invalid appId "${appId}": appId must not contain ":"`);
    }
  }

  // Integrity check
  //
  // Simple structural validation — no HMAC, no cross-session key dependency.
  // The user owns this machine; HMAC against localStorage tampering is
  // security theatre here and was silently nuking all grants on every
  // restart because the renderer partition wiped localStorage (and with it
  // the key). This only guards against corrupted/malformed data crashing
  // later code, not against a hostile local user.

  function isValidGrant(grant) {
    if (!grant || typeof grant !== 'object') return false;
    if (typeof grant.appId !== 'string' || grant.appId.length === 0) return false;
    if (typeof grant.permission !== 'string' || grant.permission.length === 0) return false;
    if (typeof grant.granted !== 'boolean') return false;
    if (typeof grant.grantedAt !== 'string' || Number.isNaN(Date.parse(grant.grantedAt))) return false;
    if (grant.lastUsed != null && (typeof grant.lastUsed !== 'string' || Number.isNaN(Date.parse(grant.lastUsed)))) return false;
    if (grant.expiresAt != null && (typeof grant.expiresAt !== 'string' || Number.isNaN(Date.parse(grant.expiresAt)))) return false;
    return true;
  }

  // Storage

  function getLocalStorage() {
    try {
      // Accessing localStorage itself can throw (Safari private mode,
      // sandboxed iframes without allow-same-origin, some Cross-Origin
      // policies), not just reading/writing from it.
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  async function saveToStorage() {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      const grants = [...permissionGrants.values()];
      storage.setItem(STORAGE_KEY, JSON.stringify(grants));
    } catch (e) {
      if (e.name === 'SecurityError') return;
      if (e.name === 'QuotaExceededError') {
        console.error('[AppPermissionManager] save failed: localStorage quota exceeded');
        return;
      }
      console.error('[AppPermissionManager] save failed:', e);
    }
  }

  // 30-day unused-app expiry sweep

  async function sweepExpiredGrants() {
    const now       = Date.now();
    const threshold = now - UNUSED_DAYS * MS_PER_DAY;

    // Group by appId so we notify once per app, not once per permission.
    const expiredApps = new Map(); // appId -> [permission, ...]

    for (const [key, grant] of permissionGrants) {
      // Never sweep denial records — they must persist to avoid re-prompting.
      if (grant.granted === false) continue;
      const lastUse = Date.parse(grant.lastUsed ?? grant.grantedAt);
      if (Number.isNaN(lastUse) || lastUse < threshold) {
        permissionGrants.delete(key);
        const list = expiredApps.get(grant.appId) ?? [];
        list.push(grant.permission);
        expiredApps.set(grant.appId, list);
      }
    }

    if (expiredApps.size === 0) return;

    await saveToStorage();

    if (typeof Notify !== 'undefined') {
      for (const [appId, perms] of expiredApps) {
        const appName = typeof AppRegistry !== 'undefined'
          ? (AppRegistry.getApp(appId)?.name ?? appId)
          : appId;
        Notify.show({
          title  : 'Permissions removed',
          body   : `${appName} hasn't been used in ${UNUSED_DAYS} days. ${perms.length} permission${perms.length > 1 ? 's' : ''} removed to protect your privacy.`,
          type   : 'info',
          appName: 'Privacy',
          icon   : 'shield',
        });
      }
    }

    console.log(`[AppPermissionManager] Swept ${expiredApps.size} unused app(s)`);
  }

  // Run the sweep at most once per day, deferred so it doesn't block init.
  function scheduleSweep() {
    const storage = getLocalStorage();
    if (!storage) return;
    const last = Number.parseInt(storage.getItem(SWEEP_KEY) ?? '0', 10);
    if (!Number.isNaN(last) && Date.now() - last < MS_PER_DAY) return;
    storage.setItem(SWEEP_KEY, String(Date.now()));
    setTimeout(() => {
      sweepExpiredGrants().catch(e => console.error('[AppPermissionManager] sweep failed:', e));
    }, 5000);
  }

  // Initialization

  function initialize() {
    const storage = getLocalStorage();
    if (!storage) {
      console.warn('[AppPermissionManager] localStorage unavailable — in-memory only');
      return;
    }

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const grants = Array.isArray(parsed) ? parsed : [];
        let rejected = 0;
        for (const grant of grants) {
          if (!isValidGrant(grant)) { rejected++; continue; }
          permissionGrants.set(makeAppScopedKey(grant.appId, grant.permission), grant);
        }
        if (rejected > 0) {
          console.warn(`[AppPermissionManager] Discarded ${rejected} malformed grant(s)`);
        }
      }

      scheduleSweep();
      console.log('[AppPermissionManager] Initialized —', permissionGrants.size, 'grant(s) loaded');
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppPermissionManager] localStorage denied (sandboxed) — in-memory only');
      } else if (e instanceof SyntaxError) {
        console.error('[AppPermissionManager] stored grants corrupted (invalid JSON) — starting fresh:', e);
      } else {
        console.error('[AppPermissionManager] initialize failed:', e);
      }
      permissionGrants = new Map();
    }
  }

  // Record app use (resets the 30-day clock)

  async function recordAppUse(appId) {
    assertValidAppId(appId);
    let dirty = false;
    const nowIso = new Date().toISOString();
    for (const grant of permissionGrants.values()) {
      if (grant.appId === appId) {
        grant.lastUsed = nowIso;
        dirty = true;
      }
    }
    if (dirty) await saveToStorage();
  }

  // Core permission checks

  function isGranted(permission, appId) {
    const grant = permissionGrants.get(makeAppScopedKey(appId, permission));
    if (!grant) return false;
    if (grant.expiresAt && Date.parse(grant.expiresAt) < Date.now()) {
      permissionGrants.delete(makeAppScopedKey(appId, permission));
      // Detached: isGranted() stays synchronous for callers that need it
      // (e.g. render paths checking many permissions in a loop); the write
      // to storage happens in the background and any failure is logged
      // rather than thrown into an unrelated caller's stack.
      saveToStorage().catch(e => console.error('[AppPermissionManager] expiry save failed:', e));
      return false;
    }
    return grant.granted === true;
  }

  function isDenied(permission, appId) {
    const grant = permissionGrants.get(makeAppScopedKey(appId, permission));
    return grant?.granted === false;
  }

  async function resetPermission(permission, appId) {
    permissionGrants.delete(makeAppScopedKey(appId, permission));
    rateLimitState.delete(makeAppScopedKey(appId, permission));
    await saveToStorage();
    console.log(`[AppPermissionManager] Reset ${permission} → ${appId}`);
  }

  // Lets callers (e.g. the Permissions app) check/display cooldown status
  // without triggering a request.
  function isRateLimited(permission, appId) {
    const state = rateLimitState.get(makeAppScopedKey(appId, permission));
    if (!state) return { limited: false };
    const remaining = state.cooldownUntil - Date.now();
    return remaining > 0 ? { limited: true, retryAfterMs: remaining } : { limited: false };
  }

  // Rate-limit gate, called at the top of requestPermission(). Returns
  // { allowed: true } if this call may show a live dialog, or
  // { allowed: false, retryAfterMs } if it must be auto-denied silently
  // because the caller is bursting requests for this key.
  function checkRateLimit(permission, appId) {
    const key   = makeAppScopedKey(appId, permission);
    const now   = Date.now();
    const state = rateLimitState.get(key) ?? { attempts: [], cooldownUntil: 0, denialStreak: 0 };

    if (now < state.cooldownUntil) {
      rateLimitState.set(key, state);
      return { allowed: false, retryAfterMs: state.cooldownUntil - now };
    }

    state.attempts = state.attempts.filter(t => now - t < RATE_WINDOW_MS);
    state.attempts.push(now);

    if (state.attempts.length > RATE_MAX_BURST) {
      // Exponential backoff keyed off consecutive denials, so a
      // persistently pushy app gets throttled harder over time rather than
      // a flat delay. denialStreak is capped before exponentiation so the
      // math can't produce an absurd intermediate value even though
      // RATE_MAX_COOLDOWN_MS would clamp the end result anyway.
      const streak  = Math.min(state.denialStreak, RATE_MAX_DENIAL_STREAK);
      const backoff = Math.min(RATE_BASE_COOLDOWN_MS * 2 ** streak, RATE_MAX_COOLDOWN_MS);
      state.cooldownUntil = now + backoff;
      state.attempts = [];
      rateLimitState.set(key, state);
      return { allowed: false, retryAfterMs: backoff };
    }

    rateLimitState.set(key, state);
    return { allowed: true };
  }

  function recordRateLimitOutcome(permission, appId, granted) {
    const key   = makeAppScopedKey(appId, permission);
    const state = rateLimitState.get(key) ?? { attempts: [], cooldownUntil: 0, denialStreak: 0 };
    state.denialStreak = granted ? 0 : state.denialStreak + 1;
    rateLimitState.set(key, state);
  }

  // Single permission request

  async function requestPermission(permission, appId, options = {}) {
    assertValidAppId(appId);
    if (isGranted(permission, appId)) return true;

    // Previously denied grants no longer short-circuit here — every call
    // to requestPermission() shows the live dialog again, so the user gets
    // a fresh real-time choice each time an app asks. The persisted denial
    // record from persistDenial() is only used by isDenied() for callers
    // that want to check status without prompting.
    //
    // That re-prompt-every-time behavior is exactly what makes
    // prompt-bombing possible, so it's gated by the rate limiter above:
    // bursts beyond RATE_MAX_BURST within RATE_WINDOW_MS get auto-denied
    // (no dialog shown at all) with exponential backoff on repeat offenders.
    const gate = checkRateLimit(permission, appId);
    if (!gate.allowed) {
      console.warn(`[AppPermissionManager] Rate-limited ${permission} → ${appId} (retry in ${Math.ceil(gate.retryAfterMs / 1000)}s)`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'Permissions', category: 'permissions', severity: 'warn',
          message: `Rate-limited permission request ${permission} → ${appId}`,
          data: { appId, permission, action: 'rate-limited', retryAfterMs: gate.retryAfterMs },
        });
      }
      return false;
    }

    const appName = options.appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;
    const riskLevel = PERMISSION_CATEGORIES[permission]?.risk ?? 'low';

    const granted = await showPermissionDialog({
      permission, appId, appName, riskLevel,
      reason   : options.reason ?? null,
      permanent: options.permanent !== false,
      current  : options.current ?? 1,
      total    : options.total ?? 1,
    });

    if (granted) {
      await persistGrant(permission, appId, {
        permanent: options.permanent !== false,
        reason   : options.reason ?? null,
      });
    } else {
      await persistDenial(permission, appId);
    }
    recordRateLimitOutcome(permission, appId, granted);
    return granted;
  }

  // Sequential multi-permission queue

  async function requestAll(permissions, appId, appName) {
    if (!permissions?.length) return true;

    // Only skip permissions already granted — previously denied ones still
    // get a live re-prompt via requestPermission() below.
    const pending = permissions.filter(p => !isGranted(p, appId));
    if (!pending.length) return true;

    const resolvedName = appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;

    let allGranted = true;
    for (const [i, permission] of pending.entries()) {
      const granted = await requestPermission(permission, appId, {
        appName: resolvedName,
        current: i + 1,
        total  : pending.length,
      });
      if (!granted) allGranted = false;
    }
    return allGranted;
  }

  // Grant / revoke

  async function persistGrant(permission, appId, options = {}) {
    const key   = makeAppScopedKey(appId, permission);
    const nowIso = new Date().toISOString();
    const grant = {
      appId,
      permission,
      granted   : true,
      grantedAt : nowIso,
      grantedBy : 'user',
      permanent : options.permanent !== false,
      expiresAt : options.permanent === false
        ? new Date(Date.now() + MS_PER_DAY).toISOString()
        : null,
      reason    : options.reason ?? null,
      lastUsed  : nowIso,
    };
    permissionGrants.set(key, grant);
    await saveToStorage();
    consentLog.push({ ...grant, timestamp: nowIso });
    console.log(`[AppPermissionManager] Granted ${permission} → ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'info', message: `Granted ${permission} → ${appId}`, data: { appId, permission, action: 'grant' } });
    }
  }

  async function persistDenial(permission, appId) {
    const key   = makeAppScopedKey(appId, permission);
    const nowIso = new Date().toISOString();
    const grant = {
      appId,
      permission,
      granted   : false,
      grantedAt : nowIso,
      grantedBy : 'user',
      permanent : true,
      expiresAt : null,
      reason    : 'User denied',
      lastUsed  : nowIso,
    };
    permissionGrants.set(key, grant);
    await saveToStorage();
    console.log(`[AppPermissionManager] Denied ${permission} → ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'warn', message: `Denied ${permission} → ${appId}`, data: { appId, permission, action: 'deny' } });
    }
  }

  async function grantPermission(permission, appId, options = {}) {
    assertValidAppId(appId);
    await persistGrant(permission, appId, options);
  }

  async function revokePermission(permission, appId) {
    assertValidAppId(appId);
    permissionGrants.delete(makeAppScopedKey(appId, permission));
    await saveToStorage();
    console.log(`[AppPermissionManager] Revoked ${permission} ← ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'info', message: `Revoked ${permission} ← ${appId}`, data: { appId, permission, action: 'revoke' } });
    }
  }

  async function revokeAllPermissions(appId) {
    assertValidAppId(appId);
    const prefix = makeAppScopedKey(appId, '');
    let count = 0;
    for (const key of permissionGrants.keys()) {
      if (key.startsWith(prefix)) { permissionGrants.delete(key); count++; }
    }
    for (const key of rateLimitState.keys()) {
      if (key.startsWith(prefix)) rateLimitState.delete(key);
    }
    await saveToStorage();
    console.log(`[AppPermissionManager] Revoked all permissions for ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'info', message: `Revoked all ${count} permission(s) for ${appId}`, data: { appId, count, action: 'revoke-all' } });
    }
  }

  // Queries

  function getAppPermissions(appId) {
    return [...permissionGrants.values()].filter(g => g.appId === appId);
  }

  function getConsentLog() {
    return [...consentLog];
  }

  function getStats() {
    const grants = [...permissionGrants.values()];
    const byCategory = new Map();
    const byRisk = new Map();
    for (const g of grants) {
      const meta = PERMISSION_CATEGORIES[g.permission];
      const cat  = meta?.category ?? 'other';
      const risk = meta?.risk ?? 'low';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      byRisk.set(risk, (byRisk.get(risk) ?? 0) + 1);
    }
    return {
      totalGrants: grants.length,
      byCategory : Object.fromEntries(byCategory),
      byRisk     : Object.fromEntries(byRisk),
    };
  }

  // Dialog UI
  //
  // Built with DOM APIs rather than innerHTML template strings. appName and
  // reason both ultimately come from an app's own manifest/call site —
  // untrusted third-party input per the sandboxing model this file is part
  // of — so every piece of dynamic text is set via textContent, never
  // parsed as markup.

  const RISK_COLORS = Object.freeze({
    low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149',
  });

  const RISK_ICONS = Object.freeze({
    low: '✅', medium: '🛡', high: '🔒', critical: '⚠',
  });

  function ensureDialogStylesInjected() {
    if (document.getElementById('_apm_styles')) return;
    const style = document.createElement('style');
    style.id = '_apm_styles';
    style.textContent = '@keyframes _apm_fadein{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}';
    document.head.appendChild(style);
  }

  function el(tag, { style, text, attrs } = {}) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text != null) node.textContent = text;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function buildPagerRow(current, total) {
    const row = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;',
    });
    row.append(el('span', {
      style: 'font-size:11px;color:#8b949e;letter-spacing:.05em;text-transform:uppercase;',
      text : `Permission ${current} of ${total}`,
    }));
    const dots = el('div', { style: 'display:flex;gap:4px;' });
    for (let i = 0; i < total; i++) {
      dots.append(el('div', {
        style: `width:6px;height:6px;border-radius:50%;background:${i < current ? '#58a6ff' : 'rgba(255,255,255,0.15)'}`,
      }));
    }
    row.append(dots);
    return row;
  }

  function buildHeaderRow({ label, appName, riskColor, riskIcon }) {
    const row = el('div', {
      style: 'display:flex;align-items:center;gap:12px;margin-bottom:18px;',
    });
    row.append(el('div', {
      style: `width:44px;height:44px;border-radius:10px;flex-shrink:0;background:${riskColor}1a;display:flex;align-items:center;justify-content:center;font-size:22px;`,
      text : riskIcon,
    }));

    const textCol = el('div');
    textCol.append(el('h3', {
      style: 'color:#e6edf3;font-size:15px;margin:0 0 2px;',
      text : label,
    }));
    const requestedBy = el('p', { style: 'color:#8b949e;font-size:12px;margin:0;' });
    requestedBy.append(document.createTextNode('Requested by '));
    requestedBy.append(el('strong', { style: 'color:#c9d1d9', text: appName }));
    textCol.append(requestedBy);
    row.append(textCol);
    return row;
  }

  function buildReasonBlock(reason, riskColor) {
    return el('p', {
      style: `color:#8b949e;font-size:13px;margin:0 0 14px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:3px solid ${riskColor}40;`,
      text : reason,
    });
  }

  function buildRiskRow({ riskLevel, riskColor, category }) {
    const row = el('div', {
      style: 'display:flex;align-items:center;gap:8px;margin-bottom:18px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;',
    });
    row.append(el('span', {
      style: 'font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;',
      text : 'Risk',
    }));
    row.append(el('span', {
      style: `font-size:12px;font-weight:600;color:${riskColor};`,
      text : riskLevel.toUpperCase(),
    }));
    row.append(el('span', { style: 'color:rgba(255,255,255,0.15);margin:0 2px;', text: '·' }));
    row.append(el('span', { style: 'font-size:12px;color:#8b949e;', text: category }));
    return row;
  }

  function buildButtonRow() {
    const row = el('div', { style: 'display:flex;gap:10px;' });
    const denyBtn = el('button', {
      style: 'flex:1;padding:11px 16px;border:1px solid rgba(255,255,255,0.12);border-radius:9px;background:transparent;color:#8b949e;font-size:14px;cursor:pointer;transition:border-color .15s,color .15s;',
      text : 'Deny',
      attrs: { type: 'button', 'data-action': 'deny' },
    });
    const grantBtn = el('button', {
      style: 'flex:1;padding:11px 16px;border:none;border-radius:9px;background:#58a6ff;color:#0d1117;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;',
      text : 'Allow',
      attrs: { type: 'button', 'data-action': 'grant' },
    });
    row.append(denyBtn, grantBtn);
    return { row, denyBtn, grantBtn };
  }

  function showPermissionDialog(opts) {
    return new Promise((resolve) => {
      const { permission, appName, riskLevel, reason, current, total } = opts;
      const riskColor = RISK_COLORS[riskLevel] ?? RISK_COLORS.low;
      const riskIcon  = RISK_ICONS[riskLevel] ?? RISK_ICONS.low;
      const meta      = PERMISSION_CATEGORIES[permission];
      const label     = meta?.label ?? permission;
      const category  = meta?.category ?? 'general';

      ensureDialogStylesInjected();

      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:100000;backdrop-filter:blur(6px);animation:_apm_fadein 0.15s ease;',
      });

      const card = el('div', {
        style: 'background:#0e121c;border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:24px;max-width:460px;width:90%;box-shadow:0 32px 80px rgba(0,0,0,0.7);animation:_apm_fadein 0.18s ease;',
      });

      if (total > 1) card.append(buildPagerRow(current, total));
      card.append(buildHeaderRow({ label, appName, riskColor, riskIcon }));
      if (reason) card.append(buildReasonBlock(reason, riskColor));
      card.append(buildRiskRow({ riskLevel, riskColor, category }));

      const { row: buttonRow, denyBtn, grantBtn } = buildButtonRow();
      card.append(buttonRow);
      overlay.append(card);
      document.body.append(overlay);

      const controller = new AbortController();
      let settled = false;

      function settle(result) {
        if (settled) return;
        settled = true;
        controller.abort();
        openDialogs.delete(forceClose);
        try {
          overlay.remove();
        } catch {
          // overlay already detached (e.g. host shell cleared the DOM) — fine
        }
        resolve(result);
      }

      // Registered so an external caller (or a future host-shell teardown
      // path) can force this dialog closed instead of leaving
      // requestPermission() — and anything awaiting it, like requestAll() —
      // hung forever if the overlay disappears from under us some other way.
      function forceClose() {
        settle(false);
      }
      openDialogs.add(forceClose);

      denyBtn.addEventListener('click', () => settle(false), { signal: controller.signal });
      grantBtn.addEventListener('click', () => settle(true), { signal: controller.signal });

      denyBtn.addEventListener('mouseenter', () => {
        denyBtn.style.borderColor = '#58a6ff';
        denyBtn.style.color = '#58a6ff';
      }, { signal: controller.signal });
      denyBtn.addEventListener('mouseleave', () => {
        denyBtn.style.borderColor = 'rgba(255,255,255,0.12)';
        denyBtn.style.color = '#8b949e';
      }, { signal: controller.signal });
      grantBtn.addEventListener('mouseenter', () => {
        grantBtn.style.background = '#79b8ff';
      }, { signal: controller.signal });
      grantBtn.addEventListener('mouseleave', () => {
        grantBtn.style.background = '#58a6ff';
      }, { signal: controller.signal });

      // Keyboard: Enter = grant, Escape = deny. Bound to document (not the
      // dialog) to match the original behavior of working regardless of
      // focus, but torn down via the same AbortController as every other
      // listener here — the previous version's version of this handler
      // was the one listener that didn't get cleaned up on a mouse-click
      // dismissal, since it removed itself only from inside its own
      // Enter/Escape branches.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); settle(true); }
        if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      }, { signal: controller.signal });
    });
  }

  // Force-closes every currently open permission dialog, resolving each as
  // a denial. Exists so a host-level teardown (route change, logout, app
  // force-quit) can guarantee no dialog — and nothing awaiting it — is left
  // hanging, without needing to know about this module's internals.
  function closeAllDialogs() {
    for (const forceClose of [...openDialogs]) forceClose();
  }

  // Public API

  return {
    initialize,
    isGranted,
    isDenied,
    isRateLimited,
    resetPermission,
    requestPermission,
    requestAll,
    grantPermission,
    revokePermission,
    revokeAllPermissions,
    recordAppUse,
    getAppPermissions,
    getConsentLog,
    getStats,
    closeAllDialogs,
    PERMISSION_TYPES,
    PERMISSION_CATEGORIES,
  };
})();

window.AppPermissionManager = AppPermissionManager;

// Auto-initialize
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppPermissionManager.initialize());
  } else {
    AppPermissionManager.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppPermissionManager;