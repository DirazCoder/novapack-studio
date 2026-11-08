// [NOVAPACK_APP_JS] -- from NovaPack Studio, not NBOSP
'use strict';

// NovaByte Studio -- UI Controller.
// Runs inside NW.js with full Node.js access. Loaded as a <script> in the
// packaged build; can also be required from Node.js (tests) thanks to the
// guarded boot block and module.exports at the bottom.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const { PERMISSIONS, PERMISSION_IDS, LEGACY_PERMISSION_ALIASES } = require('./src/sdk/permissions.js');
const cssTreeValidator = require('csstree-validator');
let beautify = null;

async function _ensureFormatter() {
  if (beautify === false) return null;
  if (beautify) return beautify;
  if (typeof require !== 'function') return null;
  try {
    beautify = require('js-beautify');
    return beautify;
  } catch (error) {
    console.warn('[app] js-beautify is unavailable; format actions are disabled.', error);
    beautify = false;
    return null;
  }
}
// Used by the Design tab for source-accurate HTML/CSS patching (surgical
// edits instead of whole-file overwrites) -- see the Design tab module
// below for why. Requires `npm install parse5 css` in this project.
const parse5 = require('parse5');
const cssParser = require('css');

// Platform detection. NW.js exposes process.platform; in pure browser
// contexts (or jsdom tests) we fall back to navigator so the file still loads.
const IS_MAC = (typeof process !== 'undefined' && process.platform
  ? process.platform
  : (typeof navigator !== 'undefined' ? navigator.platform : '')
).toLowerCase().includes('darwin');
const MOD_KEY = IS_MAC ? '\u2318' : 'Ctrl';

const {
  build,
  inspect,
  verify,
  listActions,
  loadPackage,
  detectCppSources,
  previewProjectFiles,
  walkProjectFiles,
} = require('./src/sdk/builder.js');
const { TEMPLATES, create } = require('./src/sdk/templates.js');
const AppPackage = require('./src/sdk/app-package.js');
const {
  downloadCommunityTemplate,
  fetchCommunityTemplateCatalog,
  validateCommunityTemplateBundle,
  validateTemplateFilePath,
} = require('./src/sdk/community-templates.js');
const {
  activatePlugins,
  createPluginManager,
  deactivatePlugins,
  downloadStudioPluginArchive,
  fetchStudioPluginCatalog,
  getPluginIconDataUrl,
  isPluginDomNode,
  listProjectFiles,
  resolveProjectPath,
} = require('./src/sdk/plugins.js');
const semver = require('semver');

let _studioPluginManager = null;
let _activeStudioPlugins = [];
let _studioPluginCatalog = [];
let _studioPluginCatalogLoaded = false;
let _studioPluginCatalogLoading = false;
let _studioPluginManagerView = 'marketplace';
let _studioPluginSelectedId = null;
let _studioPluginCatalogRevision = 0;
const _studioPluginCatalogDetails = new Map();
const _studioPluginCatalogDetailRequests = new Map();
const _studioPluginCommands = new Map();
const _studioPluginViews = new Map();
const _studioPluginActivationErrors = new Map();
const _studioPluginEventTarget = new EventTarget();
const _studioPluginDisposers = new Map();

function _emitStudioPluginEvent(name, detail) {
  _studioPluginEventTarget.dispatchEvent(new CustomEvent(name, { detail }));
}

function _ownStudioPluginResource(pluginId, dispose) {
  if (!_studioPluginDisposers.has(pluginId)) _studioPluginDisposers.set(pluginId, new Set());
  const resources = _studioPluginDisposers.get(pluginId);
  resources.add(dispose);
  return () => {
    if (!resources.delete(dispose)) return;
    dispose();
  };
}

function _refreshStudioPluginCommands() {
  _cpRegistry = _buildCommandRegistry();
  const overlay = $('modal-command-palette');
  if (overlay && !overlay.classList.contains('hidden')) {
    _renderCpCategories();
    _runCpFilter($('cp-input')?.value || '');
  }
}

function _disposeStudioPluginResources(pluginId) {
  const resources = _studioPluginDisposers.get(pluginId);
  if (!resources) return;
  for (const dispose of [...resources].reverse()) {
    try {
      dispose();
    } catch (error) {
      console.error(`[plugins] Could not dispose a resource from ${pluginId}:`, error);
    }
  }
  _studioPluginDisposers.delete(pluginId);
}

// nw is a global provided by NW.js -- no require needed.

// Structured errors. Typed errors make failure modes observable and easy to
// branch on. Each one carries the context that helps debugging at 2 AM.
class StorageError extends Error {
  constructor(message, { key, cause } = {}) {
    super(message);
    this.name = 'StorageError';
    this.key = key;
    if (cause) this.cause = cause;
  }
}

class GitError extends Error {
  constructor(message, { args, cause } = {}) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    if (cause) this.cause = cause;
  }
}

class BuildError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'BuildError';
    if (cause) this.cause = cause;
  }
}

// Global state. One mutable object so it's easy to inspect from devtools.
const state = {
  screen: 'welcome',           // 'welcome' | 'project' | 'inspector' | 'settings'
  projectDir: null,
  projectName: null,
  activeTab: 'manifest',
  selectedTemplate: 'blank',
  recentProjects: [],
  building: false,
  buildProgress: 0,
  theme: 'nb-dark',
  customColors: {},             // { '--bg-base': '#...', ... } -- only when theme === 'custom'
  lastNonCustomTheme: 'nb-dark', // preset to revert to if custom colors are discarded
  gitRoot: null,
  gitStatus: null,              // Map<absolutePath, statusChar> | null when not a repo
  gitNumstat: null,             // Map<absolutePath, {add, del}> -- best-effort +/- counts
  gitActiveSection: 'changes',  // 'changes' | 'history' | 'stash' | 'branches'
  gitBranches: [],              // cached branch list incl. ahead/behind, refreshed on demand
  sidebarWidth: 238,
  railWidth: 220,
  sidebarDock: 'left',
  railDock: 'left',
  railCollapsed: false,
  sidebarCollapsed: false,
  quickAccessCollapsed: true,
  firstRunSetupComplete: true,
  autosaveMode: 'off',
  autosaveManifest: true,
  autosaveEditor: true,
  uiDensity: 'comfortable',
  disableGlassEffects: false,
};
window.state = state;

function _uiIcon(name, extraClass = '') {
  return `<svg class="ui-icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ui-icon-${name}"></use></svg>`;
}

function _initCustomSelects() {
  const instances = new WeakMap();
  let nextId = 0;
  let activeInstance = null;
  let observer;

  const selectedIndexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

  function _renderOptions(instance) {
    const { select, listbox } = instance;
    listbox.replaceChildren();
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const group = document.createElement('div');
        group.className = 'custom-select-group';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', child.label);
        const label = document.createElement('div');
        label.className = 'custom-select-group-label';
        label.textContent = child.label;
        group.appendChild(label);
        for (const option of child.children) {
          if (option instanceof HTMLOptionElement) group.appendChild(_optionButton(instance, option));
        }
        listbox.appendChild(group);
      } else if (child instanceof HTMLOptionElement) {
        listbox.appendChild(_optionButton(instance, child));
      }
    }
  }

  function _optionButton(instance, option) {
    const { select } = instance;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'custom-select-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.disabled = option.disabled || option.parentElement.disabled;
    item.dataset.optionIndex = String(option.index);
    const label = document.createElement('span');
    label.className = 'custom-select-option-label';
    label.textContent = option.label;
    item.appendChild(label);
    if (option.selected) item.insertAdjacentHTML('beforeend', _uiIcon('check'));
    item.addEventListener('click', () => {
      if (item.disabled) return;
      if (select.multiple) {
        option.selected = !option.selected;
      } else if (selectedIndexDescriptor?.set) {
        selectedIndexDescriptor.set.call(select, option.index);
      } else {
        select.selectedIndex = option.index;
      }
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      instance.refresh();
      if (!select.multiple) _close(instance, true);
    });
    return item;
  }

  function _position(instance) {
    const rect = instance.trigger.getBoundingClientRect();
    const gap = 6;
    const maxHeight = Math.min(320, window.innerHeight - 24);
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const openUp = below < Math.min(180, maxHeight) && above > below;
    const listWidth = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    instance.listbox.style.left = `${Math.max(8, Math.min(rect.right - listWidth, window.innerWidth - listWidth - 8))}px`;
    instance.listbox.style.width = `${listWidth}px`;
    instance.listbox.style.maxHeight = `${Math.max(100, Math.min(maxHeight, openUp ? above : below))}px`;
    instance.listbox.style.top = openUp
      ? `${Math.max(8, rect.top - Math.min(instance.listbox.scrollHeight, Math.max(100, Math.min(maxHeight, above))) - gap)}px`
      : `${rect.bottom + gap}px`;
    instance.listbox.classList.toggle('custom-select-listbox--up', openUp);
  }

  function _open(instance, focusSelected = true) {
    if (instance.select.disabled) return;
    if (activeInstance && activeInstance !== instance) _close(activeInstance, false);
    instance.refresh();
    instance.listbox.hidden = false;
    instance.trigger.setAttribute('aria-expanded', 'true');
    activeInstance = instance;
    _position(instance);
    if (focusSelected) {
      const selected = instance.listbox.querySelector('[aria-selected="true"]:not(:disabled)');
      (selected || instance.listbox.querySelector('.custom-select-option:not(:disabled)'))?.focus();
    }
  }

  function _close(instance, returnFocus = false) {
    instance.listbox.hidden = true;
    instance.trigger.setAttribute('aria-expanded', 'false');
    if (activeInstance === instance) activeInstance = null;
    if (returnFocus) instance.trigger.focus();
  }

  function _init(select) {
    if (instances.has(select)) return;
    const parent = select.parentElement;
    if (!parent) return;
    const computed = getComputedStyle(select);
    const host = document.createElement('div');
    host.className = `custom-select-host ${select.className}`;
    host.style.width = select.style.width || computed.width;
    host.style.minWidth = select.style.minWidth || computed.minWidth;
    host.style.maxWidth = select.style.maxWidth || computed.maxWidth;
    host.style.flex = select.style.flex || computed.flex;
    host.style.alignSelf = computed.alignSelf;
    parent.insertBefore(host, select);
    host.appendChild(select);
    select.classList.add('custom-select-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `custom-select-trigger ${select.className.replace(/\bcustom-select-native\b/g, '').trim()}`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `custom-select-list-${++nextId}`);
    const associatedLabel = select.labels?.[0];
    const accessibleName = select.getAttribute('aria-label')
      || (select.getAttribute('aria-labelledby')
        ? document.getElementById(select.getAttribute('aria-labelledby'))?.textContent?.trim()
        : associatedLabel?.textContent?.trim())
      || select.title
      || select.id
      || 'Choose an option';
    trigger.setAttribute('aria-label', accessibleName);
    if (select.title) trigger.title = select.title;
    const value = document.createElement('span');
    value.className = 'custom-select-value';
    const caret = document.createElement('span');
    caret.className = 'custom-select-caret';
    caret.innerHTML = _uiIcon('chevron');
    trigger.append(value, caret);

    const listbox = document.createElement('div');
    listbox.id = trigger.getAttribute('aria-controls');
    listbox.className = 'custom-select-listbox';
    listbox.setAttribute('role', 'listbox');
    if (select.multiple) listbox.setAttribute('aria-multiselectable', 'true');
    listbox.hidden = true;
    document.body.appendChild(listbox);
    host.appendChild(trigger);

    const instance = {
      select, host, trigger, value, listbox,
      refresh() {
        const selected = select.options[select.selectedIndex];
        value.textContent = select.multiple
          ? [...select.selectedOptions].map((option) => option.label).join(', ') || select.dataset.placeholder || 'Select options'
          : selected?.label || select.dataset.placeholder || 'Select an option';
        trigger.disabled = select.disabled;
        trigger.setAttribute('aria-required', String(select.required));
        trigger.setAttribute('aria-invalid', String(select.getAttribute('aria-invalid') === 'true'));
        host.hidden = select.hidden || computedStyleDisplayNone(select);
        _renderOptions(instance);
        if (!listbox.hidden) _position(instance);
      },
    };

    instance.refresh();

    trigger.addEventListener('click', () => {
      if (listbox.hidden) _open(instance);
      else _close(instance);
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        _open(instance);
      }
    });
    select.addEventListener('change', instance.refresh);
    select.addEventListener('focus', () => trigger.focus());
    associatedLabel?.addEventListener('click', () => trigger.focus());

    if (valueDescriptor?.get && valueDescriptor.set) {
      Object.defineProperty(select, 'value', {
        configurable: true,
        enumerable: valueDescriptor.enumerable,
        get() { return valueDescriptor.get.call(this); },
        set(nextValue) {
          valueDescriptor.set.call(this, nextValue);
          instance.refresh();
        },
      });
    }
    if (selectedIndexDescriptor?.get && selectedIndexDescriptor.set) {
      Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        enumerable: selectedIndexDescriptor.enumerable,
        get() { return selectedIndexDescriptor.get.call(this); },
        set(nextIndex) {
          selectedIndexDescriptor.set.call(this, nextIndex);
          instance.refresh();
        },
      });
    }

    let search = '';
    let searchTimer;
    listbox.addEventListener('keydown', (event) => {
      const options = [...listbox.querySelectorAll('.custom-select-option:not(:disabled)')];
      const index = options.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        _close(instance, true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        (event.key === 'Home' ? options[0] : options.at(-1))?.focus();
      } else if (event.key === 'Tab') {
        _close(instance);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        search += event.key.toLocaleLowerCase();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { search = ''; }, 650);
        const match = options.find((option) => option.textContent.trim().toLocaleLowerCase().startsWith(search));
        match?.focus();
      }
    });
    instances.set(select, instance);
  }

  function _scan(root) {
    if (root instanceof HTMLSelectElement) _init(root);
    root.querySelectorAll?.('select').forEach(_init);
  }

  function computedStyleDisplayNone(select) {
    return getComputedStyle(select).display === 'none';
  }

  document.addEventListener('pointerdown', (event) => {
    if (activeInstance && !activeInstance.host.contains(event.target) && !activeInstance.listbox.contains(event.target)) {
      _close(activeInstance);
    }
  });
  window.addEventListener('resize', () => {
    if (activeInstance) _position(activeInstance);
  });
  window.addEventListener('scroll', () => {
    if (activeInstance) _position(activeInstance);
  }, true);

  _scan(document);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const select = record.target instanceof HTMLSelectElement
          ? record.target
          : record.target.closest?.('select');
        if (select) instances.get(select)?.refresh();
      } else {
        if (record.target instanceof HTMLSelectElement) instances.get(record.target)?.refresh();
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) _scan(node);
        });
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'required', 'selected', 'label', 'aria-label', 'aria-invalid', 'style', 'class', 'hidden'],
  });
}

// Precomputed lookup tables for the permissions catalogue. Built once so
// hot paths (permission hover, audit rendering) don't iterate the array.
const _PERMISSION_MAP = Object.fromEntries(PERMISSIONS.map((p) => [p.id, p]));

function _permissionsForChannel(channel) {
  const action = channel.replace(/^nova:/, '');
  if (PERMISSION_IDS.has(action)) return [action];
  if (LEGACY_PERMISSION_ALIASES[action]) return [LEGACY_PERMISSION_ALIASES[action]];

  const [family, method] = action.split(':');
  const methodName = (method || '').toLowerCase();
  const fixedPermissions = {
    'fs:watch': ['fs:watch'],
    'notifications:show': ['device:notifications'],
    'notifications:post': ['device:notifications'],
    'calendar:list': ['calendar:read'],
    'calendar:save': ['calendar:write'],
    'calendar:remove': ['calendar:delete'],
    'contacts:list': ['contacts:read'],
    'contacts:save': ['contacts:write'],
    'contacts:remove': ['contacts:delete'],
    'data:export': ['data:export'],
    'data:import': ['data:export'],
    'data:backup': ['data:backup'],
    'data:restore': ['data:backup'],
    'alarms:create': ['system:schedule'],
    'alarms:clear': ['system:schedule'],
    'alarms:getAll': ['system:schedule'],
    'badge:set': ['system:badge'],
    'badge:clear': ['system:badge'],
    'push:register': ['push:receive'],
    'push:unregister': ['push:receive'],
    'background:stay-alive': ['system:background:live'],
    'app:list': ['system:apps'],
    'app:install': ['system:apps'],
    'app:uninstall': ['system:apps'],
    'app:launch': ['system:app-launch'],
    'app:openDefaultAppsSettings': ['system:apps'],
    'admin:auditQuery': ['admin:audit'],
    'admin:systemGet': ['admin:system'],
    'admin:systemSet': ['admin:system'],
    'admin:usersList': ['admin:users'],
    'admin:usersRevoke': ['admin:users'],
    'admin:appsList': ['admin:apps'],
    'browser:createView': ['sandbox:nested-webview'],
    'settings:get': ['system:info'],
    'net:websocket': ['net:websocket'],
    'system:info': ['system:info'],
  };
  if (fixedPermissions[action]) return fixedPermissions[action];

  if (family === 'notifications') return ['device:notifications'];
  if (family === 'alarms') return ['system:schedule'];
  if (family === 'badge') return ['system:badge'];
  if (family === 'push') return ['push:receive'];
  if (family === 'share' && methodName === 'inbound') return ['system:share-target'];
  if (family === 'background' && methodName.startsWith('wake')) return ['system:background'];
  if (family === 'ipc' && ['call', 'provide', 'broadcast', 'onbroadcast'].includes(methodName)) {
    return ['apps:communicate'];
  }

  if (family === 'mail') {
    if (['connect', 'disconnect', 'restore', 'preview', 'markread', 'move'].includes(methodName)) return ['mail:write'];
    if (methodName === 'send') return ['mail:send'];
    if (methodName === 'remove') return ['mail:delete'];
    if (['folders', 'messages', 'message', 'search', 'account'].includes(methodName)) return ['mail:read'];
  }
  if (family === 'reg') {
    if (['get', 'stat', 'list', 'export', 'watch'].includes(methodName)) return ['registry.read'];
    if (['set', 'remove', 'import'].includes(methodName)) return ['registry.write'];
  }
  return [];
}

function _permissionsForEvent(eventName) {
  const permissions = {
    'system:notification': ['system:events'],
    'app:installed': ['system:events'],
    'app:uninstalled': ['system:events'],
    'app:launched': ['system:events'],
    'mail:new': ['system:events', 'mail:read'],
    'mail:updated': ['system:events', 'mail:read'],
    'calendar:reminder': ['system:events', 'calendar:read'],
    'calendar:updated': ['system:events', 'calendar:read'],
    'contacts:updated': ['system:events', 'contacts:read'],
    'nova:net:ws:message': ['net:websocket'],
    'nova:net:ws:error': ['net:websocket'],
    'nova:net:ws:close': ['net:websocket'],
    'nova:reg:changed': ['registry.read'],
  };
  return permissions[eventName] || [];
}

function _conditionalPermissionForChannel(channel) {
  if (/^nova:fs:(?:read|write|list|stat|mkdir|remove|copy|move|rename)$/.test(channel)) {
    return 'Filesystem IPC action (path-dependent)';
  }
  if (channel === 'nova:media:query') return 'Media query (type-dependent)';
  if (channel === 'nova:net:fetch') return 'Network fetch (URL-dependent)';
  if (channel === 'nova:events:subscribe') return 'Event subscription (event-dependent)';
  if (channel === 'nova:settings:set') return 'Settings update (key-dependent)';
  return '';
}

function _isKnownPermissionlessChannel(channel) {
  return /^nova:(?:dialog:(?:open|save)|sysdialog:(?:open|save)|window:(?:close|minimize|maximize|setTitle|resize|getState)|app:(?:info|share)|locale:get|ready|events:unsubscribe|request-permission|files:(?:open|save)|appearance:set|wallpaper:set)$/.test(channel);
}

const _PERMISSION_API_RULES = [
  [/window\.novaOS\.notifications\./, ['device:notifications']],
  [/window\.novaOS\.alarms\./, ['system:schedule']],
  [/window\.novaOS\.fs\.watch\b/, ['fs:watch']],
  [/window\.novaOS\.clipboard\.readText\b/, ['clipboard:read']],
  [/window\.novaOS\.clipboard\.writeText\b/, ['clipboard:write']],
  [/window\.novaOS\.app\.list\b|window\.nova\.apps\.(?:list|install|uninstall|openDefaultAppsSettings)\b/, ['system:apps']],
  [/window\.nova(?:OS)?\.app\.launch\b|window\.nova\.apps\.launch\b/, ['system:app-launch']],
  [/window\.novaOS\.settings\.set\b/, ['system:settings']],
  [/window\.novaOS\.push\./, ['push:receive']],
  [/window\.novaOS\.settings\.get\b/, ['system:info']],
  [/window\.novaOS\.geolocation\./, ['device:geolocation']],
  [/window\.novaOS\.net\.websocket\b/, ['net:websocket']],
  [/window\.nova\.websocket\b/, ['net:websocket']],
  [/window\.nova(?:OS)?\.calendar\.list\b/, ['calendar:read']],
  [/window\.nova(?:OS)?\.calendar\.save\b/, ['calendar:write']],
  [/window\.nova(?:OS)?\.calendar\.remove\b/, ['calendar:delete']],
  [/window\.nova(?:OS)?\.contacts\.list\b/, ['contacts:read']],
  [/window\.nova(?:OS)?\.contacts\.save\b/, ['contacts:write']],
  [/window\.nova(?:OS)?\.contacts\.remove\b/, ['contacts:delete']],
  [/window\.nova(?:OS)?\.data\.(?:backup|restore)\b/, ['data:backup']],
  [/window\.nova(?:OS)?\.data\.(?:export|import)\b/, ['data:export']],
  [/window\.novaOS\.badge\./, ['system:badge']],
  [/window\.novaOS\.registry\.(?:get|list|stat|export|watch)\b/, ['registry.read']],
  [/window\.novaOS\.registry\.(?:set|remove|import)\b/, ['registry.write']],
  [/window\.novaOS\.secrets\./, ['secrets:store']],
  [/window\.novaOS\.share\.onInbound\b/, ['system:share-target']],
  [/window\.novaOS\.background\.(?:onWake|wakeDone)\b|window\.nova\.(?:onBackgroundWake|backgroundWakeDone)\b/, ['system:background']],
  [/window\.novaOS\.background\.stayAlive\b|window\.nova\.stayAliveInBackground\b/, ['system:background:live']],
  [/window\.nova(?:OS)?\.admin\.auditQuery\b/, ['admin:audit']],
  [/window\.nova(?:OS)?\.admin\.system(?:Get|Set)\b/, ['admin:system']],
  [/window\.nova(?:OS)?\.admin\.users(?:List|Revoke)\b/, ['admin:users']],
  [/window\.nova(?:OS)?\.admin\.appsList\b/, ['admin:apps']],
  [/window\.novaOS\.browser\.createView\b|window\.nova\.browser\.createView\b/, ['sandbox:nested-webview']],
  [/window\.nova\.ipc\.(?:call|provide|broadcast)\b/, ['apps:communicate']],
  [/window\.nova\.mail\.(?:folders|messages|message|search|account)\b/, ['mail:read']],
  [/window\.nova\.mail\.(?:connect|disconnect|restore|preview|markRead|move)\b/, ['mail:write']],
  [/window\.nova\.mail\.send\b/, ['mail:send']],
  [/window\.nova\.mail\.remove\b/, ['mail:delete']],
];

function _canonicalPermission(permission) {
  return LEGACY_PERMISSION_ALIASES[permission] || permission;
}

function _permissionAtLinePosition(lineText, offset) {
  let start = Math.max(0, Math.min(offset, lineText.length));
  let end = start;
  const isPermissionChar = (char) => /[a-zA-Z0-9_:.-]/.test(char);
  while (start > 0 && isPermissionChar(lineText[start - 1])) start--;
  while (end < lineText.length && isPermissionChar(lineText[end])) end++;
  if (start === end) return null;

  const id = lineText.slice(start, end);
  const permission = _PERMISSION_MAP[_canonicalPermission(id)];
  return permission ? { id, permission } : null;
}

// ── nova: snippet bodies ─────────────────────────────────────────────────
//
// Boilerplate for "Insert nova: Snippet" (command palette, Snippets
// category) -- one realistic window.nova.ipc(...) call per permission,
// matching the actual call shape used in templates.js's shipped templates
// (await window.nova.ipc('nova:xxx', {...})), not a guessed/generic shape.
//
// Not every PERMISSIONS entry gets one: the admin:*, sandbox:*, and
// system:autostart/system:background(:live) entries gate *behavior* (extra
// manifest flags, OS-level lifecycle) rather than corresponding to a single
// direct IPC call a developer would type in a normal event handler -- for
// those, generating a plausible-looking `nova:admin:apps` call would be
// fabricating an API shape that doesn't necessarily exist as a single
// call. Entries without a snippet just don't get a command registered
// (see the Snippets section of _buildCommandRegistry below), rather than
// showing a fake or misleading one.
const _PERM_SNIPPETS = {
  'fs:metadata': `const { stat } = await window.nova.ipc('nova:fs:stat', { path: 'media:/Pictures/photo.png' });\n`,
  'fs:watch': `const watch = await window.novaOS.fs.watch('appdata:/notes/todo.txt', console.log);\n`,
  'fs:read:images': `const image = await window.novaOS.fs.read('media:/Pictures/photo.png');\n`,
  'net:internal': `const response = await fetch('https://localhost:3003/api/endpoint');\n`,
  'net:external': `const response = await fetch('https://api.example.com/data');\n`,
  'net:websocket': `const socket = await window.nova.websocket('wss://example.com/socket');\n`,
  'device:notifications': `await window.nova.ipc('nova:notifications:show', { title: 'Update', body: 'Ready' });\n`,
  'device:geolocation': `const position = await window.novaOS.geolocation.getCurrentPosition();\n`,
  'device:camera': `const stream = await window.nova.getUserMedia({ video: true });\n`,
  'device:microphone': `const stream = await window.nova.getUserMedia({ audio: true });\n`,
  'clipboard:read': `const clipboardText = await window.nova.ipc('nova:clipboard:read', {});\n`,
  'clipboard:write': `await window.nova.ipc('nova:clipboard:write', { text: '' });\n`,
  'mail:read': `const { data } = await window.nova.mail.messages({ folder: 'INBOX', page: 1, limit: 20 });\n`,
  'mail:write': `await window.nova.mail.markRead([101], 'INBOX');\n`,
  'mail:send': `await window.nova.mail.send({ to: 'person@example.com', subject: 'Hello', text: 'Hi', smtpHost: 'smtp.example.com', smtpPort: 587 });\n`,
  'mail:delete': `await window.nova.mail.remove([101], 'INBOX');\n`,
  'calendar:read': `const { events } = await window.nova.calendar.list();\n`,
  'calendar:write': `await window.nova.calendar.save({ title: 'Meeting', date: '2026-11-06' });\n`,
  'calendar:delete': `await window.nova.calendar.remove('event-id');\n`,
  'contacts:read': `const { contacts } = await window.nova.contacts.list();\n`,
  'contacts:write': `await window.nova.contacts.save({ id: 'contact-1', name: 'Jane Doe' });\n`,
  'contacts:delete': `await window.nova.contacts.remove('contact-1');\n`,
  'data:export': `const { envelope } = await window.nova.data.export({ prefix: 'settings.' });\n`,
  'data:backup': `const { envelope } = await window.nova.data.backup();\n`,
  'secrets:store': `await window.novaOS.secrets.set('api-token', 'value');\n`,
  'system:info': `const info = await window.nova.ipc('nova:system:info', {});\n`,
  'system:settings': `await window.nova.ipc('nova:settings:set', { key: 'theme', value: 'nord' });\n`,
  'system:apps': `const { apps } = await window.nova.apps.list();\n`,
  'system:app-launch': `await window.nova.apps.launch('com.example.other');\n`,
  'system:events': `window.nova.onEvent('system:themeChanged', (data) => console.log(data));\n`,
  'system:badge': `await window.novaOS.badge.set(3);\n`,
  'system:schedule': `await window.novaOS.alarms.create({ name: 'sync', periodMinutes: 30 });\n`,
  'system:share-target': `const unsubscribe = window.novaOS.share.onInbound((share) => console.log(share));\n`,
  'push:receive': `const unsubscribe = window.novaOS.push.onMessage((message) => console.log(message));\n`,
  'registry.read': `const value = await window.novaOS.registry.get('HKNS/shell/theme');\n`,
  'registry.write': `await window.novaOS.registry.set('HKNA/com.example.myapp/theme', 'dark');\n`,
};

function _permSnippetCommands() {
  return PERMISSIONS
    .filter((p) => _PERM_SNIPPETS[p.id])
    .map((p) => ({
      id: `snippet-${p.id}`,
      label: `Insert Snippet: ${p.id}`,
      category: 'Snippets',
      // Snippet only makes sense with an editor open AND that permission
      // actually declared -- inserting a call for a permission the app
      // hasn't granted itself would just hand the live-permission-check
      // (added above) an instant false positive.
      when: () => {
        const manifest = readManifestForm();
        return tabs.length > 0 && (
          (manifest.permissions || []).includes(p.id) ||
          (manifest.optionalPermissions || []).includes(p.id)
        );
      },
      action: () => window.CM?.insertAtCursor(_PERM_SNIPPETS[p.id]),
    }));
}
const PERMISSION_CATEGORIES = {
  fs: { label: 'Filesystem', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5h6l2 2h9a1.5 1.5 0 0 1 1.5 1.5v7a2 2 0 0 1-2 2h-16a2 2 0 0 1-2-2v-8a2.5 2.5 0 0 1 2.5-2.5Z" stroke="#60a5fa" stroke-width="1.8"/><path d="M3 11h18l-1.6 6.2a1.5 1.5 0 0 1-1.5 1.1H4.4a1.5 1.5 0 0 1-1.5-1.8L4 11Z" fill="#38bdf8" fill-opacity=".2" stroke="#22d3ee" stroke-width="1.4"/></svg>' },
  apps: { label: 'Apps', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2" fill="#a78bfa" fill-opacity=".24" stroke="#a78bfa" stroke-width="1.7"/><rect x="13.5" y="3.5" width="7" height="7" rx="2" fill="#22d3ee" fill-opacity=".2" stroke="#22d3ee" stroke-width="1.7"/><rect x="3.5" y="13.5" width="7" height="7" rx="2" fill="#fb7185" fill-opacity=".2" stroke="#fb7185" stroke-width="1.7"/><rect x="13.5" y="13.5" width="7" height="7" rx="2" fill="#60a5fa" fill-opacity=".2" stroke="#60a5fa" stroke-width="1.7"/></svg>' },
  net: { label: 'Network', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5" stroke="#34d399" stroke-width="1.7"/><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.1-3.3-8.5S9.8 5.8 12 3.5Z" stroke="#22d3ee" stroke-width="1.5"/><path d="M5.2 7.2h13.6M5.2 16.8h13.6" stroke="#a3e635" stroke-width="1.2"/></svg>' },
  mail: { label: 'Mail', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" fill="#fb923c" fill-opacity=".12" stroke="#fb923c" stroke-width="1.7"/><path d="m4.5 7 6.3 5a2 2 0 0 0 2.4 0l6.3-5" stroke="#f472b6" stroke-width="1.8"/><path d="m4.5 17 5-4M19.5 17l-5-4" stroke="#fbbf24" stroke-width="1.4"/></svg>' },
  calendar: { label: 'Calendar', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="#f472b6" fill-opacity=".12" stroke="#f472b6" stroke-width="1.7"/><path d="M7.5 3.5v4M16.5 3.5v4M4 9.5h16" stroke="#22d3ee" stroke-width="1.7"/><path d="M8 13h2M14 13h2M8 16.5h2" stroke="#fbbf24" stroke-width="2"/></svg>' },
  contacts: { label: 'Contacts', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="3" fill="#34d399" fill-opacity=".1" stroke="#34d399" stroke-width="1.7"/><circle cx="12" cy="9" r="2.5" fill="#a78bfa" fill-opacity=".3" stroke="#a78bfa" stroke-width="1.5"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0" stroke="#22d3ee" stroke-width="1.7"/><path d="M2.5 8v8M21.5 8v8" stroke="#fbbf24" stroke-width="1.5"/></svg>' },
  device: { label: 'Device', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="3" fill="#60a5fa" fill-opacity=".13" stroke="#60a5fa" stroke-width="1.7"/><path d="M9 5.5h6" stroke="#22d3ee" stroke-width="1.5"/><circle cx="12" cy="18" r="1" fill="#fb7185" stroke="#fb7185"/><path d="M9 9.5h6M9 12.5h4" stroke="#a78bfa" stroke-width="1.5"/></svg>' },
  data: { label: 'Data', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5S4 7.4 4 6Z" fill="#a78bfa" fill-opacity=".25" stroke="#a78bfa" stroke-width="1.6"/><path d="M4 6v6c0 1.4 3.6 2.5 8 2.5 1.3 0 2.5-.1 3.6-.3M20 6v4" stroke="#22d3ee" stroke-width="1.6"/><path d="M4 12v6c0 1.4 3.6 2.5 8 2.5 1.1 0 2.2-.1 3.2-.2" stroke="#60a5fa" stroke-width="1.6"/><circle cx="18" cy="16" r="3.3" fill="#fb923c" fill-opacity=".16" stroke="#fb923c" stroke-width="1.5"/><path d="m16.7 16 1 1 1.8-2" stroke="#34d399" stroke-width="1.4"/></svg>' },
  system: { label: 'System', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m10 3.5.5-1h3l.5 1 1.8 1 .9-.3 2.1 2.1-.3.9 1 1.8 1 .5v3l-1 .5-1 1.8.3.9-2.1 2.1-.9-.3-1.8 1-.5 1h-3l-.5-1-1.8-1-.9.3-2.1-2.1.3-.9-1-1.8-1-.5v-3l1-.5 1-1.8-.3-.9 2.1-2.1.9.3 1.8-1Z" transform="translate(1 1) scale(.92)" fill="#60a5fa" fill-opacity=".12" stroke="#60a5fa" stroke-width="1.5"/><circle cx="12" cy="12" r="3.2" fill="#34d399" fill-opacity=".22" stroke="#34d399" stroke-width="1.7"/><circle cx="12" cy="12" r="1" fill="#fbbf24"/></svg>' },
  admin: { label: 'Admin', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 5.7v5.5c0 5-3.4 8.4-8 10.3-4.6-1.9-8-5.3-8-10.3V5.7L12 2.5Z" fill="#f59e0b" fill-opacity=".16" stroke="#fbbf24" stroke-width="1.7"/><path d="m8.2 12.2 2.5 2.5 5.2-5.5" stroke="#fb7185" stroke-width="2"/><path d="M12 5.5v2" stroke="#22d3ee" stroke-width="1.5"/></svg>' },
  sandbox: { label: 'Sandbox', icon: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2.8 8 4.5v9.4l-8 4.5-8-4.5V7.3l8-4.5Z" fill="#a78bfa" fill-opacity=".14" stroke="#a78bfa" stroke-width="1.7"/><path d="m4.4 7.5 7.6 4.3 7.6-4.3M12 11.8v9" stroke="#22d3ee" stroke-width="1.6"/><path d="m8 5 8 4.5" stroke="#fb7185" stroke-width="1.4"/></svg>' },
};

// Permissions that need a second manifest flag beyond the permission
// string itself, per the two-gate comments on PERMISSIONS above -- surfaced
// here as a visible badge instead of only living in hover-tooltip text, so
// it's not easy to miss.
const PERMISSIONS_NEEDING_MANIFEST_FLAG = new Set([
  'sandbox:nested-webview',
  'sandbox:same-origin',
  'sandbox:escape-popups',
]);

// DOM helpers
const $ = (id) => document.getElementById(id);
let screens = {}; // populated in init() after HTML is injected by the build

// Storage
const STORAGE_KEY = 'novapack_studio_data';
const GLASS_EFFECTS_STORAGE_KEY = 'novapack_studio_disable_glass_effects';

// File-tree watcher state. Both are torn down on every project switch to
// avoid stacking watchers across loadProject() calls.
let _fileTreeWatcher = null;
let _fileTreeWatcherTimer = null;
let _fileTreeDragAbort = null; // AbortController for the tree's drag/drop listeners
let _gitStatusRefreshId = 0;

let _manifestWatcher = null;
let _manifestWatcherTimer = null;

let _fileDragData = null;
let _autosaveTimer = null;
let _autosaveDebounce = null;

// Self-write suppression for the file-tree watcher. fs.watch fires for
// every write to the project dir, including the app's own autosave/manual
// saves -- those shouldn't cause a full tree rebuild (see the watcher
// callback below for why that rebuild is expensive/visible). Basename-keyed
// with a short TTL: good enough to distinguish "we just wrote this" from
// "something else touched it", without needing exact path normalization.
const _recentOwnWrites = new Map(); // basename -> expiry timestamp
const _OWN_WRITE_SUPPRESS_MS = 800;

function _markOwnWrite(filePath) {
  if (!filePath) return;
  _recentOwnWrites.set(path.basename(filePath), Date.now() + _OWN_WRITE_SUPPRESS_MS);
  // Opportunistic cleanup: drop any expired entries so the map can't grow
  // unboundedly if the user opens many distinct files in one session.
  if (_recentOwnWrites.size > 64) {
    const now = Date.now();
    for (const [k, expiry] of _recentOwnWrites) {
      if (expiry <= now) _recentOwnWrites.delete(k);
    }
  }
}

function _isOwnWrite(filename) {
  const expiry = _recentOwnWrites.get(filename);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    _recentOwnWrites.delete(filename);
    return false;
  }
  return true;
}

function getDefaultTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'nb-dark' : 'nb-light';
}

// Parse and apply the persisted state blob. Any parse / shape failure resets
// to defaults rather than poisoning the in-memory state with partial data.
function loadStorage() {
  let raw;
  let glassEffectsPreference = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    const storedGlassEffects = localStorage.getItem(GLASS_EFFECTS_STORAGE_KEY);
    if (storedGlassEffects === 'true' || storedGlassEffects === 'false') {
      glassEffectsPreference = storedGlassEffects === 'true';
    }
  } catch (err) {
    // localStorage can throw in private mode or when storage is disabled.
    // Fall back to defaults -- the app still runs, just without persistence.
    raw = null;
  }

  state.disableGlassEffects = glassEffectsPreference === true;
  if (!raw) {
    state.firstRunSetupComplete = false;
    state.theme = getDefaultTheme();
    state.lastNonCustomTheme = getDefaultTheme();
    state.sidebarWidth = 238;
    state.railWidth = 220;
    state.sidebarDock = 'left';
    state.railDock = 'left';
    state.railCollapsed = false;
    state.sidebarCollapsed = false;
    state.quickAccessCollapsed = true;
    _applyGlassEffects();
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Corrupted blob -- reset to defaults and let the next saveStorage()
    // overwrite the bad value so the user isn't stuck.
    state.firstRunSetupComplete = true;
    state.theme = getDefaultTheme();
    state.lastNonCustomTheme = getDefaultTheme();
    state.sidebarWidth = 238;
    state.railWidth = 220;
    state.sidebarDock = 'left';
    state.railDock = 'left';
    state.railCollapsed = false;
    state.sidebarCollapsed = false;
    state.quickAccessCollapsed = true;
    _applyGlassEffects();
    return;
  }

  // Treat anything that isn't a plain object as "no state" so a stray
  // array or string in the slot can't crash the field reads below.
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

  state.firstRunSetupComplete = data.firstRunSetupComplete !== false;
  state.recentProjects = Array.isArray(data.recentProjects) ? data.recentProjects : [];
  const savedTheme = _migrateThemeId(data.theme);
  state.theme = _isValidTheme(savedTheme) ? savedTheme : getDefaultTheme();
  state.customColors = (data.customColors && typeof data.customColors === 'object' && !Array.isArray(data.customColors))
    ? data.customColors
    : {};
  const savedLastTheme = _migrateThemeId(data.lastNonCustomTheme);
  state.lastNonCustomTheme = THEMES.some((t) => t.id === savedLastTheme)
    ? savedLastTheme
    : DEFAULT_THEME;
  state.sidebarWidth = (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 190 && data.sidebarWidth <= 360)
    ? data.sidebarWidth
    : 238;
  state.railWidth = (typeof data.railWidth === 'number' && data.railWidth >= 160 && data.railWidth <= 320)
    ? data.railWidth
    : 220;
  state.sidebarDock = data.sidebarDock === 'right' ? 'right' : 'left';
  state.railDock = data.railDock === 'right' ? 'right' : 'left';
  state.railCollapsed = !!data.railCollapsed;
  state.sidebarCollapsed = !!data.sidebarCollapsed;
  state.quickAccessCollapsed = data.quickAccessCollapsed !== false;
  state.autosaveMode = data.autosaveMode === 'realtime' || (typeof data.autosaveMode === 'number' && data.autosaveMode > 0)
    ? data.autosaveMode
    : 'off';
  state.autosaveManifest = data.autosaveManifest !== false;
  state.autosaveEditor = data.autosaveEditor !== false;
  state.uiDensity = data.uiDensity === 'compact' ? 'compact' : 'comfortable';
  state.disableGlassEffects = glassEffectsPreference ?? (data.disableGlassEffects === true);
  _applyGlassEffects();
}

function saveStorage() {
  let serialized;
  try {
    serialized = JSON.stringify({
      recentProjects: state.recentProjects,
      theme: state.theme,
      customColors: state.customColors,
      lastNonCustomTheme: state.lastNonCustomTheme,
      sidebarWidth: state.sidebarWidth,
      railWidth: state.railWidth,
      sidebarDock: state.sidebarDock,
      railDock: state.railDock,
      railCollapsed: state.railCollapsed,
      sidebarCollapsed: state.sidebarCollapsed,
      quickAccessCollapsed: state.quickAccessCollapsed,
      firstRunSetupComplete: state.firstRunSetupComplete,
      autosaveMode: state.autosaveMode,
      autosaveManifest: state.autosaveManifest,
      autosaveEditor: state.autosaveEditor,
      uiDensity: state.uiDensity,
      disableGlassEffects: state.disableGlassEffects,
    });
  } catch (err) {
    // JSON.stringify only fails on circular references or symbols on
    // properties -- neither should happen here, but if it does, swallow
    // rather than crash. Persistence is best-effort.
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(
      GLASS_EFFECTS_STORAGE_KEY,
      state.disableGlassEffects ? 'true' : 'false',
    );
  } catch (err) {
    // Swallow QuotaExceededError -- persistence is best-effort. The app keeps
    // working in-memory; the user just won't see their changes after restart.
  }
}

// ── Settings export / import ─────────────────────────────────────────────
//
// Bundles the *portable* subset of Studio's local state into one JSON file
// so a person can carry their preferences to a second machine. Deliberately
// narrower than "everything in localStorage":
//
//  - state.recentProjects (part of STORAGE_KEY) is excluded: it's a list of
//    absolute paths on THIS machine. Importing it on another machine would
//    show recent-project entries that don't exist there.
//  - WORKSPACES_KEY and BUILD_HISTORY_KEY are excluded for the same reason
//    (absolute projectDir / outFile paths).
//  - No signing key material is included -- there isn't any in localStorage
//    to begin with (see runBuild(): the signing key only ever lives in a
//    form field's .value, in memory, never persisted).
//  - CUSTOM_THEME_STORAGE_KEY ('novapack_custom_theme') is NOT touched here:
//    checked the rest of the codebase and nothing actually reads or writes
//    that key at runtime -- the real custom theme colors live in
//    state.customColors, which is part of STORAGE_KEY and already covered
//    below. That key appears to be dead/legacy; exporting it would just
//    copy nothing.
//
// What IS included: theme choice, custom theme colors (state.customColors,
// the field that's actually live), rail/sidebar layout, autosave
// preferences (all from STORAGE_KEY minus recentProjects), plus editor.js's
// cm_settings (font size, tab size, word wrap) -- genuinely
// machine-independent preferences.
const SETTINGS_EXPORT_FORMAT = 'novapack-studio-settings';
const SETTINGS_EXPORT_VERSION = 1;

function exportStudioSettings() {
  const bundle = {
    format: SETTINGS_EXPORT_FORMAT,
    formatVersion: SETTINGS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    studioVersion: STUDIO_VERSION,
    data: {
      theme: state.theme,
      customColors: state.customColors,
      lastNonCustomTheme: state.lastNonCustomTheme,
      sidebarWidth: state.sidebarWidth,
      railWidth: state.railWidth,
      sidebarDock: state.sidebarDock,
      railDock: state.railDock,
      railCollapsed: state.railCollapsed,
      sidebarCollapsed: state.sidebarCollapsed,
      quickAccessCollapsed: state.quickAccessCollapsed,
      autosaveMode: state.autosaveMode,
      autosaveManifest: state.autosaveManifest,
      autosaveEditor: state.autosaveEditor,
      uiDensity: state.uiDensity,
      disableGlassEffects: state.disableGlassEffects,
      editorSettings: null,
    },
  };

  try {
    const rawEditorSettings = localStorage.getItem('cm_settings');
    if (rawEditorSettings) bundle.data.editorSettings = JSON.parse(rawEditorSettings);
  } catch { /* leave null */ }

  return JSON.stringify(bundle, null, 2);
}

// Validates and applies a previously-exported settings bundle. Every field
// is checked against the same shape/range rules loadStorage() already uses
// for its own persisted blob -- an imported file is exactly as untrusted as
// a hand-edited localStorage value, so it gets the same defensive read,
// not a plain assign.
function importStudioSettings(jsonText) {
  let bundle;
  try {
    bundle = JSON.parse(jsonText);
  } catch {
    return { success: false, error: 'Not valid JSON' };
  }

  if (!bundle || typeof bundle !== 'object' || bundle.format !== SETTINGS_EXPORT_FORMAT) {
    return { success: false, error: 'Not a NovaByte Studio settings export' };
  }

  const data = bundle.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { success: false, error: 'Malformed settings data' };
  }

  const importedTheme = _migrateThemeId(data.theme);
  if (_isValidTheme(importedTheme)) state.theme = importedTheme;
  if (data.customColors && typeof data.customColors === 'object' && !Array.isArray(data.customColors)) {
    // Same known-keys allowlist filter as the existing "Paste theme JSON"
    // import (_renderCustomThemeSection's importBtn handler), so an
    // imported bundle can't inject arbitrary CSS custom-property names.
    const known = new Set(CUSTOM_THEME_VARS.flatMap((g) => g.vars.map((v) => v.key)));
    const clean = {};
    for (const [k, v] of Object.entries(data.customColors)) {
      if (known.has(k) && typeof v === 'string') clean[k] = v;
    }
    state.customColors = clean;
  }
  const importedLastTheme = _migrateThemeId(data.lastNonCustomTheme);
  if (THEMES.some((t) => t.id === importedLastTheme)) {
    state.lastNonCustomTheme = importedLastTheme;
  }
  if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 190 && data.sidebarWidth <= 360) {
    state.sidebarWidth = data.sidebarWidth;
  }
  if (typeof data.railWidth === 'number' && data.railWidth >= 160 && data.railWidth <= 320) {
    state.railWidth = data.railWidth;
  }
  if (data.sidebarDock === 'left' || data.sidebarDock === 'right') state.sidebarDock = data.sidebarDock;
  if (data.railDock === 'left' || data.railDock === 'right') state.railDock = data.railDock;
  state.railCollapsed = !!data.railCollapsed;
  state.sidebarCollapsed = !!data.sidebarCollapsed;
  if (data.autosaveMode === 'realtime' || (typeof data.autosaveMode === 'number' && data.autosaveMode > 0)) {
    state.autosaveMode = data.autosaveMode;
  }
  if (typeof data.autosaveManifest === 'boolean') state.autosaveManifest = data.autosaveManifest;
  if (typeof data.autosaveEditor === 'boolean') state.autosaveEditor = data.autosaveEditor;
  state.uiDensity = data.uiDensity === 'compact' ? 'compact' : 'comfortable';
  if (typeof data.disableGlassEffects === 'boolean') state.disableGlassEffects = data.disableGlassEffects;

  _applyPaneDocking();
  _applyGlassEffects();
  saveStorage();

  // Editor settings: only accept the exact fields applySettings() knows
  // about, with the same type/range checks editor.js's own DEFAULT_SETTINGS
  // implies, instead of forwarding an arbitrary object into CodeMirror config.
  if (data.editorSettings && typeof data.editorSettings === 'object' && !Array.isArray(data.editorSettings)) {
    const clean = {};
    const es = data.editorSettings;
    if (typeof es.fontSize === 'number' && es.fontSize >= 10 && es.fontSize <= 24) clean.fontSize = es.fontSize;
    if ([2, 4, 8].includes(es.tabSize)) clean.tabSize = es.tabSize;
    if (typeof es.wordWrap === 'boolean') clean.wordWrap = es.wordWrap;
    if (Object.keys(clean).length) window.CM?.applySettings(clean);
  }

  // Re-apply everything that just changed so the UI reflects it immediately
  // without requiring a restart. setTheme() already does applyTheme() +
  // saveStorage() + re-rendering both theme pickers + the custom theme
  // section, so reuse it rather than duplicating that sequence here.
  //
  // Deliberately NOT calling _initSettingsPage() again here: that function
  // attaches a document-level click/keydown listener each time it runs
  // (for the settings-page theme picker dropdown) without removing the
  // previous one first, so re-running it on every import would stack a
  // duplicate global listener per import. Instead, just refresh the
  // specific on-screen fields an import can change.
  setTheme(state.theme);
  _applySidebarWidth();
  if ($('lbl-font-size')) $('lbl-font-size').textContent = window.CM?.getSettings()?.fontSize ?? 13;
  if ($('sel-tab-size')) $('sel-tab-size').value = String(window.CM?.getSettings()?.tabSize ?? 2);
  if ($('chk-word-wrap')) $('chk-word-wrap').checked = !!window.CM?.getSettings()?.wordWrap;
  _updateEditorToolbar();
  const selMode = $('sel-autosave-mode');
  if (selMode) {
    selMode.value = state.autosaveMode === 'realtime' || (typeof state.autosaveMode === 'number')
      ? String(state.autosaveMode)
      : state.autosaveMode;
  }
  if ($('chk-autosave-manifest')) $('chk-autosave-manifest').checked = state.autosaveManifest;
  if ($('chk-autosave-editor')) $('chk-autosave-editor').checked = state.autosaveEditor;
  if ($('chk-disable-glass-effects')) $('chk-disable-glass-effects').checked = state.disableGlassEffects;
  _applyAutosaveSettings();

  return { success: true };
}

// Autosave. Two modes: 'realtime' (debounced 400ms after every change) or
// a numeric interval (seconds). 'off' disables both.
function _applyAutosaveSettings() {
  if (_autosaveTimer) {
    clearInterval(_autosaveTimer);
    _autosaveTimer = null;
  }
  if (_autosaveDebounce) {
    clearTimeout(_autosaveDebounce);
    _autosaveDebounce = null;
  }

  const mode = state.autosaveMode;
  if (mode === 'off') return;

  if (mode === 'realtime') {
    // Realtime is edge-triggered from _onManifestFormChanged /
    // _onEditorContentChanged; nothing to schedule here.
    return;
  }

  const seconds = typeof mode === 'number' ? mode : parseInt(mode, 10);
  if (!Number.isFinite(seconds) || seconds < 1) return;
  _autosaveTimer = setInterval(_performAutosave, seconds * 1000);
}

function _performAutosave() {
  if (!state.projectDir) return;

  if (state.autosaveManifest) {
    try {
      const manifest = readManifestForm();
      if (manifest.id && manifest.name) {
        const outPath = path.join(state.projectDir, 'manifest.json');
        fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
        _markOwnWrite(outPath);
        const manifestTab = tabs.find((t) => t.filePath === outPath);
        if (manifestTab) {
          manifestTab.originalContent = JSON.stringify(manifest, null, 2);
          manifestTab.isDirty = false;
          _renderTabs();
          if (window.CM && _getActiveTab()?.filePath === outPath) {
            window.CM.setValue(manifestTab.originalContent);
          }
        }
      }
    } catch {
      // ignore autosave errors to avoid interrupting the user
    }
  }

  if (state.autosaveEditor) {
    saveOpenFile();
  }
}

function _onManifestFormChanged() {
  _renderManifestPreview();
  if (state.autosaveMode !== 'realtime') return;
  if (!state.autosaveManifest) return;
  if (_autosaveDebounce) clearTimeout(_autosaveDebounce);
  _autosaveDebounce = setTimeout(() => {
    _performAutosave();
    _autosaveDebounce = null;
  }, 400);
}

function _onEditorContentChanged() {
  if (state.autosaveMode !== 'realtime') return;
  if (!state.autosaveEditor) return;
  if (_autosaveDebounce) clearTimeout(_autosaveDebounce);
  _autosaveDebounce = setTimeout(() => {
    _performAutosave();
    _autosaveDebounce = null;
  }, 400);
}

// OS colour-scheme listener. Only follows the OS when the user has one of the
// two preset OS-synced themes selected; custom themes are never overridden.
let _osThemeAbort = null;
function _initOsThemeListener() {
  if (_osThemeAbort) _osThemeAbort.abort();
  _osThemeAbort = new AbortController();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const followOsTheme = () => {
    if (state.theme === 'nb-dark' || state.theme === 'nb-light') {
      applyTheme(getDefaultTheme());
    }
  };
  mq.addEventListener('change', followOsTheme, { signal: _osThemeAbort.signal });
}

// Version
const STUDIO_VERSION = '1.2.33';
const GITHUB_REPO = 'DirazCoder/novapack-studio';

// Theme
const THEMES = [
  { id: 'nb-dark', label: 'NovaByte Dark', swatch: '#58a6ff' },
  { id: 'nb-light', label: 'NovaByte Light', swatch: '#58a6ff' },
  { id: 'legacy-green', label: 'Legacy Green', swatch: '#22c55e' },
  { id: 'amber', label: 'Amber', swatch: '#d2952b' },
  { id: 'nightshade', label: 'Nightshade', swatch: '#c084fc' },
  { id: 'high-contrast', label: 'High Contrast', swatch: '#ffd60a' },
  { id: 'forest', label: 'Forest', swatch: '#4ade80' },
];
const DEFAULT_THEME = 'nb-dark';
const CUSTOM_THEME_ID = 'custom';
const LEGACY_THEME_ALIASES = new Map([['midnight-blue', 'legacy-green']]);

// All CSS vars a theme can define, grouped for the custom editor UI.
// Order here drives render order in _renderCustomThemeEditor().
const CUSTOM_THEME_VARS = [
  {
    group: 'Backgrounds', vars: [
      { key: '--bg-base', label: 'Base' },
      { key: '--bg-panel', label: 'Panel' },
      { key: '--bg-raised', label: 'Raised' },
      { key: '--bg-hover', label: 'Hover' },
      { key: '--bg-active', label: 'Active' },
      { key: '--bg-overlay', label: 'Overlay' },
    ]
  },
  {
    group: 'Borders', vars: [
      { key: '--border', label: 'Border' },
      { key: '--border-mid', label: 'Border (mid)' },
    ]
  },
  {
    group: 'Accent', vars: [
      { key: '--accent', label: 'Accent' },
      { key: '--accent-dim', label: 'Accent (dim)' },
      { key: '--accent-hover', label: 'Accent (hover)' },
      { key: '--on-accent', label: 'On accent' },
    ]
  },
  {
    group: 'Text', vars: [
      { key: '--text-primary', label: 'Primary' },
      { key: '--text-mid', label: 'Mid' },
      { key: '--text-muted', label: 'Muted' },
      { key: '--text-faint', label: 'Faint' },
    ]
  },
  {
    group: 'Status colors', vars: [
      { key: '--red', label: 'Red' },
      { key: '--yellow', label: 'Yellow' },
      { key: '--orange', label: 'Orange' },
      { key: '--blue', label: 'Blue' },
    ]
  },
  {
    group: 'Hover wash', vars: [
      { key: '--hover-wash', label: 'Hover wash' },
      { key: '--hover-wash-strong', label: 'Hover wash (strong)' },
    ]
  },
];
const CUSTOM_THEME_STORAGE_KEY = 'novapack_custom_theme';

function _isValidTheme(themeId) {
  return themeId === CUSTOM_THEME_ID || THEMES.some((t) => t.id === themeId);
}

function _migrateThemeId(themeId) {
  return LEGACY_THEME_ALIASES.get(themeId) || themeId;
}

// Reads the currently-active theme's computed values for every custom var.
// Used to seed the custom editor so users start from something coherent
// instead of blank/black fields.
function _captureComputedThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const g of CUSTOM_THEME_VARS) {
    for (const v of g.vars) {
      out[v.key] = cs.getPropertyValue(v.key).trim() || '#000000';
    }
  }
  return out;
}

// Applies state.customColors as inline CSS vars on <html>. Inline styles
// override [data-theme="..."] rules, so this works without touching
// style.css. Passing null removes every inline override so the element falls
// back to whatever [data-theme] block is active.
function _applyCustomColors(colors) {
  const root = document.documentElement.style;
  for (const g of CUSTOM_THEME_VARS) {
    for (const v of g.vars) {
      if (colors && colors[v.key]) {
        root.setProperty(v.key, colors[v.key]);
      } else {
        root.removeProperty(v.key);
      }
    }
  }
}

function _syncDesignSelectionAccent() {
  const root = $('design-frame')?.contentDocument?.documentElement;
  if (!root) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#58a6ff';
  root.style.setProperty('--nb-studio-accent', accent);
}

function applyTheme(themeId) {
  const valid = _isValidTheme(themeId) ? themeId : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', valid);
  state.theme = valid;

  if (valid === CUSTOM_THEME_ID) {
    _applyCustomColors(state.customColors);
  } else {
    _applyCustomColors(null); // strip any leftover inline overrides
  }
  _applyUiDensity();
  _applyGlassEffects();
  _syncDesignSelectionAccent();
}

function _applyUiDensity() {
  document.documentElement.setAttribute('data-density', state.uiDensity === 'compact' ? 'compact' : 'comfortable');
}

function _applyGlassEffects() {
  const root = document.documentElement;
  if (state.disableGlassEffects) root.setAttribute('data-glass-effects', 'off');
  else root.removeAttribute('data-glass-effects');
}

function initFirstRunSetup() {
  const root = document.documentElement;
  const overlay = $('first-run-setup');
  if (!overlay || root.dataset.firstRunSetup !== 'true') return;

  document.addEventListener('keydown', (event) => {
    if (overlay.classList.contains('hidden')) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      return;
    }

    const altGraph = event.getModifierState?.('AltGraph') ?? false;
    const hasShortcutModifier = event.ctrlKey || event.metaKey || (event.altKey && !altGraph);
    const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(event.key);
    if (!hasShortcutModifier && !isFunctionKey) return;

    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const intro = $('setup-intro');
  const wizard = $('setup-wizard');
  const stepPanels = [...document.querySelectorAll('.setup-step')];
  const themeSelect = $('setup-theme');
  const densitySelect = $('setup-density');
  const fontSizeInput = $('setup-font-size');
  const tabSizeSelect = $('setup-tab-size');
  const wordWrapInput = $('setup-word-wrap');
  const autosaveSelect = $('setup-autosave-mode');
  const autosaveCustomField = $('setup-autosave-custom-field');
  const autosaveCustomInput = $('setup-autosave-custom');
  const autosaveManifestInput = $('setup-autosave-manifest');
  const autosaveEditorInput = $('setup-autosave-editor');
  const sidebarDockSelect = $('setup-sidebar-dock');
  const railDockSelect = $('setup-rail-dock');
  const sidebarWidthInput = $('setup-sidebar-width');
  const railWidthInput = $('setup-rail-width');
  let activeStep = 0;
  let introTimer;
  let transitionTimer;
  let finishTimer;
  let finishing = false;

  if (themeSelect) {
    if (state.theme === CUSTOM_THEME_ID) {
      const currentTheme = document.createElement('option');
      currentTheme.value = CUSTOM_THEME_ID;
      currentTheme.textContent = 'Custom (current colors)';
      themeSelect.appendChild(currentTheme);
    }
    themeSelect.value = state.theme;
  }
  if (densitySelect) densitySelect.value = state.uiDensity;

  const editorSettings = window.CM?.getSettings() ?? { fontSize: 13, tabSize: 2, wordWrap: false };
  if (fontSizeInput) fontSizeInput.value = String(editorSettings.fontSize);
  if ($('setup-font-size-value')) $('setup-font-size-value').textContent = `${editorSettings.fontSize} px`;
  if (tabSizeSelect) tabSizeSelect.value = String(editorSettings.tabSize);
  if (wordWrapInput) wordWrapInput.checked = editorSettings.wordWrap;

  const normalAutosaveModes = ['off', 'realtime', '5', '15', '30', '60'];
  const savedAutosaveMode = state.autosaveMode === 'realtime' || typeof state.autosaveMode === 'number'
    ? String(state.autosaveMode)
    : state.autosaveMode;
  const setupAutosaveMode = normalAutosaveModes.includes(savedAutosaveMode) ? savedAutosaveMode : 'custom';
  if (autosaveSelect) autosaveSelect.value = setupAutosaveMode;
  if (autosaveCustomInput) {
    const savedInterval = typeof state.autosaveMode === 'number' ? state.autosaveMode : 30;
    autosaveCustomInput.value = String(Math.max(1, Math.min(3600, savedInterval)));
  }
  autosaveCustomField?.classList.toggle('hidden', setupAutosaveMode !== 'custom');
  if (autosaveManifestInput) autosaveManifestInput.checked = state.autosaveManifest;
  if (autosaveEditorInput) autosaveEditorInput.checked = state.autosaveEditor;

  if (sidebarDockSelect) sidebarDockSelect.value = state.sidebarDock;
  if (railDockSelect) railDockSelect.value = state.railDock;
  if (sidebarWidthInput) sidebarWidthInput.value = String(state.sidebarWidth);
  if (railWidthInput) railWidthInput.value = String(state.railWidth);
  if ($('setup-sidebar-width-value')) $('setup-sidebar-width-value').textContent = `${state.sidebarWidth} px`;
  if ($('setup-rail-width-value')) $('setup-rail-width-value').textContent = `${state.railWidth} px`;

  const setStep = (index) => {
    activeStep = Math.max(0, Math.min(stepPanels.length - 1, index));
    stepPanels.forEach((panel, panelIndex) => panel.classList.toggle('hidden', panelIndex !== activeStep));
    $('setup-progress-label').textContent = `STEP ${activeStep + 1} OF ${stepPanels.length}`;
    $('setup-progress-fill').style.width = `${((activeStep + 1) / stepPanels.length) * 100}%`;
    $('setup-back').classList.toggle('hidden', activeStep === 0);
    $('setup-next').textContent = activeStep === stepPanels.length - 1 ? 'Finish setup' : 'Continue';
  };

  const syncEditorSettings = () => {
    const current = window.CM?.getSettings();
    if ($('lbl-font-size') && current) $('lbl-font-size').textContent = String(current.fontSize);
    const tabSize = $('sel-tab-size');
    if (tabSize && current) tabSize.value = String(current.tabSize);
    const wordWrap = $('chk-word-wrap');
    if (wordWrap && current) wordWrap.checked = current.wordWrap;
    _updateEditorToolbar();
  };

  const syncAutosaveSettings = () => {
    const modeSelect = $('sel-autosave-mode');
    const customInput = $('inp-autosave-custom');
    const value = typeof state.autosaveMode === 'number' ? String(state.autosaveMode) : state.autosaveMode;
    if (customInput) {
      customInput.value = typeof state.autosaveMode === 'number' ? String(state.autosaveMode) : '';
      customInput.style.display = normalAutosaveModes.includes(value) ? 'none' : '';
    }
    if (modeSelect) {
      modeSelect.value = normalAutosaveModes.includes(value) ? value : 'custom';
    }
    const manifestInput = $('chk-autosave-manifest');
    if (manifestInput) manifestInput.checked = state.autosaveManifest;
    const editorInput = $('chk-autosave-editor');
    if (editorInput) editorInput.checked = state.autosaveEditor;
  };

  const applyAutosaveMode = () => {
    const mode = autosaveSelect?.value || 'off';
    if (mode === 'custom') {
      const interval = parseInt(autosaveCustomInput?.value || '30', 10);
      state.autosaveMode = Number.isFinite(interval) ? Math.max(1, Math.min(3600, interval)) : 30;
      if (autosaveCustomInput) autosaveCustomInput.value = String(state.autosaveMode);
      autosaveCustomField?.classList.remove('hidden');
    } else {
      state.autosaveMode = mode === 'realtime' || mode === 'off' ? mode : parseInt(mode, 10);
      autosaveCustomField?.classList.add('hidden');
    }
    saveStorage();
    _applyAutosaveSettings();
    syncAutosaveSettings();
  };

  syncAutosaveSettings();

  themeSelect?.addEventListener('change', () => setTheme(themeSelect.value));
  densitySelect?.addEventListener('change', () => {
    state.uiDensity = densitySelect.value === 'compact' ? 'compact' : 'comfortable';
    _applyUiDensity();
    saveStorage();
    const settingsDensity = $('sel-ui-density');
    if (settingsDensity) settingsDensity.value = state.uiDensity;
  });

  fontSizeInput?.addEventListener('input', () => {
    const fontSize = Math.max(10, Math.min(24, parseInt(fontSizeInput.value, 10) || 13));
    window.CM?.applySettings({ fontSize });
    $('setup-font-size-value').textContent = `${fontSize} px`;
    syncEditorSettings();
  });
  tabSizeSelect?.addEventListener('change', () => {
    window.CM?.applySettings({ tabSize: parseInt(tabSizeSelect.value, 10) });
    syncEditorSettings();
  });
  wordWrapInput?.addEventListener('change', () => {
    window.CM?.applySettings({ wordWrap: wordWrapInput.checked });
    syncEditorSettings();
  });

  autosaveSelect?.addEventListener('change', applyAutosaveMode);
  autosaveCustomInput?.addEventListener('change', applyAutosaveMode);
  autosaveManifestInput?.addEventListener('change', () => {
    state.autosaveManifest = autosaveManifestInput.checked;
    saveStorage();
    _applyAutosaveSettings();
    syncAutosaveSettings();
  });
  autosaveEditorInput?.addEventListener('change', () => {
    state.autosaveEditor = autosaveEditorInput.checked;
    saveStorage();
    _applyAutosaveSettings();
    syncAutosaveSettings();
  });

  const applyLayoutSettings = (persist = false) => {
    state.sidebarDock = sidebarDockSelect?.value === 'right' ? 'right' : 'left';
    state.railDock = railDockSelect?.value === 'right' ? 'right' : 'left';
    state.sidebarWidth = Math.max(190, Math.min(360, parseInt(sidebarWidthInput?.value || '238', 10)));
    state.railWidth = Math.max(160, Math.min(320, parseInt(railWidthInput?.value || '220', 10)));
    _applyPaneDocking();
    _applySidebarWidth(state.sidebarWidth);
    const rail = $('project-rail');
    if (rail) rail.style.width = `${state.railWidth}px`;
    $('setup-sidebar-width-value').textContent = `${state.sidebarWidth} px`;
    $('setup-rail-width-value').textContent = `${state.railWidth} px`;
    $('sidebar-resize-handle')?.setAttribute('aria-valuenow', String(state.sidebarWidth));
    $('rail-resize-handle')?.setAttribute('aria-valuenow', String(state.railWidth));
    if (persist) saveStorage();
  };
  sidebarDockSelect?.addEventListener('change', () => applyLayoutSettings(true));
  railDockSelect?.addEventListener('change', () => applyLayoutSettings(true));
  sidebarWidthInput?.addEventListener('input', () => applyLayoutSettings());
  sidebarWidthInput?.addEventListener('change', () => applyLayoutSettings(true));
  railWidthInput?.addEventListener('input', () => applyLayoutSettings());
  railWidthInput?.addEventListener('change', () => applyLayoutSettings(true));

  const finish = () => {
    if (finishing) return;
    finishing = true;
    if (introTimer) clearTimeout(introTimer);
    if (transitionTimer) clearTimeout(transitionTimer);
    state.firstRunSetupComplete = true;
    saveStorage();
    root.dataset.firstRunSetup = 'false';
    const revealTutorialOffer = () => {
      overlay.classList.add('hidden');
      overlay.classList.remove('is-finishing');
      document.body.classList.remove('studio-first-run-reveal');
      setTimeout(_showStudioTutorialOffer, 180);
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      revealTutorialOffer();
      return;
    }
    overlay.classList.add('is-finishing');
    document.body.classList.add('studio-first-run-reveal');
    finishTimer = setTimeout(revealTutorialOffer, 760);
  };

  const showWizard = () => {
    if (!intro || !wizard) return;
    intro.classList.add('is-leaving');
    transitionTimer = setTimeout(() => {
      intro.classList.add('hidden');
      intro.setAttribute('aria-hidden', 'true');
      wizard.classList.remove('hidden');
      overlay.setAttribute('aria-labelledby', 'setup-wizard-title');
      $('setup-theme')?.focus();
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 480);
  };

  $('setup-skip-intro')?.addEventListener('click', () => {
    if (introTimer) clearTimeout(introTimer);
    showWizard();
  });
  $('setup-skip')?.addEventListener('click', finish);
  $('setup-back')?.addEventListener('click', () => setStep(activeStep - 1));
  $('setup-next')?.addEventListener('click', () => {
    if (activeStep === stepPanels.length - 1) finish();
    else setStep(activeStep + 1);
  });

  setStep(0);
  overlay.classList.remove('hidden');
  intro?.setAttribute('aria-hidden', 'false');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  introTimer = setTimeout(showWizard, reduceMotion ? 0 : 3200);
}

let _studioTutorialSteps = [];
let _studioTutorialIndex = 0;
let _studioTutorialFrame = 0;
let _studioTutorialPendingProject = false;
let _studioTutorialReturnTab = null;
let _studioTutorialPackageFlow = false;

function _showStudioTutorialOffer() {
  const overlay = $('studio-tutorial');
  if (!overlay) return;
  overlay.dataset.mode = 'offer';
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.inert = false;
  $('tutorial-offer')?.classList.remove('hidden');
  $('tutorial-step-content')?.classList.add('hidden');
  overlay.setAttribute('aria-labelledby', 'tutorial-offer-title');
  $('tutorial-package-start').textContent = state.projectDir
    ? 'Walk through package tabs'
    : 'Make my first package';
  $('tutorial-start')?.focus();
}

function _buildStudioTutorialSteps(packageFlow = false) {
  const projectOpen = !$('screen-project')?.classList.contains('hidden');
  const sidebarCollapsed = document.documentElement.dataset.sidebarCollapsed === 'true';
  if (packageFlow && projectOpen) {
    const steps = [
      {
        selector: '#project-rail',
        title: 'Let’s start with your project files',
        description: 'The file tree contains your app files and folders. Start from the template files, and keep the manifest and entry page in the project root.',
      },
      {
        tab: 'editor',
        selector: '#editor-toolbar',
        title: 'Build the app',
        description: 'Open your HTML, CSS, and JavaScript from the file tree. Edit and preview your app here; save your changes before packaging.',
      },
      {
        tab: 'manifest',
        selector: '#panel-manifest .manifest-workspace',
        title: 'Set the app identity',
        description: 'In Manifest, check the app name, unique reverse-domain ID, version, entry HTML file, and icon. These details identify the package in NovaByte OS.',
      },
      {
        tab: 'design',
        selector: '#design-fullscreen',
        title: 'Shape the window',
        description: 'Design lets you inspect the app visually and configure its window presentation. Check the preview and make sure the layout works at the intended size.',
      },
      {
        tab: 'permissions',
        selector: '#panel-permissions .permissions-tab-wrap',
        title: 'Request only needed permissions',
        description: 'Declare the capabilities your app actually uses and provide clear reasons. Remove permissions inherited from a starter if you do not need them.',
      },
      {
        tab: 'build',
        selector: '#panel-build .build-page',
        title: 'Review the package contents',
        description: 'Choose an output location and inspect the file preview. Resolve validation issues before building so you know what will be included.',
      },
      {
        tab: 'sign',
        selector: '#panel-sign .sign-page',
        title: 'Configure signing when needed',
        description: 'Review the signing options for your distribution. Keep private keys secure; Studio does not include them in build profiles or packages.',
      },
      {
        tab: 'git',
        selector: '#panel-git #git-workspace',
        title: 'Review your source changes',
        description: 'Source Control helps you review and commit project changes. Check for credentials or local-only files before sharing your source.',
      },
      {
        tab: 'review',
        selector: '#panel-review .review-header',
        title: 'Check the app at different sizes',
        description: 'Review simulates the app window at common viewport sizes. Treat it as a preview, then test OS-specific APIs and permissions on the target system.',
      },
      {
        tab: 'build',
        selector: '#panel-build #btn-build',
        title: 'Build your NovaByte package',
        description: 'When you are ready, return to Build and select Build Package. This tour never starts a build or changes project files; you stay in control.',
      },
    ];
    if (!sidebarCollapsed) {
      steps.splice(1, 0, {
        selector: '#btn-toggle-quick-access',
        title: 'Quick Access',
        description: 'This section keeps the Command Palette, project search, Workspaces, Source Control, and Build shortcuts close at hand.',
      });
    }
    return steps;
  }

  const steps = [
    {
      selector: '#titlebar',
      title: 'Studio title bar',
      description: 'The title bar identifies Studio and shows your current project. Use the controls at the right to minimize, maximize, or close the window.',
    },
    sidebarCollapsed
      ? {
          selector: '#btn-reopen-sidebar',
          title: 'Reopen your sidebar',
          description: 'Your sidebar is currently collapsed. Reopen it here to reach project actions, Quick Access, and Studio tools.',
        }
      : {
          selector: '#btn-new-project',
          title: 'Create or open a project',
          description: 'Start a project from a template or open an existing project folder. Your files stay together in the project tree.',
        },
  ];

  if (!sidebarCollapsed) {
    steps.push({
      selector: '#btn-toggle-quick-access',
      title: 'Quick Access',
      description: 'Expand this section for shortcuts to the Command Palette, project search, Workspaces, Source Control, and Build.',
    });
  }

  if (projectOpen) {
    steps.push(
      {
        selector: '#project-rail',
        title: 'Project files',
        description: 'Browse and organize your project files here. Select a file to open it in the editor.',
      },
      {
        selector: '#tabs',
        title: 'Studio work areas',
        description: 'Switch between the editor, manifest, visual Design view, permissions, Build, signing, Source Control, and Review.',
      },
    );
  } else {
    steps.push({
      selector: '.welcome-actions',
      title: 'Your starting point',
      description: 'Create a new app or open an existing folder here. The welcome screen also lists the most useful keyboard shortcuts.',
    });
  }

  if (!sidebarCollapsed) {
    steps.push({
      selector: '#btn-inspect',
      title: 'Inspect a package',
      description: 'Use Package Inspector to open and review an existing .novaapp package, its files, and its metadata.',
    });
    steps.push({
      selector: '#btn-help',
      title: 'Help whenever you need it',
      description: 'Open this guide again for workflows, searchable documentation, and keyboard shortcuts. You can replay this tour from Help.',
    });
  }

  return steps;
}

function _studioTutorialTargetIsVisible(target) {
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const style = window.getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function _positionStudioTutorial() {
  const overlay = $('studio-tutorial');
  const step = _studioTutorialSteps[_studioTutorialIndex];
  if (!overlay || overlay.classList.contains('hidden') || overlay.dataset.mode !== 'tour' || !step) return;

  const target = document.querySelector(step.selector);
  const spotlight = $('tutorial-spotlight');
  const card = $('tutorial-card');
  if (!_studioTutorialTargetIsVisible(target) || !spotlight || !card) {
    _advanceStudioTutorial(1);
    return;
  }

  const rect = target.getBoundingClientRect();
  const padding = 7;
  const left = Math.max(4, rect.left - padding);
  const top = Math.max(4, rect.top - padding);
  const right = Math.min(window.innerWidth - 4, rect.right + padding);
  const bottom = Math.min(window.innerHeight - 4, rect.bottom + padding);
  spotlight.style.left = `${left}px`;
  spotlight.style.top = `${top}px`;
  spotlight.style.width = `${Math.max(1, right - left)}px`;
  spotlight.style.height = `${Math.max(1, bottom - top)}px`;

  const cardRect = card.getBoundingClientRect();
  const gap = 16;
  const below = bottom + gap;
  const cardTop = below + cardRect.height <= window.innerHeight - 12
    ? below
    : Math.max(12, top - cardRect.height - gap);
  const cardLeft = Math.min(
    Math.max(12, (left + right - cardRect.width) / 2),
    Math.max(12, window.innerWidth - cardRect.width - 12),
  );
  card.style.left = `${cardLeft}px`;
  card.style.top = `${cardTop}px`;
}

function _renderStudioTutorialStep() {
  const step = _studioTutorialSteps[_studioTutorialIndex];
  if (!step) {
    _finishStudioTutorial();
    return;
  }

  $('tutorial-step-title').textContent = step.title;
  $('tutorial-step-description').textContent = step.description;
  $('tutorial-step-count').textContent = `${_studioTutorialIndex + 1} of ${_studioTutorialSteps.length}`;
  $('tutorial-progress-fill').style.width = `${((_studioTutorialIndex + 1) / _studioTutorialSteps.length) * 100}%`;
  $('tutorial-back').disabled = _studioTutorialIndex === 0;
  $('tutorial-next').textContent = _studioTutorialIndex === _studioTutorialSteps.length - 1 ? 'Finish' : 'Next';
  $('studio-tutorial').setAttribute('aria-labelledby', 'tutorial-step-title');
  if (step.tab && state.screen === 'project' && state.activeTab !== step.tab) switchTab(step.tab);
  if (_studioTutorialFrame) cancelAnimationFrame(_studioTutorialFrame);
  _studioTutorialFrame = requestAnimationFrame(() => {
    const positionAfterTabChange = () => {
      const target = document.querySelector(step.selector);
      if (_studioTutorialTargetIsVisible(target)) {
        const rect = target.getBoundingClientRect();
        const bottomClearance = Math.min(150, window.innerHeight * 0.2);
        if (rect.top < 12 || rect.bottom > window.innerHeight - bottomClearance) {
          target.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'center',
            inline: 'nearest',
          });
        }
      }
      _positionStudioTutorial();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTimeout(_positionStudioTutorial, 360);
      }
    };
    if (step.tab) setTimeout(positionAfterTabChange, 140);
    else positionAfterTabChange();
  });
}

function _advanceStudioTutorial(direction) {
  const next = _studioTutorialIndex + direction;
  if (next < 0) return;
  if (next >= _studioTutorialSteps.length) {
    _finishStudioTutorial();
    return;
  }
  _studioTutorialIndex = next;
  _renderStudioTutorialStep();
}

function _startStudioTutorial(mode = 'overview') {
  const overlay = $('studio-tutorial');
  if (!overlay) return;
  _studioTutorialPackageFlow = mode === 'package';
  _studioTutorialReturnTab = _studioTutorialPackageFlow && state.screen === 'project' ? state.activeTab : null;
  _studioTutorialSteps = _buildStudioTutorialSteps(_studioTutorialPackageFlow);
  _studioTutorialIndex = 0;
  overlay.dataset.mode = 'tour';
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.inert = false;
  $('tutorial-offer')?.classList.add('hidden');
  $('tutorial-step-content')?.classList.remove('hidden');
  _renderStudioTutorialStep();
  $('tutorial-next')?.focus();
}

function _finishStudioTutorial(restoreTab = false) {
  const overlay = $('studio-tutorial');
  if (!overlay) return;
  if (restoreTab && _studioTutorialReturnTab && state.screen === 'project') {
    switchTab(_studioTutorialReturnTab);
  }
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;
  $('tutorial-card').style.left = '';
  $('tutorial-card').style.top = '';
  $('tutorial-spotlight').style.cssText = '';
  _studioTutorialSteps = [];
  _studioTutorialReturnTab = null;
  _studioTutorialPackageFlow = false;
}

function _initStudioTutorial() {
  const overlay = $('studio-tutorial');
  const card = $('tutorial-card');
  if (!overlay || !card) return;

  $('tutorial-start')?.addEventListener('click', () => _startStudioTutorial('overview'));
  $('tutorial-skip')?.addEventListener('click', _finishStudioTutorial);
  $('tutorial-package-start')?.addEventListener('click', () => {
    if (state.projectDir && state.screen === 'project') {
      _startStudioTutorial('package');
      return;
    }
    _studioTutorialPendingProject = true;
    _finishStudioTutorial();
    openNewProjectModal();
  });
  $('tutorial-exit')?.addEventListener('click', () => _finishStudioTutorial(true));
  $('tutorial-back')?.addEventListener('click', () => _advanceStudioTutorial(-1));
  $('tutorial-next')?.addEventListener('click', () => {
    if (_studioTutorialIndex === _studioTutorialSteps.length - 1) _finishStudioTutorial(false);
    else _advanceStudioTutorial(1);
  });
  window.addEventListener('resize', _positionStudioTutorial);
  document.addEventListener('scroll', _positionStudioTutorial, true);

  document.addEventListener('keydown', (event) => {
    if (overlay.classList.contains('hidden')) return;
    const inCard = card.contains(event.target);
    const hasShortcutModifier = event.ctrlKey || event.metaKey || event.altKey;
    const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(event.key);

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      _finishStudioTutorial(true);
      return;
    }

    if (inCard && !hasShortcutModifier && event.key === 'Tab') {
      const controls = [...card.querySelectorAll('button:not(:disabled)')]
        .filter(_studioTutorialTargetIsVisible);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }

    if (overlay.dataset.mode === 'tour' && inCard && !hasShortcutModifier) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        _advanceStudioTutorial(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        _advanceStudioTutorial(-1);
        return;
      }
    }

    if (inCard && !hasShortcutModifier && !isFunctionKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) event.preventDefault();
  });
  document.addEventListener('keydown', (event) => {
    if (_studioTutorialPendingProject && event.key === 'Escape'
      && !$('modal-new-project')?.classList.contains('hidden')) {
      _studioTutorialPendingProject = false;
    }
  }, true);
  document.addEventListener('click', (event) => {
    if (!_studioTutorialPendingProject) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-close="modal-new-project"]') || target?.id === 'modal-new-project') {
      _studioTutorialPendingProject = false;
    }
  }, true);
}

function setTheme(themeId) {
  const previous = state.theme;
  // Remember the preset the user was on before going custom, so the reset
  // button can revert to something coherent.
  if (state.theme !== CUSTOM_THEME_ID && themeId === CUSTOM_THEME_ID) {
    state.lastNonCustomTheme = state.theme;
  }
  applyTheme(themeId);
  saveStorage();
  renderThemePicker();
  const settingsList = $('theme-picker-list-settings');
  const settingsMenu = $('theme-picker-menu-settings');
  if (settingsList && settingsMenu) _renderSettingsThemeList(settingsList, settingsMenu);
  _renderCustomThemeSection();
  if (previous !== state.theme) _emitStudioPluginEvent('theme:change', { previous, current: state.theme });
}

const CUSTOM_THEME_SWATCH_GRADIENT =
  'linear-gradient(135deg, #ef4444 0%, #eab308 33%, #22c55e 66%, #3b82f6 100%)';

function _themeOptionEntries() {
  return [...THEMES, { id: CUSTOM_THEME_ID, label: 'Custom', swatch: CUSTOM_THEME_SWATCH_GRADIENT }];
}

function renderThemePicker() {
  const list = $('theme-picker-list');
  if (!list) return;
  list.replaceChildren();
  for (const t of _themeOptionEntries()) {
    const btn = document.createElement('button');
    btn.className = 'theme-option' + (state.theme === t.id ? ' theme-option--active' : '');
    btn.type = 'button';
    btn.dataset.theme = t.id;
    // Swatch background is a hard-coded value or gradient from our own
    // constant, so it's safe to inject via style. Label is escaped.
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = t.swatch;
    const label = document.createElement('span');
    label.className = 'theme-option-label';
    label.textContent = t.label;
    btn.append(swatch, label);
    if (state.theme === t.id) {
      const check = document.createElement('span');
      check.className = 'theme-option-check';
      check.innerHTML = _uiIcon('check');
      btn.appendChild(check);
    }
    btn.addEventListener('click', () => {
      setTheme(t.id);
      $('theme-picker-menu')?.classList.add('hidden');
    });
    list.appendChild(btn);
  }
}

// AbortController-based teardown for the picker dropdown: one signal removes
// every listener the dropdown wiring added, so re-initialising (e.g. when
// re-entering the settings page) doesn't accumulate duplicate listeners.
let _themePickerAbort = null;
function _initThemePicker() {
  const btn = $('btn-theme-picker');
  const menu = $('theme-picker-menu');
  if (!btn || !menu) return;

  if (_themePickerAbort) _themePickerAbort.abort();
  _themePickerAbort = new AbortController();
  const { signal } = _themePickerAbort;

  renderThemePicker();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  }, { signal });

  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) {
      menu.classList.add('hidden');
    }
  }, { signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  }, { signal });
}

// Screen switching
function showScreen(name) {
  state.screen = name;
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', k !== name);
  }
  $('sidebar-resize-handle')?.classList.toggle('hidden', name !== 'project' || state.sidebarCollapsed);
}

function showSettings() {
  showScreen('settings');
}

function hideSettings() {
  const prev = state.projectDir ? 'project' : 'welcome';
  showScreen(prev);
}

// Window controls. NW.js window handles live for the app's lifetime so we
// don't need to remove these listeners.
function initWindowControls() {
  const win = nw.Window.get();
  let maximized = false;

  win.on('maximize', () => { maximized = true; });
  win.on('restore', () => { maximized = false; });
  win.on('unmaximize', () => { maximized = false; });

  $('btn-minimize').addEventListener('click', () => win.minimize());
  $('btn-maximize').addEventListener('click', () => {
    if (maximized) win.restore(); else win.maximize();
  });
  $('btn-close').addEventListener('click', async () => {
    const choice = await _promptUnsaved();
    if (choice === null) return;
    if (choice === true) {
      _closeGuardEnabled = false;
      win.close(true);
    }
  });
}

// Close guard. Intercepts the window close event when there are unsaved
// editor tabs. Prompts the user to Save / Discard / Cancel before the
// window closes.
function _hasDirtyTabs() {
  return tabs.some((t) => t.isDirty);
}

async function _promptUnsaved() {
  if (!_hasDirtyTabs()) return true;
  const names = tabs.filter((t) => t.isDirty).map((t) => path.basename(t.filePath)).join(', ');
  const choice = await _queueStudioDialog({
    type: 'confirm',
    title: 'Unsaved changes',
    message: `Changes in ${names} have not been saved.`,
    confirmLabel: 'Save and exit',
    cancelLabel: 'Exit without saving',
  });
  if (choice === null) return null;
  if (choice) {
    try { saveAllOpenFiles(); } catch { /* swallow -- we're closing anyway */ }
  }
  // The chosen action is to exit, so suppress the close guard on the second pass.
  for (const t of tabs) t.isDirty = false;
  return choice;
}

function _initCloseGuard() {
  const win = nw.Window.get();
  win.on('close', async (e) => {
    if (!_closeGuardEnabled || !_hasDirtyTabs()) return;
    e.preventDefault();
    try {
      const choice = await _promptUnsaved();
      if (choice === null) return;
      if (choice === true) {
        _closeGuardEnabled = false;
        win.close(true);
      }
    } catch (error) {
      console.error('Could not confirm closing with unsaved changes:', error);
      showToast(`Could not close safely: ${error.message}`);
    }
  });
  _closeGuardEnabled = true;
}

// Project loading

// Reads manifest.json (or novaapp.json as a legacy fallback) from a project
// directory. Returns a normalised manifest object on success, or null when
// no manifest file exists. JSON parse errors are swallowed and reported via
// a toast -- the project still loads so the user can fix the file.
const MANIFEST_FILENAMES = ['manifest.json', 'novaapp.json'];

function _readManifest(dir) {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      // Validate the bare minimum shape so downstream code can rely on the
      // fields it reads. Unknown fields are preserved as-is.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { _error: `${name}: expected a JSON object at the top level` };
      }
      if (parsed.permissions !== undefined && !Array.isArray(parsed.permissions)) {
        return { _error: `${name}: "permissions" must be an array` };
      }
      if (parsed.optionalPermissions !== undefined && !Array.isArray(parsed.optionalPermissions)) {
        return { _error: `${name}: "optionalPermissions" must be an array` };
      }
      return parsed;
    } catch (err) {
      return { _error: `${name}: ${err.message}` };
    }
  }
  return null;
}

// Tear down any watchers / drag handlers tied to the currently-open
// project. Called before opening a new project (and on reopen) so we don't
// stack handlers across loadProject() calls.
function _teardownProjectHandlers() {
  if (_fileTreeWatcher) {
    try { _fileTreeWatcher.close(); } catch { /* already closed */ }
    _fileTreeWatcher = null;
  }
  if (_fileTreeWatcherTimer) {
    clearTimeout(_fileTreeWatcherTimer);
    _fileTreeWatcherTimer = null;
  }
  if (_manifestWatcher) {
    try { _manifestWatcher.close(); } catch { /* already closed */ }
    _manifestWatcher = null;
  }
  if (_manifestWatcherTimer) {
    clearTimeout(_manifestWatcherTimer);
    _manifestWatcherTimer = null;
  }
  if (_fileTreeDragAbort) {
    _fileTreeDragAbort.abort();
    _fileTreeDragAbort = null;
  }
}

async function loadProject(dir) {
  if (!dir || typeof dir !== 'string') {
    showToast('Invalid project path');
    return;
  }
  if (!fs.existsSync(dir)) {
    await studioAlert(`Folder not found: ${dir}`, { title: 'Project folder not found' });
    return;
  }
  if (state.projectDir && state.projectDir !== dir &&
      !_designFlushPendingBeforeSelectionChange()) {
    if (_designPendingEdit) {
      if (!await studioConfirm('A pending Design edit could not be saved. Switch projects and discard that edit?', {
        title: 'Discard pending design edit',
        confirmLabel: 'Discard edit',
        danger: true,
      })) return;
      clearTimeout(_designWriteTimer);
      _designWriteTimer = null;
      _designPendingEdit = null;
    }
  }

  let manifest = { id: '', name: '', version: '1.0.0', entry: 'index.html', permissions: [] };
  const parsed = _readManifest(dir);
  if (parsed?._error) {
    showToast('Manifest parse error: ' + parsed._error);
  } else if (parsed) {
    manifest = { ...manifest, ...parsed };
  }

  state.projectDir = dir;
  state.projectName = manifest.name || path.basename(dir);
  if (_fileTreeFilterTimer) clearTimeout(_fileTreeFilterTimer);
  _fileTreeFilterTimer = null;
  $('file-tree-filter').value = '';
  $('btn-clear-file-filter')?.classList.add('hidden');
  _fileTreeExpandedBeforeFilter = null;

  $('project-breadcrumb').textContent = state.projectName + '  \u00b7  ' + dir;
  addRecent(dir, state.projectName);
  populateManifestForm(manifest);
  populateFileTree(dir);

  // Replace any watchers / drag handlers from a previously-open project.
  _teardownProjectHandlers();

  // Manifest watcher: rebuild the form when manifest.json is touched
  // externally. Debounced 150ms so a editor's atomic write+tempfile+rename
  // pattern doesn't fire twice.
  try {
    _manifestWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (eventType !== 'change' || !filename) return;
      if (filename !== 'manifest.json' && filename !== 'novaapp.json') return;
      if (_manifestWatcherTimer) clearTimeout(_manifestWatcherTimer);
      _manifestWatcherTimer = setTimeout(() => {
        _manifestWatcherTimer = null;
        if (state.projectDir !== dir) return;
        const updated = _readManifest(dir);
        if (updated && !updated._error) {
          if (state.activeTab !== 'permissions') {
            populateManifestForm(updated);
          }
          _designInvalidate();
        }
        _renderBuildContentsPreview();
      }, 150);
    });
  } catch {
    _manifestWatcher = null;
  }

  // File-tree watcher: rebuild the tree when the dir contents change.
  // Debounced 250ms to coalesce burst events (git checkout, npm install,
  // atomic save patterns). Skips events that match our own writes.
  try {
    _fileTreeWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (!filename) return;
      if (_isOwnWrite(filename)) return;
      if (_fileTreeWatcherTimer) clearTimeout(_fileTreeWatcherTimer);
      _fileTreeWatcherTimer = setTimeout(() => {
        if (state.projectDir === dir) {
          populateFileTree(dir);
          _renderBuildContentsPreview();
        }
        _fileTreeWatcherTimer = null;
      }, 250);
    });
  } catch {
    _fileTreeWatcher = null;
  }

  $('build-outdir').value = path.join(dir, 'dist');
  _renderBuildContentsPreview();
  _renderBuildProfiles();
  $('file-tree-path').textContent = dir;

  // Wire drag-and-drop on the tree. One AbortController per project so
  // re-opening a project (or opening a different one) cleanly removes the
  // previous set of listeners rather than stacking new ones on the same
  // element.
  _fileTreeDragAbort = new AbortController();
  _wireFileTreeDragDrop($('file-tree'), dir, _fileTreeDragAbort.signal);

  showScreen('project');
  _updateEditorToolbar();
  window._nbproOnProjectLoaded?.(dir);
  switchTab('editor');
  _emitStudioPluginEvent('project:open', { directory: dir, name: state.projectName });
}

// Drag-and-drop wiring for the file-tree container. Lives outside
// loadProject() so the listener set is clearly tied to one signal.
function _wireFileTreeDragDrop(tree, dir, signal) {
  if (!tree) return;
  const clearTreeDragState = () => {
    tree.classList.remove('drag-over');
    tree.querySelectorAll('.file-item.drag-over').forEach((item) => item.classList.remove('drag-over'));
  };

  tree.addEventListener('dragenter', (e) => {
    if (!_fileDragData) return;
    if (e.target.closest?.('.file-item')) tree.classList.remove('drag-over');
    else tree.classList.add('drag-over');
  }, { signal });
  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget)) clearTreeDragState();
  }, { signal });
  tree.addEventListener('dragend', clearTreeDragState, { signal });
  tree.addEventListener('dragover', (e) => {
    if (!_fileDragData) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.target.closest?.('.file-item')) tree.classList.remove('drag-over');
    else tree.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  }, { signal });
  tree.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTreeDragState();
    if (!_fileDragData) return;
    const srcPath = _fileDragData.srcPath;
    if (srcPath === dir) return;
    try {
      const targetItem = e.target.closest('.file-item');
      const destDir = targetItem
        ? (targetItem.dataset.isdir === '1' ? targetItem.dataset.path : path.dirname(targetItem.dataset.path))
        : dir;
      const baseName = path.basename(srcPath);
      const destPath = path.join(destDir, baseName);
      if (destPath !== srcPath && fs.existsSync(destPath)) {
        showToast('An item with that name already exists at the destination');
        _fileDragData = null;
        return;
      }
      if (_isDescendantOf(srcPath, destDir)) {
        showToast('Cannot move into itself');
        _fileDragData = null;
        return;
      }
      fs.renameSync(srcPath, destPath);
      showToast('Moved ' + baseName);
    } catch (err) {
      showToast('Move failed: ' + err.message);
    } finally {
      _fileDragData = null;
      populateFileTree(state.projectDir);
    }
  }, { signal });
}

function setIconPreview(src) {
  const img = $('mf-icon-img');
  img.src = src;
  img.dataset.uri = src;
  img.style.display = '';
  $('mf-icon-plus').style.display = 'none';
}

function clearIconPreview() {
  const img = $('mf-icon-img');
  img.removeAttribute('src');
  img.removeAttribute('data-uri');
  img.style.display = 'none';
  $('mf-icon-plus').style.display = '';
}

// Manifest form
function populateManifestForm(manifest) {
  $('mf-id').value = manifest.id || '';
  $('mf-name').value = manifest.name || '';
  $('mf-version').value = manifest.version || '1.0.0';
  $('mf-description').value = manifest.description || '';
  $('mf-author').value = manifest.author || '';
  $('mf-entry').value = manifest.entry || 'index.html';

  // Icon -- data URI / URL gets previewed; text value (Lucide name) goes in the input.
  const iconVal = manifest.icon || '';
  if (iconVal && /^data:|^https?:\/\//i.test(iconVal)) {
    setIconPreview(iconVal);
    $('mf-icon').value = '';
  } else {
    clearIconPreview();
    $('mf-icon').value = iconVal;
  }

  const defaultSize = manifest.defaultSize || [800, 560];
  $('mf-width').value = defaultSize[0];
  $('mf-height').value = defaultSize[1];

  const minSize = manifest.minSize || [400, 300];
  $('mf-min-width').value = minSize[0];
  $('mf-min-height').value = minSize[1];

  const maxSize = manifest.maxSize || [];
  $('mf-max-width').value = maxSize[0] || '';
  $('mf-max-height').value = maxSize[1] || '';

  $('mf-resizable').checked = manifest.resizable !== false;
  $('mf-frame').checked = manifest.frame !== false;
  $('mf-always-on-top').checked = manifest.alwaysOnTop || false;
  $('mf-start-minimized').checked = manifest.startMinimized || false;
  $('mf-transparent').checked = manifest.transparent || false;

  // Permissions -- render grouped by category with the granted ones pre-selected.
  const granted = new Set((Array.isArray(manifest.permissions) ? manifest.permissions : [])
    .filter((permission) => PERMISSION_IDS.has(permission)));
  const optionalGranted = new Set((Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : [])
    .filter((permission) => PERMISSION_IDS.has(permission)));
  _permissionDeclaredExtras = new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
  ].filter((permission) => typeof permission === 'string' && !PERMISSION_IDS.has(permission)));
  _permissionReasons = manifest.permissionReasons === undefined
    ? new Map()
    : manifest.permissionReasons && typeof manifest.permissionReasons === 'object' && !Array.isArray(manifest.permissionReasons)
      ? new Map(Object.entries(manifest.permissionReasons))
      : null;
  for (const permission of granted) optionalGranted.delete(permission);
  renderPermissions(granted, optionalGranted);

  _validateAppIdField();
  _syncWindowPreview();
  _renderManifestPreview();
}

function _renderManifestPreview() {
  const name = $('mf-name')?.value.trim() || 'Your app';
  const appId = $('mf-id')?.value.trim() || 'com.example.myapp';
  const version = $('mf-version')?.value.trim() || '1.0.0';
  const entry = $('mf-entry')?.value.trim() || 'index.html';
  const icon = $('manifest-preview-icon');
  if (icon) {
    icon.textContent = name === 'Your app' ? 'A' : [...name][0].toLocaleUpperCase();
    icon.classList.toggle('is-invalid', !!$('mf-id')?.value.trim() && !$('mf-id-status')?.classList.contains('is-valid'));
  }
  const previewName = $('manifest-preview-name');
  const previewVersion = $('manifest-preview-version');
  const previewId = $('manifest-preview-id');
  const previewEntry = $('manifest-preview-entry');
  const previewPermissions = $('manifest-preview-permissions');
  if (previewName) previewName.textContent = name;
  if (previewVersion) previewVersion.textContent = `Version ${version}`;
  if (previewId) previewId.textContent = appId;
  if (previewEntry) previewEntry.textContent = entry;
  if (previewPermissions) {
    const count = new Set([..._requiredPermissionIds, ..._optionalPermissionIds]).size;
    previewPermissions.textContent = `${count} selected`;
  }
}

function _permCategory(id) {
  if (id.startsWith('registry.') || id.startsWith('push:')) return 'system';
  if (id.startsWith('clipboard:')) return 'device';
  return id.split(':')[0];
}

let _permSearchQuery = '';
let _requiredPermissionIds = new Set();
let _optionalPermissionIds = new Set();
let _permissionMode = 'required';
let _permissionCategoryFilter = 'all';
let _permissionRiskFilter = 'all';
let _permissionReasons = new Map();
let _permissionDeclaredExtras = new Set();

function renderPermissionReasons() {
  const grid = $('permissions-reasons-grid');
  if (!grid) return;
  grid.replaceChildren();

  if (_permissionReasons === null) {
    const warning = document.createElement('div');
    warning.className = 'permissions-reasons-invalid';
    const message = document.createElement('span');
    message.textContent = 'The manifest permissionReasons value is not an object. Replace it with a valid reason map to edit reasons here.';
    const reset = document.createElement('button');
    reset.className = 'permissions-text-action';
    reset.type = 'button';
    reset.textContent = 'Replace invalid value';
    reset.addEventListener('click', () => {
      _permissionReasons = new Map();
      renderPermissionReasons();
      _onManifestFormChanged();
    });
    warning.append(message, reset);
    grid.appendChild(warning);
    $('permissions-reasons-count').textContent = 'Invalid map';
    return;
  }

  const declared = new Set([
    ..._permissionDeclaredExtras,
    ..._requiredPermissionIds,
    ..._optionalPermissionIds,
  ]);
  const ids = new Set([...declared, ..._permissionReasons.keys()]);
  const orderedIds = [...ids].sort((a, b) => {
    const ai = PERMISSIONS.findIndex((permission) => permission.id === a);
    const bi = PERMISSIONS.findIndex((permission) => permission.id === b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
    return a.localeCompare(b);
  });
  let reasonCount = 0;

  for (const id of orderedIds) {
    const permission = _PERMISSION_MAP[id];
    const value = _permissionReasons.get(id);
    const reason = typeof value === 'string' ? value : '';
    if (reason.trim()) reasonCount++;

    const field = document.createElement('label');
    field.className = 'permissions-reason-field' + (declared.has(id) ? '' : ' permissions-reason-field--inactive');
    const heading = document.createElement('span');
    heading.className = 'permissions-reason-heading';
    const name = document.createElement('span');
    name.className = 'permissions-reason-name';
    name.textContent = permission?.label || 'Unknown permission';
    const permissionId = document.createElement('code');
    permissionId.textContent = id;
    heading.append(name, permissionId);

    const textarea = document.createElement('textarea');
    textarea.className = 'permissions-reason-input';
    textarea.rows = 2;
    textarea.maxLength = 500;
    textarea.value = reason;
    textarea.placeholder = 'Describe the feature that needs this permission…';
    textarea.setAttribute('aria-label', `Reason for ${id}`);
    const footer = document.createElement('span');
    footer.className = 'permissions-reason-footer';
    const hint = document.createElement('span');
    hint.textContent = declared.has(id)
      ? (typeof value === 'string' || value === undefined ? 'Shown when this permission is requested' : 'Stored value is not text; edit or clear it to fix')
      : 'Not currently declared — kept in the manifest but will not appear in a prompt';
    const count = document.createElement('span');
    count.textContent = `${reason.length}/500`;
    footer.append(hint, count);
    textarea.addEventListener('input', () => {
      if (textarea.value.trim()) _permissionReasons.set(id, textarea.value);
      else _permissionReasons.delete(id);
      count.textContent = `${textarea.value.length}/500`;
      _onManifestFormChanged();
    });
    field.append(heading, textarea, footer);
    grid.appendChild(field);
  }

  if (!orderedIds.length) {
    const empty = document.createElement('p');
    empty.className = 'permissions-reasons-empty';
    empty.textContent = 'Select a permission to add an explanation. Existing reasons for unselected permissions will be preserved.';
    grid.appendChild(empty);
  }
  $('permissions-reasons-count').textContent = `${reasonCount} ${reasonCount === 1 ? 'reason' : 'reasons'}`;
}

function renderPermissions(granted = _requiredPermissionIds, optionalGranted = _optionalPermissionIds) {
  const grid = $('permissions-grid');
  if (!grid) return;
  _requiredPermissionIds = new Set(granted);
  _optionalPermissionIds = new Set(optionalGranted);
  grid.replaceChildren();

  const query = _permSearchQuery.trim().toLowerCase();

  // Preserve PERMISSIONS' own ordering within each group; group order
  // follows first-appearance order in PERMISSIONS rather than an
  // arbitrarily separate list, so a reorder in PERMISSIONS doesn't need a
  // matching reorder here.
  const groups = new Map();
  for (const perm of PERMISSIONS) {
    const cat = _permCategory(perm.id);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(perm);
  }
  _populatePermissionCategoryFilter(groups);

  let visibleCount = 0;
  const selectedIds = _permissionMode === 'required' ? _requiredPermissionIds : _optionalPermissionIds;

  for (const [cat, perms] of groups) {
    const matched = perms.filter((p) => {
      if (_permissionCategoryFilter !== 'all' && _permissionCategoryFilter !== cat) return false;
      if (_permissionRiskFilter !== 'all' && p.risk !== _permissionRiskFilter) return false;
      return !query ||
          p.id.toLowerCase().includes(query) ||
          p.label.toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query);
    });

    if (matched.length === 0) continue;

    const meta = PERMISSION_CATEGORIES[cat] || { label: cat, icon: _uiIcon('workspaces') };
    const section = document.createElement('div');
    section.className = 'perm-group';

    const header = document.createElement('div');
    header.className = 'perm-group-header';
    const headerIcon = document.createElement('span');
    headerIcon.className = 'perm-group-icon';
    headerIcon.setAttribute('aria-hidden', 'true');
    if (meta.icon.startsWith('<svg ')) headerIcon.innerHTML = meta.icon;
    else headerIcon.textContent = meta.icon;
    const headerLabel = document.createElement('span');
    headerLabel.className = 'perm-group-label';
    headerLabel.textContent = meta.label;
    const headerCount = document.createElement('span');
    headerCount.className = 'perm-group-count';
    header.append(headerIcon, headerLabel, headerCount);
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'perm-group-grid';

    let groupSelected = 0;
    for (const perm of matched) {
      const isSelected = selectedIds.has(perm.id);
      if (isSelected) groupSelected++;
      visibleCount++;

      const item = document.createElement('div');
      item.className = `perm-item perm-item--${perm.risk}` + (isSelected ? ' selected' : '');
      item.dataset.id = perm.id;
      item.dataset.risk = perm.risk;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      item.setAttribute('aria-label', `${perm.label}, ${perm.id}, ${perm.risk} risk${isSelected ? ', selected' : ''}. ${perm.description || ''}`);
      item.setAttribute('aria-description', perm.description || '');

      const risk = document.createElement('span');
      risk.className = `perm-risk-badge risk-badge--${perm.risk}`;
      risk.textContent = perm.risk;

      const copy = document.createElement('span');
      copy.className = 'perm-item-copy';
      const label = document.createElement('span');
      label.className = 'perm-item-label';
      label.textContent = perm.label;
      const id = document.createElement('code');
      id.className = 'perm-item-id';
      id.textContent = perm.id;
      const description = document.createElement('span');
      description.className = 'perm-item-description';
      description.textContent = perm.description || '';
      copy.append(label, id, description);
      if (perm.id === 'system:root' && _permissionMode === 'optional') {
        const requiredOnly = document.createElement('span');
        requiredOnly.className = 'perm-required-only';
        requiredOnly.textContent = 'Required only · click to move';
        copy.appendChild(requiredOnly);
      }
      const check = document.createElement('span');
      check.className = 'perm-item-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = isSelected ? _uiIcon('check') : '';
      item.append(risk, copy, check);

      if (PERMISSIONS_NEEDING_MANIFEST_FLAG.has(perm.id)) {
        const flagBadge = document.createElement('span');
        flagBadge.className = 'perm-flag-badge';
        flagBadge.title = 'This permission also requires a matching manifest opt-in.';
        flagBadge.textContent = 'OPT-IN';
        item.appendChild(flagBadge);
      }

      const toggle = () => {
        if (perm.id === 'system:root') {
          if (_permissionMode === 'optional') {
            _optionalPermissionIds.delete(perm.id);
            _requiredPermissionIds.add(perm.id);
            renderPermissions();
            showToast('system:root is a required permission');
            _onManifestFormChanged();
            return;
          }
          if (_requiredPermissionIds.has(perm.id)) _requiredPermissionIds.delete(perm.id);
          else _requiredPermissionIds.add(perm.id);
        } else {
          const current = _permissionMode === 'required' ? _requiredPermissionIds : _optionalPermissionIds;
          const other = _permissionMode === 'required' ? _optionalPermissionIds : _requiredPermissionIds;
          if (current.has(perm.id)) current.delete(perm.id);
          else {
            current.add(perm.id);
            other.delete(perm.id);
          }
        }
        const nowSelected = selectedIds.has(perm.id);
        item.classList.toggle('selected', nowSelected);
        item.setAttribute('aria-pressed', nowSelected ? 'true' : 'false');
        check.innerHTML = nowSelected ? _uiIcon('check') : '';
        _updatePermissionsSummary();
        renderPermissionReasons();
        _onManifestFormChanged();
      };
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      list.appendChild(item);
    }

    headerCount.textContent = `${groupSelected} of ${matched.length} selected`;
    section.appendChild(list);
    grid.appendChild(section);
  }

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'perm-empty-state';
    empty.textContent = query || _permissionCategoryFilter !== 'all' || _permissionRiskFilter !== 'all'
      ? 'No permissions match these filters. Try changing your search or filters.'
      : 'No permissions are available.';
    grid.appendChild(empty);
  }

  _attachPermissionTooltips();
  _updatePermissionsSummary();
  renderPermissionReasons();
}

function _populatePermissionCategoryFilter(groups) {
  const filter = $('permissions-category-filter');
  if (!filter || filter.dataset.initialized) return;
  for (const category of groups.keys()) {
    const meta = PERMISSION_CATEGORIES[category] || { label: category };
    const option = document.createElement('option');
    option.value = category;
    option.textContent = meta.label;
    filter.appendChild(option);
  }
  filter.value = _permissionCategoryFilter;
  filter.dataset.initialized = 'true';
}

function _updatePermissionsSummary() {
  const summary = $('permissions-summary');
  if (!summary) return;
  const current = _permissionMode === 'required' ? _requiredPermissionIds : _optionalPermissionIds;
  const allSelected = new Set([..._requiredPermissionIds, ..._optionalPermissionIds]);
  const riskCount = [...allSelected].filter((id) => {
    const risk = _PERMISSION_MAP[id]?.risk;
    return risk === 'high' || risk === 'critical';
  }).length;
  summary.textContent = `${current.size} ${_permissionMode} selected`;
  if ($('permissions-total-count')) $('permissions-total-count').textContent = String(allSelected.size);
  if ($('permissions-risk-count')) $('permissions-risk-count').textContent = String(riskCount);
  if ($('permissions-catalog-count')) $('permissions-catalog-count').textContent = String(PERMISSIONS.length);
  if ($('permissions-required-count')) $('permissions-required-count').textContent = String(_requiredPermissionIds.size);
  if ($('permissions-optional-count')) $('permissions-optional-count').textContent = String(_optionalPermissionIds.size);
  const status = $('permissions-header-status');
  if (status) status.textContent = state.projectDir ? state.projectName || path.basename(state.projectDir) : 'No project loaded';
  const modeDescription = $('permissions-mode-description');
  if (modeDescription) modeDescription.textContent = _permissionMode === 'required'
    ? 'Required permissions are declared in the manifest; OS grant behavior depends on risk and user settings.'
    : 'Optional grants are requested by your app at runtime; it must work when users decline.';
  const clearButton = $('permissions-clear');
  if (clearButton) clearButton.textContent = `Clear ${_permissionMode}`;
  const requiredTab = $('permissions-mode-required');
  const optionalTab = $('permissions-mode-optional');
  requiredTab?.classList.toggle('is-active', _permissionMode === 'required');
  optionalTab?.classList.toggle('is-active', _permissionMode === 'optional');
  requiredTab?.setAttribute('aria-pressed', _permissionMode === 'required' ? 'true' : 'false');
  optionalTab?.setAttribute('aria-pressed', _permissionMode === 'optional' ? 'true' : 'false');
}

function _initPermissionsSearch() {
  const input = $('permissions-search');
  if (!input) return;
  input.addEventListener('input', () => {
    _permSearchQuery = input.value;
    renderPermissions();
  });
  $('permissions-category-filter')?.addEventListener('change', (event) => {
    _permissionCategoryFilter = event.target.value;
    renderPermissions();
  });
  $('permissions-risk-filter')?.addEventListener('change', (event) => {
    _permissionRiskFilter = event.target.value;
    renderPermissions();
  });
  $('permissions-mode-required')?.addEventListener('click', () => {
    _permissionMode = 'required';
    renderPermissions();
  });
  $('permissions-mode-optional')?.addEventListener('click', () => {
    _permissionMode = 'optional';
    renderPermissions();
  });
  $('permissions-select-low')?.addEventListener('click', () => {
    const current = _permissionMode === 'required' ? _requiredPermissionIds : _optionalPermissionIds;
    const other = _permissionMode === 'required' ? _optionalPermissionIds : _requiredPermissionIds;
    for (const item of $('permissions-grid')?.querySelectorAll('.perm-item[data-risk="low"]') || []) {
      const id = item.dataset.id;
      if (_permissionMode === 'optional' && id === 'system:root') continue;
      current.add(id);
      other.delete(id);
    }
    renderPermissions();
    _onManifestFormChanged();
  });
  $('permissions-clear')?.addEventListener('click', () => {
    const current = _permissionMode === 'required' ? _requiredPermissionIds : _optionalPermissionIds;
    current.clear();
    renderPermissions();
    _onManifestFormChanged();
  });
}

function _attachPermissionTooltips() {
  const tooltip = $('perm-tooltip');
  const dot = $('perm-tooltip-dot');
  const idEl = $('perm-tooltip-id');
  const riskEl = $('perm-tooltip-risk');
  const body = $('perm-tooltip-body');
  if (!tooltip || !dot || !idEl || !riskEl || !body) return;

  const riskColors = {
    low: '#3fb950',
    medium: '#d29922',
    high: '#f0883e',
    critical: '#f85149',
  };

  const clear = () => {
    tooltip.classList.add('hidden');
    tooltip.classList.remove('is-visible');
  };

  document.querySelectorAll('#permissions-grid .perm-item').forEach((item) => {
    const perm = _PERMISSION_MAP[item.dataset.id];
    if (!perm) return;

    item.addEventListener('mouseenter', (e) => {
      dot.style.background = riskColors[perm.risk] || '#8b949e';
      idEl.textContent = perm.id;
      riskEl.textContent = `${perm.risk} risk`;
      riskEl.dataset.risk = perm.risk;
      body.textContent = perm.description || '';
      item.setAttribute('aria-describedby', 'perm-tooltip');
      tooltip.classList.remove('hidden');
      tooltip.classList.add('is-visible');
      _positionPermTooltip(e.clientX, e.clientY);
    });

    item.addEventListener('mouseleave', () => {
      clear();
    });

    item.addEventListener('mousemove', (e) => {
      _positionPermTooltip(e.clientX, e.clientY);
    });
  });
}

function _positionPermTooltip(x, y) {
  const tooltip = $('perm-tooltip');
  if (!tooltip) return;
  const pad = 12;
  let left = x + pad;
  let top = y + pad;
  const rect = tooltip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - pad) top = y - rect.height - pad;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function _initEditorPermissionHover() {
  const tooltip = $('perm-tooltip');
  const dot = $('perm-tooltip-dot');
  const idEl = $('perm-tooltip-id');
  const riskEl = $('perm-tooltip-risk');
  const body = $('perm-tooltip-body');
  if (!tooltip || !dot || !idEl || !riskEl || !body) return;

  const riskColors = {
    low: '#3fb950',
    medium: '#d29922',
    high: '#f0883e',
    critical: '#f85149',
  };

  const clear = () => {
    tooltip.classList.add('hidden');
    tooltip.classList.remove('is-visible');
  };

  const editorHost = $('cm-editor-host');
  if (!editorHost) return;

  let pinned = false;
  const showAt = (event, view) => {
    let pos;
    try {
      pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    } catch {
      clear();
      return false;
    }
    if (pos == null) { clear(); return false; }

    const line = view.state.doc.lineAt(pos);
    const match = _permissionAtLinePosition(line.text, pos - line.from);
    if (!match) { clear(); return false; }

    dot.style.background = riskColors[match.permission.risk] || '#8b949e';
    idEl.textContent = match.id;
    riskEl.textContent = `${match.permission.risk} risk`;
    riskEl.dataset.risk = match.permission.risk;
    body.textContent = match.permission.description || '';
    tooltip.classList.remove('hidden');
    tooltip.classList.add('is-visible');
    _positionPermTooltip(event.clientX, event.clientY);
    return true;
  };

  window.CM?.setPermissionHoverHandler((type, event, view) => {
    if (type === 'leave') {
      if (!pinned) clear();
      return;
    }
    if (type === 'click') {
      pinned = showAt(event, view);
      return;
    }
    if (!pinned) showAt(event, view);
  });

  document.addEventListener('click', (e) => {
    if (editorHost.contains(e.target)) return;
    pinned = false;
    clear();
  });
}

function readManifestForm() {
  // parseInt with radix 10 and explicit fallback. NaN falls back to the
  // default so an empty field doesn't produce a NaN in the manifest.
  const width = parseInt($('mf-width').value, 10) || 800;
  const height = parseInt($('mf-height').value, 10) || 560;
  const minWidth = parseInt($('mf-min-width').value, 10) || 400;
  const minHeight = parseInt($('mf-min-height').value, 10) || 300;
  const maxWidth = parseInt($('mf-max-width').value, 10) || undefined;
  const maxHeight = parseInt($('mf-max-height').value, 10) || undefined;

  const selectedPerms = [..._requiredPermissionIds];
  const selectedOptionalPerms = [..._optionalPermissionIds].filter((id) => !_requiredPermissionIds.has(id));

  const diskManifest = state.projectDir ? _readManifest(state.projectDir) : null;
  const manifest = diskManifest && !diskManifest._error ? { ...diskManifest } : {};
  const existingPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const preservedPermissions = existingPermissions.filter((permission) => !PERMISSION_IDS.has(permission));
  const hadOptionalPermissions = Array.isArray(manifest.optionalPermissions);
  const existingOptionalPermissions = hadOptionalPermissions ? manifest.optionalPermissions : [];
  const preservedOptionalPermissions = existingOptionalPermissions.filter((permission) => !PERMISSION_IDS.has(permission));

  Object.assign(manifest, {
    id: $('mf-id').value.trim(),
    name: $('mf-name').value.trim(),
    version: $('mf-version').value.trim() || '1.0.0',
    entry: $('mf-entry').value.trim() || 'index.html',
    permissions: [...new Set([...preservedPermissions, ...selectedPerms])],
  });
  if (hadOptionalPermissions || selectedOptionalPerms.length) {
    manifest.optionalPermissions = [...new Set([...preservedOptionalPermissions, ...selectedOptionalPerms])];
  } else {
    delete manifest.optionalPermissions;
  }
  if (_permissionReasons !== null) {
    const reasons = Object.fromEntries([..._permissionReasons].map(([permission, reason]) => [
      permission,
      typeof reason === 'string' ? reason.trim() : reason,
    ]).filter(([, reason]) => typeof reason !== 'string' || reason.length > 0));
    if (Object.keys(reasons).length) manifest.permissionReasons = reasons;
    else delete manifest.permissionReasons;
  }

  manifest.description = $('mf-description').value.trim() || undefined;
  manifest.author = $('mf-author').value.trim() || undefined;

  // Icon: prefer uploaded data URI, fall back to text field (Lucide name).
  const iconDataUri = $('mf-icon-img').dataset.uri || '';
  const iconText = $('mf-icon').value.trim();
  if (iconDataUri) manifest.icon = iconDataUri;
  else if (iconText) manifest.icon = iconText;
  else manifest.icon = undefined;

  manifest.defaultSize = [width, height];
  manifest.minSize = [minWidth, minHeight];
  manifest.maxSize = (maxWidth !== undefined && maxHeight !== undefined && Number.isFinite(maxWidth) && Number.isFinite(maxHeight))
    ? [maxWidth, maxHeight]
    : undefined;
  manifest.resizable = $('mf-resizable').checked;
  manifest.frame = $('mf-frame').checked;
  manifest.alwaysOnTop = $('mf-always-on-top').checked;
  manifest.startMinimized = $('mf-start-minimized').checked;
  manifest.transparent = $('mf-transparent').checked;

  return manifest;
}

function _windowSettingsError() {
  const fields = [
    ['mf-width', 'Default width'],
    ['mf-height', 'Default height'],
    ['mf-min-width', 'Minimum width'],
    ['mf-min-height', 'Minimum height'],
    ['mf-max-width', 'Maximum width'],
    ['mf-max-height', 'Maximum height'],
  ];
  for (const [id, label] of fields) {
    const raw = $(id)?.value.trim() || '';
    if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw)))) {
      return `${label} must be a positive whole number.`;
    }
  }
  const width = Number($('mf-width')?.value) || 800;
  const height = Number($('mf-height')?.value) || 560;
  const minWidth = Number($('mf-min-width')?.value) || 400;
  const minHeight = Number($('mf-min-height')?.value) || 300;
  const maxWidthRaw = $('mf-max-width')?.value.trim() || '';
  const maxHeightRaw = $('mf-max-height')?.value.trim() || '';
  if ((maxWidthRaw === '') !== (maxHeightRaw === '')) {
    return 'Set both maximum dimensions, or leave both blank.';
  }
  if (minWidth > width || minHeight > height) {
    return 'Default dimensions must be at least as large as their minimum dimensions.';
  }
  if (maxWidthRaw && (Number(maxWidthRaw) < width || Number(maxHeightRaw) < height ||
      Number(maxWidthRaw) < minWidth || Number(maxHeightRaw) < minHeight)) {
    return 'Maximum dimensions must be at least as large as the defaults and minimums.';
  }
  return '';
}

async function saveManifest() {
  if (!state.projectDir) return false;
  const windowError = _windowSettingsError();
  if (windowError) {
    await studioAlert(windowError, { title: 'Check window dimensions' });
    return false;
  }
  const manifest = readManifestForm();

  if (!manifest.id || !manifest.name) {
    await studioAlert('App ID and Name are required.', { title: 'Manifest needs an app ID and name' });
    return false;
  }

  try {
    const outPath = path.join(state.projectDir, 'manifest.json');
    const savedJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(outPath, savedJson);
    _markOwnWrite(outPath);
    state.projectName = manifest.name;
    $('project-breadcrumb').textContent = state.projectName + '  \u00b7  ' + state.projectDir;
    addRecent(state.projectDir, state.projectName);
    showToast('manifest.json saved');
    _designInvalidate();

    const manifestTab = tabs.find((t) => t.filePath === outPath);
    if (manifestTab) {
      manifestTab.originalContent = savedJson;
      manifestTab.isDirty = false;
      _renderTabs();
      if (window.CM && _getActiveTab()?.filePath === outPath) {
        window.CM.setValue(savedJson);
      }
    }
    return true;
  } catch (err) {
    await studioAlert('Could not save manifest: ' + err.message, { title: 'Manifest save failed' });
    return false;
  }
}

// App ID live validation. Mirrors the exact rule builder.js enforces at
// Build time (see build() in src/sdk/builder.js) so an invalid ID is caught
// here instead of surfacing as a build failure in a different tab.
const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

function _validateAppIdField() {
  const input = $('mf-id');
  const status = $('mf-id-status');
  const feedback = $('mf-id-feedback');
  if (!input || !status || !feedback) return;

  const value = input.value.trim();

  if (!value) {
    input.classList.remove('is-invalid');
    status.textContent = '';
    status.className = 'mf-id-status';
    feedback.textContent = '';
    feedback.className = 'mf-id-feedback';
    return;
  }

  const valid = value.startsWith('webapp_') || APP_ID_RE.test(value);

  input.classList.toggle('is-invalid', !valid);
  status.innerHTML = valid ? _uiIcon('check') : _uiIcon('close');
  status.className = 'mf-id-status ' + (valid ? 'is-valid' : 'is-invalid');
  feedback.className = 'mf-id-feedback ' + (valid ? 'is-valid' : 'is-invalid');
  feedback.textContent = valid
    ? 'Looks good.'
    : 'Use reverse-domain format, e.g. com.example.myapp (lowercase, at least one dot).';
}

// Window designer preview. A scaled, draggable representation of
// defaultSize/minSize/maxSize so you can see the window's actual proportions
// instead of just typing numbers blind. Dragging the corner handle writes
// straight back into the existing mf-width/mf-height inputs, so
// readManifestForm() needs no changes.
const _WINDOW_PREVIEW_SCALE_MAX = 120; // px -- the larger dimension is capped to this,
                                       // comfortably under the 150px stage height so
                                       // the box (plus its shadow/handle) never clips
                                       // regardless of aspect ratio

// Single source of truth for the box's scale factor. Both the idle sync
// (typing in fields) and the active drag path call this exact function --
// previously the drag handler computed its own scale from the box's
// rendered rect at mousedown while _syncWindowPreview independently
// recomputed a *different* scale every mousemove (based on whichever of
// width/height was momentarily larger). Those two disagreeing scales
// fighting each other every frame is what made dragging feel broken:
// the box would jump/rescale non-linearly relative to the mouse instead
// of tracking it 1:1.
function _windowPreviewScale(width, height) {
  return _WINDOW_PREVIEW_SCALE_MAX / Math.max(width, height, 1);
}

function _renderWindowPreviewBox(width, height) {
  const box = $('window-preview-box');
  const dims = $('window-preview-dims');
  if (!box || !dims) return;

  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 800;
  const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 560;
  const scale = _windowPreviewScale(safeWidth, safeHeight);
  box.style.width = `${Math.round(safeWidth * scale)}px`;
  box.style.height = `${Math.round(safeHeight * scale)}px`;

  box.classList.toggle('is-frameless', !$('mf-frame').checked);
  box.classList.toggle('is-transparent', !!$('mf-transparent').checked);

  dims.textContent = `${safeWidth} \u00d7 ${safeHeight}`;
}

function _syncWindowPreview() {
  const widthValue = Number($('mf-width').value);
  const heightValue = Number($('mf-height').value);
  const width = Number.isFinite(widthValue) && widthValue > 0 ? widthValue : 800;
  const height = Number.isFinite(heightValue) && heightValue > 0 ? heightValue : 560;
  _renderWindowPreviewBox(width, height);
}

function initWindowDesigner() {
  const handle = $('window-preview-handle');
  const box = $('window-preview-box');
  const stage = $('window-preview-stage');
  if (!handle || !box || !stage) return;

  const widthInput = $('mf-width');
  const heightInput = $('mf-height');

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let scale = 1;

  const minWidth = () => parseInt($('mf-min-width').value, 10) || 200;
  const minHeight = () => parseInt($('mf-min-height').value, 10) || 150;
  const maxWidth = () => Math.max(minWidth(), parseInt($('mf-max-width').value, 10) || 3000);
  const maxHeight = () => Math.max(minHeight(), parseInt($('mf-max-height').value, 10) || 2000);

  const onMouseMove = (e) => {
    if (!dragging) return;
    const dx = (e.clientX - startX) / scale;
    const dy = (e.clientY - startY) / scale;

    const nextWidth = Math.min(maxWidth(), Math.max(minWidth(), Math.round(startWidth + dx)));
    const nextHeight = Math.min(maxHeight(), Math.max(minHeight(), Math.round(startHeight + dy)));

    widthInput.value = nextWidth;
    heightInput.value = nextHeight;

    // Render directly at the fixed drag-start scale instead of calling
    // _syncWindowPreview() -- that would recompute a fresh scale from
    // Math.max(nextWidth, nextHeight) every frame, which drifts from
    // `scale` as soon as the box isn't perfectly square and is the root
    // cause of the jumpy/broken-feeling drag.
    box.style.width = `${Math.round(nextWidth * scale)}px`;
    box.style.height = `${Math.round(nextHeight * scale)}px`;
    box.classList.toggle('is-frameless', !$('mf-frame').checked);
    box.classList.toggle('is-transparent', !!$('mf-transparent').checked);
    $('window-preview-dims').textContent = `${nextWidth} \u00d7 ${nextHeight}`;

    _onManifestFormChanged();
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // Re-derive the canonical fit-to-stage scale now that dragging has
    // stopped, so the box is exactly where _syncWindowPreview would put
    // it on any future re-render (e.g. switching tabs and back).
    _syncWindowPreview();
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = parseInt(widthInput.value, 10) || 800;
    startHeight = parseInt(heightInput.value, 10) || 560;
    // Freeze the scale for the whole drag using the same formula the idle
    // state uses -- not the box's rendered rect (which is Math.round()'d
    // and can be off by a fraction of a px, compounding into visible drift
    // over a long drag).
    scale = _windowPreviewScale(startWidth, startHeight);
    box.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Keep the preview in sync with direct typing in the numeric fields too.
  ['mf-width', 'mf-height', 'mf-frame', 'mf-transparent'].forEach((id) => {
    $(id)?.addEventListener('input', _syncWindowPreview);
    $(id)?.addEventListener('change', _syncWindowPreview);
  });

  const dimensionIds = ['mf-width', 'mf-height', 'mf-min-width', 'mf-min-height', 'mf-max-width', 'mf-max-height'];
  const updateDimensionFeedback = () => {
    const feedback = $('window-dimension-feedback');
    if (!feedback) return;
    const error = _windowSettingsError();
    feedback.textContent = error || 'Maximum dimensions are optional; leave both blank for no limit.';
    feedback.classList.toggle('is-error', Boolean(error));
  };

  document.querySelectorAll('.window-size-preset').forEach((preset) => {
    preset.addEventListener('click', () => {
      const width = Number(preset.dataset.width);
      const height = Number(preset.dataset.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return;
      widthInput.value = String(width);
      heightInput.value = String(height);
      widthInput.dispatchEvent(new Event('input', { bubbles: true }));
      heightInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  $('window-size-reset')?.addEventListener('click', () => {
    widthInput.value = '800';
    heightInput.value = '560';
    $('mf-min-width').value = '400';
    $('mf-min-height').value = '300';
    $('mf-max-width').value = '';
    $('mf-max-height').value = '';
    dimensionIds.forEach((id) => $(id).dispatchEvent(new Event('input', { bubbles: true })));
  });

  dimensionIds.forEach((id) => {
    $(id)?.addEventListener('input', updateDimensionFeedback);
    $(id)?.addEventListener('change', updateDimensionFeedback);
  });

  $('mf-id')?.addEventListener('input', _validateAppIdField);

  _syncWindowPreview();
  updateDimensionFeedback();
}


// Design tab: live click-to-select canvas over the project's manifest entry HTML,
// with an Attributes sidebar for editing the selected element and writing
// changes back to disk.
//
// Three things this module is deliberately built around, because earlier
// versions got each of these wrong:
//
// 1. SURGICAL WRITES, NOT FULL-FILE OVERWRITES. Every edit re-parses the
//    *current on-disk* entry HTML and linked stylesheets with parse5/css (both track
//    exact source offsets), finds only the node/declaration that changed,
//    and splices just that span. This preserves whatever formatting,
//    comments, and structure the file already had, and means a hand-edit
//    made in the Editor tab in between Design edits doesn't get clobbered
//    by a stale in-memory copy.
//
// 2. CLASS-AWARE STYLE EDITS. If the selected element has a class and
//    that class has a real rule in a linked stylesheet, editing e.g. "background"
//    patches the CSS rule itself. Only falls back to an inline style
//    attribute when there's no stylesheet rule to patch into -- and the
//    Attributes panel says which mode is active so it's never a silent
//    guess.
//
// 3. NO RELOAD-ON-TAB-SWITCH. The iframe is loaded once per project (or
//    after an external file change invalidates it) and just shown/hidden
//    on tab switches after that, so the page's own scripts don't
//    re-execute and any in-page state doesn't reset every time you look
//    away and back.
//
// Selection mechanics: a small script is injected into the iframe's
// srcdoc. It never touches the source files -- it tags each element in
// the *rendered* DOM with a data-nb-design-id whose value is that
// element's path in the DOM tree (e.g. "1.2.0"), matching parse5's node
// ordering, and posts click/hover/edit-intent info up to the parent via
// postMessage. The parent does the actual reading/writing of files; the
// iframe only ever mutates its own live DOM for immediate visual
// feedback, then asks the parent to persist.

const _DESIGN_WRITE_DEBOUNCE_MS = 400;

let _designSelectedPath = null; // e.g. [1,2,0] -- indices from <html> down
let _designSelectedTag = null;  // tag name at that path, for drift checks
let _designWriteTimer = null;
let _designPendingEdit = null;  // most recent edit payload, applied on flush
let _designFrameLoadedForDir = null; // projectDir the iframe was last loaded for
let _designUndoStack = [];
let _designRedoStack = [];
let _designUndoProjectDir = null;
let _designReloadPreserveSelection = false;
const _DESIGN_MAX_UNDO = 50;

function _designSnapshotFiles() {
  const htmlPath = _designIndexPath();
  if (!htmlPath) return null;
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); }
  catch (err) {
    showToast('Design: could not read the entry HTML for undo: ' + err.message);
    return null;
  }
  const paths = _designProjectFiles(html, htmlPath).stylesheets;
  const css = {};
  try {
    for (const filePath of paths) {
      css[filePath] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    }
  } catch (err) {
    showToast('Design: could not read a linked stylesheet for undo: ' + err.message);
    return null;
  }
  return { html, css };
}

function _designPushUndo(label) {
  if (_designUndoProjectDir !== state.projectDir) {
    _designUndoStack = [];
    _designRedoStack = [];
    _designUndoProjectDir = state.projectDir;
  }
  const snapshot = _designSnapshotFiles();
  if (!snapshot) {
    showToast('Design: open a project before editing.');
    return false;
  }
  _designUndoStack.push({ ...snapshot, label: label || 'edit' });
  if (_designUndoStack.length > _DESIGN_MAX_UNDO) _designUndoStack.shift();
  _designRedoStack.length = 0;
  return true;
}

function _designWriteSnapshot(target, current, htmlPath, action) {
  const restoreFile = (filePath, content) => {
    if (!filePath) return;
    if (content === null) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  };
  const cssPaths = Object.keys(target.css || {});
  const rollbackCss = new Map();
  try {
    for (const cssPath of cssPaths) {
      rollbackCss.set(cssPath, fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : null);
    }
  } catch (err) {
    showToast(`Could not read linked stylesheets before ${action}: ${err.message}`);
    return false;
  }
  try {
    for (const cssPath of cssPaths) {
      if (Object.prototype.hasOwnProperty.call(target.css, cssPath)) {
        restoreFile(cssPath, target.css[cssPath]);
      }
    }
    restoreFile(htmlPath, target.html);
    _designNoteOwnWrite();
    return true;
  } catch (err) {
    const rollbackErrors = [];
    for (const [filePath, content] of [
      [htmlPath, current.html],
      ...rollbackCss,
    ]) {
      try { restoreFile(filePath, content); }
      catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); }
    }
    _designNoteOwnWrite();
    const rollbackMessage = rollbackErrors.length
      ? ` Rollback was incomplete: ${rollbackErrors.join('; ')}`
      : '';
    showToast(`Could not ${action}: ${err.message}.${rollbackMessage}`);
    return false;
  }
}

function _designDoUndo() {
  if (!_designUndoStack.length) { showToast('Nothing to undo'); return; }
  if (_designUndoProjectDir !== state.projectDir) {
    _designUndoStack = [];
    _designRedoStack = [];
    _designUndoProjectDir = state.projectDir;
    showToast('Design: undo history was cleared after switching projects.');
    return;
  }
  const htmlPath = _designIndexPath();
  if (!htmlPath) { showToast('Design: open a project before undoing.'); return; }
  const current = _designSnapshotFiles();
  if (!current) return;
  const prev = _designUndoStack[_designUndoStack.length - 1];
  if (!_designWriteSnapshot(prev, current, htmlPath, 'undo')) return;
  _designUndoStack.pop();
  _designRedoStack.push(current);
  showToast('Undo: ' + (prev.label || 'edit'));
  _designReloadFrame();
}

function _designDoRedo() {
  if (!_designRedoStack.length) { showToast('Nothing to redo'); return; }
  if (_designUndoProjectDir !== state.projectDir) {
    _designUndoStack = [];
    _designRedoStack = [];
    _designUndoProjectDir = state.projectDir;
    showToast('Design: redo history was cleared after switching projects.');
    return;
  }
  const htmlPath = _designIndexPath();
  if (!htmlPath) { showToast('Design: open a project before redoing.'); return; }
  const current = _designSnapshotFiles();
  if (!current) return;
  const next = _designRedoStack[_designRedoStack.length - 1];
  if (!_designWriteSnapshot(next, current, htmlPath, 'redo')) return;
  _designRedoStack.pop();
  _designUndoStack.push(current);
  if (_designUndoStack.length > _DESIGN_MAX_UNDO) _designUndoStack.shift();
  showToast('Redo: ' + (next.label || 'edit'));
  _designReloadFrame();
}

function _designReloadFrame(preserveSelection = false) {
  const frame = $('design-frame');
  if (frame && state.projectDir) {
    _designFrameLoadedForDir = null;
    _designReloadPreserveSelection = preserveSelection;
    try {
      _designLoadFrame(true);
    } finally {
      _designReloadPreserveSelection = false;
    }
  }
}

function _designIndexPath() {
  if (!state.projectDir) return null;
  const manifest = _readManifest(state.projectDir);
  const entry = typeof manifest?.entry === 'string' && manifest.entry.trim()
    ? manifest.entry.trim()
    : 'index.html';
  const projectRoot = path.resolve(state.projectDir);
  const candidate = path.resolve(projectRoot, entry);
  const relative = path.relative(projectRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;

  let rootReal;
  try { rootReal = fs.realpathSync(projectRoot); }
  catch (err) {
    if (err.code === 'ENOENT') return candidate;
    showToast('Design: could not resolve the project directory: ' + err.message);
    return null;
  }
  let probe = candidate;
  let probeReal;
  while (true) {
    try {
      probeReal = fs.realpathSync(probe);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        showToast('Design: could not resolve the entry HTML path: ' + err.message);
        return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  const realRelative = path.relative(rootReal, probeReal);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  const resolvedPath = path.resolve(probeReal, path.relative(probe, candidate));
  const finalRelative = path.relative(rootReal, resolvedPath);
  return finalRelative && finalRelative !== '..' &&
    !finalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(finalRelative)
    ? resolvedPath
    : null;
}

function _designProjectFiles(htmlText, htmlPath = _designIndexPath()) {
  if (!state.projectDir || !htmlPath) return { stylesheets: [], scripts: [] };
  let root = path.resolve(state.projectDir);
  try { root = fs.realpathSync(root); } catch { /* project may be newly created */ }
  const doc = parse5.parse(htmlText, { sourceCodeLocationInfo: false });
  let baseHref = null;
  const findBase = (node) => {
    if (baseHref !== null) return;
    if (node.tagName === 'base') {
      baseHref = node.attrs?.find((attr) => attr.name === 'href')?.value ?? null;
      if (baseHref !== null) return;
    }
    for (const child of node.childNodes || []) findBase(child);
  };
  findBase(doc);
  let assetBase = pathToFileURL(htmlPath).href;
  if (baseHref) {
    try { assetBase = new URL(baseHref, assetBase).href; }
    catch { /* invalid base URL means local references cannot be resolved reliably */ }
  }
  const insideProject = (filePath) => {
    const relative = path.relative(root, filePath);
    return relative !== '' && relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const resolveReference = (value) => {
    if (!value || /^(?:data:|blob:|javascript:|#)/i.test(value.trim())) return null;
    try {
      const reference = value.trim().replace(/\\/g, '/');
      const url = new URL(reference, assetBase);
      if (url.protocol !== 'file:') return null;
      let filePath = path.resolve(fileURLToPath(url));
      if (!insideProject(filePath)) return null;
      try {
        filePath = fs.realpathSync(filePath);
        if (!insideProject(filePath)) return null;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return filePath;
    } catch {
      return null;
    }
  };
  const stylesheets = new Set();
  const scripts = new Set();
  const visit = (node) => {
    if (node.tagName === 'link') {
      const rel = node.attrs?.find((attr) => attr.name === 'rel')?.value || '';
      const href = node.attrs?.find((attr) => attr.name === 'href')?.value || '';
      if (rel.toLowerCase().split(/\s+/).includes('stylesheet')) {
        const filePath = resolveReference(href);
        if (filePath && path.extname(filePath).toLowerCase() === '.css') stylesheets.add(filePath);
      }
    } else if (node.tagName === 'script') {
      const src = node.attrs?.find((attr) => attr.name === 'src')?.value || '';
      const filePath = resolveReference(src);
      if (filePath && /\.(?:m?js|cjs)$/i.test(filePath)) scripts.add(filePath);
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(doc);
  return { stylesheets: [...stylesheets], scripts: [...scripts] };
}

function _designLinkedCssPaths(htmlState) {
  const entry = htmlState || _designReadHtml();
  return entry ? _designProjectFiles(entry.text, entry.path).stylesheets : [];
}

function _designGetProjectFiles() {
  const htmlState = _designReadHtml();
  return htmlState
    ? { html: htmlState.path, ..._designProjectFiles(htmlState.text, htmlState.path) }
    : { html: _designIndexPath(), stylesheets: [], scripts: [] };
}
if (typeof window !== 'undefined') window._designGetProjectFiles = _designGetProjectFiles;
function _designIsEntryAsset(filePath) {
  if (!state.projectDir || !filePath) return false;
  const projectFiles = _designGetProjectFiles();
  const canonical = (assetPath) => {
    try { return fs.realpathSync(assetPath); }
    catch { return path.resolve(assetPath); }
  };
  const candidate = canonical(filePath);
  return [projectFiles.html, ...projectFiles.stylesheets, ...projectFiles.scripts]
    .filter(Boolean)
    .some((assetPath) => path.relative(canonical(assetPath), candidate) === '');
}

// Writes a minimal starter index.html so a brand-new project has
// something the Design canvas can actually render and select into.
// Deliberately tiny -- a <body> with one placeholder div -- rather than
// a full boilerplate page, since the point is just "give the canvas a
// real element to click," not scaffold an opinionated app shell.
function _designScaffoldIndexHtml() {
  const indexPath = _designIndexPath();
  if (!indexPath) return false;
  if (fs.existsSync(indexPath)) return true; // already there, nothing to do
  try { fs.mkdirSync(path.dirname(indexPath), { recursive: true }); }
  catch (err) {
    showToast('Could not create entry HTML directory: ' + err.message);
    return false;
  }
  const starter = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <h1>New app</h1>
  </div>
</body>
</html>
`;
  try {
    fs.writeFileSync(indexPath, starter, 'utf8');
    return true;
  } catch (err) {
    showToast('Could not create the entry HTML: ' + err.message);
    return false;
  }
}

function _designChooseScript(scripts) {
  return [...scripts].sort((a, b) => {
    const preferred = (filePath) => /^(?:app|main|index)(?:\.[^.]+)?$/i.test(path.basename(filePath)) ? 0 : 1;
    return preferred(a) - preferred(b) || scripts.indexOf(a) - scripts.indexOf(b);
  })[0] || null;
}

function _designResolveProjectFile(filePath) {
  let rootReal;
  try { rootReal = fs.realpathSync(state.projectDir); }
  catch (err) { showToast('Design: could not resolve the project directory: ' + err.message); return null; }
  let resolved;
  try { resolved = fs.realpathSync(filePath); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      showToast('Design: could not resolve a project asset path: ' + err.message);
      return null;
    }
    try { resolved = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath)); }
    catch (parentErr) {
      showToast('Design: could not resolve a project asset directory: ' + parentErr.message);
      return null;
    }
  }
  const relative = path.relative(rootReal, resolved);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? resolved
    : null;
}

function _designAssetReference(htmlState, assetPath) {
  const doc = parse5.parse(htmlState.text, { sourceCodeLocationInfo: false });
  let baseHref = null;
  const findBase = (node) => {
    if (baseHref !== null) return;
    if (node.tagName === 'base') {
      baseHref = node.attrs?.find((attr) => attr.name === 'href')?.value ?? null;
      if (baseHref !== null) return;
    }
    for (const child of node.childNodes || []) findBase(child);
  };
  findBase(doc);
  const entryUrl = pathToFileURL(htmlState.path).href;
  let baseUrl;
  try {
    baseUrl = baseHref
      ? new URL(baseHref, entryUrl)
      : new URL(pathToFileURL(path.resolve(path.dirname(htmlState.path)) + path.sep).href);
  } catch {
    showToast('Could not add a local asset reference: entry HTML has an invalid base URL.');
    return null;
  }
  if (baseUrl.protocol !== 'file:') {
    showToast('Could not add a local asset reference while the entry HTML uses a remote base URL.');
    return null;
  }
  let basePath;
  try { basePath = fileURLToPath(baseUrl); }
  catch (err) {
    showToast('Could not resolve the entry HTML base URL: ' + err.message);
    return null;
  }
  const baseDir = baseUrl.pathname.endsWith('/') ? basePath : path.dirname(basePath);
  const relative = path.relative(baseDir, assetPath).split(path.sep).join('/');
  const reference = relative.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  try {
    if (fileURLToPath(new URL(reference, baseUrl)) !== assetPath) return null;
  } catch {
    return null;
  }
  return reference.startsWith('.') ? reference : `./${reference}`;
}

function _designEnsureEntryScript() {
  const htmlState = _designReadHtml();
  if (!htmlState) {
    showToast('Could not prepare project script: entry HTML is unavailable.');
    return null;
  }
  const { scripts } = _designProjectFiles(htmlState.text, htmlState.path);
  const existing = _designChooseScript(scripts);
  if (existing) return existing;

  const scriptPath = _designResolveProjectFile(path.join(path.dirname(htmlState.path), 'app.js'));
  if (!scriptPath) {
    showToast('Could not create a project script outside the project directory.');
    return null;
  }
  const doc = parse5.parse(htmlState.text, { sourceCodeLocationInfo: true });
  let body = null;
  let html = null;
  const findNodes = (node) => {
    if (node.tagName === 'body') body = node;
    if (node.tagName === 'html') html = node;
    for (const child of node.childNodes || []) findNodes(child);
  };
  findNodes(doc);
  const insertAt = body?.sourceCodeLocation?.endTag?.startOffset ??
    html?.sourceCodeLocation?.endTag?.startOffset ?? htmlState.text.length;
  const src = _designAssetReference(htmlState, scriptPath);
  if (!src) return null;
  const updatedHtml = htmlState.text.slice(0, insertAt) +
    `  <script src="${_escapeAttr(src)}"></script>\n` +
    htmlState.text.slice(insertAt);
  let createdScript = false;
  try {
    if (!fs.existsSync(scriptPath)) {
      fs.writeFileSync(scriptPath, '', 'utf8');
      createdScript = true;
    }
    fs.writeFileSync(htmlState.path, updatedHtml, 'utf8');
    _designNoteOwnWrite();
    return scriptPath;
  } catch (err) {
    if (createdScript) {
      try { fs.unlinkSync(scriptPath); }
      catch (cleanupErr) { console.error('[design] could not remove unreferenced script:', cleanupErr); }
    }
    showToast('Could not add a project script: ' + err.message);
    return null;
  }
}

if (typeof window !== 'undefined') window._designEnsureEntryScript = _designEnsureEntryScript;

function _designEnsureEntryStylesheet() {
  const htmlState = _designReadHtml();
  if (!htmlState) {
    showToast('Could not prepare a stylesheet: entry HTML is unavailable.');
    return null;
  }
  const linked = _designProjectFiles(htmlState.text, htmlState.path).stylesheets;
  if (linked.length) return linked[0];

  const cssPath = _designResolveProjectFile(path.join(path.dirname(htmlState.path), 'style.css'));
  if (!cssPath) {
    showToast('Could not create a stylesheet outside the project directory.');
    return null;
  }
  const doc = parse5.parse(htmlState.text, { sourceCodeLocationInfo: true });
  let head = null;
  let body = null;
  let html = null;
  const findNodes = (node) => {
    if (node.tagName === 'head') head = node;
    if (node.tagName === 'body') body = node;
    if (node.tagName === 'html') html = node;
    for (const child of node.childNodes || []) findNodes(child);
  };
  findNodes(doc);
  const headClose = head?.sourceCodeLocation?.endTag?.startOffset;
  const bodyOpen = body?.sourceCodeLocation?.startTag?.startOffset;
  const htmlClose = html?.sourceCodeLocation?.endTag?.startOffset;
  const href = _designAssetReference(htmlState, cssPath);
  if (!href) return null;
  const link = `<link rel="stylesheet" href="${_escapeAttr(href)}">\n`;
  let updatedHtml;
  if (Number.isInteger(headClose)) {
    updatedHtml = htmlState.text.slice(0, headClose) + `  ${link}` + htmlState.text.slice(headClose);
  } else if (Number.isInteger(bodyOpen)) {
    updatedHtml = htmlState.text.slice(0, bodyOpen) + `<head>\n  ${link}</head>\n` + htmlState.text.slice(bodyOpen);
  } else if (Number.isInteger(htmlClose)) {
    updatedHtml = htmlState.text.slice(0, htmlClose) + `<head>\n  ${link}</head>\n` + htmlState.text.slice(htmlClose);
  } else {
    updatedHtml = `<head>\n  ${link}</head>\n` + htmlState.text;
  }
  let createdStylesheet = false;
  try {
    if (!fs.existsSync(cssPath)) {
      fs.writeFileSync(cssPath, '', 'utf8');
      createdStylesheet = true;
    }
    fs.writeFileSync(htmlState.path, updatedHtml, 'utf8');
    _designNoteOwnWrite();
    return cssPath;
  } catch (err) {
    if (createdStylesheet) {
      try { fs.unlinkSync(cssPath); }
      catch (cleanupErr) { console.error('[design] could not remove unreferenced stylesheet:', cleanupErr); }
    }
    showToast('Could not add a project stylesheet: ' + err.message);
    return null;
  }
}

if (typeof window !== 'undefined') window._designEnsureEntryStylesheet = _designEnsureEntryStylesheet;

// Marker comments bracketing the auto-generated runtime block in the
// project's app.js. Re-running this after another Modal/Data Table gets
// placed must be a no-op, not a second copy of the same functions -- the
// markers are what makes that check cheap (a plain substring test)
// instead of re-parsing app.js to ask "is this already here?".
const _DESIGN_RUNTIME_START = '/* --- nb-design:runtime (auto-generated, safe to edit) --- */';
const _DESIGN_RUNTIME_END = '/* --- /nb-design:runtime --- */';

// The actual behavior for components whose markup alone isn't enough --
// a Modal needs open/close wiring, a Data Table needs its rows rendered
// from data-nb-rows. Delegated listeners (one listener on `document`,
// matched by attribute selector) rather than per-instance ones, so this
// still works for modals added after this block was written, or copies
// made with Duplicate -- no re-run required per instance.
//
// Deliberately NOT an inline <script> in index.html -- see the
// DOM-ready-guard / no-inline-script rules in the novaapp-builder skill.
// This text is appended into the project's own app.js instead, which is
// already required to be loaded via <script src="app.js"></script>.
function _designRuntimeSnippet() {
  return `${_DESIGN_RUNTIME_START}
  function nbRenderTableRows(tableEl) {
    var rows;
    try { rows = JSON.parse(tableEl.getAttribute('data-nb-rows') || '[]'); } catch (e) { rows = []; }
    tableEl.textContent = '';
    if (!Array.isArray(rows) || !rows.length ||
        rows.some(function (row) { return !row || typeof row !== 'object' || Array.isArray(row); })) return;
    var cols = Object.keys(rows[0]);
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    cols.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      cols.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = row[c] == null ? '' : String(row[c]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
  }

  document.querySelectorAll('table[data-nb-rows]').forEach(nbRenderTableRows);

  document.addEventListener('click', function (e) {
    var openBtn = e.target.closest('[data-nb-modal-open]');
    if (openBtn) {
      var wrap = openBtn.closest('.nb-modal-wrap');
      var dialog = wrap && wrap.querySelector('[data-nb-modal]');
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
      return;
    }
    var closeBtn = e.target.closest('[data-nb-modal-close]');
    if (closeBtn) {
      var openDialog = closeBtn.closest('[data-nb-modal]');
      if (openDialog && typeof openDialog.close === 'function') openDialog.close();
    }
  });
${_DESIGN_RUNTIME_END}`;
}

// Makes sure the project actually has a place for the snippet above to
// live and run: app.js exists on disk, index.html references it via <script src="app.js"> (not
// inline -- the install-time Content Scanner blocks inline script
// blocks in index.html outright), and the runtime snippet itself is
// present exactly once. Called right before a Modal or Data Table is
// placed, so those components work the moment they're saved, not just
// while previewed in the Design canvas.
function _designEnsureRuntimeSupport() {
  const htmlState = _designReadHtml();
  if (!htmlState) {
    showToast('Could not prepare component runtime: entry HTML is unavailable.');
    return false;
  }
  let scriptPath = _designChooseScript(_designProjectFiles(htmlState.text, htmlState.path).scripts);
  if (!scriptPath) scriptPath = _designEnsureEntryScript();
  if (!scriptPath) return false;
  let scriptText;
  try { scriptText = fs.readFileSync(scriptPath, 'utf8'); }
  catch (err) {
    showToast(`Could not read linked script "${path.relative(state.projectDir, scriptPath)}": ${err.message}`);
    return false;
  }
  if (scriptText.includes(_DESIGN_RUNTIME_START)) return true;
  scriptText = scriptText.replace(/\s*$/, '') + `\n\n(() => {\n${_designRuntimeSnippet()}\n})();\n`;
  try {
    fs.writeFileSync(scriptPath, scriptText, 'utf8');
    _designNoteOwnWrite();
    return true;
  } catch (err) {
    showToast(`Could not update component runtime files: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------
// Source-accurate patching helpers (run in the main process / Node side,
// not inside the iframe -- these read/write real files on disk).
// ---------------------------------------------------------------------

// Walks a parse5 tree and returns the element node at `pathArr`
// (indices into childNodes at each level, following only element nodes
// the injected script also counts -- i.e. all nodes, same order as
// childNodes, matching how the injected script assigns paths).
function _parse5NodeAtPath(doc, pathArr) {
  // Must mirror the browser-side computePath() in _designInjectedScript:
  // indices count element children only (tagName === 1), skipping parse5's
  // #text/#comment nodes, so both sides agree regardless of how each
  // parser splits whitespace.
  let node = doc;
  for (const idx of pathArr) {
    const children = (node.childNodes || []).filter((n) => n.tagName);
    node = children[idx];
    if (!node) return null;
  }
  return node;
}

// Returns { text, doc } for the manifest entry HTML, or null if it
// doesn't exist / can't be read.
function _designReadHtml() {
  const p = _designIndexPath();
  if (!p) return null;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') showToast('Could not read the entry HTML: ' + err.message);
    return null;
  }
  const doc = parse5.parse(text, { sourceCodeLocationInfo: true });
  return { text, doc, path: p };
}

// Splices a set of {start, end, replacement} edits into `text`. Edits
// must not overlap; applied back-to-front so earlier offsets stay valid
// as later (higher-offset) edits are applied first.
function _spliceEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

// Builds the { start, end, replacement } edit(s) needed to set a single
// attribute (id/class/style/src/alt/placeholder/type) on the element at
// _designSelectedPath. Returns [] if the element/attr location can't be
// found (e.g. the tree drifted since selection, or it's a synthetic
// <html>/<head>/<body> with no real source location).
function _buildAttrEdit(doc, name, value, sourceText) {
  const node = _parse5NodeAtPath(doc, _designSelectedPath);
  if (!node || !node.sourceCodeLocation || node.tagName !== _designSelectedTag) return [];

  const loc = node.sourceCodeLocation;
  const existing = loc.attrs && loc.attrs[name];

  if (existing) {
    // Replace just the value inside the existing name="value" span.
    // parse5 gives us the whole `name="value"` span, not just the value,
    // so we rebuild the whole attr text rather than trying to locate the
    // quotes ourselves (quote style varies: ', ", or unquoted).
    if (value === '' || value == null) {
      return [{ start: existing.startOffset, end: existing.endOffset, replacement: '' }];
    }
    return [{ start: existing.startOffset, end: existing.endOffset, replacement: `${name}="${_escapeAttr(value)}"` }];
  }

  // Attribute doesn't exist yet -- insert right before the start tag's
  // closing '>' (or '/>'), with a leading space.
  if (!value) return []; // nothing to add and nothing to remove
  let insertAt = loc.startTag.endOffset - 1;
  if (sourceText[insertAt - 1] === '/') insertAt--;
  return [{ start: insertAt, end: insertAt, replacement: ` ${name}="${_escapeAttr(value)}"` }];
}

function _escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Builds the edit for replacing an element's text content (only used
// when the element has no children -- matches the Attributes panel's
// own text-field visibility rule).
function _buildTextEdit(doc, text) {
  const node = _parse5NodeAtPath(doc, _designSelectedPath);
  if (!node || !node.sourceCodeLocation || node.tagName !== _designSelectedTag) return [];
  const loc = node.sourceCodeLocation;
  if (!loc.startTag || !loc.endTag) return []; // void element, or no closing tag captured
  return [{
    start: loc.startTag.endOffset,
    end: loc.endTag.startOffset,
    replacement: _escapeText(text),
  }];
}

function _escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// Deletion: removes the whole element's source span (startTag through
// endTag, or the whole node span for void elements without a closing
// tag).
function _buildDeleteEdit(doc) {
  const node = _parse5NodeAtPath(doc, _designSelectedPath);
  if (!node || !node.sourceCodeLocation || node.tagName !== _designSelectedTag) return [];
  const loc = node.sourceCodeLocation;
  return [{ start: loc.startOffset, end: loc.endOffset, replacement: '' }];
}

// ---------------------------------------------------------------------
// CSS-aware style patching. Given a class name and a CSS property, finds
// a `.class { property: ... }` declaration in style.css and returns the
// edit to change it -- or null if there's no such rule, so the caller
// can fall back to an inline style instead.
// ---------------------------------------------------------------------

function _designReadCss() {
  const htmlState = _designReadHtml();
  if (!htmlState) return null;
  const cssFiles = [];
  for (const filePath of _designProjectFiles(htmlState.text, htmlState.path).stylesheets) {
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (err) {
      showToast(`Could not read linked stylesheet "${path.relative(state.projectDir, filePath)}": ${err.message}`);
      return null;
    }
    let ast;
    try { ast = cssParser.parse(text, { silent: false }); } catch (err) {
      showToast(`Could not parse linked stylesheet "${path.relative(state.projectDir, filePath)}": ${err.message}`);
      return null;
    }
    cssFiles.push({ text, ast, path: filePath });
  }
  return cssFiles;
}

function _lineColToOffset(text, line, column) {
  // css package positions are 1-indexed line/column; convert to a flat
  // string offset the same way parse5's offsets work, so both patching
  // paths can share _spliceEdits.
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1; // +1 for the \n
  return offset + (column - 1);
}

// Finds the FIRST rule in the stylesheet whose selector list contains
// exactly `.className` (simple single-class selectors only -- this
// deliberately doesn't try to reason about compound/descendant
// selectors, since guessing which one the user "means" is worse than
// just falling back to inline style for anything non-trivial).
function _findSimpleClassRule(ast, className) {
  const rules = (ast.stylesheet && ast.stylesheet.rules) || [];
  for (const rule of rules) {
    if (rule.type !== 'rule') continue;
    if ((rule.selectors || []).some((s) => s.trim() === `.${className}`)) return rule;
  }
  return null;
}

function _buildCssPropertyEdit(cssText, ast, className, property, value) {
  const rule = _findSimpleClassRule(ast, className);
  if (!rule) return null; // caller falls back to inline style

  const existingDecl = (rule.declarations || []).find(
    (d) => d.type === 'declaration' && d.property === property
  );

  if (existingDecl) {
    const start = _lineColToOffset(cssText, existingDecl.position.start.line, existingDecl.position.start.column);
    let end = _lineColToOffset(cssText, existingDecl.position.end.line, existingDecl.position.end.column);
    if (value === '' || value == null) {
      // Consume the trailing ';' too (and one following space, if any)
      // so deleting a property doesn't leave a dangling "  ;" line --
      // the declaration's own end position stops just before it.
      if (cssText[end] === ';') end += 1;
      if (cssText[end] === ' ') end += 1;
      return [{ start, end, replacement: '' }];
    }
    // Note: the css package's declaration end position stops right
    // before the trailing ';' -- that semicolon is already preserved
    // untouched outside this edit span, so the replacement must NOT add
    // its own or the result is "property: value;;".
    return [{ start, end, replacement: `${property}: ${value}` }];
  }

  if (!value) return []; // nothing to add, nothing existed to remove
  // Insert as a new declaration right after the rule's opening '{'.
  const openBraceOffset = _lineColToOffset(cssText, rule.position.start.line, rule.position.start.column)
    + rule.selectors.join(', ').length + 2; // heuristic: selector text + " {" -- refined below
  // More reliable: locate the '{' by scanning forward from the rule's
  // start offset rather than trusting selector-length math (selectors
  // can have multi-line/extra whitespace formatting the heuristic above
  // doesn't account for).
  const ruleStartOffset = _lineColToOffset(cssText, rule.position.start.line, rule.position.start.column);
  const braceIdx = cssText.indexOf('{', ruleStartOffset);
  if (braceIdx === -1) return [];
  return [{ start: braceIdx + 1, end: braceIdx + 1, replacement: `\n  ${property}: ${value};` }];
}

function _buildInlineStyleValue(node, styleEdits) {
  const styleAttr = node.attrs.find((attr) => attr.name === 'style');
  const current = styleAttr ? styleAttr.value : '';
  const prefix = 'x{';
  const wrapped = prefix + current + '}';
  let ast;
  try {
    ast = cssParser.parse(wrapped, { silent: false });
  } catch (err) {
    throw new Error('The selected element has invalid inline CSS: ' + err.message);
  }
  const declarations = ast.stylesheet.rules[0]?.declarations || [];
  const edits = [];
  for (const [property, value] of Object.entries(styleEdits)) {
    const matches = declarations.filter((d) =>
      d.type === 'declaration' && d.property?.toLowerCase() === property.toLowerCase()
    );
    if (!matches.length) {
      if (value !== '' && value != null) {
        const separator = current.trim() && !current.trimEnd().endsWith(';') ? ';' : '';
        edits.push({
          start: current.length,
          end: current.length,
          replacement: `${separator}${current.trim() ? ' ' : ''}${property}: ${value};`,
        });
      }
      continue;
    }
    const targets = value === '' || value == null ? matches : [matches[matches.length - 1]];
    for (const declaration of targets) {
      const start = _lineColToOffset(wrapped, declaration.position.start.line, declaration.position.start.column) - prefix.length;
      let end = _lineColToOffset(wrapped, declaration.position.end.line, declaration.position.end.column) - prefix.length;
      if (value === '' || value == null) {
        while (end < current.length && /[ \t]/.test(current[end])) end++;
        if (current[end] === ';') end++;
        edits.push({ start, end, replacement: '' });
      } else {
        const important = /!important\s*$/i.test(declaration.value) ? ' !important' : '';
        edits.push({ start, end, replacement: `${property}: ${value}${important}` });
      }
    }
  }
  return _spliceEdits(current, edits);
}

// ---------------------------------------------------------------------
// Applying an edit end-to-end: given the pending edit payload (from the
// Attributes panel), decide per-field whether it's a CSS-class edit or
// an HTML attribute edit, build all the spliced edits, and write both
// files. Re-reads both files fresh each time -- see module doc comment.
// ---------------------------------------------------------------------

const _STYLE_PROP_MAP = {
  width: 'width', height: 'height', left: 'left', top: 'top',
  background: 'background', color: 'color', fontSize: 'font-size', opacity: 'opacity',
  display: 'display',
  flexDirection: 'flex-direction', flexWrap: 'flex-wrap',
  justifyContent: 'justify-content', alignItems: 'align-items', gap: 'gap',
  gridTemplateColumns: 'grid-template-columns', gridTemplateRows: 'grid-template-rows',
  gridTemplateAreas: 'grid-template-areas', justifyItems: 'justify-items',
};

function _designFlushEdit() {
  const edit = _designPendingEdit;
  if (!edit || !_designSelectedPath) return false;

  const htmlState = _designReadHtml();
  if (!htmlState) return false;

  const node = _parse5NodeAtPath(htmlState.doc, _designSelectedPath);
  if (!node || node.tagName !== _designSelectedTag) {
    // The tree drifted (structure changed since we selected this
    // element -- e.g. hand-edited in the Editor tab). Refuse to guess;
    // surface it instead of silently patching the wrong node. Include
    // what was actually found so this is debuggable instead of a dead
    // end -- "expected X, found Y" or "found nothing" are very
    // different failures and shouldn't produce the same message.
    const found = node ? `<${node.tagName}>` : 'nothing';
    console.warn('[design] flush mismatch', {
      path: _designSelectedPath, expectedTag: _designSelectedTag,
      foundTag: node ? node.tagName : null, pendingEdit: edit,
    });
    showToast(`Design: selection out of sync — expected <${_designSelectedTag}> at [${_designSelectedPath.join('.')}], found ${found}. Click the element again.`);
    _designPendingEdit = null;
    return false;
  }

  const attrEl = node.attrs.find((a) => a.name === 'class');
  const currentClassName = (attrEl && attrEl.value.trim().split(/\s+/)[0]) || null;
  const className = ('className' in edit ? edit.className : attrEl?.value || '')
    .trim().split(/\s+/)[0] || null;
  const inlineStyleAttr = node.attrs.find((a) => a.name === 'style');
  const inlineStyleAst = inlineStyleAttr
    ? (() => {
        try { return cssParser.parse(`x{${inlineStyleAttr.value}}`, { silent: false }); }
        catch (err) {
          showToast('Design: selected element has invalid inline CSS: ' + err.message);
          return null;
        }
      })()
    : null;
  if (inlineStyleAttr && !inlineStyleAst) return;
  const inlineProperties = new Set(
    (inlineStyleAst?.stylesheet.rules[0]?.declarations || [])
      .filter((d) => d.type === 'declaration')
      .map((d) => d.property.toLowerCase())
  );

  const htmlEdits = [];
  const cssEditsByPath = new Map();
  let cssFiles = null;

  if ('id' in edit) htmlEdits.push(..._buildAttrEdit(htmlState.doc, 'id', edit.id, htmlState.text));
  if ('className' in edit) htmlEdits.push(..._buildAttrEdit(htmlState.doc, 'class', edit.className, htmlState.text));
  if ('text' in edit && edit.text !== undefined) htmlEdits.push(..._buildTextEdit(htmlState.doc, edit.text));
  if ('dataRows' in edit) htmlEdits.push(..._buildAttrEdit(htmlState.doc, 'data-nb-rows', edit.dataRows, htmlState.text));

  const inlineStyleEdits = {};
  if (edit.style) {
    cssFiles = className ? _designReadCss() : [];
    if (className && !cssFiles) return false;
    const remainingStyle = {};
    Object.entries(edit.style).forEach(([field, value]) => {
      const prop = _STYLE_PROP_MAP[field];
      if (!prop) return;
      if (cssFiles && className && !inlineProperties.has(prop.toLowerCase())) {
        for (const cssFile of cssFiles) {
          const cssEdit = _buildCssPropertyEdit(cssFile.text, cssFile.ast, className, prop, value);
          if (cssEdit) {
            if (cssEdit.length) {
              const edits = cssEditsByPath.get(cssFile.path) || [];
              edits.push(...cssEdit);
              cssEditsByPath.set(cssFile.path, edits);
            }
            return;
          }
        }
      }
      remainingStyle[prop] = value;
    });
    try {
      Object.assign(inlineStyleEdits, remainingStyle);
      if (Object.keys(inlineStyleEdits).length) {
        const styleValue = _buildInlineStyleValue(node, inlineStyleEdits);
        htmlEdits.push(..._buildAttrEdit(htmlState.doc, 'style', styleValue, htmlState.text));
      }
    } catch (err) {
      showToast('Could not edit inline styles: ' + err.message);
      return false;
    }
  }

  if (!htmlEdits.length && !cssEditsByPath.size) {
    _designPendingEdit = null;
    return true;
  }
  if (!_designPushUndo('attribute edit')) return false;
  if (htmlEdits.length) {
    try {
      fs.writeFileSync(htmlState.path, _spliceEdits(htmlState.text, htmlEdits), 'utf8');
      _designNoteOwnWrite();
    } catch (err) {
      let rollbackMessage = '';
      try { fs.writeFileSync(htmlState.path, htmlState.text, 'utf8'); }
      catch (rollbackErr) { rollbackMessage = ` Rollback failed: ${rollbackErr.message}`; }
      showToast('Could not save the entry HTML: ' + err.message + rollbackMessage);
      _designUndoStack.pop();
      return false;
    }
  }
  const writtenCssPaths = [];
  try {
    for (const [filePath, edits] of cssEditsByPath) {
      const cssFile = cssFiles.find((file) => file.path === filePath);
      if (!cssFile) throw new Error(`Linked stylesheet is no longer available: ${filePath}`);
      writtenCssPaths.push(filePath);
      fs.writeFileSync(filePath, _spliceEdits(cssFile.text, edits), 'utf8');
      _designNoteOwnWrite();
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const filePath of writtenCssPaths.reverse()) {
      const original = cssFiles.find((file) => file.path === filePath);
      try { fs.writeFileSync(filePath, original.text, 'utf8'); }
      catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); }
    }
    if (htmlEdits.length) {
      try { fs.writeFileSync(htmlState.path, htmlState.text, 'utf8'); }
      catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); }
    }
    _designUndoStack.pop();
    const rollbackMessage = rollbackErrors.length
      ? ` Rollback incomplete: ${rollbackErrors.join('; ')}`
      : '';
    showToast('Could not save linked stylesheet: ' + err.message + rollbackMessage);
    return false;
  }
  _designPendingEdit = null;
  return true;
}

// Notifies design-pro.js's drift poller that this write is our own, not
// an external edit -- see the definition of window._nbproNoteOwnWrite in
// design-pro.js for why this is needed. Guarded/optional: design-pro.js
// may not be loaded (or may load after app.js), and the Design tab's
// core patching still works fine without it -- this just prevents the
// poller from misreading our own writes as drift and reloading the
// canvas out from under an in-progress edit.
function _designNoteOwnWrite() {
  if (typeof window._nbproNoteOwnWrite === 'function') window._nbproNoteOwnWrite();
}

function _designScheduleSave(edit) {
  _designPendingEdit = { ..._designPendingEdit, ...edit, style: { ...(_designPendingEdit && _designPendingEdit.style), ...(edit && edit.style) } };
  clearTimeout(_designWriteTimer);
  _designWriteTimer = setTimeout(() => {
    _designWriteTimer = null;
    _designFlushEdit();
  }, _DESIGN_WRITE_DEBOUNCE_MS);
}

// Delete and duplicate/insert bypass the debounce -- they're discrete
// one-shot actions, not fields the user is actively typing into, so
// there's no reason to wait.
function _designWriteImmediateHtmlEdits(edits) {
  const htmlState = _designReadHtml();
  if (!htmlState || !edits.length) {
    _designReloadFrame();
    return false;
  }
  if (!_designPushUndo('delete')) {
    _designReloadFrame();
    return false;
  }
  try {
    fs.writeFileSync(htmlState.path, _spliceEdits(htmlState.text, edits), 'utf8');
    _designNoteOwnWrite();
    return true;
  } catch (err) {
    _designUndoStack.pop();
    showToast('Could not save the entry HTML: ' + err.message);
    _designReloadFrame();
    return false;
  }
}

// ---------------------------------------------------------------------
// Injected iframe script -- selection, hover, insert/duplicate/delete
// gestures, all operating on the *live* DOM for instant visual feedback.
// It computes each element's tree path itself (matching parse5's
// childNodes ordering) rather than an opaque counter, so the parent can
// map straight back to a parse5 node without a lookup table that could
// go stale.
// ---------------------------------------------------------------------

function _designInjectedScript() {
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (['+', '-', '=', '_', '0'].includes(event.key)
      || ['NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(event.code)) {
      event.preventDefault();
    }
  }, true);
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  });

  const PATH_ATTR = 'data-nb-design-path';
  let hovered = null;
  let selected = null;
  // Guards the actual insert-mutation points (insertInto, paletteDrop)
  // against firing more than once per user gesture, whatever the cause
  // upstream turns out to be -- see _designInsertGuardUntil in the host
  // script for the matching guard on the click path. This is the single
  // choke point both click-insert and drag-drop insert funnel through,
  // so guarding here closes the gap for both regardless of which one
  // the extra calls are coming from.
  let _insertGuardUntil = 0;
  function _insertGuardPass() {
    const now = performance.now();
    if (now < _insertGuardUntil) return false;
    _insertGuardUntil = now + 50;
    return true;
  }

  // Elements the injected script itself adds to the live tree -- never
  // present in the real index.html on disk, so parse5 has no concept of
  // them. If computePath() counted these as real siblings/ancestors,
  // every path it produces would be offset from what parse5 resolves for
  // the same file, and the host would silently patch (or reject) the
  // wrong node. Tag every synthetic element with this attribute at
  // creation time; computePath() then skips it when computing indices
  // (it contributes no index of its own, and doesn't count as a sibling
  // when indexing real elements), while still walking normally past it
  // to reach real ancestors/siblings on the other side.
  const SYNTHETIC_ATTR = 'data-nb-synthetic';

  function _isSynthetic(node) {
    return !!(node && node.nodeType === 1 && node.hasAttribute(SYNTHETIC_ATTR));
  }

  function _realChildren(parentNode) {
    return Array.prototype.filter.call(parentNode.children, (c) => !_isSynthetic(c));
  }

  function computePath(el) {
    // Element-only indices: text/comment nodes split differently between
    // the browser's live DOM and parse5's parse of the raw file, so
    // counting all childNodes drifts. Both sides agree on element
    // ordering, so index within `children` (elements only, excluding
    // synthetic ones) instead.
    const idxs = [];
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const parentNode = node.parentNode;
      if (!parentNode) break;
      if (!_isSynthetic(node)) {
        const idx = _realChildren(parentNode).indexOf(node);
        idxs.unshift(idx);
      }
      if (node === document.documentElement) break;
      node = parentNode;
    }
    return idxs;
  }

  function tagAll() {
    document.querySelectorAll('*').forEach((el) => {
      if (_isSynthetic(el)) return; // never gets a path -- doesn't exist in the source file
      el.setAttribute(PATH_ATTR, computePath(el).join('.'));
    });
  }
  function notifyBindingPaths() {
    const paths = [];
    document.querySelectorAll('[data-nb-studio-action]').forEach((el) => {
      const targetId = el.getAttribute('data-nb-studio-action');
      if (targetId) paths.push([targetId, el.getAttribute(PATH_ATTR)]);
    });
    parent.postMessage({ source: 'nb-design', type: 'bindingPathsChanged', paths }, '*');
  }
  tagAll();
  notifyBindingPaths();
  new MutationObserver(() => {
    const prevSelectedPath = selected ? selected.getAttribute(PATH_ATTR) : null;
    tagAll();
    notifyBindingPaths();
    // tagAll() just re-stamped every element's path client-side; if the
    // selected element's own path shifted as a *side effect* of some
    // unrelated mutation (an insert/delete/drag elsewhere in the tree),
    // the host's _designSelectedPath is now stale and every later edit
    // resolves against the wrong node. None of the discrete action
    // messages (inserted/deleted/moved/etc) cover this case -- they only
    // fire for the element directly acted on, not for a selected element
    // whose index shifted because a sibling changed. Send a dedicated
    // 'pathChanged' message rather than re-sending 'select': the host's
    // select handler repaints the whole Attributes panel (including the
    // text field), which would stomp on in-progress typing every time an
    // unrelated part of the tree mutates. This just repoints the path.
    if (selected) {
      const newSelectedPath = selected.getAttribute(PATH_ATTR);
      if (newSelectedPath !== prevSelectedPath) {
        parent.postMessage({ source: 'nb-design', type: 'pathChanged', path: newSelectedPath, tag: selected.tagName.toLowerCase() }, '*');
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const INTERNAL_MARKER_CLASSES = ['__nb_hover', '__nb_selected', '__nb_dragging'];

  function _cleanClassName(el) {
    const raw = el.getAttribute('class') || '';
    return raw.split(/\s+/).filter((c) => c && !INTERNAL_MARKER_CLASSES.includes(c)).join(' ');
  }

  function summarize(el) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      path: el.getAttribute(PATH_ATTR),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: _cleanClassName(el),
      text: el.children.length === 0 ? el.textContent : '',
      hasChildren: el.children.length > 0,
      style: {
        width: el.style.width || '',
        height: el.style.height || '',
        left: el.style.left || '',
        top: el.style.top || '',
        background: el.style.background || el.style.backgroundColor || '',
        color: el.style.color || '',
        fontSize: el.style.fontSize || '',
        opacity: el.style.opacity || '',
        display: el.style.display || '',
        flexDirection: el.style.flexDirection || '',
        flexWrap: el.style.flexWrap || '',
        justifyContent: el.style.justifyContent || '',
        alignItems: el.style.alignItems || '',
        gap: el.style.gap || '',
        gridTemplateColumns: el.style.gridTemplateColumns || '',
        gridTemplateRows: el.style.gridTemplateRows || '',
        justifyItems: el.style.justifyItems || '',
      },
      computedStyle: {
        width: cs.width || '',
        height: cs.height || '',
        left: cs.left || '',
        top: cs.top || '',
        background: cs.background || cs.backgroundColor || '',
        color: cs.color || '',
        fontSize: cs.fontSize || '',
        opacity: cs.opacity || '',
        display: cs.display || '',
        flexDirection: cs.flexDirection || '',
        flexWrap: cs.flexWrap || '',
        justifyContent: cs.justifyContent || '',
        alignItems: cs.alignItems || '',
        gap: cs.gap || '',
        gridTemplateColumns: cs.gridTemplateColumns || '',
        gridTemplateRows: cs.gridTemplateRows || '',
        justifyItems: cs.justifyItems || '',
      },
      // Only meaningful for <table data-nb-rows>; undefined for everything
      // else so _designShowSelection's `'nbRows' in el` check stays a
      // clean way to tell "this element has row data" from "it doesn't".
      nbRows: el.tagName === 'TABLE' && el.hasAttribute('data-nb-rows') ? el.getAttribute('data-nb-rows') : undefined,
    };
  }

  document.addEventListener('mouseover', (e) => {
    if (hovered) hovered.classList.remove('__nb_hover');
    hovered = e.target;
    if (hovered && hovered !== selected) hovered.classList.add('__nb_hover');
  }, true);

  function selectEl(el) {
    if (!el || el.nodeType !== 1) return null;
    if (selected) selected.classList.remove('__nb_selected');
    selected = el;
    selected.classList.add('__nb_selected');
    _resizeSyncHandles();
    return summarize(selected);
  }

  // ── Resize handles: 8 small grips (4 corners + 4 edges) drawn around
  // the selected element, standard design-tool pattern. Corners resize
  // both width+height from that corner; edges resize one dimension only.
  // Handles live in an overlay positioned in DOCUMENT coordinates (not
  // fixed to the element itself), repositioned on every selection change
  // and on scroll/resize, so they track the selected element without
  // needing to be children of it (which would risk them affecting its
  // own box model/overflow).
  const HANDLE_SPECS = [
    { id: 'nw', cursor: 'nwse-resize', x: 0,   y: 0   },
    { id: 'n',  cursor: 'ns-resize',   x: 0.5, y: 0   },
    { id: 'ne', cursor: 'nesw-resize', x: 1,   y: 0   },
    { id: 'e',  cursor: 'ew-resize',   x: 1,   y: 0.5 },
    { id: 'se', cursor: 'nwse-resize', x: 1,   y: 1   },
    { id: 's',  cursor: 'ns-resize',   x: 0.5, y: 1   },
    { id: 'sw', cursor: 'nesw-resize', x: 0,   y: 1   },
    { id: 'w',  cursor: 'ew-resize',   x: 0,   y: 0.5 },
  ];
  const resizeOverlay = document.createElement('div');
  resizeOverlay.setAttribute('data-nb-synthetic', '');
  resizeOverlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2147483647;';
  const handleEls = {};
  HANDLE_SPECS.forEach((spec) => {
    const h = document.createElement('div');
    h.setAttribute('data-nb-synthetic', '');
    h.dataset.handle = spec.id;
    const isCorner = spec.id.length === 2;
    h.style.cssText = `position:absolute;width:${isCorner ? 9 : 7}px;height:${isCorner ? 9 : 7}px;` +
      `background:#fff;border:1.5px solid var(--accent, #58a6ff);border-radius:50%;` +
      `pointer-events:auto;cursor:${spec.cursor};transform:translate(-50%,-50%);`;
    resizeOverlay.appendChild(h);
    handleEls[spec.id] = h;
  });

  function _resizeSyncHandles() {
    // <body>/<html> aren't real boxes you drag-resize -- they're the
    // page itself, and their rect can change *as a result of* the resize
    // (setting body.style.width/height alters the document's own scroll
    // extent), which fed back into the next getBoundingClientRect() call
    // and made the handles chase a moving target instead of tracking the
    // cursor. Treat them as unselectable-for-resize; use the Window/App
    // Window size controls for page-level sizing instead.
    if (!selected || selected === document.body || selected === document.documentElement || !document.body.contains(selected)) {
      resizeOverlay.remove();
      return;
    }
    if (!resizeOverlay.parentNode) document.body.appendChild(resizeOverlay);
    const rect = selected.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;
    HANDLE_SPECS.forEach((spec) => {
      const h = handleEls[spec.id];
      h.style.top = (top + rect.height * spec.y) + 'px';
      h.style.left = (left + rect.width * spec.x) + 'px';
    });
  }
  window.addEventListener('scroll', _resizeSyncHandles, true);
  window.addEventListener('resize', _resizeSyncHandles);

  let resizeState = null; // { handle, startX, startY, startW, startH, startLeft, startTop }

  Object.entries(handleEls).forEach(([id, h]) => {
    h.addEventListener('mousedown', (e) => {
      if (!selected || selected === document.body || selected === document.documentElement) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = selected.getBoundingClientRect();
      const cs = getComputedStyle(selected);
      // width/height are no-ops on display:inline elements (span, a,
      // etc. by default) -- the browser silently ignores them, so the
      // element's real box never changes size even though our math
      // assumes it does. That mismatch between "where we think the box
      // is" and "where it actually is" is what made the handles drift
      // off the visible outline. Force a display mode where width/height
      // actually apply, same idea as forcing position:absolute for
      // free-position drag -- a real, visible change, so only do it
      // right when a resize starts, not proactively on every selection.
      if (cs.display === 'inline') {
        selected.style.display = 'inline-block';
      }
      resizeState = {
        handle: id,
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height,
        // Only meaningful for nw/n/w handles, which move the top/left
        // edge -- resizing from those needs an explicit left/top so the
        // opposite edge stays put instead of the whole box sliding.
        wasPositioned: cs.position === 'absolute' || cs.position === 'fixed',
        startLeft: parseFloat(selected.style.left) || rect.left,
        startTop: parseFloat(selected.style.top) || rect.top,
      };
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizeState || !selected) return;
    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;
    const id = resizeState.handle;
    let w = resizeState.startW;
    let h = resizeState.startH;
    let needsReposition = false;

    if (id.includes('e')) w = Math.max(4, resizeState.startW + dx);
    if (id.includes('w')) { w = Math.max(4, resizeState.startW - dx); needsReposition = true; }
    if (id.includes('s')) h = Math.max(4, resizeState.startH + dy);
    if (id.includes('n')) { h = Math.max(4, resizeState.startH - dy); needsReposition = true; }

    selected.style.width = w + 'px';
    selected.style.height = h + 'px';

    if (needsReposition) {
      // Resizing from the top or left edge moves that edge inward, which
      // means the element's origin has to shift too or the OPPOSITE edge
      // would appear to move instead (classic "resize from the wrong
      // corner" bug). Only meaningful if the element is actually taken
      // out of flow -- for an in-flow element, left/top has no effect,
      // so left/top-edge resizing legitimately just changes the box size
      // and lets normal layout reflow handle the rest.
      if (resizeState.wasPositioned) {
        if (id.includes('w')) selected.style.left = (resizeState.startLeft + dx) + 'px';
        if (id.includes('n')) selected.style.top = (resizeState.startTop + dy) + 'px';
      }
    }
    // Read the rect back AFTER applying the style changes, inside
    // _resizeSyncHandles, rather than trusting the dx/dy math to match
    // reality -- for an in-flow (non-positioned) element being resized
    // from a top/left edge, the box can shift due to normal layout
    // reflow in ways our left/top math never accounts for (that branch
    // deliberately does nothing for in-flow elements). Syncing off the
    // real, current getBoundingClientRect() is what actually keeps the
    // handles glued to the visible box regardless of how the resize
    // affected layout.
    _resizeSyncHandles();
    parent.postMessage({ source: 'nb-design', type: 'resizeLive', path: selected.getAttribute(PATH_ATTR) }, '*');
  }, true);

  document.addEventListener('mouseup', () => {
    if (!resizeState || !selected) { resizeState = null; return; }
    resizeState = null;
    parent.postMessage({
      source: 'nb-design', type: 'resized',
      path: selected.getAttribute(PATH_ATTR),
      width: selected.style.width, height: selected.style.height,
      left: selected.style.left, top: selected.style.top,
    }, '*');
  }, true);

  // Set the instant a drag becomes a real drag (past DRAG_THRESHOLD) and
  // cleared on the next click. Suppresses the click that the browser
  // still fires after a mouseup even when the mousedown called
  // preventDefault() -- preventDefault() blocks default *actions*
  // (text selection, etc), it does NOT cancel the click event itself.
  // Without this guard, finishing a reparent drag fires the drag's own
  // 'moved' selection AND a second, stale 'select' message from the
  // trailing click, double-processing the same interaction.
  let suppressNextClick = false;

  document.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (suppressNextClick) { suppressNextClick = false; return; }
    const summary = selectEl(e.target);
    if (summary) parent.postMessage({ source: 'nb-design', type: 'select', element: summary }, '*');
  }, true);

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const summary = selectEl(e.target);
    if (summary) {
      parent.postMessage({
        source: 'nb-design', type: 'contextmenu',
        element: summary, x: e.clientX, y: e.clientY,
      }, '*');
    }
  }, true);

  // Default data seeded into a freshly-placed Data Table -- small enough
  // to read at a glance, varied enough (string/number columns) to show
  // the table isn't just rendering a static <table> skeleton.
  const _DEFAULT_TABLE_ROWS = [
    { name: 'Alpha', qty: 4, status: 'Active' },
    { name: 'Bravo', qty: 1, status: 'Pending' },
    { name: 'Charlie', qty: 7, status: 'Active' },
  ];

  // Renders <thead>/<tbody> for a table element from the JSON stashed in
  // its data-nb-rows attribute. Called on placement and again whenever
  // the Attributes panel's row-data editor writes new JSON in -- kept as
  // a named function (not inline) so both call sites stay in sync.
  function renderTableRows(tableEl) {
    let rows;
    try { rows = JSON.parse(tableEl.getAttribute('data-nb-rows') || '[]'); } catch { rows = []; }
    tableEl.textContent = '';
    if (!Array.isArray(rows) || !rows.length ||
        rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return;
    const cols = Object.keys(rows[0]);
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    cols.forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      cols.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = row[c] == null ? '' : String(row[c]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
  }

  function makeElement(type) {
    const el = document.createElement(
      type === 'text' ? 'span'
        : type === 'button' ? 'button'
        : type === 'image' ? 'img'
        : type === 'input' ? 'input'
        : type === 'modal' ? 'div'
        : type === 'table' ? 'table'
        : 'div'
    );
    if (type === 'text') el.textContent = 'Text';
    if (type === 'button') el.textContent = 'Button';
    if (type === 'div') { el.style.minWidth = '40px'; el.style.minHeight = '24px'; el.style.border = '1px dashed #999'; }
    if (type === 'image') { el.alt = ''; el.style.width = '80px'; el.style.height = '60px'; el.style.background = '#ddd'; }
    if (type === 'input') { el.type = 'text'; el.placeholder = 'Input'; }
    if (type === 'flex') {
      el.style.display = 'flex';
      el.style.gap = '8px';
      el.style.minHeight = '48px';
      el.style.padding = '8px';
      el.style.border = '1px dashed #999';
    }
    if (type === 'grid') {
      el.style.display = 'grid';
      el.style.gridTemplateColumns = 'repeat(3, 1fr)';
      el.style.gap = '8px';
      el.style.minHeight = '48px';
      el.style.padding = '8px';
      el.style.border = '1px dashed #999';
    }
    if (type === 'modal') {
      // A modal is really two elements -- a trigger button that stays
      // in normal flow, and a <dialog> that doesn't -- so makeElement
      // returns a small wrapper <div> holding both. Using the native
      // <dialog> element gets focus-trapping, Esc-to-close, and the
      // ::backdrop for free instead of hand-rolling modal behavior.
      el.className = 'nb-modal-wrap';
      el.style.display = 'inline-block';
      const btn = document.createElement('button');
      btn.textContent = 'Open modal';
      btn.setAttribute('data-nb-modal-open', '');
      const dialog = document.createElement('dialog');
      dialog.setAttribute('data-nb-modal', '');
      const heading = document.createElement('h2');
      heading.textContent = 'Modal title';
      const body = document.createElement('p');
      body.textContent = 'Modal content goes here.';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      closeBtn.setAttribute('data-nb-modal-close', '');
      dialog.appendChild(heading);
      dialog.appendChild(body);
      dialog.appendChild(closeBtn);
      el.appendChild(btn);
      el.appendChild(dialog);
    }
    if (type === 'table') {
      el.setAttribute('data-nb-rows', JSON.stringify(_DEFAULT_TABLE_ROWS));
      renderTableRows(el);
    }
    return el;
  }

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
      const path = selected.getAttribute(PATH_ATTR);
      const tag = selected.tagName.toLowerCase();
      selected.remove();
      selected = null;
      resizeOverlay.remove();
      parent.postMessage({ source: 'nb-design', type: 'deleted', path, tag }, '*');
    }
  });

  // ── Drag: reposition (Shift+drag) and reparent/reorder (plain drag) ────
  // Both start from mousedown on an already-selected element. Below the
  // drag threshold it's treated as a click, not a drag, so a quick
  // select-click doesn't get misread as a zero-distance drag.
  const DRAG_THRESHOLD = 4;
  let dragState = null; // { mode: 'reposition'|'reparent', el, startX, startY, origLeft, origTop, ... }

  function elementAtPoint(x, y, excludeEl) {
    if (excludeEl) excludeEl.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    if (excludeEl) excludeEl.style.pointerEvents = '';
    return el;
  }

  // Decide before/after/inside relative to targetEl's box at (x,y).
  // "inside" wins when the point is in the vertical middle band and the
  // element can sensibly hold children; otherwise before/after based on
  // which half of the box the point falls in.
  function computeDropSpot(targetEl, x, y) {
    if (!targetEl || targetEl === document.documentElement || targetEl === document.body && !targetEl.children.length) {
      // Falling back to document.body here doesn't mean body actually
      // covers the point being dragged over -- if the real page content
      // is shorter than the frame (very common: a toolbar mockup a few
      // hundred px tall inside an 800px-tall frame), body's own
      // getBoundingClientRect() only spans its content's height, nowhere
      // near the cursor if you're hovering the empty space below it. The
      // indicator previously used body's real (wrong) rect here, so it
      // rendered small and out of position instead of tracking the mouse
      // -- easy to mistake for "not showing at all". Synthesize a rect
      // that actually reaches the cursor's position instead.
      const bodyRect = document.body.getBoundingClientRect();
      return {
        targetEl: document.body,
        position: 'inside',
        syntheticRect: {
          top: y - 20,
          left: 0,
          width: Math.max(bodyRect.width, document.documentElement.clientWidth),
          height: 40,
        },
      };
    }
    const rect = targetEl.getBoundingClientRect();
    const relY = (y - rect.top) / (rect.height || 1);
    // children.length only counts element children, so a <div>Some text</div>
    // with no child *elements* counted as a leaf and could never accept an
    // "inside" drop -- even though a div with only text content is exactly
    // the kind of element you'd want to drop something into. hasChildNodes
    // additionally covers text/comment nodes; an element is only truly a
    // leaf (can't hold a dropped child sensibly) if it has no content at all
    // and isn't one of the void/self-closing tags that never take children.
    const isLeaf = !targetEl.hasChildNodes();
    // Below a certain box height the 25%-75% "inside" band becomes a razor-
    // thin strip (a few px on something like a 20px button), so ordinary
    // mouse jitter flickers the indicator between inside/before/after.
    // Widen the tolerance for short elements instead of using a fixed band.
    const MIN_BAND_HEIGHT = 24;
    const bandFraction = rect.height < MIN_BAND_HEIGHT ? 0.15 : 0.25;
    if (!isLeaf && relY > bandFraction && relY < (1 - bandFraction)) {
      return { targetEl, position: 'inside' };
    }
    return { targetEl, position: relY < 0.5 ? 'before' : 'after' };
  }

  function reportDropSpot(spot, clientX, clientY) {
    if (!spot) {
      parent.postMessage({ source: 'nb-design', type: 'dragOverClear' }, '*');
      return;
    }
    const r = spot.syntheticRect || spot.targetEl.getBoundingClientRect();
    parent.postMessage({
      source: 'nb-design', type: 'dragOver',
      position: spot.position,
      targetPath: spot.targetEl.getAttribute(PATH_ATTR) || '',
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    }, '*');
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !selected || selected === document.body || selected === document.documentElement || e.target !== selected && !selected.contains(e.target)) return;
    dragState = {
      mode: e.shiftKey ? 'reposition' : 'reparent',
      el: selected,
      srcPath: selected.getAttribute(PATH_ATTR),
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      origLeft: parseFloat(selected.style.left) || 0,
      origTop: parseFloat(selected.style.top) || 0,
    };
    e.preventDefault();
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragState.moved = true;

    if (dragState.mode === 'reposition') {
      const cs = getComputedStyle(dragState.el);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') {
        // Take it out of flow so left/top are meaningful. This is a real
        // layout change, which is exactly why plain drag doesn't do this
        // -- only an explicit Shift+drag opts into it.
        dragState.el.style.position = 'absolute';
      }
      dragState.el.style.left = (dragState.origLeft + dx) + 'px';
      dragState.el.style.top = (dragState.origTop + dy) + 'px';
      _resizeSyncHandles();
      parent.postMessage({ source: 'nb-design', type: 'dragMoveLive', path: dragState.el.getAttribute(PATH_ATTR) }, '*');
    } else {
      dragState.el.classList.add('__nb_dragging');
      resizeOverlay.style.display = 'none'; // hide handles while reparenting -- their position would lag/fight the drag
      // elementFromPoint (a hit-test/reflow) plus two postMessages ran on
      // every raw mousemove event -- on a high-frequency pointer that's
      // easily 100+ times a second, which is what made the drop indicator
      // feel laggy/janky rather than tracking the cursor smoothly. Coalesce
      // to one update per animation frame instead; only the latest
      // position within a frame is kept and processed.
      dragState.lastMoveX = e.clientX;
      dragState.lastMoveY = e.clientY;
      if (!dragState.rafPending) {
        dragState.rafPending = true;
        requestAnimationFrame(() => {
          if (!dragState) return;
          dragState.rafPending = false;
          const x = dragState.lastMoveX, y = dragState.lastMoveY;
          const under = elementAtPoint(x, y, dragState.el);
          const spot = (under && !dragState.el.contains(under) && under !== dragState.el)
            ? computeDropSpot(under, x, y)
            : null;
          dragState.pendingSpot = spot;
          reportDropSpot(spot, x, y);
        });
      }
    }
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!dragState) return;
    const { mode, el, moved } = dragState;
    if (mode === 'reparent') { el.classList.remove('__nb_dragging'); resizeOverlay.style.display = ''; }

    if (!moved) { dragState = null; return; }
    suppressNextClick = true;

    if (mode === 'reposition') {
      parent.postMessage({
        source: 'nb-design', type: 'repositioned',
        path: el.getAttribute(PATH_ATTR),
        left: el.style.left, top: el.style.top, position: el.style.position,
      }, '*');
    } else if (dragState.pendingSpot) {
      const { targetEl, position } = dragState.pendingSpot;
      if (position === 'inside') targetEl.appendChild(el);
      else if (position === 'before') targetEl.parentNode.insertBefore(el, targetEl);
      else targetEl.parentNode.insertBefore(el, targetEl.nextSibling);
      tagAll();
      const summary = selectEl(el);
      if (summary) {
        parent.postMessage({
          source: 'nb-design', type: 'moved', srcPath: dragState.srcPath,
          newParentPath: el.parentNode.getAttribute ? el.parentNode.getAttribute(PATH_ATTR) : '',
          element: summary,
        }, '*');
      }
      reportDropSpot(null);
    } else {
      reportDropSpot(null);
    }
    dragState = null;
  }, true);

  const style = document.createElement('style');
  document.documentElement.style.setProperty('--nb-studio-accent',
    parent.getComputedStyle(parent.document.documentElement).getPropertyValue('--accent').trim() || '#58a6ff');
  style.textContent = '.__nb_hover{outline:1.5px dashed var(--nb-studio-accent, #58a6ff)!important;outline-offset:1px;cursor:pointer;}' +
    '.__nb_selected{outline:2px solid var(--nb-studio-accent, #58a6ff)!important;outline-offset:1px;}' +
    '.__nb_dragging{opacity:0.4!important;}' +
    '#nb-design-viewport{transform-origin:0 0;will-change:transform;}';
  document.head.appendChild(style);

  const body = document.body;
  const viewport = document.createElement('div');
  viewport.id = 'nb-design-viewport';
  viewport.setAttribute('data-nb-synthetic', '');
  viewport.style.cssText = 'transform-origin:0 0;will-change:transform;';
  while (body.firstChild) viewport.appendChild(body.firstChild);
  body.appendChild(viewport);
  body.style.overflow = 'hidden';
  body.style.margin = '0';
  body.style.padding = '0';

  let _panX = 0, _panY = 0, _zoom = 1;
  function _applyViewportTransform() {
    viewport.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'nb-design-host') return;

    if (msg.type === 'nbpro:pan') {
      _panX = (msg.x || 0);
      _panY = (msg.y || 0);
      _applyViewportTransform();
    } else if (msg.type === 'nbpro:zoom') {
      _zoom = Math.max(0.25, Math.min(3, msg.scale || 1));
      _applyViewportTransform();
    } else if (msg.type === 'hostViewChanged') {
      // The host stage's pan/zoom (Zoom In/Out, scroll-wheel, drag-pan)
      // scales an ancestor of this iframe via CSS transform -- that
      // never fires a scroll/resize event *inside* the iframe, so
      // nothing told the resize-handle overlay to recompute. Its last
      // synced position (from whatever zoom level was active at
      // selection/resize time) just sat there in stale iframe-local
      // pixels while the visible box moved underneath it. Re-sync here
      // instead of relying on iframe-internal events that never fire.
      _resizeSyncHandles();
    } else if (msg.type === 'nbpro:flashAll') {
      // Live visual feedback only -- the parent handles actually
      // persisting the change to disk via source patching, on its own
      // debounce. This just keeps the canvas responsive while typing.
      const el = document.querySelector(`[${PATH_ATTR}="${msg.path}"]`);
      if (!el) return;
      if (msg.style) Object.entries(msg.style).forEach(([k, v]) => { el.style[k] = v; });
      if (typeof msg.id === 'string') el.id = msg.id;
      if (typeof msg.className === 'string') {
        // Re-apply whichever internal marker classes this element
        // currently carries (selected/hover/dragging) on top of the
        // user's new class list -- setAttribute('class', ...) replaces
        // the whole attribute, so writing the raw field value straight
        // through would silently strip __nb_selected off the very
        // element being edited and break its outline/handles.
        const markers = INTERNAL_MARKER_CLASSES.filter((c) => el.classList.contains(c));
        el.setAttribute('class', [msg.className, ...markers].filter(Boolean).join(' '));
      }
      if (typeof msg.text === 'string' && el.children.length === 0) el.textContent = msg.text;
      if (typeof msg.dataRows === 'string' && el.tagName === 'TABLE') {
        el.setAttribute('data-nb-rows', msg.dataRows);
        renderTableRows(el);
      }
      if (el === selected) _resizeSyncHandles();
    } else if (msg.type === 'applyLive') {
      const el = document.querySelector(`[${PATH_ATTR}="${msg.path}"]`);
      if (!el || !msg.attr || typeof msg.attr !== 'object') return;
      for (const name of ['data-nb-perm', 'data-nb-studio-action']) {
        if (!Object.prototype.hasOwnProperty.call(msg.attr, name)) continue;
        const value = msg.attr[name];
        if (typeof value !== 'string') continue;
        if (value) el.setAttribute(name, value);
        else el.removeAttribute(name);
      }
    } else if (msg.type === 'deleteSelected') {
      if (!selected) return;
      const path = selected.getAttribute(PATH_ATTR);
      const tag = selected.tagName.toLowerCase();
      selected.remove();
      selected = null;
      resizeOverlay.remove();
      parent.postMessage({ source: 'nb-design', type: 'deleted', path, tag }, '*');
    } else if (msg.type === 'insertInto') {
      if (!_insertGuardPass()) return;
      const parentEl = (msg.path && document.querySelector(`[${PATH_ATTR}="${msg.path}"]`)) || document.body;
      const el = makeElement(msg.elType);
      parentEl.appendChild(el);
      tagAll();
      parent.postMessage({
        source: 'nb-design', type: 'inserted',
        parentPath: parentEl.getAttribute(PATH_ATTR), elType: msg.elType,
        element: selectEl(el),
      }, '*');
    } else if (msg.type === 'duplicateSelected') {
      if (!selected || !selected.parentNode) return;
      const srcPath = selected.getAttribute(PATH_ATTR);
      const clone = selected.cloneNode(true);
      clone.removeAttribute('data-nb-studio-action');
      clone.querySelectorAll('[data-nb-studio-action]').forEach((el) => {
        el.removeAttribute('data-nb-studio-action');
      });
      selected.parentNode.insertBefore(clone, selected.nextSibling);
      tagAll();
      parent.postMessage({
        source: 'nb-design', type: 'duplicated', srcPath,
        element: selectEl(clone),
      }, '*');
    } else if (msg.type === 'paletteDragOver') {
      // Palette drag is a native HTML5 drag that starts outside the
      // iframe -- the parent tracks dragover on the frame element and
      // forwards translated (iframe-local) coordinates here on every
      // move, since the iframe itself never sees the drag events for a
      // drag that originated in the parent document.
      const under = document.elementFromPoint(msg.x, msg.y);
      const spot = under ? computeDropSpot(under, msg.x, msg.y) : { targetEl: document.body, position: 'inside' };
      reportDropSpot(spot);
    } else if (msg.type === 'paletteDrop') {
      if (!_insertGuardPass()) return;
      const under = document.elementFromPoint(msg.x, msg.y);
      const spot = under ? computeDropSpot(under, msg.x, msg.y) : { targetEl: document.body, position: 'inside' };
      const el = makeElement(msg.elType);
      if (spot.position === 'inside') spot.targetEl.appendChild(el);
      else if (spot.position === 'before') spot.targetEl.parentNode.insertBefore(el, spot.targetEl);
      else spot.targetEl.parentNode.insertBefore(el, spot.targetEl.nextSibling);
      tagAll();
      const parentNode = el.parentNode;
      parent.postMessage({
        source: 'nb-design', type: 'inserted',
        parentPath: parentNode.getAttribute ? parentNode.getAttribute(PATH_ATTR) : '',
        elType: msg.elType,
        element: selectEl(el),
      }, '*');
      reportDropSpot(null);
    }
  });
}

// ---------------------------------------------------------------------
// Parent-side glue: load the iframe once per project, wire the
// Attributes panel + palette + context menu to postMessage + the
// surgical-patch functions above.
// ---------------------------------------------------------------------

// Bumped on every _designLoadFrame() reload. Embedded in every message
// sent to/from the iframe so a stray message from an old, torn-down
// document (or a document mid-teardown when a reload was still async)
// gets silently dropped instead of processed twice. Confirmed with a
// second opinion (see the exchange that motivated this) that reassigning
// .srcdoc alone doesn't guarantee old-document teardown completes before
// the new one starts in Chromium, and that a preceding `frame.src =
// 'about:blank'` doesn't reliably help either (that navigation is itself
// async/cancelable and the immediately-following srcdoc assignment can
// just preempt it) -- so this generation check is the real backstop,
// not just a nice-to-have on top of clean teardown.
let _designFrameGen = 0;

function _designLoadFrame(force) {
  const frame = $('design-frame');
  const empty = $('design-empty');
  const emptyMsg = $('design-empty-msg');
  const emptyCreateBtn = $('design-empty-create');
  if (!frame) return;

  const indexPath = _designIndexPath();
  if (!indexPath) {
    // No project open at all -- the scaffold button can't do anything
    // useful here (there's no projectDir to write into), so hide it and
    // show a message that matches the actual situation.
    frame.srcdoc = '';
    if (emptyMsg) emptyMsg.textContent = 'No project open';
    emptyCreateBtn?.classList.add('hidden');
    empty?.classList.remove('hidden');
    _designFrameLoadedForDir = null;
    return;
  }

  // Only reload if we haven't loaded this project yet (or a reload was
  // explicitly forced, e.g. after an external file change). Switching
  // tabs and back just un-hides the existing iframe -- no re-read from
  // disk, no re-running the page's own <script> tags, no lost in-page
  // state.
  if (!force && _designFrameLoadedForDir === state.projectDir) return;

  let html;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch {
    // Project is open but its entry HTML doesn't exist yet -- this is the
    // case the scaffold button actually solves, so show it.
    frame.srcdoc = '';
    if (emptyMsg) emptyMsg.textContent = `No entry HTML found at ${path.relative(state.projectDir, indexPath)}`;
    emptyCreateBtn?.classList.remove('hidden');
    empty?.classList.remove('hidden');
    _designFrameLoadedForDir = null;
    return;
  }
  empty?.classList.add('hidden');

  _designFrameGen++;
  const gen = _designFrameGen;

  let previewBase = pathToFileURL(path.resolve(path.dirname(indexPath)) + path.sep).href;
  const sourceDoc = parse5.parse(html, { sourceCodeLocationInfo: false });
  const findBaseHref = (node) => {
    if (node.tagName === 'base') {
      const href = node.attrs?.find((attr) => attr.name === 'href')?.value;
      if (href) return href;
    }
    for (const child of node.childNodes || []) {
      const href = findBaseHref(child);
      if (href) return href;
    }
    return null;
  };
  const sourceBaseHref = findBaseHref(sourceDoc);
  if (sourceBaseHref) {
    try { previewBase = new URL(sourceBaseHref, pathToFileURL(indexPath).href).href; }
    catch { showToast('Design: invalid base URL in entry HTML; using the entry directory.'); }
  }
  const base = `<base href="${_escapeAttr(previewBase)}">`;
  const script = `<script>window.__NB_FRAME_GEN=${gen};(${_designInjectedScript.toString()})();<\/script>`;
  let withBase;
  if (/<head\b[^>]*>/i.test(html)) {
    withBase = html.replace(/<head\b[^>]*>/i, (head) => head + base);
  } else if (/<html\b[^>]*>/i.test(html)) {
    withBase = html.replace(/<html\b[^>]*>/i, (tag) => tag + '<head>' + base + '</head>');
  } else {
    withBase = '<head>' + base + '</head>' + html;
  }
  const withScript = /<\/body\s*>/i.test(withBase)
    ? withBase.replace(/<\/body\s*>/i, (close) => script + close)
    : /<\/html\s*>/i.test(withBase)
      ? withBase.replace(/<\/html\s*>/i, (close) => script + close)
      : withBase + script;

  // Hard teardown: replace the <iframe> element itself rather than just
  // its srcdoc. This is the one reliable way to force Chromium to fully
  // discard the old document's BrowsingContext (and every listener bound
  // inside it) before the new one loads -- reassigning .srcdoc in place
  // doesn't guarantee that ordering. cloneNode(false) copies id/class/
  // attributes but carries over no listeners or document state.
  //
  // This DOES mean any `const frameEl = $('design-frame')` captured once
  // at setup time (rather than re-queried at point of use) goes stale
  // after this runs -- checked every call site in this file; the only
  // offender was the drag/drop-to-canvas wiring in initDesignTab(),
  // fixed alongside this to re-query $('design-frame') per-use instead
  // of closing over a boot-time reference.
  const freshFrame = frame.cloneNode(false);
  frame.parentNode.replaceChild(freshFrame, frame);
  freshFrame.addEventListener('load', () => window._designCenterStage?.(), { once: true });
  window._nbproOnDesignFrameCreated?.(freshFrame);
  freshFrame.srcdoc = withScript;

  _designFrameLoadedForDir = state.projectDir;
  if (!_designReloadPreserveSelection) _designClearSelection();
}

// Call this after any change made *outside* the Design tab that could
// affect the entry HTML or its linked assets (e.g. saving in the Editor tab
// while it's open), so the canvas doesn't silently go stale relative to
// what's on disk.
function _designInvalidate() {
  _designFrameLoadedForDir = null;
  if (state.activeTab === 'design') _designLoadFrame(true);
}

function _designClearSelection() {
  if (!_designFlushPendingBeforeSelectionChange()) return false;
  _designSelectedPath = null;
  _designSelectedTag = null;
  $('design-attrs-empty')?.classList.remove('hidden');
  $('design-attrs-body')?.classList.add('hidden');
  return true;
}

// Any code path that's about to reassign or null out _designSelectedPath
// must call this first. A debounced text/style edit may still be pending
// against whatever is *currently* selected (see _designScheduleSave) --
// if the path changes out from under that timer, it either fires later
// against the wrong element (tripping the tag-mismatch guard in
// _designFlushEdit) or, if selection was cleared, gets silently dropped
// since _designFlushEdit bails on a null path. Flushing against the
// still-current selection before it changes avoids both.
function _designFlushPendingBeforeSelectionChange() {
  if (_designPendingEdit) {
    clearTimeout(_designWriteTimer);
    _designWriteTimer = null;
    return _designFlushEdit();
  }
  return true;
}

function _designShowSelection(el) {
  if (!el || typeof el.path !== 'string') { _designClearSelection(); return false; }
  const selectedPath = el.path.split('.').map(Number);
  if (!selectedPath.length || selectedPath.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    showToast('Design: received an invalid element path.');
    return false;
  }
  if (!_designFlushPendingBeforeSelectionChange()) return false;
  _designSelectedPath = selectedPath;
  _designSelectedTag = el.tag;
  $('design-attrs-empty')?.classList.add('hidden');
  $('design-attrs-body')?.classList.remove('hidden');

  $('design-attrs-tag').textContent = el.tag;
  $('design-attrs-id').textContent = el.id ? '#' + el.id : '';
  $('da-id').value = el.id || '';
  $('da-class').value = el.className || '';
  const setSelect = (id, value, fallback) => {
    const select = $(id);
    if (select) select.value = [...select.options].some((option) => option.value === value) ? value : fallback;
  };

  const textGroup = $('da-text-group');
  if (el.hasChildren) {
    textGroup.classList.add('hidden');
  } else {
    textGroup.classList.remove('hidden');
    $('da-text').value = el.text || '';
  }

  if (el.computedStyle) {
    const fallback = (prop) => (el.style[prop] || el.computedStyle[prop] || '');
    $('da-width').value = fallback('width');
    $('da-height').value = fallback('height');
    $('da-left').value = fallback('left');
    $('da-top').value = fallback('top');
    $('da-background').value = fallback('background');
    $('da-color').value = fallback('color');
    $('da-font-size').value = fallback('fontSize');
    $('da-opacity').value = fallback('opacity');
    setSelect('da-flex-direction', fallback('flexDirection'), 'row');
    setSelect('da-flex-wrap', fallback('flexWrap'), 'nowrap');
    setSelect('da-flex-justify', fallback('justifyContent'), 'flex-start');
    setSelect('da-flex-align', fallback('alignItems'), 'stretch');
    $('da-flex-gap').value = fallback('gap');
    $('da-grid-columns').value = fallback('gridTemplateColumns');
    $('da-grid-rows').value = fallback('gridTemplateRows');
    $('da-grid-areas').value = fallback('gridTemplateAreas');
    setSelect('da-grid-justify', fallback('justifyItems'), 'stretch');
    setSelect('da-grid-align', fallback('alignItems'), 'stretch');
    $('da-grid-gap').value = fallback('gap');
  } else {
    $('da-width').value = el.style.width || '';
    $('da-height').value = el.style.height || '';
    $('da-left').value = el.style.left || '';
    $('da-top').value = el.style.top || '';
    $('da-background').value = el.style.background || '';
    $('da-color').value = el.style.color || '';
    $('da-font-size').value = el.style.fontSize || '';
    $('da-opacity').value = el.style.opacity || '';

    setSelect('da-flex-direction', el.style.flexDirection, 'row');
    setSelect('da-flex-wrap', el.style.flexWrap, 'nowrap');
    setSelect('da-flex-justify', el.style.justifyContent, 'flex-start');
    setSelect('da-flex-align', el.style.alignItems, 'stretch');
    $('da-flex-gap').value = el.style.gap || '';
    $('da-grid-columns').value = el.style.gridTemplateColumns || '';
    $('da-grid-rows').value = el.style.gridTemplateRows || '';
    $('da-grid-areas').value = el.style.gridTemplateAreas || '';
    setSelect('da-grid-justify', el.style.justifyItems, 'stretch');
    setSelect('da-grid-align', el.style.alignItems, 'stretch');
    $('da-grid-gap').value = el.style.gap || '';
  }

  const displayVal = el.style.display || (el.computedStyle && el.computedStyle.display) || '';
  const mode = displayVal === 'flex' || displayVal === 'inline-flex'
    ? 'flex'
    : displayVal === 'grid' || displayVal === 'inline-grid' ? 'grid' : 'free';
  _designSetLayoutMode(mode, { silent: true });

  const tableGroup = $('da-table-group');
  if (tableGroup) {
    if (typeof el.nbRows === 'string') {
      tableGroup.classList.remove('hidden');
      $('da-table-rows').value = el.nbRows;
      $('da-table-error').textContent = '';
      $('da-table-error').classList.remove('error');
    } else {
      tableGroup.classList.add('hidden');
    }
  }

  const modeEl = $('design-attrs-mode');
  if (modeEl) {
    modeEl.textContent = el.className
      ? `Style edits patch .${el.className.trim().split(/\s+/)[0]} in a linked stylesheet (or fall back to inline style if no rule is found)`
      : 'No class on this element — style edits write directly to its style attribute';
  }
  return true;
}

// Switches which Layout sub-panel is visible (Free/Flex/Grid) and, unless
// { silent: true } (used when just reflecting an element's existing
// display value on selection), writes the corresponding `display` value
// and pushes/schedules the change like any other field edit. Keeping
// this one function as the single place that both toggles visibility AND
// decides the display value keeps the two from drifting apart -- the
// alternative (a click handler that shows a panel, trusting some other
// code to also set display) is exactly the kind of split that goes stale
// the next time one side gets edited and the other doesn't.
function _designSetLayoutMode(mode, opts) {
  const silent = opts && opts.silent;
  document.querySelectorAll('#da-layout-mode [data-layout-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layoutMode === mode);
  });
  $('da-layout-free')?.classList.toggle('hidden', mode !== 'free');
  $('da-layout-flex')?.classList.toggle('hidden', mode !== 'flex');
  $('da-layout-grid')?.classList.toggle('hidden', mode !== 'grid');
  if (!silent) {
    // Delegate to the normal full-field apply rather than writing just
    // `display` here -- _designApplySelectedEdits already reads whichever
    // mode is now active (this toggle already flipped above) and sends
    // its whole field set, so switching Free -> Flex both sets
    // display:flex AND reapplies any flex properties already sitting in
    // those fields from a previous session, instead of landing on
    // display:flex with no explicit flex properties until the user
    // happens to touch one.
    _designApplySelectedEdits();
  }
}

// Updates the Attributes-panel input fields to match values that changed
// via a direct canvas interaction (resize handles, free-position drag)
// rather than someone typing into the fields themselves. Without this,
// dragging a resize handle would change the element on screen and on
// disk but leave the width/height inputs showing whatever they said
// before the drag -- a real (if minor) staleness bug shared by both the
// resize and free-position-drag paths.
function _designSyncFieldsFromCanvas(vals) {
  if (typeof vals.width === 'string' && $('da-width')) $('da-width').value = vals.width;
  if (typeof vals.height === 'string' && $('da-height')) $('da-height').value = vals.height;
  if (typeof vals.left === 'string' && $('da-left')) $('da-left').value = vals.left;
  if (typeof vals.top === 'string' && $('da-top')) $('da-top').value = vals.top;
}

function _designPathStr() {
  return _designSelectedPath ? _designSelectedPath.join('.') : null;
}

// Pushes current Attributes-panel field values into the iframe for
// immediate visual feedback, and schedules the debounced on-disk patch.
function _designApplySelectedEdits() {
  const frame = $('design-frame');
  const pathStr = _designPathStr();
  if (!frame?.contentWindow || !pathStr) return;

  const activeModeBtn = document.querySelector('#da-layout-mode [data-layout-mode].active');
  const mode = activeModeBtn ? activeModeBtn.dataset.layoutMode : 'free';

  const edit = {
    id: $('da-id').value,
    className: $('da-class').value,
    style: {
      width: $('da-width').value,
      height: $('da-height').value,
      // Free-position fields only apply (and only get sent) in Free
      // mode -- sending stale left/top values while in Flex/Grid mode
      // would fight the very layout those modes are meant to hand off
      // to, since left/top on a flex/grid item still technically "work"
      // if the item is also positioned.
      left: mode === 'free' ? $('da-left').value : '',
      top: mode === 'free' ? $('da-top').value : '',
      background: $('da-background').value,
      color: $('da-color').value,
      fontSize: $('da-font-size').value,
      opacity: $('da-opacity').value,
      // 'free' clears display back to whatever it'd otherwise be (empty
      // string removes the property rather than forcing 'block'/'inline',
      // so an element that was e.g. naturally flex via a stylesheet rule
      // isn't fought by an inline override it never asked for).
      display: mode === 'flex' ? 'flex' : mode === 'grid' ? 'grid' : '',
    },
  };
  if (mode === 'flex') {
    Object.assign(edit.style, {
      flexDirection: $('da-flex-direction').value,
      flexWrap: $('da-flex-wrap').value,
      justifyContent: $('da-flex-justify').value,
      alignItems: $('da-flex-align').value,
      gap: $('da-flex-gap').value,
    });
  } else if (mode === 'grid') {
    Object.assign(edit.style, {
      gridTemplateColumns: $('da-grid-columns').value,
      gridTemplateRows: $('da-grid-rows').value,
      gridTemplateAreas: $('da-grid-areas').value,
      justifyItems: $('da-grid-justify').value,
      alignItems: $('da-grid-align').value,
      gap: $('da-grid-gap').value,
    });
  }
  if (!$('da-text-group').classList.contains('hidden')) edit.text = $('da-text').value;

  frame.contentWindow.postMessage({ source: 'nb-design-host', type: 'nbpro:flashAll', path: pathStr, ...edit }, '*');
  _designScheduleSave(edit);
}

// Table row data is user-typed JSON, not a style field -- validated
// before it's pushed anywhere, since malformed JSON reaching the CSS/HTML
// patcher would either write garbage into data-nb-rows or (worse) throw
// mid-save. Invalid input just shows an inline error and applies nothing
// until it parses, rather than saving on every keystroke like the other
// fields.
function _designApplyTableRows() {
  const frame = $('design-frame');
  const pathStr = _designPathStr();
  const raw = $('da-table-rows')?.value ?? '';
  const errEl = $('da-table-error');
  if (!frame?.contentWindow || !pathStr) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
    if (parsed.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('each row must be a JSON object');
    }
  } catch (err) {
    if (errEl) { errEl.textContent = 'Invalid JSON — ' + err.message; errEl.classList.add('error'); }
    return;
  }
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('error'); }

  const normalized = JSON.stringify(parsed);
  frame.contentWindow.postMessage({ source: 'nb-design-host', type: 'nbpro:flashAll', path: pathStr, dataRows: normalized }, '*');
  _designScheduleSave({ dataRows: normalized });
}

function _designHideContextMenu() {
  $('design-ctx-menu')?.classList.add('hidden');
}

function _designShowContextMenu(x, y, el) {
  const menu = $('design-ctx-menu');
  const frame = $('design-frame');
  if (!menu || !frame) return;
  _designShowSelection(el);
  menu.classList.remove('hidden');

  // x/y come from the iframe's own contextmenu event, in the iframe's
  // unscaled local pixel space. The frame can render at a different
  // on-screen size via the DPI-preset transform and/or the stage's
  // pan/zoom transform, so adding x/y straight to frameRect.left/top (as
  // _designShowDropIndicator's comment above already notes for the drop
  // indicator) only lines up at exactly 100% zoom/DPI -- at any other
  // level the menu opens wherever the click would've landed at 1:1,
  // nowhere near the actual cursor. Scale the offset the same way the
  // drop indicator does.
  const frameRect = frame.getBoundingClientRect();
  const scaleX = frame.offsetWidth ? frameRect.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight ? frameRect.height / frame.offsetHeight : 1;
  const pageX = frameRect.left + x * scaleX;
  const pageY = frameRect.top + y * scaleY;

  const menuW = 170;
  const menuH = 140;
  const clampedX = Math.min(pageX, window.innerWidth - menuW);
  const clampedY = Math.min(pageY, window.innerHeight - menuH);
  menu.style.left = Math.max(4, clampedX) + 'px';
  menu.style.top = Math.max(4, clampedY) + 'px';
}

// Positions the drop indicator over the iframe, translating the
// iframe-local rect the injected script reported into page coordinates --
// same translation the context menu already does via getBoundingClientRect,
// since the indicator is a parent-document element and has no idea where
// the iframe sits on its own.
function _designShowDropIndicator(position, rect) {
  const indicator = $('design-drop-indicator');
  const frame = $('design-frame');
  if (!indicator || !frame || !rect) return;
  const frameRect = frame.getBoundingClientRect();
  // `rect` comes from getBoundingClientRect() taken *inside* the iframe,
  // so it's in the iframe's own unscaled pixel space -- but the frame
  // itself can be rendered at a different on-screen size than that via
  // the DPI-preset transform (frameEl.style.transform) and/or the pan/zoom
  // transform on .design-stage-pan. Placing `rect` directly against
  // frameRect.left/top (as if scale were always 1) put the indicator
  // visibly off from the cursor at any zoom/DPI level other than 100%.
  // offsetWidth/Height aren't affected by CSS transforms, so comparing
  // them against the transformed getBoundingClientRect() size gives the
  // true combined scale factor without needing to read view.scale or the
  // DPI transform separately.
  const scaleX = frame.offsetWidth ? frameRect.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight ? frameRect.height / frame.offsetHeight : 1;
  const pageLeft = frameRect.left + rect.left * scaleX;
  const pageTop = frameRect.top + rect.top * scaleY;
  const scaledWidth = rect.width * scaleX;
  const scaledHeight = rect.height * scaleY;

  indicator.style.display = 'block';
  if (position === 'inside') {
    indicator.className = 'design-drop-indicator inside';
    indicator.style.left = pageLeft + 'px';
    indicator.style.top = pageTop + 'px';
    indicator.style.width = scaledWidth + 'px';
    indicator.style.height = scaledHeight + 'px';
  } else {
    indicator.className = 'design-drop-indicator line';
    indicator.style.left = pageLeft + 'px';
    indicator.style.width = scaledWidth + 'px';
    indicator.style.height = '';
    indicator.style.top = (position === 'before' ? pageTop - 1 : pageTop + scaledHeight - 2) + 'px';
  }
}

function _designHideDropIndicator() {
  const indicator = $('design-drop-indicator');
  if (indicator) indicator.style.display = 'none';
}

// Whatever is causing multiple calls per click hasn't been pinned down
// (every listener registration site traces to exactly one binding, so
// this isn't stacked duplicate listeners in any code path that's been
// checked) -- but it doesn't matter *why* upstream fires 2-4x if this
// function itself refuses to act on anything but the first call in a
// burst. A short re-entrancy window (one animation frame) collapses
// any duplicate calls for the same click into a single insert, without
// blocking two genuinely separate clicks a moment apart.
let _designInsertGuardUntil = 0;
function _designInsertElement(elType) {
  const now = performance.now();
  if (now < _designInsertGuardUntil) return;
  _designInsertGuardUntil = now + 50; // well under normal double-click timing, plenty above a same-tick multi-fire

  const frame = $('design-frame');
  if (!frame?.contentWindow) return;
  if ((elType === 'modal' || elType === 'table') && !_designEnsureRuntimeSupport()) return;
  frame.contentWindow.postMessage({ source: 'nb-design-host', type: 'insertInto', path: _designPathStr(), elType }, '*');
}

// Design canvas iframe lookups intentionally always re-query the DOM
// rather than caching the element once. _designLoadFrame() replaces the
// <iframe> element outright on reload (see its comment for why -- a hard
// teardown is the only reliable way to guarantee an old document's
// listeners are actually gone), so any variable that captured the
// element once at setup time would silently start pointing at a
// detached, dead node after the first reload. Both closures below that
// used to do `const frameEl = $('design-frame')` once now call this
// instead at each point of use.
function _designFrameEl() { return $('design-frame'); }

function initDesignTab() {
  if (window.__nbDesignInit) return;
  window.__nbDesignInit = true;

  $('design-empty-create')?.addEventListener('click', () => {
    if (_designScaffoldIndexHtml()) _designLoadFrame(true);
  });

  $('nbpro-btn-save')?.addEventListener('click', () => {
    if (_designPendingEdit) {
      clearTimeout(_designWriteTimer);
      _designWriteTimer = null;
      if (_designFlushEdit()) showToast('Design: changes saved.');
    } else {
      showToast('Design: no pending changes to save.');
    }
  });

  $('nbpro-btn-undo')?.addEventListener('click', () => _designDoUndo());
  $('nbpro-btn-redo')?.addEventListener('click', () => _designDoRedo());
  $('design-zoom-in')?.addEventListener('click', () => window._designZoomBy?.(1.25));
  $('design-zoom-out')?.addEventListener('click', () => window._designZoomBy?.(0.8));
  $('design-zoom-reset')?.addEventListener('click', () => window._designZoomReset?.());

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'nb-design' || e.source !== _designFrameEl()?.contentWindow) return;

    if (msg.type === 'select') {
      if (!_designShowSelection(msg.element)) return;
      _designHideContextMenu();
    } else if (msg.type === 'pathChanged') {
      // The currently-selected element's index shifted because some
      // unrelated part of the tree changed (insert/delete/drag on a
      // sibling elsewhere) -- not a new selection, just a stale path.
      // Only repoint if this is still the element we think is selected
      // (same tag); a mismatched tag means selection already moved on
      // through some other path and this message is now out of date.
      if (_designSelectedPath && msg.tag === _designSelectedTag) {
        _designSelectedPath = msg.path.split('.').map(Number);
      }
    } else if (msg.type === 'contextmenu') {
      if (!_designShowSelection(msg.element)) return;
      _designShowContextMenu(msg.x, msg.y, msg.element);
    } else if (msg.type === 'deleted') {
      // Deletion is a discrete action -- patch immediately rather than
      // going through the debounced field-edit path. But the path being
      // deleted isn't necessarily the one a pending debounced edit (from
      // whatever was selected before) is targeting -- flush that first.
      if (!_designFlushPendingBeforeSelectionChange()) {
        _designReloadFrame(true);
        return;
      }
      _designSelectedPath = msg.path.split('.').map(Number);
      _designSelectedTag = msg.tag;
      const htmlState = _designReadHtml();
      if (!htmlState) {
        _designReloadFrame();
        return;
      }
      if (!_designWriteImmediateHtmlEdits(_buildDeleteEdit(htmlState.doc))) return;
      _designClearSelection();
    } else if (msg.type === 'inserted' || msg.type === 'duplicated') {
      // These already exist in the live DOM (for instant feedback); we
      // still need them on disk. Re-serializing just the *new* node's
      // outerHTML and inserting it as a sibling in the source is more
      // surgical than a full-document rewrite, but simpler than trying
      // to teach parse5 to insert nodes -- ask the iframe for that one
      // element's HTML and splice it in as raw text next to its new
      // sibling/parent in the source.
      //
      // Order matters here: a debounced text/style edit may still be
      // pending against whatever was selected *before* this insert (see
      // _designScheduleSave). _designInsertNewNodeIntoSource splices new
      // text into index.html, which shifts every sibling after the
      // insertion point -- including, potentially, the node the pending
      // edit is targeting. Flush that edit against the *pre-insert* file
      // first, so it applies to the tree as it still stood when the
      // path was captured; only after that do we mutate the source for
      // the insert and repoint selection at the new node.
      if (!_designFlushPendingBeforeSelectionChange()) {
        _designReloadFrame(true);
        return;
      }
      if (!_designInsertNewNodeIntoSource(msg)) {
        _designReloadFrame();
        return;
      }
      _designShowSelection(msg.element);
    } else if (msg.type === 'dragOver') {
      _designShowDropIndicator(msg.position, msg.rect);
    } else if (msg.type === 'dragOverClear') {
      _designHideDropIndicator();
    } else if (msg.type === 'repositioned') {
      // Free-position drag (Shift+drag) already applied live in the
      // iframe; persist the resulting inline style through the same
      // debounced style-patch path field edits use, so this doesn't
      // need its own write logic.
      _designSelectedPath = msg.path.split('.').map(Number);
      _designScheduleSave({ style: { left: msg.left, top: msg.top, position: msg.position } });
      _designSyncFieldsFromCanvas({ left: msg.left, top: msg.top });
    } else if (msg.type === 'resized') {
      _designSelectedPath = msg.path.split('.').map(Number);
      _designScheduleSave({ style: { width: msg.width, height: msg.height, left: msg.left, top: msg.top } });
      _designSyncFieldsFromCanvas({ width: msg.width, height: msg.height, left: msg.left, top: msg.top });
    } else if (msg.type === 'moved') {
      // Reorder/reparent: the element already moved in the live DOM.
      // On disk this is "delete the node's old source span, insert its
      // HTML at the new location" -- reuse the same delete-edit and
      // insert-into-source helpers already built for Backspace and
      // palette/context-menu inserts, just chained back to back.
      //
      // Same ordering concern as the insert/duplicate case above:
      // _designMoveNodeInSource splices index.html directly, shifting
      // sibling indices for everything after either the old or new
      // position. Flush any pending edit against the pre-move tree
      // before that happens.
      _designHideDropIndicator();
      if (!_designFlushPendingBeforeSelectionChange()) {
        _designReloadFrame(true);
        return;
      }
      if (!_designMoveNodeInSource(msg)) {
        _designReloadFrame();
        return;
      }
      _designShowSelection(msg.element);
    }

    // Forward only after the core accepts a selection change; a failed
    // pending edit must not leave the extension inspector on a different
    // element than the core Attributes panel.
    if (window.NBPro && typeof window.NBPro.onDesignMessage === 'function') {
      try { window.NBPro.onDesignMessage(msg); } catch (err) {
        console.warn('[NBPro] message handler error:', err);
      }
    }
  });

  ['da-id', 'da-class', 'da-text', 'da-width', 'da-height', 'da-left', 'da-top',
    'da-background', 'da-color', 'da-font-size', 'da-opacity',
    'da-flex-direction', 'da-flex-wrap', 'da-flex-justify', 'da-flex-align', 'da-flex-gap',
    'da-grid-columns', 'da-grid-rows', 'da-grid-areas', 'da-grid-justify', 'da-grid-align', 'da-grid-gap'].forEach((id) => {
    const el = $(id);
    // <select> elements don't fire 'input' in every environment the way
    // text inputs do -- 'change' is the one event guaranteed to fire for
    // them, so listen for both rather than assuming 'input' alone covers
    // every field in this list (it covers the text/number inputs fine).
    el?.addEventListener('input', _designApplySelectedEdits);
    if (el?.tagName === 'SELECT') el.addEventListener('change', _designApplySelectedEdits);
  });

  document.querySelectorAll('#da-layout-mode [data-layout-mode]').forEach((btn) => {
    btn.addEventListener('click', () => _designSetLayoutMode(btn.dataset.layoutMode));
  });

  $('da-table-rows')?.addEventListener('input', _designApplyTableRows);

  $('da-delete')?.addEventListener('click', () => {
    $('design-frame')?.contentWindow?.postMessage({ source: 'nb-design-host', type: 'deleteSelected' }, '*');
  });

  document.querySelectorAll('#design-palette [data-el-type]').forEach((btn) => {
    // A click on a draggable button can, depending on the browser, also
    // register as a zero-distance drag (dragstart immediately followed
    // by dragend/drop) -- without this guard that fires BOTH the click
    // handler's insert AND the drop handler's insert for one gesture,
    // which is the double/triple-insert bug. Track whether a real drag
    // (one that produced a 'dragstart') happened on this button and
    // skip the click-insert if so.
    let didDrag = false;

    btn.addEventListener('click', () => {
      if (didDrag) { didDrag = false; return; }
      _designInsertElement(btn.dataset.elType);
    });

    // Drag-to-place: a native HTML5 drag that starts in the parent
    // document (the palette button) and ends over the iframe. The
    // iframe never receives these drag events directly since the drag
    // didn't originate inside it, so the frame's dragover/drop handlers
    // below translate coordinates and forward them via postMessage.
    btn.addEventListener('dragstart', (e) => {
      didDrag = true;
      e.dataTransfer.setData('text/nb-el-type', btn.dataset.elType);
      e.dataTransfer.effectAllowed = 'copy';
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      _designHideDropIndicator();
      setTimeout(() => { didDrag = false; }, 0);
    });
  });

  const stageEl = $('design-stage');
  if (_designFrameEl() && stageEl) {
    // The frame can render at a different on-screen size than its own
    // internal pixel dimensions -- via the DPI-preset transform on the
    // frame itself and/or the pan/zoom transform on .design-stage-pan.
    // e.clientX/Y are host-page (post-transform) coordinates, but the
    // iframe's own elementFromPoint (used by computeDropSpot on the other
    // side of this postMessage) needs coordinates in the iframe's
    // *internal* pixel space. Dividing out the combined scale -- same
    // approach as _designShowDropIndicator's fix -- keeps the drop
    // position lined up with the actual cursor at any zoom/DPI level;
    // previously this was 1:1 host-pixel math, so at any zoom other than
    // 100% palette drops landed away from where the cursor visually was.
    const frameScale = () => {
      const frameEl = _designFrameEl();
      const r = frameEl.getBoundingClientRect();
      return {
        x: frameEl.offsetWidth ? r.width / frameEl.offsetWidth : 1,
        y: frameEl.offsetHeight ? r.height / frameEl.offsetHeight : 1,
        rect: r,
      };
    };
    // Whether a client point actually lands on the rendered page mockup
    // (the iframe), vs. the surrounding dotted stage background. At any
    // zoom below 100% the mockup only covers a fraction of the visible
    // canvas -- most of the viewport is stage background, not iframe.
    const isOverFrame = (clientX, clientY) => {
      const r = _designFrameEl().getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    // An <iframe> is a separate browsing context. During a native HTML5
    // drag, once the cursor crosses onto an iframe's rendered area the
    // browser resolves drag events against the iframe's own content
    // document, not the parent's -- and since this drag originates
    // outside the iframe (from a palette in the parent document) and the
    // iframe's document has no dragover/drop listeners of its own to
    // forward anything back, the events simply stop arriving anywhere.
    // The result: dragover/drop fired fine over the stage background, but
    // died the instant the cursor reached the actual page mockup. The
    // standard workaround is to make the iframe transparent to pointer
    // events for the duration of the drag, so hit-testing falls through
    // to the stage element underneath and the parent's listeners keep
    // receiving events the whole time, including directly over the page.
    // Delegated on document (rather than bound per-button) because the
    // Native-tab palette re-renders its buttons on every tab switch --
    // listeners attached to specific button elements at init time
    // wouldn't survive that re-render.
    document.addEventListener('dragstart', (e) => {
      if (e.target.closest('#design-palette [data-el-type]') ||
          e.target.closest('#nbpro-native-palette [data-nb-comp]') ||
          e.target.closest('#nbpro-custom-palette [data-nb-custom]')) {
        const frameEl = _designFrameEl();
        if (frameEl) frameEl.style.pointerEvents = 'none';
      }
    });
    document.addEventListener('dragend', () => {
      const frameEl = _designFrameEl();
      if (frameEl) frameEl.style.pointerEvents = '';
    });
    // These listeners live on the stage (rather than only on the iframe
    // itself) purely so the pointer-events-none workaround above actually
    // works: with the iframe transparent to pointer events during a drag,
    // hit-testing on this region resolves to the stage element underneath
    // it, so the stage is what needs to own dragover/drop, not the frame.
    // The isOverFrame check below still restricts *where a drop actually
    // lands* to the page mockup itself -- dragging onto the surrounding
    // dotted background is intentionally rejected (no preventDefault,
    // browser shows its normal not-a-drop-target cursor there), since
    // there's no meaningful in-page location to insert into out there.
    stageEl.addEventListener('dragover', (e) => {
      if (!isOverFrame(e.clientX, e.clientY)) {
        // Outside the actual page mockup there's nowhere meaningful to
        // drop -- leave preventDefault() uncalled so the browser shows
        // its normal not-a-drop-target cursor here, same as any other
        // non-drop-target area of the page.
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const { x: sx, y: sy, rect } = frameScale();
      _designFrameEl().contentWindow?.postMessage({
        source: 'nb-design-host', type: 'paletteDragOver',
        x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy,
      }, '*');
    });
    stageEl.addEventListener('drop', (e) => {
      // dragend doesn't reliably fire for a drop that lands on a valid
      // target in every browser -- restore synchronously here too rather
      // than depending solely on the dragend listener above.
      const frameElNow = _designFrameEl();
      if (frameElNow) frameElNow.style.pointerEvents = '';
      if (!isOverFrame(e.clientX, e.clientY)) {
        // Dropped outside the page mockup -- not a valid drop target,
        // same as dragover above. Don't preventDefault/insert anything.
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // The Native-tab palette (design-pro.js) uses its own MIME types
      // for built-in vs. custom components, since those are HTML+CSS
      // snippets inserted via _injectComponentHtml, not single elements
      // the iframe's own makeElement() can build from a type name. Check
      // for those first -- previously this only ever read 'text/nb-el-type'
      // (the base palette's key), so dragging anything from the Native
      // tab silently did nothing on drop.
      const nativeCompId = e.dataTransfer.getData('text/nbpro-comp');
      if (nativeCompId) { window.NBPro?.insertNativeComponent?.(nativeCompId); return; }
      const customCompId = e.dataTransfer.getData('text/nbpro-custom');
      if (customCompId) { window.NBPro?.insertCustomComponent?.(customCompId); return; }
      const elType = e.dataTransfer.getData('text/nb-el-type');
      if (!elType) return;
      if ((elType === 'modal' || elType === 'table') && !_designEnsureRuntimeSupport()) return;
      const { x: sx, y: sy, rect } = frameScale();
      _designFrameEl().contentWindow?.postMessage({
        source: 'nb-design-host', type: 'paletteDrop',
        elType, x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy,
      }, '*');
    });
  }

  // Pan/zoom: transform .design-stage-pan directly (the host-side wrapper
  // around the iframe), rather than the earlier approach of postMessage-ing
  // 'nbpro:pan'/'nbpro:zoom' into the iframe's own internal viewport wrapper.
  // That older approach had two real problems: it only fired while the
  // cursor was directly over #design-frame (an iframe captures its own
  // mouse/wheel events once the cursor enters it, so dragging/scrolling
  // over the surrounding empty stage did nothing), and it moved content
  // *inside* the iframe document instead of the box that contains it --
  // so the frame itself never actually recentered or resized on screen.
  // Binding to #design-stage instead means the whole empty canvas area is
  // draggable/scrollable, not just the page preview sitting inside it.
  _designInitStagePanZoom();

  document.querySelectorAll('#design-ctx-submenu [data-el-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _designInsertElement(btn.dataset.elType);
      _designHideContextMenu();
    });
  });
  $('ctx-duplicate')?.addEventListener('click', () => {
    $('design-frame')?.contentWindow?.postMessage({ source: 'nb-design-host', type: 'duplicateSelected' }, '*');
    _designHideContextMenu();
  });
  $('ctx-delete')?.addEventListener('click', () => {
    $('design-frame')?.contentWindow?.postMessage({ source: 'nb-design-host', type: 'deleteSelected' }, '*');
    _designHideContextMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('design-ctx-menu')?.contains(e.target)) _designHideContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _designHideContextMenu();
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); _designDoUndo(); }
    if (meta && e.key === 'z' && e.shiftKey) { e.preventDefault(); _designDoRedo(); }
    if (meta && e.key === 'Z' && !e.shiftKey) { e.preventDefault(); _designDoUndo(); }
    if (meta && e.key === 'Z' && e.shiftKey) { e.preventDefault(); _designDoRedo(); }
  });

  // Fullscreen close: X button and Escape both return to the editor tab.
  // Escape is scoped to only fire when the fullscreen overlay is actually
  // open, so it doesn't fight with the context-menu Escape handler above
  // or steal Escape from unrelated tabs.
  $('design-fs-close')?.addEventListener('click', () => switchTab('editor'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('design-fullscreen')?.classList.contains('design-fullscreen--open')) return;
    switchTab('editor');
  });

  // Floating palette / attrs panel collapse and reopen. Collapsing just
  // toggles classes -- style.css handles hiding the panel content and
  // showing the corresponding reopen tab via .design-panel--collapsed /
  // the hidden class on the reopen buttons.
  const _designTogglePanel = (panelId, collapseBtnId, reopenBtnId) => {
    const panel = $(panelId);
    const reopenBtn = $(reopenBtnId);
    $(collapseBtnId)?.addEventListener('click', () => {
      panel?.classList.add('design-panel--collapsed');
      reopenBtn?.classList.remove('hidden');
    });
    reopenBtn?.addEventListener('click', () => {
      panel?.classList.remove('design-panel--collapsed');
      reopenBtn.classList.add('hidden');
    });
  };
  _designTogglePanel('design-palette', 'design-palette-collapse', 'design-palette-reopen');
  _designTogglePanel('design-attrs-col', 'design-attrs-collapse', 'design-attrs-reopen');

  // DPI and Window popups: each trigger button toggles its own popup and
  // closes the other one, so only one is ever open at a time. Clicking
  // anywhere outside both popups and their triggers closes whichever is
  // open -- checked on the capture phase so it still fires even if the
  // click target is later removed/hidden by other handlers.
  const _designTogglePopup = (triggerId, popupId, otherPopupId) => {
    $(triggerId)?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = $(popupId);
      const wasOpen = popup && !popup.classList.contains('hidden');
      $(otherPopupId)?.classList.add('hidden');
      popup?.classList.toggle('hidden', wasOpen);
    });
  };
  _designTogglePopup('design-dpi-trigger', 'design-dpi-popup', 'design-window-popup');
  _designTogglePopup('design-window-trigger', 'design-window-popup', 'design-dpi-popup');
  $('design-dpi-popup-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('design-dpi-popup')?.classList.add('hidden');
  });
  $('design-window-popup-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('design-window-popup')?.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    const dpiPopup = $('design-dpi-popup');
    const windowPopup = $('design-window-popup');
    if (dpiPopup && !dpiPopup.classList.contains('hidden') &&
        !dpiPopup.contains(e.target) && e.target.id !== 'design-dpi-trigger') {
      dpiPopup.classList.add('hidden');
    }
    if (windowPopup && !windowPopup.classList.contains('hidden') &&
        !windowPopup.contains(e.target) && e.target.id !== 'design-window-trigger') {
      windowPopup.classList.add('hidden');
    }
  }, true);
}

// Keeps the zoom-percentage readout in the toolbar in sync with whatever
// last changed view.scale (wheel, drag re-apply, buttons, or a DPI-preset
// re-center) -- defined at module scope, not inside
// _designInitStagePanZoom, so it's safe to call before that closure has
// necessarily finished setting up on first load.
function _designUpdateZoomReadout(scale) {
  const el = $('design-zoom-pct');
  if (el) el.textContent = Math.round(scale * 100) + '%';
}

function _designInitStagePanZoom() {
  const stage = $('design-stage');
  const panWrap = $('design-stage-pan');
  if (!stage || !panWrap) return;

  const view = { x: 0, y: 0, scale: 1 };
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 4;
  const resizeHandle = $('design-frame-resize-handle');

  // Keeps the (now fixed-position, see index.html/style.css comments)
  // resize handle glued to the frame's actual on-screen bottom-right
  // corner. Called from apply() so it stays in sync with every pan, zoom,
  // center, and DPI-preset resize -- anywhere the frame's screen position
  // can change.
  function syncHandlePosition() {
    const frameEl = _designFrameEl();
    if (!resizeHandle || !frameEl) return;
    const r = frameEl.getBoundingClientRect();
    resizeHandle.style.left = (r.right - 8) + 'px';
    resizeHandle.style.top = (r.bottom - 8) + 'px';
  }

  function apply() {
    panWrap.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    syncHandlePosition();
    _designUpdateZoomReadout(view.scale);
    // Tell the iframe's own selection overlay to recompute -- see the
    // 'hostViewChanged' handler in _designInjectedScript for why this
    // can't just rely on iframe-internal scroll/resize events.
    const frameEl = _designFrameEl();
    frameEl?.contentWindow?.postMessage({ source: 'nb-design-host', type: 'hostViewChanged' }, '*');
  }

  // Center the frame in the stage. Scales down to fit if the frame is
  // larger than the available stage area (common on smaller windows or
  // with a large DPI preset active) rather than forcing 1:1 and letting
  // the frame run off-screen with no visible edge/shadow -- but never
  // scales up past 1:1 on its own, since that would make small pages
  // look artificially zoomed in before the user's touched anything.
  function center() {
    const stageRect = stage.getBoundingClientRect();
    const frameRect = panWrap.getBoundingClientRect();
    const frameEl = _designFrameEl();
    if (stageRect.width <= 0 || stageRect.height <= 0 || frameRect.width <= 0 || frameRect.height <= 0) return;
    // .design-frame can carry its own transform:scale() from the DPI
    // scale chips (100/125/150/200%, see _applyDpiToFrame in
    // design-pro.js) independent of view.scale (pan/zoom). frameRect
    // already reflects both scales multiplied together, so dividing out
    // view.scale alone left the DPI factor baked into "natural" size --
    // at 150% that inflated naturalW/H by 1.5x, which fed a wrong
    // fitScale back into view.scale and stomped whatever zoom level the
    // user had, every time a DPI control fired center(). Reading the
    // frame's own scale and dividing that out too gives the frame's true
    // unscaled size.
    let dpiScale = 1;
    const frameTransform = frameEl ? frameEl.style.transform : '';
    const m = frameTransform && frameTransform.match(/scale\(([\d.]+)\)/);
    if (m) dpiScale = parseFloat(m[1]) || 1;
    const naturalW = frameRect.width / (view.scale || 1) / dpiScale;
    const naturalH = frameRect.height / (view.scale || 1) / dpiScale;
    if (!Number.isFinite(naturalW) || !Number.isFinite(naturalH) || naturalW <= 0 || naturalH <= 0) return;
    const pad = 40;
    const fitScale = Math.min(
      1,
      (stageRect.width - pad * 2) / naturalW,
      (stageRect.height - pad * 2) / naturalH
    );
    view.scale = Math.max(MIN_SCALE, fitScale);
    view.x = (stageRect.width - naturalW * view.scale) / 2;
    view.y = (stageRect.height - naturalH * view.scale) / 2;
    apply();
  }
  window._designCenterStage = center;

  let dragState = null;
  stage.addEventListener('mousedown', (e) => {
    // Left-click drag anywhere on the stage pans the canvas. Clicks that
    // land on actual page content still reach the iframe normally for
    // selection -- this only intercepts drags that start on empty stage
    // background, palette items, or the frame's own chrome/shadow, since
    // starting a pan mid-selection would be surprising. A plain click
    // (no movement) falls through as a click, not a drag.
    if (e.button !== 0 || e.target !== stage) return;
    dragState = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    stage.classList.add('design-stage--panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    view.x = dragState.origX + (e.clientX - dragState.startX);
    view.y = dragState.origY + (e.clientY - dragState.startY);
    apply();
  });
  window.addEventListener('mouseup', () => {
    dragState = null;
    stage.classList.remove('design-stage--panning');
  });

  // Middle-mouse drag pans too, and works even when the cursor starts over
  // the iframe/frame content -- useful for panning without losing whatever
  // is currently selected.
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    dragState = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    stage.classList.add('design-stage--panning');
  });

  // Shared zoom-around-a-point logic. cx/cy are stage-local coordinates
  // (i.e. already relative to stageRect); wheel passes the cursor position,
  // toolbar buttons pass the stage's own center so zooming via the
  // Zoom In/Out buttons behaves the same as scrolling in the middle of
  // the canvas instead of jumping to some arbitrary corner.
  function zoomBy(factor, cx, cy) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const stageRect = stage.getBoundingClientRect();
    if (cx === undefined) cx = stageRect.width / 2;
    if (cy === undefined) cy = stageRect.height / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    const prevScale = view.scale;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor));
    if (nextScale === prevScale) return;
    view.x = cx - ((cx - view.x) / prevScale) * nextScale;
    view.y = cy - ((cy - view.y) / prevScale) * nextScale;
    view.scale = nextScale;
    apply();
  }
  window._designZoomBy = zoomBy;
  window._designZoomReset = () => { view.scale = 1; view.x = 0; view.y = 0; apply(); center(); };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
  }, { passive: false });

  // The iframe itself still needs pointer-events disabled while actively
  // panning, otherwise the drag gets swallowed the instant the cursor
  // crosses into the frame document mid-drag.
  stage.addEventListener('mousedown', (e) => {
    if (e.button === 0 || e.button === 1) {
      const onUp = () => {
        const frameEl = _designFrameEl();
        if (frameEl) frameEl.style.pointerEvents = '';
        window.removeEventListener('mouseup', onUp);
      };
      const frameEl = _designFrameEl();
      if (frameEl && e.target !== frameEl) frameEl.style.pointerEvents = 'none';
      window.addEventListener('mouseup', onUp);
    }
  });

  // Show the resize handle while the cursor is anywhere over the stage
  // (not just the tiny 16px handle itself, which can't be discovered by
  // hover if it's the only thing that reveals it) -- it now lives outside
  // .design-stage-pan as a direct child of .design-fullscreen (see
  // index.html/style.css comments), so plain CSS :hover on an ancestor
  // can't reach it anymore; this replaces that with the JS equivalent.
  if (resizeHandle) {
    stage.addEventListener('mouseenter', () => resizeHandle.classList.add('is-hover-visible'));
    stage.addEventListener('mouseleave', () => {
      if (!resizeHandle.classList.contains('is-resizing')) resizeHandle.classList.remove('is-hover-visible');
    });
  }

  // Corner handle to resize the frame itself (its real pixel dimensions,
  // same width/height knob _applyDpiToFrame uses for DPI presets) rather
  // than the pan/zoom view. Drag deltas are divided by view.scale (frozen
  // at drag-start) to get real frame px -- otherwise resizing while
  // zoomed in/out would move the edge faster or slower than the cursor.
  // Does NOT touch view.scale itself -- an earlier version auto-shrank the
  // view to keep the growing frame on screen, but rewriting scale mid-drag
  // made the frame's own edge (and the handle chasing it) feel unstable
  // under the cursor. Plain resize now: the frame can run past the visible
  // stage edge same as scrolling any oversized content, rather than the
  // view zooming itself out from under you while you drag.
  if (resizeHandle) {
    const MIN_FRAME = 200;
    const MAX_FRAME = 6000;
    let resizeState = null;

    resizeHandle.addEventListener('mousedown', (e) => {
      const frameEl = _designFrameEl();
      if (!frameEl) return;
      e.preventDefault();
      e.stopPropagation(); // don't let this also start a stage pan
      resizeState = {
        startX: e.clientX,
        startY: e.clientY,
        startW: frameEl.offsetWidth,
        startH: frameEl.offsetHeight,
        startScale: view.scale,
      };
      resizeHandle.classList.add('is-resizing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizeState) return;
      const frameEl = _designFrameEl();
      if (!frameEl) return;
      const dx = (e.clientX - resizeState.startX) / (resizeState.startScale || 1);
      const dy = (e.clientY - resizeState.startY) / (resizeState.startScale || 1);
      const nextW = Math.min(MAX_FRAME, Math.max(MIN_FRAME, Math.round(resizeState.startW + dx)));
      const nextH = Math.min(MAX_FRAME, Math.max(MIN_FRAME, Math.round(resizeState.startH + dy)));
      frameEl.style.width = nextW + 'px';
      frameEl.style.height = nextH + 'px';
      syncHandlePosition();
    });
    window.addEventListener('mouseup', () => {
      if (!resizeState) return;
      resizeState = null;
      resizeHandle.classList.remove('is-resizing');
      resizeHandle.classList.remove('is-hover-visible');
      // Any manual DPI preset is no longer accurate once the user's hand-
      // sized the frame -- clear just the chip/active-state bookkeeping,
      // not the frame's own size (setDpiPreset(null) would also reset the
      // width/height back to the un-framed default, undoing the resize
      // that just happened).
      if (window.NBPro && typeof window.NBPro.clearDpiPresetFlagOnly === 'function') {
        window.NBPro.clearDpiPresetFlagOnly();
      }
    });
  }

  center();
}

// Inserting a brand-new element into the source: ask the live iframe for
// the new node's outerHTML, then splice it into the source text right
// after its parent's opening tag (for insertInto) or right after the
// original element's closing tag (for duplicate). Falls back to
// reporting a toast rather than guessing if the anchor location can't be
// found -- e.g. the parent is a synthetic <body> with no source
// location because the file never wrote one out explicitly.
function _designInsertNewNodeIntoSource(msg) {
  const frame = $('design-frame');
  if (!frame?.contentWindow?.document) return false;
  const pathAttr = 'data-nb-design-path';
  const newPath = msg.element.path;
  const newNode = frame.contentWindow.document.querySelector(`[${pathAttr}="${newPath}"]`);
  if (!newNode) return false;

  const clone = newNode.cloneNode(true);
  clone.classList.remove('__nb_hover', '__nb_selected');
  clone.querySelectorAll('[' + pathAttr + ']').forEach((n) => n.removeAttribute(pathAttr));
  clone.removeAttribute(pathAttr);
  if (!clone.getAttribute('class')) clone.removeAttribute('class');
  const outerHtml = clone.outerHTML;

  const htmlState = _designReadHtml();
  if (!htmlState) return false;

  let anchorPath, insertAfter;
  if (msg.type === 'inserted') {
    anchorPath = msg.parentPath.split('.').map(Number);
    insertAfter = 'startTag'; // insert right after parent's opening tag
  } else {
    anchorPath = msg.srcPath.split('.').map(Number);
    insertAfter = 'endTag'; // insert right after the duplicated-from element
  }

  const anchorNode = _parse5NodeAtPath(htmlState.doc, anchorPath);
  if (!anchorNode || !anchorNode.sourceCodeLocation) {
    showToast('Design: could not place the new element in index.html — try selecting a different parent');
    return false;
  }
  const loc = anchorNode.sourceCodeLocation;
  const offset = insertAfter === 'startTag'
    ? (loc.startTag ? loc.startTag.endOffset : loc.startOffset)
    : (loc.endTag ? loc.endTag.endOffset : loc.endOffset);

  if (!_designPushUndo(msg.type === 'duplicated' ? 'duplicate' : 'insert')) return false;
  const edited = _spliceEdits(htmlState.text, [{ start: offset, end: offset, replacement: outerHtml }]);
  try {
    fs.writeFileSync(htmlState.path, edited, 'utf8');
    _designNoteOwnWrite();
  } catch (err) {
    _designUndoStack.pop();
    showToast('Could not save the entry HTML: ' + err.message);
    return false;
  }

  // This just spliced a new sibling into index.html at a live-DOM-derived
  // position. If something *other* than the inserted/duplicated node was
  // already selected in the same parent, its path on disk may have just
  // shifted -- but no DOM mutation happened for it (the insert only
  // touched the live DOM at msg.element's node), so the iframe's own
  // MutationObserver/pathChanged mechanism never fires for it. Re-derive
  // the selection path straight from the live iframe DOM (already correct,
  // since tagAll() re-stamps on every DOM change) rather than trusting
  // whatever path was captured before this write -- otherwise the next
  // flush of a still-in-progress edit (e.g. someone mid-typing in the text
  // field) resolves against the wrong node in the just-mutated file.
  if (_designSelectedPath && frame.contentWindow.document) {
    const stillSelected = frame.contentWindow.document.querySelector(`[${pathAttr}].__nb_selected`);
    if (stillSelected) {
      const freshPath = stillSelected.getAttribute(pathAttr);
      if (freshPath) _designSelectedPath = freshPath.split('.').map(Number);
    }
  }
  return true;
}

// Reorder/reparent: the element already moved in the live DOM (both old
// and new positions only exist as paths at this point -- the node itself
// has one location now). On disk this is a delete-then-insert against a
// single fresh parse, same idea as _designInsertNewNodeIntoSource but
// sourcing the moved HTML from the iframe's *current* state (post-move)
// rather than a freshly-created node, and computing the delete span from
// the path the element had *before* the drag.
function _designMoveNodeInSource(msg) {
  const frame = $('design-frame');
  if (!frame?.contentWindow?.document) return false;
  const pathAttr = 'data-nb-design-path';
  const newPath = msg.element.path;
  const movedNode = frame.contentWindow.document.querySelector(`[${pathAttr}="${newPath}"]`);
  if (!movedNode) return false;

  const clone = movedNode.cloneNode(true);
  clone.classList.remove('__nb_hover', '__nb_selected', '__nb_dragging');
  clone.querySelectorAll('[' + pathAttr + ']').forEach((n) => n.removeAttribute(pathAttr));
  clone.removeAttribute(pathAttr);
  if (!clone.getAttribute('class')) clone.removeAttribute('class');
  const outerHtml = clone.outerHTML;

  const htmlState = _designReadHtml();
  if (!htmlState) return false;

  // 1. Find and remove the element's OLD source span, using the path it
  // had before this drag (srcPath, captured by the iframe pre-move).
  const oldPathArr = msg.srcPath.split('.').map(Number);
  const oldNode = _parse5NodeAtPath(htmlState.doc, oldPathArr);
  if (!oldNode || !oldNode.sourceCodeLocation) {
    showToast('Design: could not locate the element\'s original position in index.html — move not saved');
    return false;
  }
  const oldLoc = oldNode.sourceCodeLocation;
  const withoutOld = _spliceEdits(htmlState.text, [{ start: oldLoc.startOffset, end: oldLoc.endOffset, replacement: '' }]);

  // 2. Re-parse the now-shorter text (offsets shift after any splice).
  // newParentPath alone only says WHICH element the node landed inside --
  // it says nothing about sibling order, so for a before/after drop
  // (the common case: reordering within the same parent) anchoring on
  // the parent's startTag would always insert as first child regardless
  // of where the drop actually happened. Anchor on the element's actual
  // NEXT sibling in the live (post-move) DOM instead -- that sibling's
  // position is exactly "where the moved node needs to go" whether it
  // ended up first, last, or in the middle.
  const doc2 = parse5.parse(withoutOld, { sourceCodeLocationInfo: true });
  const newParentPath = (msg.newParentPath || '').split('.').filter((s) => s !== '').map(Number);
  const newParentNode = newParentPath.length ? _parse5NodeAtPath(doc2, newParentPath) : doc2;
  if (!newParentNode || !newParentNode.sourceCodeLocation) {
    showToast('Design: could not place the element at its new position in index.html — move not saved');
    return false;
  }

  const liveNextSibling = movedNode.nextElementSibling;
  let insertOffset = null;
  if (liveNextSibling) {
    const nextPath = liveNextSibling.getAttribute(pathAttr);
    if (nextPath) {
      // The moved node still occupies its OLD position in the tagged
      // live DOM (tagAll() ran after the move), so the next sibling's
      // path is relative to the tree as it stands now -- same tree
      // shape doc2 was parsed from, since doc2 only differs from the
      // live DOM by the text that was already removed above.
      const nextIdxs = nextPath.split('.').map(Number);
      const nextNode = _parse5NodeAtPath(doc2, nextIdxs);
      if (nextNode && nextNode.sourceCodeLocation) {
        insertOffset = nextNode.sourceCodeLocation.startOffset;
      }
    }
  }
  if (insertOffset === null) {
    // No next sibling (dropped as last child, or sibling lookup failed
    // safely) -- fall back to right before the parent's closing tag so
    // it lands as the last child, which is correct for that case and a
    // safe default otherwise.
    const newLoc = newParentNode.sourceCodeLocation;
    insertOffset = newLoc.endTag ? newLoc.endTag.startOffset : newLoc.startTag.endOffset;
  }

  const finalText = _spliceEdits(withoutOld, [{ start: insertOffset, end: insertOffset, replacement: outerHtml }]);
  if (!_designPushUndo('move')) return false;
  try {
    fs.writeFileSync(htmlState.path, finalText, 'utf8');
    _designNoteOwnWrite();
  } catch (err) {
    _designUndoStack.pop();
    showToast('Could not save the entry HTML: ' + err.message);
    return false;
  }
  return true;
}

// File tree


// File tree

// Custom SVG fallback icons for file types without a dedicated Devicon.
const FILE_ICONS = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.svg': 'image', '.webp': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio',
  '.txt': 'file',
};

// Extension -> devicon class suffix (used as `devicon-${name}-plain`).
// Only covers extensions with a real Devicon icon; everything else falls
// back to FILE_ICONS or the generic file emoji.
const DEVICON_MAP = {
  '.html': 'html5', '.htm': 'html5',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'react',
  '.ts': 'typescript',
  '.tsx': 'react',
  '.css': 'css3',
  '.scss': 'sass', '.sass': 'sass',
  '.less': 'less',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cplusplus', '.cc': 'cplusplus', '.cxx': 'cplusplus', '.hpp': 'cplusplus',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.sh': 'bash', '.bash': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'mysql',
  '.vue': 'vuejs',
  '.lua': 'lua',
  '.dart': 'dart',
};

// Returns HTML for a file's icon: a Devicon <i> tag if we have a mapping,
// otherwise a custom SVG for the file type.
// `extraClass` lets callers add their own class (e.g. sizing) to the <i> tag.
function _fileIconHtml(ext, extraClass) {
  const dev = DEVICON_MAP[ext];
  if (dev) {
    return `<i class="devicon-${dev}-plain colored${extraClass ? ' ' + extraClass : ''}"></i>`;
  }
  const icon = FILE_ICONS[ext] || 'file';
  return `<span class="file-icon-custom${extraClass ? ' ' + extraClass : ''}">${_uiIcon(icon)}</span>`;
}

// HTML escape helper. Escapes the four characters that matter in HTML text
// content and double-quoted attribute values: & < > ". Single-quote
// attributes are not used anywhere in this file, so escaping ' is unnecessary.
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _fileTreeExpandedBeforeFilter = null;
let _fileTreeFilterTimer = null;

function populateFileTree(dir) {
  const tree = $('file-tree');
  if (!tree) return;
  tree.replaceChildren();
  const query = $('file-tree-filter')?.value.trim();
  if (query) {
    _renderFilteredFileTree(dir, query);
  } else {
    _buildTreeItems(dir, tree, 0);
    if (_fileTreeExpandedBeforeFilter) {
      const expandedPaths = _fileTreeExpandedBeforeFilter;
      _fileTreeExpandedBeforeFilter = null;
      expandedPaths
        .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)
        .forEach((expandedPath) => {
          const item = tree.querySelector(`.file-item[data-path="${CSS.escape(expandedPath)}"]`);
          if (item?.dataset.isdir === '1' && item.dataset.expanded !== '1') {
            _toggleDirExpand(item, expandedPath, Number(item.dataset.depth));
          }
        });
    }
  }
  _applyGitStatusToTree();
  _renderOpenEditors();
  _refreshGitStatus(dir);
}

const EXPLORER_FILTER_MAX_FILES = 3000;

function _collectExplorerFiles(rootDir) {
  const files = [];
  let truncated = false;
  let scannedEntries = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 64) return;
    let entries;
    try {
      entries = fs.readdirSync(dir).filter((entry) => !entry.startsWith('.') && entry !== 'node_modules');
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= EXPLORER_FILTER_MAX_FILES || scannedEntries >= 8000) {
        truncated = true;
        return;
      }
      scannedEntries++;
      const full = path.join(dir, entry);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, depth + 1);
      else files.push(full);
    }
  };
  walk(rootDir);
  return { files, truncated };
}

function _renderFilteredFileTree(rootDir, query) {
  const tree = $('file-tree');
  if (!tree) return;
  const normalizedQuery = query.toLowerCase();
  const { files, truncated } = _collectExplorerFiles(rootDir);
  const matches = files
    .filter((filePath) => path.relative(rootDir, filePath).toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 250);
  tree.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'file-filter-empty';
    empty.textContent = truncated
      ? 'No matches in the scanned files. Refine your filter.'
      : `No files match “${query}”.`;
    tree.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const fullPath of matches) {
    const item = _buildTreeItem(fullPath, 0);
    if (!item) continue;
    const location = document.createElement('span');
    location.className = 'file-filter-path';
    const relativeDirectory = path.dirname(path.relative(rootDir, fullPath));
    location.textContent = relativeDirectory === '.' ? '' : relativeDirectory;
    item.appendChild(location);
    fragment.appendChild(item);
  }
  tree.appendChild(fragment);

  const status = document.createElement('div');
  status.className = 'file-filter-status';
  status.textContent = `${matches.length}${matches.length === 250 ? '+' : ''} match${matches.length === 1 ? '' : 'es'}${truncated ? ' · refine to search more' : ''}`;
  tree.appendChild(status);
}

function _filterProjectFiles(query) {
  const input = $('file-tree-filter');
  const clearButton = $('btn-clear-file-filter');
  const normalizedQuery = query.trim();
  clearButton?.classList.toggle('hidden', !normalizedQuery);
  if (!state.projectDir) return;

  if (normalizedQuery && !_fileTreeExpandedBeforeFilter) {
    _fileTreeExpandedBeforeFilter = [...document.querySelectorAll('#file-tree .file-item--dir[data-expanded="1"]')]
      .map((item) => item.dataset.path);
  }
  if (normalizedQuery) {
    _renderFilteredFileTree(state.projectDir, normalizedQuery);
    _applyGitStatusToTree();
    return;
  }
  if (input) input.value = '';
  populateFileTree(state.projectDir);
}

function _collapseAllFileTreeFolders() {
  if (_fileTreeFilterTimer) clearTimeout(_fileTreeFilterTimer);
  _fileTreeFilterTimer = null;
  const input = $('file-tree-filter');
  if (input) input.value = '';
  _fileTreeExpandedBeforeFilter = null;
  $('btn-clear-file-filter')?.classList.add('hidden');
  if (state.projectDir) populateFileTree(state.projectDir);
}

// Git status (file tree indicators). Best-effort: if `git` isn't on PATH,
// or dir isn't a repo, this silently no-ops and the tree just renders with
// no status dots, same as today. Uses execFile (no shell) for every call so
// there's no injection surface even if a path contained shell metacharacters.
function _refreshGitStatus(dir) {
  if (!dir) return;
  const refreshId = ++_gitStatusRefreshId;
  const isCurrentRefresh = () => refreshId === _gitStatusRefreshId && state.projectDir === dir;

  execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir }, (err) => {
    if (!isCurrentRefresh()) return;
    if (err) {
      // Not a repo (or git isn't installed) -- clear any stale state from a
      // previously open project and leave the tree as-is.
      state.gitRoot = null;
      state.gitBranches = [];
      state.gitStatus = null;
      state.gitNumstat = null;
      _applyGitStatusToTree();
      _updateSidebarQuickAccess();
      if (state.activeTab === 'git') refreshGitPanel();
      return;
    }

    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir }, (err2, topLevel) => {
      if (!isCurrentRefresh()) return;
      if (err2) return;
      const root = topLevel.trim();

      execFile('git', ['status', '--porcelain=v1', '-uall'], { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (err3, out) => {
        if (!isCurrentRefresh()) return;
        if (err3) return;

        const statusMap = new Map(); // absolute path -> 'M' | 'A' | 'D' | '?' | etc.
        for (const line of out.split('\n')) {
          if (!line) continue;
          // Porcelain v1: 2 status chars, a space, then the path (rename
          // entries use "old -> new"; we only care about the new path).
          const code = line.slice(0, 2);
          let rel = line.slice(3);
          const arrow = rel.indexOf(' -> ');
          if (arrow !== -1) rel = rel.slice(arrow + 4);
          const abs = path.resolve(root, rel);
          statusMap.set(abs, code); // full 2-char porcelain code: [index, worktree]
        }

        state.gitRoot = root;
        state.gitStatus = statusMap;
        _applyGitStatusToTree();
        _updateSidebarQuickAccess();

        // +/- line counts per file, best-effort -- used only for the small
        // stat badges in the Changes list. Failure here (e.g. binary files,
        // huge diffs) shouldn't block status from rendering, so it's kept
        // as a separate non-blocking pass.
        execFile('git', ['diff', '--numstat', 'HEAD'], { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (errN, outN) => {
          if (!isCurrentRefresh()) return;
          const numstat = new Map(); // absolute path -> { add, del }
          if (!errN && outN) {
            for (const line of outN.split('\n')) {
              if (!line) continue;
              const [add, del, rel] = line.split('\t');
              if (rel === undefined) continue;
              numstat.set(path.resolve(root, rel), {
                add: add === '-' ? null : parseInt(add, 10),
                del: del === '-' ? null : parseInt(del, 10),
              });
            }
          }
          state.gitNumstat = numstat;
          if (state.activeTab === 'git') refreshGitPanel();
        });
      });
    });
  });
}

function _gitBadge(ch) {
  switch (ch) {
    case 'M': return { label: 'M', cls: 'git-modified', title: 'Modified' };
    case 'A': return { label: 'A', cls: 'git-added', title: 'Added' };
    case 'D': return { label: 'D', cls: 'git-deleted', title: 'Deleted' };
    case 'R': return { label: 'R', cls: 'git-renamed', title: 'Renamed' };
    case '?': return { label: 'U', cls: 'git-untracked', title: 'Untracked' };
    default: return null;
  }
}

function _applyGitStatusToTree() {
  document.querySelectorAll('#file-tree .file-item[data-path]').forEach((el) => {
    el.querySelector('.git-badge')?.remove();
    if (!state.gitStatus) return;
    const code = state.gitStatus.get(el.dataset.path);
    if (!code) return;
    // Prefer worktree status (what differs from the index) for the tree
    // badge; untracked files report '??' so either char works there.
    const ch = code[1] !== ' ' ? code[1] : code[0];
    const badge = _gitBadge(ch);
    if (!badge) return;
    const span = document.createElement('span');
    span.className = `git-badge ${badge.cls}` + (el.querySelector('.file-size') ? '' : ' git-badge--push');
    span.title = badge.title;
    span.textContent = badge.label;
    el.appendChild(span);
  });
}

// Git panel

function _gitLog(type, msg) {
  const log = $('git-log');
  if (!log) return;
  const empty = log.querySelector('.build-log-empty');
  if (empty) empty.remove();
  const tags = { info: '\u203a', warn: '!', success: '\u2713', error: '\u2717' };
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;

  const tag = document.createElement('span');
  tag.className = 'log-tag';
  tag.textContent = tags[type] || '\u203a';

  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = msg; // textContent -- never inject log lines as HTML

  line.append(tag, msgEl);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// All git actions below take user input (branch names, commit messages) and
// use execFile with an argv array -- never exec() with string interpolation --
// so there's no shell involved and no injection risk regardless of what the
// user types.
function _gitExecFile(args, cb) {
  if (!state.gitRoot) {
    cb(new GitError('No git repository open', { args }));
    return;
  }
  execFile('git', args, { cwd: state.gitRoot, maxBuffer: 10 * 1024 * 1024 }, cb);
}

// Branches (list, ahead/behind, create/switch/delete/rename/merge)

// %(refname:short) / upstream / ahead-behind track counts in one pass via
// for-each-ref, instead of one execFile per branch -- this scales fine to
// a repo with hundreds of branches without spawning hundreds of processes.
function _loadGitBranches(cb) {
  const fmt = '%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:relative)';
  _gitExecFile(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads/'], (err, out) => {
    if (err) { cb(err); return; }
    const branches = out.split('\n').filter(Boolean).map((line) => {
      const [name, headMark, upstream, track, relDate] = line.split('\t');
      // track looks like "[ahead 2, behind 1]", "[ahead 2]", "[behind 1]", or "" (up to date / no upstream)
      let ahead = 0, behind = 0;
      const aheadM = track && track.match(/ahead (\d+)/);
      const behindM = track && track.match(/behind (\d+)/);
      if (aheadM) ahead = parseInt(aheadM[1], 10);
      if (behindM) behind = parseInt(behindM[1], 10);
      return {
        name,
        current: headMark === '*',
        upstream: upstream || null,
        ahead,
        behind,
        relDate: relDate || '',
      };
    });
    cb(null, branches);
  });
}

function _currentGitBranch() {
  return state.gitBranches.find((b) => b.current) || null;
}

function _gitAheadBehindSpans(b) {
  const spans = [];
  if (b.ahead) spans.push('<span class="git-ahead">\u2191' + b.ahead + '</span>');
  if (b.behind) spans.push('<span class="git-behind">\u2193' + b.behind + '</span>');
  return spans;
}

// Renders the ahead/behind label as DOM nodes appended to `parent`. Used
// instead of innerHTML so a future change to the label content (e.g.
// surfacing the actual branch name) can't accidentally inject HTML.
function _appendAheadBehindLabel(parent, b) {
  if (!b) return;
  for (const html of _gitAheadBehindSpans(b)) {
    // _gitAheadBehindSpans only ever emits fixed-structure <span> with a
    // number we control; safe to parse via a template element.
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    parent.appendChild(tpl.content.cloneNode(true));
  }
}

function gitCheckoutBranch(name) {
  if (!name) return;
  _gitExecFile(['checkout', name], (err) => {
    if (err) { _gitLog('error', `Checkout failed: ${err.message}`); return; }
    _gitLog('success', `Switched to ${name}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitCreateBranch(name) {
  if (!name) { showToast('Enter a branch name'); return; }
  _gitExecFile(['checkout', '-b', name], (err) => {
    if (err) {
      // git's own validation (bad name, duplicate, etc.) -- surface it as-is
      // rather than trying to re-validate names ourselves.
      _gitLog('error', `Branch create failed: ${err.message}`);
      return;
    }
    _gitLog('success', `Created and switched to ${name}`);
    $('git-new-branch-row')?.classList.add('hidden');
    $('git-new-branch-name').value = '';
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

async function gitDeleteBranch(name) {
  if (!await studioConfirm(`Delete branch "${name}"? This cannot be undone if it isn't merged elsewhere.`, {
    title: 'Delete branch',
    confirmLabel: 'Delete branch',
    danger: true,
  })) return;
  _gitExecFile(['branch', '-d', name], (err) => {
    if (err) {
      // -d refuses on unmerged branches; offer the force path explicitly
      // rather than silently escalating to -D on the user's behalf.
      if (/not fully merged/i.test(err.message)) {
        studioConfirm(`"${name}" has unmerged changes. Force delete anyway?`, {
          title: 'Force delete unmerged branch',
          confirmLabel: 'Force delete',
          danger: true,
        }).then((confirmed) => {
          if (!confirmed) return;
        _gitExecFile(['branch', '-D', name], (err2) => {
          if (err2) { _gitLog('error', `Delete failed: ${err2.message}`); return; }
          _gitLog('success', `Force-deleted ${name}`);
          refreshGitPanel();
        });
        });
        return;
      }
      _gitLog('error', `Delete failed: ${err.message}`);
      return;
    }
    _gitLog('success', `Deleted ${name}`);
    refreshGitPanel();
  });
}

function gitRenameBranch(oldName, newName) {
  if (!newName || newName === oldName) return;
  _gitExecFile(['branch', '-m', oldName, newName], (err) => {
    if (err) { _gitLog('error', `Rename failed: ${err.message}`); return; }
    _gitLog('success', `Renamed ${oldName} \u2192 ${newName}`);
    refreshGitPanel();
  });
}

async function gitMergeBranch(name) {
  const current = _currentGitBranch();
  if (!await studioConfirm(`Merge "${name}" into "${current ? current.name : 'current branch'}"?`, {
    title: 'Merge branch',
    confirmLabel: 'Merge branch',
  })) return;
  _gitExecFile(['merge', '--no-edit', name], (err, out) => {
    if (err) { _gitLog('error', `Merge failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || `Merged ${name}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

// Fetch / pull / push

function gitFetch(cb) {
  const btn = $('btn-git-fetch');
  btn?.classList.add('is-fetching');
  _gitExecFile(['fetch', '--all'], (err, out) => {
    btn?.classList.remove('is-fetching');
    if (err) { _gitLog('error', `Fetch failed: ${err.message}`); cb?.(err); return; }
    _gitLog('success', (out || '').trim() || 'Fetched');
    refreshGitPanel();
    cb?.(null);
  });
}

function gitPull() {
  _gitExecFile(['pull'], (err, out) => {
    if (err) { _gitLog('error', `Pull failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || 'Pulled');
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitPush() {
  const current = _currentGitBranch();
  const args = (current && !current.upstream)
    ? ['push', '-u', 'origin', current.name] // no upstream yet -- set one on first push
    : ['push'];
  _gitExecFile(args, (err, out) => {
    if (err) { _gitLog('error', `Push failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || 'Pushed');
    refreshGitPanel();
  });
}

// Commit history

// Unit separator (\x1f) between fields and record separator (\x1e) between
// commits -- commit messages can contain anything else printable, so plain
// delimiters like "|" or "," would be ambiguous; these control characters
// never appear in normal commit text.
const _GIT_LOG_FIELD_SEP = '\x1f';
const _GIT_LOG_REC_SEP = '\x1e';

function _loadGitHistory(cb) {
  const fmt = `%H${_GIT_LOG_FIELD_SEP}%an${_GIT_LOG_FIELD_SEP}%ar${_GIT_LOG_FIELD_SEP}%s${_GIT_LOG_REC_SEP}`;
  _gitExecFile(['log', `--pretty=format:${fmt}`, '-n', '200'], (err, out) => {
    if (err) { cb(err); return; }
    const commits = out.split(_GIT_LOG_REC_SEP).filter((s) => s.trim()).map((rec) => {
      const [hash, author, relDate, subject] = rec.replace(/^\n/, '').split(_GIT_LOG_FIELD_SEP);
      return { hash, author, relDate, subject };
    });
    cb(null, commits);
  });
}

function gitShowCommitDiff(hash) {
  // Show this commit's full diff against its first parent by mounting the
  // same CMDiff view used for file diffs, one file at a time isn't
  // practical for a multi-file commit -- instead show a unified patch as
  // read-only text, which handles any number of changed files uniformly.
  _gitExecFile(['show', '--stat', '-p', hash], (err, out) => {
    if (err) { _gitLog('error', `Failed to load commit: ${err.message}`); return; }
    $('diff-label-left').textContent = hash.slice(0, 10);
    $('diff-label-right').textContent = 'patch';
    $('modal-diff').classList.remove('hidden');
    window.CMDiff.mount({
      host: 'diff-host',
      left: out,
      right: out,
      ext: '.diff',
      leftEditable: false,
      rightEditable: false,
    });
    _diffMode = 'files';
  });
}

function _renderGitHistory(commits) {
  const list = $('git-history-list');
  if (!list) return;
  list.replaceChildren();

  if (!commits.length) {
    const empty = document.createElement('div');
    empty.className = 'git-empty-state';
    const icon = document.createElement('div');
    icon.className = 'git-empty-state-icon';
    icon.innerHTML = _uiIcon('clock', 'ui-icon--empty');
    const text = document.createElement('div');
    text.className = 'git-empty-state-text';
    text.textContent = 'No commits yet';
    empty.append(icon, text);
    list.appendChild(empty);
    return;
  }

  for (const c of commits) {
    const row = document.createElement('div');
    row.className = 'git-commit-row-item';
    row.dataset.hash = c.hash;

    const dot = document.createElement('div');
    dot.className = 'git-commit-dot';

    const info = document.createElement('div');
    info.className = 'git-commit-info';

    const msg = document.createElement('div');
    msg.className = 'git-commit-message';
    msg.textContent = c.subject; // safe -- never inject as HTML
    msg.title = c.subject;

    const meta = document.createElement('div');
    meta.className = 'git-commit-meta';
    const hashSpan = document.createElement('span');
    hashSpan.className = 'git-commit-hash';
    hashSpan.textContent = c.hash.slice(0, 7);
    const authorSpan = document.createElement('span');
    authorSpan.textContent = c.author;
    const dateSpan = document.createElement('span');
    dateSpan.textContent = c.relDate;
    meta.append(hashSpan, authorSpan, dateSpan);

    info.append(msg, meta);
    row.append(dot, info);
    row.addEventListener('click', () => gitShowCommitDiff(c.hash));
    list.appendChild(row);
  }
}

// Stash

function _loadGitStashes(cb) {
  const fmt = `%gd${_GIT_LOG_FIELD_SEP}%s${_GIT_LOG_FIELD_SEP}%ar`;
  _gitExecFile(['stash', 'list', `--pretty=format:${fmt}`], (err, out) => {
    if (err) { cb(err); return; }
    const stashes = out.split('\n').filter(Boolean).map((line) => {
      const [ref, message, relDate] = line.split(_GIT_LOG_FIELD_SEP);
      return { ref, message, relDate };
    });
    cb(null, stashes);
  });
}

function gitStashSave() {
  const msgEl = $('git-stash-message');
  const msg = msgEl ? msgEl.value.trim() : '';
  const args = msg ? ['stash', 'push', '-m', msg] : ['stash', 'push'];
  _gitExecFile(args, (err, out) => {
    if (err) { _gitLog('error', `Stash failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || 'Stashed changes');
    if (msgEl) msgEl.value = '';
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitStashPop(ref) {
  _gitExecFile(['stash', 'pop', ref], (err, out) => {
    if (err) { _gitLog('error', `Stash pop failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || `Popped ${ref}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitStashApply(ref) {
  _gitExecFile(['stash', 'apply', ref], (err, out) => {
    if (err) { _gitLog('error', `Stash apply failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || `Applied ${ref}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

async function gitStashDrop(ref) {
  if (!await studioConfirm(`Drop stash ${ref}? This cannot be undone.`, {
    title: 'Drop stash',
    confirmLabel: 'Drop stash',
    danger: true,
  })) return;
  _gitExecFile(['stash', 'drop', ref], (err, out) => {
    if (err) { _gitLog('error', `Stash drop failed: ${err.message}`); return; }
    _gitLog('success', (out || '').trim() || `Dropped ${ref}`);
    refreshGitPanel();
  });
}

function _renderGitStashes(stashes) {
  const list = $('git-stash-list');
  const countEl = $('git-stash-count');
  if (!list) return;
  list.replaceChildren();

  if (countEl) {
    countEl.textContent = stashes.length || '';
    countEl.classList.toggle('hidden', stashes.length === 0);
  }

  if (!stashes.length) {
    const empty = document.createElement('div');
    empty.className = 'git-empty-state';
    const icon = document.createElement('div');
    icon.className = 'git-empty-state-icon';
    icon.innerHTML = _uiIcon('package', 'ui-icon--empty');
    const text = document.createElement('div');
    text.className = 'git-empty-state-text';
    text.textContent = 'No stashes';
    empty.append(icon, text);
    list.appendChild(empty);
    return;
  }

  for (const s of stashes) {
    const item = document.createElement('div');
    item.className = 'git-stash-item';

    const info = document.createElement('div');
    info.className = 'git-stash-info';
    const msg = document.createElement('div');
    msg.className = 'git-stash-message';
    msg.textContent = s.message; // safe -- never inject as HTML
    msg.title = s.message;
    const meta = document.createElement('div');
    meta.className = 'git-stash-meta';
    meta.textContent = `${s.ref} \u00b7 ${s.relDate}`;
    info.append(msg, meta);

    const actions = document.createElement('div');
    actions.className = 'git-stash-actions';

    const popBtn = document.createElement('button');
    popBtn.className = 'icon-btn';
    popBtn.title = 'Pop (apply and remove)';
    popBtn.setAttribute('aria-label', 'Pop stash');
    popBtn.innerHTML = _uiIcon('arrow-up');
    popBtn.addEventListener('click', () => gitStashPop(s.ref));

    const applyBtn = document.createElement('button');
    applyBtn.className = 'icon-btn';
    applyBtn.title = 'Apply (keep stash)';
    applyBtn.setAttribute('aria-label', 'Apply stash');
    applyBtn.innerHTML = _uiIcon('upload');
    applyBtn.addEventListener('click', () => gitStashApply(s.ref));

    const dropBtn = document.createElement('button');
    dropBtn.className = 'icon-btn git-file-action--danger';
    dropBtn.title = 'Drop';
    dropBtn.setAttribute('aria-label', 'Drop stash');
    dropBtn.innerHTML = _uiIcon('trash');
    dropBtn.addEventListener('click', () => gitStashDrop(s.ref));

    actions.append(popBtn, applyBtn, dropBtn);
    item.append(info, actions);
    list.appendChild(item);
  }
}

// Per-file diff preview (click a row in Changes)

function gitShowFileDiff(absPath, staged) {
  const rel = path.relative(state.gitRoot, absPath);
  const ext = path.extname(absPath).toLowerCase();

  const readAtHead = (cb) => {
    _gitExecFile(['show', `HEAD:${rel}`], (err, out) => cb(err ? '' : out));
  };
  const readIndex = (cb) => {
    _gitExecFile(['show', `:${rel}`], (err, out) => cb(err ? '' : out));
  };
  const readWorking = () => {
    try { return fs.readFileSync(absPath, 'utf8'); }
    catch { return ''; }
  };

  readAtHead((headContent) => {
    if (staged) {
      readIndex((indexContent) => {
        $('diff-label-left').textContent = rel + ' (staged)';
        $('diff-label-right').textContent = 'HEAD';
        $('modal-diff').classList.remove('hidden');
        window.CMDiff.mount({
          host: 'diff-host',
          left: indexContent,
          right: headContent,
          ext,
          leftEditable: false,
          rightEditable: false,
        });
        _diffMode = 'files';
      });
    } else {
      // Unstaged: compare the working-tree file against HEAD. mount() needs
      // an explicit left value -- readWorking() covers deleted files too
      // (empty string), so the diff still renders instead of erroring.
      $('diff-label-left').textContent = rel + ' (working tree)';
      $('diff-label-right').textContent = 'HEAD';
      $('modal-diff').classList.remove('hidden');
      window.CMDiff.mount({
        host: 'diff-host',
        left: readWorking(),
        right: headContent,
        ext,
        leftEditable: false,
        rightEditable: false,
      });
      _diffMode = 'files';
    }
  });
}

// Changes list rendering

async function gitDiscardChange(absPath, code) {
  const name = path.basename(absPath);
  if (code === '??') {
    // Untracked file -- "discard" means delete it, since git has nothing to
    // restore it to. Confirm explicitly since this is unrecoverable.
    if (!await studioConfirm(`Delete untracked file "${name}"? This cannot be undone.`, {
      title: 'Delete untracked file',
      confirmLabel: 'Delete file',
      danger: true,
    })) return;
    try { fs.unlinkSync(absPath); }
    catch (e) { _gitLog('error', `Delete failed: ${e.message}`); return; }
    _gitLog('success', `Deleted ${name}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
    return;
  }
  if (!await studioConfirm(`Discard changes to "${name}"? This cannot be undone.`, {
    title: 'Discard file changes',
    confirmLabel: 'Discard changes',
    danger: true,
  })) return;
  _gitExecFile(['checkout', '--', absPath], (err) => {
    if (err) { _gitLog('error', `Discard failed: ${err.message}`); return; }
    _gitLog('success', `Discarded changes to ${name}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function _renderGitFileLists() {
  const stagedEl = $('git-staged-list');
  const unstagedEl = $('git-unstaged-list');
  if (!stagedEl || !unstagedEl) return;

  stagedEl.replaceChildren();
  unstagedEl.replaceChildren();

  const empty = (text) => {
    const div = document.createElement('div');
    div.className = 'git-file-list-empty';
    div.textContent = text;
    return div;
  };

  if (!state.gitStatus || state.gitStatus.size === 0) {
    stagedEl.appendChild(empty('Nothing staged'));
    unstagedEl.appendChild(empty('No changes'));
    if ($('git-staged-count')) $('git-staged-count').textContent = '0';
    if ($('git-unstaged-count')) $('git-unstaged-count').textContent = '0';
    if ($('git-overview-changes')) $('git-overview-changes').textContent = '0';
    if ($('git-overview-staged')) $('git-overview-staged').textContent = '0';
    $('git-changes-count')?.classList.add('hidden');
    return;
  }

  let stagedCount = 0;
  let unstagedCount = 0;

  const renderRow = (rel, action, actionLabel, actionTitle, absPath, code, staged) => {
    const row = document.createElement('div');
    row.className = 'git-file-row';
    row.dataset.path = absPath;

    const icon = document.createElement('span');
    icon.className = 'git-file-row-icon';
    icon.textContent = { M: '\u25CF', A: '+', D: '\u2212', R: '\u21B7', '?': '?' }[code] || '\u25CF';

    const pathEl = document.createElement('span');
    pathEl.className = 'git-file-path';
    pathEl.textContent = rel; // safe -- never inject as HTML
    pathEl.title = rel;

    const stat = document.createElement('span');
    stat.className = 'git-file-stat';
    const nstat = state.gitNumstat?.get(absPath);
    if (nstat && (nstat.add || nstat.del)) {
      // Build the +/- badges as DOM nodes rather than `innerHTML +=` -- the
      // latter re-parses the whole element on every concatenation and was
      // visibly slow on a Changes list with many files.
      if (nstat.add) {
        const addSpan = document.createElement('span');
        addSpan.className = 'git-stat-add';
        addSpan.textContent = '+' + nstat.add;
        stat.appendChild(addSpan);
      }
      if (nstat.del) {
        const delSpan = document.createElement('span');
        delSpan.className = 'git-stat-del';
        delSpan.textContent = '\u2212' + nstat.del;
        stat.appendChild(delSpan);
      }
    }

    const actions = document.createElement('span');
    actions.className = 'git-file-row-actions';

    const actionBtn = document.createElement('button');
    actionBtn.className = 'icon-btn git-file-action';
    actionBtn.dataset.action = action;
    actionBtn.dataset.path = absPath;
    actionBtn.title = actionTitle;
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (actionBtn.dataset.action === 'stage') gitStage(absPath);
      else gitUnstage(absPath);
    });

    const discardBtn = document.createElement('button');
    discardBtn.className = 'icon-btn git-file-action git-file-action--danger';
    discardBtn.title = code === '??' ? 'Delete file' : 'Discard changes';
    discardBtn.setAttribute('aria-label', code === '??' ? 'Delete file' : 'Discard changes');
    discardBtn.innerHTML = _uiIcon(code === '??' ? 'trash' : 'refresh');
    discardBtn.addEventListener('click', (e) => { e.stopPropagation(); gitDiscardChange(absPath, code); });

    actions.append(actionBtn);
    // Discarding a staged change means unstage-then-discard; keep this to
    // unstaged rows to avoid a two-step footgun.
    if (!staged) actions.append(discardBtn);

    row.append(icon, pathEl, stat, actions);
    row.addEventListener('click', () => gitShowFileDiff(absPath, staged));
    return row;
  };

  state.gitStatus.forEach((code, absPath) => {
    const indexCh = code[0];
    const worktreeCh = code[1];
    const rel = state.gitRoot ? path.relative(state.gitRoot, absPath) : absPath;

    // Staged: index has a real status char (not space, not untracked marker).
    if (indexCh !== ' ' && indexCh !== '?') {
      stagedCount++;
      stagedEl.appendChild(renderRow(rel, 'unstage', '\u2212', 'Unstage', absPath, indexCh, true));
    }

    // Unstaged/untracked: worktree char is dirty, or file is fully untracked ('??').
    if ((worktreeCh !== ' ' && worktreeCh !== undefined) || code === '??') {
      unstagedCount++;
      const ch = code === '??' ? '?' : worktreeCh;
      unstagedEl.appendChild(renderRow(rel, 'stage', '+', 'Stage', absPath, ch, false));
    }
  });

  if (stagedCount === 0) stagedEl.appendChild(empty('Nothing staged'));
  if (unstagedCount === 0) unstagedEl.appendChild(empty('No changes'));

  if ($('git-staged-count')) $('git-staged-count').textContent = String(stagedCount);
  if ($('git-unstaged-count')) $('git-unstaged-count').textContent = String(unstagedCount);
  if ($('git-overview-changes')) $('git-overview-changes').textContent = String(state.gitStatus.size);
  if ($('git-overview-staged')) $('git-overview-staged').textContent = String(stagedCount);
  const totalEl = $('git-changes-count');
  if (totalEl) {
    const total = stagedCount + unstagedCount;
    totalEl.textContent = String(total);
    totalEl.classList.toggle('hidden', total === 0);
  }
}

function gitStage(absPath) {
  _gitExecFile(['add', '--', absPath], (err) => {
    if (err) { _gitLog('error', `Stage failed: ${err.message}`); return; }
    _gitLog('success', `Staged ${path.basename(absPath)}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitUnstage(absPath) {
  _gitExecFile(['restore', '--staged', '--', absPath], (err) => {
    if (err) { _gitLog('error', `Unstage failed: ${err.message}`); return; }
    _gitLog('success', `Unstaged ${path.basename(absPath)}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitStageAll() {
  _gitExecFile(['add', '-A'], (err) => {
    if (err) { _gitLog('error', `Stage all failed: ${err.message}`); return; }
    _gitLog('success', 'Staged all changes');
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitUnstageAll() {
  _gitExecFile(['restore', '--staged', '.'], (err) => {
    if (err) { _gitLog('error', `Unstage all failed: ${err.message}`); return; }
    _gitLog('success', 'Unstaged all changes');
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

function gitCommit() {
  const msgEl = $('git-commit-msg');
  const msg = msgEl ? msgEl.value.trim() : '';
  const amend = $('git-amend-checkbox')?.checked;
  if (!msg && !amend) { showToast('Enter a commit message'); return; }

  const args = amend
    ? (msg ? ['commit', '--amend', '-m', msg] : ['commit', '--amend', '--no-edit'])
    : ['commit', '-m', msg];

  _gitExecFile(args, (err, out) => {
    if (err) { _gitLog('error', `Commit failed: ${err.message}`); return; }
    _gitLog('success', out.trim() || 'Committed');
    if (msgEl) msgEl.value = '';
    if ($('git-amend-checkbox')) $('git-amend-checkbox').checked = false;
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
  });
}

// Branch dropdown + branches pane rendering

function _renderBranchChip() {
  const current = _currentGitBranch();
  const nameEl = $('git-branch-chip-name');
  const abEl = $('git-ahead-behind');
  if (nameEl) nameEl.textContent = current ? current.name : (state.gitRoot ? '\u2014' : 'Not a repo');
  if (abEl) {
    abEl.replaceChildren();
    _appendAheadBehindLabel(abEl, current);
  }

  const pullBtn = $('btn-git-pull');
  const pushBtn = $('btn-git-push');
  const pullCount = $('git-pull-count');
  const pushCount = $('git-push-count');
  if (pullCount) pullCount.textContent = current?.behind ? String(current.behind) : '';
  if (pushCount) pushCount.textContent = current?.ahead ? String(current.ahead) : '';
  const hasRepo = !!state.gitRoot;
  if (pullBtn) pullBtn.disabled = !hasRepo || !current?.upstream;
  if (pushBtn) pushBtn.disabled = !hasRepo;
  const overviewBranch = $('git-overview-branch');
  if (overviewBranch) overviewBranch.textContent = current?.name || '—';
  const overviewSync = $('git-overview-sync');
  if (overviewSync) {
    overviewSync.textContent = !current?.upstream
      ? 'No upstream configured'
      : current.ahead || current.behind
        ? `${current.ahead} ahead · ${current.behind} behind`
        : 'Up to date';
  }
  const repoName = $('git-repo-name');
  const repoPath = $('git-repo-path');
  const repoState = $('git-repo-state');
  if (repoName) repoName.textContent = hasRepo ? path.basename(state.gitRoot) : 'No repository';
  if (repoPath) repoPath.textContent = hasRepo ? state.gitRoot : (state.projectDir || 'Open a project inside a Git repository');
  if (repoState) {
    repoState.textContent = hasRepo ? 'Repository detected' : 'Not connected';
    repoState.classList.toggle('is-connected', hasRepo);
  }
  const workspace = $('git-workspace');
  workspace?.classList.toggle('is-no-repository', !hasRepo);
  $('git-no-repository')?.classList.toggle('hidden', hasRepo);
  $('panel-git')?.classList.toggle('git-panel--no-repo', !hasRepo);
}

function _renderBranchDropdownList(filter = '') {
  const list = $('git-branch-dropdown-list');
  if (!list) return;
  list.replaceChildren();
  const q = filter.trim().toLowerCase();
  const branches = state.gitBranches.filter((b) => !q || b.name.toLowerCase().includes(q));

  for (const b of branches) {
    const item = document.createElement('div');
    item.className = 'git-branch-dropdown-item' + (b.current ? ' git-branch-dropdown-item--current' : '');

    const icon = document.createElement('span');
    icon.className = 'git-branch-dropdown-item-icon';
    icon.innerHTML = _uiIcon('branch');

    const name = document.createElement('span');
    name.className = 'git-branch-dropdown-item-name';
    name.textContent = b.name; // safe -- never inject as HTML

    item.append(icon, name);

    if (b.current) {
      const check = document.createElement('span');
      check.className = 'git-branch-dropdown-item-check';
      check.innerHTML = _uiIcon('check');
      item.append(check);
    } else {
      item.addEventListener('click', () => {
        $('git-branch-dropdown')?.classList.add('hidden');
        $('git-branch-chip')?.classList.remove('is-open');
        gitCheckoutBranch(b.name);
      });
    }
    list.appendChild(item);
  }

  if (!branches.length) {
    const empty = document.createElement('div');
    empty.className = 'git-file-list-empty';
    empty.textContent = 'No matching branches';
    list.appendChild(empty);
  }
}

function _renderGitBranchesPane(filter = '') {
  const list = $('git-branches-list');
  if (!list) return;
  list.replaceChildren();
  const q = filter.trim().toLowerCase();
  const branches = state.gitBranches.filter((b) => !q || b.name.toLowerCase().includes(q));

  for (const b of branches) {
    const item = document.createElement('div');
    item.className = 'git-branch-item' + (b.current ? ' git-branch-item--current' : '');

    const icon = document.createElement('span');
    icon.className = 'git-branch-item-icon';
    icon.innerHTML = _uiIcon('branch');

    const info = document.createElement('div');
    info.className = 'git-branch-item-info';
    const name = document.createElement('div');
    name.className = 'git-branch-item-name';
    name.textContent = b.name; // safe -- never inject as HTML
    const meta = document.createElement('div');
    meta.className = 'git-branch-item-meta';
    const parts = [];
    if (b.current) {
      const cur = document.createElement('span');
      cur.textContent = 'current';
      parts.push(cur);
    }
    if (b.relDate) {
      const date = document.createElement('span');
      date.textContent = b.relDate;
      parts.push(date);
    }
    if (b.ahead || b.behind) {
      const ab = document.createElement('span');
      _appendAheadBehindLabel(ab, b);
      parts.push(ab);
    }
    parts.forEach((p, i) => {
      meta.appendChild(p);
      if (i < parts.length - 1) {
        const sep = document.createTextNode(' \u00b7 ');
        meta.appendChild(sep);
      }
    });
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'git-branch-item-actions';

    if (!b.current) {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'icon-btn';
      switchBtn.title = 'Switch to this branch';
      switchBtn.setAttribute('aria-label', 'Switch to this branch');
      switchBtn.innerHTML = _uiIcon('branch');
      switchBtn.addEventListener('click', () => gitCheckoutBranch(b.name));

      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'icon-btn';
      mergeBtn.title = 'Merge into current branch';
      mergeBtn.setAttribute('aria-label', 'Merge into current branch');
      mergeBtn.innerHTML = _uiIcon('merge');
      mergeBtn.addEventListener('click', () => gitMergeBranch(b.name));

      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.title = 'Rename';
      renameBtn.setAttribute('aria-label', 'Rename branch');
      renameBtn.innerHTML = _uiIcon('edit');
      renameBtn.addEventListener('click', async () => {
        const next = await studioPrompt(`Rename "${b.name}" to:`, b.name, {
          title: 'Rename branch',
          confirmLabel: 'Rename',
          maxLength: 255,
        });
        if (next && next.trim()) gitRenameBranch(b.name, next.trim());
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn git-file-action--danger';
      deleteBtn.title = 'Delete';
      deleteBtn.setAttribute('aria-label', 'Delete branch');
      deleteBtn.innerHTML = _uiIcon('trash');
      deleteBtn.addEventListener('click', () => gitDeleteBranch(b.name));

      actions.append(switchBtn, mergeBtn, renameBtn, deleteBtn);
    }

    item.append(icon, info, actions);
    list.appendChild(item);
  }

  if (!branches.length) {
    const empty = document.createElement('div');
    empty.className = 'git-file-list-empty';
    empty.textContent = 'No matching branches';
    list.appendChild(empty);
  }
}

// Section switching (Changes / History / Stash / Branches)

function _switchGitSection(name) {
  state.gitActiveSection = name;
  document.querySelectorAll('.git-subnav-btn').forEach((btn) => {
    btn.classList.toggle('git-subnav-btn--active', btn.dataset.gitSection === name);
  });
  document.querySelectorAll('.git-section').forEach((section) => {
    section.classList.toggle('hidden', section.dataset.gitPane !== name);
  });

  if (name === 'history') {
    _loadGitHistory((err, commits) => {
      if (err) { _gitLog('error', `Failed to load history: ${err.message}`); return; }
      _renderGitHistory(commits);
    });
  } else if (name === 'stash') {
    _loadGitStashes((err, stashes) => {
      if (err) { _gitLog('error', `Failed to load stashes: ${err.message}`); return; }
      _renderGitStashes(stashes);
    });
  } else if (name === 'branches') {
    _renderGitBranchesPane($('git-branches-search')?.value || '');
  }
}

// Panel refresh entry point

function refreshGitPanel() {
  if (!state.gitRoot) {
    _gitLog('warn', 'No git repository open');
    _renderBranchChip();
    return;
  }
  _renderGitFileLists();
  _loadGitBranches((err, branches) => {
    if (err) { _gitLog('error', `Failed to list branches: ${err.message}`); return; }
    state.gitBranches = branches;
    _renderBranchChip();
    _renderBranchDropdownList($('git-branch-search')?.value || '');
    if (state.gitActiveSection === 'branches') _renderGitBranchesPane($('git-branches-search')?.value || '');
  });
  _loadGitStashes((err, stashes) => {
    if (err) return; // non-fatal -- stash count badge just stays empty
    const countEl = $('git-stash-count');
    if (countEl) {
      countEl.textContent = stashes.length || '';
      countEl.classList.toggle('hidden', stashes.length === 0);
    }
    if (state.gitActiveSection === 'stash') _renderGitStashes(stashes);
  });
}

function _initGitPanel() {
  $('btn-git-open-project')?.addEventListener('click', () => pickFolder(loadProject));

  // Branch chip -> dropdown
  $('git-branch-chip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = $('git-branch-dropdown');
    const chip = $('git-branch-chip');
    const willOpen = dropdown?.classList.contains('hidden');
    dropdown?.classList.toggle('hidden', !willOpen);
    chip?.classList.toggle('is-open', willOpen);
    if (willOpen) $('git-branch-search')?.focus();
  });
  document.addEventListener('click', (e) => {
    const dropdown = $('git-branch-dropdown');
    if (!dropdown || dropdown.classList.contains('hidden')) return;
    if (e.target.closest('#git-branch-dropdown') || e.target.closest('#git-branch-chip')) return;
    dropdown.classList.add('hidden');
    $('git-branch-chip')?.classList.remove('is-open');
  });
  $('git-branch-search')?.addEventListener('input', (e) => _renderBranchDropdownList(e.target.value));

  // New branch (from either the toolbar dropdown footer or the Branches pane)
  const openNewBranchRow = () => {
    $('git-branch-dropdown')?.classList.add('hidden');
    $('git-branch-chip')?.classList.remove('is-open');
    $('git-new-branch-row')?.classList.remove('hidden');
    $('git-new-branch-name')?.focus();
  };
  $('btn-git-new-branch')?.addEventListener('click', openNewBranchRow);
  $('btn-git-branches-new')?.addEventListener('click', openNewBranchRow);

  $('btn-git-cancel-branch')?.addEventListener('click', () => {
    $('git-new-branch-row')?.classList.add('hidden');
    $('git-new-branch-name').value = '';
  });

  $('btn-git-create-branch')?.addEventListener('click', () => {
    gitCreateBranch($('git-new-branch-name').value.trim());
  });
  $('git-new-branch-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-git-create-branch')?.click();
    if (e.key === 'Escape') $('btn-git-cancel-branch')?.click();
  });

  // Fetch / pull / push
  $('btn-git-fetch')?.addEventListener('click', () => gitFetch());
  $('btn-git-pull')?.addEventListener('click', gitPull);
  $('btn-git-push')?.addEventListener('click', gitPush);

  // Sub-nav
  $('git-subnav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.git-subnav-btn');
    if (!btn) return;
    _switchGitSection(btn.dataset.gitSection);
  });

  // Changes: commit, stage/unstage all
  $('btn-git-commit')?.addEventListener('click', gitCommit);
  $('git-commit-msg')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) gitCommit();
  });
  $('btn-git-stage-all')?.addEventListener('click', gitStageAll);
  $('btn-git-unstage-all')?.addEventListener('click', gitUnstageAll);

  // Stash
  $('btn-git-stash-save')?.addEventListener('click', gitStashSave);

  // Branches pane search
  $('git-branches-search')?.addEventListener('input', (e) => _renderGitBranchesPane(e.target.value));
}

// Build a single tree-item element. Returns null when the entry can't be
// stat'd (race with deletion, permissions, etc.).
function _buildTreeItem(full, depth) {
  let stat;
  try { stat = fs.statSync(full); }
  catch { return null; }

  const isDir = stat.isDirectory();
  const ext = path.extname(full).toLowerCase();
  const iconHtml = isDir ? `<span class="file-icon-custom">${_uiIcon('folder')}</span>` : _fileIconHtml(ext);
  const size = isDir ? '' : _formatSize(stat.size);
  const name = path.basename(full);

  const item = document.createElement('div');
  item.className = 'file-item' + (isDir ? ' file-item--dir' : '');
  item.draggable = true;
  item.dataset.path = full;
  item.dataset.isdir = isDir ? '1' : '0';
  item.dataset.depth = String(depth);
  item.style.paddingLeft = (12 + depth * 16) + 'px';

  // iconHtml is from our own _fileIconHtml, which only ever emits Devicon
  // class names or hard-coded emoji -- never user content. The file name
  // itself is escaped.
  item.innerHTML =
    `<span class="file-icon" data-icon="1">${iconHtml}</span>` +
    `<span class="file-name">${_escHtml(name)}</span>` +
    (size ? `<span class="file-size">${_escHtml(size)}</span>` : '');

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    if (isDir) _toggleDirExpand(item, full, depth);
    else openFileEditor(full);
  });

  item.addEventListener('dragstart', (e) => {
    _fileDragData = { srcPath: full, isDir };
    e.dataTransfer.setData('text/plain', full);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('is-dragging');
  });

  item.addEventListener('dragend', () => {
    _fileDragData = null;
    item.classList.remove('is-dragging');
  });

  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_fileDragData) return;
    if (_fileDragData.srcPath === full) return;
    if (!isDir) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    if (_isDescendantOf(_fileDragData.srcPath, full)) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    item.classList.add('drag-over');
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over');
  });

  item.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');
    if (!_fileDragData) return;
    const srcPath = _fileDragData.srcPath;
    if (srcPath === full) return;
    if (!isDir) {
      showToast('Drop onto a folder');
      return;
    }
    if (_isDescendantOf(srcPath, full)) {
      showToast('Cannot move into itself');
      return;
    }
    try {
      const baseName = path.basename(srcPath);
      const destPath = path.join(full, baseName);
      if (fs.existsSync(destPath)) {
        showToast('An item with that name already exists in the destination');
        return;
      }
      fs.renameSync(srcPath, destPath);
      showToast('Moved ' + baseName);
    } catch (err) {
      showToast('Move failed: ' + err.message);
    } finally {
      _fileDragData = null;
      populateFileTree(state.projectDir);
    }
  });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, full);
  });

  return item;
}

function _buildTreeItems(dir, container, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter((f) => !f.startsWith('.') && f !== 'node_modules');
  } catch (e) {
    if (depth === 0) {
      const div = document.createElement('div');
      div.className = 'recent-empty';
      div.textContent = 'Could not read folder: ' + e.message;
      container.replaceChildren(div);
    }
    return;
  }

  // Stat once per entry, then sort using the cached stat. The original code
  // re-stat'd inside the comparator (2 stats per comparison -> O(n log n)
  // syscalls on every directory open). For a directory of 500 files that's
  // ~5000 redundant stat calls.
  const withStat = [];
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      withStat.push({ f, full, isDir: stat.isDirectory() });
    } catch { /* file vanished between readdir and stat -- skip */ }
  }
  withStat.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.f.localeCompare(b.f);
  });

  if (!withStat.length && depth === 0) {
    const div = document.createElement('div');
    div.className = 'recent-empty';
    div.textContent = 'Empty folder';
    container.replaceChildren(div);
    return;
  }

  for (const { full } of withStat) {
    const item = _buildTreeItem(full, depth);
    if (item) container.appendChild(item);
  }
}

function _isDescendantOf(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (child === parent) return false;
  return child.startsWith(parent + path.sep) || child.startsWith(parent + '/');
}

function _toggleDirExpand(item, dirPath, depth) {
  const isExpanded = item.dataset.expanded === '1';
  if (isExpanded) {
    item.dataset.expanded = '0';
    item.querySelector('[data-icon]').innerHTML = `<span class="file-icon-custom">${_uiIcon('folder')}</span>`;
    let sib = item.nextSibling;
    while (sib) {
      const sibDepth = parseInt(sib.dataset?.depth ?? '-1', 10);
      if (sibDepth > depth) {
        const next = sib.nextSibling;
        sib.remove();
        sib = next;
      } else break;
    }
  } else {
    item.dataset.expanded = '1';
    item.querySelector('[data-icon]').innerHTML = `<span class="file-icon-custom">${_uiIcon('folder-open')}</span>`;
    const frag = document.createDocumentFragment();
    const temp = document.createElement('div');
    _buildTreeItems(dirPath, temp, depth + 1);
    while (temp.firstChild) frag.appendChild(temp.firstChild);
    item.after(frag);
    _applyGitStatusToTree();
  }
}

// File editor

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);
const BINARY_EXTS = new Set(['.zip', '.tar', '.gz', '.exe', '.bin', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.ogg']);

// Tab system. VS Code style: preview=true tabs are reused on single-click,
// pinned on edit / dblclick.
const tabs = []; // [{ filePath, originalContent, isDirty, preview }]

let _contextTarget = null;
const EDITOR_CLIPBOARD = typeof navigator !== 'undefined' ? navigator.clipboard : null;
let activeTabIndex = -1;
let _closeGuardEnabled = false;

function _getActiveTab() {
  return tabs[activeTabIndex] ?? null;
}

const FORMATTER_LANGUAGE_NAMES = {
  js: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
};

function _guessFormatterParser(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.novaapp') return 'json';
  const map = {
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.jsx': 'js',
    '.ts': 'js',
    '.tsx': 'js',
    '.json': 'json',
    '.jsonc': 'json',
    '.json5': 'json',
    '.css': 'css',
    '.scss': 'css',
    '.less': 'css',
    '.html': 'html',
    '.htm': 'html',
  };
  return map[ext] || null;
}

async function _getFormatterFileInfo(filePath) {
  const parser = _guessFormatterParser(filePath);
  return {
    parser,
    language: parser ? (FORMATTER_LANGUAGE_NAMES[parser] || parser) : null,
  };
}

function _positionEditorContextMenu(menu, x, y) {
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function hideEditorContextMenu() {
  $('editor-context-menu')?.classList.add('hidden');
}

async function _showEditorContextMenu(x, y, tabIndex = activeTabIndex) {
  const menu = $('editor-context-menu');
  const tab = tabs[tabIndex];
  if (!menu || !tab || IMAGE_EXTS.has(path.extname(tab.filePath).toLowerCase())) return;
  if (tabIndex !== activeTabIndex) _switchToTab(tabIndex);

  hideEditorContextMenu();
  hideContextMenu();
  hideRecentContextMenu();
  const formatButton = $('editorctx-format');
  formatButton.disabled = true;
  formatButton.textContent = 'Detecting format…';
  _positionEditorContextMenu(menu, x, y);

  try {
    const { language } = await _getFormatterFileInfo(tab.filePath);
    if (_getActiveTab() !== tab) return;
    formatButton.textContent = language ? `Format ${language}` : 'Format File';
    formatButton.disabled = !language;
  } catch (error) {
    console.error('[editor] Could not detect file format:', error);
    formatButton.textContent = 'Format File';
    formatButton.disabled = true;
  }
}

async function _formatActiveFile() {
  const tab = _getActiveTab();
  const editor = window.CM;
  const view = editor?.view;
  if (!tab || !view) return;

  const parser = _guessFormatterParser(tab.filePath);
  if (!parser) {
    showToast('js-beautify does not support this file type');
    return;
  }

  let formatter;
  try {
    formatter = await _ensureFormatter();
  } catch (error) {
    console.warn('[editor] Could not initialize js-beautify for formatting:', error);
    formatter = null;
  }
  if (!formatter) {
    showToast('Formatting is unavailable in this build');
    return;
  }

  const content = view.state.doc.toString();
  const selection = view.state.selection.main;
  const cursorOffset = selection.head;
  const isUnchanged = () => _getActiveTab() === tab && window.CM?.view === view &&
    view.state.doc.toString() === content &&
    view.state.selection.main.anchor === selection.anchor &&
    view.state.selection.main.head === selection.head;
  const config = { indent_size: 2, end_with_newline: true };

  if (!isUnchanged()) {
    showToast('Formatting cancelled because the active file changed');
    return;
  }

  const formatted = parser === 'css'
    ? formatter.css_beautify(content, config)
    : parser === 'html'
      ? formatter.html_beautify(content, config)
      : formatter.js_beautify(content, config);

  if (!isUnchanged()) {
    showToast('Formatting cancelled because the active file changed');
    return;
  }

  editor.replaceDocument(formatted, Math.min(cursorOffset, formatted.length));
  showToast(`${FORMATTER_LANGUAGE_NAMES[parser] || parser} formatted`);
}

async function _copyEditorSelection(cut = false) {
  const editor = window.CM;
  const view = editor?.view;
  if (!view) return;
  const selection = view.state.selection.main;
  const selectedText = selection.from === selection.to
    ? ''
    : view.state.sliceDoc(selection.from, selection.to);
  if (selectedText == null || selectedText === '') return;
  try {
    if (!EDITOR_CLIPBOARD?.writeText) throw new Error('Clipboard access is unavailable');
    await EDITOR_CLIPBOARD.writeText(selectedText);
    if (cut) {
      const currentSelection = view.state.selection.main;
      if (window.CM?.view !== view || currentSelection.from !== selection.from ||
          currentSelection.to !== selection.to ||
          view.state.sliceDoc(selection.from, selection.to) !== selectedText) {
        showToast('Selection changed before cut completed');
        return;
      }
      editor.replaceSelection('');
    }
  } catch (error) {
    console.error('[editor] Clipboard write failed:', error);
    showToast(`Could not ${cut ? 'cut' : 'copy'} selection: ${error.message}`);
  }
}

async function _pasteEditorClipboard() {
  const editor = window.CM;
  const view = editor?.view;
  if (!view) return;
  try {
    if (!EDITOR_CLIPBOARD?.readText) throw new Error('Clipboard access is unavailable');
    const text = await EDITOR_CLIPBOARD.readText();
    if (window.CM?.view !== view) {
      showToast('Paste cancelled because the active file changed');
      return;
    }
    editor.replaceSelection(text);
  } catch (error) {
    console.error('[editor] Clipboard read failed:', error);
    showToast(`Could not paste: ${error.message}`);
  }
}

// Tab rendering
function _renderTabs() {
  const bar = $('editor-tabs');
  if (!bar) return;
  bar.replaceChildren();
  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'editor-tab' +
      (i === activeTabIndex ? ' editor-tab--active' : '') +
      (tab.preview ? ' editor-tab--preview' : '');
    el.dataset.index = i;
    const tabExt = path.extname(tab.filePath).toLowerCase();
    // _fileIconHtml output is from our own static maps -- safe to inject.
    el.innerHTML =
      `<span class="editor-tab-icon">${_fileIconHtml(tabExt)}</span>` +
      `<span class="editor-tab-name">${_escHtml(path.basename(tab.filePath))}</span>` +
      `<span class="editor-tab-dirty ${tab.isDirty ? '' : 'hidden'}" title="Unsaved">\u25CF</span>` +
      `<button class="editor-tab-close" data-index="${i}" title="Close" aria-label="Close ${_escHtml(path.basename(tab.filePath))}">${_uiIcon('close')}</button>`;

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('editor-tab-close')) return;
      _switchToTab(i);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('editor-tab-close')) return;
      if (tabs[i]?.preview) { tabs[i].preview = false; _renderTabs(); }
    });
    el.querySelector('.editor-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      _closeTab(i);
    });
    bar.appendChild(el);
  });
  _renderOpenEditors();
  _updateEditorToolbar();
}

function _renderOpenEditors() {
  const section = $('open-editors-section');
  const list = $('open-editors-list');
  const count = $('open-editors-count');
  if (!section || !list) return;
  section.classList.toggle('hidden', tabs.length === 0);
  if (count) count.textContent = String(tabs.length);
  list.replaceChildren();

  tabs.forEach((tab, index) => {
    const item = document.createElement('div');
    item.className = 'open-editor-item' + (index === activeTabIndex ? ' open-editor-item--active' : '');
    item.title = tab.filePath;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    if (index === activeTabIndex) item.setAttribute('aria-current', 'page');

    const icon = document.createElement('span');
    icon.className = 'open-editor-icon';
    icon.innerHTML = _fileIconHtml(path.extname(tab.filePath).toLowerCase());

    const name = document.createElement('span');
    name.className = 'open-editor-name';
    name.textContent = path.basename(tab.filePath);

    const dirty = document.createElement('span');
    dirty.className = `open-editor-dirty${tab.isDirty ? '' : ' hidden'}`;
    dirty.textContent = '\u25CF';
    dirty.title = 'Unsaved changes';

    const close = document.createElement('button');
    close.className = 'open-editor-close';
    close.type = 'button';
    close.title = `Close ${path.basename(tab.filePath)}`;
    close.setAttribute('aria-label', close.title);
    close.innerHTML = _uiIcon('close');
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      _closeTab(index);
    });

    item.append(icon, name, dirty, close);
    item.addEventListener('click', () => {
      _switchToTab(index);
      switchTab('editor');
    });
    item.addEventListener('keydown', (event) => {
      if (event.target === close || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      item.click();
    });
    list.appendChild(item);
  });
}

function _updateEditorToolbar() {
  const tab = _getActiveTab();
  const hasProject = !!state.projectDir;
  const ext = tab ? path.extname(tab.filePath).toLowerCase() : '';
  const isImage = !!tab && IMAGE_EXTS.has(ext);
  const isHtml = ext === '.html' || ext === '.htm';
  const canCheckSyntax = !!_SYNTAX_LOADER_MAP[ext]
    || ['.json', '.novaapp', '.css', '.html', '.htm'].includes(ext);
  const breadcrumbs = $('editor-breadcrumbs');

  if (breadcrumbs) {
    breadcrumbs.replaceChildren();
    breadcrumbs.title = tab?.filePath || '';
    if (!tab) {
      const empty = document.createElement('span');
      empty.className = 'editor-context-empty';
      empty.textContent = state.projectDir ? 'Choose a file to start editing' : 'No project open';
      breadcrumbs.appendChild(empty);
    } else {
      const root = path.resolve(state.projectDir || path.dirname(tab.filePath));
      const relative = path.relative(root, tab.filePath);
      const parts = [path.basename(root), ...relative.split(path.sep).filter(Boolean)];
      parts.forEach((part, index) => {
        if (index) {
          const separator = document.createElement('span');
          separator.className = 'editor-breadcrumb-separator';
          separator.setAttribute('aria-hidden', 'true');
          separator.textContent = '/';
          breadcrumbs.appendChild(separator);
        }
        const segment = document.createElement('span');
        segment.className = index === parts.length - 1
          ? 'editor-breadcrumb editor-breadcrumb--active'
          : 'editor-breadcrumb';
        segment.textContent = part;
        if (index === parts.length - 1) segment.setAttribute('aria-current', 'page');
        breadcrumbs.appendChild(segment);
      });
    }
  }

  const settings = window.CM?.getSettings();
  const controls = [
    ['btn-editor-find', !!tab && !isImage],
    ['btn-editor-wrap', !!tab && !isImage],
    ['btn-editor-preview', !!tab && isHtml],
    ['btn-editor-font-dec', !!tab && !isImage && (settings?.fontSize ?? 13) > 10],
    ['btn-editor-font-inc', !!tab && !isImage && (settings?.fontSize ?? 13) < 24],
    ['btn-diff-vs-saved', !!tab && !isImage],
    ['btn-check-syntax', !!tab && !isImage && canCheckSyntax],
    ['btn-editor-save', !!tab && !isImage],
    ['btn-editor-save-all', tabs.some((openTab) =>
      openTab.isDirty && !IMAGE_EXTS.has(path.extname(openTab.filePath).toLowerCase()))],
  ];
  controls.forEach(([id, enabled]) => {
    const button = $(id);
    if (button) button.disabled = !enabled;
  });

  const wrapButton = $('btn-editor-wrap');
  if (wrapButton) wrapButton.setAttribute('aria-pressed', String(settings?.wordWrap === true));
  const previewButton = $('btn-editor-preview');
  if (previewButton) previewButton.setAttribute('aria-pressed', String(_previewVisible && isHtml));
  const fontSize = $('editor-font-size');
  if (fontSize) fontSize.textContent = `${settings?.fontSize ?? 13}px`;
  const tabbar = $('editor-tabbar');
  if (tabbar) tabbar.classList.toggle('hidden', tabs.length === 0);

  const openButton = $('btn-editor-empty-open');
  if (openButton) {
    const icon = openButton.querySelector('.ui-icon use');
    const label = openButton.querySelector('span');
    const shortcut = openButton.querySelector('kbd');
    if (icon) icon.setAttribute('href', hasProject ? '#ui-icon-search' : '#ui-icon-folder-open');
    if (label) label.textContent = hasProject ? 'Quick Open' : 'Open Project';
    if (shortcut) shortcut.textContent = hasProject ? `${MOD_KEY}+P` : `${MOD_KEY}+O`;
  }
}

function _stashActiveTabContent() {
  const tab = tabs[activeTabIndex];
  if (!tab || !window.CM) return;
  const ext = path.extname(tab.filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return; // images aren't backed by a CM buffer
  tab.liveContent = window.CM.getValue();
}

function _switchToTab(index) {
  if (index === activeTabIndex) return;
  _stashActiveTabContent();
  activeTabIndex = index;
  const tab = tabs[index];
  _loadTabIntoEditor(tab);
  _renderTabs();
  _highlightActiveFile();
}

async function _closeTab(index) {
  const tab = tabs[index];
  if (!tab) return false;
  if (tab.isDirty) {
    const ok = await studioConfirm(`Discard unsaved changes to "${path.basename(tab.filePath)}"?`, {
      title: 'Discard unsaved changes',
      confirmLabel: 'Discard changes',
      danger: true,
    });
    if (!ok) return false;
  }
  _emitStudioPluginEvent('file:close', {
    path: state.projectDir
      ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
      : tab.filePath,
  });
  tabs.splice(index, 1);

  if (!tabs.length) {
    if (window.CM) window.CM.destroy();
    activeTabIndex = -1;
    _renderTabs();
    _highlightActiveFile();
    _setLivePermStatus(null); // no file open -- nothing to scan
    return true;
  }

  // If we removed a tab to the left of the active one, every later tab's
  // index shifts down by one. Keep activeTabIndex pointing at the same tab.
  if (index < activeTabIndex) {
    activeTabIndex -= 1;
  } else if (index === activeTabIndex) {
    // We closed the active tab itself -- point at the closest remaining one.
    activeTabIndex = Math.min(index, tabs.length - 1);
    _loadTabIntoEditor(tabs[activeTabIndex]);
  }
  _renderTabs();
  _highlightActiveFile();
  return true;
}

function _loadTabIntoEditor(tab) {
  if (!tab) return;
  const ext = path.extname(tab.filePath).toLowerCase();
  $('btn-editor-save').disabled = IMAGE_EXTS.has(ext);
  if (_previewVisible && ext !== '.html' && ext !== '.htm') _hidePreview();

  if (IMAGE_EXTS.has(ext)) {
    if (window.CM) window.CM.destroy();
    $('file-preview-image').classList.remove('hidden');
    $('file-preview-img').src = 'file://' + tab.filePath;
    try {
      const stat = fs.statSync(tab.filePath);
      $('file-preview-meta').textContent =
        `${path.basename(tab.filePath)} \u00b7 ${_formatSize(stat.size)}`;
    } catch {
      $('file-preview-meta').textContent = '';
    }
    $('status-bar')?.classList.add('status-bar-hidden');
  } else {
    $('file-preview-image').classList.add('hidden');
    if (window.CM) {
      const content = (tab.liveContent !== undefined) ? tab.liveContent : tab.originalContent;
      window.CM.mount(content, ext, tab.filePath, state.projectDir, _onCmChange, saveOpenFile, _updateStatusBar).then(() => {
        _updateStatusBar();
        window.CM?.focus();
        // Run the live permission scan immediately on open/switch, not just
        // on the next keystroke -- otherwise switching to a file that
        // already has undeclared nova: calls shows nothing until you type.
        _runLivePermissionScan();
      });
    } else {
      _setLivePermStatus(null); // image tab, or no editor mounted -- nothing to scan
    }
  }

  _refreshPreviewIfVisible();
  _updateEditorToolbar();
}

function _highlightActiveFile() {
  document.querySelectorAll('.file-item--active')
    .forEach((el) => el.classList.remove('file-item--active'));
  const tab = _getActiveTab();
  if (tab) {
    document.querySelector(`.file-item[data-path="${CSS.escape(tab.filePath)}"]`)
      ?.classList.add('file-item--active');
  }
}

// Open file (creates or focuses tab)
function openFileEditor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) { showToast('Binary files cannot be edited here'); return; }

  // Already open -- just focus it.
  const existing = tabs.findIndex((t) => t.filePath === filePath);
  if (existing !== -1) {
    if (existing !== activeTabIndex) _stashActiveTabContent();
    activeTabIndex = existing;
    _loadTabIntoEditor(tabs[existing]);
    _renderTabs();
    switchTab('editor');
    _highlightActiveFile();
    _qoRecordRecentFile(filePath);
    _emitStudioPluginEvent('file:open', {
      path: state.projectDir
        ? path.relative(state.projectDir, filePath).split(path.sep).join('/')
        : filePath,
      isImage: IMAGE_EXTS.has(ext),
      reusedTab: true,
    });
    return;
  }

  let originalContent = '';
  if (!IMAGE_EXTS.has(ext)) {
    try { originalContent = fs.readFileSync(filePath, 'utf8'); }
    catch (e) { showToast('Could not read file: ' + e.message); return; }
  }

  _stashActiveTabContent();

  // Reuse existing preview tab if there is one, otherwise open a new tab.
  const previewIdx = tabs.findIndex((t) => t.preview);
  if (previewIdx !== -1) {
    tabs[previewIdx] = { filePath, originalContent, isDirty: false, preview: true };
    activeTabIndex = previewIdx;
  } else {
    tabs.push({ filePath, originalContent, isDirty: false, preview: true });
    activeTabIndex = tabs.length - 1;
  }

  _renderTabs();
  _loadTabIntoEditor(tabs[activeTabIndex]);
  switchTab('editor');
  _highlightActiveFile();
  _qoRecordRecentFile(filePath);
  _emitStudioPluginEvent('file:open', {
    path: state.projectDir
      ? path.relative(state.projectDir, filePath).split(path.sep).join('/')
      : filePath,
    isImage: IMAGE_EXTS.has(ext),
    reusedTab: false,
  });
}

// CM change callback
function _onCmChange() {
  const tab = _getActiveTab();
  if (!tab) return;
  const dirty = window.CM.getValue() !== tab.originalContent;
  if (tab.preview && dirty) { tab.preview = false; }
  if (dirty !== tab.isDirty) {
    tab.isDirty = dirty;
    _renderTabs();
  }
  _refreshPreviewIfVisible();
  _updateStatusBar();
  _updateTreeFileSize(tab.filePath, window.CM.getValue());
  _emitStudioPluginEvent('editor:change', {
    path: state.projectDir
      ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
      : tab.filePath,
    isDirty: dirty,
    length: window.CM.getValue().length,
  });
  _onEditorContentChanged();
  _scheduleLivePermissionScan();
}

// ── Live undeclared-permission check ────────────────────────────────────
//
// Same idea as builder.js's listActions() + app.js's _renderPermissionAudit
// (declared-vs-detected via channel names), but scoped to just the
// buffer currently open in the editor and run on a debounce as you type,
// instead of at build/inspect time across the whole packaged app. Reuses
// the *same* regex source so the two detectors can't silently drift apart.
const _LIVE_PERM_RE = /nova:[a-zA-Z0-9:_-]+/g;
let _livePermScanTimer = null;
const _LIVE_PERM_DEBOUNCE_MS = 300;

function _scheduleLivePermissionScan() {
  if (_livePermScanTimer) clearTimeout(_livePermScanTimer);
  _livePermScanTimer = setTimeout(_runLivePermissionScan, _LIVE_PERM_DEBOUNCE_MS);
}

function _runLivePermissionScan() {
  _livePermScanTimer = null;
  const tab = _getActiveTab();
  if (!tab || !window.CM) { _setLivePermStatus(null); return; }

  // Only meaningful for files that can actually call window.nova.ipc --
  // skip non-JS-ish files rather than regex-scanning markup/CSS/JSON where
  // a "nova:xyz" match would just be a string literal, comment, or manifest
  // value, not a real permission call.
  const ext = path.extname(tab.filePath || '').toLowerCase();
  if (!['.js', '.mjs', '.cjs'].includes(ext)) { _setLivePermStatus(null); return; }

  const content = window.CM.getValue();
  const matches = content.match(_LIVE_PERM_RE);
  if (!matches || !matches.length) { _setLivePermStatus(null); return; }

  const detected = new Set(matches.flatMap(_permissionsForChannel));
  if (!detected.size) { _setLivePermStatus(null); return; }
  const manifest = readManifestForm();
  const declared = new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
  ].map(_canonicalPermission));
  const undeclared = [...detected.difference(declared)];

  if (undeclared.length === 0) {
    _setLivePermStatus('ok', 'permissions ok');
  } else {
    _setLivePermStatus('missing', `${undeclared.length} undeclared: ${undeclared.slice(0, 3).join(', ')}${undeclared.length > 3 ? '\u2026' : ''}`);
  }
}

// Mirrors _setSyntaxStatus's show/hide + type-coloring pattern exactly, so
// the two status-bar badges look and behave consistently instead of each
// inventing their own convention.
function _setLivePermStatus(type, text) {
  const el = $('sb-perm-live');
  const sep = $('sb-perm-sep');
  if (!el) return;
  if (!text) {
    el.style.display = 'none';
    if (sep) sep.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (sep) sep.style.display = '';
  el.innerHTML = `${_uiIcon(type === 'ok' ? 'check' : 'alert')}<span>${_escHtml(text)}</span>`;
  const statusClass = type === 'missing' ? 'warn' : type;
  el.className = `status-bar-item status-bar-item--clickable status-bar-item--${statusClass}`;
}

// Patches just one row's size label in the sidebar tree, rather than
// re-reading the whole directory from disk. Only meaningful for the
// currently-open file, since that's the only one with a live in-memory
// buffer to measure -- other files in the tree still show on-disk size
// until they're opened or the tree is refreshed.
function _updateTreeFileSize(filePath, content) {
  const row = document.querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
  if (!row) return;
  const sizeEl = row.querySelector('.file-size');
  if (!sizeEl) return; // shouldn't happen for a file row, but don't throw if tree markup changes later
  sizeEl.textContent = _formatSize(Buffer.byteLength(content, 'utf8'));
}

// Status bar
const LANG_LABELS = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript TSX',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS',
  '.json': 'JSON',
  '.md': 'Markdown', '.markdown': 'Markdown',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++ Header',
  '.c': 'C', '.h': 'C/C++ Header',
};

function _updateStatusBar() {
  const tab = _getActiveTab();
  const sb = $('status-bar');
  if (!tab || !sb) return;

  const ext = path.extname(tab.filePath).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  if (isImage) {
    sb.classList.add('status-bar-hidden');
    return;
  }
  sb.classList.remove('status-bar-hidden');

  $('sb-lang').textContent = LANG_LABELS[ext] || ext.slice(1).toUpperCase();

  if (window.CM) {
    try {
      const content = window.CM.getValue();
      const size = Buffer.byteLength(content, 'utf8');
      $('sb-size').textContent = _formatSize(size);
      $('sb-lines').textContent = `${window.CM.view?.state.doc.lines ?? content.split('\n').length} lines`;
    } catch {
      $('sb-size').textContent = '';
    }

    if (window.CM.view) {
      const pos = window.CM.view.state.selection.main.head;
      const selection = window.CM.view.state.selection.main;
      const line = window.CM.view.state.doc.lineAt(pos);
      const col = pos - line.from + 1;
      $('sb-pos').textContent = `Ln ${line.number}, Col ${col}`;
      const selectionCount = selection.to - selection.from;
      $('sb-selection').textContent = `${selectionCount.toLocaleString()} selected`;
      $('sb-selection').style.display = selectionCount ? '' : 'none';
      $('sb-selection-sep').style.display = selectionCount ? '' : 'none';
    }
  }

  _setSyntaxStatus(null, null);
  _updateEditorToolbar();
}

function saveOpenFile() {
  const tab = _getActiveTab();
  if (!tab || $('btn-editor-save').disabled) return;
  try {
    const content = window.CM ? window.CM.getValue() : '';
    fs.writeFileSync(tab.filePath, content, 'utf8');
    _markOwnWrite(tab.filePath);
    tab.originalContent = content;
    tab.liveContent = undefined;
    tab.isDirty = false;
    _emitStudioPluginEvent('file:save', {
      path: state.projectDir
        ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
        : tab.filePath,
    });
    _renderTabs();
    showToast('Saved ' + path.basename(tab.filePath));
    _refreshPreviewIfVisible();
    if (state.projectDir) {
      if (_designIsEntryAsset(tab.filePath)) _designInvalidate();
    }
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
}

function saveAllOpenFiles() {
  if (!tabs.length) return;

  // The active tab's freshest edits live in the live CM buffer, not yet
  // stashed onto the tab object -- save it the normal way first.
  const activeTab = _getActiveTab();
  if (activeTab && activeTab.isDirty) saveOpenFile();

  const rest = tabs.filter((t) => t !== activeTab && t.isDirty);
  if (!rest.length) return;

  let saved = 0;
  const failed = [];
  for (const tab of rest) {
    const ext = path.extname(tab.filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) continue; // nothing editable to save
    const content = (tab.liveContent !== undefined) ? tab.liveContent : tab.originalContent;
    try {
      fs.writeFileSync(tab.filePath, content, 'utf8');
      _markOwnWrite(tab.filePath);
      tab.originalContent = content;
      tab.liveContent = undefined;
      tab.isDirty = false;
      _emitStudioPluginEvent('file:save', {
        path: state.projectDir
          ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
          : tab.filePath,
      });
      saved++;
      if (state.projectDir) {
        if (_designIsEntryAsset(tab.filePath)) _designInvalidate();
      }
    } catch {
      failed.push(path.basename(tab.filePath));
    }
  }

  if (saved) _renderTabs();
  if (failed.length) {
    showToast(`Saved ${saved} file(s), failed: ${failed.join(', ')}`);
  } else if (saved) {
    showToast(`Saved ${saved} file(s)`);
  }
}

function initEditorDirtyTracking() { /* handled via _onCmChange */ }

// Close guard (closes preview/unpinned tabs; pinned tabs stay open).
//
// Pinning a tab (double-click, or editing a preview tab) is meant to be a
// durable "keep this open" action, not just protection against the next
// single-click preview-reuse. Only unpinned (preview) tabs get discarded
// here; pinned tabs persist.
async function editorCloseGuard() {
  const toDiscard = tabs.filter((t) => t.preview);
  const dirty = toDiscard.filter((t) => t.isDirty);
  if (dirty.length) {
    const names = dirty.map((t) => path.basename(t.filePath)).join(', ');
    const ok = await studioConfirm(`Discard unsaved changes to: ${names}?`, {
      title: 'Discard unsaved changes',
      confirmLabel: 'Discard changes',
      danger: true,
    });
    if (!ok) return;
  }
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].preview) tabs.splice(i, 1);
  }
  // Re-point activeTabIndex at the closest remaining pinned tab.
  activeTabIndex = tabs.length ? Math.min(activeTabIndex, tabs.length - 1) : -1;
  if (window.CM && !tabs.length) window.CM.destroy();
  if (tabs.length) _loadTabIntoEditor(tabs[activeTabIndex]);
  _renderTabs();
  _highlightActiveFile();
  _hidePreview();
}

// HTML Preview
let _previewVisible = false;

function _refreshPreviewIfVisible() {
  if (!_previewVisible) return;
  const tab = _getActiveTab();
  if (!tab) return;
  const ext = path.extname(tab.filePath).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') return;
  const iframe = $('preview-iframe');
  const content = window.CM ? window.CM.getValue() : tab.originalContent;
  // Inject a <base> so relative URLs in the user's HTML resolve against the
  // file's directory rather than the studio's origin.
  const base = `<base href="file://${path.dirname(tab.filePath)}/">`;
  iframe.srcdoc = content.replace(/<head>/i, '<head>' + base);
}

function _showPreview() {
  _previewVisible = true;
  $('preview-pane').classList.remove('hidden');
  $('editor-body').classList.add('editor-body--split');
  _refreshPreviewIfVisible();
  _updateEditorToolbar();
}

function _hidePreview() {
  _previewVisible = false;
  $('preview-pane').classList.add('hidden');
  $('editor-body').classList.remove('editor-body--split');
  _updateEditorToolbar();
}

function _togglePreview() {
  const tab = _getActiveTab();
  const ext = tab ? path.extname(tab.filePath).toLowerCase() : '';
  if (!_previewVisible) {
    if (ext !== '.html' && ext !== '.htm') {
      showToast('Preview only works for HTML files');
      return;
    }
    _showPreview();
  } else {
    _hidePreview();
  }
}

// Settings page
function _initManifestAutosave() {
  const ids = [
    'mf-id', 'mf-name', 'mf-version', 'mf-entry', 'mf-description', 'mf-author', 'mf-icon',
    'mf-width', 'mf-height', 'mf-min-width', 'mf-min-height', 'mf-max-width', 'mf-max-height',
    'mf-resizable', 'mf-frame', 'mf-always-on-top', 'mf-start-minimized', 'mf-transparent',
    'permissions-grid'
  ];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', _onManifestFormChanged);
    el.addEventListener('change', _onManifestFormChanged);
  });
}

function _initSettingsPage() {
  const s = window.CM?.getSettings() ?? { fontSize: 13, tabSize: 2, wordWrap: false };
  if ($('lbl-font-size')) $('lbl-font-size').textContent = s.fontSize;
  if ($('sel-tab-size')) $('sel-tab-size').value = String(s.tabSize);
  if ($('chk-word-wrap')) $('chk-word-wrap').checked = s.wordWrap;

  $('btn-font-dec')?.addEventListener('click', () => {
    const cur = parseInt($('lbl-font-size').textContent, 10);
    const next = Math.max(10, cur - 1);
    $('lbl-font-size').textContent = next;
    window.CM?.applySettings({ fontSize: next });
    _updateEditorToolbar();
  });

  $('btn-font-inc')?.addEventListener('click', () => {
    const cur = parseInt($('lbl-font-size').textContent, 10);
    const next = Math.min(24, cur + 1);
    $('lbl-font-size').textContent = next;
    window.CM?.applySettings({ fontSize: next });
    _updateEditorToolbar();
  });

  $('sel-tab-size')?.addEventListener('change', (e) => {
    window.CM?.applySettings({ tabSize: parseInt(e.target.value, 10) });
  });

  $('chk-word-wrap')?.addEventListener('change', (e) => {
    window.CM?.applySettings({ wordWrap: e.target.checked });
    _updateEditorToolbar();
  });

  const sbToggle = $('chk-status-bar');
  const sb = $('status-bar');
  if (sbToggle && sb) {
    sbToggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        sb.classList.remove('status-bar-hidden');
        _updateStatusBar();
      } else {
        sb.classList.add('status-bar-hidden');
      }
    });
  }

  // Autosave settings
  const selMode = $('sel-autosave-mode');
  const inpCustom = $('inp-autosave-custom');
  const chkManifest = $('chk-autosave-manifest');
  const chkEditor = $('chk-autosave-editor');

  if (selMode) {
    selMode.value = state.autosaveMode === 'realtime' || (typeof state.autosaveMode === 'number')
      ? String(state.autosaveMode)
      : state.autosaveMode;
    if (inpCustom) {
      inpCustom.style.display = selMode.value === 'custom' ? '' : 'none';
      inpCustom.value = (typeof state.autosaveMode === 'number' && selMode.value !== 'realtime')
        ? String(state.autosaveMode)
        : '';
    }
    selMode.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'custom') {
        state.autosaveMode = parseInt(inpCustom?.value || '30', 10) || 30;
        if (inpCustom) inpCustom.style.display = '';
      } else if (v === 'realtime') {
        state.autosaveMode = 'realtime';
        if (inpCustom) inpCustom.style.display = 'none';
      } else {
        state.autosaveMode = v === 'off' ? 'off' : parseInt(v, 10);
        if (inpCustom) inpCustom.style.display = 'none';
      }
      saveStorage();
      _applyAutosaveSettings();
    });
  }

  if (inpCustom) {
    inpCustom.addEventListener('input', (e) => {
      const seconds = parseInt(e.target.value, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        state.autosaveMode = seconds;
        if (selMode) selMode.value = 'custom';
        saveStorage();
        _applyAutosaveSettings();
      }
    });
  }

  if (chkManifest) {
    chkManifest.checked = state.autosaveManifest;
    chkManifest.addEventListener('change', (e) => {
      state.autosaveManifest = e.target.checked;
      saveStorage();
      _applyAutosaveSettings();
    });
  }

  if (chkEditor) {
    chkEditor.checked = state.autosaveEditor;
    chkEditor.addEventListener('change', (e) => {
      state.autosaveEditor = e.target.checked;
      saveStorage();
      _applyAutosaveSettings();
    });
  }

  $('sel-ui-density')?.addEventListener('change', (event) => {
    state.uiDensity = event.target.value === 'compact' ? 'compact' : 'comfortable';
    _applyUiDensity();
    saveStorage();
  });

  const glassEffectsInput = $('chk-disable-glass-effects');
  if (glassEffectsInput) {
    glassEffectsInput.checked = state.disableGlassEffects;
    glassEffectsInput.addEventListener('change', () => {
      state.disableGlassEffects = glassEffectsInput.checked;
      _applyGlassEffects();
      try {
        localStorage.setItem(
          GLASS_EFFECTS_STORAGE_KEY,
          state.disableGlassEffects ? 'true' : 'false',
        );
      } catch (error) {
        console.error('Could not persist blur and glass preference:', error);
        showToast(`Could not save appearance preference: ${error.message}`);
      }
      saveStorage();
    });
  }

  $('btn-appearance-reset')?.addEventListener('click', () => {
    state.customColors = {};
    state.lastNonCustomTheme = DEFAULT_THEME;
    state.uiDensity = 'comfortable';
    state.disableGlassEffects = false;
    if (glassEffectsInput) glassEffectsInput.checked = false;
    setTheme(DEFAULT_THEME);
    showToast('Appearance restored to defaults');
  });

  $('btn-settings-back')?.addEventListener('click', hideSettings);

  // Settings search
  const searchInput = $('settings-search');
  if (searchInput) {
    // Cache the rows up front so each keystroke is a tight loop instead of
    // a fresh querySelectorAll walk through the whole settings DOM.
    const sectionRows = [...document.querySelectorAll('.settings-section')].map((section) => ({
      section,
      rows: [...section.querySelectorAll('.settings-row')],
    }));
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      for (const { section, rows } of sectionRows) {
        let anyVisible = false;
        for (const row of rows) {
          const text = row.textContent.toLowerCase();
          const show = !query || text.includes(query);
          row.classList.toggle('settings-hidden', !show);
          if (show) anyVisible = true;
        }
        section.classList.toggle('settings-hidden', !anyVisible);
      }
    });
  }

  // Theme picker for settings page
  const themeBtn = $('btn-theme-picker-settings');
  const themeMenu = $('theme-picker-menu-settings');
  const themeList = $('theme-picker-list-settings');
  if (themeBtn && themeMenu && themeList) {
    _renderSettingsThemeList(themeList, themeMenu);
    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      themeMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!themeMenu.classList.contains('hidden') && !themeMenu.contains(e.target) && e.target !== themeBtn) {
        themeMenu.classList.add('hidden');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') themeMenu.classList.add('hidden');
    });
  }

  _renderCustomThemeSection();

  // Settings export / import. Uses .onclick (assignment, not
  // addEventListener) same as btn-custom-theme-export/-import above --
  // idempotent against _initSettingsPage() being called again (e.g. right
  // after a successful import, to refresh the page's own controls),
  // whereas addEventListener here would stack a duplicate handler each time.
  const settingsExportBtn = $('btn-settings-export');
  if (settingsExportBtn) {
    settingsExportBtn.onclick = () => {
      pickFolder((dir) => {
        const outPath = path.join(dir, 'novapack-studio-settings.json');
        try {
          fs.writeFileSync(outPath, exportStudioSettings());
          showToast(`Settings exported to ${path.basename(outPath)}`);
        } catch (err) {
          showToast(`Could not write settings file: ${err.message}`);
        }
      });
    };
  }

  const settingsImportBtn = $('btn-settings-import');
  if (settingsImportBtn) {
    settingsImportBtn.onclick = () => {
      pickFile('.json', (filePath) => {
        let text;
        try {
          text = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
          showToast(`Could not read file: ${err.message}`);
          return;
        }
        const result = importStudioSettings(text);
        if (result.success) {
          showToast('Settings imported');
        } else {
          showToast(`Import failed: ${result.error}`);
        }
      });
    };
  }
}

function _pluginDataDirectory() {
  if (typeof nw !== 'undefined' && nw.App?.dataPath) return nw.App.dataPath;
  return path.join(os.homedir(), '.novabyte-studio');
}

function _setPluginManagerNotice(message, type = '') {
  const notice = $('plugin-manager-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('is-error', type === 'error');
  notice.classList.toggle('is-success', type === 'success');
}

function _pluginManagerButton(label, action, className = 'action-btn action-btn--ghost') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function _renderInstalledStudioPlugins() {
  const list = $('plugin-installed-list');
  if (!list || !_studioPluginManager) return;
  list.replaceChildren();
  let plugins;
  try {
    plugins = _studioPluginManager.list();
  } catch (error) {
    _setPluginManagerNotice(error.message, 'error');
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = 'Plugin settings could not be loaded.';
    list.append(empty);
    return;
  }
  const totalInstalled = plugins.length;
  const installedCount = $('plugin-installed-count');
  if (installedCount) installedCount.textContent = String(totalInstalled);
  const installedSummary = $('plugin-installed-summary');
  if (installedSummary) installedSummary.textContent = `${totalInstalled} installed plugin${totalInstalled === 1 ? '' : 's'}`;
  const query = _studioPluginManagerView === 'installed'
    ? ($('plugin-search')?.value || '').trim().toLowerCase()
    : '';
  plugins = plugins.filter((plugin) => [plugin.name, plugin.id, plugin.publisher, plugin.description]
    .some((value) => String(value || '').toLowerCase().includes(query)));
  $('plugin-settings-summary').textContent = totalInstalled
    ? `${totalInstalled} installed plugin${totalInstalled === 1 ? '' : 's'}`
    : 'Manage installed plugins and browse the NovaByte catalog.';
  if (!plugins.length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = totalInstalled
      ? 'No installed plugins match your search.'
      : 'No plugins installed yet. Browse the marketplace or install a package.';
    list.append(empty);
    return;
  }

  for (const plugin of plugins) {
    const activationError = _studioPluginActivationErrors.get(plugin.id);
    const card = document.createElement('article');
    card.className = 'plugin-card';
    const icon = document.createElement('div');
    icon.className = 'plugin-card-icon';
    const fallback = document.createElement('span');
    fallback.className = 'plugin-card-icon-fallback';
    fallback.textContent = (plugin.name || plugin.id).split(/[\s.-]+/).filter(Boolean)
      .slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'NB';
    icon.append(fallback);
    const iconUrl = getPluginIconDataUrl(plugin);
    if (iconUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = iconUrl;
      image.addEventListener('load', () => fallback.remove(), { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
      icon.append(image);
    }
    const main = document.createElement('div');
    main.className = 'plugin-card-main';
    const heading = document.createElement('div');
    heading.className = 'plugin-card-heading';
    const title = document.createElement('span');
    title.textContent = plugin.name || plugin.id;
    heading.append(title);
    const badge = document.createElement('span');
    badge.className = `plugin-badge${plugin.signature === 'verified' ? ' plugin-badge--verified' : plugin.signature !== 'unsigned' ? ' plugin-badge--warning' : ''}`;
    badge.textContent = plugin.signature === 'verified'
      ? 'Verified'
      : plugin.signature === 'invalid' ? 'Invalid package' : 'Unverified';
    heading.append(badge);
    const meta = document.createElement('div');
    meta.className = 'plugin-card-meta';
    meta.textContent = [
      plugin.version ? `v${plugin.version}` : '',
      plugin.publisher ? `by ${plugin.publisher}` : '',
      plugin.enabled && plugin.trusted
        ? activationError ? 'Activation failed' : 'Enabled'
        : 'Disabled',
    ].filter(Boolean).join(' · ');
    main.append(heading, meta);
    if (plugin.description) {
      const description = document.createElement('div');
      description.className = 'plugin-card-description';
      description.textContent = plugin.description;
      main.append(description);
    }
    if (plugin.error) {
      const error = document.createElement('div');
      error.className = 'plugin-card-description';
      error.textContent = `Plugin cannot be loaded: ${plugin.error}`;
      main.append(error);
    }
    if (activationError) {
      const error = document.createElement('div');
      error.className = 'plugin-card-description plugin-card-description--error';
      error.textContent = `Plugin activation failed: ${activationError.message || activationError}`;
      main.append(error);
    }
    const actions = document.createElement('div');
    actions.className = 'plugin-card-actions';
    if (!plugin.error) {
      actions.append(_pluginManagerButton(plugin.enabled ? 'Disable' : 'Enable', async () => {
        try {
          if (!plugin.enabled) {
            const unsigned = plugin.signature !== 'verified';
            const needsTrust = !plugin.trusted;
            if ((unsigned || needsTrust) && !await studioConfirm(
              unsigned
                ? `“${plugin.name}” is not digitally signed by NovaByte Trusted Signing. Its publisher and package integrity could not be verified. If enabled, it will have full access to your files, programs, and network.`
                : `“${plugin.name}” will run with full access to your files, programs, and network. Only enable it if you trust its publisher.`,
              {
                title: unsigned ? 'Plugin is not digitally signed' : 'Trust this plugin?',
                confirmLabel: unsigned ? 'Enable anyway' : 'Trust and enable',
              },
            )) {
              return;
            }
          }
          _studioPluginManager.setEnabled(plugin.id, {
            enabled: !plugin.enabled,
            trusted: !plugin.enabled,
          });
          await _reloadStudioPlugins();
          _setPluginManagerNotice(`${plugin.name} ${plugin.enabled ? 'disabled' : 'enabled'}.`, 'success');
          _renderStudioPlugins();
        } catch (error) {
          _setPluginManagerNotice(`Could not update ${plugin.name}: ${error.message}`, 'error');
        }
      }, plugin.enabled ? 'action-btn action-btn--ghost' : 'action-btn action-btn--primary'));
    }
    actions.append(_pluginManagerButton('Uninstall', async () => {
      if (!await studioConfirm(
        `Uninstall “${plugin.name}”? Its installed plugin files will be removed.`,
        { title: 'Uninstall plugin?', confirmLabel: 'Uninstall', danger: true },
      )) return;
      try {
        await _studioPluginManager.uninstall(plugin.id);
        await _reloadStudioPlugins();
        _setPluginManagerNotice(`${plugin.name} was uninstalled.`, 'success');
        _renderStudioPlugins();
      } catch (error) {
        _setPluginManagerNotice(`Could not uninstall ${plugin.name}: ${error.message}`, 'error');
      }
    }));
    actions.append(_pluginManagerButton('Open folder', () => {
      try {
        if (typeof nw === 'undefined' || !nw.Shell?.showItemInFolder) throw new Error('Folder reveal is unavailable');
        nw.Shell.showItemInFolder(plugin.path);
      } catch (error) {
        _setPluginManagerNotice(`Could not open plugin folder: ${error.message}`, 'error');
      }
    }));
    actions.append(_pluginManagerButton('Copy ID', async () => {
      try {
        await navigator.clipboard.writeText(plugin.id);
        _setPluginManagerNotice(`Copied ${plugin.id}.`, 'success');
      } catch (error) {
        _setPluginManagerNotice(`Could not copy plugin ID: ${error.message}`, 'error');
      }
    }));
    card.append(icon, main, actions);
    list.append(card);
  }
}

function _marketplacePluginIcon(container, iconDataUrl) {
  if (!iconDataUrl) return;
  const image = document.createElement('img');
  image.alt = '';
  image.src = iconDataUrl;
  image.addEventListener('load', () => {
    container.querySelector('.plugin-card-icon-fallback')?.remove();
  }, { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  container.append(image);
}

function _marketplacePluginUpdateAvailable(plugin, installed) {
  return Boolean(installed
    && semver.valid(plugin.version)
    && semver.valid(installed.version)
    && semver.gt(plugin.version, installed.version));
}

function _marketplaceInstalledVersionIsNewer(plugin, installed) {
  return Boolean(installed
    && semver.valid(plugin.version)
    && semver.valid(installed.version)
    && semver.lt(plugin.version, installed.version));
}

function _minimumPluginStudioVersion(range) {
  if (!semver.validRange(range)) return null;
  const parsedRange = new semver.Range(range);
  const hasMinimumInEveryRange = parsedRange.set.every((comparators) => (
    comparators.some((comparator) => ['>=', '>', ''].includes(comparator.operator))
  ));
  return hasMinimumInEveryRange ? semver.minVersion(range)?.version || null : null;
}

function _formatPluginStudioRequirement(range) {
  const minimum = _minimumPluginStudioVersion(range);
  return minimum
    ? `Requires minimum Studio version ${minimum}`
    : `Studio compatibility: ${range || 'not specified'}`;
}

async function _loadMarketplacePluginDetails(plugin) {
  if (_studioPluginCatalogDetails.has(plugin.id)) {
    return _studioPluginCatalogDetails.get(plugin.id);
  }
  if (_studioPluginCatalogDetailRequests.has(plugin.id)) {
    return _studioPluginCatalogDetailRequests.get(plugin.id);
  }
  const catalogRevision = _studioPluginCatalogRevision;
  const request = (async () => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'novabyte-plugin-details-'));
    try {
      const archivePath = path.join(temporaryDirectory, `${plugin.id}.nbplugin`);
      const archive = await downloadStudioPluginArchive(plugin);
      fs.writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 });
      const inspected = await _studioPluginManager.inspectArchive(archivePath, { allowIncompatible: true });
      if (inspected.id !== plugin.id || inspected.version !== plugin.version
        || inspected.signature !== 'verified') {
        throw new Error('Package identity or NovaByte signature did not match the catalog listing');
      }
      if (catalogRevision !== _studioPluginCatalogRevision) {
        throw new Error('The marketplace was refreshed while package details were loading');
      }
      const details = {
        manifest: inspected,
        iconDataUrl: inspected.iconDataUrl || null,
      };
      _studioPluginCatalogDetails.set(plugin.id, details);
      return details;
    } finally {
      try {
        await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        console.error('[plugins] Could not clean temporary marketplace details:', error);
      }
    }
  })();
  _studioPluginCatalogDetailRequests.set(plugin.id, request);
  try {
    return await request;
  } catch (error) {
    if (_studioPluginCatalogDetailRequests.get(plugin.id) === request) {
      _studioPluginCatalogDetailRequests.delete(plugin.id);
    }
    throw error;
  }
}

function _renderMarketplacePluginDetails(plugin) {
  const catalogRevision = _studioPluginCatalogRevision;
  const detail = $('plugin-marketplace-detail');
  const list = $('plugin-marketplace-list');
  const caption = $('plugin-marketplace-pane')?.querySelector('.plugin-marketplace-caption');
  const toolbar = $('plugin-manager-toolbar');
  if (!detail || !list || !caption) return;
  list.hidden = true;
  caption.hidden = true;
  detail.hidden = false;
  toolbar?.classList.add('is-detail');
  detail.replaceChildren();

  const back = _pluginManagerButton('Back to marketplace', () => {
    _studioPluginSelectedId = null;
    _renderMarketplaceStudioPlugins();
  });
  back.classList.add('plugin-detail-back');

  const hero = document.createElement('div');
  hero.className = 'plugin-detail-hero';
  const icon = document.createElement('div');
  icon.className = 'plugin-card-icon plugin-detail-icon';
  const fallback = document.createElement('span');
  fallback.className = 'plugin-card-icon-fallback';
  fallback.textContent = (plugin.name || plugin.id).split(/[\s.-]+/).filter(Boolean)
    .slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'NB';
  icon.append(fallback);
  const titleBlock = document.createElement('div');
  titleBlock.className = 'plugin-detail-title-block';
  const titleRow = document.createElement('div');
  titleRow.className = 'plugin-card-heading';
  const title = document.createElement('h3');
  title.textContent = plugin.name;
  const verified = document.createElement('span');
  verified.className = 'plugin-badge plugin-badge--verified';
  verified.textContent = 'Verified';
  titleRow.append(title, verified);
  const publisher = document.createElement('p');
  publisher.className = 'plugin-detail-publisher';
  publisher.textContent = `by ${plugin.publisher}`;
  titleBlock.append(titleRow, publisher);
  hero.append(icon, titleBlock);

  const summary = document.createElement('p');
  summary.className = 'plugin-detail-description';
  summary.textContent = plugin.description;
  const metadata = document.createElement('dl');
  metadata.className = 'plugin-detail-metadata';
  const addMetadata = (label, value, target = metadata) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    row.append(term, description);
    target.append(row);
  };
  addMetadata('Version', plugin.version);
  addMetadata('Plugin ID', plugin.id);
  const minimumStudioVersion = _minimumPluginStudioVersion(plugin.compatibleStudio);
  addMetadata(
    minimumStudioVersion ? 'Minimum Studio version' : 'Studio compatibility',
    minimumStudioVersion || plugin.compatibleStudio,
  );
  addMetadata('Current Studio', STUDIO_VERSION);
  if (plugin.size > 0) addMetadata('Package size', `${(plugin.size / (1024 * 1024)).toFixed(2)} MiB`);
  if (plugin.publishedAt) {
    const published = new Date(plugin.publishedAt);
    addMetadata('Published', Number.isNaN(published.getTime()) ? plugin.publishedAt : published.toLocaleDateString());
  }

  const sections = document.createElement('div');
  sections.className = 'plugin-detail-sections';
  const descriptionSection = document.createElement('section');
  const descriptionHeading = document.createElement('h4');
  descriptionHeading.textContent = 'About this plugin';
  descriptionSection.append(descriptionHeading, summary);
  sections.append(descriptionSection, metadata);
  if (plugin.releaseNotes) {
    const releaseSection = document.createElement('section');
    const releaseHeading = document.createElement('h4');
    releaseHeading.textContent = 'Release notes';
    const releaseNotes = document.createElement('p');
    releaseNotes.className = 'plugin-detail-release-notes';
    releaseNotes.textContent = plugin.releaseNotes;
    releaseSection.append(releaseHeading, releaseNotes);
    sections.append(releaseSection);
  }
  const packageSection = document.createElement('section');
  const packageHeading = document.createElement('h4');
  packageHeading.textContent = 'Package information';
  const packageMetadata = document.createElement('dl');
  packageMetadata.className = 'plugin-detail-metadata';
  packageSection.append(packageHeading, packageMetadata);
  sections.append(packageSection);

  const actions = document.createElement('div');
  actions.className = 'plugin-detail-actions';
  let installedPlugin = null;
  try {
    installedPlugin = _studioPluginManager.list().find((installed) => installed.id === plugin.id) || null;
  } catch (error) {
    _setPluginManagerNotice(`Could not read installed plugins: ${error.message}`, 'error');
  }
  const isInstalled = Boolean(installedPlugin);
  const updateAvailable = _marketplacePluginUpdateAvailable(plugin, installedPlugin);
  const compatible = semver.validRange(plugin.compatibleStudio)
    && semver.satisfies(STUDIO_VERSION, plugin.compatibleStudio);
  const install = _pluginManagerButton(
    !compatible
      ? 'Not compatible'
      : updateAvailable
        ? `Update to v${plugin.version}`
        : isInstalled
          ? _marketplaceInstalledVersionIsNewer(plugin, installedPlugin) ? 'Installed newer' : 'Up to date'
          : 'Install plugin',
    () => void _installMarketplacePlugin(plugin),
    isInstalled && !updateAvailable ? 'action-btn action-btn--ghost' : 'action-btn action-btn--primary',
  );
  install.disabled = !compatible || (isInstalled && !updateAvailable);
  actions.append(install);
  if (isInstalled) {
    actions.append(_pluginManagerButton('Manage installed plugin', () => {
      _setPluginManagerView('installed');
      const search = $('plugin-search');
      if (search) search.value = plugin.id;
      _renderStudioPlugins();
    }));
  }

  const packageStatus = document.createElement('p');
  packageStatus.className = 'plugin-detail-package-status';
  packageStatus.setAttribute('role', 'status');
  packageStatus.textContent = 'Verifying package details and loading its bundled icon…';
  detail.append(back, hero, sections, actions, packageStatus);

  void _loadMarketplacePluginDetails(plugin).then(({ manifest, iconDataUrl }) => {
    if (_studioPluginSelectedId !== plugin.id || catalogRevision !== _studioPluginCatalogRevision) return;
    _marketplacePluginIcon(icon, iconDataUrl);
    packageStatus.remove();
    const manifestFields = [
      ['Manifest compatibility', manifest.engines?.studio],
      ['License', manifest.license],
      ['Homepage', manifest.homepage],
      ['Repository', manifest.repository],
      ['Keywords', Array.isArray(manifest.keywords) ? manifest.keywords.join(', ') : manifest.keywords],
    ];
    for (const [label, value] of manifestFields) {
      if (typeof value === 'string') addMetadata(label, value.slice(0, 500), packageMetadata);
    }
    if (!packageMetadata.children.length) packageSection.remove();
  }).catch((error) => {
    if (_studioPluginSelectedId !== plugin.id || catalogRevision !== _studioPluginCatalogRevision) return;
    packageStatus.textContent = `Package details could not be verified: ${error.message}`;
    packageStatus.classList.add('is-error');
    const retry = _pluginManagerButton('Retry verification', () => _renderMarketplacePluginDetails(plugin));
    retry.classList.add('plugin-detail-retry');
    packageStatus.append(' ', retry);
  });
}

function _renderMarketplaceStudioPlugins() {
  const list = $('plugin-marketplace-list');
  if (!list) return;
  const detail = $('plugin-marketplace-detail');
  const caption = $('plugin-marketplace-pane')?.querySelector('.plugin-marketplace-caption');
  const toolbar = $('plugin-manager-toolbar');
  const selected = _studioPluginCatalog.find((plugin) => plugin.id === _studioPluginSelectedId);
  if (selected) {
    _renderMarketplacePluginDetails(selected);
    return;
  }
  if (detail) {
    detail.hidden = true;
    detail.replaceChildren();
  }
  list.hidden = false;
  if (caption) caption.hidden = false;
  toolbar?.classList.remove('is-detail');
  list.replaceChildren();
  const query = ($('plugin-search')?.value || '').trim().toLowerCase();
  const plugins = _studioPluginCatalog.filter((plugin) => [
    plugin.name, plugin.id, plugin.publisher, plugin.description,
  ].some((value) => String(value || '').toLowerCase().includes(query)));
  if (!_studioPluginCatalogLoaded) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = _studioPluginCatalogLoading
      ? 'Loading the NovaByte plugin catalog…'
      : 'Marketplace is unavailable. Use Refresh to try again.';
    list.append(empty);
    return;
  }
  if (!plugins.length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = _studioPluginCatalog.length
      ? 'No marketplace plugins match your search.'
      : 'No plugins are currently published.';
    list.append(empty);
    return;
  }

  let installed;
  try {
    installed = new Map(_studioPluginManager.list().map((plugin) => [plugin.id, plugin]));
  } catch (error) {
    _setPluginManagerNotice(`Could not read installed plugins: ${error.message}`, 'error');
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = 'Installed plugin settings could not be loaded.';
    list.append(empty);
    return;
  }
  for (const plugin of plugins) {
    const installedPlugin = installed.get(plugin.id);
    const isInstalled = Boolean(installedPlugin);
    const updateAvailable = _marketplacePluginUpdateAvailable(plugin, installedPlugin);
    const compatible = semver.validRange(plugin.compatibleStudio)
      && semver.satisfies(STUDIO_VERSION, plugin.compatibleStudio);
    const card = document.createElement('article');
    card.className = 'plugin-card plugin-card--marketplace';
    const icon = document.createElement('div');
    icon.className = 'plugin-card-icon';
    const fallback = document.createElement('span');
    fallback.className = 'plugin-card-icon-fallback';
    fallback.textContent = (plugin.name || plugin.id).split(/[\s.-]+/).filter(Boolean)
      .slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'NB';
    icon.append(fallback);
    _marketplacePluginIcon(icon, _studioPluginCatalogDetails.get(plugin.id)?.iconDataUrl);
    const main = document.createElement('div');
    main.className = 'plugin-card-main';
    const heading = document.createElement('div');
    heading.className = 'plugin-card-heading';
    const title = document.createElement('button');
    title.className = 'plugin-card-title';
    title.textContent = plugin.name;
    title.type = 'button';
    title.addEventListener('click', () => {
      _studioPluginSelectedId = plugin.id;
      _renderMarketplaceStudioPlugins();
    });
    heading.append(title);
    const signature = document.createElement('span');
    signature.className = 'plugin-badge plugin-badge--verified';
    signature.textContent = 'Verified';
    heading.append(signature);
    const meta = document.createElement('div');
    meta.className = 'plugin-card-meta';
    meta.textContent = `v${plugin.version} · ${plugin.publisher} · ${_formatPluginStudioRequirement(plugin.compatibleStudio)} · Current ${STUDIO_VERSION}`;
    const description = document.createElement('div');
    description.className = 'plugin-card-description';
    description.textContent = plugin.description;
    main.append(heading, meta, description);
    if (plugin.releaseNotes) {
      const releaseNotes = document.createElement('details');
      releaseNotes.className = 'plugin-release-notes';
      const summary = document.createElement('summary');
      summary.textContent = 'Release notes';
      const content = document.createElement('p');
      content.textContent = plugin.releaseNotes;
      releaseNotes.append(summary, content);
      main.append(releaseNotes);
    }
    const actions = document.createElement('div');
    actions.className = 'plugin-card-actions';
    actions.append(_pluginManagerButton('View details', () => {
      _studioPluginSelectedId = plugin.id;
      _renderMarketplaceStudioPlugins();
    }));
    const button = _pluginManagerButton(
      !compatible
        ? 'Not compatible'
        : updateAvailable ? 'Update'
          : isInstalled
            ? _marketplaceInstalledVersionIsNewer(plugin, installedPlugin) ? 'Installed newer' : 'Up to date'
            : 'Install',
      () => void _installMarketplacePlugin(plugin),
      isInstalled && !updateAvailable || !compatible
        ? 'action-btn action-btn--ghost'
        : 'action-btn action-btn--primary',
    );
    button.disabled = !compatible || (isInstalled && !updateAvailable);
    actions.append(button);
    if (isInstalled) {
      actions.append(_pluginManagerButton('Manage', () => {
        _setPluginManagerView('installed');
        $('plugin-search').value = plugin.id;
        _renderStudioPlugins();
      }));
    }
    card.append(icon, main, actions);
    list.append(card);
  }
  const summary = $('plugin-marketplace-summary');
  if (summary) summary.textContent = `${_studioPluginCatalog.length} plugin${_studioPluginCatalog.length === 1 ? '' : 's'} from NovaByte Trusted Signing.`;
}

function _renderStudioPlugins() {
  if (!_studioPluginManager) return;
  _renderInstalledStudioPlugins();
  _renderMarketplaceStudioPlugins();
}

function _setPluginManagerView(view) {
  const nextView = view === 'installed' ? 'installed' : 'marketplace';
  if (_studioPluginManagerView !== nextView) {
    const search = $('plugin-search');
    if (search) search.value = '';
    _setPluginManagerNotice('');
    _studioPluginSelectedId = null;
  }
  _studioPluginManagerView = nextView;
  const marketplace = _studioPluginManagerView === 'marketplace';
  for (const [tabId, paneId, active] of [
    ['btn-plugin-marketplace-tab', 'plugin-marketplace-pane', marketplace],
    ['btn-plugin-installed-tab', 'plugin-installed-pane', !marketplace],
  ]) {
    const tab = $(tabId);
    const pane = $(paneId);
    tab?.classList.toggle('is-active', active);
    tab?.setAttribute('aria-selected', String(active));
    if (pane) {
      pane.hidden = !active;
      pane.classList.toggle('hidden', !active);
    }
  }
  $('plugin-manager-toolbar')?.classList.toggle('is-detail', marketplace && Boolean(_studioPluginSelectedId));
  _renderStudioPlugins();
}

async function _loadStudioPluginCatalog() {
  if (_studioPluginCatalogLoading) return;
  _studioPluginCatalogLoading = true;
  _renderMarketplaceStudioPlugins();
  if ($('plugin-store-status')) $('plugin-store-status').textContent = 'Connecting…';
  try {
    _studioPluginCatalog = await fetchStudioPluginCatalog();
    _studioPluginCatalogLoaded = true;
    if ($('plugin-store-status')) $('plugin-store-status').textContent = 'Store connected';
    _setPluginManagerNotice('', '');
  } catch (error) {
    _studioPluginCatalogLoaded = false;
    if ($('plugin-store-status')) $('plugin-store-status').textContent = 'Unavailable';
    _setPluginManagerNotice(`Could not load marketplace: ${error.message}`, 'error');
  } finally {
    _studioPluginCatalogLoading = false;
    _renderMarketplaceStudioPlugins();
  }
}

async function _installMarketplacePlugin(plugin) {
  let temporaryDirectory;
  try {
    const installedPlugin = _studioPluginManager.list()
      .find((installed) => installed.id === plugin.id) || null;
    const updating = _marketplacePluginUpdateAvailable(plugin, installedPlugin);
    if (installedPlugin && !updating) {
      _setPluginManagerNotice(
        semver.valid(plugin.version) && semver.valid(installedPlugin.version)
          && semver.lt(plugin.version, installedPlugin.version)
          ? `${plugin.name} ${installedPlugin.version} is newer than the marketplace version ${plugin.version}.`
          : `${plugin.name} is already up to date.`,
        'error',
      );
      return;
    }
    if (!semver.validRange(plugin.compatibleStudio)
      || !semver.satisfies(STUDIO_VERSION, plugin.compatibleStudio)) {
      _setPluginManagerNotice(`${plugin.name} is not compatible with this Studio version.`, 'error');
      return;
    }
    temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'novabyte-plugin-download-'));
    const archivePath = path.join(temporaryDirectory, `${plugin.id}.nbplugin`);
    _setPluginManagerNotice(`${updating ? 'Updating' : 'Downloading'} ${plugin.name}…`);
    const archive = await downloadStudioPluginArchive(plugin);
    fs.writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 });
    const inspected = await _studioPluginManager.inspectArchive(archivePath);
    if (inspected.id !== plugin.id || inspected.version !== plugin.version
      || inspected.signature !== 'verified') {
      throw new Error('Downloaded package identity or trusted signature did not match the catalog');
    }
    const installed = await _studioPluginManager.installArchive(archivePath);
    if (installed.signature !== 'verified') {
      throw new Error('The installed package failed signature verification');
    }
    _studioPluginCatalogDetails.delete(plugin.id);
    if (updating) await _reloadStudioPlugins();
    _setPluginManagerView('installed');
    _setPluginManagerNotice(
      `${installed.name} ${updating ? 'updated' : 'installed'}. Review its publisher and trust prompt before enabling.`,
      'success',
    );
  } catch (error) {
    _setPluginManagerNotice(`Could not install ${plugin.name}: ${error.message}`, 'error');
  } finally {
    if (temporaryDirectory) {
      try {
        await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        console.error('[plugins] Could not clean temporary marketplace download:', error);
      }
    }
  }
}

function _createStudioPluginApi(plugin) {
  const commands = {
    registerCommand(id, label, action, options = {}) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(id)
        || typeof label !== 'string' || !label.trim() || label.length > 100
        || typeof action !== 'function') {
        throw new TypeError('registerCommand requires a valid ID, label, and action function');
      }
      const key = `${plugin.id}:${id}`;
      if (_studioPluginCommands.has(key)) throw new Error(`Plugin command already registered: ${id}`);
      const entry = {
        id: `plugin:${key}`,
        label,
        aliases: [id, plugin.id, plugin.name],
        description: typeof options.description === 'string' ? options.description : '',
        category: typeof options.category === 'string' && options.category.trim()
          ? `Plugins · ${options.category.trim().slice(0, 40)}`
          : 'Plugins',
        action: () => {
          try {
            Promise.resolve(action(api)).catch((error) => {
              console.error(`[plugins] Command failed in ${plugin.id} (${id}):`, error);
              showToast(`${plugin.name}: command failed. See the developer console for details.`);
            });
          } catch (error) {
            console.error(`[plugins] Command failed in ${plugin.id} (${id}):`, error);
            showToast(`${plugin.name}: command failed. See the developer console for details.`);
          }
        },
        when: typeof options.when === 'function' ? () => {
          try {
            const result = options.when();
            if (result && typeof result.then === 'function') {
              throw new TypeError('Command visibility predicates must be synchronous');
            }
            return result;
          } catch (error) {
            console.error(`[plugins] Command visibility check failed in ${plugin.id} (${id}):`, error);
            return false;
          }
        } : undefined,
      };
      _studioPluginCommands.set(key, entry);
      _refreshStudioPluginCommands();
      return _ownStudioPluginResource(plugin.id, () => {
        _studioPluginCommands.delete(key);
        _refreshStudioPluginCommands();
      });
    },
  };
  const events = {
    on(name, listener) {
      const supported = new Set([
        'project:open',
        'tab:change',
        'view:change',
        'file:open',
        'file:save',
        'file:close',
        'editor:change',
        'theme:change',
        'build:start',
        'build:log',
        'build:complete',
        'build:error',
      ]);
      if (!supported.has(name) || typeof listener !== 'function') {
        throw new TypeError('events.on requires a supported Studio event and listener function');
      }
      const wrapped = (event) => {
        try {
          const result = listener(event.detail);
          if (result && typeof result.then === 'function') {
            result.catch((error) => console.error(`[plugins] Event listener failed in ${plugin.id} (${name}):`, error));
          }
        } catch (error) {
          console.error(`[plugins] Event listener failed in ${plugin.id} (${name}):`, error);
        }
      };
      _studioPluginEventTarget.addEventListener(name, wrapped);
      return _ownStudioPluginResource(plugin.id, () => _studioPluginEventTarget.removeEventListener(name, wrapped));
    },
  };
  const views = {
    registerView({ id, title, content, onShow, onHide } = {}) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(id)
        || typeof title !== 'string' || !title.trim() || title.length > 100
        || !isPluginDomNode(content)
        || (onShow !== undefined && typeof onShow !== 'function')
        || (onHide !== undefined && typeof onHide !== 'function')) {
        throw new TypeError('views.registerView requires a valid ID, title, DOM content node, and optional lifecycle functions');
      }
      const key = `plugin:${plugin.id}:${id}`;
      if (_studioPluginViews.has(key) || document.querySelector(`.tab[data-tab="${CSS.escape(key)}"]`)) {
        throw new Error(`Plugin view already exists: ${id}`);
      }

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab plugin-tab';
      tab.dataset.tab = key;
      tab.setAttribute('aria-label', title);
      const label = document.createElement('span');
      label.textContent = title;
      tab.append(label);
      tab.addEventListener('click', () => switchTab(key));

      const panel = document.createElement('section');
      panel.id = `panel-${key}`;
      panel.className = 'tab-panel plugin-view-panel hidden';
      panel.dataset.pluginId = plugin.id;
      panel.setAttribute('aria-label', title);
      const body = document.createElement('div');
      body.className = 'plugin-view-content';
      body.append(content);
      panel.append(body);

      const tabsElement = $('tabs');
      const projectMain = $('project-main');
      if (!tabsElement || !projectMain) throw new Error('Studio workspace is not available');
      tabsElement.append(tab);
      projectMain.append(panel);

      const registeredView = { pluginId: plugin.id, id, key, tab, panel, api, onShow, onHide };
      _studioPluginViews.set(key, registeredView);
      const dispose = _ownStudioPluginResource(plugin.id, () => {
        if (state.activeTab === key) switchTab('editor');
        tab.remove();
        panel.remove();
        _studioPluginViews.delete(key);
        _refreshStudioPluginCommands();
      });
      _refreshStudioPluginCommands();

      return {
        id: key,
        element: panel,
        show() { switchTab(key); },
        hide() {
          if (state.activeTab === key) switchTab('editor');
          else panel.classList.add('hidden');
        },
        dispose,
      };
    },
    getRegisteredViews() {
      return [..._studioPluginViews.values()]
        .filter((view) => view.pluginId === plugin.id)
        .map(({ id, key, panel }) => ({ id, key, element: panel }));
    },
  };
  const panels = {
    create({ id, title, content } = {}) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(id)
        || typeof title !== 'string' || !title.trim() || title.length > 100
        || !isPluginDomNode(content)) {
        throw new TypeError('panels.create requires a valid ID, title, and DOM content node');
      }
      const panelId = `studio-plugin-${plugin.id}-${id}`;
      if (document.getElementById(panelId)) throw new Error(`Plugin panel already exists: ${id}`);
      const root = document.createElement('div');
      root.className = 'studio-plugin-panel-overlay';
      root.id = panelId;
      root.dataset.pluginId = plugin.id;
      const dialog = document.createElement('section');
      dialog.className = 'studio-plugin-panel';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', title);
      const header = document.createElement('header');
      header.className = 'studio-plugin-panel__header';
      const heading = document.createElement('h2');
      heading.textContent = title;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'studio-plugin-panel__close';
      close.setAttribute('aria-label', 'Close panel');
      close.textContent = '×';
      close.addEventListener('click', () => panel.hide());
      const body = document.createElement('div');
      body.className = 'studio-plugin-panel__body';
      body.append(content);
      header.append(heading, close);
      dialog.append(header, body);
      root.append(dialog);
      root.addEventListener('click', (event) => {
        if (event.target === root) panel.hide();
      });
      document.body.append(root);
      const panel = {
        element: dialog,
        show() { root.hidden = false; close.focus(); },
        hide() { root.hidden = true; },
        dispose() { root.remove(); },
      };
      root.hidden = true;
      return Object.assign(panel, {
        dispose: _ownStudioPluginResource(plugin.id, panel.dispose),
      });
    },
  };
  const api = {
    version: 1,
    studio: { version: STUDIO_VERSION, plugin: { id: plugin.id, name: plugin.name, version: plugin.version } },
    notify(message) {
      showToast(`${plugin.name}: ${String(message).slice(0, 500)}`);
    },
    commands,
    menus: {
      registerItem(menu, id, label, action, options = {}) {
        if (typeof menu !== 'string' || !menu.trim() || menu.length > 40) {
          throw new TypeError('menus.registerItem requires a menu label of 1-40 characters');
        }
        return commands.registerCommand(id, label, action, { ...options, category: menu });
      },
    },
    events,
    views,
    panels,
    project: {
      getDirectory: () => state.projectDir,
      getName: () => state.projectName,
      getManifest() {
        if (!state.projectDir) throw new Error('No project is open');
        return _readManifest(state.projectDir);
      },
      listFiles() {
        if (!state.projectDir) throw new Error('No project is open');
        return listProjectFiles(state.projectDir);
      },
      exists(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        const target = resolveProjectPath(state.projectDir, relativePath);
        try {
          fs.accessSync(target);
          return true;
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
          throw error;
        }
      },
      stat(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        const stat = fs.statSync(resolveProjectPath(state.projectDir, relativePath));
        return {
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      },
      readFile(relativePath, encoding = 'utf8') {
        if (!state.projectDir) throw new Error('No project is open');
        const target = resolveProjectPath(state.projectDir, relativePath);
        return fs.readFileSync(target, encoding);
      },
      writeFile(relativePath, contents, encoding = 'utf8') {
        if (!state.projectDir) throw new Error('No project is open');
        const target = resolveProjectPath(state.projectDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, encoding);
      },
      createDirectory(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        fs.mkdirSync(resolveProjectPath(state.projectDir, relativePath), { recursive: true });
      },
      remove(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        const target = path.resolve(state.projectDir, relativePath);
        resolveProjectPath(state.projectDir, relativePath);
        if (target === path.resolve(state.projectDir)) throw new Error('Cannot remove the open project root');
        fs.rmSync(target, { recursive: true });
      },
      openFile(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        const target = resolveProjectPath(state.projectDir, relativePath);
        if (!fs.statSync(target).isFile()) throw new Error('Project path is not a file');
        openFileEditor(target);
        const tab = tabs.find((item) => item.filePath === target);
        return tab ? {
          path: path.relative(state.projectDir, tab.filePath).split(path.sep).join('/'),
          isDirty: tab.isDirty,
          isPreview: tab.preview,
        } : null;
      },
    },
    files: {
      getOpenFiles() {
        return tabs.map((tab) => ({
          path: state.projectDir
            ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
            : tab.filePath,
          isActive: tab === _getActiveTab(),
          isDirty: tab.isDirty,
          isPreview: tab.preview,
        }));
      },
      getActiveFile() {
        const tab = _getActiveTab();
        if (!tab) return null;
        return {
          path: state.projectDir
            ? path.relative(state.projectDir, tab.filePath).split(path.sep).join('/')
            : tab.filePath,
          isDirty: tab.isDirty,
          isPreview: tab.preview,
        };
      },
      saveCurrent() {
        const tab = _getActiveTab();
        if (!tab) return false;
        saveOpenFile();
        return !tab.isDirty;
      },
      saveAll() {
        saveAllOpenFiles();
        return tabs.every((tab) => !tab.isDirty);
      },
      close(relativePath) {
        if (!state.projectDir) throw new Error('No project is open');
        const target = resolveProjectPath(state.projectDir, relativePath);
        const index = tabs.findIndex((tab) => path.resolve(tab.filePath) === target);
        if (index < 0) return false;
        return _closeTab(index).then(() => !tabs.some((tab) => path.resolve(tab.filePath) === target));
      },
    },
    app: {
      getState() {
        return {
          screen: state.screen,
          projectDirectory: state.projectDir,
          projectName: state.projectName,
          activeView: state.activeTab,
          theme: state.theme,
          building: state.building,
        };
      },
      async openProject(directory) {
        if (typeof directory !== 'string' || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
          throw new Error('Project directory does not exist');
        }
        await loadProject(directory);
        return typeof directory === 'string' && !!state.projectDir
          && path.resolve(state.projectDir) === path.resolve(directory);
      },
    },
    ui: {
      notify: (message) => api.notify(message),
      getTheme: () => state.theme,
      getThemes: () => [...THEMES, { id: CUSTOM_THEME_ID, label: 'Custom' }]
        .map(({ id, label }) => ({ id, label })),
      setTheme(themeId) {
        if (!_isValidTheme(themeId)) throw new TypeError(`Unsupported Studio theme: ${themeId}`);
        setTheme(themeId);
        return state.theme;
      },
      getDensity: () => state.uiDensity,
      setDensity(density) {
        if (!['comfortable', 'compact'].includes(density)) {
          throw new TypeError(`Unsupported Studio density: ${density}`);
        }
        state.uiDensity = density;
        _applyUiDensity();
        saveStorage();
        return state.uiDensity;
      },
      getViews: () => [
        'editor', 'manifest', 'design', 'permissions', 'build', 'sign', 'git', 'review',
        ..._studioPluginViews.keys(),
      ],
      switchView(name) {
        const allowed = new Set([
          'editor', 'manifest', 'design', 'permissions', 'build', 'sign', 'git', 'review',
          ..._studioPluginViews.keys(),
        ]);
        if (!allowed.has(name)) throw new TypeError(`Unsupported Studio view: ${name}`);
        switchTab(name);
        return state.activeTab === name;
      },
    },
    build: {
      run: () => runBuild(),
    },
    templates: {
      list: () => Object.entries(TEMPLATES).map(([id, template]) => ({
        id,
        name: template.name,
        description: template.description,
      })),
      create: (options) => create(options),
    },
    permissions: {
      list: () => PERMISSIONS.map((permission) => ({ ...permission })),
      get: (id) => {
        const permission = PERMISSIONS.find((item) => item.id === id);
        return permission ? { ...permission } : null;
      },
      forAction: (action) => _permissionsForChannel(action),
    },
    packages: {
      inspect: (packagePath) => inspect(packagePath),
      verify: (packagePath, trustStore = []) => verify(packagePath, trustStore),
      listActions: (packagePath) => listActions(packagePath),
    },
    get editor() { return window.CM; },
    get design() { return window.NBPro; },
    node: { fs, path, os, process, require },
  };
  return api;
}

async function _reloadStudioPlugins() {
  await deactivatePlugins(_activeStudioPlugins);
  for (const plugin of _activeStudioPlugins) _disposeStudioPluginResources(plugin.id);
  _activeStudioPlugins = [];
  _studioPluginCommands.clear();
  _studioPluginActivationErrors.clear();
  _refreshStudioPluginCommands();
  if (!_studioPluginManager) return;
  const result = await activatePlugins(_studioPluginManager, _createStudioPluginApi);
  _activeStudioPlugins = result.active;
  _refreshStudioPluginCommands();
  for (const { id, error } of result.errors) {
    _studioPluginActivationErrors.set(id, error);
    _disposeStudioPluginResources(id);
  }
  if ($('modal-plugins') && !$('modal-plugins').classList.contains('hidden')) {
    _renderStudioPlugins();
  }
  if (result.errors.length) {
    const failed = result.errors.map(({ id }) => id).join(', ');
    _setPluginManagerNotice(`${result.errors.length} plugin${result.errors.length === 1 ? '' : 's'} failed to activate: ${failed}. See each plugin card and the developer console for details.`, 'error');
  }
}

async function _initStudioPlugins() {
  _studioPluginManager = createPluginManager({
    rootDirectory: _pluginDataDirectory(),
    studioVersion: STUDIO_VERSION,
  });
  $('btn-manage-plugins')?.addEventListener('click', () => {
    _setPluginManagerView(_studioPluginManagerView);
    _renderStudioPlugins();
    $('modal-plugins')?.classList.remove('hidden');
    if (_studioPluginManagerView === 'marketplace' && !_studioPluginCatalogLoaded) {
      void _loadStudioPluginCatalog();
    }
  });
  $('btn-plugin-marketplace-tab')?.addEventListener('click', () => _setPluginManagerView('marketplace'));
  $('btn-plugin-installed-tab')?.addEventListener('click', () => _setPluginManagerView('installed'));
  $('plugin-search')?.addEventListener('input', _renderStudioPlugins);
  $('btn-plugin-refresh')?.addEventListener('click', () => {
    _studioPluginCatalogRevision += 1;
    _studioPluginCatalogLoaded = false;
    _studioPluginSelectedId = null;
    _studioPluginCatalogDetails.clear();
    _studioPluginCatalogDetailRequests.clear();
    void _loadStudioPluginCatalog();
  });
  $('btn-plugin-reload')?.addEventListener('click', async () => {
    try {
      await _reloadStudioPlugins();
      if (!_studioPluginActivationErrors.size) {
        _setPluginManagerNotice('Enabled plugins reloaded.', 'success');
      }
    } catch (error) {
      _setPluginManagerNotice(`Could not reload plugins: ${error.message}`, 'error');
    }
  });
  $('btn-plugin-install-file')?.addEventListener('click', () => {
    pickFile('.nbplugin,.zip', async (filePath) => {
      try {
        const plugin = await _studioPluginManager.installArchive(filePath);
        _setPluginManagerNotice(`Installed ${plugin.name}. Review its publisher and trust prompt before enabling.`, 'success');
        _setPluginManagerView('installed');
        _renderStudioPlugins();
      } catch (error) {
        _setPluginManagerNotice(`Plugin installation failed: ${error.message}`, 'error');
      }
    });
  });
  $('btn-plugin-install-folder')?.addEventListener('click', () => {
    pickFolder(async (folderPath) => {
      try {
        const plugin = await _studioPluginManager.installFolder(folderPath);
        _setPluginManagerNotice(`Installed ${plugin.name}. Review its publisher and trust prompt before enabling.`, 'success');
        _setPluginManagerView('installed');
        _renderStudioPlugins();
      } catch (error) {
        _setPluginManagerNotice(`Plugin installation failed: ${error.message}`, 'error');
      }
    });
  });
  await _reloadStudioPlugins();
}

function _isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

// Best-effort coercion so non-hex CSS values (rgba(), var() fallbacks, etc.)
// from a captured theme still give the <input type=color> something valid
// to show, without pretending we've parsed them correctly.
function _coerceToHex(v, fallback) {
  if (_isHexColor(v)) return v;
  const probe = document.createElement('div');
  probe.style.color = v;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g);
  document.body.removeChild(probe);
  if (!rgb || rgb.length < 3) return fallback;
  const hex = rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

function _renderCustomThemeSection() {
  const wrap = $('custom-theme-editor');
  if (!wrap) return;

  if (state.theme !== CUSTOM_THEME_ID) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  // First time switching to custom with nothing saved yet: seed from
  // whatever theme was active just before, so the editor doesn't open
  // to a wall of black swatches.
  if (!state.customColors || Object.keys(state.customColors).length === 0) {
    state.customColors = _captureComputedThemeVars();
    saveStorage();
  }

  // Preserve the actions bar (reset/export/import), only rebuild the
  // color-group rows which live before it.
  const actionsBar = wrap.querySelector('.custom-theme-actions');
  wrap.querySelectorAll('.custom-theme-group').forEach((el) => el.remove());

  const groupsFragment = document.createDocumentFragment();
  for (const g of CUSTOM_THEME_VARS) {
    const groupEl = document.createElement('div');
    groupEl.className = 'custom-theme-group';

    const title = document.createElement('div');
    title.className = 'custom-theme-group-title';
    title.textContent = g.group;
    groupEl.appendChild(title);

    for (const v of g.vars) {
      const raw = state.customColors[v.key] || '#000000';
      const hex = _coerceToHex(raw, '#000000');

      const row = document.createElement('div');
      row.className = 'custom-theme-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'custom-theme-row-label';
      labelEl.textContent = v.label;

      const control = document.createElement('span');
      control.className = 'custom-theme-row-control';

      const swatchInput = document.createElement('input');
      swatchInput.type = 'color';
      swatchInput.className = 'custom-theme-swatch-input';
      swatchInput.value = hex;
      swatchInput.dataset.var = v.key;

      const hexInput = document.createElement('input');
      hexInput.type = 'text';
      hexInput.className = 'custom-theme-hex-input';
      hexInput.value = raw;
      hexInput.dataset.var = v.key;
      hexInput.spellcheck = false;

      control.append(swatchInput, hexInput);
      row.append(labelEl, control);
      groupEl.appendChild(row);
    }
    groupsFragment.appendChild(groupEl);
  }
  if (actionsBar) {
    wrap.insertBefore(groupsFragment, actionsBar);
  } else {
    wrap.appendChild(groupsFragment);
  }

  // Live-apply on every change, keep the paired color/text inputs in sync.
  wrap.querySelectorAll('.custom-theme-swatch-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      const key = e.target.dataset.var;
      const val = e.target.value;
      state.customColors[key] = val;
      const twin = wrap.querySelector(`.custom-theme-hex-input[data-var="${key}"]`);
      if (twin) twin.value = val;
      _applyCustomColors(state.customColors);
      saveStorage();
    });
  });

  wrap.querySelectorAll('.custom-theme-hex-input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.var;
      const val = e.target.value.trim();
      state.customColors[key] = val; // accept any valid CSS color, not just hex
      const twin = wrap.querySelector(`.custom-theme-swatch-input[data-var="${key}"]`);
      if (twin) twin.value = _coerceToHex(val, twin.value);
      _applyCustomColors(state.customColors);
      saveStorage();
    });
  });

  const resetBtn = $('btn-custom-theme-reset');
  if (resetBtn) {
    resetBtn.onclick = () => {
      state.customColors = {};
      const revertTo = _isValidTheme(state.lastNonCustomTheme) ? state.lastNonCustomTheme : DEFAULT_THEME;
      setTheme(revertTo); // saves, re-applies, and re-renders both picker lists + this section
    };
  }

  const exportBtn = $('btn-custom-theme-export');
  if (exportBtn) {
    exportBtn.onclick = () => {
      const json = JSON.stringify(state.customColors, null, 2);
      navigator.clipboard?.writeText(json).then(
        () => showToast('Theme copied to clipboard'),
        () => showToast('Could not copy theme')
      );
    };
  }

  const importBtn = $('btn-custom-theme-import');
  if (importBtn) {
    importBtn.onclick = async () => {
      const text = await navigator.clipboard?.readText().catch(() => null);
      if (!text) { showToast('Clipboard is empty or unavailable'); return; }
      try {
        const parsed = JSON.parse(text);
        const known = new Set(CUSTOM_THEME_VARS.flatMap((g) => g.vars.map((v) => v.key)));
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (known.has(k) && typeof v === 'string') clean[k] = v;
        }
        if (Object.keys(clean).length === 0) { showToast('No valid theme values found'); return; }
        state.customColors = { ...state.customColors, ...clean };
        saveStorage();
        _applyCustomColors(state.customColors);
        _renderCustomThemeSection();
        showToast('Theme imported');
      } catch {
        showToast('Clipboard content is not valid theme JSON');
      }
    };
  }
}

function _renderSettingsThemeList(themeList, themeMenu) {
  themeList.replaceChildren();
  for (const t of _themeOptionEntries()) {
    const btn = document.createElement('button');
    btn.className = 'theme-option' + (state.theme === t.id ? ' theme-option--active' : '');
    btn.type = 'button';
    btn.dataset.theme = t.id;

    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = t.swatch;

    const label = document.createElement('span');
    label.className = 'theme-option-label';
    label.textContent = t.label;

    btn.append(swatch, label);
    if (state.theme === t.id) {
      const check = document.createElement('span');
      check.className = 'theme-option-check';
      check.innerHTML = _uiIcon('check');
      btn.appendChild(check);
    }
    btn.addEventListener('click', () => {
      setTheme(t.id);
      themeMenu.classList.add('hidden');
    });
    themeList.appendChild(btn);
  }
}

// New file / new folder. Both validate the proposed name so a value like
// "../escape" or "sub/dir/file" can't be used to write outside the project
// directory. We allow nested paths if the parent already exists, but
// resolve+verify the final path stays under dir before touching the disk.
function _isPathInside(childPath, parentPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (child === parent) return false;
  return child.startsWith(parent + path.sep) || child.startsWith(parent + '/');
}

function _safeJoinName(dir, name) {
  // Strip leading/trailing whitespace, reject empty after trim.
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  // Reject path separators outright for the file/folder create flows -- a
  // "name" containing '/' or '\' is almost always a user mistake and the
  // downstream code wouldn't create intermediate directories anyway.
  if (/[\\/]/.test(trimmed)) return null;
  const candidate = path.join(dir, trimmed);
  if (!_isPathInside(candidate, dir)) return null;
  return candidate;
}

async function promptNewFile(inDir) {
  const dir = inDir ?? state.projectDir;
  if (!dir) return;
  const name = await studioPrompt('Choose a name for the new file.', 'untitled.js', {
    title: 'New file',
    confirmLabel: 'Create file',
  });
  if (!name?.trim()) return;
  const fullPath = _safeJoinName(dir, name);
  if (!fullPath) { showToast('Invalid file name'); return; }
  if (fs.existsSync(fullPath)) { showToast('File already exists'); return; }
  try {
    fs.writeFileSync(fullPath, '', 'utf8');
    populateFileTree(state.projectDir);
    openFileEditor(fullPath);
  } catch (e) {
    showToast('Could not create file: ' + e.message);
  }
}

async function promptNewFolder(inDir) {
  const dir = inDir ?? state.projectDir;
  if (!dir) return;
  const name = await studioPrompt('Choose a name for the new folder.', 'new-folder', {
    title: 'New folder',
    confirmLabel: 'Create folder',
  });
  if (!name?.trim()) return;
  const fullPath = _safeJoinName(dir, name);
  if (!fullPath) { showToast('Invalid folder name'); return; }
  if (fs.existsSync(fullPath)) { showToast('Folder already exists'); return; }
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    populateFileTree(state.projectDir);
    showToast('Folder created');
  } catch (e) {
    showToast('Could not create folder: ' + e.message);
  }
}

// Context menu
function showContextMenu(x, y, targetPath) {
  hideRecentContextMenu(); // only one context menu should ever be visible at a time
  _contextTarget = targetPath;
  const menu = $('context-menu');
  hideEditorContextMenu();

  // Show/hide file-specific actions depending on whether we right-clicked a file/dir
  const hasTarget = !!targetPath;
  const isFile = hasTarget && (() => {
    try { return !fs.statSync(targetPath).isDirectory(); } catch { return false; }
  })();
  $('filectx-rename').style.display = hasTarget ? '' : 'none';
  $('filectx-duplicate').style.display = hasTarget ? '' : 'none';
  $('filectx-compare').style.display = isFile ? '' : 'none';
  $('filectx-sep').style.display = hasTarget ? '' : 'none';
  $('filectx-delete').style.display = hasTarget ? '' : 'none';

  menu.classList.remove('hidden');
  const mw = 190, mh = hasTarget ? (isFile ? 204 : 170) : 68;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideContextMenu() {
  $('context-menu').classList.add('hidden');
  _contextTarget = null;
}

function _getContextTargetDir() {
  if (!_contextTarget) return state.projectDir;
  try {
    return fs.statSync(_contextTarget).isDirectory()
      ? _contextTarget
      : path.dirname(_contextTarget);
  } catch {
    return state.projectDir;
  }
}

async function renameItem(targetPath) {
  if (!targetPath) return;
  const oldName = path.basename(targetPath);
  const newName = (await studioPrompt('Choose a new name.', oldName, {
    title: 'Rename item',
    confirmLabel: 'Rename',
  }))?.trim();
  if (!newName || newName === oldName) return;
  const parentDir = path.dirname(targetPath);
  // Reuse the create-flow validator so a rename can't escape its parent dir.
  const newPath = _safeJoinName(parentDir, newName);
  if (!newPath) { showToast('Invalid name'); return; }
  if (fs.existsSync(newPath)) { showToast('A file with that name already exists'); return; }
  try {
    fs.renameSync(targetPath, newPath);
    const renamedTab = tabs.find((t) => t.filePath === targetPath);
    if (renamedTab) { renamedTab.filePath = newPath; _renderTabs(); }
    populateFileTree(state.projectDir);
    showToast('Renamed to ' + newName);
  } catch (e) {
    showToast('Rename failed: ' + e.message);
  }
}

function duplicateItem(targetPath) {
  if (!targetPath) return;
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  const dir = path.dirname(targetPath);
  let dest = path.join(dir, base + '-copy' + ext);
  let n = 2;
  while (fs.existsSync(dest)) { dest = path.join(dir, `${base}-copy-${n}${ext}`); n++; }
  try {
    fs.copyFileSync(targetPath, dest);
    populateFileTree(state.projectDir);
    showToast('Duplicated as ' + path.basename(dest));
  } catch (e) {
    showToast('Duplicate failed: ' + e.message);
  }
}

async function deleteItem(targetPath) {
  if (!targetPath) return;
  const name = path.basename(targetPath);
  if (!await studioConfirm(`Delete "${name}"? This cannot be undone.`, {
    title: 'Delete item',
    confirmLabel: 'Delete',
    danger: true,
  })) return;
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) fs.rmSync(targetPath, { recursive: true, force: true });
    else fs.unlinkSync(targetPath);
    const deletedIdx = tabs.findIndex((t) => t.filePath === targetPath);
    if (deletedIdx !== -1) {
      tabs[deletedIdx].isDirty = false;  // suppress dirty confirm
      await _closeTab(deletedIdx);
    }
    populateFileTree(state.projectDir);
    showToast('Deleted ' + name);
  } catch (e) {
    showToast('Delete failed: ' + e.message);
  }
}

// Size formatting. Human-readable byte size. Uses binary (1024) units because
// that's what the original showed -- switching to decimal (1000) would
// change the displayed values. We keep toFixed(1) (rather than
// Intl.NumberFormat) so the output matches the original byte-for-byte:
// "1.0 KB" not "1 KB".
function _formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Build
function appendLog(type, msg) {
  const log = $('build-log');
  if (!log) return;
  const empty = log.querySelector('.build-log-empty');
  if (empty) empty.remove();

  const tags = { info: '\u203a', warn: '!', success: '\u2713', error: '\u2717' };
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;

  const tag = document.createElement('span');
  tag.className = 'log-tag';
  tag.textContent = tags[type] || '\u203a';

  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = msg; // textContent -- esbuild errors can contain user code

  line.append(tag, msgEl);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  const log = $('build-log');
  log.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'build-log-empty';
  empty.textContent = 'Build output will appear here';
  log.appendChild(empty);
}

// Syntax check
const _SYNTAX_LOADER_MAP = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js',
};

function _setSyntaxStatus(type, text) {
  const el = $('sb-syntax');
  const sep = $('sb-syntax-sep');
  if (!el) return;
  if (!text) {
    el.style.display = 'none';
    if (sep) sep.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (sep) sep.style.display = '';
  const icon = type === 'ok' ? 'check' : type === 'warn' ? 'alert' : 'close';
  el.innerHTML = `${_uiIcon(icon)}<span>${_escHtml(text)}</span>`;
  const statusClass = type === 'warn' ? 'warn' : type;
  el.className = `status-bar-item status-bar-item--clickable status-bar-item--${statusClass}`;
}

function _syntaxCurrentContent(filePath) {
  const resolvedPath = path.resolve(filePath);
  const openTab = tabs.find((tab) => path.resolve(tab.filePath) === resolvedPath);
  if (openTab) {
    if (openTab === _getActiveTab() && window.CM) return window.CM.getValue();
    if (openTab.liveContent !== undefined) return openTab.liveContent;
    return openTab.originalContent;
  }
  return fs.readFileSync(resolvedPath, 'utf8');
}

function _htmlStyles(htmlText, htmlPath) {
  const styles = [];
  const linkedPaths = new Set();
  const doc = parse5.parse(htmlText, { sourceCodeLocationInfo: true });

  function visit(node) {
    if (node.tagName === 'style') {
      const location = node.sourceCodeLocation;
      const inlineCss = location?.startTag && location?.endTag
        ? htmlText.slice(location.startTag.endOffset, location.endTag.startOffset)
        : (node.childNodes || []).map((child) => child.value || '').join('');
      if (inlineCss.trim()) {
        styles.push({
          filePath: `${htmlPath} (inline style)`,
          content: inlineCss,
          editorOffset: location?.startTag?.endOffset,
          editorContent: htmlText,
        });
      }
    } else if (node.tagName === 'link') {
      const attrs = new Map((node.attrs || []).map(({ name, value }) => [name.toLowerCase(), value]));
      const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
      const href = attrs.get('href');
      if (rel.includes('stylesheet') && href && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
        const pathPart = href.split(/[?#]/, 1)[0];
        let decodedPath;
        try {
          decodedPath = decodeURIComponent(pathPart);
        } catch {
          decodedPath = pathPart;
        }
        const root = path.resolve(state.projectDir || path.dirname(htmlPath));
        const basePath = decodedPath.startsWith('/') ? root : path.dirname(htmlPath);
        const cssPath = path.resolve(basePath, decodedPath.replace(/^[/\\]+/, ''));
        const relative = path.relative(root, cssPath);
        const outsideProject = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
        if (!outsideProject && path.extname(cssPath).toLowerCase() === '.css') linkedPaths.add(cssPath);
      }
    }

    for (const child of node.childNodes || []) visit(child);
  }

  visit(doc);
  for (const cssPath of linkedPaths) {
    if (fs.existsSync(cssPath) && fs.statSync(cssPath).isFile()) {
      styles.push({ filePath: cssPath, content: _syntaxCurrentContent(cssPath) });
    } else {
      styles.push({ filePath: cssPath, content: null });
    }
  }
  return styles;
}

function _syntaxPositionAtOffset(content, offset) {
  const end = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < end; i++) {
    if (content[i] === '\r') {
      if (content[i + 1] === '\n' && i + 1 < end) i++;
      line++;
      column = 1;
    } else if (content[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function _cssSyntaxDiagnostics(content, fileName, { editor = true, editorOffset, editorContent } = {}) {
  try {
    const result = cssTreeValidator.validateString(content, fileName);
    const errors = result[fileName] || [];
    if (!errors.length) return [];

    return errors.map((error) => {
      const offset = typeof error.offset === 'number' ? error.offset : 0;
      const position = editorOffset !== undefined && editorContent
        ? _syntaxPositionAtOffset(editorContent, editorOffset + offset)
        : _syntaxPositionAtOffset(content, offset);

      return {
        severity: 'error',
        fileName,
        line: position.line,
        column: position.column,
        message: error.message || error.rawMessage || 'Invalid CSS',
        editor,
      };
    });
  } catch (error) {
    return [{
      severity: 'error',
      fileName,
      line: 1,
      column: 1,
      message: error.message || 'Invalid CSS',
      editor,
    }];
  }
}

function _showSyntaxDiagnostics(fileName, diagnostics) {
  window.CM?.setSyntaxDiagnostics(diagnostics);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== 'error');
  if (!diagnostics.length) {
    _setSyntaxStatus('ok', 'No errors');
    appendLog('success', `${fileName} -- no syntax errors`);
    return;
  }

  const first = errors[0] || diagnostics[0];
  const firstLocation = first.line ? `${first.line}:${first.column || 1}` : '?';
  const status = errors.length ? 'error' : 'warn';
  const label = errors.length
    ? `${errors.length} error${errors.length === 1 ? '' : 's'} -- Ln ${firstLocation}`
    : `${warnings.length} warning${warnings.length === 1 ? '' : 's'} -- Ln ${firstLocation}`;
  _setSyntaxStatus(status, label);

  for (const diagnostic of diagnostics) {
    const location = diagnostic.line ? `${diagnostic.line}:${diagnostic.column || 1}` : '?';
    const rule = diagnostic.rule ? ` [${diagnostic.rule}]` : '';
    appendLog(diagnostic.severity === 'error' ? 'error' : 'warn',
      `${diagnostic.fileName || fileName}:${location} -- ${diagnostic.message}${rule}`);
  }
}

async function checkSyntax() {
  const tab = _getActiveTab();
  if (!tab) { showToast('No file open to check'); return; }

  const ext = path.extname(tab.filePath).toLowerCase();
  const loader = _SYNTAX_LOADER_MAP[ext];
  const supported = loader || ['.json', '.novaapp', '.css', '.html', '.htm'].includes(ext);
  if (!supported) {
    showToast(`Syntax check not supported for ${ext || 'this file type'}`);
    return;
  }

  const content = window.CM ? window.CM.getValue() : tab.originalContent;
  const fileName = path.basename(tab.filePath);

  try {
    const diagnostics = [];
    if (loader) {
      const esbuild = require('esbuild');
      try {
        await esbuild.transform(content, { loader, sourcefile: fileName, logLevel: 'silent' });
      } catch (error) {
        for (const item of error.errors || [{ text: error.message }]) {
          diagnostics.push({
            severity: 'error',
            fileName,
            line: item.location?.line,
            column: item.location ? item.location.column + 1 : undefined,
            message: item.text,
            editor: true,
          });
        }
      }
    } else if (ext === '.json' || ext === '.novaapp') {
      const { validate, lineColumn } = require('@jsonlint/core');
      const result = validate(content, { mode: 'strict' });
      const esbuild = require('esbuild');
      const parseErrors = [];
      try {
        await esbuild.transform(content, { loader: 'json', sourcefile: fileName, logLevel: 'silent' });
      } catch (error) {
        for (const item of error.errors || [{ text: error.message }]) {
          parseErrors.push({
            severity: 'error',
            fileName,
            line: item.location?.line,
            column: item.location ? item.location.column + 1 : undefined,
            message: item.text,
            editor: true,
          });
        }
      }
      if (parseErrors.length) diagnostics.push(...parseErrors);
      else for (const item of result.diagnostics) {
        const position = lineColumn(content, item.start);
        diagnostics.push({
          severity: item.severity === 'error' ? 'error' : 'warning',
          fileName,
          line: position.line,
          column: position.column,
          message: item.hint ? `${item.message} (${item.hint})` : item.message,
          editor: true,
        });
      }
    } else if (ext === '.css') {
      diagnostics.push(..._cssSyntaxDiagnostics(content, fileName));
    } else {
      const { HTMLHint } = require('htmlhint');
      for (const item of HTMLHint.verify(content)) {
        diagnostics.push({
          severity: item.type === 'error' ? 'error' : 'warning',
          fileName,
          line: item.line,
          column: item.col,
          message: item.message,
          rule: item.rule?.id,
          editor: true,
        });
      }

      const cssFiles = _htmlStyles(content, tab.filePath);
      for (const cssFile of cssFiles) {
        if (cssFile.content === null) {
          diagnostics.push({
            severity: 'error',
            fileName: path.basename(cssFile.filePath),
            message: 'Linked stylesheet was not found.',
          });
          continue;
        }
        diagnostics.push(..._cssSyntaxDiagnostics(cssFile.content, path.basename(cssFile.filePath), {
          editor: cssFile.editorOffset !== undefined,
          editorOffset: cssFile.editorOffset,
          editorContent: cssFile.editorContent,
        }));
      }
    }
    _showSyntaxDiagnostics(fileName, diagnostics);
  } catch (error) {
    _setSyntaxStatus('error', 'Syntax check failed');
    appendLog('error', `${fileName} -- syntax checker failed: ${error.message}`);
  }
}

let _buildInterval = null;

function _readFileSize(filePath) {
  try {
    const b = fs.statSync(filePath).size;
    return b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B';
  } catch {
    return '';
  }
}

function _readProjectVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(state.projectDir, 'manifest.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

async function runBuild() {
  if (state.building) return { success: false, error: 'A build is already in progress.' };
  if (!state.projectDir) return { success: false, error: 'No project is open.' };
  const outDir = _getBuildOutDir();
  if ($('build-clean')?.checked && _buildOutputContainsProject(outDir)) {
    const message = 'Refusing to clean this output directory because it contains the project folder.';
    clearLog();
    appendLog('error', message);
    showToast(message);
    return { success: false, error: message };
  }
  const btn = $('btn-build');
  const fill = $('build-btn-fill');
  const label = btn.querySelector('.build-btn-label');

  if (!await saveManifest()) return { success: false, error: 'Could not save the project manifest.' };
  state.building = true;
  _emitStudioPluginEvent('build:start', { projectDirectory: state.projectDir, outputDirectory: outDir });
  clearLog();

  btn.disabled = false;
  btn.className = 'build-btn building';
  fill.style.width = '0%';
  label.textContent = 'Building...';

  let progress = 0;
  _buildInterval = setInterval(() => {
    progress = Math.min(progress + (Math.random() * 3), 85);
    fill.style.width = progress + '%';
  }, 80);

  if ($('build-clean').checked && fs.existsSync(outDir)) {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      appendLog('info', `Cleaned output directory: ${outDir}`);
    } catch (err) {
      appendLog('warn', `Could not clean output directory: ${err.message}`);
    }
  }

  // try/finally guarantees state.building is reset, the progress interval is
  // cleared, and the button is re-enabled -- even if build() throws or the
  // promise rejects. The original code only handled the success/failure
  // branches and would leak the interval on throw.
  let result;
  try {
    const integrityMethod = _selectedIntegrityMethod;
    const signingMethod = _selectedSigningMethod;
    // Build only signs if we actually have a usable key -- 'none' and
    // 'custom'-without-input both mean "don't sign here." The Sign tab's
    // "Self-Sign Last Build" step remains the place to apply/replace a
    // signature after the fact; this just stops silently ignoring the
    // dropdown selection when a real key IS available at build time.
    let signingKey = null;
    if (signingMethod !== 'none') {
      if (signingMethod === 'custom') {
        signingKey = ($('sign-dev-custom-key')?.value || '').trim() || null;
      } else {
        const privRaw = ($('sign-dev-privkey')?.value || '').trim();
        if (privRaw) {
          try { signingKey = JSON.parse(privRaw); } catch { signingKey = null; }
        }
      }
    }
    result = await build({
      projectDir: state.projectDir,
      outDir,
      // Swaps the button to the 'compiling' visual state the moment
      // builder.js logs that it's found C/C++ sources, and back to the
      // plain 'building' state once compilation is past (any subsequent
      // "Compiled N ... to WebAssembly" success line, or any log at all
      // once the compile-detection log has already fired -- bundling/
      // signing/integrity steps that follow aren't compile-specific, so
      // there's no reason to keep the compiling color lit for those).
      // This only ever reflects what builder.js itself reports -- it does
      // not re-run detection or duplicate the emcc lookup, so it can't
      // disagree with the actual compile outcome.
      onLog: (type, msg) => {
        if (msg.startsWith('Found') && msg.includes('C/C++ source file')) {
          btn.className = 'build-btn compiling';
          label.textContent = 'Compiling C++...';
        } else if (btn.className === 'build-btn compiling') {
          btn.className = 'build-btn building';
          label.textContent = 'Building...';
        }
        appendLog(type, msg);
        _emitStudioPluginEvent('build:log', {
          projectDirectory: state.projectDir,
          type,
          message: msg,
        });
      },
      integrityMethod,
      signingMethod: signingMethod === 'none' ? undefined : signingMethod,
      signingKey,
    });
  } catch (err) {
    result = { success: false, error: err };
    appendLog('error', `Build threw: ${err.message}`);
  } finally {
    clearInterval(_buildInterval);
    _buildInterval = null;
    state.building = false;
  }

  if (result.success) {
    _emitStudioPluginEvent('build:complete', {
      projectDirectory: state.projectDir,
      outputFile: result.outFile || null,
    });
    fill.style.width = '100%';
    btn.className = 'build-btn success';
    label.innerHTML = `${_uiIcon('check')} Build Complete`;
    _lastBuildOutFile = result.outFile || null;
    _updateSignActionAvailability();
    _pushBuildEntry({
      ts: Date.now(),
      success: true,
      name: state.projectName,
      version: _readProjectVersion(),
      outFile: result.outFile,
      size: result.outFile ? _readFileSize(result.outFile) : '',
    });
    setTimeout(() => {
      btn.className = 'build-btn';
      fill.style.width = '0%';
      label.textContent = 'Build Package';
      btn.disabled = false;
    }, 3000);
    return { success: true, outputFile: result.outFile || null };
  } else {
    _emitStudioPluginEvent('build:error', {
      projectDirectory: state.projectDir,
      error: result.error?.message || 'Build failed',
    });
    fill.style.width = '0%';
    btn.className = 'build-btn error';
    label.innerHTML = `${_uiIcon('close')} Build Failed`;
    _pushBuildEntry({
      ts: Date.now(),
      success: false,
      name: state.projectName,
      version: _readProjectVersion(),
    });
    setTimeout(() => {
      btn.className = 'build-btn';
      label.textContent = 'Build Package';
      btn.disabled = false;
    }, 3000);
    return { success: false, error: result.error?.message || 'Build failed' };
  }
}

// Build history
const BUILD_HISTORY_KEY = 'novapack_build_history';
const BUILD_HISTORY_MAX = 30;

function _loadBuildHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUILD_HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _saveBuildHistory(history) {
  try {
    localStorage.setItem(BUILD_HISTORY_KEY, JSON.stringify(history));
  } catch { /* QuotaExceeded -- best-effort */ }
}

function _pushBuildEntry(entry) {
  const history = _loadBuildHistory();
  history.unshift(entry);
  if (history.length > BUILD_HISTORY_MAX) history.length = BUILD_HISTORY_MAX;
  _saveBuildHistory(history);
  _renderBuildHistory();
}

function _renderBuildHistory() {
  const list = $('build-history-list');
  if (!list) return;
  const history = _loadBuildHistory();
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'build-history-empty';
    empty.textContent = 'No builds yet';
    list.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  history.forEach((e, i) => {
    const ago = _timeAgo(e.ts);
    const cls = e.success ? 'build-history-item--ok' : 'build-history-item--fail';

    const item = document.createElement('div');
    item.className = `build-history-item ${cls}`;
    item.dataset.index = i;
    item.title = e.outFile || '';

    // Build the inner DOM with textContent to avoid any chance of injecting
    // build-name / version strings as HTML.
    const iconEl = document.createElement('span');
    iconEl.className = 'bh-icon';
    iconEl.innerHTML = _uiIcon(e.success ? 'check' : 'close');

    const info = document.createElement('div');
    info.className = 'bh-info';
    const name = document.createElement('span');
    name.className = 'bh-name';
    name.textContent = `${e.name || 'Unknown'} v${e.version || '?'}`;
    const meta = document.createElement('span');
    meta.className = 'bh-meta';
    meta.textContent = `${ago}${e.size ? ' \u00b7 ' + e.size : ''}`;
    info.append(name, meta);

    const rerun = document.createElement('span');
    rerun.className = 'bh-rerun icon-btn';
    rerun.dataset.index = i;
    rerun.title = 'Re-run build';
    rerun.setAttribute('aria-label', 'Re-run build');
    rerun.innerHTML = _uiIcon('play');
    rerun.addEventListener('click', (ev) => {
      ev.stopPropagation();
      runBuild();
    });

    item.append(iconEl, info, rerun);
    frag.appendChild(item);
  });
  list.replaceChildren(frag);
}

function _timeAgo(ts) {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return 'just now'; // clock skew guard
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

let _lastBuildOutFile = null;
let _selectedSigningMethod = 'none';
let _selectedIntegrityMethod = 'none';

// index.html's inline <script> (the method/integrity <select> handlers)
// calls these to update the actual bindings above. Previously it wrote to
// window._selectedSigningMethod / window._selectedIntegrityMethod, which
// were separate `let` variables shadowed under the same name -- since this
// file loads as a plain <script src> (not a module), top-level `let`
// never attaches to `window`, so the dropdown was updating a variable
// nothing else read, and every keypair/sign action silently stayed on
// whatever these `let`s were initialized to (ed25519 / blake3).
window.setSelectedSigningMethod = (method) => { _selectedSigningMethod = method; _updateSignActionAvailability(); };
window.setSelectedIntegrityMethod = (method) => { _selectedIntegrityMethod = method; _updateBuildSummary(); };

async function _generateDevKeypair(method = _selectedSigningMethod) {
  const btn = $('btn-sign-generate-key');
  const privField = $('sign-dev-privkey');
  const pubOut = $('sign-keypair-out');
  const pubField = $('sign-dev-pubkey');
  if (!btn) return;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Generating\u2026';
  try {
    const result = await AppPackage.generateSigningKeyPair(method);
    if (!result?.publicJwk || !result?.privateJwk) {
      throw new Error('generateSigningKeyPair() returned an incomplete keypair.');
    }
    privField.value = JSON.stringify(result.privateJwk);
    pubField.value = JSON.stringify(result.publicJwk);
    pubOut.classList.remove('hidden');
    _updateSignActionAvailability();
  } catch (err) {
    console.error('Keypair generation failed:', err);
    appendLog?.('error', `Keypair generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function _updateSignActionAvailability() {
  const selfSignBtn = $('btn-sign-selfsign');
  const hasBuild = !!_lastBuildOutFile && fs.existsSync(_lastBuildOutFile);
  const method = _selectedSigningMethod;
  let hasKey = false;
  if (method === 'none') {
    // Nothing to key-check -- "None" just means write the build back out
    // unsigned (and strip any signature a previous method may have added).
    hasKey = true;
  } else if (method === 'custom') {
    const customArea = $('sign-dev-custom-key');
    hasKey = !!(customArea?.value || '').trim();
  } else {
    const privField = $('sign-dev-privkey');
    hasKey = !!(privField?.value || '').trim();
  }
  if (selfSignBtn) {
    selfSignBtn.disabled = !(hasBuild && hasKey);
    selfSignBtn.textContent = method === 'none' ? 'Apply (Leave Unsigned)' : 'Self-Sign Last Build';
  }
  _updateBuildSummary();
  _updateSignStatusStrip();
}

// Read-only reflection of what a build right now would actually produce --
// same signing-method/key-presence logic as _updateSignActionAvailability
// above (kept in one place so the two can't drift apart), plus the
// integrity method, resolved output path, and (new) whether this project
// has C/C++ sources that'll need compiling. Purely informational: this
// never writes state, it only mirrors what runBuild() will read.
function _updateBuildSummary() {
  const signingEl = $('build-summary-signing');
  const integrityEl = $('build-summary-integrity');
  const outpathEl = $('build-summary-outpath');
  if (!signingEl || !integrityEl || !outpathEl) return;

  const method = _selectedSigningMethod;
  let signingText, signingCls;
  if (method === 'none') {
    signingText = 'Unsigned';
    signingCls = 'build-summary-value--warn';
  } else {
    let hasKey = false;
    if (method === 'custom') {
      hasKey = !!($('sign-dev-custom-key')?.value || '').trim();
    } else {
      hasKey = !!($('sign-dev-privkey')?.value || '').trim();
    }
    if (hasKey) {
      signingText = `${method} (ready)`;
      signingCls = 'build-summary-value--ok';
    } else {
      signingText = `${method} -- no key yet, will build unsigned`;
      signingCls = 'build-summary-value--warn';
    }
  }
  signingEl.textContent = signingText;
  signingEl.className = 'build-summary-value ' + signingCls;

  integrityEl.textContent = _selectedIntegrityMethod === 'none' ? 'None' : _selectedIntegrityMethod;
  integrityEl.className = 'build-summary-value' + (_selectedIntegrityMethod === 'none' ? ' build-summary-value--warn' : '');

  outpathEl.textContent = _getBuildOutDir();

  // C++/native detection -- purely a resting-state visual cue, not a
  // build-blocking check (build() itself still does the real detection +
  // emcc lookup; a stale/missing detectCppSources here would just mean the
  // button shows the wrong color for a moment, never a wrong build result).
  // btn-build's default markup/CSS covers the plain 'build-btn' class; the
  // 'build-btn--native' class is additive and only changes the resting
  // (non-building, non-success, non-error) color, so it composes fine with
  // the 'building'/'success'/'error' classes runBuild() swaps in later --
  // see the style.css entry that scopes '--native' to
  // ':not(.building):not(.success):not(.error)'.
  const btn = $('btn-build');
  if (btn && state.projectDir) {
    let hasCpp = false;
    try {
      hasCpp = detectCppSources(state.projectDir).length > 0;
    } catch {
      hasCpp = false; // detection failing shouldn't block rendering the summary
    }
    btn.classList.toggle('build-btn--native', hasCpp);
  }
}

function _getBuildOutDir() {
  return ($('build-outdir')?.value || '').trim()
    || (state.projectDir ? path.join(state.projectDir, 'dist') : './dist');
}

const BUILD_PROFILES_KEY = 'novapack_build_profiles';

function _readBuildProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUILD_PROFILES_KEY) || '[]');
    if (!Array.isArray(parsed)) throw new Error('Stored build profiles are not a list.');
    return parsed.filter((profile) => profile && typeof profile.name === 'string'
      && typeof profile.outDir === 'string'
      && typeof profile.clean === 'boolean'
      && typeof profile.signing === 'string'
      && typeof profile.integrity === 'string');
  } catch (error) {
    console.error('Could not read build profiles:', error);
    showToast('Could not read saved build profiles');
    return [];
  }
}

function _renderBuildProfiles(selectedName = $('build-profile-select')?.value || '') {
  const select = $('build-profile-select');
  if (!select) return;
  const profiles = _readBuildProfiles().filter((profile) => profile.projectDir === state.projectDir);
  select.replaceChildren(new Option('Current settings', ''));
  for (const profile of profiles) select.add(new Option(profile.name, profile.name));
  select.value = profiles.some((profile) => profile.name === selectedName) ? selectedName : '';
  $('btn-build-profile-delete').disabled = !select.value;
}

async function _saveBuildProfile() {
  const name = (await studioPrompt('Choose a name for this build profile.', '', {
    title: 'Save build profile',
    confirmLabel: 'Save profile',
    maxLength: 60,
  }))?.trim();
  if (!name) return;
  if (name.length > 60) {
    showToast('Build profile names must be 60 characters or fewer');
    return;
  }
  const profiles = _readBuildProfiles().filter((profile) =>
    profile.name !== name || profile.projectDir !== state.projectDir);
  profiles.push({
    name,
    projectDir: state.projectDir,
    outDir: $('build-outdir').value.trim(),
    clean: $('build-clean').checked,
    signing: _selectedSigningMethod,
    integrity: _selectedIntegrityMethod,
  });
  try {
    localStorage.setItem(BUILD_PROFILES_KEY, JSON.stringify(profiles));
    _renderBuildProfiles(name);
    showToast(`Saved build profile “${name}”`);
  } catch (error) {
    console.error('Could not save build profile:', error);
    showToast(`Could not save build profile: ${error.message}`);
  }
}

function _applyBuildProfile(name) {
  const profile = _readBuildProfiles().find((item) => item.name === name && item.projectDir === state.projectDir);
  if (!profile) return;
  $('build-outdir').value = profile.outDir;
  $('build-clean').checked = profile.clean;
  const signing = $('sign-method-select');
  const integrity = $('sign-integrity-select');
  if (signing && [...signing.options].some((option) => option.value === profile.signing)) {
    if (window.applyBuildSigningMethod) window.applyBuildSigningMethod(profile.signing);
    else {
      signing.value = profile.signing;
      window.setSelectedSigningMethod?.(profile.signing);
    }
  }
  if (integrity && [...integrity.options].some((option) => option.value === profile.integrity)) {
    integrity.value = profile.integrity;
    window.setSelectedIntegrityMethod?.(profile.integrity);
  }
  _updateBuildSummary();
  _renderBuildContentsPreview();
}

function _previewList(title, rows, reasonKey = null, maxRows = 250) {
  const details = document.createElement('details');
  details.className = 'build-contents-group';
  const summary = document.createElement('summary');
  summary.textContent = `${title} (${rows.length})`;
  details.appendChild(summary);
  if (rows.length) {
    const list = document.createElement('ul');
    for (const row of rows.slice(0, maxRows)) {
      const item = document.createElement('li');
      const filename = typeof row === 'string' ? row : row.path;
      item.textContent = reasonKey && row[reasonKey] ? `${filename} — ${row[reasonKey]}` : filename;
      list.appendChild(item);
    }
    if (rows.length > maxRows) {
      const more = document.createElement('li');
      more.textContent = `…and ${rows.length - maxRows} more`;
      list.appendChild(more);
    }
    details.appendChild(list);
  }
  return details;
}

function _renderBuildContentsPreview(expandFiles = false) {
  const host = $('build-contents-preview-list');
  const summary = $('build-contents-summary');
  if (!host || !summary) return;
  if (!state.projectDir) {
    host.textContent = 'Open a project to preview its package contents.';
    summary.textContent = 'No project loaded';
    return;
  }
  try {
    const preview = previewProjectFiles(state.projectDir);
    const manifest = _readManifest(state.projectDir);
    const entry = manifest?.entry || 'index.html';
    const entryPath = path.resolve(state.projectDir, entry);
    const relativeEntry = path.relative(state.projectDir, entryPath);
    const entryInsideProject = relativeEntry !== '..' && !relativeEntry.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeEntry);
    const entryExists = entryInsideProject && fs.existsSync(entryPath);
    host.replaceChildren();
    if (!manifest || manifest._error) {
      const warning = document.createElement('div');
      warning.className = 'build-preview-warning';
      warning.textContent = manifest?._error
        ? `Manifest could not be read: ${manifest._error}`
        : 'No manifest.json or novaapp.json was found.';
      host.appendChild(warning);
    }
    if (!entryExists) {
      const warning = document.createElement('div');
      warning.className = 'build-preview-warning';
      warning.textContent = entryInsideProject
        ? `Entry file “${entry}” is missing. Build will fail until it exists.`
        : 'The entry file must be inside the project folder.';
      host.appendChild(warning);
    }
    const manifestNote = document.createElement('div');
    manifestNote.className = 'build-preview-manifest';
    manifestNote.textContent = 'manifest.json / novaapp.json is packaged as app metadata, not as a regular project file.';
    const included = _previewList('Included project files', preview.included);
    const excluded = _previewList('Excluded files and rules', preview.excluded, 'reason');
    const generated = _previewList('Generated by bundled Emscripten', preview.generated, 'reason');
    included.open = expandFiles;
    host.append(manifestNote, included, excluded, generated);
    summary.textContent = `${preview.included.length} files · ${preview.excluded.length} excluded · ${preview.generated.length} generated`;
  } catch (error) {
    console.error('Could not preview package contents:', error);
    host.textContent = `Could not preview package contents: ${error.message}`;
    summary.textContent = 'Preview failed';
  }
}

function _buildOutputContainsProject(outDir) {
  const relativeProjectPath = path.relative(path.resolve(outDir), path.resolve(state.projectDir));
  return relativeProjectPath === ''
    || (relativeProjectPath !== '..'
      && !relativeProjectPath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeProjectPath));
}

async function _copyBuildOutputPath() {
  try {
    await navigator.clipboard.writeText(_getBuildOutDir());
    showToast('Output path copied');
  } catch (error) {
    showToast(`Could not copy output path: ${error.message}`);
  }
}

function _openBuildOutputFolder() {
  const outDir = _getBuildOutDir();
  if (!fs.existsSync(outDir)) {
    showToast('Output folder does not exist yet. Build the package first.');
    return;
  }
  try {
    if (typeof nw !== 'undefined' && nw.Shell?.openItem) {
      nw.Shell.openItem(outDir);
    } else if (typeof nw !== 'undefined' && nw.Shell?.showItemInFolder) {
      nw.Shell.showItemInFolder(outDir);
    } else {
      showToast('Opening folders is not available in this environment');
    }
  } catch (error) {
    showToast(`Could not open output folder: ${error.message}`);
  }
}

// Status-at-a-glance strip on the Sign tab -- same signing/integrity logic
// as _updateBuildSummary (kept separate since the two cards show different
// things: Build shows "what will this build produce", Sign shows "what's
// my current signing setup + do I have a build to act on"), reusing the
// exact same hasKey check so they can't disagree.
function _updateSignStatusStrip() {
  const signingEl = $('sign-status-signing');
  const integrityEl = $('sign-status-integrity');
  const buildEl = $('sign-status-build');
  if (!signingEl || !integrityEl || !buildEl) return;

  const method = _selectedSigningMethod;
  if (method === 'none') {
    signingEl.textContent = 'Unsigned';
    signingEl.className = 'sign-status-value sign-status-value--warn';
  } else {
    let hasKey = false;
    if (method === 'custom') {
      hasKey = !!($('sign-dev-custom-key')?.value || '').trim();
    } else {
      hasKey = !!($('sign-dev-privkey')?.value || '').trim();
    }
    signingEl.textContent = hasKey ? `${method} (ready)` : `${method} -- no key yet`;
    signingEl.className = 'sign-status-value ' + (hasKey ? 'sign-status-value--ok' : 'sign-status-value--warn');
  }

  integrityEl.textContent = _selectedIntegrityMethod === 'none' ? 'None' : _selectedIntegrityMethod;
  integrityEl.className = 'sign-status-value' + (_selectedIntegrityMethod === 'none' ? ' sign-status-value--warn' : '');

  const hasBuild = !!_lastBuildOutFile && fs.existsSync(_lastBuildOutFile);
  buildEl.textContent = hasBuild ? path.basename(_lastBuildOutFile) : 'No build yet';
  buildEl.className = 'sign-status-value' + (hasBuild ? '' : ' sign-status-value--warn');
}

async function _runSelfSign() {
  const btn = $('btn-sign-selfsign');
  if (!btn || btn.disabled) return;
  const method = _selectedSigningMethod;
  const integrityMethod = _selectedIntegrityMethod;
  let privateKey = null;

  if (method === 'none') {
    // No key needed -- this path intentionally does not sign.
  } else if (method === 'custom') {
    privateKey = ($('sign-dev-custom-key')?.value || '').trim();
    if (!privateKey) {
      appendLog('error', 'Custom mode requires key/payload in the textarea below.');
      return;
    }
  } else {
    const privRaw = ($('sign-dev-privkey')?.value || '').trim();
    try {
      privateKey = JSON.parse(privRaw);
    } catch {
      appendLog('error', 'Dev private key must be valid JWK JSON. Click "Generate New Keypair" if you don\'t have one.');
      return;
    }
  }

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = method === 'none' ? 'Applying\u2026' : 'Signing\u2026';
  try {
    const loadPkg = AppPackage.loadPackage
      ? AppPackage.loadPackage(_lastBuildOutFile)
      : JSON.parse(fs.readFileSync(_lastBuildOutFile, 'utf8'));
    const pkg = { ...loadPkg };

    if (method === 'none') {
      // Explicitly unsigned: strip any signature a previous method may
      // have left on this build file rather than leaving it stale. This
      // is the same "unsigned" state runBuild() already produces by
      // default -- Self-Sign with None just re-asserts it after the fact.
      delete pkg.signature;
      delete pkg.signer;
      pkg.signing = { method: 'none' };
    } else {
      pkg.signing = { method };
      pkg.signature = await AppPackage.signPackage(pkg, privateKey, { method });
      pkg.signer = method === 'custom' ? 'custom' : `local-dev-${method}`;
    }

    if (integrityMethod !== 'none') {
      pkg.integrity = await AppPackage.computeIntegrity(pkg, integrityMethod);
    } else {
      delete pkg.integrity;
    }
    fs.writeFileSync(_lastBuildOutFile, JSON.stringify(pkg, null, 2));
    const intLabel = integrityMethod !== 'none' ? ` + ${integrityMethod} integrity` : '';
    if (method === 'none') {
      appendLog('success', `${path.basename(_lastBuildOutFile)} left unsigned${intLabel}. NBOSP will show this as "Not Signed" -- publish only if that's intended.`);
    } else {
      appendLog('success', `Self-signed ${path.basename(_lastBuildOutFile)} with ${method}${intLabel}. This will still show as Unverified in NBOSP unless the public key is in the trust store.`);
    }
  } catch (err) {
    appendLog('error', `${method === 'none' ? 'Applying unsigned state' : 'Self-signing'} failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
    _updateSignActionAvailability();
  }
}

// Workspaces
const WORKSPACES_KEY = 'novapack_workspaces';
let _workspaceQuery = '';

function _loadWorkspaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || '[]');
    if (!Array.isArray(parsed)) throw new TypeError('Saved workspace data is not a list');
    return parsed.filter((item) => item && typeof item === 'object').map((item, index) => ({
      ...item,
      id: item.id ?? `legacy-${index}-${item.ts ?? 0}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : 'Untitled workspace',
      projectDir: typeof item.projectDir === 'string' ? item.projectDir : '',
      activeTab: typeof item.activeTab === 'string' ? item.activeTab : 'editor',
      activeFile: typeof item.activeFile === 'string' ? item.activeFile : '',
      openFiles: Array.isArray(item.openFiles) ? item.openFiles.filter((file) => typeof file === 'string') : [],
      ts: Number.isFinite(item.ts) ? item.ts : 0,
    }));
  } catch (err) {
    console.error('Could not read saved workspaces:', err);
    return [];
  }
}

function _saveWorkspaces(ws) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(ws));
    return true;
  } catch (err) {
    console.error('Could not save workspaces:', err);
    showToast('Could not save workspaces');
    return false;
  }
}

function openWorkspaces() {
  const projectLabel = $('workspace-current-project');
  const saveHint = $('workspace-save-hint');
  const nameInput = $('workspace-name-input');
  const saveButton = $('btn-workspace-save');
  const hasProject = !!state.projectDir;
  const openFileCount = hasProject ? _workspaceFilesForProject(state.projectDir).length : 0;
  if (projectLabel) projectLabel.textContent = hasProject ? state.projectName || path.basename(state.projectDir) : 'No project open';
  if (saveHint) saveHint.textContent = hasProject
    ? `${openFileCount} open file${openFileCount === 1 ? '' : 's'} · editor and current Studio panel`
    : 'Open a project to save its current setup.';
  if (nameInput) {
    nameInput.value = hasProject ? `${state.projectName || path.basename(state.projectDir)} Workspace` : '';
    nameInput.disabled = !hasProject;
  }
  if (saveButton) saveButton.disabled = !hasProject;
  _workspaceQuery = '';
  const search = $('workspace-search');
  if (search) search.value = '';
  _renderWorkspaceList();
  $('modal-workspace')?.classList.remove('hidden');
}

function closeWorkspaces() {
  $('modal-workspace')?.classList.add('hidden');
}

function _workspaceFilesForProject(projectDir) {
  const files = [];
  for (const tab of tabs) {
    if (!_workspacePathIsInside(tab.filePath, projectDir) || files.includes(tab.filePath)) continue;
    files.push(tab.filePath);
  }
  return files;
}

function _workspacePathIsInside(filePath, projectDir) {
  if (!filePath || !projectDir) return false;
  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function _workspacePathsEqual(first, second) {
  if (!first || !second) return false;
  return path.relative(path.resolve(first), path.resolve(second)) === '' &&
    path.relative(path.resolve(second), path.resolve(first)) === '';
}

function _workspaceSnapshot(name, id = Date.now()) {
  _stashActiveTabContent();
  const openFiles = _workspaceFilesForProject(state.projectDir);
  const activeFile = _getActiveTab()?.filePath;
  return {
    id,
    name,
    projectDir: state.projectDir,
    activeTab: state.activeTab || 'editor',
    activeFile: activeFile && _workspacePathIsInside(activeFile, state.projectDir) ? activeFile : '',
    openFiles,
    ts: Date.now(),
  };
}

async function _saveCurrentWorkspace(name = null) {
  if (!state.projectDir) { showToast('No project open', 'warn'); return; }
  if (typeof name !== 'string') {
    name = await studioPrompt('Choose a name for this workspace.', `${state.projectName || 'My Project'} Workspace`, {
      title: 'Save workspace',
      confirmLabel: 'Save workspace',
      maxLength: 64,
    });
    if (name === null) return;
  }
  name = name.trim();
  if (!name) { showToast('Enter a workspace name', 'warn'); $('workspace-name-input')?.focus(); return; }
  const ws = _loadWorkspaces();
  ws.unshift(_workspaceSnapshot(name));
  if (ws.length > 20) ws.length = 20;
  if (!_saveWorkspaces(ws)) return;
  _renderWorkspaceList();
  showToast('Workspace saved', 'success');
}

async function _updateWorkspace(id) {
  if (!state.projectDir) { showToast('Open a project before updating a workspace', 'warn'); return; }
  const ws = _loadWorkspaces();
  const index = ws.findIndex((item) => String(item.id) === String(id));
  if (index === -1) { showToast('Workspace no longer exists'); _renderWorkspaceList(); return; }
  if (!_workspacePathsEqual(state.projectDir, ws[index].projectDir) &&
      !await studioConfirm(`Replace "${ws[index].name}" with the current project workspace?`, {
        title: 'Replace saved workspace',
        confirmLabel: 'Replace workspace',
      })) return;
  ws[index] = _workspaceSnapshot(ws[index].name, ws[index].id);
  if (!_saveWorkspaces(ws)) return;
  _renderWorkspaceList();
  showToast('Workspace updated', 'success');
}

async function _renameWorkspace(id) {
  const ws = _loadWorkspaces();
  const item = ws.find((entry) => String(entry.id) === String(id));
  if (!item) { showToast('Workspace no longer exists'); _renderWorkspaceList(); return; }
  const name = await studioPrompt('Choose a new name for this workspace.', item.name, {
    title: 'Rename workspace',
    confirmLabel: 'Rename',
    maxLength: 64,
  });
  if (name === null) return;
  if (!name.trim()) { showToast('Workspace name cannot be empty', 'warn'); return; }
  item.name = name.trim();
  if (!_saveWorkspaces(ws)) return;
  _renderWorkspaceList();
}

async function _deleteWorkspace(id) {
  const ws = _loadWorkspaces();
  const index = ws.findIndex((item) => String(item.id) === String(id));
  if (index === -1) { showToast('Workspace no longer exists'); _renderWorkspaceList(); return; }
  if (!await studioConfirm(`Delete workspace "${ws[index].name}"?`, {
    title: 'Delete workspace',
    confirmLabel: 'Delete workspace',
    danger: true,
  })) return;
  ws.splice(index, 1);
  if (!_saveWorkspaces(ws)) return;
  _renderWorkspaceList();
  showToast('Workspace deleted', 'success');
}

function _renderWorkspaceList() {
  const list = $('workspace-list');
  if (!list) return;
  const ws = _loadWorkspaces();
  const count = $('workspace-count');
  if (count) count.textContent = `${ws.length} saved workspace${ws.length === 1 ? '' : 's'}`;
  list.replaceChildren();

  if (!ws.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    const icon = document.createElement('span');
    icon.className = 'workspace-empty-icon';
    icon.innerHTML = _uiIcon('workspaces', 'ui-icon--empty');
    const message = document.createElement('span');
    message.textContent = 'No saved workspaces yet. Save the current project setup to get started.';
    empty.append(icon, message);
    list.appendChild(empty);
    return;
  }

  const query = _workspaceQuery.trim().toLocaleLowerCase();
  const visible = ws.map((workspace, index) => ({ workspace, index })).filter(({ workspace }) => {
    if (!query) return true;
    return [workspace.name, workspace.projectDir, ...workspace.openFiles]
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = 'No workspaces match your search.';
    list.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  visible.forEach(({ workspace: w }) => {
    const item = document.createElement('div');
    const sameProject = _workspacePathsEqual(state.projectDir, w.projectDir);
    const available = !!w.projectDir && fs.existsSync(w.projectDir);
    item.className = `workspace-item${sameProject ? ' workspace-item--current' : ''}`;

    const top = document.createElement('div');
    top.className = 'ws-card-top';
    const projectIcon = document.createElement('span');
    projectIcon.className = 'ws-project-icon';
    projectIcon.innerHTML = _uiIcon('folder');
    projectIcon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    info.className = 'ws-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'ws-name-row';
    const nameEl = document.createElement('strong');
    nameEl.className = 'ws-name';
    nameEl.textContent = w.name;
    nameRow.appendChild(nameEl);
    if (sameProject) {
      const badge = document.createElement('span');
      badge.className = 'ws-current-badge';
      badge.textContent = 'Current';
      nameRow.appendChild(badge);
    }
    if (!available) {
      const badge = document.createElement('span');
      badge.className = 'ws-unavailable-badge';
      badge.textContent = 'Unavailable';
      nameRow.appendChild(badge);
    }

    const metaEl = document.createElement('span');
    metaEl.className = 'ws-meta';
    const savedTime = w.ts ? `Saved ${_timeAgo(w.ts)}` : 'Saved date unknown';
    const openedTime = w.lastOpenedAt ? ` · Opened ${_timeAgo(w.lastOpenedAt)}` : '';
    metaEl.textContent = `${w.projectDir || 'Project path missing'} · ${savedTime}${openedTime}`;
    metaEl.title = w.projectDir;

    const filesEl = document.createElement('span');
    filesEl.className = 'ws-files';
    const fileNames = w.openFiles.map((file) => path.basename(file));
    filesEl.textContent = `${fileNames.length} open file${fileNames.length === 1 ? '' : 's'}${fileNames.length ? ` · ${fileNames.join(', ')}` : ''}`;
    filesEl.title = fileNames.join(', ') || 'No open files';

    info.append(nameRow, metaEl, filesEl);
    top.append(projectIcon, info);

    const actions = document.createElement('div');
    actions.className = 'ws-card-actions';
    const mainActions = document.createElement('div');
    mainActions.className = 'ws-card-actions-main';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'action-btn action-btn--ghost ws-load';
    loadBtn.type = 'button';
    loadBtn.textContent = 'Open workspace';
    loadBtn.disabled = !available;
    loadBtn.addEventListener('click', () => _loadWorkspace(w));
    mainActions.appendChild(loadBtn);

    const tools = document.createElement('div');
    tools.className = 'ws-card-actions-tools';
    const updateBtn = document.createElement('button');
    updateBtn.className = 'icon-btn';
    updateBtn.type = 'button';
    updateBtn.title = 'Update from current project';
    updateBtn.setAttribute('aria-label', `Update ${w.name} from the current project`);
    updateBtn.innerHTML = _uiIcon('refresh');
    updateBtn.disabled = !state.projectDir;
    updateBtn.addEventListener('click', () => _updateWorkspace(w.id));

    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn';
    renameBtn.type = 'button';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('aria-label', `Rename ${w.name}`);
    renameBtn.innerHTML = _uiIcon('edit');
    renameBtn.addEventListener('click', () => _renameWorkspace(w.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn';
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete';
    deleteBtn.setAttribute('aria-label', `Delete ${w.name}`);
    deleteBtn.innerHTML = _uiIcon('trash');
    deleteBtn.addEventListener('click', () => _deleteWorkspace(w.id));
    tools.append(updateBtn, renameBtn, deleteBtn);

    actions.append(mainActions, tools);
    item.append(top, actions);
    frag.appendChild(item);
  });
  list.appendChild(frag);
}

async function _loadWorkspace(ws) {
  if (!ws?.projectDir) { showToast('Workspace has no project path'); return; }
  if (!fs.existsSync(ws.projectDir)) { showToast(`Project folder not found: ${ws.projectDir}`); return; }
  const dirtyTabs = tabs.filter((tab) => tab.isDirty);
  if (dirtyTabs.length) {
    const names = dirtyTabs.map((tab) => path.basename(tab.filePath)).join(', ');
    if (!await studioConfirm(`Discard unsaved changes in ${names} and open this workspace?`, {
      title: 'Open workspace',
      confirmLabel: 'Discard and open',
      danger: true,
    })) return;
  }
  _stashActiveTabContent();
  await loadProject(ws.projectDir);
  if (!state.projectDir || !_workspacePathsEqual(state.projectDir, ws.projectDir)) return;

  tabs.length = 0;
  activeTabIndex = -1;
  if (window.CM) window.CM.destroy();
  $('file-preview-image')?.classList.add('hidden');
  _renderTabs();

  const missingFiles = [];
  const files = [];
  for (const savedPath of ws.openFiles) {
    const filePath = path.isAbsolute(savedPath) ? savedPath : path.resolve(ws.projectDir, savedPath);
    if (!_workspacePathIsInside(filePath, ws.projectDir) || !fs.existsSync(filePath)) {
      missingFiles.push(savedPath);
      continue;
    }
    files.push(filePath);
  }
  for (const filePath of files) {
    openFileEditor(filePath);
    if (tabs[activeTabIndex]) tabs[activeTabIndex].preview = false;
  }
  _renderTabs();

  const activeFile = ws.activeFile
    ? (path.isAbsolute(ws.activeFile) ? ws.activeFile : path.resolve(ws.projectDir, ws.activeFile))
    : '';
  if (activeFile && files.includes(activeFile)) {
    const activeIndex = tabs.findIndex((tab) => tab.filePath === activeFile);
    if (activeIndex !== -1 && activeIndex !== activeTabIndex) _switchToTab(activeIndex);
  }
  if (!tabs.length) {
    activeTabIndex = -1;
    _renderTabs();
    _highlightActiveFile();
  }
  const savedPanel = ws.activeTab && document.querySelector(`.tab[data-tab="${CSS.escape(ws.activeTab)}"]`)
    ? ws.activeTab
    : 'editor';
  switchTab(savedPanel);
  const stored = _loadWorkspaces();
  const saved = stored.find((item) => String(item.id) === String(ws.id));
  if (saved) {
    saved.lastOpenedAt = Date.now();
    _saveWorkspaces(stored);
  }
  closeWorkspaces();
  _renderWorkspaceList();
  if (missingFiles.length) {
    showToast(`Workspace loaded; ${missingFiles.length} saved file${missingFiles.length === 1 ? '' : 's'} could not be found`, 'warn');
    console.warn('Workspace files are missing or outside the project:', missingFiles);
    return;
  }
  showToast(`Loaded workspace: ${ws.name}`, 'success');
}

// Command palette

// Static command registry. Each entry: { id, label, description, category, action, when? }
// `when` is an optional fn() => bool -- command is hidden if it returns false.
function _buildCommandRegistry() {
  const hasProject = () => !!state.projectDir;
  const editorOpen = () => tabs.length > 0;
  const activeTab = () => _getActiveTab();
  const activeTextEditor = () => {
    const tab = activeTab();
    return !!window.CM && !!tab && !IMAGE_EXTS.has(path.extname(tab.filePath).toLowerCase());
  };
  const activeHtmlFile = () => {
    const ext = path.extname(activeTab()?.filePath || '').toLowerCase();
    return ext === '.html' || ext === '.htm';
  };
  const syntaxCheckAvailable = () => {
    const ext = path.extname(activeTab()?.filePath || '').toLowerCase();
    return !!_SYNTAX_LOADER_MAP[ext] || ['.json', '.novaapp', '.css', '.html', '.htm'].includes(ext);
  };
  const editorFontCanGrow = () => !!window.CM && (window.CM.getSettings()?.fontSize ?? 13) < 24;
  const editorFontCanShrink = () => !!window.CM && (window.CM.getSettings()?.fontSize ?? 13) > 10;

  return [
    // File
    { id: 'new-project', label: 'New Project', category: 'File', action: openNewProjectModal },
    { id: 'open-project', label: 'Open Project\u2026', category: 'File', action: () => pickFolder(loadProject) },
    { id: 'save-manifest', label: 'Save Manifest', category: 'File', action: saveManifest, when: hasProject },
    { id: 'new-file', label: 'New File', category: 'File', action: () => promptNewFile(), when: hasProject },
    { id: 'new-folder', label: 'New Folder', category: 'File', action: () => promptNewFolder(), when: hasProject },
    { id: 'save-file', label: 'Save File', category: 'File', action: saveOpenFile, when: editorOpen },

    // Navigate
    {
      id: 'quick-open', label: 'Quick Open File', category: 'Navigate', action: openQuickOpen, when: hasProject,
      shortcut: `${MOD_KEY}+P`
    },
    {
      id: 'global-search', label: 'Search in Project', category: 'Navigate', action: openGlobalSearch, when: hasProject,
      shortcut: `${MOD_KEY}+Shift+F`
    },
    { id: 'go-manifest', label: 'Go to Manifest tab', category: 'Navigate', action: () => switchTab('manifest'), when: hasProject },
    { id: 'go-design', label: 'Go to Design tab', category: 'Navigate', action: () => switchTab('design'), when: hasProject },
    { id: 'go-permissions', label: 'Go to Permissions tab', category: 'Navigate', action: () => switchTab('permissions'), when: hasProject },
    { id: 'go-editor', label: 'Go to Editor', category: 'Navigate', action: () => switchTab('editor'), when: hasProject },
    { id: 'go-build', label: 'Go to Build tab', category: 'Navigate', action: () => switchTab('build'), when: hasProject },
    { id: 'go-sign', label: 'Go to Signing tab', category: 'Navigate', action: () => switchTab('sign'), when: hasProject },
    { id: 'go-git', label: 'Go to Source Control', category: 'Navigate', action: () => switchTab('git'), when: hasProject },
    { id: 'go-review', label: 'Go to Review Preview', category: 'Navigate', action: () => switchTab('review'), when: hasProject },
    { id: 'show-inspector', label: 'Open Package Inspector', category: 'Navigate', action: showInspector },
    { id: 'open-settings', label: 'Open Studio Settings', category: 'Navigate', action: showSettings },

    // Editor
    { id: 'find-in-file', label: 'Find in Current File', category: 'Editor', action: () => window.CM?.openFind(), when: activeTextEditor },
    { id: 'toggle-word-wrap', label: 'Toggle Word Wrap', category: 'Editor', action: () => {
      const settings = window.CM?.getSettings();
      if (settings) window.CM.applySettings({ wordWrap: !settings.wordWrap });
    }, when: activeTextEditor },
    { id: 'increase-editor-font', label: 'Increase Editor Font Size', category: 'Editor', action: () => {
      const size = window.CM?.getSettings()?.fontSize;
      if (size !== undefined) {
        window.CM.applySettings({ fontSize: Math.min(24, size + 1) });
        _updateEditorToolbar();
      }
    }, when: editorFontCanGrow },
    { id: 'decrease-editor-font', label: 'Decrease Editor Font Size', category: 'Editor', action: () => {
      const size = window.CM?.getSettings()?.fontSize;
      if (size !== undefined) {
        window.CM.applySettings({ fontSize: Math.max(10, size - 1) });
        _updateEditorToolbar();
      }
    }, when: editorFontCanShrink },
    { id: 'check-file-syntax', label: 'Check Current File Syntax', category: 'Editor', action: checkSyntax, when: syntaxCheckAvailable },
    { id: 'toggle-preview', label: 'Toggle HTML Preview', category: 'Editor', action: _togglePreview, when: () => _previewVisible || activeHtmlFile() },
    { id: 'refresh-preview', label: 'Refresh HTML Preview', category: 'Editor', action: _refreshPreviewIfVisible, when: () => activeHtmlFile() && _previewVisible },
    {
      id: 'diff-vs-saved', label: 'Diff File vs Saved', category: 'Editor', action: openDiffVsSaved, when: editorOpen,
      shortcut: `${MOD_KEY}+Shift+D`
    },
    {
      id: 'save-all', label: 'Save All Files', category: 'Editor', action: saveAllOpenFiles, when: editorOpen,
      shortcut: `${MOD_KEY}+Alt+S`
    },

    // Project
    { id: 'permission-audit', label: 'Audit Project Permissions', category: 'Project', action: _runProjectPermissionAudit, when: hasProject },
    { id: 'collapse-folders', label: 'Collapse All File Tree Folders', category: 'Project', action: _collapseAllFileTreeFolders, when: hasProject },

    // Build
    {
      id: 'build', label: 'Build Package', category: 'Build', action: () => { switchTab('build'); runBuild(); }, when: hasProject,
      shortcut: `${MOD_KEY}+B`
    },
    { id: 'open-build-output', label: 'Open Build Output Folder', category: 'Build', action: _openBuildOutputFolder, when: () => !!_lastBuildOutFile && fs.existsSync(_lastBuildOutFile) },
    { id: 'clear-build-history', label: 'Clear Build History', category: 'Build', action: () => { localStorage.removeItem(BUILD_HISTORY_KEY); _renderBuildHistory(); } },

    // Workspace
    {
      id: 'workspaces', label: 'Manage Workspaces', category: 'Workspace', action: openWorkspaces,
      shortcut: `${MOD_KEY}+Shift+W`
    },
    { id: 'save-workspace', label: 'Save Current Workspace', category: 'Workspace', action: _saveCurrentWorkspace, when: hasProject },
    { id: 'refresh-files', label: 'Refresh File Tree', category: 'Workspace', action: () => { if (state.projectDir) populateFileTree(state.projectDir); }, when: hasProject },

    // Theme (generated dynamically)
    ...THEMES.map((t) => ({
      id: `theme-${t.id}`,
      label: `Theme: ${t.label}`,
      category: 'Theme',
      action: () => setTheme(t.id),
      _swatch: t.swatch,
    })),

    // Snippets (generated dynamically from PERMISSIONS -- see _PERM_SNIPPETS)
    ..._permSnippetCommands(),

    // Help
    { id: 'help', label: 'Help', category: 'Help', action: () => openHelp() },
    { id: 'about', label: 'About NovaByte Studio', category: 'Help', action: openAboutModal },
    { id: 'check-updates', label: 'Check for Updates', category: 'Help', action: () => checkForUpdates(false) },
    ..._studioPluginCommands.values(),
  ];
}

let _cpRegistry = null;   // built lazily so all fns are defined
let _cpActiveIdx = -1;
let _cpFiltered = [];
let _cpCategory = 'All';
let _cpFavorites = new Set();
let _cpFavoritesLoaded = false;
let _cpRecentIds = [];
const CP_FAVORITES_KEY = 'novapack_command_favorites';

const CP_CATEGORY_ICONS = {
  File: 'file',
  Navigate: 'search',
  Editor: 'edit',
  Project: 'folder',
  Build: 'package',
  Workspace: 'workspaces',
  Theme: 'palette',
  Help: 'help',
  Snippets: 'text',
};

const CP_CATEGORY_DESCRIPTIONS = {
  File: 'Create a project or work with files.',
  Navigate: 'Jump to a Studio view, file, or tool.',
  Editor: 'Search, preview, and adjust editor behavior.',
  Project: 'Manage and inspect the open project.',
  Build: 'Package the project and review build output.',
  Workspace: 'Save, restore, and organize your setup.',
  Theme: 'Change the Studio color theme.',
  Help: 'Get guidance and app information.',
};

function _cpDescription(cmd) {
  if (cmd.description) return cmd.description;
  if (cmd.id.startsWith('go-')) return `Open the ${cmd.label.replace(/^Go to /i, '')}.`;
  if (cmd.id.startsWith('theme-')) return `Switch to the ${cmd.label.replace(/^Theme: /, '')} theme.`;
  return CP_CATEGORY_DESCRIPTIONS[cmd.category] || `Run this ${cmd.category.toLowerCase()} command.`;
}

function _cpEnsureFavorites() {
  if (_cpFavoritesLoaded) return;
  _cpFavoritesLoaded = true;
  try {
    const stored = JSON.parse(localStorage.getItem(CP_FAVORITES_KEY) || '[]');
    if (!Array.isArray(stored) || stored.some((id) => typeof id !== 'string')) {
      throw new TypeError('Saved command favorites are invalid');
    }
    _cpFavorites = new Set(stored);
  } catch (error) {
    console.error('Could not load command favorites:', error);
    showToast('Saved command favorites could not be loaded', 'warn');
  }
}

function _cpToggleFavorite(command) {
  const wasFavorite = _cpFavorites.has(command.id);
  if (wasFavorite) _cpFavorites.delete(command.id);
  else _cpFavorites.add(command.id);
  try {
    localStorage.setItem(CP_FAVORITES_KEY, JSON.stringify([..._cpFavorites]));
  } catch (error) {
    if (wasFavorite) _cpFavorites.add(command.id);
    else _cpFavorites.delete(command.id);
    console.error('Could not save command favorites:', error);
    showToast('Could not save command favorite', 'warn');
    return;
  }
  _renderCpCategories();
  _runCpFilter($('cp-input')?.value || '');
  $('cp-input')?.focus();
}

function _cpAvailableCommands() {
  return (_cpRegistry || []).filter((cmd) => !cmd.when || cmd.when());
}

function _renderCpCategories() {
  const nav = $('cp-categories');
  if (!nav) return;
  const available = _cpAvailableCommands();
  const categories = [...new Set(available.map((cmd) => cmd.category))];
  const options = [
    { id: 'All', label: 'All', count: available.length },
    { id: 'Recent', label: 'Recent', count: _cpRecentIds.filter((id) => available.some((cmd) => cmd.id === id)).length },
    { id: 'Starred', label: 'Starred', count: available.filter((cmd) => _cpFavorites.has(cmd.id)).length },
    ...categories.map((category) => ({
      id: category,
      label: category,
      count: available.filter((cmd) => cmd.category === category).length,
    })),
  ];
  nav.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-category-chip' + (_cpCategory === option.id ? ' is-active' : '');
    button.setAttribute('aria-pressed', String(_cpCategory === option.id));
    const label = document.createElement('span');
    label.textContent = option.label;
    const count = document.createElement('span');
    count.className = 'cp-category-count';
    count.textContent = String(option.count);
    button.append(label, count);
    button.addEventListener('click', () => {
      _cpCategory = option.id;
      _renderCpCategories();
      _runCpFilter($('cp-input')?.value || '');
      $('cp-input')?.focus();
    });
    nav.appendChild(button);
  }
}

// Help modal
let _activeHelpSection = 'how-to-use';

function openHelp(section) {
  const overlay = $('modal-help');
  overlay?.classList.remove('hidden');
  const search = $('help-search');
  if (search) search.value = '';
  _filterHelp('');
  if (section) _showHelpSection(section);

  // Reflect the real platform modifier key (\u2318 on macOS, Ctrl elsewhere)
  // instead of hardcoding "Ctrl" in the markup.
  [
    'help-kbd-new',
    'help-kbd-open',
    'help-kbd-build',
    'help-kbd-palette',
    'help-kbd-quickopen',
    'help-kbd-save',
    'help-kbd-undo',
    'help-kbd-redo',
    'help-kbd-find',
    'help-kbd-search',
    'help-kbd-diff',
    'help-kbd-workspaces',
  ].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = el.textContent.replace(/^Ctrl/, MOD_KEY);
  });
  const saveAllShortcut = $('help-kbd-save-all');
  if (saveAllShortcut) saveAllShortcut.textContent = `${MOD_KEY}+${IS_MAC ? 'Option' : 'Alt'}+S`;
  const modKeyLabel = $('help-mod-key');
  if (modKeyLabel) modKeyLabel.textContent = MOD_KEY;
}

function closeHelp() {
  $('modal-help')?.classList.add('hidden');
}

function _showHelpSection(section) {
  if (![...document.querySelectorAll('.help-pane')].some((pane) => pane.dataset.helpPane === section)) return;
  _activeHelpSection = section;
  document.querySelectorAll('.help-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.helpSection === section);
  });
  document.querySelectorAll('.help-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.helpPane === section);
  });
  const panes = $('help-panes');
  if (panes) panes.scrollTop = 0;
}

function _filterHelp(query) {
  const normalized = query.trim().toLocaleLowerCase();
  const buttons = [...document.querySelectorAll('.help-nav-btn')];
  const panes = [...document.querySelectorAll('.help-pane')];
  const status = $('help-search-status');
  const noResults = $('help-no-results');

  if (!normalized) {
    buttons.forEach((button) => { button.hidden = false; });
    noResults?.classList.add('hidden');
    if (status) status.textContent = '';
    _showHelpSection(_activeHelpSection);
    return;
  }

  const matchingSections = new Set(
    panes
      .filter((pane) => pane.textContent.toLocaleLowerCase().includes(normalized))
      .map((pane) => pane.dataset.helpPane),
  );
  buttons.forEach((button) => { button.hidden = !matchingSections.has(button.dataset.helpSection); });

  const matchCount = matchingSections.size;
  if (status) status.textContent = `${matchCount} topic${matchCount === 1 ? '' : 's'} found`;
  noResults?.classList.toggle('hidden', matchCount > 0);
  if (!matchCount) {
    buttons.forEach((button) => button.classList.remove('active'));
    panes.forEach((pane) => pane.classList.remove('active'));
    return;
  }

  const section = matchingSections.has(_activeHelpSection)
    ? _activeHelpSection
    : panes.find((pane) => matchingSections.has(pane.dataset.helpPane)).dataset.helpPane;
  _showHelpSection(section);
}

function initHelp() {
  $('btn-help')?.addEventListener('click', () => openHelp());
  $('help-search')?.addEventListener('input', (event) => _filterHelp(event.currentTarget.value));
  document.querySelectorAll('.help-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => _showHelpSection(btn.dataset.helpSection));
  });
  document.querySelectorAll('[data-help-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.helpAction;
      if (action === 'tutorial') {
        closeHelp();
        _startStudioTutorial(state.projectDir && state.screen === 'project' ? 'package' : 'overview');
      } else if (action === 'new-project') {
        closeHelp();
        openNewProjectModal();
      } else if (action === 'open-project') {
        closeHelp();
        pickFolder(loadProject);
      } else if (action === 'tab-build') {
        if (!state.projectDir) {
          showToast('Open a project before going to Build.');
          return;
        }
        closeHelp();
        switchTab('build');
      }
    });
  });
}

function openCommandPalette() {
  _refreshStudioPluginCommands();
  _cpEnsureFavorites();
  _cpCategory = 'All';

  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const overlay = $('modal-command-palette');
  const input = $('cp-input');
  overlay?.classList.remove('hidden');
  input.value = '';
  _renderCpCategories();
  _runCpFilter('');
  input.focus();
}

function closeCommandPalette() {
  $('modal-command-palette')?.classList.add('hidden');
}

function _runCpFilter(query) {
  const q = query.trim().toLowerCase();
  const available = _cpAvailableCommands();
  const byId = new Map(available.map((cmd) => [cmd.id, cmd]));
  let candidates;
  if (_cpCategory === 'Recent') {
    candidates = _cpRecentIds.map((id) => byId.get(id)).filter(Boolean);
  } else if (_cpCategory === 'Starred') {
    candidates = available.filter((cmd) => _cpFavorites.has(cmd.id));
  } else {
    candidates = _cpCategory === 'All'
      ? available
      : available.filter((cmd) => cmd.category === _cpCategory);
  }
  _cpFiltered = candidates
    .filter((cmd) => !q || _cpMatch(
      `${cmd.label} ${_cpDescription(cmd)} ${(cmd.aliases || []).join(' ')}`.toLowerCase(),
      cmd.category.toLowerCase(),
      q,
    ))
    .sort((a, b) => {
      if (!q) return 0; // preserve registry order when no query
      return _cpScore(`${b.label} ${_cpDescription(b)} ${(b.aliases || []).join(' ')}`.toLowerCase(), q)
        - _cpScore(`${a.label} ${_cpDescription(a)} ${(a.aliases || []).join(' ')}`.toLowerCase(), q);
    });

  _cpActiveIdx = _cpFiltered.length ? 0 : -1;
  _renderCpResults();
}

function _cpMatch(label, cat, q) {
  return label.includes(q) || cat.includes(q) || _qoScore(label, q) > 0;
}

function _cpScore(label, q) {
  if (label.includes(q)) return 100 + (q.length / label.length) * 50;
  return _qoScore(label, q);
}

function _renderCpResults() {
  const el = $('cp-results');
  if (!el) return;
  el.replaceChildren();
  const count = $('cp-results-count');
  const label = $('cp-results-label');
  if (count) count.textContent = `${_cpFiltered.length} COMMAND${_cpFiltered.length === 1 ? '' : 'S'}`;
  if (label) label.textContent = `${_cpCategory.toUpperCase()} COMMANDS`;

  if (!_cpFiltered.length) {
    const empty = document.createElement('div');
    empty.className = 'cp-empty';
    empty.textContent = _cpCategory === 'Starred' && !$('cp-input')?.value
      ? 'No starred commands yet — use the star beside a command to save it here.'
      : _cpCategory === 'Recent' && !$('cp-input')?.value
        ? 'Commands you run will appear here.'
        : 'No matching commands. Try another category or search term.';
    el.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  let lastCat = null;
  _cpFiltered.forEach((cmd, i) => {
    if (cmd.category !== lastCat) {
      const header = document.createElement('div');
      header.className = 'cp-category';
      header.textContent = cmd.category;
      frag.appendChild(header);
      lastCat = cmd.category;
    }
    const item = document.createElement('div');
    item.className = 'cp-result-row';
    item.setAttribute('role', 'listitem');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-item' + (i === _cpActiveIdx ? ' qo-item--active' : '');
    button.dataset.index = i;
    button.setAttribute('aria-current', String(i === _cpActiveIdx));

    const icon = document.createElement('span');
    icon.className = 'cp-icon' + (cmd._swatch ? ' cp-icon--swatch' : '');
    if (cmd._swatch) {
      icon.style.background = cmd._swatch;
    } else {
      icon.innerHTML = _uiIcon(CP_CATEGORY_ICONS[cmd.category] || 'grid');
    }
    button.appendChild(icon);

    const copy = document.createElement('span');
    copy.className = 'cp-item-copy';
    const label = document.createElement('span');
    label.className = 'cp-label';
    label.textContent = cmd.label;
    copy.appendChild(label);

    const description = document.createElement('span');
    description.className = 'cp-description';
    description.textContent = _cpDescription(cmd);
    copy.appendChild(description);
    button.appendChild(copy);

    if (cmd.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'cp-shortcut';
      sc.textContent = cmd.shortcut;
      button.appendChild(sc);
    }

    button.addEventListener('mouseenter', () => {
      _cpActiveIdx = +button.dataset.index;
      _cpHighlight();
    });
    button.addEventListener('click', () => _cpExecute(+button.dataset.index));

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'cp-star' + (_cpFavorites.has(cmd.id) ? ' is-starred' : '');
    star.textContent = _cpFavorites.has(cmd.id) ? '\u2605' : '\u2606';
    star.title = _cpFavorites.has(cmd.id) ? 'Remove from starred commands' : 'Add to starred commands';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(_cpFavorites.has(cmd.id)));
    star.addEventListener('click', () => _cpToggleFavorite(cmd));
    item.append(button, star);
    frag.appendChild(item);
  });
  el.appendChild(frag);
}

function _cpHighlight() {
  const items = $('cp-results')?.querySelectorAll('.cp-item') || [];
  items.forEach((el, i) => {
    el.classList.toggle('qo-item--active', i === _cpActiveIdx);
    el.setAttribute('aria-current', String(i === _cpActiveIdx));
    if (i === _cpActiveIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function _cpExecute(idx) {
  const cmd = _cpFiltered[idx];
  if (!cmd) return;
  _cpRecentIds = [cmd.id, ..._cpRecentIds.filter((id) => id !== cmd.id)].slice(0, 8);
  closeCommandPalette();
  // Small delay so the modal is gone before the action runs (avoids focus fights)
  setTimeout(() => cmd.action(), 30);
}

function _initCommandPalette() {
  const input = $('cp-input');
  if (!input) return;
  const modifier = $('cp-mod-key');
  if (modifier) modifier.textContent = MOD_KEY;

  input.addEventListener('input', () => _runCpFilter(input.value));

  input.addEventListener('keydown', (e) => {
    const items = $('cp-results')?.querySelectorAll('.cp-item') || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _cpActiveIdx = Math.min(_cpActiveIdx + 1, items.length - 1);
      _cpHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _cpActiveIdx = Math.max(_cpActiveIdx - 1, 0);
      _cpHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      _cpExecute(_cpActiveIdx);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const command = _cpFiltered[_cpActiveIdx];
      if (command) _cpToggleFavorite(command);
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  $('cp-close')?.addEventListener('click', closeCommandPalette);
  const overlay = $('modal-command-palette');
  overlay?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.target !== input) {
      event.preventDefault();
      closeCommandPalette();
    }
  });
  overlay?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-command-palette') closeCommandPalette();
  });
}

// Quick-open file switcher
let _qoFiles = [];
let _qoActiveIdx = -1;
let _qoMode = 'All';
let _qoRecentPaths = [];

function _qoRecentStorageKey() {
  return `novapack_quick_open_recent:${path.resolve(state.projectDir || '')}`;
}

function _qoLoadRecentFiles() {
  try {
    const stored = JSON.parse(localStorage.getItem(_qoRecentStorageKey()) || '[]');
    if (!Array.isArray(stored) || stored.some((filePath) => typeof filePath !== 'string')) {
      throw new TypeError('Saved Quick Open history is invalid');
    }
    _qoRecentPaths = stored
      .filter((filePath) => _workspacePathIsInside(filePath, state.projectDir) && fs.existsSync(filePath))
      .slice(0, 20);
  } catch (error) {
    console.error('Could not load Quick Open history:', error);
    showToast('Quick Open history could not be loaded', 'warn');
    _qoRecentPaths = [];
  }
}

function _qoRecordRecentFile(filePath) {
  if (!state.projectDir || !_workspacePathIsInside(filePath, state.projectDir)) return;
  _qoRecentPaths = [path.resolve(filePath), ..._qoRecentPaths.filter((item) => path.resolve(item) !== path.resolve(filePath))]
    .slice(0, 20);
  try {
    localStorage.setItem(_qoRecentStorageKey(), JSON.stringify(_qoRecentPaths));
  } catch (error) {
    console.error('Could not save Quick Open history:', error);
    showToast('Could not save Quick Open history', 'warn');
  }
}

function openQuickOpen() {
  if (!state.projectDir) {
    pickFolder(loadProject);
    return;
  }
  _qoLoadRecentFiles();
  _qoFiles = _collectSearchableFiles(state.projectDir)
    .map((full) => ({ full, rel: path.relative(state.projectDir, full) }));

  // Blur whatever currently has focus (almost always the CodeMirror editor)
  // before showing the modal, so keystrokes can't land in the document
  // while the input below is taking focus.
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const overlay = $('modal-quick-open');
  const input = $('qo-input');
  overlay?.classList.remove('hidden');
  _qoMode = 'All';
  input.value = '';
  $('qo-project-name').textContent = state.projectName || path.basename(state.projectDir);
  document.querySelectorAll('.qo-filter').forEach((button) => {
    const active = button.dataset.qoMode === _qoMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  _qoUpdateFilterCounts();
  _renderQoResults('');
  input.focus();
}

function closeQuickOpen() {
  $('modal-quick-open')?.classList.add('hidden');
}

function _renderQoResults(query) {
  const el = $('qo-results');
  if (!el) return;
  const q = query.trim().toLowerCase();
  const activeTab = _getActiveTab();
  const activePath = activeTab ? path.resolve(activeTab.filePath) : '';
  const openPaths = new Set(tabs.map((tab) => path.resolve(tab.filePath)));
  const filesByPath = new Map(_qoFiles.map((file) => [path.resolve(file.full), file]));
  let candidates = _qoMode === 'Open'
    ? tabs.map((tab) => filesByPath.get(path.resolve(tab.filePath)) || ({
      full: tab.filePath,
      rel: path.relative(state.projectDir, tab.filePath),
    }))
    : _qoMode === 'Recent'
      ? _qoRecentPaths.map((filePath) => filesByPath.get(path.resolve(filePath))).filter(Boolean)
      : _qoFiles;

  const recentOrder = new Map(_qoRecentPaths.map((filePath, index) => [path.resolve(filePath), index]));
  const scored = candidates
    .map((file) => {
      const rel = file.rel.replace(/\\/g, '/');
      const base = path.basename(rel);
      const score = Math.max(_qoScore(rel.toLowerCase(), q), _qoScore(base.toLowerCase(), q));
      const resolved = path.resolve(file.full);
      return {
        ...file,
        rel,
        score,
        isOpen: openPaths.has(resolved),
        isActive: resolved === activePath,
        recentRank: recentOrder.get(resolved) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((file) => !q || file.score > 0)
    .sort((a, b) => {
      if (q && a.score !== b.score) return b.score - a.score;
      if (a.recentRank !== b.recentRank) return a.recentRank - b.recentRank;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.rel.localeCompare(b.rel);
    })
    .slice(0, 50);

  _qoActiveIdx = scored.length ? 0 : -1;
  el.replaceChildren();
  const count = $('qo-results-count');
  const label = $('qo-results-label');
  const clear = $('qo-clear');
  if (count) count.textContent = `${scored.length} FILE${scored.length === 1 ? '' : 'S'}`;
  if (label) label.textContent = _qoMode === 'Recent' ? 'RECENT FILES'
    : _qoMode === 'Open' ? 'OPEN EDITORS' : 'PROJECT FILES';
  clear?.classList.toggle('hidden', !query);

  if (!scored.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = q ? 'No files match that search. Try another name or path.'
      : _qoMode === 'Open' ? 'No files are currently open.'
        : _qoMode === 'Recent' ? 'Files you open will appear here.'
          : 'No searchable files found in this project.';
    el.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  scored.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'qo-item' + (i === 0 ? ' qo-item--active' : '');
    item.dataset.index = i;
    item.dataset.path = f.full;
    item.tabIndex = -1;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === _qoActiveIdx));
    item.title = f.full;

    const icon = document.createElement('span');
    icon.className = 'qo-file-icon';
    icon.innerHTML = _fileIconHtml(path.extname(f.rel).toLowerCase());

    const copy = document.createElement('span');
    copy.className = 'qo-file-copy';
    const name = document.createElement('span');
    name.className = 'qo-name';
    name.textContent = path.basename(f.rel);

    const relDir = path.dirname(f.rel);
    const p = document.createElement('span');
    p.className = 'qo-path';
    p.textContent = relDir === '.' ? state.projectName || path.basename(state.projectDir) : relDir;

    copy.append(name, p);
    const badges = document.createElement('span');
    badges.className = 'qo-file-badges';
    if (f.isActive) {
      const active = document.createElement('span');
      active.className = 'qo-file-badge qo-file-badge--active';
      active.textContent = 'ACTIVE';
      badges.appendChild(active);
    } else if (f.isOpen) {
      const opened = document.createElement('span');
      opened.className = 'qo-file-badge';
      opened.textContent = 'OPEN';
      badges.appendChild(opened);
    }
    const openTab = tabs.find((tab) => path.resolve(tab.filePath) === path.resolve(f.full));
    if (openTab?.isDirty) {
      const dirty = document.createElement('span');
      dirty.className = 'qo-file-dirty';
      dirty.textContent = 'UNSAVED';
      badges.appendChild(dirty);
    }

    item.append(icon, copy, badges);
    item.addEventListener('mouseenter', () => {
      _qoActiveIdx = +item.dataset.index;
      _qoHighlight();
    });
    item.addEventListener('click', () => {
      openFileEditor(item.dataset.path);
      closeQuickOpen();
    });
    frag.appendChild(item);
  });
  el.appendChild(frag);
}

function _qoUpdateFilterCounts() {
  const openCount = $('qo-open-count');
  const recentCount = $('qo-recent-count');
  if (openCount) openCount.textContent = String(tabs.length);
  if (recentCount) recentCount.textContent = String(_qoRecentPaths.length);
}

// Simple fuzzy score: consecutive match bonus, start-of-segment bonus.
// Returns 0 when the query is not fully matched so the caller can drop
// non-matches.
function _qoScore(name, q) {
  if (!q) return 1;
  let si = 0, score = 0, prev = -1;
  for (let ni = 0; ni < name.length && si < q.length; ni++) {
    if (name[ni] === q[si]) {
      score += (ni === prev + 1) ? 3 : 1;           // consecutive bonus
      if (ni === 0 || '/._-'.includes(name[ni - 1])) score += 2; // segment-start bonus
      prev = ni; si++;
    }
  }
  return si === q.length ? score : 0; // must match all chars
}

function _qoHighlight() {
  $('qo-results')?.querySelectorAll('.qo-item').forEach((el, i) => {
    el.classList.toggle('qo-item--active', i === _qoActiveIdx);
    el.setAttribute('aria-selected', String(i === _qoActiveIdx));
    if (i === _qoActiveIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function _initQuickOpen() {
  const input = $('qo-input');
  if (!input) return;

  input.addEventListener('input', () => _renderQoResults(input.value));

  input.addEventListener('keydown', (e) => {
    const items = $('qo-results')?.querySelectorAll('.qo-item') || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _qoActiveIdx = Math.min(_qoActiveIdx + 1, items.length - 1);
      _qoHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _qoActiveIdx = Math.max(_qoActiveIdx - 1, 0);
      _qoHighlight();
    } else if (e.key === 'Enter') {
      const active = items[_qoActiveIdx];
      if (active) { openFileEditor(active.dataset.path); closeQuickOpen(); }
    } else if (e.key === 'Escape') {
      closeQuickOpen();
    }
  });

  $('qo-close')?.addEventListener('click', closeQuickOpen);
  $('qo-clear')?.addEventListener('click', () => {
    input.value = '';
    _renderQoResults('');
    input.focus();
  });
  $('qo-filters')?.addEventListener('click', (event) => {
    const button = event.target.closest('.qo-filter');
    if (!button) return;
    _qoMode = button.dataset.qoMode || 'All';
    document.querySelectorAll('.qo-filter').forEach((filter) => {
      const active = filter === button;
      filter.classList.toggle('is-active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    _renderQoResults(input.value);
    input.focus();
  });

  $('modal-quick-open')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-quick-open') closeQuickOpen();
  });
}

// Inspector
function showInspector() {
  showScreen('inspector');
  $('inspector-dropzone').classList.remove('hidden');
  $('inspector-result').classList.add('hidden');
  $('inspector-result').replaceChildren();
  $('package-comparison')?.classList.add('hidden');
  $('package-comparison')?.replaceChildren();
  $('project-breadcrumb').textContent = 'Inspector';
}

const _PACKAGE_AUDIT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm']);
const _PACKAGE_AUDIT_MAX_FILES = 4000;
const _PACKAGE_AUDIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const _PACKAGE_AUDIT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION = 4;
const _PACKAGE_AUDIT_MAX_UNMAPPED_ACTIONS = 50;
const _PACKAGE_AUDIT_MAX_UNKNOWN_DECLARATIONS = 50;

function _stripSourceComments(source, isHtml = false) {
  const text = isHtml
    ? source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '))
    : source;
  const output = [];
  let segmentStart = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    const isLineComment = text[i + 1] === '/';
    const start = i;
    i += 2;
    while (i < text.length && (isLineComment ? text[i] !== '\n' : !(text[i - 1] === '*' && text[i] === '/'))) i++;
    if (!isLineComment && i < text.length) i++;
    const end = i;
    output.push(text.slice(segmentStart, start), text.slice(start, end).replace(/[^\r\n]/g, ' '));
    segmentStart = end;
  }
  output.push(text.slice(segmentStart));
  return output.join('');
}

function _scanPackagePermissionEvidence(pkg) {
  const evidence = new Map();
  const unknownActions = new Map();
  const conditionalApis = new Map();
  const alternativeEvidence = new Map();
  const stats = { scannedFiles: 0, skippedFiles: 0, truncated: false, omittedUnknownActions: 0 };
  const files = pkg?.files && typeof pkg.files === 'object' && !Array.isArray(pkg.files)
    ? Object.entries(pkg.files)
    : [];
  let totalBytes = 0;

  const addEvidence = (permission, reference) => {
    if (!evidence.has(permission)) evidence.set(permission, []);
    const refs = evidence.get(permission);
    if (refs.length < _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION) refs.push(reference);
  };
  const addConditionalApi = (api, filePath, line) => {
    if (!conditionalApis.has(api)) conditionalApis.set(api, []);
    const refs = conditionalApis.get(api);
    if (refs.length < _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION) refs.push({ path: filePath, line });
  };
  const addAlternativeEvidence = (id, permissions, reference) => {
    if (!alternativeEvidence.has(id)) alternativeEvidence.set(id, { permissions, references: [] });
    const refs = alternativeEvidence.get(id).references;
    if (refs.length < _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION) refs.push(reference);
  };

  for (const [filePath, encoded] of files) {
    if (!_PACKAGE_AUDIT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    if (stats.scannedFiles >= _PACKAGE_AUDIT_MAX_FILES || totalBytes >= _PACKAGE_AUDIT_MAX_TOTAL_BYTES) {
      stats.truncated = true;
      stats.skippedFiles++;
      continue;
    }
    if (typeof encoded !== 'string') {
      stats.skippedFiles++;
      continue;
    }
    if (encoded.length > Math.ceil(_PACKAGE_AUDIT_MAX_FILE_BYTES / 3) * 4) {
      stats.skippedFiles++;
      continue;
    }
    if (encoded.length > Math.ceil((_PACKAGE_AUDIT_MAX_TOTAL_BYTES - totalBytes) / 3) * 4) {
      stats.skippedFiles++;
      stats.truncated = true;
      continue;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      stats.skippedFiles++;
      continue;
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > _PACKAGE_AUDIT_MAX_FILE_BYTES || totalBytes + bytes.length > _PACKAGE_AUDIT_MAX_TOTAL_BYTES
        || bytes.includes(0)) {
      stats.skippedFiles++;
      continue;
    }
    totalBytes += bytes.length;
    stats.scannedFiles++;
    const source = _stripSourceComments(bytes.toString('utf8'), ['.html', '.htm'].includes(path.extname(filePath).toLowerCase()));
    const lines = source.split(/\r?\n/);
    const lineForOffset = (offset) => source.slice(0, offset).split(/\r?\n/).length;
    lines.forEach((line, index) => {
      for (const [pattern, permissions] of _PERMISSION_API_RULES) {
        const expression = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        for (const match of line.matchAll(expression)) {
          if (/window\.nova(?:OS)?\.app\.launch|window\.nova\.apps\.launch|window\.novaOS\.settings\.set/.test(match[0])) continue;
          for (const permission of permissions) {
            addEvidence(permission, { path: filePath, line: index + 1, source: match[0], kind: 'NovaOS API reference' });
          }
        }
      }

    });

    const settingsSetIpcPattern = /(?:window\.)?nova(?:OS)?\.ipc\s*\(\s*(['"])nova:settings:set\1\s*,\s*\{[^}]*?\bkey\s*:\s*(['"])([^'"]+)\2/g;
    const literalSettingsSetCalls = new Set();
    for (const match of source.matchAll(settingsSetIpcPattern)) {
      literalSettingsSetCalls.add(match.index);
      if (['wallpaperId', 'customWallpaper'].includes(match[3])) continue;
      addEvidence('system:settings', {
        path: filePath, line: lineForOffset(match.index), source: match[0], kind: 'IPC call',
      });
    }

    const ipcActionPattern = /(?:window\.)?nova(?:OS)?\.ipc\s*\(\s*(['"])(nova:[a-zA-Z0-9:_-]+)\1/g;
    for (const match of source.matchAll(ipcActionPattern)) {
      const action = match[2];
      if (action === 'nova:app:launch') {
        addAlternativeEvidence('app-launch', ['system:app-launch', 'system:apps'], {
          path: filePath, line: lineForOffset(match.index), source: match[0], kind: 'IPC call',
        });
        continue;
      }
      if (action === 'nova:settings:set') {
        if (!literalSettingsSetCalls.has(match.index)) {
          addConditionalApi('Settings update (key-dependent)', filePath, lineForOffset(match.index));
        }
        continue;
      }
      const permissions = _permissionsForChannel(action);
      if (action.startsWith('nova:reg:')) {
        addConditionalApi('Registry operation (hive/ACL-dependent)', filePath, lineForOffset(match.index));
      }
      if (!permissions.length) {
        const conditional = _conditionalPermissionForChannel(action);
        if (conditional) {
          addConditionalApi(conditional, filePath, lineForOffset(match.index));
          continue;
        }
        if (_isKnownPermissionlessChannel(action)) continue;
        if (!unknownActions.has(action) && unknownActions.size >= _PACKAGE_AUDIT_MAX_UNMAPPED_ACTIONS) {
          stats.omittedUnknownActions++;
          continue;
        }
        if (!unknownActions.has(action)) unknownActions.set(action, []);
        const refs = unknownActions.get(action);
        if (refs.length < _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION) {
          refs.push({ path: filePath, line: lineForOffset(match.index) });
        }
      }
      for (const permission of permissions) {
        addEvidence(permission, {
          path: filePath,
          line: lineForOffset(match.index),
          source: match[0],
          kind: 'IPC call',
        });
      }
    }

    const appLaunchPattern = /window\.nova(?:OS)?\.app\.launch\s*\(|window\.nova\.apps\.launch\s*\(/g;
    for (const match of source.matchAll(appLaunchPattern)) {
      addAlternativeEvidence('app-launch', ['system:app-launch', 'system:apps'], {
        path: filePath, line: lineForOffset(match.index), source: match[0], kind: 'App launch API',
      });
    }

    const settingsSetPattern = /window\.novaOS\.settings\.set\s*\(\s*(['"])([^'"]+)\1/g;
    const settingsSetMatches = [...source.matchAll(settingsSetPattern)];
    for (const match of settingsSetMatches) {
      if (['wallpaperId', 'customWallpaper'].includes(match[2])) continue;
      addEvidence('system:settings', {
        path: filePath, line: lineForOffset(match.index), source: match[0], kind: 'Settings API reference',
      });
    }
    const settingsSetCallPattern = /window\.novaOS\.settings\.set\s*\(/g;
    const literalSettingsSetOffsets = new Set(settingsSetMatches.map((match) => match.index));
    for (const match of source.matchAll(settingsSetCallPattern)) {
      if (!literalSettingsSetOffsets.has(match.index)) {
        addConditionalApi('Settings update (key-dependent)', filePath, lineForOffset(match.index));
      }
    }

    const registryPattern = /window\.novaOS\.registry\.(?:get|list|stat|export|watch|set|remove|import)\s*\(/g;
    for (const match of source.matchAll(registryPattern)) {
      addConditionalApi('Registry operation (hive/ACL-dependent)', filePath, lineForOffset(match.index));
    }

    const eventPattern = /(?:window\.)?nova(?:OS)?\.(?:events\.(?:on|subscribe)|onEvent)\s*\(\s*(['"])([^'"]+)\1/g;
    for (const match of source.matchAll(eventPattern)) {
      for (const permission of _permissionsForEvent(match[2])) {
        addEvidence(permission, {
          path: filePath,
          line: lineForOffset(match.index),
          source: match[0],
          kind: 'Protected event subscription',
        });
      }
    }

    const requestPattern = /(?:window\.)?novaOS\.permissions\.request\s*\(\s*(['"])([a-zA-Z0-9_:.-]+)\1|window\.nova\.requestPermission\s*\(\s*(['"])([a-zA-Z0-9_:.-]+)\3/g;
    for (const match of source.matchAll(requestPattern)) {
      const permission = _canonicalPermission(match[2] || match[4]);
      if (PERMISSION_IDS.has(permission)) {
        addEvidence(permission, {
          path: filePath,
          line: lineForOffset(match.index),
          source: match[0],
          kind: 'Permission request',
        });
      }
    }

    const mediaPattern = /(?:window\.novaOS\.media\.getUserMedia|window\.nova\.getUserMedia)\s*\(([^)]*)\)/g;
    for (const match of source.matchAll(mediaPattern)) {
      const options = match[1];
      const mediaPermissions = [];
      if (/\bvideo\s*:\s*(?:true|\{)/.test(options)) mediaPermissions.push('device:camera');
      if (/\baudio\s*:\s*(?:true|\{)/.test(options)) mediaPermissions.push('device:microphone');
      if (!mediaPermissions.length) {
        addConditionalApi('Camera/microphone constraints (argument-dependent)', filePath, lineForOffset(match.index));
      }
      for (const permission of mediaPermissions) {
        addEvidence(permission, {
          path: filePath,
          line: lineForOffset(match.index),
          source: match[0],
          kind: 'Media API reference',
        });
      }
    }

    for (const [pattern, label] of [
      [/window\.novaOS\.fs\.(?:read|write|watch)\s*\(/g, 'Filesystem access (path-dependent)'],
      [/window\.novaOS\.media\.query\s*\(/g, 'Media query (type-dependent)'],
      [/(?:window\.)?fetch\s*\(/g, 'Network fetch (URL-dependent)'],
    ]) {
      for (const match of source.matchAll(pattern)) {
        addConditionalApi(label, filePath, lineForOffset(match.index));
      }
    }
  }

  return { evidence, unknownActions, conditionalApis, alternativeEvidence, stats };
}

function _auditRow(cls, icon, perm, label, evidence = []) {
  const row = document.createElement('div');
  row.className = `audit-row audit-row--${cls}`;

  const iconEl = document.createElement('span');
  iconEl.className = 'audit-icon';
  iconEl.innerHTML = _uiIcon(icon);

  const permEl = document.createElement('span');
  permEl.className = 'audit-perm';
  permEl.textContent = perm; // permission string from the .novaapp -- could be hostile

  const textCol = document.createElement('span');
  textCol.className = 'audit-text-col';

  const lbl = document.createElement('span');
  lbl.className = 'audit-label';
  lbl.textContent = label;
  textCol.appendChild(lbl);

  for (const reference of evidence) {
    const source = document.createElement('span');
    source.className = 'audit-source';
    source.textContent = `${reference.path}:${reference.line} · ${reference.kind}`;
    textCol.appendChild(source);
  }

  const known = _PERMISSION_MAP[perm];
  if (known?.description) {
    const why = document.createElement('span');
    why.className = 'audit-why';
    why.textContent = known.description;
    textCol.appendChild(why);
  }

  row.append(iconEl, permEl, textCol);
  return row;
}

function _renderPermissionAudit(declared, evidence, options = {}) {
  const evidenceMap = evidence instanceof Map
    ? evidence
    : new Map([...evidence].map((permission) => [permission, []]));
  const satisfiedBySuperset = new Set();
  if (declared.has('registry.system')) {
    for (const permission of ['registry.read', 'registry.write']) {
      const references = evidenceMap.get(permission);
      if (!references?.length) continue;
      satisfiedBySuperset.add(permission);
      evidenceMap.set('registry.system', [
        ...(evidenceMap.get('registry.system') || []),
        ...references,
      ].slice(0, _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION));
    }
  }
  const missingAlternatives = [];
  for (const group of options.alternativeEvidence?.values() || []) {
    const declaredAlternatives = group.permissions.filter((permission) => declared.has(permission));
    if (!declaredAlternatives.length) {
      missingAlternatives.push(group);
      continue;
    }
    for (const permission of declaredAlternatives) {
      evidenceMap.set(permission, [
        ...(evidenceMap.get(permission) || []),
        ...group.references,
      ].slice(0, _PACKAGE_AUDIT_MAX_REFS_PER_PERMISSION));
    }
  }
  const detected = new Set(evidenceMap.keys());
  const ok = [...declared].filter((permission) => detected.has(permission));
  const missing = [...detected].filter((permission) => !declared.has(permission) && !satisfiedBySuperset.has(permission));
  const unconfirmed = [...declared].filter((permission) => !detected.has(permission));

  const rows = [
    ...missing.map((permission) => _auditRow(
      'missing', 'alert', permission, 'Source reference found · not declared', evidenceMap.get(permission),
    )),
    ...missingAlternatives.map((group) => _auditRow(
      'missing', 'alert', group.permissions.join(' or '), 'Source reference found · declare one grant',
      group.references,
    )),
    ...ok.map((permission) => _auditRow(
      'ok', 'check', permission,
      `${options.optional?.has(permission) ? 'Optional' : 'Required'} · source reference found`,
      evidenceMap.get(permission),
    )),
    ...unconfirmed.map((permission) => _auditRow(
      'unused', 'alert', permission,
      `${options.optional?.has(permission) ? 'Optional' : 'Required'} · no static reference found`,
    )),
    ...(options.unknownDeclarations || []).map((permission) => _auditRow(
      'unused', 'alert', permission, 'Unknown to this Studio permission catalog',
    )),
  ];

  const card = document.createElement('div');
  card.className = 'inspector-card inspector-card--wide';

  const title = document.createElement('div');
  title.className = 'inspector-card-title';
  title.textContent = 'Permission Audit';
  card.appendChild(title);

  const summary = document.createElement('span');
  const undeclaredCount = missing.length + missingAlternatives.length;
  summary.className = `audit-summary ${undeclaredCount ? 'audit-summary--error' : 'audit-summary--warn'}`;
  summary.textContent = `${options.stats?.scannedFiles || 0} source files scanned · ${detected.size} permission${detected.size === 1 ? '' : 's'} with source references${undeclaredCount ? ` · ${undeclaredCount} not declared` : ''}`;
  card.appendChild(summary);

  const limitation = document.createElement('p');
  limitation.className = 'audit-limitation';
  limitation.textContent = 'Text-based static scan of JS/TS/HTML only: source references do not prove runtime use, and no match does not prove a permission is unused. Dynamic calls, template strings, path-dependent access, and behavior in skipped files may not be detected. Filesystem, registry, settings, media-query, and fetch calls with argument-dependent grants are listed separately.';
  card.appendChild(limitation);

  if (rows.length) {
    const list = document.createElement('div');
    list.className = 'audit-list';
    for (const row of rows) list.appendChild(row);
    card.appendChild(list);
  } else {
    const note = document.createElement('div');
    note.className = 'audit-limitation';
    note.textContent = 'No known permission declarations or source references were found.';
    card.appendChild(note);
  }

  const notes = [];
  if (options.stats?.skippedFiles) {
    notes.push(`${options.stats.skippedFiles} file${options.stats.skippedFiles === 1 ? '' : 's'} skipped (binary, oversized, invalid, or scan limit).`);
  }
  if (options.stats?.truncated) notes.push('Scan stopped at its configured file/size limit; results are incomplete.');
  if (options.unknownActions?.size) {
    notes.push(`${options.unknownActions.size} unmapped Nova IPC action${options.unknownActions.size === 1 ? '' : 's'} found; they may be custom actions or from a newer OS.`);
  }
  if (options.stats?.omittedUnknownActions) {
    notes.push(`${options.stats.omittedUnknownActions} additional unmapped action reference${options.stats.omittedUnknownActions === 1 ? '' : 's'} omitted.`);
  }
  if (options.invalidDeclarationCount) {
    notes.push(`${options.invalidDeclarationCount} malformed permission entr${options.invalidDeclarationCount === 1 ? 'y was' : 'ies were'} ignored.`);
  }
  if (options.duplicateCount) {
    notes.push(`${options.duplicateCount} duplicate permission entr${options.duplicateCount === 1 ? 'y' : 'ies'} found in the manifest.`);
  }
  if (notes.length) {
    const note = document.createElement('p');
    note.className = 'audit-limitation';
    note.textContent = notes.join(' ');
    card.appendChild(note);
  }

  if (options.unknownActions?.size) {
    const unknown = document.createElement('div');
    unknown.className = 'audit-unknown-actions';
    const examples = [...options.unknownActions].slice(0, 8)
      .map(([action, references]) => `${action} (${references[0].path}:${references[0].line})`);
    unknown.textContent = `Unmapped action strings: ${examples.join(', ')}`;
    card.appendChild(unknown);
  }
  if (options.omittedUnknownDeclarationCount) {
    const note = document.createElement('p');
    note.className = 'audit-limitation';
    note.textContent = `${options.omittedUnknownDeclarationCount} additional unknown permission declaration${options.omittedUnknownDeclarationCount === 1 ? '' : 's'} omitted.`;
    card.appendChild(note);
  }
  if (options.conditionalApis?.size) {
    const conditional = document.createElement('div');
    conditional.className = 'audit-conditional-apis';
    const examples = [...options.conditionalApis].map(([api, references]) =>
      `${api} (${references[0].path}:${references[0].line})`);
    conditional.textContent = `Argument-dependent APIs: ${examples.join(', ')}`;
    card.appendChild(conditional);
  }
  return card;
}

function _runProjectPermissionAudit() {
  const host = $('project-permission-audit-results');
  if (!host || !state.projectDir) return;
  const evidence = new Map();
  const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.htm', '.css', '.json']);
  try {
    walkProjectFiles(state.projectDir, (filePath, relativePath) => {
      if (!sourceExtensions.has(path.extname(relativePath).toLowerCase())) return;
      const source = fs.readFileSync(filePath, 'utf8');
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/nova:[a-zA-Z0-9:_-]+/g)) {
          for (const permission of _permissionsForChannel(match[0])) {
            if (!evidence.has(permission)) evidence.set(permission, []);
            const refs = evidence.get(permission);
            if (refs.length < 4) refs.push({ path: relativePath, line: index + 1, action: match[0] });
          }
        }
        for (const [pattern, permissions] of _PERMISSION_API_RULES) {
          const match = pattern.exec(line);
          if (!match) continue;
          for (const permission of permissions) {
            if (!evidence.has(permission)) evidence.set(permission, []);
            const refs = evidence.get(permission);
            if (refs.length < 4) refs.push({ path: relativePath, line: index + 1, action: match[0] });
          }
        }
        const mediaMatch = line.match(/window\.novaOS\.media\.getUserMedia\s*\(([^)]*)\)/);
        if (mediaMatch) {
          const mediaOptions = mediaMatch[1];
          const mediaPermissions = [];
          if (/\bvideo\s*:\s*(?:true|\{)/.test(mediaOptions)) mediaPermissions.push('device:camera');
          if (/\baudio\s*:\s*(?:true|\{)/.test(mediaOptions)) mediaPermissions.push('device:microphone');
          for (const permission of mediaPermissions) {
            if (!evidence.has(permission)) evidence.set(permission, []);
            const refs = evidence.get(permission);
            if (refs.length < 4) refs.push({ path: relativePath, line: index + 1, action: mediaMatch[0] });
          }
        }
      });
      for (const match of source.matchAll(/(?:window\.)?novaOS\.permissions\.request\s*\(\s*(['"])([a-zA-Z0-9_:.-]+)\1/g)) {
        const permission = _canonicalPermission(match[2]);
        if (!PERMISSION_IDS.has(permission)) continue;
        if (!evidence.has(permission)) evidence.set(permission, []);
        const refs = evidence.get(permission);
        if (refs.length < 4) {
          refs.push({
            path: relativePath,
            line: source.slice(0, match.index).split(/\r?\n/).length,
            action: `permissions.request(${match[2]})`,
          });
        }
      }
    });

    const manifest = readManifestForm();
    const declared = new Set([
      ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
      ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
    ].map(_canonicalPermission));
    const detected = new Set(evidence.keys());
    const missing = [...detected].filter((permission) => !declared.has(permission));
    const unused = [...declared].filter((permission) => !detected.has(permission));
    host.replaceChildren();

    const summary = document.createElement('p');
    summary.className = missing.length ? 'project-audit-summary project-audit-summary--warning' : 'project-audit-summary';
    summary.textContent = `${detected.size} permission${detected.size === 1 ? '' : 's'} inferred from source · ${missing.length} undeclared · ${unused.length} declared but not detected`;
    host.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'project-audit-list';
    for (const permission of [...new Set([...missing, ...[...detected].filter((id) => declared.has(id)), ...unused])].sort()) {
      const row = document.createElement('div');
      row.className = 'project-audit-row';
      const id = document.createElement('code');
      id.textContent = permission;
      const status = document.createElement('span');
      status.textContent = missing.includes(permission) ? 'Detected, not declared'
        : detected.has(permission) ? 'Declared and detected' : 'Declared, not detected';
      row.append(id, status);
      const refs = evidence.get(permission) || [];
      if (refs.length) {
        const source = document.createElement('small');
        source.textContent = refs.map((ref) => `${ref.path}:${ref.line} (${ref.action})`).join(' · ');
        row.appendChild(source);
      }
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = 'No NovaApp actions were detected in project source.';
      list.appendChild(empty);
    }
    host.appendChild(list);

    const addable = missing.filter((permission) => PERMISSION_IDS.has(permission));
    if (addable.length) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'action-btn action-btn--primary';
      add.textContent = `Add ${addable.length} detected permission${addable.length === 1 ? '' : 's'} as required`;
      add.addEventListener('click', async () => {
        for (const permission of addable) {
          _requiredPermissionIds.add(permission);
          _optionalPermissionIds.delete(permission);
        }
        renderPermissions();
        _onManifestFormChanged();
        if (await saveManifest()) _runProjectPermissionAudit();
      });
      host.appendChild(add);
    }
  } catch (error) {
    console.error('Project permission audit failed:', error);
    host.textContent = `Project scan failed: ${error.message}`;
  }
}

async function inspectFile(filePath) {
  let info, vResult, pkg;
  try {
    info = inspect(filePath);
    [vResult, pkg] = await Promise.all([
      verify(filePath),
      Promise.resolve(loadPackage(filePath)),
    ]);
  } catch (e) {
    $('inspector-dropzone').classList.remove('hidden');
    $('inspector-result').classList.add('hidden');
    await studioAlert('Failed to inspect file: ' + e.message, { title: 'Package inspection failed' });
    return;
  }

  const dropzone = $('inspector-dropzone');
  const result = $('inspector-result');
  dropzone.classList.add('hidden');
  result.classList.remove('hidden');
  result.replaceChildren();
  $('package-comparison')?.classList.add('hidden');
  $('package-comparison')?.replaceChildren();

  // Header
  const header = document.createElement('div');
  header.className = 'inspector-header';

  const headerText = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.className = 'inspector-app-name';
  nameEl.textContent = info.manifest?.name || 'Unknown';
  const idEl = document.createElement('div');
  idEl.className = 'inspector-app-id';
  idEl.textContent = info.manifest?.id || '';
  const signatureNote = document.createElement('div');
  signatureNote.className = 'inspector-signature-note';
  signatureNote.textContent = vResult.reason;
  headerText.append(nameEl, idEl, signatureNote);

  const badges = document.createElement('div');
  badges.className = 'inspector-badges';
  const sigBadge = document.createElement('span');
  sigBadge.className = vResult.valid
    ? 'badge badge--green'
    : info.hasSignature ? 'badge badge--red' : 'badge badge--gray';
  const signatureIcon = vResult.valid ? 'check' : info.hasSignature ? 'alert' : null;
  sigBadge.innerHTML = `${signatureIcon ? _uiIcon(signatureIcon) : ''}<span>${
    vResult.valid ? 'Trusted signature' : info.hasSignature ? 'Untrusted signature' : 'Unsigned'
  }</span>`;
  const formatBadge = document.createElement('span');
  formatBadge.className = 'badge badge--gray';
  formatBadge.textContent = info.format ? `Format ${info.format}` : 'Unknown format';
  badges.append(sigBadge, formatBadge);
  header.append(headerText, badges);
  result.appendChild(header);

  // Grid
  const grid = document.createElement('div');
  grid.className = 'inspector-grid';

  // Package info card
  const infoCard = document.createElement('div');
  infoCard.className = 'inspector-card';
  const infoTitle = document.createElement('div');
  infoTitle.className = 'inspector-card-title';
  infoTitle.textContent = 'Package Info';
  infoCard.appendChild(infoTitle);

  const infoKv = document.createElement('div');
  infoKv.className = 'inspector-kv';
  const infoRows = [
    ['Version', info.manifest?.version || '\u2014'],
    ['Format', info.format || '\u2014'],
    ['Files', String(info.fileCount)],
    ['Size', _formatSize(info.size)],
    ['Built at', info.compiledAt ? new Date(info.compiledAt).toLocaleString() : '\u2014'],
  ];
  for (const [k, v] of infoRows) {
    const row = document.createElement('div');
    row.className = 'inspector-row';
    const keyEl = document.createElement('span');
    keyEl.className = 'inspector-key';
    keyEl.textContent = k;
    const valEl = document.createElement('span');
    valEl.className = 'inspector-val';
    valEl.textContent = v;
    row.append(keyEl, valEl);
    infoKv.appendChild(row);
  }
  infoCard.appendChild(infoKv);
  grid.appendChild(infoCard);

  // A static source scan provides evidence, not proof of runtime use.
  const rawRequired = Array.isArray(info.manifest?.permissions) ? info.manifest.permissions : [];
  const rawOptional = Array.isArray(info.manifest?.optionalPermissions) ? info.manifest.optionalPermissions : [];
  const rawDeclarations = [...rawRequired, ...rawOptional];
  const declared = new Set();
  const optional = new Set();
  const required = new Set(rawRequired
    .filter((permission) => typeof permission === 'string' && permission.trim())
    .map((permission) => _canonicalPermission(permission.trim()))
    .filter((permission) => PERMISSION_IDS.has(permission)));
  const unknownDeclarations = new Set();
  let invalidDeclarationCount = 0;
  let duplicateCount = 0;
  let omittedUnknownDeclarationCount = 0;
  const seenDeclarations = new Set();
  for (const value of rawDeclarations) {
    if (typeof value !== 'string' || !value.trim()) {
      invalidDeclarationCount++;
      continue;
    }
    const permission = _canonicalPermission(value.trim());
    if (seenDeclarations.has(permission)) duplicateCount++;
    seenDeclarations.add(permission);
    if (PERMISSION_IDS.has(permission)) declared.add(permission);
    else if (unknownDeclarations.size < _PACKAGE_AUDIT_MAX_UNKNOWN_DECLARATIONS || unknownDeclarations.has(permission)) {
      unknownDeclarations.add(permission);
    } else omittedUnknownDeclarationCount++;
  }
  for (const value of rawOptional) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const permission = _canonicalPermission(value.trim());
    if (PERMISSION_IDS.has(permission) && !required.has(permission)) optional.add(permission);
  }
  const audit = _scanPackagePermissionEvidence(pkg);
  grid.appendChild(_renderPermissionAudit(declared, audit.evidence, {
    optional,
    unknownDeclarations: [...unknownDeclarations],
    unknownActions: audit.unknownActions,
    conditionalApis: audit.conditionalApis,
    alternativeEvidence: audit.alternativeEvidence,
    stats: audit.stats,
    invalidDeclarationCount,
    duplicateCount,
    omittedUnknownDeclarationCount,
  }));

  // Files card
  const filesCard = document.createElement('div');
  filesCard.className = 'inspector-card inspector-card--files';
  const filesTitle = document.createElement('div');
  filesTitle.className = 'inspector-card-title';
  filesTitle.textContent = `Files (${info.fileCount})`;
  filesCard.appendChild(filesTitle);

  const filesList = document.createElement('div');
  filesList.className = 'inspector-file-list';
  for (const f of info.files) {
    const div = document.createElement('div');
    div.className = 'inspector-file';
    div.textContent = f; // file names from a .novaapp are untrusted
    filesList.appendChild(div);
  }
  filesCard.appendChild(filesList);
  grid.appendChild(filesCard);

  result.appendChild(grid);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'inspector-actions';
  const another = document.createElement('button');
  another.className = 'action-btn action-btn--primary';
  another.id = 'btn-inspect-another';
  another.textContent = 'Inspect another';
  another.addEventListener('click', showInspector);
  const compare = document.createElement('button');
  compare.className = 'action-btn action-btn--ghost';
  compare.type = 'button';
  compare.textContent = 'Compare packages';
  compare.addEventListener('click', () => $('inspector-compare-files')?.click());
  footer.append(another, compare);
  result.appendChild(footer);
}

async function _renderPackageComparison(leftPath, rightPath) {
  const host = $('package-comparison');
  if (!host) return;
  host.classList.remove('hidden');
  host.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Package comparison';
  host.appendChild(heading);

  try {
    const [leftInfo, rightInfo] = [inspect(leftPath), inspect(rightPath)];
    const [leftPkg, rightPkg] = [loadPackage(leftPath), loadPackage(rightPath)];
    const [leftIntegrity, rightIntegrity] = await Promise.all([
      AppPackage.verifyIntegrity(leftPkg),
      AppPackage.verifyIntegrity(rightPkg),
    ]);

    const metadata = document.createElement('div');
    metadata.className = 'package-comparison-metadata';
    const rows = [
      ['Package', `${path.basename(leftPath)}  ↔  ${path.basename(rightPath)}`],
      ['App ID', `${leftInfo.manifest?.id || 'Unknown'}  ↔  ${rightInfo.manifest?.id || 'Unknown'}`],
      ['Version', `${leftInfo.manifest?.version || '—'}  ↔  ${rightInfo.manifest?.version || '—'}`],
      ['Package size', `${_formatSize(leftInfo.size)}  ↔  ${_formatSize(rightInfo.size)}`],
      ['Signature', `${leftInfo.hasSignature ? 'Present (trust not checked)' : 'Unsigned'}  ↔  ${rightInfo.hasSignature ? 'Present (trust not checked)' : 'Unsigned'}`],
      ['Integrity', `${leftPkg.integrity ? `${leftPkg.integrity.method}: ${leftIntegrity ? 'valid' : 'invalid'}` : 'Not recorded'}  ↔  ${rightPkg.integrity ? `${rightPkg.integrity.method}: ${rightIntegrity ? 'valid' : 'invalid'}` : 'Not recorded'}`],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const key = document.createElement('strong');
      key.textContent = label;
      const val = document.createElement('span');
      val.textContent = value;
      row.append(key, val);
      metadata.appendChild(row);
    }
    host.appendChild(metadata);

    const manifestDiff = document.createElement('section');
    manifestDiff.className = 'package-comparison-section';
    const manifestTitle = document.createElement('h3');
    manifestTitle.textContent = 'Manifest changes';
    manifestDiff.appendChild(manifestTitle);
    const manifestKeys = [...new Set([
      ...Object.keys(leftInfo.manifest || {}),
      ...Object.keys(rightInfo.manifest || {}),
    ])].sort();
    const changedManifest = manifestKeys.filter((key) =>
      JSON.stringify(leftInfo.manifest?.[key]) !== JSON.stringify(rightInfo.manifest?.[key]));
    if (changedManifest.length) {
      for (const key of changedManifest) {
        const row = document.createElement('p');
        row.textContent = `${key}: ${JSON.stringify(leftInfo.manifest?.[key] ?? null)} → ${JSON.stringify(rightInfo.manifest?.[key] ?? null)}`;
        manifestDiff.appendChild(row);
      }
    } else {
      const same = document.createElement('p');
      same.textContent = 'No manifest differences.';
      manifestDiff.appendChild(same);
    }
    host.appendChild(manifestDiff);

    const leftFiles = leftPkg.files || {};
    const rightFiles = rightPkg.files || {};
    const fileNames = [...new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)])].sort();
    const fileChanges = fileNames.flatMap((name) => {
      if (!(name in leftFiles)) return [{ name, status: 'Added' }];
      if (!(name in rightFiles)) return [{ name, status: 'Removed' }];
      return leftFiles[name] === rightFiles[name] ? [] : [{ name, status: 'Changed' }];
    });
    const filesSection = document.createElement('section');
    filesSection.className = 'package-comparison-section';
    const filesTitle = document.createElement('h3');
    filesTitle.textContent = `File changes (${fileChanges.length})`;
    filesSection.appendChild(filesTitle);
    if (fileChanges.length) {
      const list = document.createElement('ul');
      for (const change of fileChanges.slice(0, 500)) {
        const item = document.createElement('li');
        item.textContent = `${change.status}: ${change.name}`;
        list.appendChild(item);
      }
      if (fileChanges.length > 500) {
        const more = document.createElement('li');
        more.textContent = `…and ${fileChanges.length - 500} more`;
        list.appendChild(more);
      }
      filesSection.appendChild(list);
    } else {
      const same = document.createElement('p');
      same.textContent = 'Package file contents are identical.';
      filesSection.appendChild(same);
    }
    host.appendChild(filesSection);
  } catch (error) {
    console.error('Package comparison failed:', error);
    const message = document.createElement('p');
    message.className = 'package-comparison-error';
    message.textContent = `Could not compare packages: ${error.message}`;
    host.appendChild(message);
  }
}

// Recent projects
let _recentContextTarget = null; // dir of the recent item the menu was opened on

function addRecent(dir, name) {
  const existing = state.recentProjects.find((r) => r.dir === dir);
  const pinned = existing?.pinned || false;
  state.recentProjects = state.recentProjects.filter((r) => r.dir !== dir);
  state.recentProjects.unshift({ dir, name, time: Date.now(), pinned });
  _capUnpinnedRecents();
  saveStorage();
  renderRecent();
}

// Caps the unpinned portion of the list at 10 entries. Pinned items are
// exempt -- pinning is a deliberate "keep this" action, so the automatic
// recency cap shouldn't be able to silently evict something the user pinned.
function _capUnpinnedRecents() {
  const pinned = state.recentProjects.filter((r) => r.pinned);
  let unpinned = state.recentProjects.filter((r) => !r.pinned);
  if (unpinned.length > 10) unpinned = unpinned.slice(0, 10);
  state.recentProjects = [...pinned, ...unpinned];
}

function _buildRecentItem(r) {
  const item = document.createElement('div');
  item.className = 'recent-item';
  item.dataset.dir = r.dir;

  const nameEl = document.createElement('div');
  nameEl.className = 'recent-item-name';
  if (r.pinned) {
    const pinIcon = document.createElement('span');
    pinIcon.className = 'recent-item-pin';
    pinIcon.innerHTML = _uiIcon('pin');
    nameEl.appendChild(pinIcon);
  }
  nameEl.append(document.createTextNode(r.name));

  const pathEl = document.createElement('div');
  pathEl.className = 'recent-item-path';
  pathEl.textContent = r.dir;

  item.append(nameEl, pathEl);
  return item;
}

function renderRecent() {
  const pinnedSection = $('pinned-section');
  const pinnedList = $('pinned-list');
  const recentList = $('recent-list');

  const pinned = state.recentProjects.filter((r) => r.pinned);
  const unpinned = state.recentProjects.filter((r) => !r.pinned);

  // Pinned section only takes up sidebar space when something is pinned.
  if (pinned.length) {
    pinnedSection?.classList.remove('hidden');
    pinnedList?.replaceChildren();
    if (pinnedList) {
      for (const r of pinned) pinnedList.appendChild(_buildRecentItem(r));
      _wireRecentItems(pinnedList);
    }
  } else {
    pinnedSection?.classList.add('hidden');
    pinnedList?.replaceChildren();
  }

  if (!recentList) return;
  recentList.replaceChildren();
  if (unpinned.length) {
    for (const r of unpinned) recentList.appendChild(_buildRecentItem(r));
    _wireRecentItems(recentList);
  } else {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = 'No recent projects';
    recentList.appendChild(empty);
  }
}

function _wireRecentItems(container) {
  container.querySelectorAll('.recent-item').forEach((el) => {
    el.addEventListener('click', () => loadProject(el.dataset.dir));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showRecentContextMenu(e.clientX, e.clientY, el.dataset.dir);
    });
  });
}

function showRecentContextMenu(x, y, dir) {
  hideContextMenu(); // close the file-tree menu if it happens to be open
  hideEditorContextMenu();
  _recentContextTarget = dir;
  const entry = state.recentProjects.find((r) => r.dir === dir);
  const menu = $('recent-context-menu');

  const pinAction = $('rctx-pin');
  pinAction.replaceChildren();
  const pinIcon = document.createElement('span');
  pinIcon.innerHTML = _uiIcon('pin');
  pinAction.append(pinIcon, document.createTextNode(entry?.pinned ? ' Unpin' : ' Pin to top'));

  menu.classList.remove('hidden');
  const mw = 220, mh = 170;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideRecentContextMenu() {
  $('recent-context-menu').classList.add('hidden');
  _recentContextTarget = null;
}

function toggleRecentPin(dir) {
  const entry = state.recentProjects.find((r) => r.dir === dir);
  if (!entry) return;
  entry.pinned = !entry.pinned;
  _capUnpinnedRecents();
  saveStorage();
  renderRecent();
  showToast(entry.pinned ? 'Pinned' : 'Unpinned');
}

function removeRecent(dir) {
  state.recentProjects = state.recentProjects.filter((r) => r.dir !== dir);
  saveStorage();
  renderRecent();
  showToast('Removed from Recents');
}

async function copyRecentPath(dir) {
  try {
    await navigator.clipboard.writeText(dir);
    showToast('Path copied');
  } catch (e) {
    showToast('Could not copy path: ' + e.message);
  }
}

function revealRecentInFolder(dir) {
  try {
    if (typeof nw !== 'undefined' && nw.Shell?.showItemInFolder) {
      nw.Shell.showItemInFolder(dir);
    } else {
      showToast('Reveal in folder is not available in this environment');
    }
  } catch (e) {
    showToast('Could not open file explorer: ' + e.message);
  }
}

// Tabs
function _updateSidebarQuickAccess() {
  const hasProject = !!state.projectDir;
  const search = $('btn-sidebar-search');
  if (search) search.disabled = !hasProject;

  document.querySelectorAll('[data-sidebar-tab]').forEach((button) => {
    const active = hasProject && button.dataset.sidebarTab === state.activeTab;
    button.disabled = !hasProject;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const gitCount = $('sidebar-git-count');
  if (gitCount) {
    const count = state.gitStatus?.size || 0;
    gitCount.textContent = String(count);
    gitCount.classList.toggle('hidden', count === 0);
    gitCount.setAttribute('aria-label', `${count} changed file${count === 1 ? '' : 's'}`);
  }
}

function switchTab(name) {
  const previousTab = state.activeTab;
  if (name !== 'review' && document.fullscreenElement === $('panel-review')) {
    document.exitFullscreen().catch((error) => {
      console.error('Could not exit Preview fullscreen:', error);
      showToast('Could not exit fullscreen: ' + error.message);
    });
  }
  state.activeTab = name;
  if (previousTab !== name) {
    const detail = { previous: previousTab, current: name };
    _emitStudioPluginEvent('tab:change', detail);
    _emitStudioPluginEvent('view:change', detail);
  }
  _updateSidebarQuickAccess();
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('tab--active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel:not(.tab-panel--editor)').forEach((p) => p.classList.add('hidden'));
  if (name !== 'editor') {
    const pluginView = _studioPluginViews.get(name);
    (pluginView?.panel || document.getElementById('panel-' + name))?.classList.remove('hidden');
  }
  const previousPluginView = _studioPluginViews.get(previousTab);
  if (previousTab !== name && previousPluginView) {
    try {
      const result = previousPluginView.onHide?.(previousPluginView.api);
      if (result && typeof result.then === 'function') {
        result.catch((error) => console.error(`[plugins] View hide failed in ${previousPluginView.pluginId}:`, error));
      }
    } catch (error) {
      console.error(`[plugins] View hide failed in ${previousPluginView.pluginId}:`, error);
    }
  }
  const currentPluginView = _studioPluginViews.get(name);
  if (currentPluginView && previousTab !== name) {
    try {
      const result = currentPluginView.onShow?.(currentPluginView.api);
      if (result && typeof result.then === 'function') {
        result.catch((error) => console.error(`[plugins] View show failed in ${currentPluginView.pluginId}:`, error));
      }
    } catch (error) {
      console.error(`[plugins] View show failed in ${currentPluginView.pluginId}:`, error);
    }
  }
  if (name === 'git') refreshGitPanel();
  if (name === 'sign') _updateSignStatusStrip();
  if (name === 'build') _updateBuildSummary();
  if (name === 'permissions' && state.projectDir) {
    const fresh = _readManifest(state.projectDir);
    if (fresh && !fresh._error) populateManifestForm(fresh);
  }
  if (name === 'review') renderReviewPreview();
  if (name === 'design') {
    $('design-fullscreen')?.classList.add('design-fullscreen--open');
    // -webkit-app-region: drag on .titlebar hijacks hit-testing at the OS
    // compositor level regardless of z-index, so painting the fullscreen
    // overlay above it isn't enough on its own -- the titlebar's drag
    // region has to actually be turned off while design mode is open, or
    // clicks near the top of the canvas/toolbar keep getting swallowed by
    // the (now invisible) titlebar underneath.
    $('titlebar')?.classList.add('titlebar--suppressed');
    _designLoadFrame();
  } else {
    // Leaving the design tab: drop the fixed-position takeover and close
    // whichever popup happened to be open, so re-entering later starts clean.
    $('design-fullscreen')?.classList.remove('design-fullscreen--open');
    $('titlebar')?.classList.remove('titlebar--suppressed');
    $('design-dpi-popup')?.classList.add('hidden');
    $('design-window-popup')?.classList.add('hidden');
    // NBPro's own modals (AST Diff, Grid Areas, Save Component, etc.) are
    // appended straight to document.body by design-pro.js, not nested
    // inside .design-fullscreen -- so they never got auto-hidden here and
    // could stay open, floating above whatever tab you switched to next.
    document.querySelectorAll('.nbpro-modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
  }
}

function renderReviewPreview() {
  const frame = $('review-body-frame');
  const win = $('review-window');
  const stage = $('review-stage');
  if (!frame || !win || !stage) return;

  $('review-titlebar-text').textContent = ($('mf-name')?.value || '').trim() || 'Untitled App';
  const icon = $('mf-icon-img')?.dataset?.uri || '';
  const iconEl = $('review-titlebar-icon');
  iconEl.src = icon;
  iconEl.style.display = icon ? '' : 'none';

  const width = parseInt($('mf-width')?.value, 10) || 800;
  const height = parseInt($('mf-height')?.value, 10) || 560;
  const manifestSize = `${width}x${height}`;
  if (win.dataset.manifestSize !== manifestSize) {
    win.dataset.manifestSize = manifestSize;
    delete win.dataset.userWidth;
    delete win.dataset.userHeight;
    win.dataset.previewPreset = 'manifest';
  }
  const previewWidth = parseInt(win.dataset.userWidth, 10) || width;
  const previewHeight = parseInt(win.dataset.userHeight, 10) || height;
  const bounds = stage.getBoundingClientRect();
  const scale = Math.min(1, (bounds.width - 40) / previewWidth, (bounds.height - 40) / previewHeight);
  win.style.width = `${previewWidth}px`;
  win.style.height = `${previewHeight}px`;
  win.style.transform = `scale(${scale})`;
  $('review-viewport-size').textContent = `${previewWidth} × ${previewHeight}`;
  document.querySelectorAll('[data-review-preset]').forEach((button) => {
    const active = button.dataset.reviewPreset === (win.dataset.previewPreset || 'manifest');
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (win.dataset.positionInitialized !== '1') {
    win.style.left = `${Math.max(0, (bounds.width - previewWidth * scale) / 2)}px`;
    win.style.top = `${Math.max(0, (bounds.height - previewHeight * scale) / 2)}px`;
    win.dataset.positionInitialized = '1';
  }

  win.classList.toggle('review-window--frameless', $('mf-frame')?.checked === false);
  win.classList.toggle('review-window--transparent', !!$('mf-transparent')?.checked);
  win.classList.toggle('review-window--no-resize', $('mf-resizable')?.checked === false);
  const simulateApis = !!$('chk-review-simulate-apis')?.checked;
  $('review-simulation-note').textContent = simulateApis
    ? 'Studio API simulation is enabled; prompts and responses are synthetic, not NBOSP behavior.'
    : 'Preview does not emulate NBOSP. API simulation is off.';
  $('review-simulation-log')?.classList.toggle('hidden', !simulateApis);
  setupReviewWindowInteractions();

  if (!state.projectDir) {
    $('review-entry-path').textContent = 'No project';
    frame.srcdoc = '<body style="margin:0;padding:24px;font:13px system-ui;color:#8b949e;background:#0d1117;">No project open</body>';
    return;
  }

  const entry = $('mf-entry')?.value.trim() || 'index.html';
  $('review-entry-path').textContent = entry;
  try {
    const entryPath = path.resolve(state.projectDir, entry);
    const relativeEntry = path.relative(state.projectDir, entryPath);
    if (relativeEntry.startsWith('..' + path.sep) || relativeEntry === '..' || path.isAbsolute(relativeEntry)) {
      throw new Error('The entry file must be inside the project folder.');
    }
    const html = fs.readFileSync(entryPath, 'utf8');
    const base = `<base href="${pathToFileURL(path.dirname(entryPath) + path.sep).href}">`;
    const simulationScript = simulateApis ? `<script>${_reviewSimulationBootstrap()}<\/script>` : '';
    const headContent = `${base}${simulationScript}`;
    if (/<head\b[^>]*>/i.test(html)) {
      frame.srcdoc = html.replace(/<head\b[^>]*>/i, (head) => `${head}${headContent}`);
    } else if (/<html\b[^>]*>/i.test(html)) {
      frame.srcdoc = html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${headContent}</head>`);
    } else {
      frame.srcdoc = `<head>${headContent}</head>${html}`;
    }
  } catch (error) {
    frame.srcdoc = `<body style="margin:0;padding:24px;font:13px system-ui;color:#8b949e;background:#0d1117;">Could not load project preview: ${_escHtml(error.message)}</body>`;
  }
}

function _setReviewPreset(preset) {
  const win = $('review-window');
  if (!win) return;
  const sizes = {
    manifest: [parseInt($('mf-width')?.value, 10) || 800, parseInt($('mf-height')?.value, 10) || 560],
    tablet: [768, 1024],
    phone: [390, 844],
    landscape: [1024, 768],
  };
  const size = sizes[preset];
  if (!size) return;
  win.dataset.manifestSize = `${parseInt($('mf-width')?.value, 10) || 800}x${parseInt($('mf-height')?.value, 10) || 560}`;
  win.dataset.previewPreset = preset;
  win.dataset.userWidth = String(size[0]);
  win.dataset.userHeight = String(size[1]);
  $('review-custom-width').value = String(size[0]);
  $('review-custom-height').value = String(size[1]);
  renderReviewPreview();
  _centerReviewWindow();
}

const REVIEW_SIZES_KEY = 'novapack_review_sizes';

function _readReviewSizes() {
  try {
    const sizes = JSON.parse(localStorage.getItem(REVIEW_SIZES_KEY) || '[]');
    if (!Array.isArray(sizes)) throw new Error('Saved preview sizes are not a list.');
    return sizes.filter((size) => size && typeof size.name === 'string'
      && size.name.trim().length > 0 && size.name.length <= 40
      && Number.isInteger(size.width) && size.width >= 200 && size.width <= 4000
      && Number.isInteger(size.height) && size.height >= 150 && size.height <= 3000).slice(0, 8);
  } catch (error) {
    console.error('Could not read saved preview sizes:', error);
    showToast('Could not read saved preview sizes');
    return [];
  }
}

function _renderReviewSizes() {
  const host = $('review-saved-sizes');
  if (!host) return;
  host.replaceChildren();
  for (const size of _readReviewSizes()) {
    const group = document.createElement('span');
    group.className = 'review-saved-size';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'review-tool-btn';
    button.textContent = size.name;
    button.title = `${size.width} × ${size.height}`;
    button.addEventListener('click', () => _applyReviewSize(size.width, size.height));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'review-size-remove';
    remove.setAttribute('aria-label', `Remove saved preview size ${size.name}`);
    remove.innerHTML = _uiIcon('close');
    remove.addEventListener('click', () => {
      const remaining = _readReviewSizes().filter((saved) => saved.name !== size.name);
      try {
        localStorage.setItem(REVIEW_SIZES_KEY, JSON.stringify(remaining));
        _renderReviewSizes();
      } catch (error) {
        console.error('Could not remove saved preview size:', error);
        showToast(`Could not remove saved preview size: ${error.message}`);
      }
    });
    group.append(button, remove);
    host.appendChild(group);
  }
}

function _applyReviewSize(width, height) {
  const win = $('review-window');
  if (!win) return;
  win.dataset.manifestSize = `${parseInt($('mf-width')?.value, 10) || 800}x${parseInt($('mf-height')?.value, 10) || 560}`;
  win.dataset.previewPreset = 'custom';
  win.dataset.userWidth = String(width);
  win.dataset.userHeight = String(height);
  $('review-custom-width').value = String(width);
  $('review-custom-height').value = String(height);
  renderReviewPreview();
  _centerReviewWindow();
}

async function _saveReviewSize() {
  const name = (await studioPrompt('Choose a name for this preview size.', '', {
    title: 'Save preview size',
    confirmLabel: 'Save size',
    maxLength: 40,
  }))?.trim();
  if (!name) return;
  if (name.length > 40) {
    showToast('Preview size names must be 40 characters or fewer');
    return;
  }
  const width = Number($('review-custom-width').value);
  const height = Number($('review-custom-height').value);
  if (!Number.isInteger(width) || width < 200 || width > 4000
    || !Number.isInteger(height) || height < 150 || height > 3000) {
    showToast('Preview dimensions must be width 200–4000 and height 150–3000');
    return;
  }
  const sizes = _readReviewSizes().filter((size) => size.name.toLowerCase() !== name.toLowerCase());
  if (sizes.length >= 8) {
    showToast('You can save up to 8 preview sizes. Remove one before saving another.');
    return;
  }
  sizes.push({ name, width, height });
  try {
    localStorage.setItem(REVIEW_SIZES_KEY, JSON.stringify(sizes));
    _renderReviewSizes();
  } catch (error) {
    console.error('Could not save preview size:', error);
    showToast(`Could not save preview size: ${error.message}`);
  }
}

function _reviewSimulationBootstrap() {
  return `(() => {
    let requestId = 0;
    const pending = new Map();
    const report = (action, approved) => {
      parent.postMessage({ __novapackSimulation: true, action, approved }, '*');
    };
    window.addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.__novapackSimulationResponse !== true) return;
      const resolve = pending.get(event.data.requestId);
      if (!resolve) return;
      pending.delete(event.data.requestId);
      resolve(event.data.approved === true);
    });
    const request = async (action, args) => {
      const id = 'simulation-' + (++requestId);
      const approved = await new Promise((resolve) => {
        pending.set(id, resolve);
        parent.postMessage({ __novapackSimulation: true, requestId: id, action }, '*');
      });
      report(action, approved);
      if (!approved) throw new Error('Simulated request denied: ' + action);
      return { simulated: true, action, args };
    };
    const makeProxy = (root, segments = []) => new Proxy(function () {}, {
      get(_target, key) {
        if (key === 'then' || key === 'toJSON') return undefined;
        return makeProxy(root, [...segments, String(key)]);
      },
      apply(_target, _this, args) {
        return request([root, ...segments].join('.'), args);
      }
    });
    window.nova = new Proxy({ ipc: request }, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'then' || key === 'toJSON') return undefined;
        return makeProxy('nova', [String(key)]);
      }
    });
    window.novaOS = makeProxy('novaOS');
  })();`;
}

function _centerReviewWindow() {
  const win = $('review-window');
  const stage = $('review-stage');
  if (!win || !stage) return;
  const bounds = stage.getBoundingClientRect();
  const match = /scale\(([^)]+)\)/.exec(win.style.transform);
  const scale = match ? Number(match[1]) || 1 : 1;
  win.style.left = `${Math.max(0, (bounds.width - win.offsetWidth * scale) / 2)}px`;
  win.style.top = `${Math.max(0, (bounds.height - win.offsetHeight * scale) / 2)}px`;
  win.dataset.positionInitialized = '1';
}

function _initReviewPreviewControls() {
  document.querySelectorAll('[data-review-preset]').forEach((button) => {
    button.addEventListener('click', () => _setReviewPreset(button.dataset.reviewPreset));
  });
  $('btn-review-center')?.addEventListener('click', _centerReviewWindow);
  $('btn-review-refresh')?.addEventListener('click', renderReviewPreview);
  $('btn-review-custom-size')?.addEventListener('click', () => {
    const width = Number($('review-custom-width').value);
    const height = Number($('review-custom-height').value);
    if (!Number.isInteger(width) || width < 200 || width > 4000
      || !Number.isInteger(height) || height < 150 || height > 3000) {
      showToast('Preview dimensions must be width 200–4000 and height 150–3000');
      return;
    }
    _applyReviewSize(width, height);
  });
  $('btn-review-save-size')?.addEventListener('click', _saveReviewSize);
  $('chk-review-simulate-apis')?.addEventListener('change', () => {
    const log = $('review-simulation-log');
    if (log) log.replaceChildren();
    renderReviewPreview();
  });
  _renderReviewSizes();
  window.addEventListener('message', async (event) => {
    const frame = $('review-body-frame');
    const data = event.data;
    if (event.source !== frame?.contentWindow || data?.__novapackSimulation !== true) return;
    if (typeof data.requestId === 'string') {
      const approved = await studioConfirm(
        `Allow the preview to simulate “${String(data.action || 'Unknown action')}”? This is a mock response only; no NovaByte OS API is called.`,
        { title: 'Review simulated API request', confirmLabel: 'Allow simulation', cancelLabel: 'Deny' },
      );
      if (frame.contentWindow) {
        frame.contentWindow.postMessage({
          __novapackSimulationResponse: true,
          requestId: data.requestId,
          approved,
        }, '*');
      }
      return;
    }
    const log = $('review-simulation-log');
    if (!log) return;
    const row = document.createElement('div');
    row.textContent = `${data.approved ? 'SIMULATED ALLOW' : 'SIMULATED DENY'} · ${String(data.action || 'Unknown action')}`;
    log.prepend(row);
    while (log.childElementCount > 12) log.lastElementChild.remove();
  });
  $('btn-review-fullscreen')?.addEventListener('click', async () => {
    const panel = $('panel-review');
    if (!panel) return;
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen();
      else if (panel.requestFullscreen) await panel.requestFullscreen();
      else showToast('Fullscreen is not supported in this environment');
    } catch (error) {
      console.error('Could not toggle Preview fullscreen:', error);
      showToast('Could not toggle fullscreen: ' + error.message);
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const panel = $('panel-review');
    const button = $('btn-review-fullscreen');
    if (!panel || !button) return;
    const active = document.fullscreenElement === panel;
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? 'Exit fullscreen (Esc)' : 'Expand preview to fullscreen';
    const label = button.querySelector('span');
    if (label) label.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    if (active || state.activeTab === 'review') {
      renderReviewPreview();
      _centerReviewWindow();
    }
  });
}

function setupReviewWindowInteractions() {
  const win = $('review-window');
  const stage = $('review-stage');
  const titlebar = $('review-titlebar');
  const handle = $('review-resize-handle');
  if (!win || !stage) return;

  if (titlebar && titlebar.dataset.dragBound !== '1') {
    titlebar.dataset.dragBound = '1';
    titlebar.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.review-controls')) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = parseFloat(win.style.left) || 0;
      const startTop = parseFloat(win.style.top) || 0;
      const match = /scale\(([^)]+)\)/.exec(win.style.transform);
      const scale = match ? Number(match[1]) || 1 : 1;
      const move = (moveEvent) => {
        const bounds = stage.getBoundingClientRect();
        const scaledWidth = win.offsetWidth * scale;
        const scaledHeight = win.offsetHeight * scale;
        win.style.left = `${Math.max(0, Math.min(bounds.width - scaledWidth, startLeft + (moveEvent.clientX - startX) / scale))}px`;
        win.style.top = `${Math.max(0, Math.min(bounds.height - scaledHeight, startTop + (moveEvent.clientY - startY) / scale))}px`;
      };
      const end = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
      event.preventDefault();
    });
  }

  if (handle && handle.dataset.resizeBound !== '1') {
    handle.dataset.resizeBound = '1';
    handle.addEventListener('pointerdown', (event) => {
      if (win.classList.contains('review-window--no-resize')) return;
      const match = /scale\(([^)]+)\)/.exec(win.style.transform);
      const scale = match ? Number(match[1]) || 1 : 1;
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = win.offsetWidth;
      const startHeight = win.offsetHeight;
      const move = (moveEvent) => {
        const minWidth = parseInt($('mf-min-width')?.value, 10) || 200;
        const minHeight = parseInt($('mf-min-height')?.value, 10) || 150;
        const maxWidth = parseInt($('mf-max-width')?.value, 10) || 4000;
        const maxHeight = parseInt($('mf-max-height')?.value, 10) || 3000;
        const nextWidth = Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + (moveEvent.clientX - startX) / scale)));
        const nextHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(startHeight + (moveEvent.clientY - startY) / scale)));
        win.dataset.userWidth = String(nextWidth);
        win.dataset.userHeight = String(nextHeight);
        win.style.width = `${nextWidth}px`;
        win.style.height = `${nextHeight}px`;
      };
      const end = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        win.dataset.previewPreset = 'custom';
        $('review-custom-width').value = win.dataset.userWidth || '';
        $('review-custom-height').value = win.dataset.userHeight || '';
        renderReviewPreview();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
      event.preventDefault();
      event.stopPropagation();
    });
  }
}

// New project modal
//
// _npPlaceholderValues holds the current value of any per-template
// placeholder fields (currently just `url` for Web App Wrapper) keyed by
// field key, separate from state so it resets cleanly per modal-open
// without needing to touch the persisted app state shape.
let _npPlaceholderValues = {};
let _npSelectedFile = null; // filename currently shown in the preview pane
let _npActiveTemplateCategory = 'all';
let _npTemplateSource = 'studio';
let _npCommunityTemplateCatalog = [];
let _npCommunityTemplateCatalogLoaded = false;
let _npCommunityTemplateCatalogLoading = false;
let _npCommunityTemplateCategory = 'all';
let _npCommunityTemplateSort = 'recent';
const USER_TEMPLATES_KEY = 'novapack_user_templates';
const USER_TEMPLATE_FORMAT = 'novapack-studio-user-template';
const USER_TEMPLATE_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="16" fill="#15263d"/><path d="M17 20h30v24H17zM17 27h30M25 20v24M39 20v24" fill="none" stroke="#58a6ff" stroke-width="3" stroke-linejoin="round"/></svg>')}`;

function _readUserTemplates() {
  try {
    const entries = JSON.parse(localStorage.getItem(USER_TEMPLATES_KEY) || '[]');
    if (!Array.isArray(entries)) throw new Error('Stored user templates are not a list.');
    return entries.flatMap((entry) => {
      try {
        if (!entry || typeof entry.id !== 'string') return [];
        if (entry.communityBundle) {
          const bundle = validateCommunityTemplateBundle(entry.communityBundle, entry.communityListing);
          const template = _validateUserTemplate(bundle);
          if (entry.communityListing && (
            typeof entry.communityId !== 'string' || typeof entry.communityVersion !== 'string'
            || entry.communityId !== entry.communityListing.id
            || entry.communityVersion !== entry.communityListing.version
          )) {
            throw new Error('Saved community template catalog identity is invalid.');
          }
          return [{
            ...template,
            id: entry.id,
            communityId: entry.communityId,
            communityVersion: entry.communityVersion,
            communityListing: entry.communityListing,
            communityBundle: bundle,
            verified: true,
          }];
        }
        return [{
          ..._validateUserTemplate({
            format: USER_TEMPLATE_FORMAT,
            version: 1,
            template: entry,
          }),
          id: entry.id,
        }];
      } catch (error) {
        console.error('Ignoring an invalid saved starter template:', error);
        return [];
      }
    });
  } catch (error) {
    console.error('Could not read user templates:', error);
    showToast('Could not read saved user templates');
    return [];
  }
}

function _npTemplateEntries() {
  return [...Object.entries(TEMPLATES), ..._readUserTemplates().map((entry) => [entry.id, {
    name: entry.name,
    description: entry.description,
    icon: USER_TEMPLATE_ICON,
    permissions: entry.manifest.permissions || [],
    optionalPermissions: entry.manifest.optionalPermissions || [],
    permissionReasons: entry.manifest.permissionReasons || {},
    userTemplate: entry,
    verified: entry.verified === true,
    files: Object.fromEntries(Object.entries(entry.files).map(([filename, encoded]) =>
      [filename, () => Buffer.from(encoded, 'base64').toString('utf8')]))
  }])];
}

function _npGetTemplate(id) {
  return _npTemplateEntries().find(([key]) => key === id)?.[1] || null;
}

function _userTemplateExport(entry) {
  if (entry.communityBundle) return JSON.stringify(entry.communityBundle, null, 2);
  return JSON.stringify({
    format: USER_TEMPLATE_FORMAT,
    version: 1,
    template: {
      name: entry.name,
      description: entry.description,
      author: entry.author || '',
      releaseVersion: entry.releaseVersion || '1.0.0',
      category: entry.category || 'custom',
      icon: entry.icon || 'box',
      manifest: entry.manifest,
      files: entry.files,
    },
  }, null, 2);
}

function _validateUserTemplate(bundle) {
  const template = bundle?.template;
  if (bundle?.format !== USER_TEMPLATE_FORMAT || bundle.version !== 1
    || !template || typeof template.name !== 'string'
    || typeof template.description !== 'string' || typeof template.files !== 'object'
    || !template.files || Array.isArray(template.files)
    || !template.manifest || typeof template.manifest !== 'object' || Array.isArray(template.manifest)) {
    throw new Error('Invalid NovaByte Studio starter template file.');
  }
  const name = template.name.trim();
  if (!name || name.length > 80 || template.description.length > 240
    || (template.author != null && (typeof template.author !== 'string' || template.author.length > 80))
    || (template.category != null && (typeof template.category !== 'string' || template.category.length > 40))) {
    throw new Error('Starter name must be 1–80 characters and description at most 240 characters.');
  }
  const releaseVersion = template.releaseVersion || '1.0.0';
  if (!semver.valid(releaseVersion)) throw new Error('Starter release version must be valid SemVer.');
  if (Buffer.byteLength(JSON.stringify(template.manifest), 'utf8') > 256 * 1024) {
    throw new Error('Starter manifest exceeds the 256 KB limit.');
  }
  const files = {};
  let totalBytes = 0;
  const names = Object.keys(template.files);
  if (names.length > 1000) throw new Error('Starter contains too many files.');
  for (const filename of names) {
    const normalized = validateTemplateFilePath(filename);
    const encoded = template.files[filename];
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Invalid file data for ${filename}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error(`Invalid file data for ${filename}`);
    totalBytes += bytes.length;
    if (totalBytes > 2 * 1024 * 1024) throw new Error('Starter files exceed the 2 MB import limit.');
    files[normalized] = encoded;
  }
  if (!names.length) throw new Error('Starter must include at least one project file.');
  return {
    id: `user:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: template.description,
    author: typeof template.author === 'string' ? template.author.trim() : '',
    releaseVersion,
    category: typeof template.category === 'string' ? template.category.trim() : 'custom',
    icon: typeof template.icon === 'string' ? template.icon.slice(0, 100) : 'box',
    manifest: template.manifest,
    files,
    verified: false,
  };
}

async function _saveOpenProjectAsTemplate() {
  if (!state.projectDir) {
    showToast('Open a project before saving it as a starter');
    return;
  }
  const name = (await studioPrompt('Choose a name for this starter template.', '', {
    title: 'Save project as starter',
    confirmLabel: 'Save starter',
    maxLength: 80,
  }))?.trim();
  if (!name) return;
  if (name.length > 80) {
    showToast('Starter name must be at most 80 characters');
    return;
  }
  const projectRoot = path.resolve(state.projectDir);
  const unsaved = tabs.filter((tab) => {
    if (!tab.isDirty || IMAGE_EXTS.has(path.extname(tab.filePath).toLowerCase())) return false;
    const relative = path.relative(projectRoot, path.resolve(tab.filePath));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (unsaved.length) {
    showToast(`Save or resolve open edits before creating a starter: ${unsaved.map((tab) => path.basename(tab.filePath)).join(', ')}`);
    return;
  }
  try {
    const formManifest = readManifestForm();
    if (!formManifest.id || !formManifest.name) {
      showToast('App ID and name are required before saving a starter');
      return;
    }
    if (!await saveManifest()) return;
    const manifest = _readManifest(state.projectDir);
    if (!manifest || manifest._error || JSON.stringify(manifest) !== JSON.stringify(formManifest)) {
      showToast('Could not save the current manifest; starter was not created');
      return;
    }
    const description = manifest.description || `Starter based on ${manifest.name || path.basename(state.projectDir)}`;
    if (description.length > 240) {
      showToast('Starter description must be at most 240 characters');
      return;
    }
    const files = {};
    let totalBytes = 0;
    walkProjectFiles(state.projectDir, (full, rel) => {
      const buffer = fs.readFileSync(full);
      totalBytes += buffer.length;
      if (totalBytes > 2 * 1024 * 1024) throw new Error('Project files exceed the 2 MB starter limit.');
      files[rel] = buffer.toString('base64');
    });
    const entry = _validateUserTemplate({
      format: USER_TEMPLATE_FORMAT,
      version: 1,
      template: {
        name,
        description,
        author: manifest.author || '',
        releaseVersion: '1.0.0',
        category: 'custom',
        icon: manifest.icon || 'box',
        manifest,
        files,
      },
    });
    const templates = _readUserTemplates().filter((item) => item.name.toLowerCase() !== entry.name.toLowerCase());
    templates.push(entry);
    localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(templates));
    state.selectedTemplate = entry.id;
    _npRenderTemplateCategories();
    _npRenderTemplateGallery();
    _renderNewProjectPreview();
    showToast(`Saved “${entry.name}” as a starter. Project files are stored locally in Studio settings.`);
  } catch (error) {
    console.error('Could not save project as a starter template:', error);
    showToast(`Could not save starter: ${error.message}`);
  }
}

function _importUserTemplate(filePath) {
  try {
    if (fs.statSync(filePath).size > 4 * 1024 * 1024) {
      throw new Error('Starter template file exceeds the 4 MB import limit.');
    }
    const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const imported = bundle?.signature
      ? {
        ..._validateUserTemplate(validateCommunityTemplateBundle(bundle)),
        communityBundle: bundle,
        verified: true,
      }
      : _validateUserTemplate(bundle);
    const templates = _readUserTemplates().filter((entry) => entry.name.toLowerCase() !== imported.name.toLowerCase());
    templates.push(imported);
    localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(templates));
    state.selectedTemplate = imported.id;
    _npRenderTemplateCategories();
    _npRenderTemplateGallery();
    _renderNewProjectPreview();
    showToast(`Imported starter “${imported.name}”`);
  } catch (error) {
    console.error('Could not import starter template:', error);
    showToast(`Could not import starter: ${error.message}`);
  }
}

function _exportSelectedUserTemplate() {
  const entry = _readUserTemplates().find((item) => item.id === state.selectedTemplate);
  if (!entry) {
    showToast('Select one of your saved or imported starters first');
    return;
  }
  pickFolder((dir) => {
    const filePath = path.join(dir, `${entry.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'starter'}.nbtemplate`);
    try {
      fs.writeFileSync(filePath, _userTemplateExport(entry), { flag: 'wx' });
      showToast(`Starter exported to ${filePath}`);
    } catch (error) {
      console.error('Could not export starter template:', error);
      showToast(`Could not export starter: ${error.message}`);
    }
  });
}

const _npApiTemplateKeys = new Set([
  'notifications-api', 'alarms-api', 'clipboard-api', 'dialogs-api',
  'app-integration-api', 'settings-window-api', 'device-apis',
  'calendar-contacts-api', 'data-backup-api', 'events-lifecycle-api',
  'secrets-api', 'share-target-api',
]);
const _npTemplateCategories = [
  { id: 'all', label: 'All starters' },
  { id: 'api', label: 'NovaApp APIs' },
  { id: 'apps', label: 'App foundations' },
  { id: 'web', label: 'Web & content' },
  { id: 'native', label: 'Games & native' },
  { id: 'custom', label: 'Custom' },
];

function _npCategoryKey(category) {
  const normalized = String(category || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const aliases = {
    api: 'api',
    'novaapp api': 'api',
    'novaapp apis': 'api',
    app: 'apps',
    apps: 'apps',
    general: 'apps',
    'app foundations': 'apps',
    web: 'web',
    'web content': 'web',
    'web & content': 'web',
    native: 'native',
    'games native': 'native',
    'games & native': 'native',
    custom: 'custom',
  };
  return Object.hasOwn(aliases, normalized)
    ? aliases[normalized]
    : normalized ? `user-category:${normalized}` : 'custom';
}

function _npGetTemplateCategory(key, template) {
  if (key.startsWith('user:')) return _npCategoryKey(template?.userTemplate?.category);
  if (_npApiTemplateKeys.has(key)) return 'api';
  if (key === 'native-cpp' || key === 'game') return 'native';
  if (['webapp', 'browser', 'dashboard', 'markdown-viewer', 'chat'].includes(key)) return 'web';
  return 'apps';
}

function _npGetTemplateCategories(entries) {
  const categories = [..._npTemplateCategories];
  const known = new Set(categories.map((category) => category.id));
  const custom = new Map();
  for (const [key, template] of entries) {
    if (!key.startsWith('user:')) continue;
    const category = typeof template.userTemplate?.category === 'string'
      ? template.userTemplate.category.trim()
      : '';
    const id = _npGetTemplateCategory(key, template);
    if (!known.has(id) && category) custom.set(id, category);
  }
  return categories.concat([...custom]
    .sort(([, left], [, right]) => left.localeCompare(right))
    .map(([id, label]) => ({ id, label })));
}

function _npRenderTemplateCategories() {
  const nav = $('np-categories');
  nav.replaceChildren();
  const entries = _npTemplateEntries();
  const categories = _npGetTemplateCategories(entries);
  if (!categories.some((category) => category.id === _npActiveTemplateCategory)) {
    _npActiveTemplateCategory = 'all';
  }
  for (const category of categories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'np-category' + (_npActiveTemplateCategory === category.id ? ' active' : '');
    button.setAttribute('aria-pressed', String(_npActiveTemplateCategory === category.id));
    const label = document.createElement('span');
    label.textContent = category.label;
    const count = document.createElement('span');
    count.className = 'np-category-count';
    count.textContent = String(category.id === 'all'
      ? entries.length
      : entries.filter(([key, template]) => _npGetTemplateCategory(key, template) === category.id).length);
    button.append(label, count);
    button.addEventListener('click', () => {
      _npActiveTemplateCategory = category.id;
      _npRenderTemplateCategories();
      _npRenderTemplateGallery();
    });
    nav.appendChild(button);
  }
}

function _npRenderTemplateGallery() {
  const grid = $('template-grid');
  const query = $('np-template-search').value.trim().toLowerCase();
  const allEntries = _npTemplateEntries();
  const categories = _npGetTemplateCategories(allEntries);
  const category = categories.find((item) => item.id === _npActiveTemplateCategory);
  $('np-category-title').textContent = category?.label || 'All starters';
  grid.replaceChildren();

  const entries = allEntries
    .filter(([key, tpl]) => _npActiveTemplateCategory === 'all'
      || _npGetTemplateCategory(key, tpl) === _npActiveTemplateCategory)
    .filter(([, tpl]) => !query
      || tpl.name.toLowerCase().includes(query)
      || tpl.description.toLowerCase().includes(query)
      || String(tpl.userTemplate?.category || '').toLowerCase().includes(query))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'np-gallery-empty';
    empty.textContent = 'No starters match your search.';
    grid.appendChild(empty);
    return;
  }

  for (const [key, tpl] of entries) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'template-card' + (state.selectedTemplate === key ? ' selected' : '');
    card.dataset.key = key;
    card.setAttribute('aria-pressed', String(state.selectedTemplate === key));

    const art = document.createElement('span');
    art.className = 'template-card-art';
    const icon = document.createElement('img');
    icon.src = tpl.icon;
    icon.alt = '';
    art.appendChild(icon);

    const details = document.createElement('span');
    details.className = 'template-card-details';
    const name = document.createElement('span');
    name.className = 'template-card-name';
    name.textContent = tpl.name;
    const desc = document.createElement('span');
    desc.className = 'template-card-desc';
    desc.textContent = tpl.description;
    const type = document.createElement('span');
    type.className = 'template-card-type';
    const sourceLabel = tpl.verified ? 'VERIFIED COMMUNITY'
      : key.startsWith('user:') ? 'MY STARTER'
      : _npApiTemplateKeys.has(key) ? 'NOVAAPP API' : 'STARTER';
    const userCategory = tpl.userTemplate?.category?.trim();
    type.textContent = userCategory
      ? `${sourceLabel} · ${userCategory.toUpperCase()}`
      : sourceLabel;
    details.append(name, desc, type);
    card.append(art, details);

    card.addEventListener('click', () => {
      state.selectedTemplate = key;
      _npSelectedFile = null;
      _npPlaceholderValues = {};
      _npRenderTemplateGallery();
      _renderNewProjectPreview();
      _npUpdateCreateProjectAvailability();
    });
    grid.appendChild(card);
  }
}

function _npSetCommunityTemplateNotice(message, type = '') {
  const notice = $('np-community-template-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('is-error', type === 'error');
  notice.classList.toggle('is-success', type === 'success');
}

function _npRenderCommunityTemplateCategories() {
  const filters = $('np-community-template-categories');
  if (!filters) return;
  filters.replaceChildren();
  const categories = new Map();
  if (_npCommunityTemplateCatalogLoaded) {
    for (const listing of _npCommunityTemplateCatalog) {
      const label = String(listing.category || 'General').trim() || 'General';
      const key = label.toLowerCase();
      const category = categories.get(key) || { label, count: 0 };
      category.count += 1;
      categories.set(key, category);
    }
  }
  if (_npCommunityTemplateCategory !== 'all' && !categories.has(_npCommunityTemplateCategory)) {
    _npCommunityTemplateCategory = 'all';
  }
  const options = [
    { id: 'all', label: 'All templates', count: _npCommunityTemplateCatalog.length },
    ...[...categories.entries()]
      .sort(([, left], [, right]) => left.label.localeCompare(right.label))
      .map(([id, category]) => ({ id, ...category })),
  ];
  for (const category of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `np-community-category${_npCommunityTemplateCategory === category.id ? ' is-active' : ''}`;
    button.setAttribute('aria-pressed', String(_npCommunityTemplateCategory === category.id));
    button.textContent = `${category.label} · ${category.count}`;
    button.addEventListener('click', () => {
      _npCommunityTemplateCategory = category.id;
      _npRenderCommunityTemplateMarketplace();
    });
    filters.appendChild(button);
  }
}

function _npRenderCommunityTemplateMarketplace() {
  const grid = $('np-community-template-grid');
  if (!grid) return;
  grid.replaceChildren();
  _npRenderCommunityTemplateCategories();
  if (!_npCommunityTemplateCatalogLoaded) {
    $('np-community-template-count').textContent = '';
    const empty = document.createElement('p');
    empty.className = 'np-community-template-empty';
    empty.textContent = _npCommunityTemplateCatalogLoading
      ? 'Loading reviewed templates…'
      : 'The community catalog could not be loaded. Check your connection and try again.';
    grid.appendChild(empty);
    return;
  }
  const query = ($('np-community-template-search')?.value || '').trim().toLowerCase();
  const listings = _npCommunityTemplateCatalog
    .filter((listing) => _npCommunityTemplateCategory === 'all'
      || String(listing.category || 'General').trim().toLowerCase() === _npCommunityTemplateCategory)
    .filter((listing) => !query || [
      listing.name, listing.author, listing.description, listing.category, listing.id,
    ].some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((left, right) => _npCommunityTemplateSort === 'name'
      ? left.name.localeCompare(right.name)
      : (Date.parse(right.publishedAt || '') || 0) - (Date.parse(left.publishedAt || '') || 0)
        || left.name.localeCompare(right.name));
  const count = $('np-community-template-count');
  if (count) {
    count.textContent = listings.length === _npCommunityTemplateCatalog.length
      ? `${listings.length} ${listings.length === 1 ? 'template' : 'templates'}`
      : `${listings.length} of ${_npCommunityTemplateCatalog.length}`;
  }
  if (!listings.length) {
    const empty = document.createElement('p');
    empty.className = 'np-community-template-empty';
    empty.textContent = _npCommunityTemplateCatalog.length
      ? 'No templates match these filters. Try another category or clear your search.'
      : 'The library is ready for its first community release.';
    grid.appendChild(empty);
    return;
  }
  const verifiedTemplates = _readUserTemplates().filter((entry) => entry.verified
    && entry.communityId && entry.communityVersion);
  for (const listing of listings) {
    const cached = verifiedTemplates.find((entry) => entry.communityId === listing.id
      && entry.communityVersion === listing.version
      && (() => {
        try {
          validateCommunityTemplateBundle(entry.communityBundle, listing);
          return true;
        } catch {
          return false;
        }
      })());
    const card = document.createElement('article');
    card.className = `np-community-template-card${state.selectedTemplate === cached?.id ? ' is-selected' : ''}`;
    const artwork = document.createElement('div');
    artwork.className = 'np-community-template-card__art';
    const icon = document.createElement('span');
    icon.className = 'np-community-template-card__art-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✳';
    const category = document.createElement('span');
    category.className = 'np-community-template-card__category';
    category.textContent = listing.category || 'General';
    artwork.append(icon, category);
    const heading = document.createElement('div');
    heading.className = 'np-community-template-card__heading';
    const name = document.createElement('span');
    name.className = 'np-community-template-card__name';
    name.textContent = listing.name;
    heading.appendChild(name);
    const badge = document.createElement('span');
    badge.className = `np-community-template-card__badge${cached ? '' : ' is-pending'}`;
    badge.textContent = cached ? 'Verified' : 'Ready to verify';
    heading.appendChild(badge);
    const description = document.createElement('p');
    description.className = 'np-community-template-card__description';
    description.textContent = listing.description;
    const meta = document.createElement('div');
    meta.className = 'np-community-template-card__meta';
    for (const value of [
      listing.category || 'General',
      listing.author,
      `v${listing.version}`,
      _formatSize(listing.size),
    ]) {
      const item = document.createElement('span');
      item.textContent = value;
      meta.appendChild(item);
    }
    if (listing.publishedAt && Number.isFinite(Date.parse(listing.publishedAt))) {
      const date = document.createElement('span');
      date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        .format(new Date(listing.publishedAt));
      meta.appendChild(date);
    }
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'action-btn action-btn--primary';
    action.textContent = cached ? 'Use this template' : 'Verify & preview';
    action.addEventListener('click', () => void _npSelectCommunityTemplate(listing, cached, action));
    card.append(artwork, heading, description, meta, action);
    grid.appendChild(card);
  }
}

async function _npLoadCommunityTemplateCatalog({ refresh = false } = {}) {
  if (_npCommunityTemplateCatalogLoading) return;
  if (_npCommunityTemplateCatalogLoaded && !refresh) {
    _npRenderCommunityTemplateMarketplace();
    return;
  }
  _npCommunityTemplateCatalogLoading = true;
  _npSetCommunityTemplateNotice('');
  _npRenderCommunityTemplateMarketplace();
  try {
    _npCommunityTemplateCatalog = await fetchCommunityTemplateCatalog();
    _npCommunityTemplateCatalogLoaded = true;
    _npSetCommunityTemplateNotice(
      `${_npCommunityTemplateCatalog.length} reviewed template${_npCommunityTemplateCatalog.length === 1 ? '' : 's'}. Bundles are verified before preview.`,
    );
  } catch (error) {
    _npCommunityTemplateCatalogLoaded = false;
    _npSetCommunityTemplateNotice(`Could not load community templates: ${error.message}`, 'error');
  } finally {
    _npCommunityTemplateCatalogLoading = false;
    _npRenderCommunityTemplateMarketplace();
  }
}

async function _npSelectCommunityTemplate(listing, cached, button) {
  if (cached) {
    state.selectedTemplate = cached.id;
    _npSelectedFile = null;
    _npPlaceholderValues = {};
    _npRenderCommunityTemplateMarketplace();
    _renderNewProjectPreview();
    _npUpdateCreateProjectAvailability();
    return;
  }
  button.disabled = true;
  button.textContent = 'Downloading & verifying…';
  _npSetCommunityTemplateNotice(`Downloading and verifying ${listing.name}…`);
  try {
    const downloaded = await downloadCommunityTemplate(listing);
    const template = _validateUserTemplate(downloaded.bundle);
    const id = `user:community:${listing.id}:${listing.version}`;
    const entry = {
      ...template,
      id,
      communityId: listing.id,
      communityVersion: listing.version,
      communityListing: downloaded.listing,
      communityBundle: downloaded.bundle,
      verified: true,
    };
    const templates = _readUserTemplates().filter((item) => item.communityId !== listing.id);
    templates.push(entry);
    localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(templates));
    state.selectedTemplate = id;
    _npSelectedFile = null;
    _npPlaceholderValues = {};
    _npSetCommunityTemplateNotice(`${listing.name} is Verified. Preview its files and manifest before creating a project.`, 'success');
    _npRenderCommunityTemplateMarketplace();
    _renderNewProjectPreview();
    _npUpdateCreateProjectAvailability();
  } catch (error) {
    _npSetCommunityTemplateNotice(`Could not verify ${listing.name}: ${error.message}`, 'error');
    button.disabled = false;
    button.textContent = 'Retry verification';
  }
}

function _npSetTemplateSource(source) {
  _npTemplateSource = source === 'community' ? 'community' : 'studio';
  const community = _npTemplateSource === 'community';
  const studioTab = $('btn-np-studio-templates');
  const communityTab = $('btn-np-community-templates');
  const studioPane = $('np-studio-template-pane');
  const communityPane = $('np-community-template-pane');
  studioTab?.classList.toggle('active', !community);
  studioTab?.setAttribute('aria-selected', String(!community));
  communityTab?.classList.toggle('active', community);
  communityTab?.setAttribute('aria-selected', String(community));
  if (studioPane) studioPane.hidden = community;
  if (communityPane) communityPane.hidden = !community;
  $('np-categories')?.classList.toggle('hidden', community);
  document.querySelector('#modal-new-project .modal-body--new-project')
    ?.classList.toggle('is-community-template-source', community);
  _npUpdateCreateProjectAvailability();
  if (community) {
    _npRenderCommunityTemplateCategories();
    _npRenderCommunityTemplateMarketplace();
    void _npLoadCommunityTemplateCatalog();
  }
}

function _npUpdateCreateProjectAvailability() {
  const button = $('btn-create-project');
  if (!button) return;
  const template = _npGetTemplate(state.selectedTemplate);
  const ready = _npTemplateSource !== 'community'
    || Boolean(template?.verified && template.userTemplate?.communityId);
  button.disabled = !ready;
  button.title = ready ? '' : 'Select and verify a community template before creating a project.';
}

function openNewProjectModal() {
  $('new-app-name').value = '';
  $('new-app-id').value = '';
  $('new-app-dir').value = '';
  $('np-template-search').value = '';
  $('np-community-template-search').value = '';
  $('np-community-template-sort').value = 'recent';
  _npCommunityTemplateCategory = 'all';
  _npCommunityTemplateSort = 'recent';
  _npActiveTemplateCategory = 'all';
  _npPlaceholderValues = {};
  _npSelectedFile = null;

  $('modal-new-project').classList.remove('hidden');
  _npSetTemplateSource(_npTemplateSource);
  $('np-template-search').oninput = _npRenderTemplateGallery;
  _npRenderTemplateCategories();
  _npRenderTemplateGallery();
  _renderNewProjectPreview();
  _npUpdateCreateProjectAvailability();
  setTimeout(() => $('np-template-search').focus(), 50);
}

// Builds the manifest-like object passed into each template's file
// functions, using current form values with the same fallbacks create()
// itself applies (so the preview never shows something create() wouldn't
// actually produce) plus any collected placeholder values (e.g. url).
function _npBuildManifestForPreview() {
  const name = $('new-app-name')?.value.trim() || 'My App';
  const id = $('new-app-id')?.value.trim() || 'com.example.myapp';
  return { name, id, version: '1.0.0', description: '', author: '', ..._npPlaceholderValues };
}

// Re-renders the project preview: header (icon/name/description), file list,
// project and placeholder fields, and the currently
// selected file's generated content. Called on template change, form
// input, and placeholder-field input -- cheap enough (string templates,
// no disk I/O) to just re-run in full each time rather than diffing.
function _renderNewProjectPreview() {
  const tpl = _npGetTemplate(state.selectedTemplate);
  if (!tpl) return;
  const m = _npBuildManifestForPreview();

  const previewIconEl = $('np-preview-icon');
  if (typeof tpl.icon === 'string' && tpl.icon.startsWith('data:image')) {
    const img = document.createElement('img');
    img.src = tpl.icon;
    img.alt = '';
    previewIconEl.replaceChildren(img);
  } else {
    previewIconEl.textContent = tpl.icon;
  }
  $('np-preview-name').textContent = tpl.name;
  $('np-preview-desc').textContent = tpl.userTemplate?.author
    ? `${tpl.description} · by ${tpl.userTemplate.author}`
    : tpl.description;
  const trustBadge = $('np-preview-trust');
  if (trustBadge) {
    trustBadge.hidden = !tpl.userTemplate;
    trustBadge.textContent = tpl.verified ? 'Verified' : 'Imported JSON · not verified';
    trustBadge.classList.toggle('is-unverified', Boolean(tpl.userTemplate && !tpl.verified));
  }

  // Placeholder fields (e.g. Web App Wrapper's URL) -- rendered as normal
  // labeled inputs in the project details panel, not just inline in the preview, so
  // they're discoverable even before someone clicks into the preview pane.
  const fieldsWrap = $('np-placeholder-fields');
  fieldsWrap.replaceChildren();
  const fields = tpl.placeholderFields || [];
  if (fields.length === 0) {
    fieldsWrap.classList.add('hidden');
  } else {
    fieldsWrap.classList.remove('hidden');
    for (const field of fields) {
      if (!(field.key in _npPlaceholderValues)) {
        _npPlaceholderValues[field.key] = field.default || '';
      }
      const row = document.createElement('div');
      row.className = 'field-row';
      const label = document.createElement('label');
      label.className = 'field-label';
      label.textContent = field.label;
      const input = document.createElement('input');
      input.className = 'field-input';
      input.placeholder = field.placeholder || '';
      input.spellcheck = false;
      input.value = _npPlaceholderValues[field.key];
      input.addEventListener('input', (e) => {
        _npPlaceholderValues[field.key] = e.target.value;
        _renderNewProjectPreview();
      });
      row.append(label, input);
      fieldsWrap.appendChild(row);
    }
  }

  // File list
  const fileNames = [...Object.keys(tpl.files), 'manifest.json'];
  if (!fileNames.includes(_npSelectedFile)) {
    _npSelectedFile = fileNames.includes('index.html') ? 'index.html' : fileNames[0];
  }

  const list = $('np-file-list');
  list.replaceChildren();
  for (const filename of fileNames) {
    const item = document.createElement('div');
    item.className = 'np-file-list-item' + (filename === _npSelectedFile ? ' selected' : '');
    const ext = filename === 'manifest.json' ? '.json' : path.extname(filename).toLowerCase();
    item.innerHTML = _fileIconHtml(ext) + `<span></span>`; // icon HTML is from our own static _fileIconHtml map -- safe
    item.querySelector('span').textContent = filename;
    item.addEventListener('click', () => {
      _npSelectedFile = filename;
      _renderNewProjectPreview();
    });
    list.appendChild(item);
  }

  // Selected file's content
  $('np-file-view-name').textContent = _npSelectedFile || '';
  const content = _npGenerateFileContent(tpl, _npSelectedFile, m);
  _npRenderFileContent(content, _npSelectedFile);
}

// Returns the generated content for one file in the given template,
// running the real content function from templates.js (or building the
// same manifest.json shape create() writes) so what's shown is exactly
// what create() would write -- not a separate guess at it.
function _npGenerateFileContent(tpl, filename, m) {
  if (filename === 'manifest.json') {
    if (tpl.userTemplate) {
      return JSON.stringify({
        ...tpl.userTemplate.manifest,
        id: m.id || 'com.example.myapp',
        name: m.name || tpl.userTemplate.manifest.name,
        version: m.version || tpl.userTemplate.manifest.version || '1.0.0',
      }, null, 2);
    }
    const manifestObj = {
      id: m.id || 'com.example.myapp',
      name: m.name || 'My App',
      version: m.version || '1.0.0',
      description: m.description || '',
      author: m.author || '',
      entry: 'index.html',
      icon: tpl.icon || 'box',
      permissions: [...(tpl.permissions || [])],
      ...(tpl.optionalPermissions?.length ? { optionalPermissions: [...tpl.optionalPermissions] } : {}),
      permissionReasons: { ...(tpl.permissionReasons || {}) },
    };
    if (state.selectedTemplate === 'webapp') {
      manifestObj.url = m.url || 'https://example.com';
      manifestObj.allowNestedWebview = true;
    }
    if (state.selectedTemplate === 'browser') {
      manifestObj.allowNestedWebview = true;
    }
    if (tpl.shareTarget) manifestObj.shareTarget = { ...tpl.shareTarget };
    return JSON.stringify(manifestObj, null, 2);
  }
  const fn = tpl.files[filename];
  if (!fn) return '';
  try {
    return typeof fn === 'function' ? fn(m) : fn;
  } catch (e) {
    return `// Could not render preview: ${e.message}`;
  }
}

// Renders file content into the preview pane with light static
// highlighting (comments/strings/keywords/tags) and, for the currently
// selected placeholder fields, live-editable inline inputs at the exact
// point they appear in the generated text -- e.g. the URL string inside
// Web App Wrapper's app.js. This is a display convenience only: the
// actual value being edited is still _npPlaceholderValues[key], the same
// one driving the labeled field in the form. Editing here or there does
// the same thing.
function _npRenderFileContent(content, filename) {
  const host = $('np-file-view-content');
  host.replaceChildren();

  const tpl = _npGetTemplate(state.selectedTemplate);
  const fields = tpl?.placeholderFields || [];

  // Only index.html/app.js are realistic homes for a placeholder value
  // appearing literally in the text (manifest.json shows it structurally
  // via the JSON above, which is already correct without extra markup).
  const relevantFields = filename === 'manifest.json' ? [] : fields;

  if (relevantFields.length === 0) {
    host.innerHTML = _npHighlight(content, filename);
    return;
  }

  // Build the content in segments, splitting out each occurrence of a
  // placeholder value so it can be swapped for a live <input> in the DOM
  // instead of highlighted as plain text. Fields can declare a `normalize`
  // function for cases where the value that actually lands in the
  // generated file differs from the raw input -- e.g. Web App Wrapper's
  // url goes through sanitizeUrl()/URL.href in templates.js, which can add
  // a trailing slash or otherwise canonicalize the string. Splitting on
  // the raw value there would silently fail to find a match and just show
  // the URL as plain text instead of an editable token.
  let segments = [{ text: content, editable: null }];
  for (const field of relevantFields) {
    const rawValue = _npPlaceholderValues[field.key];
    if (!rawValue) continue;
    const matchValue = field.normalize ? field.normalize(rawValue) : rawValue;
    if (!matchValue) continue;
    const next = [];
    for (const seg of segments) {
      if (seg.editable) { next.push(seg); continue; }
      const parts = seg.text.split(matchValue);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) next.push({ text: parts[i], editable: null });
        if (i < parts.length - 1) next.push({ text: matchValue, editable: field });
      }
    }
    segments = next;
  }

  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    if (seg.editable) {
      const input = document.createElement('input');
      input.className = 'np-placeholder-token';
      input.value = seg.text;
      input.spellcheck = false;
      input.style.width = Math.max(4, seg.text.length) + 'ch';
      input.title = seg.editable.label;
      input.addEventListener('input', (e) => {
        _npPlaceholderValues[seg.editable.key] = e.target.value;
        input.style.width = Math.max(4, e.target.value.length) + 'ch';
      });
      // Only resync the labeled form field + rest of the preview once the
      // user leaves the inline input, same reasoning as the diff pane's
      // "don't fight the cursor on every keystroke" -- rebuilding this
      // whole content view on every character would yank focus/cursor
      // position out of the input the user is actively typing in.
      input.addEventListener('change', () => _renderNewProjectPreview());
      frag.appendChild(input);
    } else {
      const span = document.createElement('span');
      span.innerHTML = _npHighlight(seg.text, filename);
      frag.appendChild(span);
    }
  }
  host.appendChild(frag);
}

// Minimal static highlighter for the New Project preview only. Not
// language-aware, not a tokenizer/parser -- just enough regex-based
// coloring (comments, strings, a handful of keywords, HTML tags) to make
// generated files legible at a glance before the project exists on disk.
// Deliberately not routed through window.CM/CodeMirror: that editor is
// built around mounting a real file path for imports/autocomplete/save,
// none of which exist yet at this point in the New Project flow.
function _npHighlight(text, filename) {
  const escaped = _escHtml(text);
  const ext = filename === 'manifest.json' ? '.json' : (filename ? path.extname(filename).toLowerCase() : '');

  if (ext === '.html') {
    return escaped
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="np-tok-comment">$1</span>')
      .replace(/(&lt;\/?[a-zA-Z][\w-]*)/g, '<span class="np-tok-tag">$1</span>')
      .replace(/(&quot;[^&]*?&quot;)/g, '<span class="np-tok-string">$1</span>');
  }
  if (ext === '.css') {
    return escaped
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="np-tok-comment">$1</span>');
  }
  if (ext === '.json') {
    return escaped
      .replace(/(&quot;[^&]*?&quot;)(?=:)/g, '<span class="np-tok-keyword">$1</span>')
      .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="np-tok-string">$2</span>');
  }
  // .js / default
  return escaped
    .replace(/(\/\/[^\n]*)/g, '<span class="np-tok-comment">$1</span>')
    .replace(/(&#39;[^&]*?&#39;|&quot;[^&]*?&quot;|`[^`]*?`)/g, '<span class="np-tok-string">$1</span>')
    .replace(/\b(const|let|function|return|if|else|for|while|new|async|await|try|catch|throw)\b/g, '<span class="np-tok-keyword">$1</span>');
}

// Auto-generate ID from name. Wired in init() so this only runs in the
// browser, not when the module is required by tests.
function _initNewProjectIdSync() {
  const nameInput = $('new-app-name');
  const idInput = $('new-app-id');
  if (!nameInput || !idInput) return;
  nameInput.addEventListener('input', (e) => {
    const name = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name) idInput.value = `com.example.${name}`;
    _renderNewProjectPreview();
  });
  idInput.addEventListener('input', () => _renderNewProjectPreview());
}

async function createProject() {
  const name = $('new-app-name').value.trim();
  const id = $('new-app-id').value.trim();
  const dir = $('new-app-dir').value.trim();

  if (!name || !id || !dir) {
    await studioAlert('Please fill in the app name, ID, and project folder.', { title: 'Project details required' });
    return;
  }

  let result;
  try {
    const userTemplate = _readUserTemplates().find((entry) => entry.id === state.selectedTemplate);
    if (_npTemplateSource === 'community'
      && (!userTemplate?.verified || !userTemplate.communityId)) {
      await studioAlert('Choose and verify a community template before creating a project.', {
        title: 'Community template required',
      });
      return;
    }
    if (userTemplate) {
      result = _createProjectFromUserTemplate(dir, userTemplate, { id, name, ..._npPlaceholderValues });
    } else {
      result = create({
        targetDir: dir,
        template: state.selectedTemplate,
        manifest: { id, name, version: '1.0.0', ..._npPlaceholderValues },
      });
    }
  } catch (err) {
    await studioAlert('Could not create project: ' + err.message, { title: 'Project creation failed' });
    return;
  }

  if (!result.success) {
    await studioAlert('Could not create project: ' + result.error, { title: 'Project creation failed' });
    return;
  }

  closeModal('modal-new-project');
  await loadProject(dir);
  if (_studioTutorialPendingProject && state.projectDir && state.screen === 'project') {
    _studioTutorialPendingProject = false;
    _startStudioTutorial('package');
  }
}

function _createProjectFromUserTemplate(targetDir, template, overrides) {
  const root = path.resolve(targetDir);
  if (fs.existsSync(root) && (!fs.statSync(root).isDirectory() || fs.readdirSync(root).length)) {
    return { success: false, error: 'Choose a new or empty project folder for this starter.' };
  }
  const created = [];
  try {
    fs.mkdirSync(root, { recursive: true });
    const manifest = {
      ...template.manifest,
      ...overrides,
      version: '1.0.0',
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    created.push(manifestPath);
    for (const [filename, encoded] of Object.entries(template.files)) {
      const normalized = path.normalize(filename);
      const relativePath = path.relative(root, path.resolve(root, normalized));
      if (path.isAbsolute(filename) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath) || normalized.split(path.sep).some((part) =>
          !part || part.startsWith('.') || part.toLowerCase() === 'node_modules')
        || ['manifest.json', 'novaapp.json'].includes(path.basename(normalized))) {
        throw new Error(`Unsafe starter path: ${filename}`);
      }
      const filePath = path.join(root, normalized);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(encoded, 'base64'), { flag: 'wx' });
      created.push(filePath);
    }
    return { success: true, files: created.map((filename) => path.relative(root, filename)) };
  } catch (error) {
    for (const file of created) {
      try { fs.rmSync(file, { force: true }); } catch (cleanupError) {
        console.error(`Could not remove partial starter file ${file}:`, cleanupError);
      }
    }
    return { success: false, error: error.message };
  }
}

// Keep the native input attached until NW.js has completed its picker event;
// detached inputs have produced unstable native-dialog behavior in some NW builds.
function _pickerStartDirectory() {
  const candidates = [state.projectDir];
  if (typeof __dirname !== 'undefined') candidates.push(__dirname);
  let lastError = null;
  try {
    candidates.push(process.cwd());
  } catch (err) {
    lastError = err;
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
    } catch (err) {
      lastError = err;
    }
  }

  showToast(`Could not determine a starting directory for the picker${lastError ? `: ${lastError.message}` : '.'}`);
  return null;
}

function _openNativePicker(input, callback, expectedKind) {
  const startDirectory = _pickerStartDirectory();
  if (!startDirectory) return;
  input.setAttribute('nwworkingdir', startDirectory);
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(input);
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    input.remove();
  };
  input.addEventListener('cancel', cleanup, { once: true });
  input.addEventListener('change', () => {
    const selectedPath = input.files?.[0]?.path;
    cleanup();
    if (!selectedPath) return;
    let stats;
    try {
      stats = fs.statSync(selectedPath);
    } catch (err) {
      showToast(`Could not access the selected ${expectedKind}: ${err.message}`);
      return;
    }
    if (expectedKind === 'folder' && !stats.isDirectory()) {
      showToast('The folder picker did not return a folder path.');
      return;
    }
    if (expectedKind === 'file' && !stats.isFile()) {
      showToast('The file picker did not return a file path.');
      return;
    }
    try {
      callback(selectedPath);
    } catch (err) {
      showToast(`Could not process the selected ${expectedKind}: ${err.message}`);
    }
  }, { once: true });
  try {
    input.click();
  } catch (err) {
    cleanup();
    showToast(`Could not open the ${expectedKind} picker: ${err.message}`);
  }
}

function _pickFolderWindows(callback) {
  const startDirectory = _pickerStartDirectory();
  if (!startDirectory) return;

  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$cacheDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) \'NovaPack Studio\\Cache\'',
    '$assemblyPath = Join-Path $cacheDirectory \'ModernFolderPicker-v1.dll\'',
    'if (Test-Path -LiteralPath $assemblyPath) { Add-Type -Path $assemblyPath } else {',
    '  New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null',
    '  Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    '[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] public class FileOpenDialogComObject {}',
    '[ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IFileOpenDialog : IFileDialog { void GetResults(out IntPtr items); void GetSelectedItems(out IntPtr items); }',
    '[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IFileDialog {',
    '  void Show(IntPtr owner); void SetFileTypes(uint count, IntPtr filters); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);',
    '  void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie); void SetOptions(uint options); void GetOptions(out uint options);',
    '  void SetDefaultFolder(IShellItem folder); void SetFolder(IShellItem folder); void GetFolder(out IShellItem folder); void GetCurrentSelection(out IShellItem item);',
    '  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName(out IntPtr name); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);',
    '  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label); void GetResult(out IShellItem item);',
    '  void AddPlace(IShellItem item, uint alignment); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension); void Close(int result);',
    '  void SetClientGuid(ref Guid guid); void ClearClientData(); void SetFilter(IntPtr filter);',
    '}',
    '[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IShellItem {',
    '  void BindToHandler(IntPtr binding, ref Guid handler, ref Guid iid, out IntPtr result); void GetParent(out IShellItem parent);',
    '  void GetDisplayName(uint nameType, out IntPtr name); void GetAttributes(uint mask, out uint attributes); void Compare(IShellItem item, uint hint, out int order);',
    '}',
    'public static class ModernFolderPicker {',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)] static extern void SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, out IShellItem item);',
    '  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);',
    '  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);',
    '  public static string Show(string startDirectory) {',
    '    IntPtr previousDpiContext = IntPtr.Zero;',
    '    try { previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }',
    '    try {',
    '    var dialog = (IFileOpenDialog)new FileOpenDialogComObject(); dialog.SetOptions(0x20 | 0x40 | 0x800); dialog.SetTitle("Select a folder");',
    '    var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"); IShellItem startFolder;',
    '    SHCreateItemFromParsingName(startDirectory, IntPtr.Zero, ref iid, out startFolder); dialog.SetFolder(startFolder);',
    '    try { dialog.Show(IntPtr.Zero); } catch (COMException ex) { if ((uint)ex.ErrorCode == 0x800704C7) return null; throw; }',
    '    IShellItem selected; dialog.GetResult(out selected); IntPtr displayName; selected.GetDisplayName(0x80058000, out displayName);',
    '    try { return Marshal.PtrToStringUni(displayName); } finally { CoTaskMemFree(displayName); }',
    '    } finally { if (previousDpiContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpiContext); }',
    '  }',
    '}',
    '\'@ -OutputAssembly $assemblyPath',
    '  Add-Type -Path $assemblyPath',
    '}',
    '$selected = [ModernFolderPicker]::Show($env:NOVAPACK_PICKER_START_DIR)',
    'if ($selected) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($selected))) }',
  ].join('\n');

  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, NOVAPACK_PICKER_START_DIR: startDirectory },
  }, (err, stdout, stderr) => {
    if (err) {
      showToast(`Could not open the folder picker: ${stderr.trim() || err.message}`);
      return;
    }
    const encodedPath = stdout.trim();
    if (!encodedPath) return;

    const selectedPath = Buffer.from(encodedPath, 'base64').toString('utf8');
    let stats;
    try {
      stats = fs.statSync(selectedPath);
    } catch (statError) {
      showToast(`Could not access the selected folder: ${statError.message}`);
      return;
    }
    if (!stats.isDirectory()) {
      showToast('The folder picker did not return a folder path.');
      return;
    }
    try {
      callback(selectedPath);
    } catch (callbackError) {
      showToast(`Could not process the selected folder: ${callbackError.message}`);
    }
  });
}

function _acceptToExtensions(accept) {
  return String(accept || '')
    .split(',')
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter((part) => /^[a-z0-9]+$/.test(part));
}

// Each entry builds argv for one OS dialog tool. They run out of process like the
// Windows picker, because NW.js's own <input nwdirectory> dialog takes the whole
// app down on macOS and Linux when the user confirms a selection.
function _posixPickerCommands(kind, accept, startDirectory) {
  const extensions = _acceptToExtensions(accept);
  if (process.platform === 'darwin') {
    const chooser = kind === 'folder'
      ? 'choose folder with prompt "Select a folder" default location (POSIX file (item 1 of argv))'
      : `choose file with prompt "Select a file" default location (POSIX file (item 1 of argv))${
        extensions.length ? ` of type {${extensions.map((ext) => `"${ext}"`).join(', ')}}` : ''}`;
    return [{
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', `POSIX path of (${chooser})`, '-e', 'end run', startDirectory],
    }];
  }
  const withSlash = startDirectory.endsWith('/') ? startDirectory : `${startDirectory}/`;
  const zenityArgs = ['--file-selection', `--filename=${withSlash}`];
  if (kind === 'folder') zenityArgs.push('--directory');
  else if (extensions.length) zenityArgs.push(`--file-filter=Supported files | ${extensions.map((ext) => `*.${ext}`).join(' ')}`);
  const kdialogArgs = kind === 'folder'
    ? ['--getexistingdirectory', withSlash]
    : ['--getopenfilename', withSlash, extensions.map((ext) => `*.${ext}`).join(' ')].filter(Boolean);
  return [{ cmd: 'zenity', args: zenityArgs }, { cmd: 'kdialog', args: kdialogArgs }];
}

function _runPosixPicker(kind, accept, callback, fallback) {
  const startDirectory = _pickerStartDirectory();
  if (!startDirectory) return;
  const commands = _posixPickerCommands(kind, accept, startDirectory);

  const tryNext = (index) => {
    if (index >= commands.length) {
      fallback();
      return;
    }
    const { cmd, args } = commands[index];
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        tryNext(index + 1);
        return;
      }
      const picked = String(stdout || '').trim();
      if (err) {
        // osascript reports cancel as error -128, zenity/kdialog as exit code 1 with no output
        if (!picked && (/-128/.test(stderr || '') || err.code === 1)) return;
        showToast(`Could not open the ${kind} picker: ${String(stderr || '').trim() || err.message}`);
        return;
      }
      if (!picked) return;
      // osascript returns folders with a trailing slash
      const selectedPath = picked.length > 1 ? picked.replace(/\/+$/, '') : picked;
      let stats;
      try {
        stats = fs.statSync(selectedPath);
      } catch (statError) {
        showToast(`Could not access the selected ${kind}: ${statError.message}`);
        return;
      }
      if (kind === 'folder' ? !stats.isDirectory() : !stats.isFile()) {
        showToast(`The ${kind} picker did not return a ${kind} path.`);
        return;
      }
      try {
        callback(selectedPath);
      } catch (callbackError) {
        showToast(`Could not process the selected ${kind}: ${callbackError.message}`);
      }
    });
  };
  tryNext(0);
}

function pickFolder(callback) {
  if (process.platform === 'win32') {
    _pickFolderWindows(callback);
    return;
  }
  const fallback = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('nwdirectory', '');
    _openNativePicker(input, callback, 'folder');
  };
  _runPosixPicker('folder', null, callback, fallback);
}

function pickFile(accept, callback) {
  const fallback = () => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    _openNativePicker(input, callback, 'file');
  };
  if (process.platform === 'win32') {
    fallback();
    return;
  }
  _runPosixPicker('file', accept, callback, fallback);
}

// Studio-native replacements for Chromium's blocking alert/confirm/prompt.
const _studioDialogQueue = [];
let _studioDialogActive = null;
let _studioDialogDismissHandler = null;

function _showNextStudioDialog() {
  if (_studioDialogActive || !_studioDialogQueue.length) return;
  const overlay = $('studio-dialog-overlay');
  if (!overlay) {
    const request = _studioDialogQueue.shift();
    console.error('Studio dialog markup is unavailable');
    request.resolve(request.type === 'prompt' ? null : false);
    _showNextStudioDialog();
    return;
  }

  const request = _studioDialogQueue.shift();
  const title = $('studio-dialog-title');
  const message = $('studio-dialog-message');
  const input = $('studio-dialog-input');
  const cancel = $('studio-dialog-cancel');
  const confirmButton = $('studio-dialog-confirm');
  const activeElement = document.activeElement;
  _studioDialogActive = { ...request, activeElement };

  overlay.querySelector('.studio-dialog').setAttribute(
    'role',
    request.type === 'alert' ? 'alertdialog' : 'dialog',
  );
  title.textContent = request.title;
  message.textContent = request.message;
  input.value = request.defaultValue;
  input.placeholder = request.placeholder;
  input.maxLength = request.maxLength;
  input.classList.toggle('hidden', request.type !== 'prompt');
  cancel.textContent = request.cancelLabel;
  cancel.classList.toggle('hidden', request.type === 'alert');
  confirmButton.textContent = request.confirmLabel;
  confirmButton.classList.toggle('is-danger', request.danger);
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => (request.type === 'prompt' ? input : confirmButton).focus());
}

function _finishStudioDialog(value) {
  const active = _studioDialogActive;
  if (!active) return;
  _studioDialogActive = null;
  $('studio-dialog-overlay')?.classList.add('hidden');
  active.resolve(value);
  if (active.activeElement?.isConnected) active.activeElement.focus();
  queueMicrotask(_showNextStudioDialog);
}

function _queueStudioDialog({
  type, title, message, defaultValue = '', placeholder = '', maxLength = 1000,
  confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false,
}) {
  return new Promise((resolve) => {
    _studioDialogQueue.push({
      type,
      title,
      message: String(message ?? ''),
      defaultValue: String(defaultValue ?? ''),
      placeholder,
      maxLength,
      confirmLabel,
      cancelLabel,
      danger,
      resolve,
    });
    _showNextStudioDialog();
  });
}

function studioAlert(message, options = {}) {
  return _queueStudioDialog({
    type: 'alert',
    title: options.title || 'Notice',
    message,
    confirmLabel: options.confirmLabel || 'Got it',
  });
}

function studioConfirm(message, options = {}) {
  return _queueStudioDialog({
    type: 'confirm',
    title: options.title || 'Confirm action',
    message,
    confirmLabel: options.confirmLabel || 'Continue',
    cancelLabel: options.cancelLabel || 'Cancel',
    danger: options.danger === true,
  });
}

function studioPrompt(message, defaultValue = '', options = {}) {
  return _queueStudioDialog({
    type: 'prompt',
    title: options.title || 'Enter a value',
    message,
    defaultValue,
    placeholder: options.placeholder || '',
    maxLength: options.maxLength || 1000,
    confirmLabel: options.confirmLabel || 'Save',
    cancelLabel: options.cancelLabel || 'Cancel',
  });
}

function _initStudioDialogs() {
  const overlay = $('studio-dialog-overlay');
  if (!overlay) throw new Error('Studio dialog markup is missing');
  $('studio-dialog-cancel').addEventListener('click', () => {
    _finishStudioDialog(_studioDialogActive?.type === 'prompt' ? null : false);
  });
  $('studio-dialog-confirm').addEventListener('click', () => {
    _finishStudioDialog(_studioDialogActive?.type === 'prompt'
      ? $('studio-dialog-input').value
      : true);
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      _finishStudioDialog(_studioDialogActive?.type === 'prompt' ? null : false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!_studioDialogActive) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      _finishStudioDialog(_studioDialogActive.type === 'prompt' ? null : false);
    } else if (event.key === 'Tab') {
      const overlay = $('studio-dialog-overlay');
      const focusable = [...overlay.querySelectorAll('button:not(.hidden), input:not(.hidden)')]
        .filter((element) => !element.disabled);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    } else if (event.key === 'Enter' && _studioDialogActive.type === 'prompt'
      && document.activeElement === $('studio-dialog-input')) {
      event.preventDefault();
      $('studio-dialog-confirm').click();
    }
  }, true);
}

// Modal helpers
function closeModal(id) {
  $(id).classList.add('hidden');
}

// Wired in init() so the listener isn't added when the file is required by tests.
function _initModalDismissHandlers() {
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      const target = close.dataset.close;
      if (target === 'modal-diff') { closeDiff(); return; }
      closeModal(target);
    }
    // Click outside modal -- also guard the editor
    if (e.target.classList.contains('modal-overlay')) {
      if (e.target.id === 'modal-diff') { closeDiff(); return; }
      e.target.classList.add('hidden');
    }
  });
}

// Toast. Single shared toast element. Timer is tracked via a WeakMap so
// repeated toasts reset the fade-out timer cleanly without leaking it.
const _toastTimers = new WeakMap();

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.cssText = [
      'position:fixed;bottom:20px;right:20px;',
      'background:var(--bg-raised);border:1px solid var(--border-mid);',
      'border-radius:var(--radius);padding:10px 16px;',
      'font-size:12px;color:var(--text-mid);',
      // Design mode's .design-fullscreen overlay sits at z-index:20000, and
      // NBPro's own toolbar (Snapshot/Undo/Redo/etc.) fires this same
      // showToast while that overlay is open -- at the old 9999 every one
      // of those toasts rendered underneath the canvas and was invisible.
      'z-index:20060;transition:opacity 0.3s;',
    ].join('');
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  const existing = _toastTimers.get(toast);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  _toastTimers.set(toast, t);
}

// Drag and drop on inspector
function initInspectorDrop() {
  const zone = $('inspector-dropzone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.novaapp')) {
      inspectFile(file.path);
    } else {
      await studioAlert('Please drop a .novaapp file.', { title: 'Unsupported package' });
    }
  });
}

// Resizable file tree rail. Drag the handle next to the rail to resize it.
// Clamped to the same 160-320px bounds declared on .project-rail in
// style.css. Width is persisted in the same storage blob as theme/recents.
function initRailResize() {
  const rail = $('project-rail');
  const handle = $('rail-resize-handle');
  const actions = rail?.querySelector('.file-tree-actions');
  if (!rail || !handle) return;

  const MIN_WIDTH = 160;
  const MAX_WIDTH = 320;

  const initialWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, state.railWidth || 220));
  rail.style.width = `${initialWidth}px`;
  handle.setAttribute('aria-valuenow', String(initialWidth));

  // Keep the action row visible; the path label can shrink.
  const toolbarMinWidth = () => {
    if (!actions) return MIN_WIDTH;
    return actions.scrollWidth + 24;
  };

  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const onMouseMove = (e) => {
    if (!dragging) return;
    const delta = (e.clientX - startX) * (state.railDock === 'right' ? -1 : 1);
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    const needed = toolbarMinWidth();

    if (next < needed) {
      // Dragged narrower than the toolbar can support -- collapse instead
      // of letting the buttons get clipped.
      collapseRail();
      onMouseUp(e, /* skipWidthSave */ true);
      return;
    }
    rail.style.width = `${next}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(next)));
  };

  const onMouseUp = (_e, skipWidthSave) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-resizing');
    document.body.classList.remove('is-resizing-rail');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    if (!skipWidthSave) {
      state.railWidth = parseInt(rail.style.width, 10) || 220;
      saveStorage();
    }
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = rail.getBoundingClientRect().width;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-rail');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 32 : 8;
    const direction = state.railDock === 'right' ? -1 : 1;
    let next;
    if (e.key === 'ArrowLeft') next = rail.getBoundingClientRect().width - step * direction;
    else if (e.key === 'ArrowRight') next = rail.getBoundingClientRect().width + step * direction;
    else if (e.key === 'Home') next = MIN_WIDTH;
    else if (e.key === 'End') next = MAX_WIDTH;
    else return;

    e.preventDefault();
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
    if (width < toolbarMinWidth()) {
      collapseRail();
      return;
    }
    rail.style.width = `${width}px`;
    state.railWidth = width;
    handle.setAttribute('aria-valuenow', String(width));
    saveStorage();
  });

  // Manual collapse/expand controls
  $('btn-collapse-rail')?.addEventListener('click', () => collapseRail());
  $('btn-reopen-rail')?.addEventListener('click', () => expandRail());

  if (state.railCollapsed) collapseRail(/* skipSave */ true);
}

function collapseRail(skipSave) {
  const rail = $('project-rail');
  const handle = $('rail-resize-handle');
  const tab = $('btn-reopen-rail');
  if (!rail || !handle) return;
  document.documentElement.dataset.railCollapsed = 'true';
  rail.classList.add('hidden');
  handle.classList.add('hidden');
  tab?.classList.remove('hidden');
  if (!skipSave) {
    state.railCollapsed = true;
    saveStorage();
  }
}

function _applyPaneDocking() {
  const layout = $('main-layout');
  const project = $('screen-project');
  const root = document.documentElement;
  const sidebarDock = state.sidebarDock === 'right' ? 'right' : 'left';
  const railDock = state.railDock === 'right' ? 'right' : 'left';
  root.dataset.sidebarDock = sidebarDock;
  root.dataset.railDock = railDock;
  if (layout) layout.dataset.sidebarDock = sidebarDock;
  if (project) project.dataset.railDock = railDock;
}

function initPaneDocking() {
  const panes = [
    { key: 'sidebarDock', surface: '#sidebar .sidebar-brand', container: 'main-layout' },
    { key: 'railDock', surface: '#project-rail .file-tree-header', container: 'screen-project' },
  ];

  _applyPaneDocking();

  for (const pane of panes) {
    const surface = document.querySelector(pane.surface);
    const container = $(pane.container);
    if (!surface || !container) continue;

    const guides = document.createElement('div');
    guides.className = 'pane-dock-guides hidden';
    guides.setAttribute('aria-hidden', 'true');
    for (const side of ['left', 'right']) {
      const zone = document.createElement('div');
      zone.className = 'pane-dock-zone';
      zone.dataset.side = side;
      const label = document.createElement('span');
      label.textContent = `Dock ${side}`;
      zone.appendChild(label);
      guides.appendChild(zone);
    }
    container.appendChild(guides);

    let pointerId = null;
    let startX = 0;
    let moved = false;

    const finishDrag = (event, commit) => {
      if (pointerId === null || (event && event.pointerId !== pointerId)) return;
      const side = guides.dataset.active;
      pointerId = null;
      guides.classList.add('hidden');
      guides.removeAttribute('data-active');
      document.body.classList.remove('is-docking-pane');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', cancel);
      if (commit && moved && (side === 'left' || side === 'right')) {
        state[pane.key] = side;
        _applyPaneDocking();
        saveStorage();
      }
    };

    const move = (event) => {
      if (event.pointerId !== pointerId) return;
      if (!moved && Math.abs(event.clientX - startX) < 8) return;
      moved = true;
      const bounds = container.getBoundingClientRect();
      guides.dataset.active = event.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
    };
    const end = (event) => finishDrag(event, true);
    const cancel = (event) => finishDrag(event, false);

    surface.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || pointerId !== null ||
          event.target.closest('button, a, input, select, textarea, [role="button"]')) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      moved = false;
      guides.classList.remove('hidden');
      guides.removeAttribute('data-active');
      document.body.classList.add('is-docking-pane');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', cancel);
    });
  }
}

function expandRail() {
  const rail = $('project-rail');
  const handle = $('rail-resize-handle');
  const tab = $('btn-reopen-rail');
  if (!rail || !handle) return;
  document.documentElement.dataset.railCollapsed = 'false';
  rail.classList.remove('hidden');
  handle.classList.remove('hidden');
  tab?.classList.add('hidden');
  state.railCollapsed = false;
  saveStorage();
}

function _applySidebarWidth(width = state.sidebarWidth) {
  const sidebar = $('sidebar');
  const handle = $('sidebar-resize-handle');
  if (!sidebar) return;
  const next = Math.min(360, Math.max(190, Math.round(width)));
  sidebar.style.width = `${next}px`;
  handle?.setAttribute('aria-valuenow', String(next));
}

function initSidebarResize() {
  const sidebar = $('sidebar');
  const handle = $('sidebar-resize-handle');
  if (!sidebar || !handle) return;

  const MIN_WIDTH = 190;
  const MAX_WIDTH = 360;
  const maxWidth = () => {
    const railWidth = $('project-rail')?.getBoundingClientRect().width || 220;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - railWidth - 460));
  };
  const applyWidth = (width) => {
    const next = Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(width)));
    sidebar.style.width = `${next}px`;
    handle.setAttribute('aria-valuenow', String(next));
  };

  applyWidth(state.sidebarWidth || 238);

  let startX = 0;
  let startWidth = 0;
  let activePointerId = null;

  const stopResize = (event) => {
    if (activePointerId === null || (event && event.pointerId !== activePointerId)) return;
    activePointerId = null;
    handle.classList.remove('is-resizing');
    document.body.classList.remove('is-resizing-sidebar');
    document.removeEventListener('pointermove', moveResize);
    document.removeEventListener('pointerup', stopResize);
    document.removeEventListener('pointercancel', stopResize);
    state.sidebarWidth = Math.round(sidebar.getBoundingClientRect().width);
    saveStorage();
  };
  const moveResize = (event) => {
    if (event.pointerId !== activePointerId) return;
    const direction = state.sidebarDock === 'right' ? -1 : 1;
    applyWidth(startWidth + (event.clientX - startX) * direction);
  };
  window.addEventListener('resize', () => applyWidth(state.sidebarWidth || 238));

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || sidebar.classList.contains('hidden')) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    startX = event.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    handle.classList.add('is-resizing');
    document.body.classList.add('is-resizing-sidebar');
    document.addEventListener('pointermove', moveResize);
    document.addEventListener('pointerup', stopResize);
    document.addEventListener('pointercancel', stopResize);
  });

  handle.addEventListener('keydown', (event) => {
    const current = sidebar.getBoundingClientRect().width;
    const step = event.shiftKey ? 32 : 12;
    let next;
    const direction = state.sidebarDock === 'right' ? -1 : 1;
    if (event.key === 'ArrowLeft') next = current - step * direction;
    else if (event.key === 'ArrowRight') next = current + step * direction;
    else if (event.key === 'Home') next = MIN_WIDTH;
    else if (event.key === 'End') next = maxWidth();
    else return;
    event.preventDefault();
    applyWidth(next);
    state.sidebarWidth = Math.round(sidebar.getBoundingClientRect().width);
    saveStorage();
  });
}

function initSidebarCollapse() {
  const sidebar = $('sidebar');
  const handle = $('sidebar-resize-handle');
  const tab = $('btn-reopen-sidebar');
  if (!sidebar) return;

  const collapse = () => {
    document.documentElement.dataset.sidebarCollapsed = 'true';
    sidebar.classList.add('hidden');
    handle?.classList.add('hidden');
    tab?.classList.remove('hidden');
    state.sidebarCollapsed = true;
    saveStorage();
  };

  const expand = () => {
    document.documentElement.dataset.sidebarCollapsed = 'false';
    sidebar.classList.remove('hidden');
    handle?.classList.remove('hidden');
    _applySidebarWidth();
    tab?.classList.add('hidden');
    state.sidebarCollapsed = false;
    saveStorage();
  };

  $('btn-collapse-sidebar')?.addEventListener('click', collapse);
  $('btn-reopen-sidebar')?.addEventListener('click', expand);

  if (state.sidebarCollapsed) {
    sidebar.classList.add('hidden');
    handle?.classList.add('hidden');
    tab?.classList.remove('hidden');
  }
}

// Global project search. Greps every text file under state.projectDir for a
// query and lets the user jump straight to a match. Mirrors the file-tree's
// own skip rules (dotfiles, node_modules) and the editor's binary/image
// exclusion lists so it never tries to read something it can't sensibly
// search.
const SEARCH_MAX_FILES = 2000;              // hard stop so a huge tree can't hang the UI
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;  // skip anything over 1MB as "probably not source"
const SEARCH_MAX_RESULTS = 500;             // cap total matches rendered
const SEARCH_DEFAULT_OPTIONS = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
});

let _searchDebounce = null;
let _searchResults = [];   // [{ filePath, relPath, line, col, lineText }]
let _searchActiveIdx = -1;
let _searchOptions = { ...SEARCH_DEFAULT_OPTIONS };

// Wires up listeners on the static #modal-global-search markup. Called once
// from init(), same pattern as the rest of the modal wiring below.
function _initGlobalSearch() {
  const input = $('gs-input');
  if (!input) return; // markup not present -- fail quiet, same as other $()? calls

  const queueSearch = () => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => _runGlobalSearch(input.value), 150);
  };
  input.addEventListener('input', () => {
    queueSearch();
  });
  $('gs-include')?.addEventListener('input', queueSearch);
  $('gs-exclude')?.addEventListener('input', queueSearch);
  document.querySelectorAll('[data-search-option]').forEach((button) => {
    const option = button.dataset.searchOption;
    if (!Object.hasOwn(_searchOptions, option)) return;
    button.addEventListener('click', () => {
      _searchOptions[option] = !_searchOptions[option];
      button.setAttribute('aria-pressed', String(_searchOptions[option]));
      button.classList.toggle('gs-toggle--active', _searchOptions[option]);
      queueSearch();
    });
  });
  $('gs-copy-results')?.addEventListener('click', async () => {
    if (!_searchResults.length) return;
    const text = _searchResults.map((result) =>
      `${result.relPath}:${result.line}:${result.lineText.trim()}`
    ).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${_searchResults.length} search result${_searchResults.length === 1 ? '' : 's'}`);
    } catch (err) {
      showToast(`Could not copy search results: ${err.message}`);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _moveSearchSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _moveSearchSelection(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (_searchActiveIdx >= 0) _jumpToSearchResult(_searchResults[_searchActiveIdx]);
    }
  });
}

function openGlobalSearch() {
  if (!state.projectDir) { showToast('Open a project first'); return; }

  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const overlay = $('modal-global-search');
  overlay.classList.remove('hidden');
  const input = $('gs-input');
  input.value = '';
  $('gs-include').value = '';
  $('gs-exclude').value = '';
  $('gs-results').replaceChildren();
  $('gs-meta').textContent = 'Type to search across all project files';
  $('gs-meta').classList.remove('gs-meta--error');
  $('gs-copy-results').disabled = true;
  _searchResults = [];
  _searchActiveIdx = -1;
  input.focus();
}

function closeGlobalSearch() {
  // Cancel any pending debounce so a late search doesn't fire after close.
  if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
  $('modal-global-search')?.classList.add('hidden');
}

// Walks the project dir collecting candidate text files, honoring the same
// skip rules as the file tree (_buildTreeItems) and the editor's binary/
// image extension lists, so we never try to decode something nonsensical.
function _collectSearchableFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= SEARCH_MAX_FILES) return;
    let items;
    try {
      items = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && f !== 'node_modules');
    } catch { return; }

    for (const f of items) {
      if (out.length >= SEARCH_MAX_FILES) return;
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.isDirectory()) { walk(full); continue; }

      const ext = path.extname(f).toLowerCase();
      if (IMAGE_EXTS.has(ext) || BINARY_EXTS.has(ext)) continue;
      if (stat.size > SEARCH_MAX_FILE_BYTES) continue;

      out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

function _parseSearchPatterns(input) {
  return input.split(/[\n,;]+/).map((part) => part.trim().replace(/\\/g, '/')).filter(Boolean);
}

function _globToRegExp(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(pattern + '$', 'i');
}

function _matchesSearchPath(relPath, patterns) {
  if (!patterns.length) return true;
  const normalizedPath = relPath.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    const matcher = _globToRegExp(pattern);
    return matcher.test(normalizedPath) || (!pattern.includes('/') && matcher.test(path.posix.basename(normalizedPath)));
  });
}

function _runGlobalSearch(query) {
  const resultsEl = $('gs-results');
  const metaEl = $('gs-meta');
  query = query.trim();
  metaEl.classList.remove('gs-meta--error');

  if (!query) {
    resultsEl.replaceChildren();
    metaEl.textContent = 'Type to search across all project files';
    _searchResults = [];
    _searchActiveIdx = -1;
    $('gs-copy-results').disabled = true;
    return;
  }

  let matcher;
  try {
    const source = _searchOptions.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordPattern = _searchOptions.wholeWord ? `\\b(?:${source})\\b` : source;
    matcher = new RegExp(wordPattern, _searchOptions.caseSensitive ? '' : 'i');
  } catch (err) {
    resultsEl.replaceChildren();
    _searchResults = [];
    _searchActiveIdx = -1;
    $('gs-copy-results').disabled = true;
    metaEl.classList.add('gs-meta--error');
    metaEl.textContent = `Invalid regular expression: ${err.message}`;
    return;
  }

  const includePatterns = _parseSearchPatterns($('gs-include').value);
  const excludePatterns = _parseSearchPatterns($('gs-exclude').value);
  const candidates = _collectSearchableFiles(state.projectDir);
  const files = candidates.filter((filePath) => {
    const relPath = path.relative(state.projectDir, filePath).replace(/\\/g, '/');
    return (!includePatterns.length || _matchesSearchPath(relPath, includePatterns)) &&
      (!excludePatterns.length || !_matchesSearchPath(relPath, excludePatterns));
  });
  const results = [];

  // Labeled break -- drop the loop as soon as we hit the cap so we don't
  // keep reading files we'll throw away.
  searchLoop:
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { continue; } // unreadable / not actually text -- skip silently

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0;
      const match = matcher.exec(lines[i]);
      if (match) {
        results.push({
          filePath,
          relPath: path.relative(state.projectDir, filePath),
          line: i + 1,
          col: match.index + 1,
          lineText: lines[i],
          matchStart: match.index,
          matchLength: match[0].length,
        });
        if (results.length >= SEARCH_MAX_RESULTS) break searchLoop;
      }
    }
  }

  _searchResults = results;
  _searchActiveIdx = results.length ? 0 : -1;
  $('gs-copy-results').disabled = results.length === 0;

  const capped = results.length >= SEARCH_MAX_RESULTS
    ? ` (showing first ${SEARCH_MAX_RESULTS})` : '';
  const filterSummary = includePatterns.length || excludePatterns.length
    ? ` · ${files.length} of ${candidates.length} files after filters`
    : ` · ${files.length} files searched`;
  metaEl.textContent = results.length
    ? `${results.length} matching line${results.length === 1 ? '' : 's'}${capped}${filterSummary}`
    : `No matches${filterSummary}`;

  _renderSearchResults();
}

function _renderSearchResults() {
  const resultsEl = $('gs-results');
  resultsEl.replaceChildren();
  if (!_searchResults.length) return;

  // Group by file so results read like a per-file outline, same mental
  // model as the file tree above it.
  const byFile = new Map();
  _searchResults.forEach((r, idx) => {
    r._idx = idx;
    if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
    byFile.get(r.filePath).push(r);
  });

  const frag = document.createDocumentFragment();

  for (const [filePath, matches] of byFile) {
    const group = document.createElement('div');
    group.className = 'gs-group';

    const ext = path.extname(filePath).toLowerCase();
    const iconHtml = _fileIconHtml(ext); // safe -- from our own static maps
    const head = document.createElement('div');
    head.className = 'gs-group-header';
    head.innerHTML = `<span class="file-icon">${iconHtml}</span>` +
      `<span class="gs-group-path">${_escHtml(matches[0].relPath)}</span>` +
      `<span class="gs-group-count">${matches.length}</span>`;
    group.appendChild(head);

    for (const r of matches) {
      const row = document.createElement('div');
      row.className = 'gs-result' + (r._idx === _searchActiveIdx ? ' gs-result--active' : '');
      row.dataset.idx = String(r._idx);

      const text = r.lineText;
      const matchAt = r.matchStart;
      const matchLength = r.matchLength;

      const lineNum = document.createElement('span');
      lineNum.className = 'gs-line-num';
      lineNum.textContent = r.line;

      const lineText = document.createElement('span');
      lineText.className = 'gs-line-text';

      if (matchAt >= 0) {
        // Highlight the match by stitching together text nodes + a <mark>.
        // Building the line from DOM nodes (instead of innerHTML) means
        // arbitrary line content can never break out into HTML.
        const before = document.createTextNode(text.slice(0, matchAt));
        const mark = document.createElement('mark');
        mark.className = 'gs-highlight';
        mark.textContent = text.slice(matchAt, matchAt + matchLength);
        const after = document.createTextNode(text.slice(matchAt + matchLength));
        lineText.append(before, mark, after);
      } else {
        lineText.textContent = text.trim();
      }

      row.append(lineNum, lineText);
      row.addEventListener('click', () => _jumpToSearchResult(r));
      group.appendChild(row);
    }

    frag.appendChild(group);
  }

  resultsEl.appendChild(frag);
}

function _moveSearchSelection(delta) {
  if (!_searchResults.length) return;
  _searchActiveIdx = (_searchActiveIdx + delta + _searchResults.length) % _searchResults.length;
  // Re-render only if there's an active query -- otherwise the result list is
  // empty and there's nothing to highlight.
  const q = $('gs-input')?.value;
  if (q) _renderSearchResults();
  const active = $('gs-results').querySelector('.gs-result--active');
  active?.scrollIntoView({ block: 'nearest' });
}

function _jumpToSearchResult(result) {
  if (!result) return;
  closeGlobalSearch();
  openFileEditor(result.filePath);
  // openFileEditor mounts the editor asynchronously (CM.mount is async),
  // so the goto has to wait a tick before the view exists.
  setTimeout(() => window.CM?.gotoLine(result.line, result.col), 80);
}

// Diff / compare view. Two entry points: comparing two arbitrary files on
// disk (read-only both sides), and comparing the active tab's unsaved buffer
// against what's actually on disk (left side stays editable -- edits there
// should flow back into the real tab, not get silently dropped when the
// diff closes).
let _diffMode = null; // 'files' | 'unsaved' | null

function openDiffBetweenFiles(pathA, pathB) {
  let contentA, contentB;
  try { contentA = fs.readFileSync(pathA, 'utf8'); }
  catch (e) { showToast('Could not read ' + path.basename(pathA) + ': ' + e.message); return; }
  try { contentB = fs.readFileSync(pathB, 'utf8'); }
  catch (e) { showToast('Could not read ' + path.basename(pathB) + ': ' + e.message); return; }

  _diffMode = 'files';
  $('diff-label-left').textContent = path.basename(pathA);
  $('diff-label-right').textContent = path.basename(pathB);
  $('modal-diff').classList.remove('hidden');

  window.CMDiff.mount({
    host: 'diff-host',
    left: contentA,
    right: contentB,
    ext: path.extname(pathA).toLowerCase(),
    leftEditable: false,
    rightEditable: false,
  });
}

function openDiffVsSaved() {
  const tab = _getActiveTab();
  if (!tab) { showToast('Open a file first'); return; }
  if (!tab.isDirty) { showToast('No unsaved changes to compare'); return; }

  const ext = path.extname(tab.filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext) || BINARY_EXTS.has(ext)) {
    showToast('Diff is only available for text files');
    return;
  }

  _diffMode = 'unsaved';
  $('diff-label-left').textContent = path.basename(tab.filePath) + ' (unsaved)';
  $('diff-label-right').textContent = path.basename(tab.filePath) + ' (saved)';
  $('modal-diff').classList.remove('hidden');

  window.CMDiff.mount({
    host: 'diff-host',
    left: window.CM ? window.CM.getValue() : tab.originalContent,
    right: tab.originalContent,
    ext,
    leftEditable: true,
    rightEditable: false,
    // Deliberately NOT synced back to the main editor on every keystroke --
    // window.CM.setValue() replaces the whole document and resets the
    // cursor to position 0, so live-syncing here would yank the real
    // editor's cursor on every character typed in the diff pane. Instead
    // closeDiff() reads window.CMDiff.getLeftValue() once and writes it
    // back a single time, only if it actually changed.
  });
}

function closeDiff() {
  if (_diffMode === 'unsaved' && window.CM && window.CMDiff) {
    const edited = window.CMDiff.getLeftValue();
    if (edited !== window.CM.getValue()) window.CM.setValue(edited);
  }
  window.CMDiff?.destroy();
  $('modal-diff').classList.add('hidden');
  _diffMode = null;
}

// Global keyboard shortcuts. Wired in init() so tests can load the module
// without registering handlers on the shared document.
function _initGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'n') { e.preventDefault(); openNewProjectModal(); }
    if (meta && e.key === 'o') { e.preventDefault(); pickFolder(loadProject); }
    if (meta && e.key === 'b') { e.preventDefault(); if (state.projectDir) { switchTab('build'); runBuild(); } }
    if (meta && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openGlobalSearch(); }
    if (meta && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); openDiffVsSaved(); }
    if (meta && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openQuickOpen(); }
    if (meta && e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openCommandPalette(); }
    if (meta && e.shiftKey && (e.key === 'W' || e.key === 'w')) { e.preventDefault(); openWorkspaces(); }
    if (meta && e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAllOpenFiles(); }
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => {
        if (m.id === 'modal-diff') return;
        if (m.id === 'modal-quick-open') return;
        if (m.id === 'modal-command-palette') return;
        m.classList.add('hidden');
      });
    }
  });
}

// About & Update check

function openAboutModal() {
  $('modal-about').classList.remove('hidden');
}

// Returns true if semver string a > b. Only handles plain X.Y.Z --
// prerelease tags are ignored, which is fine for the "should we show the
// update badge?" decision.
function _semverGt(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(Number);
  const pb = String(b).replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Fetch the latest release tag from GitHub, with a 10s timeout so a
// slow / unreachable GitHub doesn't hang the launch. Silent by default --
// the badge is the only signal; non-silent mode shows a toast on no-update.
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
let _latestUpdateRelease = null;

async function checkForUpdates(silent = true) {
  const checkButton = $('btn-check-updates');
  if (checkButton) checkButton.disabled = true;
  if (!silent) {
    $('modal-update')?.classList.remove('hidden');
    $('update-title').textContent = 'Checking for updates';
    $('update-current-version').textContent = `Installed version ${STUDIO_VERSION}`;
    $('update-new-version').textContent = '';
    $('update-status').textContent = 'Checking the latest release…';
    $('update-footer-status').textContent = 'Contacting GitHub for the latest release.';
    $('btn-download-update').disabled = true;
    $('update-assets-section').classList.add('hidden');
    $('update-changelog').textContent = '';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    if (!latest) throw new Error('Release response did not include a version tag');

    _latestUpdateRelease = release;
    const badge = $('btn-update-badge');
    if (_semverGt(latest, STUDIO_VERSION)) {
      if (badge) {
        badge.classList.remove('hidden');
        badge.onclick = () => openUpdateModal(release, latest);
      }
      if (!silent) openUpdateModal(release, latest);
    } else {
      badge?.classList.add('hidden');
      if (!silent) {
        _renderNoUpdateState(release, latest);
        showToast('NovaByte Studio is up to date');
      }
    }
  } catch (err) {
    console.warn('[updates] Release check failed:', err);
    if (!silent) {
      $('update-title').textContent = 'Could not check for updates';
      $('update-status').textContent = 'The latest release could not be reached.';
      $('update-footer-status').textContent = 'Check your connection and try again.';
      $('btn-download-update').disabled = !_latestUpdateRelease;
      showToast('Could not check for updates');
    }
  } finally {
    clearTimeout(timeout);
    if (checkButton) checkButton.disabled = false;
  }
}

function _renderNoUpdateState(release, latest) {
  openUpdateModal(release, latest);
  $('update-title').textContent = 'You’re up to date';
  $('update-current-version').textContent = `Installed version ${STUDIO_VERSION}`;
  $('update-new-version').textContent = `Latest version ${latest}`;
  $('update-status').textContent = 'You’re running the latest release';
  $('update-footer-status').textContent = 'No update is needed right now.';
  $('btn-download-update').classList.add('hidden');
  $('btn-download-update').disabled = false;
  $('update-assets-section').classList.add('hidden');
  $('update-new-version').classList.add('update-version-line--current');
}

function _formatReleaseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? `Published ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)}`
    : '';
}

function _safeReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function _renderReleaseAssets(release) {
  const section = $('update-assets-section');
  const list = $('update-assets-list');
  list.replaceChildren();
  const assets = (Array.isArray(release.assets) ? release.assets : [])
    .filter((asset) => asset && typeof asset.name === 'string' && _safeReleaseUrl(asset.browser_download_url));
  $('update-release-assets-count').textContent = assets.length
    ? `${assets.length} download${assets.length === 1 ? '' : 's'}`
    : '';
  if (!assets.length) {
    section.classList.add('hidden');
    return;
  }

  for (const asset of assets) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'update-asset';
    const name = document.createElement('span');
    name.className = 'update-asset-name';
    name.textContent = asset.name;
    const size = document.createElement('span');
    size.className = 'update-asset-size';
    size.textContent = Number.isFinite(asset.size) ? _formatSize(asset.size) : '';
    link.append(name, size);
    link.addEventListener('click', () => _openUpdateUrl(asset.browser_download_url));
    list.appendChild(link);
  }
  section.classList.remove('hidden');
}

function _openUpdateUrl(value) {
  const url = _safeReleaseUrl(value);
  if (!url) {
    showToast('This release link is not valid');
    return;
  }
  nw.Shell.openExternal(url);
}

function openUpdateModal(release, latest) {
  $('update-title').textContent = 'Update available';
  $('update-new-version').textContent = `Version ${latest} available`;
  $('update-current-version').textContent = `You have version ${STUDIO_VERSION}`;
  $('update-status').textContent = 'A newer version is ready';
  $('update-release-channel').textContent = release.prerelease ? 'Pre-release' : 'Stable release';
  $('update-release-date').textContent = _formatReleaseDate(release.published_at);
  $('update-footer-status').textContent = 'Updates are downloaded from the official release page.';
  $('btn-download-update').textContent = 'View release';
  $('btn-download-update').classList.remove('hidden');
  $('btn-download-update').disabled = false;
  $('update-new-version').classList.remove('update-version-line--current');
  _renderReleaseAssets(release);

  let body = (release.body || 'No changelog provided.');

  // Strip the leading title block: "# <emoji?> vX.Y.Z", the blockquote
  // download link, and the following "---" divider. This is generated
  // by the release template every time, so match it structurally instead
  // of hardcoding a version number.
  body = body.replace(/^#\s.*\n+>\s*\*\*\[.*?\]\(.*?\)\*\*\n+---\n*/i, '');

  // Strip the "## Installation" section (heading, intro line, table,
  // and everything after -- it's always the last section) rather than
  // hardcoding filenames/links that change every release.
  body = body.replace(/##\s*(?:\u{1F4E6}\s*)?Installation[\s\S]*$/i, '');

  // Clean up any now-orphaned trailing "---" divider left by the strips above.
  body = body.replace(/\n+---\s*$/, '');
  body = body.trim();

  // release.body is remote content from GitHub -- parse as markdown, then
  // sanitize before injecting as HTML. Never skip the sanitize step just
  // because "it's our own repo": a compromised token or an edited release
  // is enough to turn this into a script-injection vector.
  const rawHtml = (typeof markdownit === 'function')
    ? markdownit({ html: false, linkify: false, typographer: false }).render(body)
    : `<p>${_escHtml(body)}</p>`; // fallback if markdown-it failed to load
  const cleanHtml = (typeof DOMPurify !== 'undefined')
    ? DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } })
    : _escHtml(body); // if DOMPurify is missing, never inject unsanitized HTML -- show escaped text instead
  $('update-changelog').innerHTML = cleanHtml;

  $('btn-download-update').onclick = () => _openUpdateUrl(release.html_url);

  $('modal-update').classList.remove('hidden');
}

// Event wiring. Each init step is wrapped in try/catch so one failure
// (e.g. a missing element in a future markup change) doesn't take down the
// rest of the app's wiring. Each failure is logged to console.error.
function _safeInit(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[init] ${label} failed:`, err);
  }
}

function init() {
  _safeInit('screens', () => {
    screens = {
      welcome: $('screen-welcome'),
      project: $('screen-project'),
      inspector: $('screen-inspector'),
      settings: $('screen-settings'),
    };
  });
  _safeInit('loadStorage', loadStorage);
  _safeInit('applyTheme', () => applyTheme(state.theme));
  _safeInit('_initOsThemeListener', _initOsThemeListener);
  _safeInit('studio tutorial', _initStudioTutorial);
  _safeInit('initWindowControls', initWindowControls);
  _safeInit('initWindowDesigner', initWindowDesigner);
  _safeInit('initDesignTab', initDesignTab);
  _safeInit('NBPro.init', () => window.NBPro && window.NBPro.init());
  _safeInit('_initPermissionsSearch', _initPermissionsSearch);
  _safeInit('initHelp', initHelp);
  _safeInit('_initStudioDialogs', _initStudioDialogs);
  _safeInit('_initCloseGuard', _initCloseGuard);
  _safeInit('initInspectorDrop', initInspectorDrop);
  _safeInit('renderRecent', renderRecent);
  _safeInit('_initThemePicker', _initThemePicker);
  _safeInit('initPaneDocking', initPaneDocking);
  _safeInit('initSidebarResize', initSidebarResize);
  _safeInit('initRailResize', initRailResize);
  _safeInit('initSidebarCollapse', initSidebarCollapse);
  _safeInit('_initManifestAutosave', _initManifestAutosave);
  _safeInit('_applyAutosaveSettings', _applyAutosaveSettings);

  // Update shortcut badges to show Ctrl vs \u2318 based on platform
  _safeInit('shortcut labels', () => {
    const _sc = (id, lbl) => { const el = document.getElementById(id); if (el) el.textContent = lbl; };
    _sc('editorctx-undo-shortcut', `${MOD_KEY}+Z`);
    _sc('editorctx-redo-shortcut', `${MOD_KEY}+Shift+Z`);
    _sc('editorctx-cut-shortcut', `${MOD_KEY}+X`);
    _sc('editorctx-copy-shortcut', `${MOD_KEY}+C`);
    _sc('editorctx-paste-shortcut', `${MOD_KEY}+V`);
    _sc('editorctx-select-all-shortcut', `${MOD_KEY}+A`);
    _sc('sc-new', `${MOD_KEY}+N`);
    _sc('sc-open', `${MOD_KEY}+O`);
    _sc('sc-build', `${MOD_KEY}+B`);
    _sc('sc-quick-open', `${MOD_KEY}+P`);
    _sc('sc-quickopen', `${MOD_KEY}+P`);
    _sc('sc-palette', `${MOD_KEY}+Shift+P`);
    _sc('sc-search', `${MOD_KEY}+Shift+F`);
    _sc('sc-diff', `${MOD_KEY}+Shift+D`);
    _sc('sc-workspaces', `${MOD_KEY}+Shift+W`);

    // Same platform-aware shortcut also lives in these button tooltips
    const _title = (id, lbl) => { const el = document.getElementById(id); if (el) el.title = el.title.replace(/Ctrl\/Cmd/, lbl); };
    _title('btn-global-search', MOD_KEY);
    _title('btn-workspaces', MOD_KEY);
    _title('btn-diff-vs-saved', MOD_KEY);
  });

  // Titlebar drag region for frameless window
  _safeInit('titlebar dblclick', () => {
    $('titlebar')?.addEventListener('dblclick', () => {
      const win = nw.Window.get();
      if (win.isMaximized) win.restore(); else win.maximize();
    });
  });

  // Welcome
  _safeInit('welcome buttons', () => {
    $('welcome-new')?.addEventListener('click', openNewProjectModal);
    $('welcome-open')?.addEventListener('click', () => pickFolder(loadProject));
  });

  // Sidebar
  _safeInit('sidebar buttons', () => {
    const quickAccessToggle = $('btn-toggle-quick-access');
    const quickAccess = $('sidebar-quick-actions');
    const setQuickAccessCollapsed = (collapsed) => {
      state.quickAccessCollapsed = collapsed;
      document.documentElement.dataset.quickAccessCollapsed = String(collapsed);
      quickAccessToggle?.setAttribute('aria-expanded', String(!collapsed));
      quickAccess?.setAttribute('aria-hidden', String(collapsed));
      if (quickAccess) quickAccess.inert = collapsed;
    };
    setQuickAccessCollapsed(state.quickAccessCollapsed);
    quickAccessToggle?.addEventListener('click', () => {
      setQuickAccessCollapsed(!state.quickAccessCollapsed);
      saveStorage();
    });
    $('btn-new-project')?.addEventListener('click', openNewProjectModal);
    $('btn-open-project')?.addEventListener('click', () => pickFolder(loadProject));
    $('btn-sidebar-command')?.addEventListener('click', openCommandPalette);
    $('btn-sidebar-search')?.addEventListener('click', openGlobalSearch);
    $('btn-sidebar-workspaces')?.addEventListener('click', openWorkspaces);
    $('btn-sidebar-source-control')?.addEventListener('click', () => switchTab('git'));
    $('btn-sidebar-build')?.addEventListener('click', () => switchTab('build'));
    $('btn-inspect')?.addEventListener('click', showInspector);
    $('btn-editor-settings')?.addEventListener('click', showSettings);
    $('btn-about')?.addEventListener('click', openAboutModal);
    $('sidebar-sc-command').textContent = `${MOD_KEY}+Shift+P`;
    $('sidebar-sc-search').textContent = `${MOD_KEY}+Shift+F`;
    $('sidebar-sc-workspaces').textContent = `${MOD_KEY}+Shift+W`;
    _updateSidebarQuickAccess();
  });

  // Tabs
  _safeInit('tabs', () => {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    _initReviewPreviewControls();
    window.addEventListener('resize', () => {
      if (state.activeTab === 'review') renderReviewPreview();
    });
  });

  // Manifest
  _safeInit('manifest buttons', () => {
    $('btn-save-manifest')?.addEventListener('click', saveManifest);
    $('btn-save-manifest-perms')?.addEventListener('click', saveManifest);
    $('design-window-popup-save')?.addEventListener('click', saveManifest);
    $('btn-manifest-permissions')?.addEventListener('click', () => switchTab('permissions'));
    $('btn-manifest-design')?.addEventListener('click', () => switchTab('design'));
    $('btn-view-json')?.addEventListener('click', async () => {
      const windowError = _windowSettingsError();
      if (windowError) {
        await studioAlert(windowError, { title: 'Check window dimensions' });
        return;
      }
      const manifest = readManifestForm();
      $('json-viewer').textContent = JSON.stringify(manifest, null, 2);
      $('modal-json').classList.remove('hidden');
    });
  });

  // File tree -- toolbar buttons
  _safeInit('file tree toolbar', () => {
    $('file-tree-filter')?.addEventListener('input', (event) => {
      const query = event.target.value;
      $('btn-clear-file-filter')?.classList.toggle('hidden', !query.trim());
      if (_fileTreeFilterTimer) clearTimeout(_fileTreeFilterTimer);
      _fileTreeFilterTimer = setTimeout(() => {
        _fileTreeFilterTimer = null;
        if (query === $('file-tree-filter')?.value) _filterProjectFiles(query);
      }, 120);
    });
    $('file-tree-filter')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.target.value) {
        event.preventDefault();
        event.target.value = '';
        _filterProjectFiles('');
      }
    });
    $('btn-clear-file-filter')?.addEventListener('click', () => {
      const input = $('file-tree-filter');
      if (!input) return;
      input.value = '';
      _filterProjectFiles('');
      input.focus();
    });
    $('btn-collapse-all-folders')?.addEventListener('click', _collapseAllFileTreeFolders);
    $('btn-refresh-files')?.addEventListener('click', () => {
      if (state.projectDir) populateFileTree(state.projectDir);
    });
    $('btn-global-search')?.addEventListener('click', openGlobalSearch);
    $('btn-workspaces')?.addEventListener('click', openWorkspaces);
    _initCommandPalette();
    _initGlobalSearch();
    _initQuickOpen();
    _initGitPanel();
    _initNewProjectIdSync();
    _initModalDismissHandlers();
    _initGlobalShortcuts();
  });

  // Build history
  _safeInit('build history', () => {
    _renderBuildHistory();
    $('btn-clear-history')?.addEventListener('click', () => {
      localStorage.removeItem(BUILD_HISTORY_KEY);
      _renderBuildHistory();
    });
  });

  // Workspace modal
  _safeInit('workspace modal', () => {
    $('btn-workspace-save')?.addEventListener('click', () => _saveCurrentWorkspace($('workspace-name-input')?.value));
    $('workspace-name-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !$('btn-workspace-save')?.disabled) {
        _saveCurrentWorkspace($('workspace-name-input').value);
      }
    });
    $('workspace-search')?.addEventListener('input', (event) => {
      _workspaceQuery = event.target.value;
      _renderWorkspaceList();
    });
    $('[data-close="modal-workspace"]')?.addEventListener('click', closeWorkspaces);
  });

  // Right-click on empty space in the file rail
  _safeInit('rail contextmenu', () => {
    $('project-rail')?.addEventListener('contextmenu', (e) => {
      // Only fire if the click wasn't on a file item (those stop propagation)
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, null);
    });
  });

  _safeInit('new file/folder buttons', () => {
    $('btn-new-file')?.addEventListener('click', () => promptNewFile());
    $('btn-new-folder')?.addEventListener('click', () => promptNewFolder());
  });

  // Editor
  _safeInit('editor', () => {
    initEditorDirtyTracking();
    _initSettingsPage();
    $('btn-editor-empty-open')?.addEventListener('click', openQuickOpen);
    $('cm-editor-host')?.addEventListener('contextmenu', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.cm-content')) return;
      if (!_getActiveTab() || IMAGE_EXTS.has(path.extname(_getActiveTab().filePath).toLowerCase())) return;
      event.preventDefault();
      event.stopPropagation();
      _showEditorContextMenu(event.clientX, event.clientY);
    });
    $('editor-tabs')?.addEventListener('contextmenu', (event) => {
      const tabElement = event.target instanceof Element ? event.target.closest('.editor-tab') : null;
      if (!tabElement || IMAGE_EXTS.has(path.extname(tabs[Number(tabElement.dataset.index)]?.filePath || '').toLowerCase())) return;
      event.preventDefault();
      event.stopPropagation();
      _showEditorContextMenu(event.clientX, event.clientY, Number(tabElement.dataset.index));
    });
    $('btn-editor-find')?.addEventListener('click', () => window.CM?.openFind());
    $('btn-editor-wrap')?.addEventListener('click', () => {
      const current = window.CM?.getSettings();
      if (!current) return;
      const wordWrap = !current.wordWrap;
      window.CM.applySettings({ wordWrap });
      if ($('chk-word-wrap')) $('chk-word-wrap').checked = wordWrap;
      _updateEditorToolbar();
    });
    $('btn-editor-preview')?.addEventListener('click', _togglePreview);
    $('btn-editor-font-dec')?.addEventListener('click', () => {
      const current = window.CM?.getSettings();
      if (!current) return;
      const fontSize = Math.max(10, current.fontSize - 1);
      window.CM.applySettings({ fontSize });
      if ($('lbl-font-size')) $('lbl-font-size').textContent = fontSize;
      _updateEditorToolbar();
    });
    $('btn-editor-font-inc')?.addEventListener('click', () => {
      const current = window.CM?.getSettings();
      if (!current) return;
      const fontSize = Math.min(24, current.fontSize + 1);
      window.CM.applySettings({ fontSize });
      if ($('lbl-font-size')) $('lbl-font-size').textContent = fontSize;
      _updateEditorToolbar();
    });
    $('btn-editor-save')?.addEventListener('click', saveOpenFile);
    $('btn-editor-save-all')?.addEventListener('click', saveAllOpenFiles);
    $('btn-refresh-preview')?.addEventListener('click', _refreshPreviewIfVisible);
    $('btn-diff-vs-saved')?.addEventListener('click', openDiffVsSaved);
    $('btn-diff-prev')?.addEventListener('click', () => window.CMDiff?.goToPreviousChunk());
    $('btn-diff-next')?.addEventListener('click', () => window.CMDiff?.goToNextChunk());
    _updateEditorToolbar();
  });

  // Context menu actions
  _safeInit('context menu actions', () => {
    $('editorctx-undo')?.addEventListener('click', () => { hideEditorContextMenu(); window.CM?.undo(); });
    $('editorctx-redo')?.addEventListener('click', () => { hideEditorContextMenu(); window.CM?.redo(); });
    $('editorctx-cut')?.addEventListener('click', () => { hideEditorContextMenu(); _copyEditorSelection(true); });
    $('editorctx-copy')?.addEventListener('click', () => { hideEditorContextMenu(); _copyEditorSelection(); });
    $('editorctx-paste')?.addEventListener('click', () => { hideEditorContextMenu(); _pasteEditorClipboard(); });
    $('editorctx-select-all')?.addEventListener('click', () => { hideEditorContextMenu(); window.CM?.selectAll(); });
    $('editorctx-format')?.addEventListener('click', async () => {
      hideEditorContextMenu();
      try {
        await _formatActiveFile();
      } catch (error) {
        console.error('[editor] Formatting failed:', error);
        showToast(`Could not format file: ${error.message}`);
      }
    });
    $('filectx-rename')?.addEventListener('click', () => { const t = _contextTarget; hideContextMenu(); renameItem(t); });
    $('filectx-duplicate')?.addEventListener('click', () => { const t = _contextTarget; hideContextMenu(); duplicateItem(t); });
    $('filectx-compare')?.addEventListener('click', () => {
      const t = _contextTarget;
      hideContextMenu();
      if (!t) return;
      pickFile(null, (otherPath) => openDiffBetweenFiles(t, otherPath));
    });
    $('ctx-new-file')?.addEventListener('click', () => { const d = _getContextTargetDir(); hideContextMenu(); promptNewFile(d); });
    $('ctx-new-folder')?.addEventListener('click', () => { const d = _getContextTargetDir(); hideContextMenu(); promptNewFolder(d); });
    $('filectx-delete')?.addEventListener('click', () => { const t = _contextTarget; hideContextMenu(); deleteItem(t); });
  });

  // Recents context menu actions
  _safeInit('recents context menu', () => {
    $('rctx-open')?.addEventListener('click', () => { const d = _recentContextTarget; hideRecentContextMenu(); if (d) loadProject(d); });
    $('rctx-pin')?.addEventListener('click', () => { const d = _recentContextTarget; hideRecentContextMenu(); if (d) toggleRecentPin(d); });
    $('rctx-copy-path')?.addEventListener('click', () => { const d = _recentContextTarget; hideRecentContextMenu(); if (d) copyRecentPath(d); });
    $('rctx-reveal')?.addEventListener('click', () => { const d = _recentContextTarget; hideRecentContextMenu(); if (d) revealRecentInFolder(d); });
    $('rctx-remove')?.addEventListener('click', () => { const d = _recentContextTarget; hideRecentContextMenu(); if (d) removeRecent(d); });
  });

  // Dismiss context menus on outside click + Escape-to-close modals
  _safeInit('document-wide handlers', () => {
    document.addEventListener('click', () => { hideContextMenu(); hideRecentContextMenu(); hideEditorContextMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        hideRecentContextMenu();
        hideEditorContextMenu();
        if (!$('modal-diff').classList.contains('hidden')) closeDiff();
        if (!$('modal-quick-open').classList.contains('hidden')) closeQuickOpen();
        if (!$('modal-workspace').classList.contains('hidden')) closeWorkspaces();
        if (!$('modal-command-palette').classList.contains('hidden')) closeCommandPalette();
      }
    });
  });

  // Build
  _safeInit('build tab', () => {
    $('btn-check-syntax')?.addEventListener('click', checkSyntax);
    $('sb-syntax')?.addEventListener('click', () => switchTab('build'));
    // Live permission badge -> jump to the Manifest tab's permission grid,
    // since that's where the "declared" side of the ok/undeclared check
    // lives (the same place _renderPermissionAudit's audit-row explanations
    // point to when someone wants to fix an undeclared permission).
    $('sb-perm-live')?.addEventListener('click', () => switchTab('manifest'));
    $('btn-build')?.addEventListener('click', runBuild);
    $('btn-copy-build-path')?.addEventListener('click', _copyBuildOutputPath);
    $('btn-open-build-folder')?.addEventListener('click', _openBuildOutputFolder);
    $('btn-clear-build-log')?.addEventListener('click', clearLog);
    $('btn-preview-build-contents')?.addEventListener('click', () => _renderBuildContentsPreview(true));
    $('btn-build-profile-save')?.addEventListener('click', _saveBuildProfile);
    $('build-profile-select')?.addEventListener('change', (event) => {
      if (event.target.value) _applyBuildProfile(event.target.value);
      else $('btn-build-profile-delete').disabled = true;
    });
    $('btn-build-profile-delete')?.addEventListener('click', () => {
      const select = $('build-profile-select');
      if (!select.value) return;
      const profiles = _readBuildProfiles().filter((profile) =>
        profile.name !== select.value || profile.projectDir !== state.projectDir);
      try {
        localStorage.setItem(BUILD_PROFILES_KEY, JSON.stringify(profiles));
        _renderBuildProfiles();
      } catch (error) {
        console.error('Could not delete build profile:', error);
        showToast(`Could not delete build profile: ${error.message}`);
      }
    });
    $('btn-pick-outdir')?.addEventListener('click', () => {
      pickFolder((dir) => {
        $('build-outdir').value = dir;
        _updateBuildSummary();
        _renderBuildContentsPreview();
      });
    });
    $('build-outdir')?.addEventListener('input', _updateBuildSummary);
    $('build-clean')?.addEventListener('change', _updateBuildSummary);
    _updateBuildSummary();
    _renderBuildProfiles();
  });

  // Sign
  _safeInit('sign tab', () => {
    $('btn-sign-generate-key')?.addEventListener('click', () => _generateDevKeypair());
    $('btn-sign-selfsign')?.addEventListener('click', _runSelfSign);
    $('btn-sign-go-build')?.addEventListener('click', () => switchTab('build'));
    $('btn-sign-submit-review')?.addEventListener('click', () => {
      try {
        nw.Shell.openExternal('https://novabyteteam.github.io/novabyte-os/');
      } catch (err) {
        console.error('Could not open NovaByte OS verification page:', err);
        showToast('Could not open the NovaByte OS website');
      }
    });
    $('sign-dev-privkey')?.addEventListener('input', _updateSignActionAvailability);
    $('sign-dev-custom-key')?.addEventListener('input', _updateSignActionAvailability);

    const localdevToggle = $('btn-localdev-toggle');
    const localdevConfig = $('localdev-config');
    localdevToggle?.addEventListener('click', () => {
      const expanded = localdevToggle.getAttribute('aria-expanded') === 'true';
      localdevToggle.setAttribute('aria-expanded', String(!expanded));
      localdevConfig?.classList.toggle('hidden', expanded);
    });

    // Private key is masked by default (CSS-only obscuring -- see
    // .key-field--masked in style.css; the underlying .value is never
    // touched, so every existing read site keeps working unchanged).
    const privkeyField = $('sign-dev-privkey');
    const privkeyRevealBtn = $('btn-privkey-reveal');
    privkeyRevealBtn?.addEventListener('click', () => {
      const willReveal = privkeyRevealBtn.getAttribute('aria-pressed') !== 'true';
      privkeyField?.classList.toggle('key-field--masked', !willReveal);
      privkeyRevealBtn.setAttribute('aria-pressed', String(willReveal));
      privkeyRevealBtn.innerHTML = _uiIcon(willReveal ? 'eye-off' : 'eye');
      privkeyRevealBtn.title = willReveal ? 'Hide private key' : 'Show private key';
      privkeyRevealBtn.setAttribute('aria-label', privkeyRevealBtn.title);
    });

    const _wireCopyButton = (btnId, fieldId) => {
      const btn = $(btnId);
      const field = $(fieldId);
      if (!btn || !field) return;
      btn.addEventListener('click', async () => {
        const value = field.value || '';
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          const original = btn.innerHTML;
          btn.innerHTML = _uiIcon('check');
          setTimeout(() => { btn.innerHTML = original; }, 1200);
        } catch (err) {
          showToast('Copy failed: ' + err.message);
        }
      });
    };
    _wireCopyButton('btn-privkey-copy', 'sign-dev-privkey');
    _wireCopyButton('btn-pubkey-copy', 'sign-dev-pubkey');
  });

  // Inspector
  _safeInit('inspector', () => {
    $('btn-pick-novaapp')?.addEventListener('click', () => {
      pickFile('.novaapp', inspectFile);
    });
    $('btn-compare-novaapps')?.addEventListener('click', () => $('inspector-compare-files')?.click());
    $('inspector-compare-files')?.addEventListener('change', async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (files.length !== 2 || !files[0].path || !files[1].path) {
        showToast('Choose exactly two local .novaapp packages to compare');
        return;
      }
      await _renderPackageComparison(files[0].path, files[1].path);
    });
  });

  _safeInit('project permission audit', () => {
    $('btn-project-permission-audit')?.addEventListener('click', _runProjectPermissionAudit);
  });

  // Manifest icon upload
  _safeInit('icon upload', () => {
    $('mf-icon-preview')?.addEventListener('click', () => $('mf-icon-file').click());
    $('btn-icon-upload')?.addEventListener('click', () => $('mf-icon-file').click());
    $('btn-icon-clear')?.addEventListener('click', () => {
      clearIconPreview();
      $('mf-icon').value = '';
    });
    $('mf-icon-file')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        setIconPreview(ev.target.result);
        $('mf-icon').value = '';
      };
      reader.readAsDataURL(file);
    });
  });

  // New project modal
  _safeInit('new project modal', () => {
    $('btn-np-studio-templates')?.addEventListener('click', () => _npSetTemplateSource('studio'));
    $('btn-np-community-templates')?.addEventListener('click', () => _npSetTemplateSource('community'));
    $('np-community-template-search')?.addEventListener('input', _npRenderCommunityTemplateMarketplace);
    $('np-community-template-sort')?.addEventListener('change', (event) => {
      _npCommunityTemplateSort = event.target.value === 'name' ? 'name' : 'recent';
      _npRenderCommunityTemplateMarketplace();
    });
    $('btn-np-community-refresh')?.addEventListener('click', () => {
      _npCommunityTemplateCatalogLoaded = false;
      void _npLoadCommunityTemplateCatalog({ refresh: true });
    });
    $('btn-pick-dir')?.addEventListener('click', () => {
      pickFolder((dir) => {
        const name = $('new-app-name').value.trim();
        $('new-app-dir').value = name ? path.join(dir, name.toLowerCase().replace(/\s+/g, '-')) : dir;
      });
    });
    $('btn-create-project')?.addEventListener('click', createProject);
    $('btn-save-user-template')?.addEventListener('click', _saveOpenProjectAsTemplate);
    $('btn-export-user-template')?.addEventListener('click', _exportSelectedUserTemplate);
    $('btn-import-user-template')?.addEventListener('click', () => $('user-template-import-file')?.click());
    $('user-template-import-file')?.addEventListener('change', (event) => {
      const filePath = event.target.files?.[0]?.path;
      event.target.value = '';
      if (filePath) _importUserTemplate(filePath);
    });
  });

  _safeInit('update modal', () => {
    $('btn-check-updates')?.addEventListener('click', () => checkForUpdates(false));
    $('update-changelog')?.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link) return;
      event.preventDefault();
      _openUpdateUrl(link.href);
    });
    $('btn-copy-update-version')?.addEventListener('click', async () => {
      const version = _latestUpdateRelease?.tag_name || STUDIO_VERSION;
      try {
        await navigator.clipboard.writeText(version);
        showToast(`Copied version ${version}`);
      } catch (err) {
        showToast(`Copy failed: ${err.message}`);
      }
    });
    const notesButton = $('btn-toggle-update-notes');
    const notesSection = $('update-changelog')?.closest('.update-notes-section');
    notesButton?.addEventListener('click', () => {
      const expanded = notesButton.getAttribute('aria-expanded') === 'true';
      notesButton.setAttribute('aria-expanded', String(!expanded));
      notesButton.textContent = expanded ? 'Expand' : 'Collapse';
      notesSection?.classList.toggle('is-collapsed', expanded);
    });
  });

  // Check for updates on launch (silent -- only shows badge if newer version found)
  _safeInit('checkForUpdates', () => checkForUpdates());

  _safeInit('custom select controls', _initCustomSelects);
  _safeInit('_initEditorPermissionHover', _initEditorPermissionHover);
  _safeInit('first-run setup', initFirstRunSetup);
  _safeInit('Studio plugins', () => {
    void _initStudioPlugins().catch((error) => {
      console.error('[plugins] Could not initialize plugin support:', error);
      _setPluginManagerNotice(`Could not initialize plugins: ${error.message}`, 'error');
    });
  });
}

// Boot. Only runs in a real browser/script context -- when this file is
// required from Node (tests), `module` is defined and we skip the boot
// block so tests can construct the module without initialising the UI.
if (typeof module === 'undefined') {
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
}

// Test-only exports. When this file is required from Node (Vitest), the
// functions below are accessible for unit testing. The boot block above is
// skipped, and the DOM/NW.js dependencies must be mocked by the test
// harness before requiring this file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // Pure helpers -- fully testable with no DOM or fs.
    _escHtml,
    _formatSize,
    _semverGt,
    _qoScore,
    _cpMatch,
    _cpScore,
    _isHexColor,
    _isValidTheme,
    _gitBadge,
    _timeAgo,
    _buildOutputContainsProject,
    _permissionsForChannel,
    _validateUserTemplate,
    _createProjectFromUserTemplate,
    _reviewSimulationBootstrap,
    // State + state mutators -- testable with localStorage mocked.
    state,
    tabs,
    loadStorage,
    saveStorage,
    addRecent,
    removeRecent,
    toggleRecentPin,
    _capUnpinnedRecents,
    _loadBuildHistory,
    _saveBuildHistory,
    _pushBuildEntry,
    _loadWorkspaces,
    _saveWorkspaces,
    _readManifest,
    _designIndexPath,
    _designProjectFiles,
    _designEnsureEntryScript,
    _designEnsureEntryStylesheet,
    _designEnsureRuntimeSupport,
    _designGetProjectFiles,
    pickFolder,
    pickFile,
    applyTheme,
    setTheme,
    getDefaultTheme,
    // Manifest form helpers -- testable with JSDOM and the form pre-populated.
    readManifestForm,
    populateManifestForm,
    // Path safety helper (added in the production rewrite).
    _safeJoinName,
    _isPathInside,
    // Constants
    PERMISSIONS,
    THEMES,
    DEFAULT_THEME,
    CUSTOM_THEME_ID,
    CUSTOM_THEME_VARS,
    STUDIO_VERSION,
    GITHUB_REPO,
    STORAGE_KEY,
    BUILD_HISTORY_KEY,
    WORKSPACES_KEY,
    IMAGE_EXTS,
    BINARY_EXTS,
    // Error classes
    StorageError,
    GitError,
    BuildError,
    // Coercion helpers
    _coerceToHex,
    // Inspector permission audit helpers
    _renderPermissionAudit,
    _scanPackagePermissionEvidence,
    // Init wiring (so tests can call them in isolation if desired)
    _initNewProjectIdSync,
    // File pickers (NW.js)
    pickFolder,
    pickFile,
    // Update check
    checkForUpdates,
    openUpdateModal,
  };
}