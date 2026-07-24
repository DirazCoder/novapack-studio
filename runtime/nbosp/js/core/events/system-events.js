'use strict';

// system-events.js — shell-level event handlers for the NovaByte desktop.
// Wires up the launchpad, notification panel, system tray, keyboard shortcuts,
// screenshot capture, lock screen, recovery mode, and the snake easter egg.

// Cached prefers-reduced-motion query. matchMedia is not free and we re-check
// this every time the launchpad opens, so query it once here.
const _reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

// Interval IDs that need to be reachable from more than one function. Kept at
// module scope so verifyPin() can start a wipe countdown and unlockFromLockScreen()
// can cancel it, and so the recovery screen can replace its own clock/countdown
// timers without leaking the previous ones.
let _wipeCountdownId = 0;
let _recoveryClockId = 0;
let _recoveryCountdownId = 0;
let _debouncedLaunchpadSearch = null;

// Frozen direction map for the snake game. Built once, never rebuilt per keypress.
const _SNAKE_DIR_MAP = Object.freeze({
  ArrowUp:    { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 }, s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 }, d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
});

// Threat patterns for file content scanning. Compiled without the /g flag so
// .test() is always stateless — a /g regex advances lastIndex on each match
// and silently returns false on the next call, which let malicious content
// bypass the scanner on every second invocation.
const _THREAT_PATTERNS = Object.freeze([
  { regex: /<script[\s\S]*?alert\s*\(/i,     name: 'alert-xss',       severity: 'high'     },
  { regex: /onerror\s*=\s*["']alert/i,        name: 'onerror-alert',   severity: 'high'     },
  { regex: /onclick\s*=\s*["']alert/i,         name: 'onclick-alert',   severity: 'high'     },
  { regex: /eval\s*\(\s*atob\s*\(/i,           name: 'encoded-eval',    severity: 'critical' },
  { regex: /eval\s*\(\s*decodeURIComponent/i,  name: 'uri-decode-eval', severity: 'critical' },
]);

// Hard cap on virtual desktops. Defined here so switchWorkspace() can rely on
// it — the previous code referenced an undeclared maxWorkspaces and crashed.
const MAX_WORKSPACES = 9;

// Look up whether an app already has a desktop .lnk shortcut. Used by the
// launchpad context menu to decide between "Pin to Desktop" and "Unpin from
// Desktop". Tolerates any FS failure and just reports "no shortcut".
function _hasDesktopShortcut(appId) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return false;
    for (const f of FS.listDir(desktopFolder)) {
      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          if (JSON.parse(f.content || '{}')?.target === appId) return true;
        } catch { /* skip invalid shortcut payloads */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Highlight every case-insensitive occurrence of `query` inside `text` by
// appending text nodes and <mark> elements to `target`. Done entirely through
// the DOM so app names containing <, >, or & can't break out into HTML.
function _highlightMatches(target, text, query) {
  target.textContent = '';
  if (!query) {
    target.appendChild(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      target.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) target.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.style.cssText = 'background:var(--accent);color:#fff;border-radius:2px;padding:0 2px;';
    mark.textContent = text.slice(idx, idx + q.length);
    target.appendChild(mark);
    i = idx + q.length;
  }
}

// Strips the `data:<mime>;base64,` wrapper so only the raw base64 payload is
// stored — matches the VFS convention used for dropped/uploaded binary files
// (see extractBase64FromDataUrl in the desktop drop handler) and what apps
// like Gallery expect to decode.
function _dataUrlToBase64(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return '';
  const comma = dataUrl.indexOf(',');
  return comma > -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

// LAUNCHPAD

document.getElementById('start-btn')?.addEventListener('click', toggleLaunchpad);

function toggleLaunchpad() {
  const launchpad = document.getElementById('launchpad');
  if (!launchpad) return;
  const isClosing = launchpad.classList.contains('active');
  launchpad.classList.toggle('active');
  if (launchpad.classList.contains('active')) {
    _debouncedLaunchpadSearch?.cancel?.();
    renderLaunchpad();
    const searchEl = document.getElementById('launchpad-search');
    if (searchEl) {
      searchEl.value = '';
      setTimeout(() => { searchEl.focus(); searchEl.select() }, 50);
    }
    document.querySelectorAll('.launchpad-item').forEach(item => {
      item.style.display = '';
    });
    const noResultsMsg = document.getElementById('launchpad-no-results');
    if (noResultsMsg) noResultsMsg.style.display = 'none';
    launchpad.querySelectorAll('.launchpad-name mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  } else if (isClosing) {
    _debouncedLaunchpadSearch?.cancel?.();
    // Strip <mark> highlights back to plain text on close.
    launchpad.querySelectorAll('.launchpad-name mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }
}

function renderLaunchpad() {
  const grid = document.getElementById('launchpad-grid');
  if (!grid) return;
  const devMode = OS.settings.get('devMode');
  const apps = devMode ? APP_REGISTRY : APP_REGISTRY.filter(app => !app.devOnly);
  const webApps = (typeof WebAppManager !== 'undefined' && WebAppManager.getAllApps)
    ? WebAppManager.getAllApps()
    : [];

  // Signature tracks the set of apps currently rendered so we only rebuild the
  // grid when something actually changes — not on every open.
  const signature = [
    ...apps.map(app => `${app.id}:${app.name}:${app.icon}`),
    ...webApps.map(wa => `web:${wa.id}:${wa.name}:${wa.icon}:${wa.url}`)
  ].join('||');

  const needsRebuild = grid.dataset.renderedSignature !== signature || grid.children.length === 0;

  if (needsRebuild) {
    grid.innerHTML = '';
    grid.dataset.renderedSignature = signature;

    apps.forEach(app => appendAppItem(app, grid));

    if (typeof WebAppManager !== 'undefined') {
      webApps.forEach(webApp => appendWebAppItem(webApp, grid));
    }
  } else {
    // Already built — just reset animation state for re-open.
    Array.from(grid.children).forEach(item => {
      item.classList.remove('animate');
      item.style.opacity = '';
      item.style.transform = '';
      item.style.removeProperty('--delay');
      item.style.willChange = '';
      item.style.display = '';
    });
  }

  // Stagger animation radiates out from the grid centre.
  requestAnimationFrame(() => {
    const prefersReducedMotion =
      OS.settings.get('reduceMotion') || _reducedMotionMQ.matches;
    const items = Array.from(grid.querySelectorAll('.launchpad-item'))
      .filter(item => item.style.display !== 'none');

    if (prefersReducedMotion) {
      items.forEach(item => {
        item.style.opacity = '1';
        item.style.transform = 'scale(1)';
        item.classList.add('animate');
      });
      return;
    }

    const gridWidth = grid.offsetWidth;
    const gridHeight = grid.offsetHeight;
    const centerX = gridWidth / 2;
    const centerY = gridHeight / 2;
    const maxDist = Math.sqrt((gridWidth / 2) ** 2 + (gridHeight / 2) ** 2) || 1;

    items.forEach(item => {
      const cx = item.offsetLeft + item.offsetWidth / 2;
      const cy = item.offsetTop + item.offsetHeight / 2;
      const d = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2);
      const delay = Math.round((d / maxDist) * 300);
      item.style.setProperty('--delay', `${delay}ms`);
      item.style.willChange = 'transform, opacity';
      item.classList.add('animate');
      // Drop willChange once the animation has finished so the compositor can
      // release the layer.
      setTimeout(() => { item.style.willChange = ''; }, 500 + delay);
    });
  });
}

function appendAppItem(app, grid) {
  const targetGrid = grid || document.getElementById('launchpad-grid');
  if (!targetGrid) return;

  const item = createEl('button', {
    className: 'launchpad-item',
    'aria-label': app.name,
    draggable: 'true'
  });
  const icon = createEl('div', { className: 'launchpad-icon' });
  icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 28);
  item.appendChild(icon);
  item.appendChild(createEl('div', { className: 'launchpad-name', textContent: app.name }));

  item.addEventListener('click', () => { toggleLaunchpad(); WM.createWindow(app.id); });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAppContextMenu(e, app);
  });

  attachLaunchpadDragHandlers(item, app.name, {
    type: 'app-shortcut', appId: app.id, appName: app.name, appIcon: app.icon
  });
  targetGrid.appendChild(item);
}

function showAppContextMenu(e, app) {
  const pinnedApps = OS.settings.get('pinnedApps') || [];
  const isPinned = pinnedApps.includes(app.id);
  const storedApps = (() => {
    try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; }
  })();
  const isUserApp = storedApps.some(a => a.id === app.id);

  const menuItems = [
    { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); WM.createWindow(app.id); } },
    { separator: true },
    {
      label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
      icon: 'pin',
      action: () => toggleTaskbarPin(app.id, app.name, isPinned)
    }
  ];

  if (_hasDesktopShortcut(app.id)) {
    menuItems.push({ separator: true }, {
      label: 'Unpin from Desktop', icon: 'pin',
      action: () => unpinAppFromDesktop(app)
    });
  } else {
    menuItems.push({ separator: true }, {
      label: 'Pin to Desktop', icon: 'pin',
      action: () => pinAppToDesktop(app)
    });
  }

  if (isUserApp) {
    menuItems.push({ separator: true }, {
      label: 'Uninstall', icon: 'trash', danger: true,
      action: () => uninstallApp(app)
    });
  }

  ContextMenu.show(e.clientX, e.clientY, menuItems);
}

function toggleTaskbarPin(appId, appName, currentlyPinned) {
  const pins = OS.settings.get('pinnedApps') || [];
  if (currentlyPinned) {
    OS.settings.set('pinnedApps', pins.filter(id => id !== appId));
    WM.updateTaskbar();
    Notify.show({ title: 'Unpinned', body: `${appName} removed from taskbar`, type: 'success', appName: 'Launchpad' });
  } else {
    if (pins.includes(appId)) {
      Notify.show({ title: 'Already Pinned', body: `${appName} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
      return;
    }
    OS.settings.set('pinnedApps', [...pins, appId]);
    WM.updateTaskbar();
    Notify.show({ title: 'Pinned', body: `${appName} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
  }
}

async function pinAppToDesktop(app) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return;
    const shortcutContent = JSON.stringify({
      target: app.id,
      type: 'app-shortcut',
      icon: app.icon
    });
    await FS.createFile(desktopFolder, app.name + '.lnk', shortcutContent, 'application/x-app-shortcut');
    renderDesktopIcons();
    Notify.show({ title: 'Pinned to Desktop', body: `${app.name} shortcut added to desktop`, type: 'success', appName: 'Launchpad' });
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to pin to desktop: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

async function unpinAppFromDesktop(app) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return;
    let removed = 0;
    const iconPositions = OS.settings.get('desktopIconPositions') || {};
    for (const f of FS.listDir(desktopFolder)) {
      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          const data = JSON.parse(f.content || '{}');
          if (data?.type === 'app-shortcut' && data?.target === app.id) {
            await FS.permanentDelete(f.id);
            delete iconPositions['file:' + f.id];
            removed++;
          }
        } catch { /* skip invalid shortcut payloads */ }
      }
    }
    OS.settings.set('desktopIconPositions', iconPositions);
    renderDesktopIcons();
    WM.updateTaskbar();
    Notify.show({
      title: 'Unpinned from Desktop',
      body: removed > 0
        ? `Removed ${removed} desktop shortcut${removed > 1 ? 's' : ''} for ${app.name}`
        : `No desktop shortcuts found for ${app.name}`,
      type: 'success', appName: 'Launchpad'
    });
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to unpin from desktop: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

async function uninstallApp(app) {
  toggleLaunchpad();
  const uninstallResult = await showModal(
    'Uninstall App',
    `Uninstall "${app.name}"? This cannot be undone.`,
    [{ label: 'Cancel' }, { label: 'Uninstall', value: 'confirm', danger: true }]
  );
  if (uninstallResult !== 'confirm') return;

  try {
    // Close any open windows for this app before tearing it down.
    if (WM?.closeWindow && OS.windows) {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === app.id) openWindowIds.push(wid);
      }
      await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
    }

    if (window.NovaAppPackageStore?.removeApp) {
      await NovaAppPackageStore.removeApp(app.id);
    } else {
      const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
      localStorage.setItem(
        'nova_installed_apps',
        JSON.stringify(stored.filter(a => a.id !== app.id))
      );
    }

    // Best-effort cleanup of per-app storage and data dirs — failures here
    // shouldn't abort the uninstall. clearAppPartition wipes the webview's
    // own storage partition; storageClear wipes the separate nova:storage
    // IndexedDB (see storageClear in app-sandbox.js) that clearAppPartition
    // never touches.
    await Promise.allSettled([
      AppSandbox?.clearAppPartition?.(app.id),
      AppSandbox?.storageClear?.(app.id),
      AppDirs?.removeAppData?.(app.id),
    ]);

    AppRegistry?.unregisterApp?.(app.id);
    if (OS.apps) delete OS.apps[app.id];
    const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
    if (ri > -1) APP_REGISTRY.splice(ri, 1);
    OS.settings.set('pinnedApps', (OS.settings.get('pinnedApps') || []).filter(id => id !== app.id));

    // Clear disabled/boot lists so the app doesn't get re-resurrected on restart.
    for (const key of ['nova_disabled_apps', 'nova_boot_apps']) {
      try {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const updated = list.filter(x => (typeof x === 'string' ? x : x?.id) !== app.id);
        localStorage.setItem(key, JSON.stringify(updated));
      } catch { /* quota or parse error — best effort */ }
    }

    // Remove any desktop shortcuts that pointed at the uninstalled app.
    try {
      const desktopFolder = FS.specialFolders?.desktop;
      if (desktopFolder) {
        for (const f of FS.listDir(desktopFolder)) {
          if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
            try {
              const data = JSON.parse(f.content || '{}');
              if (data?.type === 'app-shortcut' && data?.target === app.id) {
                await FS.permanentDelete(f.id);
              }
            } catch { /* skip invalid shortcut payloads */ }
          }
        }
      }
    } catch (err) {
      console.warn('[Launchpad] Failed to clean up shortcuts for', app.id, err);
      EventLog?.log?.({ app: 'Launchpad', category: 'apps', severity: 'warn', message: `Failed to clean up desktop shortcuts for ${app.id}: ${err?.message || err}`, data: { appId: app.id } });
    }

    renderDesktopIcons();
    WM.updateTaskbar();
    if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
    Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Launchpad' });
  } catch (err) {
    Notify.show({ title: 'Error', body: `Failed to uninstall: ${err?.message || err}`, type: 'error', appName: 'Launchpad' });
  }
}

function appendWebAppItem(webApp, grid) {
  const item = createEl('button', {
    className: 'launchpad-item',
    'aria-label': `${webApp.name} (Web App)`,
    // Cap URL length on the tooltip so very long data URIs don't reflow the
    // browser's native tooltip popup for seconds at a time.
    title: typeof webApp.url === 'string' ? webApp.url.slice(0, 2048) : '',
    draggable: 'true'
  });

  const icon = createEl('div', {
    className: 'launchpad-icon',
    style: 'font-size: 28px; line-height: 1;'
  });
  if (webApp.icon) {
    if (/^data:|^https?:\/\//i.test(webApp.icon)) {
      const img = createEl('img', {
        src: webApp.icon,
        style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:inherit;',
        draggable: 'false',
        crossorigin: 'anonymous'
      });
      img.onerror = () => { icon.innerHTML = svgIcon('globe', 28); };
      icon.appendChild(img);
    } else {
      icon.textContent = webApp.icon;
    }
  } else {
    icon.innerHTML = svgIcon('globe', 28);
  }

  const name = createEl('div', { className: 'launchpad-name', textContent: webApp.name });
  const indicator = createEl('div', {
    style: 'position:absolute;bottom:4px;right:4px;width:8px;height:8px;background:#58a6ff;border-radius:50%;border:1px solid rgba(255,255,255,0.3);',
    title: 'Web App'
  });

  item.append(icon, name, indicator);

  // Extracted so the context-menu "Open" can call it directly. Calling
  // item.click() instead would re-enter toggleLaunchpad() and double-close.
  // Delegates to openWebApp() (registry.js) which sets OS.apps[id].init(),
  // so the webview renders correctly on subsequent opens via taskbar/desktop.
  function launchWebApp() {
    toggleLaunchpad();
    try {
      if (typeof window.openWebApp !== 'function') throw new Error('Web app launcher unavailable');
      const windowElement = window.openWebApp(webApp.id);
      if (!windowElement) throw new Error('Web app not found');
    } catch (error) {
      Notify.show({
        title: 'Error', body: `Failed to launch app: ${error.message}`,
        type: 'error', appName: 'System'
      });
    }
  }

  item.addEventListener('click', launchWebApp);

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const waPins = OS.settings.get('pinnedApps') || [];
    const waId = 'webapp_' + webApp.id;
    const waIsPinned = waPins.includes(waId);
    ContextMenu.show(e.clientX, e.clientY, [
      { label: 'Open', icon: 'play', action: launchWebApp },
      { separator: true },
      {
        label: waIsPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
        icon: 'pin',
        action: () => {
          const p = OS.settings.get('pinnedApps') || [];
          if (waIsPinned) {
            OS.settings.set('pinnedApps', p.filter(id => id !== waId));
            WM?.updateTaskbar?.();
            Notify.show({ title: 'Unpinned', body: `${webApp.name} unpinned from taskbar`, type: 'success', appName: 'Launchpad' });
          } else {
            if (p.includes(waId)) {
              Notify.show({ title: 'Already Pinned', body: `${webApp.name} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
              return;
            }
            OS.settings.set('pinnedApps', [...p, waId]);
            WM?.updateTaskbar?.();
            Notify.show({ title: 'Pinned', body: `${webApp.name} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
          }
        }
      },
      { separator: true },
      {
        label: 'Remove Web App', icon: 'trash', danger: true,
        action: async () => {
          // removeWebApp (registry.js) also unpins from the taskbar and
          // deletes any desktop .lnk shortcut, matching the Web Apps tab's
          // own Remove button.
          if (typeof window.removeWebApp === 'function') {
            await window.removeWebApp(webApp.id);
          } else {
            WebAppManager.removeApp(webApp.id);
          }
          renderLaunchpad();
          Notify.show({ title: 'Removed', body: `"${webApp.name}" has been removed`, type: 'success', appName: 'Launchpad' });
        }
      }
    ]);
  });

  attachLaunchpadDragHandlers(item, webApp.name, {
    type: 'app-shortcut', appId: 'webapp_' + webApp.id, appName: webApp.name, appIcon: webApp.icon
  });
  grid.appendChild(item);
}

// Shared drag handlers for both native and web app launchpad items.
function attachLaunchpadDragHandlers(item, displayName, payload) {
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', displayName);
    const dragImg = createEl('div', {
      style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;'
    });
    dragImg.textContent = displayName;
    document.body.appendChild(dragImg);
    e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
    requestAnimationFrame(() => {
      // requestAnimationFrame may fire after a dragcancel has already torn
      // the drag image down — guard the removeChild so we don't throw.
      if (dragImg.parentNode === document.body) document.body.removeChild(dragImg);
      const lp = document.getElementById('launchpad');
      if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
    });
  });

  item.addEventListener('dragend', () => {
    const lp = document.getElementById('launchpad');
    if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
    setTimeout(() => {
      if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
    }, 80);
  });
}

// Launchpad search — debounced so we don't reflow the whole grid on every keystroke.
_debouncedLaunchpadSearch = debounce((e) => {
  const q = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.launchpad-item');
  let visibleCount = 0;

  items.forEach(item => {
    const nameEl = item.querySelector('.launchpad-name');
    const name = (nameEl?.textContent || '').toLowerCase();
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    const match = q === '' || name.includes(q) || label.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) {
      visibleCount++;
      if (nameEl && q) {
        const original = nameEl.dataset.originalText ?? nameEl.textContent;
        nameEl.dataset.originalText = original;
        _highlightMatches(nameEl, original, q);
      } else if (nameEl) {
        delete nameEl.dataset.originalText;
        nameEl.textContent = nameEl.textContent;
      }
    }
  });

  let noResultsMsg = document.getElementById('launchpad-no-results');
  if (q && visibleCount === 0 && items.length > 0) {
    if (!noResultsMsg) {
      noResultsMsg = createEl('div', {
        id: 'launchpad-no-results',
        className: 'launchpad-no-results',
        textContent: 'No apps found',
        style: 'grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;'
      });
      document.getElementById('launchpad-grid')?.appendChild(noResultsMsg);
    }
    noResultsMsg.style.display = '';
  } else if (noResultsMsg) {
    noResultsMsg.style.display = 'none';
  }
}, 150);

document.getElementById('launchpad-search')?.addEventListener('input', _debouncedLaunchpadSearch);

document.getElementById('launchpad-search')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.toLowerCase().trim();
  if (!q) return;
  const items = Array.from(document.querySelectorAll('.launchpad-item'))
    .filter(item => item.style.display !== 'none');
  if (!items.length) return;
  const target = items.find(item => {
    const name = item.querySelector('.launchpad-name')?.textContent?.toLowerCase() ?? '';
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    return name === q || label === q;
  });
  if (target) target.click();
});

// Close launchpad on backdrop click.
document.getElementById('launchpad')?.addEventListener('click', (e) => {
  if (e.target.id === 'launchpad') toggleLaunchpad();
});

// NOTIFICATION PANEL

document.getElementById('notification-panel')?.addEventListener('click', (e) => {
  if (e.target.id !== 'notification-panel') return;
  e.currentTarget.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('tray-bell')?.addEventListener('click', Notify.togglePanel);

document.getElementById('notif-close')?.addEventListener('click', () => {
  document.getElementById('notification-panel')?.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('notif-mark-all')?.addEventListener('click', () => {
  // Notify.clearAll() preserves pinned entries (like "running in background");
  // bypassing it by assigning OS.notifications = [] would wipe those too and
  // leave a background app running with no way to stop it.
  Notify.clearAll();
  // clearAll() updates Notify's own badge but not this file's separate tray
  // badge element, so call that here too.
  updateNotificationBadge();
});

document.getElementById('notif-mark-read')?.addEventListener('click', () => {
  Notify.markAllRead();
  updateNotificationBadge();
});

function resetShellScrollTwice() {
  if (typeof window.resetShellScroll !== 'function') return;
  window.resetShellScroll();
  requestAnimationFrame(window.resetShellScroll);
}

function updateNotificationBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = (OS.notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

Notify.loadPersisted();
Notify.renderPanel();
Notify.updateBadge();
updateNotificationBadge();

// TRAY — WiFi

const trayWifi = document.getElementById('tray-wifi');
if (trayWifi) {
  trayWifi.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('wifi-popup');
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = 'wifi-popup';
    popup.style.cssText =
      'position:fixed;bottom:60px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--r-md);padding:16px;min-width:200px;z-index:9999;box-shadow:var(--shadow-md)';
    document.body.appendChild(popup);

    // Dismiss on any outside click. Looked up by id inside the handler so
    // reopening the popup doesn't leave stale closures over a removed element.
    document.addEventListener('click', () => {
      document.getElementById('wifi-popup')?.remove();
    }, { once: true });

    const online = navigator.onLine;
    const rect = trayWifi.getBoundingClientRect();
    popup.style.left = Math.max(0, rect.left - 80) + 'px';

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:600;margin-bottom:8px;';
    header.textContent = 'Network';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;';
    const dot = document.createElement('span');
    dot.style.color = online ? 'var(--text-success)' : 'var(--text-danger)';
    dot.textContent = '●';
    const statusText = document.createElement('span');
    statusText.textContent = online ? 'Connected to network' : 'No internet connection';
    row.append(dot, statusText);

    popup.append(header, row);
  });
}

// TRAY — Volume

// Guard all four elements — any one missing would throw on addEventListener.
const volumeBtn = document.getElementById('tray-volume');
const volumePopup = document.getElementById('volume-popup');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');

if (volumeBtn && volumePopup && volumeSlider && volumeValue) {
  let volumePopupPinned = false;

  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = volumeBtn.getBoundingClientRect();
    volumePopup.style.left = rect.left + 'px';
    volumePopup.style.bottom = '60px';
    volumePopup.classList.toggle('active');
  });

  volumeBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    volumePopupPinned = !volumePopupPinned;
  });

  volumeSlider.addEventListener('click', (e) => { e.stopPropagation(); });

  volumeSlider.addEventListener('input', () => {
    // Number() returns NaN for garbage input; parseInt with radix works too but
    // Number() is stricter about rejecting trailing chars. NaN is rejected below.
    const newVolume = Number(volumeSlider.value);
    if (!Number.isFinite(newVolume)) return;

    OS.volume = newVolume;
    volumeValue.textContent = newVolume + '%';
    OS.events?.emit?.('os:volumeChanged', { volume: newVolume });

    if (!OS.windows) return;
    // Clamp and JSON-stringify the volume before injecting it into webview
    // JavaScript. Never build the executed source by concatenating a value
    // directly into it — even one that's "supposed" to be a safe number —
    // because if this pattern gets copied elsewhere with a less-trusted
    // value, it becomes an injection point.
    const safeVolume = Math.min(1, Math.max(0, newVolume / 100));
    const volumeLiteral = JSON.stringify(safeVolume);
    const volumeScript =
      `(function(){var v=${volumeLiteral};` +
      `document.querySelectorAll('audio,video').forEach(function(el){el.volume=v;});})();`;

    for (const state of OS.windows.values()) {
      if (state.appId !== 'browser') continue;
      const webviews = state.element?.querySelectorAll?.('webview');
      if (!webviews) continue;
      for (const webview of webviews) {
        if (typeof webview.executeJavaScript === 'function') {
          // Swallow rejection: an inactive webview rejecting executeJavaScript
          // shouldn't surface as an unhandled promise rejection.
          webview.executeJavaScript(volumeScript).catch(() => {});
        }
      }
    }
  });

  volumePopup.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('click', () => {
    if (!volumePopupPinned) volumePopup.classList.remove('active');
  });
}

// TRAY — Battery

// Track the battery object and its listeners so re-calling updateBattery (e.g.
// after a theme change) doesn't stack duplicate levelchange listeners.
let _batteryWatch = null;

async function updateBattery() {
  const batteryBtn = document.getElementById('tray-battery');
  if (!batteryBtn) return;
  if (!('getBattery' in navigator)) return;

  try {
    const battery = await navigator.getBattery();

    // If we're already watching this same battery object, don't re-subscribe.
    if (_batteryWatch?.battery === battery) return;
    // If we were watching a different one (page reload preserved the getter
    // result but the closure went stale), drop the old listener first.
    if (_batteryWatch) {
      _batteryWatch.battery.removeEventListener('levelchange', _batteryWatch.update);
    }

    const update = () => {
      const level = Math.round(battery.level * 100);
      batteryBtn.textContent = '';
      const span = document.createElement('span');
      span.style.fontSize = '11px';
      span.textContent = `${level}%`;
      batteryBtn.appendChild(span);
    };

    battery.addEventListener('levelchange', update);
    _batteryWatch = { battery, update };
    update();
  } catch { /* getBattery rejected — battery info unavailable, silently ignore */ }
}
updateBattery();

// WINDOW RESIZE

window.addEventListener('resize', throttleRAF(() => {
  if (!OS.windows) return;
  for (const state of OS.windows.values()) {
    if (state.maximized) {
      const area = WM.getWorkArea();
      state.x = area.left; state.y = area.top;
      state.width = area.width; state.height = area.height;
      state.element.style.left = area.left + 'px';
      state.element.style.top = area.top + 'px';
      state.element.style.width = area.width + 'px';
      state.element.style.height = area.height + 'px';
    } else {
      const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
      state.x = next.x; state.y = next.y; state.width = next.w; state.height = next.h;
      state.element.style.left = next.x + 'px';
      state.element.style.top = next.y + 'px';
      state.element.style.width = next.w + 'px';
      state.element.style.height = next.h + 'px';
    }
  }
  WM.hideSnapPreview();
}));

// DESKTOP CONTEXT MENU

const desktopEl = document.getElementById('desktop');
if (desktopEl) {
  desktopEl.addEventListener('pointerdown', (e) => {
    if (
      e.target.closest('.app-window') ||
      e.target.closest('.taskbar') ||
      e.target.closest('.context-menu')
    ) return;
    // Clicking empty desktop defocuses any window and clears focus state.
    if (OS.windows) {
      for (const [, w] of OS.windows) w.element.classList.remove('focused');
    }
    OS.focusedWindowId = null;
    WM.updateTaskbar();
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  desktopEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.desktop-icon')) return;
    e.preventDefault();
    ContextMenu.show(e.clientX, e.clientY, [
      {
        label: 'New File', icon: 'file', action: async () => {
          const name = await showPrompt('New File Name', 'untitled.txt');
          if (!name) return;
          const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
          await FS.createFile(FS.specialFolders.desktop, finalName, '', 'text/plain');
          renderDesktopIcons();
        }
      },
      {
        label: 'New Folder', icon: 'folder', action: async () => {
          const name = await showPrompt('New Folder Name', 'New Folder');
          if (!name) return;
          const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
          await FS.createFolder(FS.specialFolders.desktop, finalName);
          renderDesktopIcons();
        }
      },
      ...(OS.clipboard?.fileId ? [
        { separator: true },
        {
          label: 'Paste', icon: 'paste', action: async () => {
            if (OS.settings?.get?.('disableClipboardPaste')) {
              Notify.show({ title: 'Paste disabled', body: 'Paste disabled.', type: 'error', appName: 'Desktop' });
              return;
            }
            try {
              const clip = OS.clipboard;
              await FS.pasteInto(clip, FS.specialFolders.desktop);
              if (clip.type === 'cut') OS.clipboard = null;
              renderDesktopIcons();
            } catch (err) {
              console.error('[Desktop] paste failed:', err);
              Notify.show({ title: 'Paste failed', body: err?.message || 'Unknown error', type: 'error', appName: 'Desktop' });
            }
          }
        }
      ] : []),
      { separator: true },
      { label: 'Open Terminal', icon: 'terminal', action: () => WM.createWindow('shell') },
      { label: 'Open Settings', icon: 'settings', action: () => WM.createWindow('nook') },
      { separator: true },
      { label: 'Refresh', action: () => renderDesktopIcons() }
    ]);
  });
}

// KEYBOARD SHORTCUTS

document.addEventListener('keydown', (e) => {
  const focused = document.activeElement;
  const inAppContent = focused?.closest?.('.window-content');
  const alwaysAllow =
    (e.altKey && (e.key === 'F4' || e.key === 'Tab')) ||
    e.key === 'Escape' || e.key === 'PrintScreen';

  // Don't hijack editor-style shortcuts when the user is typing inside an app.
  if (inAppContent && !alwaysAllow) {
    const conflicting = (e.ctrlKey || e.metaKey) && [
      'l', 'L', 'e', 'E', 'd', 'D', 'c', 'C', 'u', 'U', 'a', 'A',
      ' ', 'ArrowLeft', 'ArrowRight'
    ].includes(e.key);
    if (conflicting) return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'e') { e.preventDefault(); WM.createWindow('vault'); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't') { e.preventDefault(); WM.createWindow('shell'); }
  if ((e.metaKey || e.ctrlKey) && e.key === ' ') { e.preventDefault(); toggleLaunchpad(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') { e.preventDefault(); lockScreen(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); WM.minimizeAll(); }
  if (e.key === 'PrintScreen' && !e.altKey) { e.preventDefault(); captureScreenshot('desktop'); }
  if (e.altKey && e.key === 'PrintScreen') { e.preventDefault(); captureScreenshot('window'); }
  if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault(); captureScreenshot('region');
  }
  if (e.altKey && e.key === 'F4') {
    e.preventDefault();
    if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId);
  }
  if (e.altKey && e.key === 'Tab') { e.preventDefault(); showAppSwitcher(); }

  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
  }

  if (e.key === 'Escape') {
    if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
    ContextMenu.hide();
  }

  // F3 toggles the debug overlay only; devMode setting is unchanged.
  if (e.key === 'F3') {
    e.preventDefault();
    window.DebugOverlay?.toggle?.();
  }

  // Ctrl+Shift+D copies the debug overlay text to the clipboard.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (window.DebugOverlay?._copyDebugInfo) {
      window.DebugOverlay._copyDebugInfo();
      Notify.show({ title: 'Debug Info Copied', body: 'Overlay text copied to clipboard', type: 'success' });
    }
  }
});

// SCREENSHOT

