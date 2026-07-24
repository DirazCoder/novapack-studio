/**
 * NovaByte — App Registry
 * ─────────────────────────────────────────────────────────────
 * Manages installed applications, registration with OS.apps,
 * and app lifecycle (install, uninstall, update).
 *
 * Fixes applied vs previous version:
 *  [R1] window.AppRegistry — exported as a true global so every
 *       other file (AppPermissionManager, system-events, etc.) can
 *       reference it without import gymnastics.
 *  [R2] launchApp — no longer throws on missing permissions.
 *       Instead it calls AppPermissionManager.requestAll() which
 *       shows the sequential Android-style prompt queue, then
 *       proceeds or aborts cleanly.
 *  [R3] lastLaunched written on every launch — consumed by
 *       AppPermissionManager's 30-day unused-app expiry sweep.
 *  [R4] onInstall / onUninstall accept multiple callbacks via
 *       arrays instead of a single overwriteable reference.
 *  [R5] checkPermissions() guards against AppPermissionManager
 *       not yet being loaded.
 *
 * @module js/platform/core/app-registry
 */

const AppRegistry = (() => {
  'use strict';

  const STORAGE_KEY = 'nova_registry_meta';

  let installedApps    = new Map();
  const _onInstalled   = [];
  const _onUninstalled = [];

  const KNOWN_PERMISSIONS = new Set([
    'vfs:read', 'vfs:write', 'vfs:delete', 'vfs:metadata',
    'net:internal', 'net:external', 'net:websocket',
    'mail:read', 'mail:write', 'mail:send', 'mail:delete',
    'calendar:read', 'calendar:write', 'calendar:delete',
    'contacts:read', 'contacts:write', 'contacts:delete',
    'device:notifications', 'device:geolocation', 'device:camera', 'device:microphone',
    'system:info', 'system:settings', 'system:apps', 'system:events',
    'system:background', 'system:background:live', 'system:autostart',
    'sandbox:nested-webview', 'sandbox:same-origin',
    'admin:apps', 'admin:users', 'admin:system', 'admin:audit',
  ]);

  const RESERVED_APP_IDS = new Set([
    'nook', 'app-manager', 'browser', 'nbosp-email', 'vault',
    'shell', 'nbosp-gallery', 'nbosp-music', 'nbosp-downloads',
    'nbosp-search', 'nbosp-contacts', 'calendar-app', 'calculator',
    'nbosp-clock', 'quill', 'nbosp-files',
  ]);

  // ── Storage ────────────────────────────────────────────────────────────────

  function _saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...installedApps.values()]));
    } catch (e) {
      if (e.name !== 'SecurityError') {
        console.error('[AppRegistry] save failed:', e);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'error', message: `Registry save failed: ${e?.message || e}` });
        }
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppRegistry] localStorage unavailable — in-memory only');
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: 'localStorage unavailable — running in-memory only' });
        }
        return;
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const apps = JSON.parse(raw);
      for (const app of apps) {
        // Re-sanitize on restore too — closes the gap for records persisted
        // by a pre-patch version of this file, where a .novaapp install
        // could have had autoGrant: true written to storage before this
        // source-based check existed. See registerApp() for the full
        // rationale; kept in sync with the same rule (source === 'local').
        if ((app.source || 'local') !== 'local' && app.autoGrant) {
          app.autoGrant = false;
        }
        installedApps.set(app.id, app);
        if (typeof OS !== 'undefined' && OS?.apps) {
          // Always rebuild from the persisted record, even if a static
          // OS.apps[app.id] already exists — otherwise a restored install
          // that shares an id with a pre-registered app can never win here,
          // and (see below) never reaches APP_REGISTRY either.
          OS.apps[app.id] = {
            id: app.id, name: app.name, icon: app.icon, description: app.description,
            defaultSize: app.defaultSize || [800, 600], minSize: app.minSize || [400, 300],
            maxSize: app.maxSize ?? null,
            resizable: app.resizable !== false, frame: app.frame !== false,
            alwaysOnTop: app.alwaysOnTop || false, fullscreenable: app.fullscreenable !== false,
            startMinimized: app.startMinimized || false, transparent: app.transparent || false,
            devOnly: app.devOnly || false,
            autoGrant: app.autoGrant || false,
            init: (content, state, options) => AppRegistry.launchApp(app.id, content, state, options),
            onDrop: app.onDrop ?? undefined,
            onClose: app.onClose ?? undefined,
          };
          // registerApp() (js/core/services/registry.js) is the only thing
          // that writes into APP_REGISTRY, which is what the launchpad and
          // taskbar actually iterate — see the comment in registerApp() in
          // this file. initialize() rebuilt OS.apps by hand above and never
          // called it, so every restored app vanished from APP_REGISTRY on
          // reload even though OS.apps (and thus direct launches) was fine.
          // This is almost certainly the "old UI comes back after refresh"
          // bug: the render layer was reading a registry that boot never
          // repopulated.
          if (typeof window !== 'undefined' && typeof window.registerApp === 'function') {
            window.registerApp(OS.apps[app.id]);
          }
        }
      }
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
      console.log(`[AppRegistry] Loaded ${installedApps.size} app(s)`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Loaded ${installedApps.size} app(s) from storage`, data: { count: installedApps.size } });
      }
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppRegistry] localStorage denied (sandboxed) — in-memory only');
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: 'localStorage denied (sandboxed) — running in-memory only' });
        }
      } else {
        console.error('[AppRegistry] initialize failed:', e);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'error', message: `Initialize failed: ${e?.message || e}` });
        }
      }
      installedApps = new Map();
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  function registerApp(appConfig, options = {}) {
    if (!appConfig?.id || !appConfig?.name) throw new Error('[AppRegistry] App must have id and name');

    if (installedApps.has(appConfig.id) && !options.force) {
      return installedApps.get(appConfig.id);
    }

    if (RESERVED_APP_IDS.has(appConfig.id) && !appConfig.verified) {
      throw new Error('[AppRegistry] Registration denied — id "' + appConfig.id + '" is reserved for system apps. Verify the app signature to proceed.');
    }

    const allPerms = [...(appConfig.permissions || []), ...(appConfig.optionalPermissions || [])];
    const unknown = allPerms.filter(p => !KNOWN_PERMISSIONS.has(p));
    if (unknown.length > 0) {
      console.warn('[AppRegistry] Rejecting unknown permission(s) for', appConfig.id + ':', unknown.join(', '));
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Rejected unknown permission(s) for ${appConfig.id}: ${unknown.join(', ')}`, data: { appId: appConfig.id, unknown } });
      }
      appConfig.permissions = (appConfig.permissions || []).filter(p => KNOWN_PERMISSIONS.has(p));
      appConfig.optionalPermissions = (appConfig.optionalPermissions || []).filter(p => KNOWN_PERMISSIONS.has(p));
    }

    // autoGrant silently skips the permission-request prompt entirely (see
    // launchApp() below) — it exists for first-party dev tools that are
    // hardcoded into the JS bundle (console, packages, permissions, etc.),
    // none of which go through a package install path. Every real .novaapp
    // install — whether via the Packages app, App Manager's manual install,
    // or the nova:app:install IPC handler in app-sandbox.js — sets `source`
    // to something other than the 'local' default used by built-ins. Any
    // manifest arriving through one of those paths is untrusted, so strip
    // autoGrant from it here regardless of what the manifest itself claims:
    // otherwise a package author could just declare autoGrant: true and
    // self-grant sandbox:same-origin (or any other permission) with zero
    // user prompt. This is enforced here, once, rather than at each of the
    // several install call sites, so it can't be missed by a new one later.
    const claimedSource = appConfig.source || 'local';
    const isBuiltinSource = claimedSource === 'local';
    if (!isBuiltinSource && appConfig.autoGrant) {
      console.warn('[AppRegistry] Ignoring autoGrant on non-builtin app', appConfig.id, '(source:', claimedSource + ')');
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Ignored autoGrant on non-builtin app ${appConfig.id} (source: ${claimedSource})`, data: { appId: appConfig.id, source: claimedSource } });
      }
    }

    const app = {
      icon: '/assets/no_app_icon.svg', description: '', version: '1.0.0', author: 'Unknown',
      type: 'webapp', entry: 'index.html', permissions: [], optionalPermissions: [],
      defaultSize: [800, 600], minSize: [400, 300], maxSize: null,
      resizable: true, frame: true, sandbox: { allowSameOrigin: false, allowScripts: true, allowForms: true, allowPopups: false },
      categories: ['other'], installedDate: new Date().toISOString(),
      lastLaunched: null, launchCount: 0, source: 'local', signature: null, verified: false,
      ...appConfig,
      id: appConfig.id,
      name: appConfig.name,
      autoGrant: isBuiltinSource ? (appConfig.autoGrant || false) : false,
    };

    if (typeof OS !== 'undefined' && OS?.apps) {
      OS.apps[app.id] = {
        id: app.id, name: app.name, icon: app.icon, description: app.description,
        defaultSize: app.defaultSize, minSize: app.minSize, maxSize: app.maxSize ?? null,
        resizable: app.resizable !== false, frame: app.frame !== false,
        alwaysOnTop: app.alwaysOnTop || false, fullscreenable: app.fullscreenable !== false,
        startMinimized: app.startMinimized || false, transparent: app.transparent || false,
        devOnly: appConfig.devOnly || false,
        autoGrant: app.autoGrant,
        init: (content, state, options) => AppRegistry.launchApp(app.id, content, state, options),
        onDrop: appConfig.onDrop ?? undefined,
        onClose: appConfig.onClose ?? undefined,
      };
    }

    installedApps.set(app.id, app);
    _saveToStorage();
    console.log(`[AppRegistry] Registered: ${app.name} (${app.id}) v${app.version}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Registered ${app.name} (${app.id}) v${app.version}`, data: { appId: app.id, version: app.version, verified: app.verified } });
    }

    // AppRegistry.registerApp() only ever touched installedApps + OS.apps.
    // The launchpad (and taskbar) render from the separate APP_REGISTRY
    // array maintained by the global window.registerApp() in registry.js —
    // installs never reached it, so a package could report success and
    // still never show up anywhere in the UI. Route through the same
    // global registrar here so both registries stay in sync, same as
    // every statically-loaded app already does on boot.
    if (typeof window !== 'undefined' && typeof window.registerApp === 'function' && OS?.apps?.[app.id]) {
      window.registerApp(OS.apps[app.id]);
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
    }

    for (const cb of _onInstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return app;
  }

  function unregisterApp(appId) {
    const app = installedApps.get(appId);
    if (!app) return false;

    // Every uninstall surface (App Manager, desktop right-click,
    // MyAppsManager) funnels through here — close any window still open
    // for this app before its registry entry, files, and permissions are
    // deleted out from under it. forceKill: true so a system:background:live
    // grant can't turn this into an orphaned webview that outlives the
    // registry entry being deleted below.
    if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === appId) openWindowIds.push(wid);
      }
      for (const wid of openWindowIds) WM.closeWindow(wid, { forceKill: true });
    }

    // An app can also be alive in the background with no open window at
    // all (its window was closed in an earlier moment of this session,
    // and its sandbox has been sitting in #background-app-host ever
    // since) — the loop above wouldn't touch that, since it only looks at
    // OS.windows. Catch that case directly so uninstalling a backgrounded
    // app actually stops its process instead of leaving it running with
    // no registry entry, files, or permissions left to justify it.
    if (typeof AppSandbox !== 'undefined' && AppSandbox.getAllSandboxes) {
      for (const sandbox of AppSandbox.getAllSandboxes()) {
        if (sandbox.appId === appId && sandbox.backgrounded) {
          AppSandbox.terminateBackground(sandbox.sandboxId);
          if (typeof Notify !== 'undefined' && Notify.unpin) Notify.unpin(`pin_bg_${appId}`);
        }
      }
    }

    if (typeof OS !== 'undefined' && OS?.apps) delete OS.apps[appId];
    installedApps.delete(appId);
    _saveToStorage();
    console.log(`[AppRegistry] Unregistered: ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Unregistered ${appId}`, data: { appId } });
    }

    // Mirror the registerApp() sync above — remove the stale entry from
    // APP_REGISTRY too, or an uninstalled app keeps showing in the launchpad.
    if (typeof window !== 'undefined' && Array.isArray(window.APP_REGISTRY)) {
      const idx = window.APP_REGISTRY.findIndex(a => a.id === appId);
      if (idx !== -1) window.APP_REGISTRY.splice(idx, 1);
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
    }

    for (const cb of _onUninstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return true;
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  /**
   * Launch an app.
   * FIX [R2]: missing required permissions now trigger the sequential
   * permission-request queue rather than throwing immediately.
   */
  async function launchApp(appId, content, state, options) {
    try {
      const disabled = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
      if (disabled.some(x => (typeof x === 'string' ? x : x?.id) === appId)) {
        console.warn('[AppRegistry] Launch blocked — disabled app:', appId);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Launch blocked — ${appId} is disabled`, data: { appId } });
        }
        try {
          const name = OS?.apps?.[appId]?.name || appId;
          if (typeof Notify !== 'undefined' && Notify.show) {
            Notify.show({ title: 'App disabled', body: name + ' has a broken install and was disabled.', type: 'warn', appName: 'System' });
          }
        } catch { }
        return null;
      }
    } catch { }

    const app = installedApps.get(appId);
    if (!app) throw new Error(`[AppRegistry] App not found: ${appId}`);

    if (!OS.settings.get('devMode') && app.devOnly) return null;

    // FIX [R2]: request missing permissions before proceeding
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    if (mgr && app.permissions.length > 0) {
      const missing = app.permissions.filter(p => !mgr.isGranted(p, appId));
      if (missing.length > 0) {
        if (app.autoGrant) {
          for (const p of missing) {
            await mgr.grantPermission(p, appId, { permanent: true, reason: 'Auto-granted for developer tool', grantedBy: 'system' });
          }
        } else {
          const allGranted = await mgr.requestAll(missing, appId, app.name);
          if (!allGranted) {
            console.warn(`[AppRegistry] Launch aborted — permissions denied for ${appId}`);
            if (typeof EventLog !== 'undefined') {
              EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Launch aborted — permissions denied for ${appId}`, data: { appId, missing } });
            }
            return null;
          }
        }
      }
    }

    // FIX [R3]: update usage timestamps so 30-day expiry sweep has data
    app.launchCount  = (app.launchCount || 0) + 1;
    app.lastLaunched = new Date().toISOString();
    _saveToStorage();

    // Also tell the permission manager this app was just used
    if (mgr?.recordAppUse) mgr.recordAppUse(appId);

    console.log(`[AppRegistry] Launching: ${app.name} (${appId})`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Launching ${app.name} (${appId})`, data: { appId, launchCount: app.launchCount } });
    }

    if (typeof AppSandbox !== 'undefined') {
      return AppSandbox.launch(app, content, state, options);
    }
    // Fallback if sandbox not loaded
    if (typeof app.init === 'function') return app.init(content, state, options);
    return null;
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  /**
   * FIX [R5]: guard against AppPermissionManager not yet being loaded.
   */
  function checkPermissions(app) {
    if (typeof AppPermissionManager === 'undefined') return true; // defer to launchApp
    return app.permissions.every(p => AppPermissionManager.isGranted(p, app.id));
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch fields on an existing installedApps entry.
   * Used by app-permissions-bootstrap to write permissions[] into the
   * internal map — the only object launchApp() actually reads from.
   */
  function updateApp(appId, patch) {
    const app = installedApps.get(appId);
    if (!app) return false;
    Object.assign(app, patch);
    _saveToStorage();
    return true;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  function getApp(appId)              { return installedApps.get(appId) ?? null; }
  function getAllApps()               { return [...installedApps.values()]; }
  function getAppsByCategory(cat)    { return [...installedApps.values()].filter(a => a.categories.includes(cat)); }

  function getStats() {
    const apps = [...installedApps.values()];
    return {
      totalApps   : apps.length,
      totalLaunches: apps.reduce((s, a) => s + (a.launchCount || 0), 0),
      byCategory  : apps.reduce((acc, a) => {
        for (const c of a.categories) acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, {}),
      verifiedApps: apps.filter(a => a.verified).length,
    };
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  // FIX [R4]: arrays instead of single overwriteable references
  function onInstall(cb)   { if (typeof cb === 'function') _onInstalled.push(cb); }
  function onUninstall(cb) { if (typeof cb === 'function') _onUninstalled.push(cb); }

  return {
    initialize, registerApp, unregisterApp, launchApp, updateApp,
    getApp, getAllApps, getAppsByCategory, checkPermissions,
    onInstall, onUninstall, getStats,
  };
})();

// FIX [R1]: expose as a true global so AppPermissionManager, system-events,
// and any other file can reference window.AppRegistry directly.
window.AppRegistry = AppRegistry;

// Auto-initialize
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppRegistry.initialize());
  } else {
    AppRegistry.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppRegistry;