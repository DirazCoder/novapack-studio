// [NOVAPACK_APP_JS] -- from NovaPack Studio, not NBOSP
'use strict';

// NovaByte Studio -- UI Controller.
// Runs inside NW.js with full Node.js access. Loaded as a <script> in the
// packaged build; can also be required from Node.js (tests) thanks to the
// guarded boot block and module.exports at the bottom.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
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

const { build, inspect, verify, listActions, detectCppSources } = require('./src/sdk/builder.js');
const { TEMPLATES, create } = require('./src/sdk/templates.js');
const AppPackage = require('./src/sdk/app-package.js');

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
  railWidth: 220,
  railCollapsed: false,
  sidebarCollapsed: false,
  autosaveMode: 'off',
  autosaveManifest: true,
  autosaveEditor: true,
};
window.state = state;

// Permissions catalogue (mirrors app-permission-manager.js).
const PERMISSIONS = [
  { id: 'vfs:access', label: 'Shared file access', risk: 'high', description: 'Reading and editing user files throughout the shared NovaByte VFS; one grant covers read and write' },
  { id: 'vfs:read', label: 'Read files', risk: 'medium', description: 'Reading files a user opens/imports' },
  { id: 'vfs:write', label: 'Write files', risk: 'high', description: 'Saving files, exports, generated output' },
  { id: 'vfs:delete', label: 'Delete files', risk: 'critical', description: 'File managers, cleanup tools' },
  { id: 'vfs:metadata', label: 'File metadata', risk: 'low', description: 'Listing/sizing files without reading contents' },
  { id: 'net:internal', label: 'Internal network', risk: 'high', description: 'Calling this OS\'s own API/server endpoints -- also reaches private-network and cloud metadata addresses (169.254.169.254), not just same-origin' },
  { id: 'net:external', label: 'External network', risk: 'low', description: 'Calling public internet services (declare in the manifest; auto-granted unless previously denied)' },
  { id: 'net:websocket', label: 'WebSocket', risk: 'low', description: 'Public WebSocket connections (declare in the manifest; auto-granted unless previously denied)' },
  { id: 'device:notifications', label: 'Notifications', risk: 'low', description: 'Alerts, reminders, background-task completion pings' },
  { id: 'device:geolocation', label: 'Geolocation', risk: 'high', description: 'Maps, weather, location-tagged content' },
  { id: 'device:camera', label: 'Camera', risk: 'critical', description: 'Photo capture, video chat, QR/barcode scanning' },
  { id: 'device:microphone', label: 'Microphone', risk: 'critical', description: 'Voice recording, voice chat, dictation' },
  // clipboard:read/write were split out of vfs:read -- the clipboard is a
  // shared, ambient, cross-app channel and a permission literally named
  // "read files" was a misleading label for "also read whatever's on the
  // system clipboard". vfs:read is still honored as a fallback for apps
  // granted it before this split, so this isn't a breaking change.
  { id: 'clipboard:read', label: 'Read clipboard', risk: 'high', description: 'Paste-in tools, import-from-clipboard features. Can expose whatever any other app or the user copied, not just your own app\'s data.' },
  { id: 'clipboard:write', label: 'Write clipboard', risk: 'low', description: 'Copy-to-clipboard features (auto-granted when declared; does not allow reading clipboard contents)' },
  { id: 'mail:read', label: 'Read emails', risk: 'high', description: 'Inbox viewers, search, unread-count widgets' },
  { id: 'mail:write', label: 'Compose emails', risk: 'critical', description: 'Mark-as-read/move tools, compose-preview UIs' },
  { id: 'mail:send', label: 'Send emails', risk: 'critical', description: 'Send-on-your-behalf tools (needs its own SMTP config UI -- see below)' },
  { id: 'mail:delete', label: 'Delete emails', risk: 'critical', description: 'Cleanup/triage tools (spam pruning, bulk delete)' },
  { id: 'calendar:read', label: 'Read calendar', risk: 'medium', description: 'Agenda widgets, scheduling assistants' },
  { id: 'calendar:write', label: 'Edit calendar', risk: 'high', description: 'Event creation, meeting schedulers' },
  { id: 'calendar:delete', label: 'Delete calendar events', risk: 'high', description: 'Calendar cleanup/sync tools' },
  { id: 'contacts:read', label: 'Read contacts', risk: 'medium', description: 'Address-book pickers, CRM-style lookups' },
  { id: 'contacts:write', label: 'Edit contacts', risk: 'high', description: 'Contact import/sync tools' },
  { id: 'contacts:delete', label: 'Delete contacts', risk: 'high', description: 'Dedup/cleanup tools' },
  { id: 'system:info', label: 'System info', risk: 'medium', description: 'Diagnostics, \'about this device\' panels -- also gates reading settings values like username, region, timezone, and devMode' },
  { id: 'system:settings', label: 'System settings', risk: 'medium', description: 'Preference sync, theme/settings dashboards' },
  { id: 'system:apps', label: 'Manage apps', risk: 'medium', description: 'Launchers, app-store-style installers, dock/dashboard replacements' },
  { id: 'system:app-launch', label: 'Launch installed apps', risk: 'low', description: 'Launching an installed app without access to app inventory or management' },
  { id: 'system:events', label: 'System events', risk: 'medium', description: 'Reacting to OS-level events (theme change, etc.)' },
  { id: 'system:root', label: 'Run with root access', risk: 'critical', description: "Running the app's unrestrictedEntry as its complete host-page implementation instead of loading its HTML entry in the app sandbox; requires Developer Mode, Root Access, and a separate explicit confirmation" },
  { id: 'system:background', label: 'Run scheduled background tasks', risk: 'medium', description: 'Periodic sync/checks while closed -- reminders, cache refresh, polling (see below)' },
  { id: 'system:background:live', label: 'Keep running after you close it', risk: 'high', description: 'Staying alive after the window closes -- timers, active transfers, live connections (see below)' },
  { id: 'system:autostart', label: 'Start automatically when NovaByte starts', risk: 'high', description: 'Launching automatically at OS startup with no user action at all (see below)' },
  { id: 'admin:apps', label: 'Manage apps (admin)', risk: 'high', description: 'Fleet/security audit tools -- see actual grants per app, not just declared ones (needs admin mode, see below)' },
  { id: 'admin:users', label: 'Manage users', risk: 'critical', description: 'Session monitors, force-logout tools (needs admin mode)' },
  { id: 'admin:system', label: 'System administration', risk: 'critical', description: 'Security-policy dashboards, lockout/IP-block tuning (needs admin mode)' },
  { id: 'admin:audit', label: 'Audit logs', risk: 'high', description: 'Security/activity log viewers (needs admin mode)' },
  // NOTE: unlike every other entry here, this permission alone does nothing --
  // the app's manifest.json must ALSO set "allowNestedWebview": true (a
  // top-level manifest boolean, not a permission) for app-sandbox.js's
  // isNestedWebviewPermitted() to allow it. Both gates must pass. See the
  // Browser template in templates.js for a working example of both together.
  { id: 'sandbox:nested-webview', label: 'Embed live web content (nested browser view)', risk: 'critical', description: 'Apps that need to create their own <webview> for in-app browsing (e.g. a browser-style app). Requires manifest.allowNestedWebview: true as well.' },
  // Same two-gate pattern as sandbox:nested-webview above: this permission
  // alone does nothing. The manifest must ALSO set "sandbox.allowSameOrigin":
  // true (nested under sandbox, unlike allowNestedWebview which is
  // top-level) for app-sandbox.js's sanitizeSandboxAttr() to add
  // allow-same-origin to the app's webview. 'high', not 'critical': this
  // widens what an existing XSS in the guest can reach (shared cookies/
  // localStorage/sessionStorage on the origin) rather than handing the
  // guest a whole second uncontained renderer the way nested-webview does.
  { id: 'sandbox:same-origin', label: 'Access shared cookies & storage', risk: 'high', description: 'Apps that need a stable origin for cross-tab logic or an IPC bridge that depends on window.location.origin matching. Requires manifest.sandbox.allowSameOrigin: true as well.' },
  // Same two-gate pattern as sandbox:nested-webview and sandbox:same-origin
  // above: this permission alone does nothing. The manifest must ALSO set
  // "allowPopupsToEscapeSandbox": true (top-level, like allowNestedWebview)
  // for app-sandbox.js's sanitizeSandboxAttr() to add
  // allow-popups-to-escape-sandbox to the app's webview. 'high' risk:
  // a popup that escapes the sandbox is a fully unrestricted browsing
  // context, comparable risk to sandbox:same-origin.
  { id: 'sandbox:escape-popups', label: 'Let popups escape the sandbox', risk: 'high', description: 'Apps whose popups need to open as normal, unsandboxed browser windows (e.g. OAuth flows, external checkout). Requires manifest.allowPopupsToEscapeSandbox: true as well.' },
];