// Lets the user drag out a rectangle over a still image of the captured
// frame. Resolves to {x, y, width, height} in the image's own pixel space,
// or null if the user cancels (Escape / right-click).
function _promptRegionSelect(frameCanvas) {
  return new Promise((resolve) => {
    const scale = Math.min(
      (window.innerWidth * 0.9) / frameCanvas.width,
      (window.innerHeight * 0.9) / frameCanvas.height,
      1
    );
    const dispW = frameCanvas.width * scale;
    const dispH = frameCanvas.height * scale;

    const overlay = createEl('div', {
      id: 'screenshot-region-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:99999;cursor:crosshair;user-select:none;'
    });

    const frame = createEl('div', {
      style: `position:relative;width:${dispW}px;height:${dispH}px;box-shadow:0 0 0 1px rgba(255,255,255,0.2);`
    });
    const img = createEl('img', { style: 'width:100%;height:100%;display:block;pointer-events:none;' });
    img.src = frameCanvas.toDataURL('image/png');

    const selectionBox = createEl('div', {
      style: 'position:absolute;border:2px solid var(--accent, #3b82f6);background:rgba(59,130,246,0.15);display:none;pointer-events:none;'
    });

    const hint = createEl('div', {
      textContent: 'Drag to select a region · Esc to cancel',
      style: 'position:absolute;top:-32px;left:0;color:#fff;font-size:12px;font-family:var(--font-ui, sans-serif);opacity:0.85;'
    });

    frame.append(img, selectionBox, hint);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    let startX = 0, startY = 0, dragging = false;
    let settled = false;

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const rect = frame.getBoundingClientRect();
      startX = clamp(e.clientX - rect.left, 0, dispW);
      startY = clamp(e.clientY - rect.top, 0, dispH);
      dragging = true;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${w}px`;
      selectionBox.style.height = `${h}px`;
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);

      // Too small to be intentional — treat as a click, keep waiting rather
      // than resolving with an empty region.
      if (w < 4 || h < 4) {
        selectionBox.style.display = 'none';
        return;
      }

      finish({
        x: Math.round(left / scale),
        y: Math.round(top / scale),
        width: Math.round(w / scale),
        height: Math.round(h / scale),
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    const onContextMenu = (e) => { e.preventDefault(); finish(null); };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
  });
}

// Finds the "Screenshots" subfolder inside Pictures, creating it once if it
// doesn't exist yet. Cached after the first successful lookup/creation so
// repeated screenshots don't re-scan Pictures' contents every time.
let _screenshotsFolderId = null;

async function _getOrCreateScreenshotsFolder() {
  if (_screenshotsFolderId && FS.files?.has(_screenshotsFolderId)) {
    return _screenshotsFolderId;
  }

  const picturesId = FS.specialFolders?.pictures;
  if (!picturesId) return null;

  const existing = FS.listDir(picturesId)
    .find(f => f.type === 'folder' && f.name === 'Screenshots');

  if (existing) {
    _screenshotsFolderId = existing.id;
    return existing.id;
  }

  const created = await FS.createFolder(picturesId, 'Screenshots');
  _screenshotsFolderId = created.id;
  return created.id;
}

async function captureScreenshot(mode) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: mode === 'window' ? 'window' : 'monitor' }
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext('2d').drawImage(video, 0, 0);

    // The stream is only needed to grab one frame — release it immediately
    // so the screen-capture indicator goes away while the user drags out a
    // region selection.
    stream.getTracks().forEach(t => t.stop());
    stream = null;

    let outputCanvas = fullCanvas;

    if (mode === 'region') {
      const region = await _promptRegionSelect(fullCanvas);
      if (!region) return; // user cancelled — not an error
      const cropped = document.createElement('canvas');
      cropped.width = region.width;
      cropped.height = region.height;
      cropped.getContext('2d').drawImage(
        fullCanvas,
        region.x, region.y, region.width, region.height,
        0, 0, region.width, region.height
      );
      outputCanvas = cropped;
    }

    const dataUrl = outputCanvas.toDataURL('image/png');
    const base64 = _dataUrlToBase64(dataUrl);

    const screenshotsId = await _getOrCreateScreenshotsFolder();
    if (!screenshotsId) throw new Error('Pictures folder not found');

    // Use FS.uniqueName so two screenshots taken in the same millisecond
    // don't collide and silently overwrite each other.
    const name = FS.uniqueName(screenshotsId, `screenshot-${Date.now()}.png`);
    await FS.createFile(screenshotsId, name, base64, 'image/png');

    Notify.show({ title: 'Screenshot Saved', body: `Saved to Pictures/Screenshots as ${name}`, type: 'success', appName: 'System' });
    EventLog?.log?.({ app: 'System', category: 'system', severity: 'info', message: `Screenshot captured (${mode})`, data: { mode, name } });
  } catch (err) {
    Notify.show({ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' });
    EventLog?.log?.({ app: 'System', category: 'system', severity: 'error', message: `Screenshot capture failed (${mode}): ${err?.message || err}`, data: { mode } });
  } finally {
    // Always stop tracks — never leave the screen-capture indicator dangling,
    // even if play() or drawImage() threw above.
    stream?.getTracks().forEach(t => t.stop());
  }
}

// VIRTUAL DESKTOPS

function switchWorkspace(direction) {
  if (!OS.workspaces || OS.workspaces.length === 0) return;
  const currentIdx = OS.workspaces.findIndex(w => w.id === OS.currentWorkspace);
  const newIdx = currentIdx + direction;

  if (newIdx >= 0 && newIdx < OS.workspaces.length) {
    OS.currentWorkspace = OS.workspaces[newIdx].id;
  } else if (newIdx >= OS.workspaces.length && OS.workspaces.length < MAX_WORKSPACES) {
    const newWs = { id: Date.now(), name: `Workspace ${OS.workspaces.length + 1}` };
    OS.workspaces.push(newWs);
    OS.currentWorkspace = newWs.id;
    EventLog?.log?.({ app: 'System', category: 'window', severity: 'info', message: `Created ${newWs.name}`, data: { workspaceId: newWs.id } });
  }
}

// APP SWITCHER

let switcherActive = false;
let switcherIdx = 0;

function showAppSwitcher() {
  if (!OS.windows) return;
  const windows = Array.from(OS.windows.values());
  if (windows.length === 0) return;

  switcherActive = true;
  switcherIdx = 0;

  const switcher = document.getElementById('app-switcher');
  const list = document.getElementById('app-switcher-list');
  if (!switcher || !list) return;
  list.innerHTML = '';

  windows.forEach((w, i) => {
    const app = OS.apps?.[w.appId];
    if (!app) return;
    const item = createEl('div', { className: 'app-switcher-item' + (i === 0 ? ' active' : '') });
    const icon = createEl('div', { className: 'app-switcher-icon' });
    icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 32);
    item.appendChild(icon);
    item.appendChild(createEl('div', { className: 'app-switcher-name', textContent: app.name }));
    list.appendChild(item);
  });

  switcher.classList.add('active');
}

function hideAppSwitcher() {
  document.getElementById('app-switcher')?.classList.remove('active');
  switcherActive = false;
}

document.addEventListener('keyup', (e) => {
  if (!switcherActive || e.key !== 'Alt') return;
  hideAppSwitcher();
  if (!OS.windows) return;
  const windows = Array.from(OS.windows.values());
  if (windows[switcherIdx]) WM.focusWindow(windows[switcherIdx].id);
});

// LOCK SCREEN

function handleLockScreenKeydown(e) {
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl?.classList.contains('active')) {
    document.removeEventListener('keydown', handleLockScreenKeydown);
    return;
  }
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); enterPinDigit(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); backspacePin(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (enteredPin.length === 4) verifyPin(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearPin(); }
}

function lockScreen() {
  if (!OS.lockPin) { WM.minimizeAll(); return; }
  OS.isLocked = true;
  document.getElementById('lock-screen')?.classList.add('active');
  renderLockScreen();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
}

let enteredPin = '';

function renderLockScreen() {
  const usernameEl = document.getElementById('lock-username');
  const dotsEl = document.getElementById('lock-pin-dots');
  const statusEl = document.getElementById('lock-status');
  const numpadEl = document.getElementById('lock-numpad');
  if (!usernameEl || !dotsEl || !statusEl || !numpadEl) return;

  usernameEl.textContent = OS.username || '';
  dotsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
  }
  statusEl.textContent = '';
  numpadEl.innerHTML = '';

  for (let i = 1; i <= 9; i++) {
    const btn = createEl('button', { textContent: String(i), 'aria-label': String(i) });
    btn.addEventListener('click', () => enterPinDigit(String(i)));
    numpadEl.appendChild(btn);
  }
  const clearBtn = createEl('button', { textContent: 'C', 'aria-label': 'Clear' });
  clearBtn.addEventListener('click', clearPin);
  numpadEl.appendChild(clearBtn);

  const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
  zeroBtn.addEventListener('click', () => enterPinDigit('0'));
  numpadEl.appendChild(zeroBtn);

  const backBtn = createEl('button', { 'aria-label': 'Backspace' });
  backBtn.innerHTML = svgIcon('chevron-left', 18);
  backBtn.addEventListener('click', backspacePin);
  numpadEl.appendChild(backBtn);

  // Biometric unlock button — added once per lock screen mount.
  if (window.PublicKeyCredential && OS.settings.get('biometricCredentialId')) {
    const lockScreenEl = document.getElementById('lock-screen');
    if (lockScreenEl && !lockScreenEl.querySelector('.biometric-btn')) {
      const bioBtn = createEl('button', {
        className: 'biometric-btn',
        style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
      });
      bioBtn.textContent = '👆 Use Biometric';
      bioBtn.addEventListener('click', () => attemptBiometricUnlock(statusEl));
      numpadEl.parentNode?.appendChild(bioBtn);
    }
  }

  enteredPin = '';
  updatePinDots();
  // Remove before re-adding so re-renders don't stack keydown listeners.
  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
}

async function attemptBiometricUnlock(statusEl) {
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) { statusEl.textContent = 'Biometric not available on this device'; return; }
    statusEl.textContent = 'Waiting for biometric...';

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = OS.settings.get('biometricCredentialId');
    // Uint8Array.fromBase64() (ES2026) replaces the legacy atob() + char-code
    // dance. Feature-detect and fall back to atob() for older browsers.
    const credBytes = Uint8Array.fromBase64
      ? Uint8Array.fromBase64(credentialId)
      : Uint8Array.from(atob(credentialId), c => c.charCodeAt(0));

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credBytes, type: 'public-key' }],
        userVerification: 'required'
      }
    });
    if (credential) {
      unlockFromLockScreen();
      Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
    }
  } catch (err) {
    statusEl.textContent = 'Biometric failed: ' + (err?.message || 'Try PIN instead');
  }
}

function unlockFromLockScreen() {
  OS.isLocked = false;
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen unlocked' });

  // Cancel any pending wipe countdown — biometric auth must be able to abort it.
  if (_wipeCountdownId) {
    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
  }

  document.getElementById('lock-screen')?.classList.remove('active');
  document.removeEventListener('keydown', handleLockScreenKeydown);
  enteredPin = '';

  WM.updateTaskbar();
  requestAnimationFrame(() => { renderDesktopIcons(); WM.updateTaskbar(); });
}

function enterPinDigit(d) {
  if (enteredPin.length >= 4) return;
  enteredPin += d;
  updatePinDots();
  if (enteredPin.length === 4) verifyPin();
}

function clearPin() {
  enteredPin = '';
  updatePinDots();
  document.getElementById('lock-status').textContent = '';
}

function backspacePin() {
  enteredPin = enteredPin.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  document.querySelectorAll('.lock-pin-dot').forEach((dot, i) =>
    dot.classList.toggle('filled', i < enteredPin.length)
  );
}

async function verifyPin() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;

  // Enforce lockout before touching the hash worker — the original code set
  // OS.lockoutUntil but never checked it at entry, so a caller could keep
  // submitting PINs indefinitely during the lockout window.
  if (OS.lockoutUntil && Date.now() < OS.lockoutUntil) {
    const remaining = Math.ceil((OS.lockoutUntil - Date.now()) / 1000);
    statusEl.textContent = `Locked out. Try again in ${remaining}s`;
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `PIN attempt blocked — lockout active (${remaining}s remaining)` });
    return;
  }

  statusEl.textContent = 'Verifying...';

  let hash;
  try {
    if (!OS.workers?.crypto?.call) throw new Error('crypto worker unavailable');
    if (typeof getPinSalt !== 'function') throw new Error('PIN salt provider unavailable');
    hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());
  } catch (err) {
    statusEl.textContent = 'Verification unavailable: ' + (err?.message || 'try again');
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: `PIN verification failed: ${err?.message || err}` });
    return;
  }

  if (hash === OS.lockPin) {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    unlockFromLockScreen();
    return;
  }

  // Wrong PIN — escalate lockout based on attempt count.
  OS.wrongPinCount++;
  enteredPin = '';
  updatePinDots();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `Incorrect PIN entered (attempt ${OS.wrongPinCount})`, data: { wrongPinCount: OS.wrongPinCount } });

  const THRESHOLD = 3;
  const DURATION_MS = 30_000;

  if (OS.wrongPinCount >= THRESHOLD && OS.wrongPinCount < THRESHOLD * 2) {
    applyLockout(statusEl, DURATION_MS);
  } else if (OS.wrongPinCount >= THRESHOLD * 2 && OS.wrongPinCount < 10) {
    applyLockout(statusEl, DURATION_MS * 5);
  } else if (OS.wrongPinCount >= 10) {
    triggerSecurityWipe(statusEl);
  } else {
    statusEl.textContent = 'Incorrect PIN';
  }
}

// Shared lockout path for both the standard and extended windows. Starts a
// timer that clears the count once the window expires.
function applyLockout(statusEl, durationMs) {
  const sec = Math.round(durationMs / 1000);
  const label = sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
  statusEl.textContent = `Too many attempts. ${label} lockout.`;
  OS.lockoutUntil = Date.now() + durationMs;
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'warn',
    message: `Lockout triggered (${label}) after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount, durationMs }
  });
  setTimeout(() => {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    statusEl.textContent = '';
  }, durationMs);
}

