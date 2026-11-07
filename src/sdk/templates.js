// [NOVAPACK_TEMPLATES_JS] -- from NovaPack Studio, not NBOSP
'use strict';

/**
 * NovaByte Studio — App Templates
 *
 * Scaffolds new app project directories from a small set of starters.
 * Each template is a frozen spec: a display name, icon, and a map of
 * filename → generator function. The generator receives the manifest
 * and returns the file's string content, with manifest values escaped
 * for the context they land in (HTML text, JS string literal, URL).
 */

const fs = require('fs');
const path = require('path');

// Manifest fields end up interpolated straight into HTML or JS that becomes
// a real file loaded in a webview. A name like `</script><script>…` or an id
// containing a quote would break out of its context and run as injected
// markup or code in every app built from these templates. The three helpers
// below are the boundary between "user-supplied manifest field" and "bytes
// we write to disk and load as a page."

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// For values embedded inside a single-quoted JS string literal in a template
// (e.g. `appId: '${m.id}'`). Escapes backslashes and quotes so the value
// can't terminate the string early, and replaces line/paragraph separators
// — U+2028 and U+2029 are valid in JS strings but act as line terminators,
// which would be a syntax error inside a single-quoted literal.
const JS_STRING_REPLACEMENTS = Object.freeze({
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

function escapeJsString(value) {
  return String(value).replace(/[\\'\n\r\u2028\u2029]/g, (ch) => JS_STRING_REPLACEMENTS[ch]);
}

// The webapp template pins its host-managed browser view to manifest.url.
// Accept only HTTP(S) URLs so unsupported or executable schemes cannot be
// used as the app's initial destination.
function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const TEMPLATE_ICON_ART = Object.freeze({
  blank: ['#6478f5', '<path d="M19 23h26v23H19z"/><path d="m25 17 26 0 0 23M13 29v23h26" />'],
  webapp: ['#19a58a', '<circle cx="32" cy="32" r="16"/><path d="M16 32h32M32 16c5 5 7 10 7 16s-2 11-7 16c-5-5-7-10-7-16s2-11 7-16z"/>'],
  browser: ['#477df5', '<rect x="14" y="17" width="36" height="30" rx="5"/><path d="M14 25h36M20 21h.1M25 21h.1M30 21h.1M25 39l6-6 5 5 4-4 7 7"/>'],
  utility: ['#e1a640', '<path d="M35 17a12 12 0 0 0-14 15L15 38a5 5 0 0 0 7 7l6-6a12 12 0 0 0 15-14l-7 7-8-8z"/><path d="m19 41 .1.1"/>'],
  game: ['#8263eb', '<path d="M19 25h26a9 9 0 0 1 8 13l-3 6a5 5 0 0 1-8 1l-5-4h-8l-5 4a5 5 0 0 1-8-1l-3-6a9 9 0 0 1 8-13z"/><path d="M24 30v10M19 35h10M41 32h.1M46 37h.1"/>'],
  dashboard: ['#18a88b', '<rect x="15" y="16" width="34" height="32" rx="4"/><path d="M15 27h34M27 27v21M22 22h.1M28 22h.1M34 22h.1M33 40l5-6 4 3 5-7"/>'],
  form: ['#ed8e58', '<rect x="19" y="15" width="26" height="34" rx="4"/><path d="M26 24h13M26 32h13M26 40h8M22 24h.1M22 32h.1M22 40h.1"/>'],
  'markdown-viewer': ['#45a6d8', '<path d="M14 20a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z"/><path d="M20 38V28l5 6 5-6v10M36 35l5-7 5 7M41 28v13"/>'],
  chat: ['#d46bb2', '<path d="M16 18h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H29l-9 5v-5h-4a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z"/><path d="M22 29h20M22 36h13"/>'],
  'notifications-api': ['#df5f78', '<path d="M19 42h26l-4-5V28a9 9 0 0 0-18 0v9zM28 47a4 4 0 0 0 8 0"/>'],
  'alarms-api': ['#e6a543', '<circle cx="32" cy="34" r="16"/><path d="M32 24v11l8 5M19 17l-5 6M45 17l5 6"/>'],
  'clipboard-api': ['#5b87ed', '<rect x="19" y="19" width="26" height="31" rx="4"/><path d="M26 19v-4h12v4M25 29h14M25 36h14M25 43h9"/>'],
  'dialogs-api': ['#d5a248', '<path d="M13 23a4 4 0 0 1 4-4h12l4 5h14a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4z"/><path d="M32 29v12M26 35h12"/>'],
  'app-integration-api': ['#56a98e', '<circle cx="20" cy="32" r="5"/><circle cx="44" cy="20" r="5"/><circle cx="44" cy="44" r="5"/><path d="m25 30 14-8M25 34l14 8"/>'],
  'settings-window-api': ['#7083d9', '<path d="M17 21h30M17 32h30M17 43h30"/><circle cx="27" cy="21" r="4"/><circle cx="39" cy="32" r="4"/><circle cx="29" cy="43" r="4"/>'],
  'device-apis': ['#54a9ca', '<path d="M32 50s15-14 15-25a15 15 0 1 0-30 0c0 11 15 25 15 25z"/><circle cx="32" cy="25" r="5"/>'],
  'calendar-contacts-api': ['#5ba78c', '<rect x="15" y="19" width="34" height="30" rx="4"/><path d="M23 15v8M41 15v8M15 28h34M23 35h5M36 35h5M23 42h5"/>'],
  'data-backup-api': ['#8269d4', '<path d="M17 23h30v24H17z"/><path d="M24 23v-7h16v7M26 34h12M26 40h12"/>'],
  'events-lifecycle-api': ['#46a59d', '<path d="M14 33h9l5-12 8 23 5-11h9"/><path d="M20 18a17 17 0 0 1 26 5M44 46a17 17 0 0 1-26-5"/>'],
  'secrets-api': ['#d1a84c', '<rect x="17" y="28" width="30" height="22" rx="4"/><path d="M23 28v-6a9 9 0 0 1 18 0v6M32 36v6"/>'],
  'share-target-api': ['#4f91d5', '<circle cx="19" cy="32" r="5"/><circle cx="44" cy="19" r="5"/><circle cx="44" cy="45" r="5"/><path d="m24 30 15-9M24 34l15 9"/>'],
});

function makeTemplateIcon(key) {
  const [accent, artwork] = TEMPLATE_ICON_ART[key] || TEMPLATE_ICON_ART.blank;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset="1" stop-color="#1b2850"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="17" fill="url(#bg)"/><circle cx="50" cy="13" r="15" fill="#fff" opacity=".08"/><g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">${artwork}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function apiStarterTemplate({ name, description, icon, permissions = [], optionalPermissions = [], permissionReasons = {}, shareTarget, appJs }) {
  return {
    name,
    description,
    icon,
    permissions,
    optionalPermissions,
    permissionReasons,
    ...(shareTarget ? { shareTarget } : {}),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || description)}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <header>
      <span class="eyebrow">NOVAAPP API STARTER</span>
      <h1>${escapeHtml(m.name)}</h1>
      <p>${escapeHtml(description)}</p>
    </header>
    <section id="controls" aria-label="API demo controls"></section>
    <p id="status" role="status" aria-live="polite">Ready. Choose an action to try this API.</p>
    <pre id="output" aria-live="polite"></pre>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,
      'app.js': (m) => `// ${escapeJsString(m.name)}
// NovaApp v2 API starter: ${escapeJsString(description)}

function main() {
  const controls = document.getElementById('controls');
  const status = document.getElementById('status');
  const output = document.getElementById('output');

  function show(value) {
    output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  async function run(action) {
    try {
      const result = await action();
      if (result !== undefined) show(result);
      setStatus('Completed.');
    } catch (error) {
      setStatus(error.message || 'The API call failed.', true);
      console.error('NovaApp API starter error:', error);
    }
  }

  function addButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => void run(action));
    controls.append(button);
    return button;
  }

  function addField(label, options = {}) {
    const wrapper = document.createElement('label');
    wrapper.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement(options.multiline ? 'textarea' : 'input');
    if (!options.multiline) input.type = options.type || 'text';
    input.placeholder = options.placeholder || '';
    if (options.value) input.value = options.value;
    wrapper.append(caption, input);
    controls.append(wrapper);
    return input;
  }

  async function requestPermission(permission, reason) {
    const granted = await window.novaOS.permissions.request(permission, reason);
    if (!granted) throw new Error('Permission not granted: ' + permission);
  }

  ${appJs}
}

main();`,
      'style.css': () => `:root {
  color-scheme: dark;
  font-family: system-ui, sans-serif;
  color: #eef2ff;
  background: #111827;
}

* { box-sizing: border-box; }

body {
  min-height: 100vh;
  margin: 0;
  padding: clamp(20px, 5vw, 56px);
  background: radial-gradient(ellipse at top left, #23304b, #111827 58%);
}

.app { width: min(760px, 100%); margin: 0 auto; }
header { margin-bottom: 28px; }
.eyebrow { color: #8ea8ff; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
h1 { margin: 8px 0; font-size: clamp(28px, 5vw, 40px); }
header p { margin: 0; color: #aab5ca; line-height: 1.6; }

#controls {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
  padding: 16px;
  border: 1px solid #ffffff1a;
  border-radius: 14px;
  background: #ffffff08;
}

button, input, textarea {
  border: 1px solid #ffffff24;
  border-radius: 8px;
  background: #1c2638;
  color: inherit;
  font: inherit;
}

button { padding: 10px 14px; cursor: pointer; }
button:hover { background: #293752; }
button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid #8ea8ff;
  outline-offset: 2px;
}

.field { display: grid; flex: 1 1 220px; gap: 6px; color: #aab5ca; font-size: 12px; }
.field input, .field textarea { width: 100%; padding: 10px; }
.field textarea { min-height: 110px; resize: vertical; }
#status { min-height: 1.5em; margin: 18px 2px 8px; color: #aab5ca; font-size: 13px; }
#status.error { color: #ff9a9a; }
#output {
  min-height: 80px;
  overflow: auto;
  padding: 14px;
  border: 1px solid #ffffff14;
  border-radius: 10px;
  background: #080d16a8;
  color: #c7d2e7;
  font: 12px/1.6 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}`,
    },
  };
}

const API_STARTER_TEMPLATES = {
  'notifications-api': apiStarterTemplate({
    name: 'Notifications API',
    description: 'Create a notification channel, post a notification, and inspect action replies.',
    icon: makeTemplateIcon('notifications-api'),
    permissions: ['device:notifications'],
    permissionReasons: {
      'device:notifications': 'Posts the notifications you explicitly trigger from this demo.',
    },
    appJs: `
  const channelId = 'starter-updates';
  addButton('Create channel and post test notification', async () => {
    await window.novaOS.notifications.createChannel(channelId, 'Starter updates', 'default');
    return window.novaOS.notifications.post({
      channelId,
      tag: 'starter-test',
      title: 'NovaApp API starter',
      body: 'Your notification API is working.',
      actions: [{ id: 'open', label: 'Open app' }],
    });
  });
  addButton('Read notification actions', () => window.novaOS.notifications.consumeActions());`,
  }),

  'alarms-api': apiStarterTemplate({
    name: 'Alarms API',
    description: 'Listen for an alarm, schedule a one-minute reminder, and inspect or cancel alarms.',
    icon: makeTemplateIcon('alarms-api'),
    optionalPermissions: ['system:schedule'],
    permissionReasons: {
      'system:schedule': 'Schedules the reminder alarm that you choose to create in this demo.',
    },
    appJs: `
  const alarmName = 'starter-reminder';
  let stopListening = null;
  addButton('Listen for alarm events', async () => {
    await requestPermission('system:schedule', 'Listens for the alarm you schedule with this demo.');
    if (!stopListening) {
      stopListening = await window.novaOS.alarms.onAlarm((event) => {
        show(event);
        setStatus('Alarm fired: ' + event.name);
      });
    }
    return 'Listening for alarm events in this running app.';
  });
  addButton('Schedule reminder in one minute', async () => {
    await requestPermission('system:schedule', 'Schedules a one-minute test reminder.');
    return window.novaOS.alarms.create({ name: alarmName, when: Date.now() + 60_000 });
  });
  addButton('List alarms', async () => {
    await requestPermission('system:schedule', 'Lists alarms scheduled by this app.');
    return window.novaOS.alarms.getAll();
  });
  addButton('Cancel reminder', async () => {
    await requestPermission('system:schedule', 'Cancels the reminder scheduled by this demo.');
    return window.novaOS.alarms.clear(alarmName);
  });
  window.addEventListener('pagehide', () => {
    if (stopListening) void stopListening();
  }, { once: true });`,
  }),

  'clipboard-api': apiStarterTemplate({
    name: 'Clipboard API',
    description: 'Write text to the clipboard and explicitly request access before reading it.',
    icon: makeTemplateIcon('clipboard-api'),
    optionalPermissions: ['clipboard:read', 'clipboard:write'],
    permissionReasons: {
      'clipboard:read': 'Reads clipboard text only after you press the read button.',
      'clipboard:write': 'Copies text only after you press the copy button.',
    },
    appJs: `
  const text = addField('Text to copy', { value: 'Hello from NovaApp.' });
  addButton('Copy text', async () => {
    await requestPermission('clipboard:write', 'Copies the text you entered into the system clipboard.');
    await window.novaOS.clipboard.writeText(text.value);
    return 'Text copied.';
  });
  addButton('Read clipboard', async () => {
    await requestPermission('clipboard:read', 'Reads the current system clipboard after your request.');
    return { text: await window.novaOS.clipboard.readText() };
  });`,
  }),

  'dialogs-api': apiStarterTemplate({
    name: 'Dialogs & File Picker',
    description: 'Open user-mediated file pickers for selecting an input or save destination.',
    icon: makeTemplateIcon('dialogs-api'),
    appJs: `
  addButton('Pick a JSON or text file', () =>
    window.novaOS.dialog.pickOpen({ accept: '.json,.txt', multiple: false }));
  addButton('Choose a save destination', () =>
    window.novaOS.dialog.pickSave({ defaultName: 'starter-export.json' }));`,
  }),

  'app-integration-api': apiStarterTemplate({
    name: 'App Integration',
    description: 'Inspect this app, browse installed apps, launch one, or open the OS share sheet.',
    icon: makeTemplateIcon('app-integration-api'),
    optionalPermissions: ['system:apps', 'system:app-launch'],
    permissionReasons: {
      'system:apps': 'Lists installed apps when you ask to browse them.',
      'system:app-launch': 'Launches the app whose identifier you entered.',
    },
    appJs: `
  const appId = addField('Installed app ID to launch', { placeholder: 'com.example.otherapp' });
  addButton('Show this app info', () => window.novaOS.app.info());
  addButton('List installed apps', async () => {
    await requestPermission('system:apps', 'Lists installed apps so you can choose an integration target.');
    return window.novaOS.app.list();
  });
  addButton('Launch entered app', async () => {
    if (!appId.value.trim()) throw new Error('Enter an app ID first.');
    await requestPermission('system:app-launch', 'Launches the app ID you entered.');
    return window.novaOS.app.launch(appId.value.trim());
  });
  addButton('Share a sample message', () =>
    window.novaOS.app.share({ title: 'NovaApp API starter', text: 'Shared from the App Integration starter.' }));`,
  }),

  'settings-window-api': apiStarterTemplate({
    name: 'Settings & Window',
    description: 'Read an allowlisted OS setting and inspect or update the app window.',
    icon: makeTemplateIcon('settings-window-api'),
    optionalPermissions: ['system:info', 'system:settings'],
    permissionReasons: {
      'system:info': 'Reads the current OS theme after you request it.',
      'system:settings': 'Changes the OS accent color only when you submit a color.',
    },
    appJs: `
  const color = addField('Accent color (#rrggbb)', { value: '#6688ff' });
  addButton('Read OS theme', async () => {
    await requestPermission('system:info', 'Reads the allowlisted theme preference.');
    return { theme: await window.novaOS.settings.get('theme') };
  });
  addButton('Set OS accent color', async () => {
    if (!/^#[0-9a-f]{6}$/i.test(color.value.trim())) throw new Error('Enter a color like #6688ff.');
    await requestPermission('system:settings', 'Changes the OS accent color to the value you entered.');
    await window.novaOS.settings.set('accentColor', color.value.trim());
    return 'Accent color updated.';
  });
  addButton('Read window state', () => window.novaOS.window.getState());
  addButton('Set window title', () => window.novaOS.window.setTitle('NovaApp Window API Starter'));`,
  }),

  'device-apis': apiStarterTemplate({
    name: 'Device APIs',
    description: 'Request location, camera, or microphone access only when you choose each action.',
    icon: makeTemplateIcon('device-apis'),
    optionalPermissions: ['device:geolocation', 'device:camera', 'device:microphone'],
    permissionReasons: {
      'device:geolocation': 'Reads your current location only after you press the location button.',
      'device:camera': 'Opens the camera only after you press the camera button.',
      'device:microphone': 'Opens the microphone only after you press the microphone button.',
    },
    appJs: `
  addButton('Get current location', async () => {
    await requestPermission('device:geolocation', 'Shows your current location in this demo.');
    return window.novaOS.geolocation.getCurrentPosition({ timeout: 10_000 });
  });
  async function testMedia(permission, constraints, reason) {
    await requestPermission(permission, reason);
    const stream = await window.novaOS.media.getUserMedia(constraints);
    const tracks = stream.getTracks().map((track) => ({ kind: track.kind, label: track.label }));
    stream.getTracks().forEach((track) => track.stop());
    return { opened: true, tracksStopped: true, tracks };
  }
  addButton('Test camera', () => testMedia(
    'device:camera', { video: true }, 'Opens the camera briefly to verify access, then stops it.'));
  addButton('Test microphone', () => testMedia(
    'device:microphone', { audio: true }, 'Opens the microphone briefly to verify access, then stops it.'));`,
  }),

  'calendar-contacts-api': apiStarterTemplate({
    name: 'Calendar & Contacts',
    description: 'Read or add a clearly labeled sample event and contact in shared OS data.',
    icon: makeTemplateIcon('calendar-contacts-api'),
    optionalPermissions: ['calendar:read', 'calendar:write', 'contacts:read', 'contacts:write'],
    permissionReasons: {
      'calendar:read': 'Reads your calendar only when you press the list events button.',
      'calendar:write': 'Adds a clearly labeled sample event only when you press the add event button.',
      'contacts:read': 'Reads your contacts only when you press the list contacts button.',
      'contacts:write': 'Adds a clearly labeled sample contact only when you press the add contact button.',
    },
    appJs: `
  addButton('List calendar events', async () => {
    await requestPermission('calendar:read', 'Reads calendar entries so you can inspect the API result.');
    return window.novaOS.calendar.list();
  });
  addButton('Add sample calendar event', async () => {
    await requestPermission('calendar:write', 'Adds one event titled NovaApp API starter demo to your shared calendar.');
    return window.novaOS.calendar.save({
      id: 'novaapp-starter-' + Date.now(),
      title: 'NovaApp API starter demo',
      date: new Date().toISOString().slice(0, 10),
    });
  });
  addButton('List contacts', async () => {
    await requestPermission('contacts:read', 'Reads contacts so you can inspect the API result.');
    return window.novaOS.contacts.list();
  });
  addButton('Add sample contact', async () => {
    await requestPermission('contacts:write', 'Adds a clearly labeled NovaApp API starter contact.');
    return window.novaOS.contacts.save({
      id: 'novaapp-starter-' + Date.now(),
      name: 'NovaApp API starter demo',
      email: 'starter@example.invalid',
    });
  });`,
  }),

  'data-backup-api': apiStarterTemplate({
    name: 'Data Backup & Restore',
    description: 'Create a checksummed backup envelope and merge a same-app backup back into storage.',
    icon: makeTemplateIcon('data-backup-api'),
    optionalPermissions: ['data:backup'],
    permissionReasons: {
      'data:backup': 'Creates or restores a backup of this app’s own key-value data when you choose.',
    },
    appJs: `
  const envelopeText = addField('Backup envelope JSON', {
    multiline: true,
    placeholder: 'Create a backup to fill this field, or paste a backup for this same app.',
  });
  addButton('Create backup', async () => {
    await requestPermission('data:backup', 'Creates a portable backup of this app’s own data.');
    const result = await window.novaOS.data.backup();
    envelopeText.value = JSON.stringify(result.envelope, null, 2);
    return { capturedAt: result.envelope.capturedAt, keys: result.envelope.counts.keys };
  });
  addButton('Merge backup into this app', async () => {
    await requestPermission('data:backup', 'Restores the same app’s backup without clearing current data.');
    let envelope;
    try {
      envelope = JSON.parse(envelopeText.value);
    } catch {
      throw new Error('Enter a valid backup envelope JSON first.');
    }
    return window.novaOS.data.restore(envelope, { clearFirst: false });
  });`,
  }),

  'events-lifecycle-api': apiStarterTemplate({
    name: 'Events & Lifecycle',
    description: 'Subscribe to an allowlisted system event and cleanly unsubscribe when finished.',
    icon: makeTemplateIcon('events-lifecycle-api'),
    appJs: `
  let stopThemeListener = null;
  addButton('Subscribe to theme changes', async () => {
    if (stopThemeListener) return 'Already listening for theme changes.';
    stopThemeListener = await window.novaOS.events.on('system:themeChanged', (event) => {
      show(event);
      setStatus('Theme changed.');
    });
    return 'Subscribed. Change the OS theme to receive an event.';
  });
  addButton('Unsubscribe', async () => {
    if (!stopThemeListener) return 'There is no active subscription.';
    await stopThemeListener();
    stopThemeListener = null;
    return 'Unsubscribed.';
  });
  window.addEventListener('visibilitychange', () => {
    setStatus(document.visibilityState === 'visible' ? 'App became visible.' : 'App is hidden.');
  });
  window.addEventListener('pagehide', () => {
    if (stopThemeListener) void stopThemeListener();
  }, { once: true });`,
  }),

  'secrets-api': apiStarterTemplate({
    name: 'Secrets',
    description: 'Store a credential in the encrypted app-scoped secrets store, then read or delete it.',
    icon: makeTemplateIcon('secrets-api'),
    optionalPermissions: ['secrets:store'],
    permissionReasons: {
      'secrets:store': 'Stores and retrieves the credential you enter using the encrypted app-scoped secrets store.',
    },
    appJs: `
  const key = addField('Secret name', { value: 'demo-token' });
  const value = addField('Secret value', { type: 'password', placeholder: 'Enter a test value' });
  addButton('Store secret', async () => {
    if (!key.value.trim() || !value.value) throw new Error('Enter a name and value.');
    await requestPermission('secrets:store', 'Stores the value you entered in this app’s encrypted secret store.');
    const secretKey = key.value.trim();
    const secretValue = value.value;
    await window.novaOS.secrets.set(secretKey, secretValue);
    const storedValue = await window.novaOS.secrets.get(secretKey);
    const keys = await window.novaOS.secrets.keys();
    if (storedValue !== secretValue || !keys.includes(secretKey)) {
      throw new Error('The host accepted the save call, but the secret could not be read back. Verify this NovaByte OS build supports secrets.v1 and restart the app.');
    }
    value.value = '';
    return {
      saved: true,
      verified: true,
      key: secretKey,
      keys,
      persistence: 'The NovaApp v2 facade does not report whether it was persisted to disk.',
    };
  });
  addButton('Retrieve secret into password field', async () => {
    await requestPermission('secrets:store', 'Reads this app’s secret with your request.');
    const secretKey = key.value.trim();
    value.value = await window.novaOS.secrets.get(secretKey) || '';
    return {
      found: value.value.length > 0,
      key: secretKey,
      message: value.value ? 'Secret loaded into the password field.' : 'No secret with this name exists for this app.',
    };
  });
  addButton('List secret names', async () => {
    await requestPermission('secrets:store', 'Lists this app’s secret labels, not their values.');
    const keys = await window.novaOS.secrets.keys();
    return {
      keys,
      message: keys.length ? 'These secret names belong to this app.' : 'This app has no stored secrets yet.',
    };
  });
  addButton('Delete secret', async () => {
    await requestPermission('secrets:store', 'Deletes the named secret from this app’s encrypted store.');
    await window.novaOS.secrets.delete(key.value.trim());
    value.value = '';
    return 'Secret deleted.';
  });`,
  }),

  'share-target-api': apiStarterTemplate({
    name: 'Share Target',
    description: 'Register as a user-selected share destination and display incoming shared content.',
    icon: makeTemplateIcon('share-target-api'),
    optionalPermissions: ['system:share-target'],
    permissionReasons: {
      'system:share-target': 'Receives content only after the user selects this app in the OS share sheet.',
    },
    shareTarget: { mimeTypes: ['text/plain', 'text/uri-list'] },
    appJs: `
  let stopShareListener = null;
  addButton('Enable incoming shares', async () => {
    await requestPermission(
      'system:share-target',
      'Allows this app to appear in the share sheet and receive content you select for it.');
    if (!stopShareListener) {
      stopShareListener = window.novaOS.share.onInbound((share) => {
        show(share);
        setStatus('Received shared content.');
      });
    }
    return 'Ready to receive shares selected by the user.';
  });
  window.addEventListener('pagehide', () => {
    if (stopShareListener) stopShareListener();
  }, { once: true });`,
  }),
};

const TEMPLATES = Object.freeze({
  'native-cpp': {
    name: 'Native C++',
    description: 'C++ compiled to WebAssembly, UI in HTML/CSS/JS',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB2ZXJzaW9uPSIxLjEiIGlkPSJMYXllcl8xIiB4PSIwcHgiIHk9IjBweCIgd2lkdGg9IjMwNnB4IiBoZWlnaHQ9IjM0NC4zNXB4IiB2aWV3Qm94PSIwIDAgMzA2IDM0NC4zNSIgZW5hYmxlLWJhY2tncm91bmQ9Im5ldyAwIDAgMzA2IDM0NC4zNSIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+CjxwYXRoIGZpbGw9IiMwMDU5OUMiIGQ9Ik0zMDIuMTA3LDI1OC4yNjJjMi40MDEtNC4xNTksMy44OTMtOC44NDUsMy44OTMtMTMuMDUzVjk5LjE0YzAtNC4yMDgtMS40OS04Ljg5My0zLjg5Mi0xMy4wNTJMMTUzLDE3Mi4xNzUgIEwzMDIuMTA3LDI1OC4yNjJ6Ii8+CjxwYXRoIGZpbGw9IiMwMDQ0ODIiIGQ9Ik0xNjYuMjUsMzQxLjE5M2wxMjYuNS03My4wMzRjMy42NDQtMi4xMDQsNi45NTYtNS43MzcsOS4zNTctOS44OTdMMTUzLDE3Mi4xNzVMMy44OTMsMjU4LjI2MyAgYzIuNDAxLDQuMTU5LDUuNzE0LDcuNzkzLDkuMzU3LDkuODk2bDEyNi41LDczLjAzNEMxNDcuMDM3LDM0NS40MDEsMTU4Ljk2MywzNDUuNDAxLDE2Ni4yNSwzNDEuMTkzeiIvPgo8cGF0aCBmaWxsPSIjNjU5QUQyIiBkPSJNMzAyLjEwOCw4Ni4wODdjLTIuNDAyLTQuMTYtNS43MTUtNy43OTMtOS4zNTgtOS44OTdMMTY2LjI1LDMuMTU2Yy03LjI4Ny00LjIwOC0xOS4yMTMtNC4yMDgtMjYuNSwwICBMMTMuMjUsNzYuMTlDNS45NjIsODAuMzk3LDAsOTAuNzI1LDAsOTkuMTR2MTQ2LjA2OWMwLDQuMjA4LDEuNDkxLDguODk0LDMuODkzLDEzLjA1M0wxNTMsMTcyLjE3NUwzMDIuMTA4LDg2LjA4N3oiLz4KPGc+Cgk8cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNMTUzLDI3NC4xNzVjLTU2LjI0MywwLTEwMi00NS43NTctMTAyLTEwMnM0NS43NTctMTAyLDEwMi0xMDJjMzYuMjkyLDAsNzAuMTM5LDE5LjUzLDg4LjMzMSw1MC45NjggICBsLTQ0LjE0MywyNS41NDRjLTkuMTA1LTE1LjczNi0yNi4wMzgtMjUuNTEyLTQ0LjE4OC0yNS41MTJjLTI4LjEyMiwwLTUxLDIyLjg3OC01MSw1MWMwLDI4LjEyMSwyMi44NzgsNTEsNTEsNTEgICBjMTguMTUyLDAsMzUuMDg1LTkuNzc2LDQ0LjE5MS0yNS41MTVsNDQuMTQzLDI1LjU0M0MyMjMuMTQyLDI1NC42NDQsMTg5LjI5NCwyNzQuMTc1LDE1MywyNzQuMTc1eiIvPgo8L2c+CjxnPgoJPHBvbHlnb24gZmlsbD0iI0ZGRkZGRiIgcG9pbnRzPSIyNTUsMTY2LjUwOCAyNDMuNjY2LDE2Ni41MDggMjQzLjY2NiwxNTUuMTc1IDIzMi4zMzQsMTU1LjE3NSAyMzIuMzM0LDE2Ni41MDggMjIxLDE2Ni41MDggICAgMjIxLDE3Ny44NDEgMjMyLjMzNCwxNzcuODQxIDIzMi4zMzQsMTg5LjE3NSAyNDMuNjY2LDE4OS4xNzUgMjQzLjY2NiwxNzcuODQxIDI1NSwxNzcuODQxICAiLz4KPC9nPgo8Zz4KCTxwb2x5Z29uIGZpbGw9IiNGRkZGRkYiIHBvaW50cz0iMjk3LjUsMTY2LjUwOCAyODYuMTY2LDE2Ni41MDggMjg2LjE2NiwxNTUuMTc1IDI3NC44MzQsMTU1LjE3NSAyNzQuODM0LDE2Ni41MDggMjYzLjUsMTY2LjUwOCAgICAyNjMuNSwxNzcuODQxIDI3NC44MzQsMTc3Ljg0MSAyNzQuODM0LDE4OS4xNzUgMjg2LjE2NiwxODkuMTc1IDI4Ni4xNjYsMTc3Ljg0MSAyOTcuNSwxNzcuODQxICAiLz4KPC9nPgo8L3N2Zz4=',
    // No vendor/ entry here: vendor/ is for pre-built third-party JS/CSS/
    // wasm files the user drops in (see create()'s vendor/README.md). This
    // template's C++ is the project's OWN source, so it's a normal project
    // file like index.html/app.js, not a vendor asset.
    files: {
      'module.cpp': () => `
// minimal, working, end-to-end plumbing rather than a real feature.
// EMSCRIPTEN_KEEPALIVE stops the compiler's dead-code elimination from
// dropping functions that are only ever called from JS, not from C++.
#include <emscripten.h>

extern "C" {

EMSCRIPTEN_KEEPALIVE
int add(int a, int b) {
    return a + b;
}

}`,

      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Built with NovaByte Studio')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="container">
    <h1>${escapeHtml(m.name)}</h1>
    <p id="result">Compiling / loading module...</p>
  </main>
  <!-- module.js is the Emscripten-generated glue -- it does not exist until
       you Build (or run node build.mjs locally with emcc on PATH). It is
       NOT committed as a template file itself; builder.js's C++ detection
       compiles module.cpp -> module.js + module.wasm at build time and
       those become normal bundled files, same as anything else here. -->
  <script src="module.js"></script>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// The runtime handshake is automatic; use the v2 snapshot to inspect grants.
//
// Module (from module.js, the emcc-generated glue for module.cpp) is a
// MODULARIZE factory function, not a pre-built object -- builder.js's
// compileCppSources() passes -s MODULARIZE=1 -s EXPORT_NAME=Module to emcc,
// so calling Module() returns a Promise that resolves once the .wasm has
// actually loaded. Setting Module.onRuntimeInitialized on the factory does
// nothing, since nothing ever calls the factory to instantiate it.
window.novaOS.ready.get()
  .then((result) => console.log('Permissions granted:', result.permissions))
  .catch((error) => console.error('Could not read runtime grants:', error));

const resultEl = document.getElementById('result');

if (typeof Module === 'undefined') {
  // Expected in the editor/preview before the first real Build -- module.js
  // only exists once builder.js has compiled module.cpp. Not an error.
  resultEl.textContent = 'module.js not found yet — run Build to compile module.cpp.';
} else {
  Module().then((instance) => {
    // ccall('funcName', returnType, [argTypes], [args]) -- see module.cpp's
    // extern "C" add(int, int). Matches the EXPORTED_RUNTIME_METHODS flags
    // builder.js's compileCppSources() passes to emcc.
    const sum = instance.ccall('add', 'number', ['number', 'number'], [15, 30]);
    resultEl.textContent = \`C++ add(15, 30) = \${sum}\`;
  });
}`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --fg-muted: oklch(66.2% 0.018 251);
  }
}

@layer base {
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

@layer components {
  .container { padding: 40px; text-align: center; }
  h1 { font-size: 32px; margin-block-end: 12px; text-wrap: balance; }
  p { color: var(--fg-muted); font-size: 16px; text-wrap: pretty; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,

      'README.md': () => `# Native C++ template

This project has a C/C++ source file (module.cpp) alongside the usual
HTML/CSS/JS. UI, layout, and Nova API calls stay in JS -- only
compute-heavy logic belongs in module.cpp. See the "Games and rendering"
note below before assuming C++ will make everything faster.

## Requirements

Packaged Studio releases include a platform-specific Emscripten SDK. When
running Studio from source or a development build, Emscripten (\`emcc\`) must
be installed separately and available on your PATH.

For source/development builds, install it yourself first:
  macOS:            brew install emscripten
  Linux/Windows:    git clone https://github.com/emscripten-core/emsdk.git
                     cd emsdk && ./emsdk install latest && ./emsdk activate latest
                     source ./emsdk_env.sh   (or emsdk_env.ps1 / emsdk_env.bat)

Full instructions: https://emscripten.org/docs/getting_started/downloads.html

## How it builds

Build detects module.cpp automatically and compiles it with emcc before
bundling -- no separate step, no manual toolchain wiring. The Build button
turns purple when a project like this one has C/C++ sources detected.
Compiling emits module.js (glue) + module.wasm, which then get bundled into
the .novaapp package exactly like any other project file.

## Calling C++ from JS

module.cpp exports functions via \`extern "C"\` + \`EMSCRIPTEN_KEEPALIVE\`.
Module (from module.js) is a MODULARIZE factory function -- call \`Module()\`
and use \`.then((instance) => ...)\` to get the real instance once the .wasm
has actually loaded, then call instance.ccall/cwrap on that. See app.js for
the working example (add(a, b)). Don't call ccall before the factory's
promise resolves; the .wasm binary loads asynchronously even though
module.js itself is a normal <script>.

## What actually gets faster

C++/WASM wins on CPU-bound work done in module.cpp itself -- simulation,
parsing, numeric loops, DSP, pathfinding. It does NOT speed up anything
already handled by a browser-native API on the JS side -- Canvas2D drawing,
DOM updates, or nova.ipc round-trips are not JS-bound to begin with, so
moving surrounding code to C++ doesn't touch their cost. Keep UI/IPC code
in JS; move only genuinely CPU-heavy logic into module.cpp.

## Adding a prebuilt WASM library instead of writing your own

If you want to use an existing compiled .wasm library rather than writing
C++ yourself, drop the .wasm file in vendor/ instead -- see vendor/README.md
in this project. That's for consuming someone else's prebuilt library;
module.cpp is for your own C++ source that Build compiles for you.
`,
    },
  },

  blank: {
    name: 'Blank App',
    description: 'Empty shell — start from scratch',
    icon: makeTemplateIcon('blank'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Built with NovaByte Studio')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="container">
    <h1>${escapeHtml(m.name)}</h1>
    <p>${escapeHtml(m.description || 'Built with NovaByte Studio')}</p>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// The runtime handshake is automatic; use the v2 snapshot to inspect grants.
window.novaOS.ready.get()
  .then((result) => console.log('Permissions granted:', result.permissions))
  .catch((error) => console.error('Could not read runtime grants:', error));`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --fg-muted: oklch(66.2% 0.018 251);
  }
}

@layer base {
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

@layer components {
  .container { padding: 40px; text-align: center; }
  h1 { font-size: 32px; margin-block-end: 12px; text-wrap: balance; }
  p { color: var(--fg-muted); font-size: 16px; text-wrap: pretty; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  webapp: {
    name: 'Web App Wrapper',
    description: 'Pins one external site as its own app — fixed URL, no address bar or navigation',
    icon: makeTemplateIcon('webapp'),
    permissions: ['net:external', 'sandbox:nested-webview'],
    permissionReasons: {
      'net:external': 'Loads the website URL configured for this app.',
      'sandbox:nested-webview': 'Displays the configured website inside this app.',
    },
    // Tells the New Project preview which manifest field this template reads,
    // so it doesn't have to scan generated text to guess. Lives next to `files`
    // so the two can't drift apart.
    placeholderFields: [
      {
        key: 'url',
        label: 'Website URL',
        placeholder: 'https://example.com',
        default: 'https://example.com',
        // Same function used when generating app.js below — not a reimplementation.
        // Otherwise the preview's token matching would miss cases where URL
        // normalization changes the string (e.g. a trailing slash added by URL.href).
        normalize: (value) => sanitizeUrl(value) || 'https://example.com',
      },
    ],
    files: {
      // Produces a sandboxed .novaapp with a host-managed browser view pinned
      // to the configured URL. No address field or navigation controls.
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Web app wrapper')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="url-bar" role="contentinfo"></div>
  <main id="content"></main>
  <p id="status" role="status" aria-live="polite"></p>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// Fixed-URL web app wrapper using Nova's host-managed browser view.

const WRAPPED_URL = ${JSON.stringify(sanitizeUrl(m.url) || 'https://example.com')};
let browserView = null;
const lifecycle = new AbortController();

async function requireBrowserApi() {
  let browser = window.nova?.browser;
  if (typeof browser?.createView === 'function') return browser;
  if (typeof window.novaOS?.permissions?.request === 'function') {
    const granted = await window.novaOS.permissions.request(
      'sandbox:nested-webview',
      'This app needs an embedded browser view to display the configured website.'
    );
    if (!granted) throw new Error('Browser access was not granted.');
    browser = window.nova?.browser;
  }
  if (typeof browser?.createView !== 'function') {
    throw new Error('The Nova browser API is unavailable. Grant sandbox:nested-webview and restart the app.');
  }
  return browser;
}

window.addEventListener('pagehide', () => {
  lifecycle.abort();
  browserView?.destroy();
}, { once: true });

async function main() {
  const urlBar = document.getElementById('url-bar');
  const content = document.getElementById('content');
  const status = document.getElementById('status');

  try {
    urlBar.textContent = '\\uD83D\\uDD12 ' + new URL(WRAPPED_URL).host;
  } catch {
    urlBar.textContent = 'External Web App';
  }

  content.classList.add('loading');
  try {
    const browser = await requireBrowserApi();
    browserView = await browser.createView({
      container: content,
      url: WRAPPED_URL,
      pollingInterval: 0,
    });
    if (lifecycle.signal.aborted) {
      browserView.destroy();
      browserView = null;
      return;
    }
    browserView.addEventListener('navigation-start', () => {
      content.classList.add('loading');
      status.textContent = '';
    });
    browserView.addEventListener('navigation-complete', () => {
      content.classList.remove('loading');
      status.textContent = '';
    });
    browserView.addEventListener('navigation-error', (event) => {
      content.classList.remove('loading');
      status.textContent = event.detail.errorDescription || event.detail.reason || 'Navigation failed';
    });
    const state = await browserView.getState();
    content.classList.remove('loading');
    if (state.loading) content.classList.add('loading');
  } catch (error) {
    browserView?.destroy();
    browserView = null;
    content.classList.remove('loading');
    status.textContent = 'Could not open site: ' + error.message;
    console.error('Could not create browser view:', error);
  }
}

main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg-dim: oklch(100% 0 0 / 0.4);
    --border: oklch(100% 0 0 / 0.07);
    --loading-bg: oklch(98.5% 0 0);
    --loading-fg: oklch(0% 0 0 / 0.35);
  }
}

@layer base {
  html, body { height: 100%; }
  body {
    font-family: system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }
}

@layer components {
  #url-bar {
    background: oklch(0% 0 0 / 0.22);
    border-block-end: 1px solid var(--border);
    padding: 5px 12px;
    font-size: 11px;
    color: var(--fg-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: monospace;
    flex-shrink: 0;
  }

  #content { flex: 1; position: relative; overflow: hidden; }

  #status {
    flex-shrink: 0;
    padding: 5px 12px;
    color: var(--loading-fg);
    font: 11px monospace;
  }

  #status:empty { display: none; }

  #content.loading::after {
    content: 'Loading…';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    color: var(--loading-fg);
    background: var(--loading-bg);
  }

}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  utility: {
    name: 'Utility App',
    description: "App-data tool using NovaByte's scoped filesystem",
    icon: makeTemplateIcon('utility'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="description" content="${escapeHtml(m.description || 'Utility app')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <div class="toolbar" role="toolbar" aria-label="File operations">
      <button id="btn-list" type="button">List Files</button>
      <button id="btn-read" type="button">Read File</button>
      <button id="btn-write" type="button">Write File</button>
    </div>
    <output id="output" aria-live="polite">Ready…</output>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// nova:ready fires automatically before this script runs — no handshake needed.

function main() {
  const lifecycle = new AbortController();

  // App-owned files need no filesystem permission.
  const APP_FILE_PATH = 'files/example.txt';

  function log(message) {
    document.getElementById('output').textContent = message;
  }

  async function listFiles() {
    try {
      const listing = await window.novaOS.fs.appdata.list();
      log(JSON.stringify(listing, null, 2));
    } catch (error) {
      log('Could not list app files: ' + error.message);
    }
  }

  async function readFile() {
    try {
      const file = await window.novaOS.fs.appdata.read(APP_FILE_PATH);
      log(file.data ?? '(empty)');
    } catch (error) {
      log('Could not read app file: ' + error.message);
    }
  }

  async function writeFile() {
    try {
      await window.novaOS.fs.appdata.write(APP_FILE_PATH, 'Hello from ${escapeJsString(m.name)}');
      log('Saved!');
    } catch (error) {
      log('Could not write app file: ' + error.message);
    }
  }

  document.getElementById('btn-list').addEventListener('click', listFiles, { signal: lifecycle.signal });
  document.getElementById('btn-read').addEventListener('click', readFile, { signal: lifecycle.signal });
  document.getElementById('btn-write').addEventListener('click', writeFile, { signal: lifecycle.signal });

  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: light;
    --bg: oklch(97% 0 0);
    --fg: oklch(0% 0 0);
    --border: oklch(89.8% 0 0);
    --border-dark: oklch(84.5% 0 0);
    --hover: oklch(93.4% 0 0);
    --surface: oklch(100% 0 0);
  }
}

@layer base {
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    padding: 20px;
  }

  button {
    padding: 8px 16px;
    border: 1px solid var(--border-dark);
    border-radius: 6px;
    background: var(--surface);
    cursor: pointer;
    font-size: 13px;

    &:hover { background: var(--hover); }
    &:focus-visible { outline: 2px solid oklch(54.6% 0.12 244); outline-offset: 2px; }
  }
}

@layer components {
  .toolbar { margin-block-end: 16px; display: flex; gap: 8px; }

  #output {
    display: block;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    min-height: 200px;
    font-family: monospace;
    font-size: 13px;
    white-space: pre-wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  game: {
    name: 'Canvas Game',
    description: 'Game loop skeleton with canvas rendering',
    icon: makeTemplateIcon('game'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Canvas game')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main id="stage">
    <canvas id="canvas" width="800" height="600" aria-label="Game screen"></canvas>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// This game runs entirely in the browser and does not need platform APIs.

function main() {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 800;
  canvas.height = 600;

  const state = {
    player: { x: 400, y: 300, size: 20, speed: 240 }, // speed in px/sec, not px/frame
    keys: new Set(),
    score: 0,
  };

  const lifecycle = new AbortController();

  // Keys tracked lowercased so held-key movement doesn't silently break under
  // Caps Lock or Shift, where e.key would report 'A' instead of 'a'.
  window.addEventListener('keydown', (e) => state.keys.add(e.key.toLowerCase()), { signal: lifecycle.signal });
  window.addEventListener('keyup', (e) => state.keys.delete(e.key.toLowerCase()), { signal: lifecycle.signal });

  // Losing keyboard focus (alt-tab, devtools, etc.) without a matching keyup
  // would leave a key "stuck" down indefinitely.
  window.addEventListener('blur', () => state.keys.clear(), { signal: lifecycle.signal });

  function update(deltaSeconds) {
    const { player, keys } = state;
    const distance = player.speed * deltaSeconds;

    if (keys.has('arrowleft') || keys.has('a')) player.x -= distance;
    if (keys.has('arrowright') || keys.has('d')) player.x += distance;
    if (keys.has('arrowup') || keys.has('w')) player.y -= distance;
    if (keys.has('arrowdown') || keys.has('s')) player.y += distance;

    player.x = Math.max(player.size, Math.min(canvas.width - player.size, player.x));
    player.y = Math.max(player.size, Math.min(canvas.height - player.size, player.y));
  }

  function draw() {
    ctx.fillStyle = '#0e121c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(state.player.x, state.player.y, state.player.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e6edf3';
    ctx.font = '14px monospace';
    ctx.fillText('Score: ' + state.score, 16, 24);
  }

  let lastFrameTime = performance.now();
  let rafId = null;

  // requestAnimationFrame keeps looping even in a backgrounded tab on some
  // platforms, so document.hidden skips the (pointless) draw call there.
  // Movement still runs on real elapsed time via deltaSeconds, capped at
  // 100ms so a paused/backgrounded tab doesn't jump the player on resume.
  function loop(now) {
    const deltaSeconds = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;

    update(deltaSeconds);
    if (!document.hidden) draw();
    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);

  // Cancel the loop and drop all listeners when the page is torn down —
  // otherwise the rAF chain keeps running against a detached canvas.
  window.addEventListener('pagehide', () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    lifecycle.abort();
  }, { once: true });
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(0% 0 0);
  }
}

@layer base {
  body {
    background: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
  }
}

@layer components {
  canvas { display: block; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  dashboard: {
    name: 'Dashboard',
    description: 'Data widget grid with live update pattern',
    icon: makeTemplateIcon('dashboard'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Dashboard')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <header>
      <h1>${escapeHtml(m.name)}</h1>
      <span id="last-updated" aria-live="polite"></span>
    </header>
    <section class="grid" aria-label="Metrics">
      <article class="card" id="card-1"><div class="label">Metric A</div><div class="value" id="val-1">—</div></article>
      <article class="card" id="card-2"><div class="label">Metric B</div><div class="value" id="val-2">—</div></article>
      <article class="card" id="card-3"><div class="label">Metric C</div><div class="value" id="val-3">—</div></article>
      <article class="card wide">
        <div class="label">Activity</div>
        <canvas id="chart" width="600" height="120" aria-label="Activity over time"></canvas>
      </article>
    </section>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// nova:ready is automatic; no handshake needed.

function main() {
  const HISTORY_LENGTH = 30;
  const POLL_INTERVAL_MS = 5000;
  const history = [];

  // Replace this with a real data source (fetch, websocket, etc.)
  function fetchData() {
    return {
      a: Math.floor(Math.random() * 1000),
      b: (Math.random() * 100).toFixed(1) + '%',
      c: Math.floor(Math.random() * 50),
    };
  }

  const chart = document.getElementById('chart');
  const chartCtx = chart.getContext('2d');
  const lifecycle = new AbortController();

  function drawChart() {
    const { width, height } = chart;
    chartCtx.clearRect(0, 0, width, height);
    if (history.length < 2) return;

    const max = Math.max(...history, 1);
    const stepX = width / (HISTORY_LENGTH - 1);

    chartCtx.strokeStyle = '#22c55e';
    chartCtx.lineWidth = 2;
    chartCtx.beginPath();
    history.forEach((value, i) => {
      const x = i * stepX;
      const y = height - (value / max) * (height - 8) - 4;
      if (i === 0) chartCtx.moveTo(x, y);
      else chartCtx.lineTo(x, y);
    });
    chartCtx.stroke();
  }

  function update() {
    const data = fetchData();
    document.getElementById('val-1').textContent = data.a;
    document.getElementById('val-2').textContent = data.b;
    document.getElementById('val-3').textContent = data.c;
    document.getElementById('last-updated').textContent =
      'Updated ' + new Date().toLocaleTimeString();

    history.push(data.a);
    if (history.length > HISTORY_LENGTH) history.shift();
    drawChart();
  }

  let pollTimer = null;

  function startPolling() {
    if (pollTimer === null) {
      pollTimer = setInterval(update, POLL_INTERVAL_MS);
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  update();
  startPolling();

  // Pause polling in a hidden tab so a background tab isn't burning cycles
  // (and "Updated ..." timestamps) for a screen nobody's looking at, and
  // catch up with an immediate refresh when it becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      update();
      startPolling();
    }
  }, { signal: lifecycle.signal });

  // Tear down the timer and listener when the page is closed.
  window.addEventListener('pagehide', () => {
    stopPolling();
    lifecycle.abort();
  }, { once: true });
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --fg-muted: oklch(66.2% 0.018 251);
    --card-bg: oklch(24.9% 0.041 271);
    --border: oklch(100% 0 0 / 0.08);
    --accent: oklch(72.3% 0.192 150);
  }
}

@layer base {
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    padding: 20px;
  }

  h1 { font-size: 18px; font-weight: 600; text-wrap: balance; }
}

@layer components {
  .app > header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-block-end: 20px;
  }

  #last-updated { font-size: 12px; color: var(--fg-muted); }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
  }

  .card.wide { grid-column: 1 / -1; }

  .label {
    font-size: 12px;
    color: var(--fg-muted);
    margin-block-end: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .value { font-size: 32px; font-weight: 700; color: var(--accent); }

  #chart { display: block; width: 100%; height: 120px; margin-block-start: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  form: {
    name: 'Data Entry Form',
    description: "Structured form that saves entries to NovaByte's virtual filesystem",
    icon: makeTemplateIcon('form'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Data entry form')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="wrap">
    <h1>${escapeHtml(m.name)}</h1>
    <form id="entry-form" autocomplete="on" novalidate>
      <p class="field">
        <label for="f-title">Title</label>
        <input id="f-title" name="title" type="text" autocomplete="off" required
               aria-required="true" aria-describedby="form-status">
      </p>
      <p class="field">
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" name="notes" rows="4"></textarea>
      </p>
      <button type="submit">Save Entry</button>
    </form>
    <div id="form-status" role="status" aria-live="polite"></div>
    <ul id="entries" aria-label="Saved entries"></ul>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// The runtime handshake is automatic; app-owned data uses the v2 filesystem facade.

function main() {
  const STORE_PATH = 'files/entries.json';
  const lifecycle = new AbortController();

  function setStatus(message, isError) {
    const el = document.getElementById('form-status');
    el.textContent = message;
    el.className = isError ? 'error' : '';
  }

  async function loadEntries() {
    let file;
    try {
      file = await window.novaOS.fs.appdata.read(STORE_PATH);
    } catch (error) {
      if (error.code === 'NOT_FOUND') return [];
      throw error;
    }
    const parsed = JSON.parse(file.data);
    if (!Array.isArray(parsed)) throw new Error('Saved entries must be a JSON array.');
    return parsed.filter((entry) => entry && typeof entry.title === 'string');
  }

  function renderEntries(entries) {
    const list = document.getElementById('entries');
    list.replaceChildren();
    for (const entry of entries) {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const notes = document.createElement('span');
      notes.textContent = entry.notes ? ' — ' + entry.notes : '';
      li.append(title, notes);
      list.append(li);
    }
  }

  async function init() {
    try {
      renderEntries(await loadEntries());
    } catch (error) {
      setStatus('Could not load entries: ' + error.message, true);
    }
  }

  const form = document.getElementById('entry-form');
  const submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('f-title').value.trim();
    const notes = document.getElementById('f-notes').value.trim();
    if (!title) return;

    // Disabling the button rules out a double-submit from this tab racing
    // itself. It does NOT protect against another tab or process writing to
    // STORE_PATH between the read below and the write — this starter is for
    // one app window and does not implement a cross-window file lock.
    submitButton.disabled = true;
    try {
      const entries = await loadEntries();
      entries.push({ title, notes, createdAt: new Date().toISOString() });

      await window.novaOS.fs.appdata.write(STORE_PATH, JSON.stringify(entries, null, 2));

      setStatus('Saved.');
      document.getElementById('f-title').value = '';
      document.getElementById('f-notes').value = '';
      renderEntries(entries);
    } catch (err) {
      setStatus('Save failed: ' + err.message, true);
    } finally {
      submitButton.disabled = false;
    }
  }, { signal: lifecycle.signal });

  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });

  init();
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --fg-muted: oklch(66.2% 0.018 251);
    --card-bg: oklch(24.9% 0.041 271);
    --border: oklch(100% 0 0 / 0.08);
    --accent: oklch(72.3% 0.192 150);
    --accent-fg: oklch(22.1% 0.048 152);
    --danger: oklch(63.7% 0.208 25);
    --focus-ring: oklch(72.3% 0.192 150);
  }
}

@layer base {
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    padding: 24px;
  }

  h1 { font-size: 20px; margin-block-end: 16px; text-wrap: balance; }

  input, textarea {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    padding: 8px 10px;
    font-size: 14px;
    font-family: inherit;
    resize: vertical;

    &:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
  }

  button {
    align-self: flex-start;
    background: var(--accent);
    color: var(--accent-fg);
    border: none;
    border-radius: 6px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;

    &:hover { opacity: 0.9; }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    &:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  }
}

@layer components {
  .wrap { max-width: 480px; margin: 0 auto; }

  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-block-end: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: var(--fg-muted);
  }

  #form-status {
    font-size: 12px;
    color: var(--accent);
    min-height: 16px;
    margin-block-end: 12px;
  }
  #form-status.error { color: var(--danger); }

  #entries {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;

    & li {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
    }
    & span { color: var(--fg-muted); }
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  'markdown-viewer': {
    name: 'Markdown Viewer',
    description: 'Live markdown preview using a bundled vendor library',
    icon: makeTemplateIcon('markdown-viewer'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Markdown viewer')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="split">
    <textarea id="source" placeholder="Type markdown here..." aria-label="Markdown source">## ${escapeHtml(m.name)}

Start typing **markdown** on the left to see it rendered on the right.

- supports lists
- supports \`code\`
- supports [links](https://example.com)</textarea>
    <div id="preview" aria-label="Rendered preview" aria-live="polite"></div>
  </main>
  <script src="vendor/markdown-it.min.js" defer></script>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// This viewer runs entirely in the browser and does not need platform APIs.

function main() {
  const source = document.getElementById('source');
  const preview = document.getElementById('preview');
  const lifecycle = new AbortController();

  // Markdown output is untrusted even with raw HTML disabled. Sanitize the
  // rendered HTML before adding it to the preview.
  //
  // This rebuilds the output in a new fragment instead of pruning the parsed
  // tree in place. Parsing via template.innerHTML and then unwrapping nodes
  // afterward is the mutation-XSS pattern: an <svg> or <math> wrapper
  // (neither in ALLOWED_TAGS, so it used to get unwrapped) switches the
  // parser into foreign-content mode, and re-attaching its children to an
  // HTML parent afterward can turn inert-looking markup into something that
  // executes. Copying only text nodes and allowed elements into a fresh
  // fragment means a rejected element's subtree is read for its text and
  // discarded — never re-parented into HTML context at all.
  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'HR',
  ]);

  // Anchor hrefs only. Bare "//host" is protocol-relative and inherits
  // whatever scheme the page loaded under, which isn't guaranteed safe here,
  // so it's rejected rather than assumed http/https. Resolving through the
  // URL parser instead of a regex on the raw string checks the scheme the
  // browser will actually navigate to, not just a substring match — closes
  // the gap where a value reads as "starts with https:" to a regex but
  // decodes to something else by the time the browser acts on it.
  const SAFE_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

  function isSafeHref(value) {
    if (value.startsWith('#')) return true;
    try {
      return SAFE_HREF_PROTOCOLS.has(new URL(value, document.baseURI).protocol);
    } catch {
      return false;
    }
  }

  function sanitize(html) {
    const parsed = document.createElement('template');
    parsed.innerHTML = html;

    const clean = document.createDocumentFragment();

    function copyChildren(sourceParent, destParent) {
      for (const child of sourceParent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          destParent.appendChild(child.cloneNode());
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;

        // SCRIPT and STYLE hold source code, not prose — skip entirely
        // rather than falling through to the text-only branch below, which
        // would print that code as visible text.
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;

        if (ALLOWED_TAGS.has(child.tagName)) {
          const el = document.createElement(child.tagName);
          if (child.tagName === 'A') {
            const href = child.getAttribute('href');
            if (href && isSafeHref(href)) el.setAttribute('href', href);
          }
          destParent.appendChild(el);
          copyChildren(child, el);
        } else {
          // Not an allowed element (includes <svg>, <math>, and anything
          // else outside ALLOWED_TAGS): keep the text inside it, drop the
          // element. Recursing straight into destParent — no wrapper of any
          // kind — means this subtree is never attached to the output tree
          // as an element, so there's nothing left for the parser to
          // reinterpret.
          copyChildren(child, destParent);
        }
      }
    }

    copyChildren(parsed.content, clean);
    return clean;
  }

  const md = typeof window.markdownit === 'function'
    ? window.markdownit({ html: false, linkify: false, typographer: false })
    : null;

  function render() {
    if (!md) {
      preview.textContent = 'vendor/markdown-it.min.js not found — drop the library file into vendor/ to enable rendering.';
      return;
    }
    preview.replaceChildren(sanitize(md.render(source.value)));
  }

  source.addEventListener('input', render, { signal: lifecycle.signal });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });

  render();
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --panel-bg: oklch(20.1% 0.025 267 / 0.5);
    --border: oklch(100% 0 0 / 0.08);
    --code-bg: oklch(24.9% 0.041 271);
    --accent: oklch(72.3% 0.192 150);
  }
}

@layer base {
  html, body { height: 100%; }
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
}

@layer components {
  .split {
    display: flex;
    height: 100dvh;
  }

  #source, #preview {
    flex: 1;
    height: 100%;
    padding: 20px;
    overflow-y: auto;
    box-sizing: border-box;
  }

  #source {
    background: var(--bg);
    color: var(--fg);
    border: none;
    border-inline-end: 1px solid var(--border);
    resize: none;
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 14px;
    line-height: 1.6;

    &:focus-visible { outline: none; }
  }

  #preview {
    background: var(--panel-bg);
    line-height: 1.6;

    & h1, & h2, & h3 { margin-block: 16px 8px; }
    & p { margin-block-end: 10px; }
    & code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }
    & a { color: var(--accent); }
    & ul, & ol { margin: 0 0 10px 20px; }
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  chat: {
    name: 'Chat UI',
    description: 'Message list with input — client-side state, no permissions needed',
    icon: makeTemplateIcon('chat'),
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Chat UI')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="chat">
    <div id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
    <form id="composer" role="search">
      <label for="msg-input" class="sr-only">Message</label>
      <input id="msg-input" name="message" type="text"
             placeholder="Type a message..." autocomplete="off">
      <button type="submit">Send</button>
    </form>
  </main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// This chat demo runs entirely in the browser and does not need platform APIs.

function main() {
  const state = {
    messages: [
      { from: 'them', text: 'Welcome to ${escapeJsString(m.name)}!' },
    ],
  };

  const messagesEl = document.getElementById('messages');
  const lifecycle = new AbortController();
  let echoTimer = null;

  function renderMessages() {
    messagesEl.replaceChildren();
    for (const msg of state.messages) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (msg.from === 'me' ? 'me' : 'them');
      bubble.textContent = msg.text;
      messagesEl.append(bubble);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  document.getElementById('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;

    state.messages.push({ from: 'me', text });
    input.value = '';
    renderMessages();

    // Replace this with a real response source (fetch, websocket, etc.)
    // Clearing any pending echo first means rapid-fire sends produce one
    // reply per message instead of stacking up timers that all fire late.
    clearTimeout(echoTimer);
    echoTimer = setTimeout(() => {
      state.messages.push({ from: 'them', text: 'Echo: ' + text });
      renderMessages();
    }, 400);
  }, { signal: lifecycle.signal });

  window.addEventListener('pagehide', () => {
    clearTimeout(echoTimer);
    lifecycle.abort();
  }, { once: true });

  renderMessages();
}
main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --bubble-them: oklch(24.9% 0.041 271);
    --accent: oklch(72.3% 0.192 150);
    --accent-fg: oklch(22.1% 0.048 152);
    --border: oklch(100% 0 0 / 0.08);
    --input-bg: oklch(24.9% 0.041 271);
  }
}

@layer base {
  html, body { height: 100%; }
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
}

@layer components {
  .chat {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .bubble {
    max-width: 70%;
    padding: 8px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.4;
  }
  .bubble.them {
    background: var(--bubble-them);
    align-self: flex-start;
    border-block-end-left-radius: 4px;
  }
  .bubble.me {
    background: var(--accent);
    color: var(--accent-fg);
    align-self: flex-end;
    border-block-end-right-radius: 4px;
  }

  #composer {
    display: flex;
    gap: 8px;
    padding: 12px;
    border-block-start: 1px solid var(--border);
  }

  #msg-input {
    flex: 1;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--fg);
    padding: 10px 16px;
    font-size: 14px;

    &:focus-visible {
      outline: none;
      border-color: var(--accent);
    }
  }

  #composer button {
    background: var(--accent);
    color: var(--accent-fg);
    border: none;
    border-radius: 20px;
    padding: 10px 20px;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;

    &:hover { opacity: 0.9; }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },

  browser: {
    name: 'Browser',
    description: 'URL bar with back, forward, and reload — a real navigable browser view',
    icon: makeTemplateIcon('browser'),
    permissions: ['net:external', 'sandbox:nested-webview'],
    permissionReasons: {
      'net:external': 'Loads websites that the user enters in the browser address bar.',
      'sandbox:nested-webview': 'Displays websites inside the app browser view.',
    },
    files: {
      'index.html': (m) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="${escapeHtml(m.description || 'Browser')}">
  <title>${escapeHtml(m.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <form id="toolbar" aria-label="Navigation">
    <button id="back" type="button" title="Back" aria-label="Back" disabled>←</button>
    <button id="forward" type="button" title="Forward" aria-label="Forward" disabled>→</button>
    <button id="reload" type="button" title="Reload" aria-label="Reload" disabled>⟳</button>
    <label for="address" class="sr-only">Address or search</label>
    <input id="address" name="address" type="text"
           placeholder="Enter a URL or search"
           autocomplete="url" spellcheck="false">
    <button id="go" type="submit">Go</button>
  </form>
  <div id="browser-status" role="status" aria-live="polite"></div>
  <main id="browser-viewport"></main>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// Uses Nova's host-managed BrowserView API.

const HOME = 'https://example.com';
const STORAGE_KEY = 'browser-last-url';
let browserView = null;

function addressToUrl(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^https?:\\/\\//i.test(input)) return input;
  if (/^[\\w-]+(\\.[\\w-]+)+(\\/.*)?$/.test(input) && !input.includes(' ')) {
    return 'https://' + input;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

async function requireBrowserApi() {
  let browser = window.nova?.browser;
  if (typeof browser?.createView === 'function') return browser;
  if (typeof window.novaOS?.permissions?.request === 'function') {
    const granted = await window.novaOS.permissions.request(
      'sandbox:nested-webview',
      'This app needs an embedded browser view to display websites.'
    );
    if (!granted) throw new Error('Browser access was not granted.');
    browser = window.nova?.browser;
  }
  if (typeof browser?.createView !== 'function') {
    throw new Error('The Nova browser API is unavailable. Grant sandbox:nested-webview and restart the app.');
  }
  return browser;
}

async function readLastUrl() {
  try {
    const value = await window.novaOS.storage.get(STORAGE_KEY);
    const saved = value ? JSON.parse(value) : null;
    if (saved && typeof saved.url === 'string') {
      const parsed = new URL(saved.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    }
  } catch (error) {
    console.warn('Could not restore the last browser URL:', error);
  }
  return HOME;
}

async function saveLastUrl(url) {
  if (!url) return;
  try {
    await window.novaOS.storage.set(STORAGE_KEY, JSON.stringify({ url }));
  } catch (error) {
    console.warn('Could not save the last browser URL:', error);
  }
}

function main() {
  const els = {
    back: document.getElementById('back'),
    forward: document.getElementById('forward'),
    reload: document.getElementById('reload'),
    address: document.getElementById('address'),
    form: document.getElementById('toolbar'),
    status: document.getElementById('browser-status'),
    viewport: document.getElementById('browser-viewport'),
  };
  const lifecycle = new AbortController();

  function setStatus(message) {
    els.status.textContent = message || '';
  }

  function updateState(state) {
    if (state.url && document.activeElement !== els.address) els.address.value = state.url;
    els.back.disabled = !state.canGoBack;
    els.forward.disabled = !state.canGoForward;
    els.reload.disabled = !state.url;
    if (state.url) void saveLastUrl(state.url);
  }

  async function runAction(action) {
    if (!browserView) {
      setStatus('Browser is still starting.');
      return;
    }
    try {
      await action();
    } catch (error) {
      setStatus(error.message || 'Browser action failed');
      console.error('Browser action failed:', error);
    }
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = addressToUrl(els.address.value);
    if (!url) {
      setStatus('Enter a URL or search term.');
      return;
    }
    void runAction(() => browserView.navigate(url));
    els.address.blur();
  }, { signal: lifecycle.signal });

  els.back.addEventListener('click', () => void runAction(() => browserView.back()), { signal: lifecycle.signal });
  els.forward.addEventListener('click', () => void runAction(() => browserView.forward()), { signal: lifecycle.signal });
  els.reload.addEventListener('click', () => void runAction(() => browserView.reload()), { signal: lifecycle.signal });

  window.addEventListener('pagehide', () => {
    lifecycle.abort();
    browserView?.destroy();
  }, { once: true });

  void (async () => {
    try {
      setStatus('Starting browser…');
      const initialUrl = await readLastUrl();
      const browser = await requireBrowserApi();
      browserView = await browser.createView({
        container: els.viewport,
        url: initialUrl,
        pollingInterval: 1000,
      });
      if (lifecycle.signal.aborted) {
        browserView.destroy();
        browserView = null;
        return;
      }
      browserView.addEventListener('url-change', (event) => {
        const url = event.detail?.url;
        if (typeof url !== 'string') return;
        if (document.activeElement !== els.address) els.address.value = url;
        void saveLastUrl(url);
      });
      browserView.addEventListener('title-change', (event) => {
        document.title = event.detail?.title || ${JSON.stringify(m.name)};
      });
      browserView.addEventListener('navigation-start', () => setStatus('Loading…'));
      browserView.addEventListener('navigation-complete', () => setStatus(''));
      browserView.addEventListener('navigation-error', (event) => {
        setStatus(event.detail?.errorDescription || event.detail?.reason || 'Navigation failed');
      });
      browserView.addEventListener('state-change', (event) => updateState(event.detail || {}));
      browserView.addEventListener('state-error', (event) => {
        const error = event.detail?.error || 'Unknown state error';
        setStatus('Could not refresh browser state: ' + error);
        console.error('Could not refresh browser state:', error);
      });
      browserView.addEventListener('new-window', (event) => {
        setStatus('Popup blocked: ' + (event.detail?.url || 'unknown URL'));
      });
      browserView.addEventListener('download-request', async (event) => {
        try {
          const result = await browser.download({
            url: event.detail?.url,
            filename: 'download',
          });
          if (!result.cancelled) setStatus('Download saved.');
        } catch (error) {
          setStatus('Download failed: ' + error.message);
          console.error('Download failed:', error);
        }
      });
      updateState(await browserView.getState());
    } catch (error) {
      browserView?.destroy();
      browserView = null;
      setStatus('Could not start browser: ' + error.message);
      console.error('Could not start browser:', error);
    }
  })();
}

main();`,

      'style.css': () => `@layer reset, tokens, base, components;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
}

@layer tokens {
  :root {
    color-scheme: dark;
    --bg: oklch(18.3% 0.022 267.4);
    --fg: oklch(94.3% 0.011 244);
    --fg-muted: oklch(66.2% 0.018 251);
    --toolbar-bg: oklch(20.1% 0.025 267 / 0.5);
    --surface: oklch(24.9% 0.041 271);
    --surface-hover: oklch(30% 0.041 271);
    --border: oklch(100% 0 0 / 0.08);
    --border-faint: oklch(100% 0 0 / 0.04);
    --accent: oklch(72.3% 0.192 150);
    --accent-fg: oklch(22.1% 0.048 152);
    --danger: oklch(71.1% 0.166 22);
    --content-bg: oklch(100% 0 0);
    --content-fg: oklch(18.3% 0.022 267.4);
  }
}

@layer base {
  html, body { height: 100%; }
  body {
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  button {
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;

    &:not(:disabled):hover { background: var(--surface-hover); }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  }
}

@layer components {
  #toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--toolbar-bg);
    border-block-end: 1px solid var(--border);

    & button {
      width: 32px;
      height: 32px;

      &:disabled { opacity: 0.35; cursor: default; }
    }
  }

  #toolbar #go {
    width: auto;
    min-width: 56px;
    height: 32px;
    padding: 0 18px;
    margin-inline-start: 4px;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    flex-shrink: 0;
    text-align: center;

    &:hover { opacity: 0.9; }
  }

  #address {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    padding: 0 12px;
    height: 32px;
    font-size: 13px;
    font-family: monospace;

    &:focus-visible {
      outline: none;
      border-color: var(--accent);
    }
  }

  #browser-status {
    padding: 4px 14px;
    font-size: 11px;
    color: var(--fg-muted);
    font-family: monospace;
    min-height: 20px;
    border-block-end: 1px solid var(--border-faint);

    &.error { color: var(--danger); }
  }

  #browser-viewport {
    height: 600px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--content-bg);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`,
    },
  },
  ...API_STARTER_TEMPLATES,
});

// Windows reserves these names (case-insensitively, with or without an
// extension) at the filesystem level — CON, PRN, AUX, NUL, COM1-9, LPT1-9.
// Every template here writes plain, hardcoded filenames (index.html, app.js,
// style.css) so this can't actually trigger today, but if a future template's
// filename ever comes from manifest data instead of a literal, this guard is
// the difference between "rejected with a clear error" and "silently fails
// to create a file on any Windows host."
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

// Confines a filename to a single path segment inside targetDir. Rejects
// anything containing a path separator, a leading dot-dot, or a null byte —
// the standard building blocks of a traversal attempt (../../etc/passwd,
// or an absolute path that would make path.join ignore targetDir entirely).
function isSafeFilename(filename) {
  if (typeof filename !== 'string' || filename === '') return false;
  if (filename.includes('\0')) return false;
  if (filename !== path.normalize(filename)) return false;
  if (path.isAbsolute(filename)) return false;
  if (filename.split(/[/\\]/).includes('..')) return false;
  const base = filename.split(/[/\\]/).pop();
  if (WINDOWS_RESERVED_NAMES.test(base)) return false;
  return true;
}

// Same idea for targetDir itself: it has to resolve to somewhere inside
// appsRoot. Without this, a targetDir of "../../../etc" would happily pass
// fs.mkdirSync/writeFileSync and scaffold an app's files outside the intended
// apps directory entirely.
//
// path.relative() alone isn't quite enough on Windows: across two different
// drive letters (C:\\apps vs D:\\apps) it returns the target path unchanged —
// no leading '..', and not flagged absolute either, since it's relative to
// nothing in particular. That slips past the startsWith('..')/isAbsolute
// checks below. The prefix check on resolvedTarget catches that case too,
// since a cross-drive path will never actually start with resolvedRoot.
function isSafeTargetDir(targetDir, appsRoot) {
  const resolvedRoot = path.resolve(appsRoot);
  const resolvedTarget = path.resolve(targetDir);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const withinRoot = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return withinRoot && resolvedTarget.startsWith(rootWithSep);
}

/**
 * Create a new app from a template.
 *
 * @param {object} opts
 * @param {string} opts.targetDir - Directory to create the app in. Must resolve inside appsRoot.
 * @param {string} [opts.template] - Template key (defaults to 'blank').
 * @param {object} opts.manifest - Manifest values to interpolate.
 * @param {string} [opts.appsRoot] - Root directory targetDir must stay within (defaults to targetDir's parent).
 * @returns {{ success: boolean, files: string[], error?: string }}
 */
function create({ targetDir, template = 'blank', manifest, appsRoot } = {}) {
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return { success: false, error: 'targetDir is required' };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { success: false, error: 'manifest is required and must be a plain object' };
  }

  // Prevent prototype pollution or looking up built-in object properties.
  if (!Object.prototype.hasOwnProperty.call(TEMPLATES, template)) {
    return { success: false, error: `Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}` };
  }

  const tpl = TEMPLATES[template];

  // Default appsRoot to targetDir's parent when the caller doesn't supply one,
  // so single-level "create this one app here" calls still work without every
  // caller having to pass appsRoot explicitly. Callers that want real
  // traversal protection across a shared apps directory should pass appsRoot
  // themselves.
  const effectiveAppsRoot = appsRoot ?? path.dirname(path.resolve(targetDir));
  if (!isSafeTargetDir(targetDir, effectiveAppsRoot)) {
    return { success: false, error: `targetDir must resolve inside "${effectiveAppsRoot}"` };
  }

  const created = [];

  // If we fail partway through, remove exactly the files this call created —
  // not anything that already existed in targetDir before we started, and not
  // the whole directory if the caller is scaffolding into a pre-existing folder.
  const rollback = () => {
    for (const file of created) {
      try {
        fs.rmSync(path.join(targetDir, file), { force: true });
      } catch {
        // Best-effort cleanup; a failure here shouldn't mask the original error.
      }
    }
  };

  try {
    // mkdirSync with recursive:true is a no-op if the directory already
    // exists, so the existsSync check would be a redundant TOCTOU race.
    fs.mkdirSync(targetDir, { recursive: true });

    const manifestObj = {
      id: manifest.id || 'com.example.myapp',
      name: manifest.name || 'My App',
      version: manifest.version || '1.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      entry: 'index.html',
      icon: tpl.icon || 'box',
      permissions: [...(tpl.permissions || [])],
      ...(tpl.optionalPermissions?.length ? { optionalPermissions: [...tpl.optionalPermissions] } : {}),
      permissionReasons: { ...(tpl.permissionReasons || {}) },
    };

    // Store the sanitized site URL in the manifest as well as the generated
    // wrapper code, so it remains available to tools that inspect the app.
    if (template === 'webapp') {
      manifestObj.url = sanitizeUrl(manifest.url) || 'https://example.com';
      manifestObj.allowNestedWebview = true;
    }

    // Browser views require both the nested-view and external-network grants.
    // These declarations request the grants; they do not auto-approve them.
    if (template === 'browser') {
      manifestObj.allowNestedWebview = true;
    }
    if (tpl.shareTarget) {
      manifestObj.shareTarget = { ...tpl.shareTarget };
    }

    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifestObj, null, 2));
    created.push('manifest.json');

    for (const [filename, contentFn] of Object.entries(tpl.files)) {
      if (!isSafeFilename(filename)) {
        throw new Error(`Refusing to write unsafe filename "${filename}"`);
      }
      const content = typeof contentFn === 'function' ? contentFn(manifest) : contentFn;

      const filePath = path.join(targetDir, filename);
      // Ensure sub-directory layout exists for templates whose filenames
      // are nested (future-proofing — current templates are all flat).
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      created.push(filename);
    }

    // vendor/ holds bundled third-party libraries the user drops in
    // themselves (e.g. vendor/markdown-it.min.js for the markdown-viewer template).
    // Files placed here are base64-encoded and included in the package
    // automatically at build time — reference them in HTML as
    // <script src="vendor/library.min.js">. Don't put node_modules here;
    // copy only the built/minified file you need.
    const vendorDir = path.join(targetDir, 'vendor');
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(
      path.join(vendorDir, 'README.md'),
      [
        '# vendor/',
        '',
        'Place third-party libraries here as single JS (or CSS) files.',
        'They are bundled automatically when you build — no CDN needed.',
        '',
        'Example:',
        '  vendor/markdown-it.min.js',
        '  vendor/chart.min.js',
        '',
        'Then reference them in your HTML:',
        '  <script src="vendor/markdown-it.min.js" defer></script>',
        '',
        'Do not put node_modules here — copy only the built/minified file you need.',
      ].join('\n'),
    );
    created.push('vendor/README.md');

    return { success: true, files: created };
  } catch (err) {
    rollback();
    return { success: false, error: err.message };
  }
}

module.exports = { TEMPLATES, create };