// Precomputed lookup tables for the permissions catalogue. Built once so
// hot paths (permission hover, audit rendering) don't iterate the array.
const _PERMISSION_MAP = Object.fromEntries(PERMISSIONS.map((p) => [p.id, p]));

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
  'vfs:read': `const file = await window.nova.ipc('nova:vfs:read', { path: '/path/to/file' });\n`,
  'vfs:write': `await window.nova.ipc('nova:vfs:write', { path: '/path/to/file', content: '' });\n`,
  'vfs:delete': `await window.nova.ipc('nova:vfs:delete', { path: '/path/to/file' });\n`,
  'vfs:metadata': `const meta = await window.nova.ipc('nova:vfs:metadata', { path: '/path/to/file' });\n`,
  'net:internal': `const result = await window.nova.ipc('nova:net:internal', { url: '/api/endpoint' });\n`,
  'net:external': `const result = await window.nova.ipc('nova:net:external', { url: 'https://api.example.com/...' });\n`,
  'net:websocket': `const socket = await window.nova.ipc('nova:net:websocket', { url: 'wss://example.com/socket' });\n`,
  'device:notifications': `await window.nova.ipc('nova:device:notifications', { title: '', body: '' });\n`,
  'device:geolocation': `const position = await window.nova.ipc('nova:device:geolocation', {});\n`,
  'device:camera': `const photo = await window.nova.ipc('nova:device:camera', {});\n`,
  'device:microphone': `const recording = await window.nova.ipc('nova:device:microphone', {});\n`,
  'clipboard:read': `const clipboardText = await window.nova.ipc('nova:clipboard:read', {});\n`,
  'clipboard:write': `await window.nova.ipc('nova:clipboard:write', { text: '' });\n`,
  'mail:read': `const messages = await window.nova.ipc('nova:mail:read', {});\n`,
  'mail:write': `await window.nova.ipc('nova:mail:write', { id: '', changes: {} });\n`,
  'mail:send': `await window.nova.ipc('nova:mail:send', { to: '', subject: '', body: '' });\n`,
  'mail:delete': `await window.nova.ipc('nova:mail:delete', { id: '' });\n`,
  'calendar:read': `const events = await window.nova.ipc('nova:calendar:read', {});\n`,
  'calendar:write': `await window.nova.ipc('nova:calendar:write', { title: '', start: '', end: '' });\n`,
  'calendar:delete': `await window.nova.ipc('nova:calendar:delete', { id: '' });\n`,
  'contacts:read': `const contacts = await window.nova.ipc('nova:contacts:read', {});\n`,
  'contacts:write': `await window.nova.ipc('nova:contacts:write', { id: '', changes: {} });\n`,
  'contacts:delete': `await window.nova.ipc('nova:contacts:delete', { id: '' });\n`,
  'system:info': `const info = await window.nova.ipc('nova:system:info', {});\n`,
  'system:settings': `await window.nova.ipc('nova:system:settings', { key: '', value: '' });\n`,
  'system:apps': `const apps = await window.nova.ipc('nova:system:apps', {});\n`,
  'system:events': `window.nova.on('nova:system:events', (event) => {\n  // handle OS-level event\n});\n`,
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
      when: () => tabs.length > 0 && (readManifestForm().permissions || []).includes(p.id),
      action: () => window.CM?.insertAtCursor(_PERM_SNIPPETS[p.id]),
    }));
}
const PERMISSION_CATEGORIES = {
  vfs:       { label: 'Filesystem',        icon: '\u{1F4C1}' },
  net:       { label: 'Network',           icon: '\u21C4' },
  clipboard: { label: 'Clipboard',         icon: '\u29C9' },
  mail:      { label: 'Mail',              icon: '\u2709' },
  calendar:  { label: 'Calendar',          icon: '\u{1F4C5}' },
  contacts:  { label: 'Contacts',          icon: '\u2630' },
  device:    { label: 'Device',            icon: '\u25C9' },
  system:    { label: 'System',            icon: '\u2699' },
  admin:     { label: 'Admin',             icon: '\u{1F6E1}' },
  sandbox:   { label: 'Sandbox',           icon: '\u29C8' },
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

// File-tree watcher state. Both are torn down on every project switch to
// avoid stacking watchers across loadProject() calls.
let _fileTreeWatcher = null;
let _fileTreeWatcherTimer = null;
let _fileTreeDragAbort = null; // AbortController for the tree's drag/drop listeners

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
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // localStorage can throw in private mode or when storage is disabled.
    // Fall back to defaults -- the app still runs, just without persistence.
    raw = null;
  }

  if (!raw) {
    state.theme = getDefaultTheme();
    state.lastNonCustomTheme = getDefaultTheme();
    state.railWidth = 220;
    state.railCollapsed = false;
    state.sidebarCollapsed = false;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Corrupted blob -- reset to defaults and let the next saveStorage()
    // overwrite the bad value so the user isn't stuck.
    state.theme = getDefaultTheme();
    state.lastNonCustomTheme = getDefaultTheme();
    state.railWidth = 220;
    state.railCollapsed = false;
    state.sidebarCollapsed = false;
    return;
  }

  // Treat anything that isn't a plain object as "no state" so a stray
  // array or string in the slot can't crash the field reads below.
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

  state.recentProjects = Array.isArray(data.recentProjects) ? data.recentProjects : [];
  state.theme = _isValidTheme(data.theme) ? data.theme : getDefaultTheme();
  state.customColors = (data.customColors && typeof data.customColors === 'object' && !Array.isArray(data.customColors))
    ? data.customColors
    : {};
  state.lastNonCustomTheme = THEMES.some((t) => t.id === data.lastNonCustomTheme)
    ? data.lastNonCustomTheme
    : DEFAULT_THEME;
  state.railWidth = (typeof data.railWidth === 'number' && data.railWidth >= 160 && data.railWidth <= 320)
    ? data.railWidth
    : 220;
  state.railCollapsed = !!data.railCollapsed;
  state.sidebarCollapsed = !!data.sidebarCollapsed;
  state.autosaveMode = data.autosaveMode === 'realtime' || (typeof data.autosaveMode === 'number' && data.autosaveMode > 0)
    ? data.autosaveMode
    : 'off';
  state.autosaveManifest = data.autosaveManifest !== false;
  state.autosaveEditor = data.autosaveEditor !== false;
}

function saveStorage() {
  let serialized;
  try {
    serialized = JSON.stringify({
      recentProjects: state.recentProjects,
      theme: state.theme,
      customColors: state.customColors,
      lastNonCustomTheme: state.lastNonCustomTheme,
      railWidth: state.railWidth,
      railCollapsed: state.railCollapsed,
      sidebarCollapsed: state.sidebarCollapsed,
      autosaveMode: state.autosaveMode,
      autosaveManifest: state.autosaveManifest,
      autosaveEditor: state.autosaveEditor,
    });
  } catch (err) {
    // JSON.stringify only fails on circular references or symbols on
    // properties -- neither should happen here, but if it does, swallow
    // rather than crash. Persistence is best-effort.
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
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
      railWidth: state.railWidth,
      railCollapsed: state.railCollapsed,
      sidebarCollapsed: state.sidebarCollapsed,
      autosaveMode: state.autosaveMode,
      autosaveManifest: state.autosaveManifest,
      autosaveEditor: state.autosaveEditor,
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

  if (_isValidTheme(data.theme)) state.theme = data.theme;
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
  if (THEMES.some((t) => t.id === data.lastNonCustomTheme)) {
    state.lastNonCustomTheme = data.lastNonCustomTheme;
  }
  if (typeof data.railWidth === 'number' && data.railWidth >= 160 && data.railWidth <= 320) {
    state.railWidth = data.railWidth;
  }
  state.railCollapsed = !!data.railCollapsed;
  state.sidebarCollapsed = !!data.sidebarCollapsed;
  if (data.autosaveMode === 'realtime' || (typeof data.autosaveMode === 'number' && data.autosaveMode > 0)) {
    state.autosaveMode = data.autosaveMode;
  }
  if (typeof data.autosaveManifest === 'boolean') state.autosaveManifest = data.autosaveManifest;
  if (typeof data.autosaveEditor === 'boolean') state.autosaveEditor = data.autosaveEditor;

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
  if ($('lbl-font-size')) $('lbl-font-size').textContent = window.CM?.getSettings()?.fontSize ?? 13;
  if ($('sel-tab-size')) $('sel-tab-size').value = String(window.CM?.getSettings()?.tabSize ?? 2);
  if ($('chk-word-wrap')) $('chk-word-wrap').checked = !!window.CM?.getSettings()?.wordWrap;
  const selMode = $('sel-autosave-mode');
  if (selMode) {
    selMode.value = state.autosaveMode === 'realtime' || (typeof state.autosaveMode === 'number')
      ? String(state.autosaveMode)
      : state.autosaveMode;
  }
  if ($('chk-autosave-manifest')) $('chk-autosave-manifest').checked = state.autosaveManifest;
  if ($('chk-autosave-editor')) $('chk-autosave-editor').checked = state.autosaveEditor;
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
const STUDIO_VERSION = '1.2.01';
const GITHUB_REPO = 'NovaByteOfficial/novapack-studio';

// Theme
const THEMES = [
  { id: 'nb-dark', label: 'NovaByte Dark', swatch: '#22c55e' },
  { id: 'nb-light', label: 'NovaByte Light', swatch: '#16a34a' },
  { id: 'midnight-blue', label: 'Midnight Blue', swatch: '#3b82f6' },
  { id: 'amber', label: 'Amber', swatch: '#d2952b' },
  { id: 'nightshade', label: 'Nightshade', swatch: '#c084fc' },
  { id: 'high-contrast', label: 'High Contrast', swatch: '#ffd60a' },
  { id: 'forest', label: 'Forest', swatch: '#4ade80' },
];
const DEFAULT_THEME = 'nb-dark';
const CUSTOM_THEME_ID = 'custom';

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

function applyTheme(themeId) {
  const valid = _isValidTheme(themeId) ? themeId : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', valid);
  state.theme = valid;

  if (valid === CUSTOM_THEME_ID) {
    _applyCustomColors(state.customColors);
  } else {
    _applyCustomColors(null); // strip any leftover inline overrides
  }
}

function setTheme(themeId) {
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
      check.textContent = '\u2713';
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
  $('btn-close').addEventListener('click', () => {
    _promptUnsaved();
    win.close(true);
  });
}

// Close guard. Intercepts the window close event when there are unsaved
// editor tabs. Prompts the user to Save / Discard / Cancel before the
// window closes.
function _hasDirtyTabs() {
  return tabs.some((t) => t.isDirty);
}

function _promptUnsaved() {
  if (!_hasDirtyTabs()) return;
  const names = tabs.filter((t) => t.isDirty).map((t) => path.basename(t.filePath)).join(', ');
  const ok = confirm(`You have unsaved changes in: ${names}\n\nClick OK to save and exit, or Cancel to exit without saving.`);
  if (ok) {
    try { saveAllOpenFiles(); } catch { /* swallow -- we're closing anyway */ }
  }
  // Suppress the dirty flag on every tab regardless of save outcome -- the
  // window is about to close, so re-prompting serves no purpose.
  for (const t of tabs) t.isDirty = false;
}

function _initCloseGuard() {
  const win = nw.Window.get();
  win.on('close', (e) => {
    if (!_hasDirtyTabs()) return;
    e.preventDefault();
    _promptUnsaved();
    // win.close(true) skips this close handler (force flag) so we don't
    // recurse; that's also why _promptUnsaved clears every dirty flag --
    // even if force didn't skip the handler, the next pass would no-op.
    win.close(true);
  });
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

function loadProject(dir) {
  if (!dir || typeof dir !== 'string') {
    showToast('Invalid project path');
    return;
  }
  if (!fs.existsSync(dir)) {
    alert(`Folder not found: ${dir}`);
    return;
  }
  if (state.projectDir && state.projectDir !== dir &&
      !_designFlushPendingBeforeSelectionChange()) {
    if (_designPendingEdit) {
      if (!window.confirm('A pending Design edit could not be saved. Switch projects and discard that edit?')) return;
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
        if (state.projectDir === dir) populateFileTree(dir);
        _fileTreeWatcherTimer = null;
      }, 250);
    });
  } catch {
    _fileTreeWatcher = null;
  }

  $('build-outdir').value = path.join(dir, 'dist');
  $('file-tree-path').textContent = dir;

  // Wire drag-and-drop on the tree. One AbortController per project so
  // re-opening a project (or opening a different one) cleanly removes the
  // previous set of listeners rather than stacking new ones on the same
  // element.
  _fileTreeDragAbort = new AbortController();
  _wireFileTreeDragDrop($('file-tree'), dir, _fileTreeDragAbort.signal);

  showScreen('project');
  window._nbproOnProjectLoaded?.(dir);
  switchTab('editor');
}