// Ten or more failed attempts triggers a 10-second countdown to a full local
// wipe. Biometric unlock can still cancel it via unlockFromLockScreen().
function triggerSecurityWipe(statusEl) {
  statusEl.textContent = 'Security alert! Data will be wiped.';
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'error',
    message: `Security wipe countdown started after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount }
  });

  let countdown = 10;
  _wipeCountdownId = setInterval(() => {
    countdown--;
    statusEl.textContent = `Security alert! Wiping in ${countdown}s`;
    if (countdown > 0) return;

    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
    localStorage.clear();
    sessionStorage.clear();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: 'Security wipe executed — all local data cleared' });
    Notify.show({
      title: 'Security Wipe',
      body: 'All data has been wiped due to too many failed attempts.',
      type: 'error', appName: 'System'
    });
    setTimeout(() => location.reload(), 2000);
  }, 1000);
}

// IDLE LOCK

let lastActivity = Date.now();
const _resetIdleTimer = () => { lastActivity = Date.now(); };
['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, _resetIdleTimer, { passive: true });
});

setInterval(() => {
  // Truthy check on idleTimeout guards against undefined/0/null — without it,
  // an unset idleTimeout would compare NaN < Infinity (false) and never lock,
  // but a 0 would lock on the very first tick.
  if (OS.lockPin && !OS.isLocked && OS.idleTimeout && OS.idleTimeout < Infinity) {
    if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
  }
}, 30_000);

// FILE THREAT SCANNING

/**
 * Check a filename's extension against a blocked list.
 * @param {string} filename
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function checkFileExtension(filename) {
  if (!filename || typeof filename !== 'string') return { blocked: false, reason: null };
  const parts = filename.split('.');
  if (parts.length < 2) return { blocked: false, reason: null };

  const ext = parts.pop().toLowerCase();
  // Edge case: a filename like ".exe" — the "extension" is the whole name.
  if (!parts.join('')) return { blocked: false, reason: null };

  const BLOCKED = new Set(['exe', 'dll', 'scr', 'msi', 'com', 'pif', 'vbs', 'vbe', 'wsf', 'wsh']);
  if (BLOCKED.has(ext)) {
    return { blocked: true, reason: `Blocked: ${ext.toUpperCase()} files cannot be added (executable type)` };
  }
  return { blocked: false, reason: null };
}

/**
 * Scan file content for known-malicious patterns.
 * @param {string} content
 * @param {string} [_filename] — reserved, unused
 * @returns {{ isMalicious: boolean, threats: Array, patterns: Array }}
 */
function scanFileForThreats(content, _filename) {
  if (!content || typeof content !== 'string' || content.length === 0) {
    return { isMalicious: false, threats: [], patterns: [] };
  }

  const threats = [];
  const patterns = [];

  // _THREAT_PATTERNS uses no /g flag — .test() result is always correct.
  for (const { regex, name, severity } of _THREAT_PATTERNS) {
    if (regex.test(content)) {
      patterns.push(name);
      threats.push({ type: name, severity });
    }
  }

  return { isMalicious: patterns.length > 0, threats, patterns };
}

// RECOVERY MODE

function triggerRecovery(reason) {
  if (document.body.classList.contains('os-booted')) return false;

  const KEY = 'nova_boot_attempts';
  const attempts = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  })();

  attempts.push({ ts: Date.now(), reason: reason || 'unknown', ua: navigator.userAgent.slice(0, 80) });
  if (attempts.length > 10) attempts.shift();
  try {
    localStorage.setItem(KEY, JSON.stringify(attempts));
  } catch { /* quota exceeded — keep going without persisting */ }

  EventLog?.log?.({
    app: 'System', category: 'system', severity: 'error',
    message: `Boot failure detected: ${reason || 'unknown'} (attempt ${attempts.length})`,
    data: { reason, attemptCount: attempts.length }
  });

  if (attempts.length >= 2) {
    showRecoveryScreen(attempts, false);
    return true;
  }
  return false;
}

// Listen for syntax errors during boot and route to recovery. Errors from
// scripts under /js/apps/ are skipped — those are loaded lazily and a single
// broken app shouldn't put the whole OS into recovery.
window.addEventListener('error', (e) => {
  if (document.body.classList.contains('os-booted')) return;
  const msg = e.message || '';
  if (!msg.includes('SyntaxError') && !msg.includes('Unexpected token')) return;

  const target = e.target;
  const src = target?.src || e.filename || '';
  if (src.includes('/js/apps/') || src.includes('\\js\\apps\\')) {
    console.warn('[Boot] App syntax error skipped from recovery:', src, msg);
    return;
  }
  console.error('[BOOT] Syntax error detected:', msg);
  triggerRecovery('syntax_error: ' + msg.slice(0, 100));
});

function showRecoveryScreen(priorAttempts, isManual) {
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) bootScreen.style.display = 'none';

  const anim = document.createElement('div');
  anim.id = 'recovery-boot-anim';
  anim.innerHTML = `
    <div class="rba-scanlines"></div>
    <div class="rba-glow"></div>
    <div class="rba-content">
      <div class="rba-logo-wrap">
        <div class="rba-logo-ring"></div>
        <div class="rba-logo-ring-2"></div>
        <div class="rba-logo-hex">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <polygon points="18,3 33,10.5 33,25.5 18,33 3,25.5 3,10.5"
              fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>
            <text x="18" y="23" text-anchor="middle" font-size="13"
              font-weight="700" fill="#ffd700" font-family="monospace">NB</text>
          </svg>
        </div>
      </div>
      <div class="rba-title">NovaByte</div>
      <div class="rba-subtitle">⚠ Recovery Mode</div>
      <div class="rba-log" id="rba-log"></div>
      <div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>
      <div class="rba-status" id="rba-status">Initializing recovery environment…</div>
    </div>`;
  document.body.appendChild(anim);

  const rbaLog = document.getElementById('rba-log');
  const rbaBar = document.getElementById('rba-bar');
  const rbaStatus = document.getElementById('rba-status');
  let step = 0;

  const steps = isManual ? [
    { msg: '[ RECOVERY MODE ]',                            cls: 'info', pct: 8,   label: 'Loading recovery kernel…'   },
    { msg: '✓ Recovery environment loaded',                cls: 'ok',   pct: 22,  label: 'Mounting storage…'          },
    { msg: '✓ localStorage integrity check…',              cls: 'ok',   pct: 38,  label: 'Checking data…'             },
    { msg: 'Entering recovery — requested manually',       cls: 'info', pct: 60,  label: 'Preparing interface…'       },
    { msg: '✓ Recovery UI ready',                          cls: 'ok',   pct: 88,  label: 'Almost ready…'              },
    { msg: '✓ Handoff to Recovery Environment',            cls: 'info', pct: 100, label: 'Done.'                      },
  ] : [
    { msg: '[ RECOVERY MODE TRIGGERED ]',                 cls: 'warn', pct: 8,   label: 'Loading recovery kernel…'   },
    { msg: '✓ Recovery environment loaded',                cls: 'ok',   pct: 22,  label: 'Mounting storage…'          },
    { msg: '✓ localStorage integrity check…',              cls: 'ok',   pct: 38,  label: 'Checking data…'             },
    { msg: '⚠ Boot failure detected — entering recovery',  cls: 'warn', pct: 60,  label: 'Preparing interface…'       },
    { msg: '✓ Recovery UI ready',                          cls: 'ok',   pct: 88,  label: 'Almost ready…'              },
    { msg: '✓ Handoff to Recovery Environment',            cls: 'info', pct: 100, label: 'Done.'                      },
  ];

  function runStep() {
    if (step >= steps.length) {
      setTimeout(() => {
        anim.classList.add('fade-out');
        setTimeout(() => { anim.remove(); }, 650);
        _doShowRecoveryScreen(priorAttempts, isManual);
      }, 300);
      return;
    }
    const s = steps[step++];
    rbaBar.style.width = s.pct + '%';
    rbaStatus.textContent = s.label;
    const line = document.createElement('div');
    line.className = 'rba-log-line ' + (s.cls || '');
    line.textContent = s.msg;
    rbaLog.appendChild(line);
    rbaLog.scrollTop = rbaLog.scrollHeight;
    setTimeout(runStep, step === 1 ? 250 : 320);
  }
  setTimeout(runStep, 180);
}

function _doShowRecoveryScreen(priorAttempts, isManual) {
  const recoveryScreenEl = document.getElementById('recovery-screen');
  if (!recoveryScreenEl) return;
  recoveryScreenEl.classList.add('active');

  // isManual is passed in explicitly from showRecoveryScreen() because boot.js
  // has already cleared nova_manual_recovery / nova_show_recovery by the time
  // this runs — re-reading those flags here always returned false, so the
  // manual-recovery banner never actually applied.
  isManual = !!isManual;

  const attemptCountEl = document.getElementById('rec-attempt-count');
  const attemptAlertEl = document.querySelector('.recovery-alert');
  if (isManual && attemptAlertEl) {
    attemptAlertEl.style.display = 'none';
    if (attemptCountEl) attemptCountEl.textContent = '0';
  } else if (attemptCountEl) {
    attemptCountEl.textContent = String(priorAttempts.length);
  }

  const now = new Date();
  const tsEl = document.getElementById('rec-timestamp');
  if (tsEl) tsEl.textContent = now.toLocaleString();
  const footerTimeEl = document.getElementById('rec-footer-time');
  if (footerTimeEl) footerTimeEl.textContent = now.toLocaleTimeString();

  // Cancel any leaked clock timer from a prior call before starting a new one.
  if (_recoveryClockId) clearInterval(_recoveryClockId);
  _recoveryClockId = setInterval(() => {
    const el = document.getElementById('rec-footer-time');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString();
  }, 1000);

  // Diagnostics log.
  const diagEl = document.getElementById('rec-diag-lines');
  const log = (msg, cls = '') => {
    if (!diagEl) return;
    const line = document.createElement('div');
    line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
    line.textContent = msg;
    diagEl.appendChild(line);
  };

  log('[ NovaByte Recovery Environment ]', 'info');
  log('');
  if (!isManual) {
    log('Boot failure analysis:', 'warn');
    priorAttempts.slice(-5).forEach((a, i) => {
      log(`  Attempt ${i + 1}: ${new Date(a.ts).toLocaleTimeString()}`, 'err');
    });
    log('');
  } else {
    log('Recovery mode initialized (Manual boot)', 'info');
    log('');
  }

  log('Scanning storage...', 'info');
  try {
    const lsKeys = Object.keys(localStorage);
    log(`  localStorage: ${lsKeys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
    ['nova_settings', 'nova_boot_attempts'].forEach(k => {
      const val = localStorage.getItem(k);
      log(val ? `  ✓ ${k}: ${val.length} chars` : `  ✗ ${k}: not found`, val ? 'ok' : 'warn');
    });
  } catch (err) {
    log('  ! localStorage read error: ' + err?.message, 'err');
  }

  log('');
  const hasSettings = !!localStorage.getItem('nova_settings');
  log(`  Settings key present: ${hasSettings ? 'YES' : 'NO'}`, hasSettings ? 'ok' : 'warn');
  log('');
  if (!isManual) {
    log('Recommendation: Try "Continue" first.', 'info');
    log('If it fails again, use Safe Mode or', 'info');
    log('"Reset Settings" to restore stability.', 'info');
  } else {
    log('Select any recovery option as needed.', 'info');
  }

  // Countdown auto-boot.
  let countdown = 15;
  let countdownStopped = false;
  const cdownNum = document.getElementById('rec-cdown-num');
  const cdownBar = document.getElementById('rec-cdown-bar');
  const cdownBlock = document.getElementById('rec-countdown-block');

  function stopCountdown() {
    countdownStopped = true;
    if (cdownBlock) {
      cdownBlock.style.opacity = '0.4';
      const ctext = cdownBlock.querySelector('.recovery-countdown-text');
      if (ctext) ctext.textContent = 'Auto-boot cancelled';
    }
    if (cdownBar) { cdownBar.style.transition = 'none'; cdownBar.style.width = '0%'; }
  }

  wireRecoveryControls(recoveryScreenEl);
  if (typeof initRecoveryUI === 'function') initRecoveryUI();

  if (isManual) {
    stopCountdown();
  } else {
    // Track at module scope so a second call to _doShowRecoveryScreen can't
    // leave the previous countdown running.
    if (_recoveryCountdownId) clearInterval(_recoveryCountdownId);
    _recoveryCountdownId = setInterval(() => {
      if (countdownStopped) { clearInterval(_recoveryCountdownId); _recoveryCountdownId = 0; return; }
      countdown--;
      if (cdownNum) cdownNum.textContent = String(countdown);
      if (cdownBar) cdownBar.style.width = ((countdown / 15) * 100) + '%';
      if (countdown <= 0) {
        clearInterval(_recoveryCountdownId);
        _recoveryCountdownId = 0;
        if (typeof recoveryAction === 'function') recoveryAction('continue');
      }
    }, 1000);

    ['click', 'keydown', 'mousemove'].forEach(ev => {
      document.addEventListener(ev, () => { if (!countdownStopped) stopCountdown(); }, { once: true });
    });
  }
}

