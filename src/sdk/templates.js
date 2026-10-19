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
// window.nova is ready — the nova:ready handshake runs before this script,
// so no setup call is needed for the IPC bridge itself.
//
// Module (from module.js, the emcc-generated glue for module.cpp) is a
// MODULARIZE factory function, not a pre-built object -- builder.js's
// compileCppSources() passes -s MODULARIZE=1 -s EXPORT_NAME=Module to emcc,
// so calling Module() returns a Promise that resolves once the .wasm has
// actually loaded. Setting Module.onRuntimeInitialized on the factory does
// nothing, since nothing ever calls the factory to instantiate it.
window.nova.ipc('nova:ready', {}).then((result) => {
  console.log('Permissions granted:', result.permissions);
});

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
HTML/CSS/JS. UI, layout, and IPC calls to window.nova stay in JS -- only
compute-heavy logic belongs in module.cpp. See the "Games and rendering"
note below before assuming C++ will make everything faster.

## Requirements

Building this project requires Emscripten (\`emcc\`) on your PATH. Studio
does not bundle or install a compiler -- if \`emcc\` isn't found, Build will
fail with install instructions rather than silently skip module.cpp.

Install it yourself first:
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
    icon: '⬜',
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
// window.nova is ready — the nova:ready handshake runs before this script,
// so no setup call is needed.
window.nova.ipc('nova:ready', {}).then((result) => {
  console.log('Permissions granted:', result.permissions);
});`,

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
    icon: '🌐',
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
  if (typeof window.nova?.requestPermission === 'function') {
    const result = await window.nova.requestPermission(
      'sandbox:nested-webview',
      'This app needs an embedded browser view to display the configured website.'
    );
    if (!result?.granted) throw new Error('Browser access was not granted.');
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
    description: "File-access tool using NovaByte's virtual filesystem",
    icon: '🔧',
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

  // This app's own scratch file. vfs:write (and read-back of anything it
  // wrote) only ever succeeds under /data/ — a write anywhere
  // else fails with PERMISSION_DENIED even with the vfs:write grant held.
  // vfs:read alone can still see the shared tree; it's only write/rename/
  // move/delete that are scoped this tightly.
  const APP_FILE_PATH = '/data/files/example.txt';

  // ipc() rejects on error rather than resolving with {error}, so this adapts
  // it to the {error, result} shape the callers below expect — meaning they
  // never need their own try/catch.
  async function send(type, payload) {
    try {
      const result = await window.nova.ipc(type, payload);
      return { result };
    } catch (err) {
      return { error: { code: err.code, message: err.message } };
    }
  }

  function log(message) {
    document.getElementById('output').textContent = message;
  }

  async function listFiles() {
    const res = await send('nova:vfs:list', { path: '/' });
    log(res.error ? res.error.message : JSON.stringify(res.result, null, 2));
  }

  async function readFile() {
    const res = await send('nova:vfs:read', { path: APP_FILE_PATH });
    // The file's content comes back on 'data', not 'content'.
    log(res.error ? res.error.message : (res.result?.data ?? '(empty)'));
  }

  async function writeFile() {
    const res = await send('nova:vfs:write', {
      path: APP_FILE_PATH,
      content: 'Hello from ${escapeJsString(m.name)}',
    });
    log(res.error ? res.error.message : 'Saved!');
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
    icon: '🎮',
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
// window.nova is available immediately — nova:ready is automatic.

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
    icon: '📊',
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
    icon: '📝',
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
// The nova:ready handshake is automatic — no setup call needed.

function main() {
  // vfs:write only ever succeeds under /data/ — a write
  // anywhere else fails with PERMISSION_DENIED regardless of the vfs:write
  // grant, so the store has to live inside this app's own data folder.
  const STORE_PATH = '/data/files/entries.json';
  const lifecycle = new AbortController();

  // ipc() rejects on error rather than resolving with {error}, so this adapts
  // it to the {error, result} shape the rest of this file expects.
  async function send(type, payload) {
    try {
      const result = await window.nova.ipc(type, payload);
      return { result };
    } catch (err) {
      return { error: { code: err.code, message: err.message } };
    }
  }

  function setStatus(message, isError) {
    const el = document.getElementById('form-status');
    el.textContent = message;
    el.className = isError ? 'error' : '';
  }

  async function loadEntries() {
    const res = await send('nova:vfs:read', { path: STORE_PATH });
    if (res.error) return [];
    try {
      // File content comes back on 'data', not 'content'.
      const parsed = JSON.parse(res.result.data);
      if (!Array.isArray(parsed)) return [];
      // Guard against a hand-edited or older-schema store file — an entry
      // missing a string title would otherwise render as blank/"undefined".
      return parsed.filter((entry) => entry && typeof entry.title === 'string');
    } catch {
      return [];
    }
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
    renderEntries(await loadEntries());
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
    // STORE_PATH between the read below and the write — the vfs bridge has
    // no atomic append, so a true multi-writer race would still need a lock
    // or a server-side merge. Fine for a single-tab tool; worth knowing if
    // this store path ever gets shared.
    submitButton.disabled = true;
    try {
      const entries = await loadEntries();
      entries.push({ title, notes, createdAt: new Date().toISOString() });

      const res = await send('nova:vfs:write', {
        path: STORE_PATH,
        content: JSON.stringify(entries, null, 2),
      });

      if (res.error) {
        setStatus('Save failed: ' + res.error.message, true);
        return;
      }

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
    icon: '📄',
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
  <script src="vendor/marked.min.js" defer></script>
  <script src="app.js" defer></script>
</body>
</html>`,

      'app.js': (m) => `// ${escapeJsString(m.name)}
// window.nova is available immediately; nova:ready fires automatically.

function main() {
  const source = document.getElementById('source');
  const preview = document.getElementById('preview');
  const lifecycle = new AbortController();

  // marked converts markdown to HTML but does not sanitize it — markdown
  // allows raw HTML passthrough by default, so unescaped input (or a
  // malicious link/image) becomes live markup the moment it hits innerHTML.
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

  function render() {
    if (typeof marked === 'undefined') {
      preview.textContent = 'vendor/marked.min.js not found — drop the real library file into vendor/ to enable rendering.';
      return;
    }
    preview.replaceChildren(sanitize(marked.parse(source.value)));
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
    icon: '💬',
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
// window.nova is available immediately; nova:ready is automatic.

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
    icon: '🧭',
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
// Uses Nova's host-managed BrowserView API for isolated site rendering.

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
  if (typeof window.nova?.requestPermission === 'function') {
    const result = await window.nova.requestPermission(
      'sandbox:nested-webview',
      'This app needs an embedded browser view to display websites.'
    );
    if (!result?.granted) throw new Error('Browser access was not granted.');
    browser = window.nova?.browser;
  }
  if (typeof browser?.createView !== 'function') {
    throw new Error('The Nova browser API is unavailable. Grant sandbox:nested-webview and restart the app.');
  }
  return browser;
}

async function readLastUrl() {
  try {
    const result = await window.nova.ipc('nova:storage:get', { key: STORAGE_KEY });
    const saved = result && result.value ? JSON.parse(result.value) : null;
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
    await window.nova.ipc('nova:storage:set', {
      key: STORAGE_KEY,
      value: JSON.stringify({ url }),
    });
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
      icon: 'box',
      permissions: [],
    };

    // Store the sanitized site URL in the manifest as well as the generated
    // wrapper code, so it remains available to tools that inspect the app.
    if (template === 'webapp') {
      manifestObj.url = sanitizeUrl(manifest.url) || 'https://example.com';
      manifestObj.permissions = ['net:external', 'sandbox:nested-webview'];
      manifestObj.allowNestedWebview = true;
    }

    // Browser views require both the nested-view and external-network grants.
    // These declarations request the grants; they do not auto-approve them.
    if (template === 'browser') {
      manifestObj.permissions = ['net:external', 'sandbox:nested-webview'];
      manifestObj.allowNestedWebview = true;
    }

    // Both templates' app.js call nova:vfs:read/write against files in this
    // app's private /data/files/ folder. Without declaring these here, calls would still
    // compile and run, but every one of them would reject with
    // PERMISSION_DENIED on a fresh install, since permissions.md is explicit
    // that only entries in `permissions` go through the launch-time consent
    // queue — a template that never asks for the grant can never get it.
    if (template === 'form' || template === 'utility') {
      manifestObj.permissions = ['vfs:read', 'vfs:write'];
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
    // themselves (e.g. vendor/marked.min.js for the markdown-viewer template).
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
        '  vendor/marked.min.js',
        '  vendor/chart.min.js',
        '',
        'Then reference them in your HTML:',
        '  <script src="vendor/marked.min.js" defer></script>',
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