// Drag-and-drop wiring for the file-tree container. Lives outside
// loadProject() so the listener set is clearly tied to one signal.
function _wireFileTreeDragDrop(tree, dir, signal) {
  if (!tree) return;
  const clearTreeDragState = () => tree.classList.remove('drag-over');

  tree.addEventListener('dragenter', () => {
    if (_fileDragData) tree.classList.add('drag-over');
  }, { signal });
  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(e.relatedTarget)) clearTreeDragState();
  }, { signal });
  tree.addEventListener('dragover', (e) => {
    if (!_fileDragData) return;
    e.preventDefault();
    e.stopPropagation();
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
  const granted = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  renderPermissions(granted);

  _validateAppIdField();
  _syncWindowPreview();
}

function _permCategory(id) {
  return id.split(':')[0];
}

let _permSearchQuery = '';

function renderPermissions(granted) {
  const grid = $('permissions-grid');
  if (!grid) return;
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

  let visibleCount = 0;
  let selectedCount = 0;

  for (const [cat, perms] of groups) {
    const matched = query
      ? perms.filter((p) =>
          p.id.toLowerCase().includes(query) ||
          p.label.toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query))
      : perms;

    if (matched.length === 0) continue;

    const meta = PERMISSION_CATEGORIES[cat] || { label: cat, icon: '\u2022' };
    const section = document.createElement('div');
    section.className = 'perm-group';

    const header = document.createElement('div');
    header.className = 'perm-group-header';
    const headerIcon = document.createElement('span');
    headerIcon.className = 'perm-group-icon';
    headerIcon.textContent = meta.icon;
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
      const isSelected = granted.has(perm.id);
      if (isSelected) { groupSelected++; selectedCount++; }
      visibleCount++;

      const item = document.createElement('div');
      item.className = 'perm-item' + (isSelected ? ' selected' : '');
      item.dataset.id = perm.id;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

      const risk = document.createElement('span');
      risk.className = `perm-risk-badge risk-badge--${perm.risk}`;
      risk.textContent = perm.risk;

      const label = document.createElement('span');
      label.className = 'perm-item-label';
      label.textContent = perm.label;

      item.append(risk, label);

      if (PERMISSIONS_NEEDING_MANIFEST_FLAG.has(perm.id)) {
        const flagBadge = document.createElement('span');
        flagBadge.className = 'perm-flag-badge';
        flagBadge.title = 'Also requires a matching flag in manifest.json -- see the description on hover.';
        flagBadge.textContent = '+flag';
        item.appendChild(flagBadge);
      }

      const toggle = () => {
        item.classList.toggle('selected');
        item.setAttribute('aria-pressed', item.classList.contains('selected') ? 'true' : 'false');
        _updatePermissionsSummary();
        _onManifestFormChanged();
      };
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      list.appendChild(item);
    }

    headerCount.textContent = `${groupSelected}/${matched.length}`;
    section.appendChild(list);
    grid.appendChild(section);
  }

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'perm-empty-state';
    empty.textContent = `No permissions match "${_permSearchQuery.trim()}"`;
    grid.appendChild(empty);
  }

  _attachPermissionTooltips();
  _updatePermissionsSummary();
}

function _updatePermissionsSummary() {
  const summary = $('permissions-summary');
  if (!summary) return;
  const count = $('permissions-grid').querySelectorAll('.perm-item.selected').length;
  summary.textContent = `${count} selected`;
}

function _initPermissionsSearch() {
  const input = $('permissions-search');
  if (!input) return;
  input.addEventListener('input', () => {
    _permSearchQuery = input.value;
    // Re-render from the currently-selected set so filtering never loses
    // a selection that's just temporarily out of view.
    const granted = new Set(
      [...$('permissions-grid').querySelectorAll('.perm-item.selected')].map((el) => el.dataset.id)
    );
    renderPermissions(granted);
  });
}