// Wires up click handling for the recovery screen. Accepts the screen element
// explicitly — the original code used the bare identifier `screen` which
// JavaScript resolved to window.screen (a Screen object, not a DOM element),
// so screen.dataset was always undefined and screen.querySelectorAll threw.
function wireRecoveryControls(screenEl) {
  if (!screenEl || screenEl.dataset.recoveryWired === '1') return;
  screenEl.dataset.recoveryWired = '1';

  const ACTION_MAP = {
    'continue': 'continue', 'boot': 'boot', 'boot normal': 'boot-normal',
    'normal boot': 'boot-normal', 'safe mode': 'safemode', 'boot safe': 'boot-safe',
    'boot to safe mode': 'boot-safe', 'minimal mode': 'boot-minimal',
    'boot minimal': 'boot-minimal', 'boot recovery': 'boot-recovery',
    'boot to recovery': 'boot-recovery', 'reset settings': 'reset-settings',
    'clear cache': 'clear-cache', 'clear data': 'wipe-user-data',
    'factory reset': 'factory', 'console': 'console', 'terminal': 'console',
    'file manager': 'file-manager', 'settings editor': 'settings-editor',
    'storage analyzer': 'storage-analyzer', 'event log': 'event-log', 'back': 'back'
  };

  // Functions that recovery buttons can invoke directly via data-action. Kept
  // explicit so a stray data-action attribute can never reach eval, Function,
  // or other dangerous globals — defense in depth even though the recovery
  // UI HTML itself is trusted.
  const GLOBAL_FN_ALLOWLIST = new Set([
    'recoveryAction', 'recNav', 'recGoBack', 'initRecoveryUI',
  ]);

  function switchRecoveryTab(tabName) {
    const tab = String(tabName || '').trim().toLowerCase();
    if (!tab) return false;
    screenEl.querySelectorAll('.recovery-tab').forEach(btn => {
      const btnTab = (btn.dataset.tab || btn.dataset.switchtab || '').trim().toLowerCase();
      btn.classList.toggle('active', btnTab === tab);
      btn.setAttribute('aria-selected', String(btnTab === tab));
    });
    screenEl.querySelectorAll('.recovery-tab-panel').forEach(panel => {
      const panelId = (panel.id || '').replace(/^tab-/, '').trim().toLowerCase();
      panel.classList.toggle('active', panelId === tab);
    });
    return true;
  }

  screenEl.addEventListener('click', (e) => {
    const t = e.target.closest(
      'button,[role="button"],[data-fn],[data-action],[data-recovery-action],' +
      '.recovery-tab,.recovery-option,.rec-btn,.rec-breadcrumb-item'
    );
    if (!t || !screenEl.contains(t)) return;

    const dataAction = (t.dataset.recoveryAction || t.dataset.action || t.dataset.fn || '').trim();
    const label = (t.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const action = dataAction || ACTION_MAP[label] || ACTION_MAP[label.replace(/\s*\(.*?\)\s*$/g, '')];
    const tabName = (t.dataset.tab || t.dataset.switchtab || '').trim().toLowerCase();

    if (t.classList.contains('recovery-tab') && tabName) {
      e.preventDefault(); e.stopPropagation(); switchRecoveryTab(tabName); return;
    }
    if (t.dataset.page && typeof recNav === 'function') {
      e.preventDefault(); e.stopPropagation(); recNav(t.dataset.page); return;
    }
    if (dataAction && GLOBAL_FN_ALLOWLIST.has(dataAction) && typeof window[dataAction] === 'function') {
      e.preventDefault(); e.stopPropagation();
      window[dataAction](t.dataset.arg || t.dataset.value || t.dataset.page); return;
    }
    if (action === 'back' && typeof recGoBack === 'function') {
      e.preventDefault(); e.stopPropagation(); recGoBack(); return;
    }
    if (action) {
      e.preventDefault(); e.stopPropagation();
      if (typeof recoveryAction === 'function') recoveryAction(action);
    }
  }, true);
}

// SNAKE GAME — Easter egg (click NovaByte version label 7× in About)

function launchSnakeGame() {
  if (document.getElementById('snake-game-overlay')) return;

  const COLS = 20, ROWS = 20, CELL = 18;
  const W = COLS * CELL, H = ROWS * CELL;

  const overlay = createEl('div', {
    id: 'snake-game-overlay',
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
  });
  const win = createEl('div', {
    style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
  });

  const titleBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
  });
  const titleText = createEl('span', {
    textContent: '🐍 NovaByte Snake',
    style: 'font-size:13px;font-weight:600;color:var(--text-primary);'
  });
  const closeBtn = createEl('button', {
    textContent: '✕',
    'aria-label': 'Close',
    style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
  });
  titleBar.append(titleText, closeBtn);

  const scoreBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
  });
  const scoreLabel = createEl('span', { textContent: 'Score: 0' });
  const hintLabel = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
  scoreBar.append(scoreLabel, hintLabel);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.display = 'block';
  canvas.setAttribute('aria-label', 'Snake game canvas');
  const ctx = canvas.getContext('2d');

  win.append(titleBar, scoreBar, canvas);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  let snake, dir, nextDir, food, score, gameLoop;
  const rand = (n) => Math.floor(Math.random() * n);

  function spawnFood() {
    let pos;
    do { pos = { x: rand(COLS), y: rand(ROWS) }; }
    while (snake.some(s => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function init() {
    const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
    snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
    dir = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    food = spawnFood();
    score = 0;
    scoreLabel.textContent = 'Score: 0';
    canvas.parentElement?.querySelector('.snake-game-over')?.remove();
  }

  function draw() {
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 0.5;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, H); ctx.stroke(); }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke(); }

    const fx = food.x * CELL + CELL / 2, fy = food.y * CELL + CELL / 2, fr = CELL / 2 - 2;
    const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
    foodGrad.addColorStop(0, '#ff6e6e');
    foodGrad.addColorStop(1, '#f85149');
    ctx.fillStyle = foodGrad;
    ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

    snake.forEach((seg, i) => {
      const x = seg.x * CELL + 1, y = seg.y * CELL + 1, s = CELL - 2;
      const t = i / (snake.length - 1 || 1);
      const r = Math.round(88 + (63 - 88) * t);
      const g = Math.round(166 + (190 - 166) * t);
      const b = Math.round(255 + (90 - 255) * t);
      ctx.fillStyle = i === 0 ? '#79b8ff' : `rgb(${r},${g},${b})`;
      ctx.beginPath(); ctx.roundRect(x, y, s, s, i === 0 ? 5 : 3); ctx.fill();
      if (i === 0) {
        ctx.fillStyle = '#07090f';
        const ex = x + (dir.x >= 0 ? s - 4 : 3);
        const ey = y + (dir.y >= 0 ? 3 : s - 4);
        ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  function gameOver() {
    if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
    const goDiv = createEl('div', { className: 'snake-game-over' });
    const goTitle = createEl('div', { className: 'snake-game-over-title', textContent: 'Game Over' });
    const goScore = createEl('div', { className: 'snake-game-over-score', textContent: `Score: ${score}` });
    const goBtn = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
    goBtn.addEventListener('click', () => { goDiv.remove(); startGame(); });
    goDiv.append(goTitle, goScore, goBtn);
    const wrap = canvas.parentElement;
    if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(goDiv); }
  }

  function step() {
    dir = { ...nextDir };
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) { gameOver(); return; }
    if (snake.some(s => s.x === head.x && s.y === head.y)) { gameOver(); return; }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score++;
      scoreLabel.textContent = `Score: ${score}`;
      food = spawnFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function startGame() {
    // Defensive: if a previous loop somehow survived (e.g. a startGame call
    // without a gameOver), clear it before starting a new one so we don't
    // end up with two intervals stepping the same snake.
    if (gameLoop) clearInterval(gameLoop);
    init();
    draw();
    gameLoop = setInterval(step, 120);
  }

  function onKey(e) {
    // _SNAKE_DIR_MAP is a module-level frozen constant — zero allocation per keypress.
    const nd = _SNAKE_DIR_MAP[e.key];
    if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) {
      e.preventDefault();
      nextDir = nd;
    }
  }

  document.addEventListener('keydown', onKey);

  // Single cleanup path: clear the loop and drop the keydown listener, then
  // remove the overlay. Both close paths (button + backdrop click) use it.
  const cleanup = () => {
    if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
    document.removeEventListener('keydown', onKey);
  };
  closeBtn.addEventListener('click', () => { cleanup(); overlay.remove(); });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { cleanup(); overlay.remove(); }
  });

  startGame();
}

// BACKGROUND EMAIL BOOTSTRAP — silent startup sync.
// Wrapped in try/catch so a failure in the email service can't break the
// rest of the shell's boot wiring.
try {
  const bg = window.__NBOSP_BG = window.__NBOSP_BG || {};
  if (!bg.email?.__patchedStartup) {
    const svc = bg.email = bg.email || {};
    svc.__patchedStartup = true;
    svc.ensureBooted?.();
  }
} catch { /* email service unavailable — silent */ }

OS.events?.on?.('settings:changed', ({ key }) => {
  if (key !== 'devMode') return;
  if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
  WM?.updateTaskbar?.();
});

// Kick off the OS boot sequence. Guarded so a missing boot() surfaces a clear
// error instead of an unhandled ReferenceError.
if (typeof boot === 'function') {
  boot();
} else {
  console.error('[system-events] boot() is not defined — OS cannot start');
}