function _attachPermissionTooltips() {
  const tooltip = $('perm-tooltip');
  const dot = $('perm-tooltip-dot');
  const idEl = $('perm-tooltip-id');
  const body = $('perm-tooltip-body');
  if (!tooltip || !dot || !idEl || !body) return;

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
      body.textContent = perm.description || '';
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
  const body = $('perm-tooltip-body');
  if (!tooltip || !dot || !idEl || !body) return;

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

  // Throttle mousemove to one tooltip update per animation frame so a
  // frantic pointer sweep across the editor doesn't hammer posAtCoords.
  let pending = null;
  let rafId = null;
  const flush = () => {
    rafId = null;
    if (!pending) return;
    const { clientX, clientY } = pending;
    pending = null;

    if (!window.CM || !window.CM.view) return;
    const view = window.CM.view;

    // CodeMirror's posAtCoords can throw internally (not just return null)
    // when called while the view is mid-layout, detached, or its container
    // is momentarily display:none -- e.g. right as a tab becomes visible.
    let pos;
    try {
      pos = view.posAtCoords({ left: clientX, top: clientY });
    } catch (err) {
      clear();
      return;
    }
    if (pos == null) { clear(); return; }

    const line = view.state.doc.lineAt(pos);
    const lineText = line.text;
    const offsetInLine = pos - line.from;

    let start = offsetInLine;
    let end = offsetInLine;
    while (start > 0 && /[\w:]/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /[\w:]/.test(lineText[end])) end++;
    const word = lineText.slice(start, end);

    const perm = _PERMISSION_MAP[word];
    if (!perm) { clear(); return; }

    dot.style.background = riskColors[perm.risk] || '#8b949e';
    idEl.textContent = perm.id;
    body.textContent = perm.description || '';
    tooltip.classList.remove('hidden');
    tooltip.classList.add('is-visible');
    _positionPermTooltip(clientX, clientY);
  };

  editorHost.addEventListener('mousemove', (e) => {
    pending = e;
    if (rafId == null) rafId = requestAnimationFrame(flush);
  });

  editorHost.addEventListener('mouseleave', () => {
    pending = null;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
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

  const selectedPerms = [...$('permissions-grid').querySelectorAll('.perm-item.selected')]
    .map((el) => el.dataset.id);

  const manifest = {
    id: $('mf-id').value.trim(),
    name: $('mf-name').value.trim(),
    version: $('mf-version').value.trim() || '1.0.0',
    entry: $('mf-entry').value.trim() || 'index.html',
    permissions: selectedPerms,
  };

  if ($('mf-description').value.trim()) manifest.description = $('mf-description').value.trim();
  if ($('mf-author').value.trim()) manifest.author = $('mf-author').value.trim();

  // Icon: prefer uploaded data URI, fall back to text field (Lucide name).
  const iconDataUri = $('mf-icon-img').dataset.uri || '';
  const iconText = $('mf-icon').value.trim();
  if (iconDataUri) manifest.icon = iconDataUri;
  else if (iconText) manifest.icon = iconText;

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

function saveManifest() {
  if (!state.projectDir) return;
  const windowError = _windowSettingsError();
  if (windowError) {
    alert(windowError);
    return;
  }
  const manifest = readManifestForm();

  if (!manifest.id || !manifest.name) {
    alert('App ID and Name are required.');
    return;
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
  } catch (err) {
    alert('Could not save manifest: ' + err.message);
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
  status.textContent = valid ? '\u2713' : '\u2715';
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

  $('mf-id')?.addEventListener('input', _validateAppIdField);

  _syncWindowPreview();
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
      `background:#fff;border:1.5px solid #22c55e;border-radius:50%;` +
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
  style.textContent = '.__nb_hover{outline:1.5px dashed #22c55e!important;outline-offset:1px;cursor:pointer;}' +
    '.__nb_selected{outline:2px solid #22c55e!important;outline-offset:1px;}' +
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
    const stageRect = stage.getBoundingClientRect();
    // Zoom around the cursor position, not the top-left corner, so the
    // point under the mouse stays put as scale changes.
    const cx = e.clientX - stageRect.left;
    const cy = e.clientY - stageRect.top;
    const delta = -e.deltaY * 0.001;
    zoomBy(1 + delta, cx, cy);
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

// Fallback emoji for extensions with no Devicon equivalent (images, audio, plain text).
const FILE_ICONS = {
  '.png': '\u{1F5BC}', '.jpg': '\u{1F5BC}', '.jpeg': '\u{1F5BC}', '.gif': '\u{1F5BC}', '.svg': '\u{1F5BC}', '.webp': '\u{1F5BC}',
  '.mp3': '\u{1F3B5}', '.wav': '\u{1F3B5}', '.ogg': '\u{1F3B5}',
  '.txt': '\u{1F4C4}',
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
// otherwise an emoji span from FILE_ICONS, otherwise the generic file emoji.
// `extraClass` lets callers add their own class (e.g. sizing) to the <i> tag.
function _fileIconHtml(ext, extraClass) {
  const dev = DEVICON_MAP[ext];
  if (dev) {
    return `<i class="devicon-${dev}-plain colored${extraClass ? ' ' + extraClass : ''}"></i>`;
  }
  const emoji = FILE_ICONS[ext] || '\u{1F4C4}';
  return `<span class="file-icon-emoji${extraClass ? ' ' + extraClass : ''}">${emoji}</span>`;
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

function populateFileTree(dir) {
  const tree = $('file-tree');
  if (!tree) return;
  tree.replaceChildren();
  _buildTreeItems(dir, tree, 0);
  _refreshGitStatus(dir);
}

// Git status (file tree indicators). Best-effort: if `git` isn't on PATH,
// or dir isn't a repo, this silently no-ops and the tree just renders with
// no status dots, same as today. Uses execFile (no shell) for every call so
// there's no injection surface even if a path contained shell metacharacters.
function _refreshGitStatus(dir) {
  if (!dir) return;

  execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir }, (err) => {
    if (err) {
      // Not a repo (or git isn't installed) -- clear any stale state from a
      // previously open project and leave the tree as-is.
      if (state.gitRoot) { state.gitRoot = null; state.gitStatus = null; state.gitNumstat = null; }
      return;
    }

    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir }, (err2, topLevel) => {
      if (err2) return;
      const root = topLevel.trim();

      execFile('git', ['status', '--porcelain=v1', '-uall'], { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (err3, out) => {
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

        // +/- line counts per file, best-effort -- used only for the small
        // stat badges in the Changes list. Failure here (e.g. binary files,
        // huge diffs) shouldn't block status from rendering, so it's kept
        // as a separate non-blocking pass.
        execFile('git', ['diff', '--numstat', 'HEAD'], { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (errN, outN) => {
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
  if (!state.gitStatus) return;
  document.querySelectorAll('#file-tree .file-item[data-path]').forEach((el) => {
    el.querySelector('.git-badge')?.remove();
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

function gitDeleteBranch(name) {
  if (!confirm(`Delete branch "${name}"? This cannot be undone if it isn't merged elsewhere.`)) return;
  _gitExecFile(['branch', '-d', name], (err) => {
    if (err) {
      // -d refuses on unmerged branches; offer the force path explicitly
      // rather than silently escalating to -D on the user's behalf.
      if (/not fully merged/i.test(err.message) &&
          confirm(`"${name}" has unmerged changes. Force delete anyway?`)) {
        _gitExecFile(['branch', '-D', name], (err2) => {
          if (err2) { _gitLog('error', `Delete failed: ${err2.message}`); return; }
          _gitLog('success', `Force-deleted ${name}`);
          refreshGitPanel();
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

function gitMergeBranch(name) {
  const current = _currentGitBranch();
  if (!confirm(`Merge "${name}" into "${current ? current.name : 'current branch'}"?`)) return;
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
    icon.textContent = '\u23F1';
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

function gitStashDrop(ref) {
  if (!confirm(`Drop stash ${ref}? This cannot be undone.`)) return;
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
    icon.textContent = '\u{1F4E6}';
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
    popBtn.textContent = '\u21E4';
    popBtn.addEventListener('click', () => gitStashPop(s.ref));

    const applyBtn = document.createElement('button');
    applyBtn.className = 'icon-btn';
    applyBtn.title = 'Apply (keep stash)';
    applyBtn.textContent = '\u21E5';
    applyBtn.addEventListener('click', () => gitStashApply(s.ref));

    const dropBtn = document.createElement('button');
    dropBtn.className = 'icon-btn git-file-action--danger';
    dropBtn.title = 'Drop';
    dropBtn.textContent = '\u2715';
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

function gitDiscardChange(absPath, code) {
  const name = path.basename(absPath);
  if (code === '??') {
    // Untracked file -- "discard" means delete it, since git has nothing to
    // restore it to. Confirm explicitly since this is unrecoverable.
    if (!confirm(`Delete untracked file "${name}"? This cannot be undone.`)) return;
    try { fs.unlinkSync(absPath); }
    catch (e) { _gitLog('error', `Delete failed: ${e.message}`); return; }
    _gitLog('success', `Deleted ${name}`);
    _refreshGitStatus(state.projectDir);
    refreshGitPanel();
    return;
  }
  if (!confirm(`Discard changes to "${name}"? This cannot be undone.`)) return;
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
    discardBtn.textContent = '\u21BA';
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
    icon.textContent = '\u2102';

    const name = document.createElement('span');
    name.className = 'git-branch-dropdown-item-name';
    name.textContent = b.name; // safe -- never inject as HTML

    item.append(icon, name);

    if (b.current) {
      const check = document.createElement('span');
      check.className = 'git-branch-dropdown-item-check';
      check.textContent = '\u2713';
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
    icon.textContent = '\u2102';

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
      switchBtn.textContent = '\u21C4';
      switchBtn.addEventListener('click', () => gitCheckoutBranch(b.name));

      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'icon-btn';
      mergeBtn.title = 'Merge into current branch';
      mergeBtn.textContent = '\u2103';
      mergeBtn.addEventListener('click', () => gitMergeBranch(b.name));

      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.title = 'Rename';
      renameBtn.textContent = '\u270F';
      renameBtn.addEventListener('click', () => {
        const next = prompt(`Rename "${b.name}" to:`, b.name);
        if (next && next.trim()) gitRenameBranch(b.name, next.trim());
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn git-file-action--danger';
      deleteBtn.title = 'Delete';
      deleteBtn.textContent = '\u{1F5D1}';
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
  const iconHtml = isDir ? '<span class="file-icon-emoji">\u{1F4C1}</span>' : _fileIconHtml(ext);
  const size = isDir ? '' : _formatSize(stat.size);
  const name = path.basename(full);

  const item = document.createElement('div');
  item.className = 'file-item' + (isDir ? ' file-item--dir' : '');
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
    item.querySelector('[data-icon]').innerHTML = '<span class="file-icon-emoji">\u{1F4C1}</span>';
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
    item.querySelector('[data-icon]').innerHTML = '<span class="file-icon-emoji">\u{1F4C2}</span>';
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
const BINARY_EXTS = new Set(['.novaapp', '.zip', '.tar', '.gz', '.exe', '.bin', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.ogg']);

// Tab system. VS Code style: preview=true tabs are reused on single-click,
// pinned on edit / dblclick.
const tabs = []; // [{ filePath, originalContent, isDirty, preview }]

let _contextTarget = null;
let activeTabIndex = -1;

function _getActiveTab() {
  return tabs[activeTabIndex] ?? null;
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
      `<button class="editor-tab-close" data-index="${i}" title="Close">\u2715</button>`;

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

function _closeTab(index) {
  const tab = tabs[index];
  if (!tab) return;
  if (tab.isDirty) {
    const ok = confirm(`Discard unsaved changes to "${path.basename(tab.filePath)}"?`);
    if (!ok) return;
  }
  tabs.splice(index, 1);

  if (!tabs.length) {
    if (window.CM) window.CM.destroy();
    activeTabIndex = -1;
    _renderTabs();
    _highlightActiveFile();
    _setLivePermStatus(null); // no file open -- nothing to scan
    return;
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
}

function _loadTabIntoEditor(tab) {
  if (!tab) return;
  const ext = path.extname(tab.filePath).toLowerCase();
  $('btn-editor-save').disabled = IMAGE_EXTS.has(ext);

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
  _onEditorContentChanged();
  _scheduleLivePermissionScan();
}

// ── Live undeclared-permission check ────────────────────────────────────
//
// Same idea as builder.js's listActions() + app.js's _renderPermissionAudit
// (declared-vs-detected via the nova:[a-z:]+ regex), but scoped to just the
// buffer currently open in the editor and run on a debounce as you type,
// instead of at build/inspect time across the whole packaged app. Reuses
// the *same* regex source so the two detectors can't silently drift apart.
const _LIVE_PERM_RE = /nova:[a-z:]+/g;
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

  const detected = new Set(matches);
  const declared = new Set(readManifestForm().permissions || []);
  const undeclared = [...detected.difference(declared)];

  if (undeclared.length === 0) {
    _setLivePermStatus('ok', `\u2713 permissions ok`);
  } else {
    _setLivePermStatus('missing', `\u26A0 ${undeclared.length} undeclared: ${undeclared.slice(0, 3).join(', ')}${undeclared.length > 3 ? '\u2026' : ''}`);
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
  el.textContent = text;
  el.className = `status-bar-item status-bar-item--clickable status-bar-item--${type}`;
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
      const size = Buffer.byteLength(window.CM.getValue(), 'utf8');
      $('sb-size').textContent = _formatSize(size);
    } catch {
      $('sb-size').textContent = '';
    }

    if (window.CM.view) {
      const pos = window.CM.view.state.selection.main.head;
      const line = window.CM.view.state.doc.lineAt(pos);
      const col = pos - line.from + 1;
      $('sb-pos').textContent = `Ln ${line.number}, Col ${col}`;
    }
  }

  _setSyntaxStatus(null, null);
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
function editorCloseGuard() {
  const toDiscard = tabs.filter((t) => t.preview);
  const dirty = toDiscard.filter((t) => t.isDirty);
  if (dirty.length) {
    const names = dirty.map((t) => path.basename(t.filePath)).join(', ');
    const ok = confirm(`Discard unsaved changes to: ${names}?`);
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
  $('btn-toggle-preview').textContent = '\u2B1B';
  $('btn-toggle-preview').title = 'Hide Preview';
  _refreshPreviewIfVisible();
}

function _hidePreview() {
  _previewVisible = false;
  $('preview-pane').classList.add('hidden');
  $('editor-body').classList.remove('editor-body--split');
  const btn = $('btn-toggle-preview');
  if (btn) { btn.textContent = '\u2B1C'; btn.title = 'Show Preview'; }
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
  });

  $('btn-font-inc')?.addEventListener('click', () => {
    const cur = parseInt($('lbl-font-size').textContent, 10);
    const next = Math.min(24, cur + 1);
    $('lbl-font-size').textContent = next;
    window.CM?.applySettings({ fontSize: next });
  });

  $('sel-tab-size')?.addEventListener('change', (e) => {
    window.CM?.applySettings({ tabSize: parseInt(e.target.value, 10) });
  });

  $('chk-word-wrap')?.addEventListener('change', (e) => {
    window.CM?.applySettings({ wordWrap: e.target.checked });
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
      check.textContent = '\u2713';
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

function promptNewFile(inDir) {
  const dir = inDir ?? state.projectDir;
  if (!dir) return;
  const name = prompt('New file name:', 'untitled.js');
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

function promptNewFolder(inDir) {
  const dir = inDir ?? state.projectDir;
  if (!dir) return;
  const name = prompt('New folder name:', 'new-folder');
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

function renameItem(targetPath) {
  if (!targetPath) return;
  const oldName = path.basename(targetPath);
  const newName = prompt('Rename to:', oldName)?.trim();
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

function deleteItem(targetPath) {
  if (!targetPath) return;
  const name = path.basename(targetPath);
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) fs.rmSync(targetPath, { recursive: true, force: true });
    else fs.unlinkSync(targetPath);
    const deletedIdx = tabs.findIndex((t) => t.filePath === targetPath);
    if (deletedIdx !== -1) {
      tabs[deletedIdx].isDirty = false;  // suppress dirty confirm
      _closeTab(deletedIdx);
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
  el.textContent = text;
  el.className = `status-bar-item status-bar-item--clickable status-bar-item--${type}`;
}

function checkSyntax() {
  const tab = _getActiveTab();
  if (!tab) { showToast('No file open to check'); return; }

  const ext = path.extname(tab.filePath).toLowerCase();
  const loader = _SYNTAX_LOADER_MAP[ext];
  if (!loader) {
    showToast(`Syntax check not supported for ${ext || 'this file type'}`);
    return;
  }

  const content = window.CM ? window.CM.getValue() : tab.originalContent;
  const fileName = path.basename(tab.filePath);

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    _setSyntaxStatus('error', 'esbuild unavailable');
    appendLog('error', `esbuild not available: ${e.message}`);
    return;
  }

  try {
    esbuild.transformSync(content, { loader, sourcefile: fileName, logLevel: 'silent' });
    _setSyntaxStatus('ok', '\u2713 No errors');
    appendLog('success', `${fileName} -- no syntax errors`);
  } catch (e) {
    const errors = e.errors && e.errors.length ? e.errors : [{ text: e.message }];
    const first = errors[0];
    const loc = first.location ? `${first.location.line}:${first.location.column}` : '?';
    const label = errors.length > 1
      ? `\u2717 ${errors.length} errors -- Ln ${loc}`
      : `\u2717 Ln ${loc}: ${first.text}`;
    _setSyntaxStatus('error', label);

    for (const err of errors) {
      const eLoc = err.location ? `${err.location.line}:${err.location.column}` : '?';
      appendLog('error', `${fileName}:${eLoc} -- ${err.text}`);
    }
    if (e.warnings && e.warnings.length) {
      for (const w of e.warnings) {
        const wLoc = w.location ? `${w.location.line}:${w.location.column}` : '?';
        appendLog('warn', `${fileName}:${wLoc} -- ${w.text}`);
      }
    }
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
  if (state.building || !state.projectDir) return;
  state.building = true;

  const btn = $('btn-build');
  const fill = $('build-btn-fill');
  const label = btn.querySelector('.build-btn-label');

  saveManifest();
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

  const outDir = $('build-outdir').value.trim() || path.join(state.projectDir, 'dist');

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
    fill.style.width = '100%';
    btn.className = 'build-btn success';
    label.textContent = '\u2713 Build Complete';
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
  } else {
    fill.style.width = '0%';
    btn.className = 'build-btn error';
    label.textContent = '\u2717 Build Failed';
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
    const icon = e.success ? '\u2713' : '\u2717';
    const cls = e.success ? 'build-history-item--ok' : 'build-history-item--fail';

    const item = document.createElement('div');
    item.className = `build-history-item ${cls}`;
    item.dataset.index = i;
    item.title = e.outFile || '';

    // Build the inner DOM with textContent to avoid any chance of injecting
    // build-name / version strings as HTML.
    const iconEl = document.createElement('span');
    iconEl.className = 'bh-icon';
    iconEl.textContent = icon;

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
    rerun.textContent = '\u25B6';
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

  const outDir = ($('build-outdir')?.value || '').trim() || (state.projectDir ? path.join(state.projectDir, 'dist') : './dist');
  outpathEl.textContent = outDir;

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

function _loadWorkspaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _saveWorkspaces(ws) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(ws));
  } catch { /* best-effort */ }
}

function openWorkspaces() {
  _renderWorkspaceList();
  $('modal-workspace')?.classList.remove('hidden');
}

function closeWorkspaces() {
  $('modal-workspace')?.classList.add('hidden');
}

function _saveCurrentWorkspace() {
  if (!state.projectDir) { showToast('No project open', 'warn'); return; }
  const name = prompt('Workspace name:', state.projectName || 'My Workspace');
  if (!name) return;
  const ws = _loadWorkspaces();
  ws.unshift({
    id: Date.now(),
    name: name.trim(),
    projectDir: state.projectDir,
    activeTab: state.activeTab,
    openFiles: tabs.map((t) => t.filePath),
    ts: Date.now(),
  });
  if (ws.length > 20) ws.length = 20;
  _saveWorkspaces(ws);
  _renderWorkspaceList();
  showToast('Workspace saved', 'success');
}

function _renderWorkspaceList() {
  const list = $('workspace-list');
  if (!list) return;
  const ws = _loadWorkspaces();
  list.replaceChildren();

  if (!ws.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = 'No saved workspaces';
    list.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  ws.forEach((w, i) => {
    const item = document.createElement('div');
    item.className = 'workspace-item';
    item.dataset.index = i;

    const info = document.createElement('div');
    info.className = 'ws-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'ws-name';
    nameEl.textContent = w.name;

    const metaEl = document.createElement('span');
    metaEl.className = 'ws-meta';
    metaEl.textContent = `${w.projectDir} \u00b7 ${_timeAgo(w.ts)}`;

    const filesEl = document.createElement('span');
    filesEl.className = 'ws-files';
    const files = (w.openFiles || []).map((f) => path.basename(f)).join(', ');
    filesEl.textContent = files || 'No open files';

    info.append(nameEl, metaEl, filesEl);

    const actions = document.createElement('div');
    actions.className = 'ws-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'action-btn action-btn--ghost ws-load';
    loadBtn.dataset.index = i;
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => _loadWorkspace(ws[+loadBtn.dataset.index]));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn ws-delete';
    deleteBtn.dataset.index = i;
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '\u2715';
    deleteBtn.addEventListener('click', () => {
      const idx = +deleteBtn.dataset.index;
      if (Number.isNaN(idx)) return;
      ws.splice(idx, 1);
      _saveWorkspaces(ws);
      _renderWorkspaceList();
    });

    actions.append(loadBtn, deleteBtn);
    item.append(info, actions);
    frag.appendChild(item);
  });
  list.appendChild(frag);
}

function _loadWorkspace(ws) {
  if (!ws?.projectDir) return;
  closeWorkspaces();
  // Load the project (handles manifest, file tree, tab reset).
  loadProject(ws.projectDir);
  // Restore open files. loadProject() is synchronous, so we don't need the
  // setTimeout-race hack the original used -- just open the files inline.
  if (ws.openFiles?.length) {
    for (const fp of ws.openFiles) {
      try { if (fs.existsSync(fp)) openFileEditor(fp); } catch { /* vanished */ }
    }
  }
  if (ws.activeTab) switchTab(ws.activeTab);
  showToast(`Loaded workspace: ${ws.name}`, 'success');
}

// Command palette

// Static command registry. Each entry: { id, label, description, category, action, when? }
// `when` is an optional fn() => bool -- command is hidden if it returns false.
function _buildCommandRegistry() {
  const hasProject = () => !!state.projectDir;
  const editorOpen = () => tabs.length > 0;

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
    { id: 'show-inspector', label: 'Open Package Inspector', category: 'Navigate', action: showInspector },

    // Editor
    { id: 'toggle-preview', label: 'Toggle Preview', category: 'Editor', action: _togglePreview, when: editorOpen },
    { id: 'refresh-preview', label: 'Refresh Preview', category: 'Editor', action: _refreshPreviewIfVisible, when: editorOpen },
    {
      id: 'diff-vs-saved', label: 'Diff File vs Saved', category: 'Editor', action: openDiffVsSaved, when: editorOpen,
      shortcut: `${MOD_KEY}+Shift+D`
    },
    {
      id: 'save-all', label: 'Save All Files', category: 'Editor', action: saveAllOpenFiles, when: editorOpen,
      shortcut: `${MOD_KEY}+Alt+S`
    },

    // Build
    {
      id: 'build', label: 'Build Package', category: 'Build', action: () => { switchTab('build'); runBuild(); }, when: hasProject,
      shortcut: `${MOD_KEY}+B`
    },
    { id: 'run-novabyte', label: 'Run NovaByte', category: 'Build', action: runNovaByte, when: hasProject },
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
  ];
}

let _cpRegistry = null;   // built lazily so all fns are defined
let _cpActiveIdx = -1;
let _cpFiltered = [];

// Help modal
function openHelp(section) {
  const overlay = $('modal-help');
  overlay?.classList.remove('hidden');
  if (section) _showHelpSection(section);

  // Reflect the real platform modifier key (\u2318 on macOS, Ctrl elsewhere)
  // instead of hardcoding "Ctrl" in the markup.
  ['help-kbd-palette', 'help-kbd-quickopen', 'help-kbd-save'].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = el.textContent.replace(/^Ctrl/, MOD_KEY);
  });
  const modKeyLabel = $('help-mod-key');
  if (modKeyLabel) modKeyLabel.textContent = MOD_KEY;
}

function closeHelp() {
  $('modal-help')?.classList.add('hidden');
}

function _showHelpSection(section) {
  document.querySelectorAll('.help-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.helpSection === section);
  });
  document.querySelectorAll('.help-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.helpPane === section);
  });
}

function initHelp() {
  $('btn-help')?.addEventListener('click', () => openHelp());
  document.querySelectorAll('.help-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => _showHelpSection(btn.dataset.helpSection));
  });
}

function openCommandPalette() {
  if (!_cpRegistry) _cpRegistry = _buildCommandRegistry();

  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const overlay = $('modal-command-palette');
  const input = $('cp-input');
  overlay?.classList.remove('hidden');
  input.value = '';
  _runCpFilter('');
  input.focus();
}

function closeCommandPalette() {
  $('modal-command-palette')?.classList.add('hidden');
}

function _runCpFilter(query) {
  const q = query.trim().toLowerCase();
  _cpFiltered = _cpRegistry
    .filter((cmd) => !cmd.when || cmd.when())
    .filter((cmd) => !q || _cpMatch(cmd.label.toLowerCase(), cmd.category.toLowerCase(), q))
    .sort((a, b) => {
      if (!q) return 0; // preserve registry order when no query
      return _cpScore(b.label.toLowerCase(), q) - _cpScore(a.label.toLowerCase(), q);
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

  if (!_cpFiltered.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = 'No matching commands';
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
    item.className = 'cp-item' + (i === _cpActiveIdx ? ' qo-item--active' : '');
    item.dataset.index = i;

    // _swatch comes from the THEMES constant -- safe to inject via style.
    if (cmd._swatch) {
      const sw = document.createElement('span');
      sw.className = 'cp-swatch';
      sw.style.background = cmd._swatch;
      item.appendChild(sw);
    } else {
      const icon = document.createElement('span');
      icon.className = 'cp-icon';
      icon.textContent = '\u2325';
      item.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'cp-label';
    label.textContent = cmd.label;
    item.appendChild(label);

    if (cmd.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'cp-shortcut';
      sc.textContent = cmd.shortcut;
      item.appendChild(sc);
    }

    item.addEventListener('mouseenter', () => {
      _cpActiveIdx = +item.dataset.index;
      _cpHighlight();
    });
    item.addEventListener('click', () => _cpExecute(+item.dataset.index));
    frag.appendChild(item);
  });
  el.appendChild(frag);
}

function _cpHighlight() {
  const items = $('cp-results')?.querySelectorAll('.cp-item') || [];
  items.forEach((el, i) => {
    el.classList.toggle('qo-item--active', i === _cpActiveIdx);
    if (i === _cpActiveIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function _cpExecute(idx) {
  const cmd = _cpFiltered[idx];
  if (!cmd) return;
  closeCommandPalette();
  // Small delay so the modal is gone before the action runs (avoids focus fights)
  setTimeout(() => cmd.action(), 30);
}

function _initCommandPalette() {
  const input = $('cp-input');
  if (!input) return;

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
      _cpExecute(_cpActiveIdx);
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  $('modal-command-palette')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-command-palette') closeCommandPalette();
  });
}

// Quick-open file switcher
let _qoFiles = [];
let _qoActiveIdx = -1;

function openQuickOpen() {
  if (!state.projectDir) return;
  _qoFiles = _collectSearchableFiles(state.projectDir)
    .map((f) => ({ full: f, rel: path.relative(state.projectDir, f) }));

  // Blur whatever currently has focus (almost always the CodeMirror editor)
  // before showing the modal, so keystrokes can't land in the document
  // while the input below is taking focus.
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const overlay = $('modal-quick-open');
  const input = $('qo-input');
  overlay?.classList.remove('hidden');
  input.value = '';
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

  const scored = _qoFiles
    .map((f) => ({ ...f, score: _qoScore(f.rel.toLowerCase(), q) }))
    .filter((f) => !q || f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  _qoActiveIdx = scored.length ? 0 : -1;
  el.replaceChildren();

  if (!scored.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = 'No files found';
    el.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  scored.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'qo-item' + (i === 0 ? ' qo-item--active' : '');
    item.dataset.index = i;
    item.dataset.path = f.full;

    const name = document.createElement('span');
    name.className = 'qo-name';
    name.textContent = path.basename(f.rel);

    const relDir = path.dirname(f.rel);
    const p = document.createElement('span');
    p.className = 'qo-path';
    p.textContent = relDir === '.' ? '' : relDir;

    item.append(name, p);
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
  $('project-breadcrumb').textContent = 'Inspector';
}

// Build an audit row for a single permission. `cls` is the CSS modifier
// (ok | missing | unused), `icon` is the symbol, `label` is the audit-status
// description ("declared & used" etc, NOT the permission's own doc text).
//
// If `perm` matches a known entry in PERMISSIONS, we also append that
// catalogue's `description` field (the same text shown in the editor hover
// tooltips) as a second, dimmer line -- so "why is this flagged" is
// answerable right here instead of only via a separate tooltip lookup.
// Unknown permission strings (typos, or something from a future/foreign
// catalogue) just get the status line, same as before.
function _auditRow(cls, icon, perm, label) {
  const row = document.createElement('div');
  row.className = `audit-row audit-row--${cls}`;

  const iconEl = document.createElement('span');
  iconEl.className = 'audit-icon';
  iconEl.textContent = icon;

  const permEl = document.createElement('span');
  permEl.className = 'audit-perm';
  permEl.textContent = perm; // permission string from the .novaapp -- could be hostile

  const textCol = document.createElement('span');
  textCol.className = 'audit-text-col';

  const lbl = document.createElement('span');
  lbl.className = 'audit-label';
  lbl.textContent = label;
  textCol.appendChild(lbl);

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

function _renderPermissionAudit(declared, detected) {
  // Use the native Set methods (ES2025) -- intersection preserves
  // declared's iteration order, difference preserves the receiver's order,
  // matching the original filter-based behaviour.
  const ok = [...declared.intersection(detected)];
  const missing = [...detected.difference(declared)];   // used but not declared
  const unused = [...declared.difference(detected)];    // declared but not used

  const rows = [
    ...missing.map((p) => _auditRow('missing', '\u2717', p, 'used in code -- not declared')),
    ...ok.map((p) => _auditRow('ok', '\u2713', p, 'declared & used')),
    ...unused.map((p) => _auditRow('unused', '\u25B3', p, 'declared -- not detected in code')),
  ];

  const card = document.createElement('div');
  card.className = 'inspector-card inspector-card--wide';

  const title = document.createElement('div');
  title.className = 'inspector-card-title';
  title.textContent = 'Permission Audit';
  card.appendChild(title);

  if (rows.length) {
    const summary = document.createElement('span');
    if (missing.length) {
      summary.className = 'audit-summary audit-summary--error';
      summary.textContent = `${missing.length} undeclared permission${missing.length > 1 ? 's' : ''} -- app may be blocked at runtime`;
    } else if (unused.length) {
      summary.className = 'audit-summary audit-summary--warn';
      summary.textContent = `${unused.length} over-declared permission${unused.length > 1 ? 's' : ''} -- consider trimming`;
    } else if (ok.length || detected.size === 0) {
      summary.className = 'audit-summary audit-summary--ok';
      summary.textContent = 'All permissions accounted for';
    }
    card.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'audit-list';
    for (const row of rows) list.appendChild(row);
    card.appendChild(list);
  } else {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:var(--text-faint);padding:6px 0';
    note.textContent = 'No permissions declared or detected';
    card.appendChild(note);
  }
  return card;
}

function inspectFile(filePath) {
  let info, vResult, actions;
  try {
    info = inspect(filePath);
    vResult = verify(filePath);
    actions = listActions(filePath);
  } catch (e) {
    $('inspector-dropzone').classList.remove('hidden');
    $('inspector-result').classList.add('hidden');
    alert('Failed to inspect file: ' + e.message);
    return;
  }

  const dropzone = $('inspector-dropzone');
  const result = $('inspector-result');
  dropzone.classList.add('hidden');
  result.classList.remove('hidden');
  result.replaceChildren();

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
  headerText.append(nameEl, idEl);

  const badges = document.createElement('div');
  badges.className = 'inspector-badges';
  const sigBadge = document.createElement('span');
  sigBadge.className = vResult.valid ? 'badge badge--green' : 'badge badge--red';
  sigBadge.textContent = vResult.valid ? '\u2713 Valid' : '\u2717 Invalid sig';
  badges.appendChild(sigBadge);
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

  // Permission audit card -- .novaapp files are untrusted, so we treat
  // manifest.permissions and the detected action list as hostile input.
  const declared = new Set(info.manifest?.permissions || []);
  // nova:vfs:read -> vfs:read; nova:ready / nova:ready:response are system calls, not permissions
  const SYSTEM_ACTIONS = new Set(['nova:ready', 'nova:ready:response']);
  const detected = new Set(
    actions
      .filter((a) => !SYSTEM_ACTIONS.has(a))
      .map((a) => a.replace(/^nova:/, ''))
  );
  grid.appendChild(_renderPermissionAudit(declared, detected));

  // Files card
  const filesCard = document.createElement('div');
  filesCard.className = 'inspector-card';
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
  footer.style.marginTop = '8px';
  const another = document.createElement('button');
  another.className = 'action-btn action-btn--ghost';
  another.id = 'btn-inspect-another';
  another.textContent = 'Inspect another';
  another.addEventListener('click', showInspector);
  footer.appendChild(another);
  result.appendChild(footer);
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
  nameEl.textContent = (r.pinned ? '\u{1F4CC} ' : '') + r.name;

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
  _recentContextTarget = dir;
  const entry = state.recentProjects.find((r) => r.dir === dir);
  const menu = $('recent-context-menu');

  $('rctx-pin').textContent = entry?.pinned ? '\u{1F4CC} Unpin' : '\u{1F4CC} Pin to top';

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
function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('tab--active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel:not(.tab-panel--editor)').forEach((p) => p.classList.add('hidden'));
  if (name !== 'editor') {
    document.getElementById('panel-' + name)?.classList.remove('hidden');
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
  }
  const previewWidth = parseInt(win.dataset.userWidth, 10) || width;
  const previewHeight = parseInt(win.dataset.userHeight, 10) || height;
  const bounds = stage.getBoundingClientRect();
  const scale = Math.min(1, (bounds.width - 40) / previewWidth, (bounds.height - 40) / previewHeight);
  win.style.width = `${previewWidth}px`;
  win.style.height = `${previewHeight}px`;
  win.style.transform = `scale(${scale})`;
  if (win.dataset.positionInitialized !== '1') {
    win.style.left = `${Math.max(0, (bounds.width - previewWidth * scale) / 2)}px`;
    win.style.top = `${Math.max(0, (bounds.height - previewHeight * scale) / 2)}px`;
    win.dataset.positionInitialized = '1';
  }

  win.classList.toggle('review-window--frameless', $('mf-frame')?.checked === false);
  win.classList.toggle('review-window--transparent', !!$('mf-transparent')?.checked);
  win.classList.toggle('review-window--no-resize', $('mf-resizable')?.checked === false);
  setupReviewWindowInteractions();

  if (!state.projectDir) {
    frame.srcdoc = '<body style="margin:0;padding:24px;font:13px system-ui;color:#8b949e;background:#0d1117;">No project open</body>';
    return;
  }

  try {
    const html = fs.readFileSync(path.join(state.projectDir, 'index.html'), 'utf8');
    const base = `<base href="${pathToFileURL(state.projectDir + path.sep).href}">`;
    frame.srcdoc = html.replace(/<head[^>]*>/i, (head) => `${head}${base}`);
  } catch (error) {
    frame.srcdoc = `<body style="margin:0;padding:24px;font:13px system-ui;color:#8b949e;background:#0d1117;">Could not load project preview: ${_escHtml(error.message)}</body>`;
  }
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

function openNewProjectModal() {
  // Populate template grid
  const grid = $('template-grid');
  grid.replaceChildren();
  for (const [key, tpl] of Object.entries(TEMPLATES)) {
    const card = document.createElement('div');
    card.className = 'template-card' + (state.selectedTemplate === key ? ' selected' : '');
    card.dataset.key = key;

    const icon = document.createElement('div');
    icon.className = 'template-card-icon';
    // icon is usually an emoji from our own TEMPLATES table, but some
    // templates (e.g. native-cpp) use a data: URI for a real logo instead --
    // textContent alone would just print the URI string, so render an <img>
    // for those and fall back to plain text for emoji.
    if (typeof tpl.icon === 'string' && tpl.icon.startsWith('data:image')) {
      const img = document.createElement('img');
      img.src = tpl.icon;
      img.alt = '';
      icon.replaceChildren(img);
    } else {
      icon.textContent = tpl.icon;
    }

    const name = document.createElement('div');
    name.className = 'template-card-name';
    name.textContent = tpl.name;

    const desc = document.createElement('div');
    desc.className = 'template-card-desc';
    desc.textContent = tpl.description;

    card.append(icon, name, desc);
    card.addEventListener('click', () => {
      grid.querySelectorAll('.template-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      state.selectedTemplate = key;
      _npSelectedFile = null; // reset file selection -- new template, new file list
      _npPlaceholderValues = {}; // reset to that template's defaults, not the old template's leftovers
      _renderNewProjectPreview();
    });
    grid.appendChild(card);
  }

  $('new-app-name').value = '';
  $('new-app-id').value = '';
  $('new-app-dir').value = '';
  _npPlaceholderValues = {};
  _npSelectedFile = null;

  $('modal-new-project').classList.remove('hidden');
  _renderNewProjectPreview();
  setTimeout(() => $('new-app-name').focus(), 50);
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

// Re-renders the right-hand preview pane: header (icon/name/description),
// file list, placeholder fields under the form, and the currently
// selected file's generated content. Called on template change, form
// input, and placeholder-field input -- cheap enough (string templates,
// no disk I/O) to just re-run in full each time rather than diffing.
function _renderNewProjectPreview() {
  const tpl = TEMPLATES[state.selectedTemplate];
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
  $('np-preview-desc').textContent = tpl.description;

  // Placeholder fields (e.g. Web App Wrapper's URL) -- rendered as normal
  // labeled inputs in the left form, not just inline in the preview, so
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
    const manifestObj = {
      id: m.id || 'com.example.myapp',
      name: m.name || 'My App',
      version: m.version || '1.0.0',
      description: m.description || '',
      author: m.author || '',
      entry: 'index.html',
      icon: 'box',
      permissions: [],
    };
    if (state.selectedTemplate === 'webapp') {
      manifestObj.url = m.url || 'https://example.com';
      manifestObj.permissions = ['sandbox:nested-webview'];
      manifestObj.allowNestedWebview = true;
    }
    if (state.selectedTemplate === 'browser') {
      manifestObj.permissions = ['net:external', 'sandbox:nested-webview'];
      manifestObj.allowNestedWebview = true;
    }
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

  const tpl = TEMPLATES[state.selectedTemplate];
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

function createProject() {
  const name = $('new-app-name').value.trim();
  const id = $('new-app-id').value.trim();
  const dir = $('new-app-dir').value.trim();

  if (!name || !id || !dir) {
    alert('Please fill in all fields.');
    return;
  }

  let result;
  try {
    result = create({
      targetDir: dir,
      template: state.selectedTemplate,
      // Spread collected placeholder values (e.g. url for Web App
      // Wrapper) into the manifest passed to create() -- previously this
      // was always {id, name, version}, so webapp projects silently got
      // manifest.url hardcoded to 'https://example.com' regardless of
      // what the New Project form showed, because nothing collected it.
      manifest: { id, name, version: '1.0.0', ..._npPlaceholderValues },
    });
  } catch (err) {
    alert('Could not create project: ' + err.message);
    return;
  }

  if (!result.success) {
    alert('Could not create project: ' + result.error);
    return;
  }

  closeModal('modal-new-project');
  loadProject(dir);
}

// Virtual runner. Spawns a second NW.js window pointing at the bundled
// NBOSP runtime. Both the install path and the run path use detached: true +
// unref() so the spawned process survives this Studio window closing.
function runNovaByte() {
  // Deprecated: runtime/nbosp is no longer bundled with Studio. Clone NBOSP
  // yourself instead of relying on this button to launch a bundled copy.
  showToast(
    'Run NovaByte is deprecated \u2014 clone NBOSP yourself: github.com/NovaByteTeam/novabyte-os',
    'info',
    8000
  );
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

function pickFolder(callback) {
  if (process.platform === 'win32') {
    _pickFolderWindows(callback);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.setAttribute('nwdirectory', '');
  _openNativePicker(input, callback, 'folder');
}

function pickFile(accept, callback) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  _openNativePicker(input, callback, 'file');
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
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.novaapp')) {
      inspectFile(file.path);
    } else {
      alert('Please drop a .novaapp file.');
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

  rail.style.width = `${state.railWidth || 220}px`;

  // Minimum width the toolbar itself needs (path label can shrink to ~0,
  // but the button row can't shrink below its own content).
  const toolbarMinWidth = () => {
    if (!actions) return MIN_WIDTH;
    // header horizontal padding (12px each side) + button row width
    return actions.scrollWidth + 24;
  };

  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const onMouseMove = (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
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
  rail.classList.add('hidden');
  handle.classList.add('hidden');
  tab?.classList.remove('hidden');
  if (!skipSave) {
    state.railCollapsed = true;
    saveStorage();
  }
}

function expandRail() {
  const rail = $('project-rail');
  const handle = $('rail-resize-handle');
  const tab = $('btn-reopen-rail');
  if (!rail || !handle) return;
  rail.classList.remove('hidden');
  handle.classList.remove('hidden');
  tab?.classList.add('hidden');
  state.railCollapsed = false;
  saveStorage();
}

function initSidebarCollapse() {
  const sidebar = $('sidebar');
  const tab = $('btn-reopen-sidebar');
  if (!sidebar) return;

  const collapse = () => {
    sidebar.classList.add('hidden');
    tab?.classList.remove('hidden');
    state.sidebarCollapsed = true;
    saveStorage();
  };

  const expand = () => {
    sidebar.classList.remove('hidden');
    tab?.classList.add('hidden');
    state.sidebarCollapsed = false;
    saveStorage();
  };

  $('btn-collapse-sidebar')?.addEventListener('click', collapse);
  $('btn-reopen-sidebar')?.addEventListener('click', expand);

  if (state.sidebarCollapsed) {
    sidebar.classList.add('hidden');
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

let _searchDebounce = null;
let _searchResults = [];   // [{ filePath, relPath, line, col, lineText }]
let _searchActiveIdx = -1;

// Wires up listeners on the static #modal-global-search markup. Called once
// from init(), same pattern as the rest of the modal wiring below.
function _initGlobalSearch() {
  const input = $('gs-input');
  if (!input) return; // markup not present -- fail quiet, same as other $()? calls

  input.addEventListener('input', () => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => _runGlobalSearch(input.value), 150);
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
  $('gs-results').replaceChildren();
  $('gs-meta').textContent = 'Type to search across all project files';
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

function _runGlobalSearch(query) {
  const resultsEl = $('gs-results');
  const metaEl = $('gs-meta');
  query = query.trim();

  if (!query) {
    resultsEl.replaceChildren();
    metaEl.textContent = 'Type to search across all project files';
    _searchResults = [];
    _searchActiveIdx = -1;
    return;
  }

  const needle = query.toLowerCase();
  const files = _collectSearchableFiles(state.projectDir);
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
      const idx = lines[i].toLowerCase().indexOf(needle);
      if (idx !== -1) {
        results.push({
          filePath,
          relPath: path.relative(state.projectDir, filePath),
          line: i + 1,
          col: idx + 1,
          lineText: lines[i],
        });
        if (results.length >= SEARCH_MAX_RESULTS) break searchLoop;
      }
    }
  }

  _searchResults = results;
  _searchActiveIdx = results.length ? 0 : -1;

  const capped = results.length >= SEARCH_MAX_RESULTS
    ? ` (showing first ${SEARCH_MAX_RESULTS})` : '';
  metaEl.textContent = results.length
    ? `${results.length} match${results.length === 1 ? '' : 'es'}${capped} in ${files.length} file(s) searched`
    : `No matches in ${files.length} file(s) searched`;

  _renderSearchResults(query);
}

function _renderSearchResults(query) {
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

  const needleLower = query.toLowerCase();
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
      const lowerText = text.toLowerCase();
      const matchAt = lowerText.indexOf(needleLower);

      const lineNum = document.createElement('span');
      lineNum.className = 'gs-line-num';
      lineNum.textContent = r.line;

      const lineText = document.createElement('span');
      lineText.className = 'gs-line-text';

      if (matchAt !== -1) {
        // Highlight the match by stitching together text nodes + a <mark>.
        // Building the line from DOM nodes (instead of innerHTML) means
        // arbitrary line content can never break out into HTML.
        const before = document.createTextNode(text.slice(0, matchAt));
        const mark = document.createElement('mark');
        mark.className = 'gs-highlight';
        mark.textContent = text.slice(matchAt, matchAt + query.length);
        const after = document.createTextNode(text.slice(matchAt + query.length));
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
  if (q) _renderSearchResults(q);
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
    if (meta && e.key === 'r') { e.preventDefault(); runNovaByte(); }
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

async function checkForUpdates(silent = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (!silent) showToast('Could not check for updates');
    return;
  }
  clearTimeout(timeout);

  if (!res.ok) return;
  let release;
  try {
    release = await res.json();
  } catch {
    return;
  }
  const latest = (release.tag_name || '').replace(/^v/i, '');
  if (!latest) return;

  if (_semverGt(latest, STUDIO_VERSION)) {
    const badge = $('btn-update-badge');
    if (badge) {
      badge.classList.remove('hidden');
      badge.onclick = () => openUpdateModal(release, latest);
    }
  } else if (!silent) {
    showToast('NovaByte Studio is up to date');
  }
}

function openUpdateModal(release, latest) {
  $('update-new-version').textContent = `Version ${latest} available`;
  $('update-current-version').textContent = `You have version ${STUDIO_VERSION}`;

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
  const rawHtml = (typeof marked !== 'undefined')
    ? marked.parse(body)
    : `<p>${_escHtml(body)}</p>`; // fallback if marked failed to load
  const cleanHtml = (typeof DOMPurify !== 'undefined')
    ? DOMPurify.sanitize(rawHtml)
    : _escHtml(body); // if DOMPurify is missing, never inject unsanitized HTML -- show escaped text instead
  $('update-changelog').innerHTML = cleanHtml;

  $('btn-download-update').onclick = () => {
    nw.Shell.openExternal(release.html_url);
  };

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
  _safeInit('initWindowControls', initWindowControls);
  _safeInit('initWindowDesigner', initWindowDesigner);
  _safeInit('initDesignTab', initDesignTab);
  _safeInit('NBPro.init', () => window.NBPro && window.NBPro.init());
  _safeInit('_initPermissionsSearch', _initPermissionsSearch);
  _safeInit('initHelp', initHelp);
  _safeInit('_initCloseGuard', _initCloseGuard);
  _safeInit('initInspectorDrop', initInspectorDrop);
  _safeInit('renderRecent', renderRecent);
  _safeInit('_initThemePicker', _initThemePicker);
  _safeInit('initRailResize', initRailResize);
  _safeInit('initSidebarCollapse', initSidebarCollapse);
  _safeInit('_initManifestAutosave', _initManifestAutosave);
  _safeInit('_applyAutosaveSettings', _applyAutosaveSettings);

  // Update shortcut badges to show Ctrl vs \u2318 based on platform
  _safeInit('shortcut labels', () => {
    const _sc = (id, lbl) => { const el = document.getElementById(id); if (el) el.textContent = lbl; };
    _sc('sc-new', `${MOD_KEY}+N`);
    _sc('sc-open', `${MOD_KEY}+O`);
    _sc('sc-build', `${MOD_KEY}+B`);
    _sc('sc-run', `${MOD_KEY}+R`);
    _sc('sc-quick-open', `${MOD_KEY}+P`);
    _sc('sc-qo-icon', IS_MAC ? '\u2318' : '');
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
    $('btn-new-project')?.addEventListener('click', openNewProjectModal);
    $('btn-open-project')?.addEventListener('click', () => pickFolder(loadProject));
    $('btn-inspect')?.addEventListener('click', showInspector);
    const runNovaByteBtn = $('btn-run-novabyte');
    if (runNovaByteBtn) {
      // runtime/nbosp is no longer bundled with Studio -- deprecated in
      // place. Visually disabled, but still clickable so the toast can
      // actually explain why, rather than just going dead with no feedback.
      runNovaByteBtn.classList.add('is-deprecated');
      runNovaByteBtn.setAttribute('aria-disabled', 'true');
      runNovaByteBtn.title = 'Deprecated \u2014 NBOSP is no longer bundled. Clone it yourself: github.com/NovaByteTeam/novabyte-os';
      runNovaByteBtn.addEventListener('click', runNovaByte);
    }
    $('btn-editor-settings')?.addEventListener('click', showSettings);
    $('btn-about')?.addEventListener('click', openAboutModal);
  });

  // Tabs
  _safeInit('tabs', () => {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    window.addEventListener('resize', () => {
      if (state.activeTab === 'review') renderReviewPreview();
    });
  });

  // Manifest
  _safeInit('manifest buttons', () => {
    $('btn-save-manifest')?.addEventListener('click', saveManifest);
    $('btn-save-manifest-perms')?.addEventListener('click', saveManifest);
    $('design-window-popup-save')?.addEventListener('click', saveManifest);
    $('btn-view-json')?.addEventListener('click', () => {
      const windowError = _windowSettingsError();
      if (windowError) {
        alert(windowError);
        return;
      }
      const manifest = readManifestForm();
      $('json-viewer').textContent = JSON.stringify(manifest, null, 2);
      $('modal-json').classList.remove('hidden');
    });
  });

  // File tree -- toolbar buttons
  _safeInit('file tree toolbar', () => {
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
    $('btn-workspace-save')?.addEventListener('click', _saveCurrentWorkspace);
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
    $('btn-editor-save')?.addEventListener('click', saveOpenFile);
    $('btn-editor-save-all')?.addEventListener('click', saveAllOpenFiles);
    $('btn-toggle-preview')?.addEventListener('click', _togglePreview);
    $('btn-refresh-preview')?.addEventListener('click', _refreshPreviewIfVisible);
    $('btn-diff-vs-saved')?.addEventListener('click', openDiffVsSaved);
    $('btn-diff-prev')?.addEventListener('click', () => window.CMDiff?.goToPreviousChunk());
    $('btn-diff-next')?.addEventListener('click', () => window.CMDiff?.goToNextChunk());
  });

  // Context menu actions
  _safeInit('context menu actions', () => {
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
    document.addEventListener('click', () => { hideContextMenu(); hideRecentContextMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        hideRecentContextMenu();
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
    $('btn-pick-outdir')?.addEventListener('click', () => {
      pickFolder((dir) => { $('build-outdir').value = dir; });
    });
    $('build-outdir')?.addEventListener('input', _updateBuildSummary);
    _updateBuildSummary();
  });

  // Sign
  _safeInit('sign tab', () => {
    $('btn-sign-generate-key')?.addEventListener('click', () => _generateDevKeypair());
    $('btn-sign-selfsign')?.addEventListener('click', _runSelfSign);
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
      const revealed = privkeyRevealBtn.getAttribute('aria-pressed') === 'true';
      privkeyField?.classList.toggle('key-field--masked', revealed);
      privkeyRevealBtn.setAttribute('aria-pressed', String(!revealed));
      privkeyRevealBtn.textContent = revealed ? '\u{1F441}' : '\u{1F648}';
      privkeyRevealBtn.title = revealed ? 'Show private key' : 'Hide private key';
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
          const original = btn.textContent;
          btn.textContent = '\u2713';
          setTimeout(() => { btn.textContent = original; }, 1200);
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
    $('btn-pick-dir')?.addEventListener('click', () => {
      pickFolder((dir) => {
        const name = $('new-app-name').value.trim();
        $('new-app-dir').value = name ? path.join(dir, name.toLowerCase().replace(/\s+/g, '-')) : dir;
      });
    });
    $('btn-create-project')?.addEventListener('click', createProject);
  });

  // Check for updates on launch (silent -- only shows badge if newer version found)
  _safeInit('checkForUpdates', () => checkForUpdates());

  _safeInit('_initEditorPermissionHover', _initEditorPermissionHover);
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
    // Inspector rendering (depends on inspect/verify/listActions mocks)
    _renderPermissionAudit,
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