# `.novaapp` App Development Guide

This guide documents the app package format and the APIs available to apps running on NovaByte OS and compatible NBOSP systems. Studio setup, templates, and Studio builds are covered in the [NovaByte Studio README](./README.md).

## Manifest Format

Every app needs a `manifest.json` at the root of its directory.

### Minimal manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "entry": "index.html"
}
```

### Full manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "description": "A short description",
  "author": "Your Name",
  "email": "you@example.com",
  "website": "https://example.com",
  "entry": "index.html",
  "icon": "box",
  "type": "blank",
  "permissions": ["vfs:read"],
  "optionalPermissions": ["device:notifications"],
  "defaultSize": [800, 560],
  "minSize": [400, 300],
  "maxSize": [1600, 1200],
  "resizable": true,
  "frame": true,
  "categories": ["utilities"],
  "handles": {
    "protocols": [],
    "extensions": [".mp3", ".flac"]
  }
}
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique app ID — reverse domain format |
| `name` | string | Display name shown in the OS |
| `version` | string | Semantic version `x.y.z` |
| `entry` | string | Main HTML file to load |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | Short description |
| `author` | string | — | Your name |
| `email` | string | — | Contact email |
| `website` | string | — | Your site |
| `icon` | string | `"box"` | Icon Lucide name, data URI, or URL |
| `type` | string | `"blank"` | App type |
| `unrestrictedEntry` | string | — | Packaged JavaScript entry for trusted system packages or apps granted `system:root` |
| `permissions` | array | `[]` | Required capabilities; missing sensitive grants are requested at launch, but denial does not block the app |
| `optionalPermissions` | array | `[]` | Optional permissions — app must handle denial gracefully |
| `defaultSize` | array | `[800, 560]` | `[width, height]` in pixels |
| `minSize` | array | `[400, 300]` | Minimum window size |
| `maxSize` | array | — | Maximum window size |
| `resizable` | boolean | `true` | Whether the window can be resized |
| `frame` | boolean | `true` | Whether the window has a title bar |
| `transparent` | boolean | `false` | Enables an alpha-capable sandboxed app surface |
| `categories` | array | `[]` | App categories for filtering |
| `handles` | object | — | Declares file extensions, URL protocols, and/or MIME types your app can open — see [Default Apps](#default-apps) below |

Set `transparent` to `true` when the app should let the desktop show through areas not painted by its UI. The OS makes the sandboxed webview alpha-capable and makes the document's `html` and `body` backgrounds transparent; it does not force child elements to be transparent, so your app can still paint opaque panels, cards, and controls. This is a visual setting only: it does not grant host-page access, bypass the app sandbox, or make the package trusted or system-signed.

### Root access (high risk)

Third-party `.novaapp` packages can request host-page execution with a required `system:root` permission and a packaged JavaScript entry:

```json
{
  "entry": "index.html",
  "permissions": ["system:root"],
  "unrestrictedEntry": "root.js"
}
```

`unrestrictedEntry` must name a `.js` file included in the package. That file is the **complete app entry** for root execution: it should register the app with `registerApp(...)` and render its window from the registered `init()` function, like a trusted built-in app. It can be named `app.js` instead of `root.js` if that is the app's single host-side implementation.

Root-approved apps do not run two copies of the app. When Developer Mode and Root Access are enabled and the user grants `system:root`, the OS loads only `unrestrictedEntry` directly into the OS page; the manifest's ordinary HTML `entry` and its scripts are not also loaded. If root is unavailable or not granted, the ordinary HTML `entry` runs in the app's sandbox instead. The two launch modes are alternatives, not communicating processes, so there is no app.js-to-root.js IPC bridge. Move the UI and behavior needed in root mode into the unrestricted entry; it can use host APIs directly.

Users must enable Developer Mode, turn on Root Access in Settings, and explicitly approve the app through the conspicuous root permission prompt. Root grants do not expire automatically; revoke them explicitly in Settings. Root code runs in the OS page rather than an isolated app webview and can read or modify OS data and UI. Settings provides per-app grants and a persistent log of up to 1,000 recent observed OS API calls. The log is best-effort: direct JavaScript and browser activity is not completely observable, and a root app can potentially tamper with same-origin data. Disabling Developer Mode, Root Access, or an app's root grant closes root app windows and reloads the OS page if root code has run.

### App ID format

Use reverse domain name notation. Studio's manifest validation enforces this at Build time.

```
✅  com.example.myapp
✅  io.github.username.app
✅  webapp_uniqueid          ← web app shortcut IDs use this prefix instead
❌  MyApp                    ← no uppercase
❌  myapp                    ← needs at least one dot
```

---

### Default Apps

Declaring a `handles` block makes your app selectable in **Settings → Default Apps** and in the desktop file context menu's **Open with...** chooser for matching file types, alongside the OS's own built-in apps (Browser, TextEdit, Music, Gallery, Email, Calendar). Apps may also declare the `home` role to be offered as a Home app:

```json
{
  "handles": {
    "extensions": [".webp"],
    "mimeTypes": ["image/heic"],
    "roles": ["home"]
  }
}
```

`protocols`, `extensions`, `mimeTypes`, and `roles` are optional independently — declare whichever applies, or omit `handles` entirely if your app doesn't want to be a default-openable target at all. `roles` currently supports `home`. Declaring it only makes the app eligible; the user must explicitly choose it in Settings. A selected third-party Home app is hosted in a full-screen sandboxed surface, not an OS application window, and does not receive host-page access. Home selection takes effect after the OS page reloads. Extensions are matched case-insensitively and should include the leading dot (`.mp3`, not `mp3`); protocols and MIME types are matched case-insensitively. MIME parameters are ignored, and subtype wildcards such as `image/*` are supported.

This is purely a **discovery/selection** declaration, not a permission — it doesn't grant ambient access to files, and there's no `handles:*` permission string to request. When the user chooses your app through **Open with...**, the launch receives a `fileIntent` object in `window.__NOVA_APP_OPTIONS__` and the host grants that sandbox access to only that selected file. The scoped grant permits reading and writing that file through `nova:vfs:read` / `nova:vfs:write` by file id, without granting directory listing, access to other files, or broad `vfs:read` / `vfs:write` permission. A user can choose **Always use this app for this file type**; that preference is checked against the app's current declaration and installed status when the file is opened.

A sandboxed file manager can show the same OS chooser for a file the app can access by calling `window.nova.openWith(fileId)`, for example from its own right-click menu:

```javascript
fileMenuItems.push({
  label: 'Open with…',
  action: async () => {
    const result = await window.nova.openWith(file.id);
    if (result.cancelled) return;
    if (!result.success) console.error('The selected app could not be opened');
  }
});
```

The host checks the file is within the calling app's accessible VFS scope before displaying the chooser. The app is not allowed to pass a path or file contents to this API. It resolves to `{ cancelled: true }` if the user dismisses the chooser (or there is no compatible installed app), or `{ cancelled: false, success, appId, windowId, defaultSaved }` after a choice. This API displays a chooser each time; it does not silently launch a remembered default.

```javascript
const intent = window.__NOVA_APP_OPTIONS__?.fileIntent;
if (intent?.action === 'open') {
  const file = await window.nova.ipc('nova:vfs:read', { id: intent.file.id });
  // `file.data` is the selected file's content.
  // Saving this same file is scoped to this launch:
  await window.nova.ipc('nova:vfs:write', {
    id: intent.file.id,
    content: 'Updated content'
  });
}
```

Files opened without a matching `handles` declaration do not receive this scoped file grant. The OS checks the declaration again when launching, so a stale choice or a file type the app no longer declares cannot be used to acquire access.

`handles` isn't part of `RESERVED_APP_IDS`-gated behavior — any installed `.novaapp`, including unsigned/Unverified ones, is eligible to appear in the chooser for any extension/protocol it declares. The OS doesn't currently restrict which apps can claim which types (e.g. a third-party app may declare `extensions: [".html"]` alongside the built-in Browser). A user choice in **Open with...** applies once unless they select **Always use this app**; declaring `handles` never changes a default on its own.

---

## Build process

When you hit Build in Studio, here's what happens under the hood:

- Reads and validates `manifest.json` (or `novaapp.json` — both accepted)
- Validates the app ID format and all declared permissions against the known permission list
- If the project has a C/C++ source file (e.g. `module.cpp`, from the `native-cpp` template), compiles it with `emcc` first — output is `module.js` (glue) + `module.wasm`, bundled like any other project file. The Build button turns purple when C/C++ sources are detected. This step requires `emcc` on your PATH; see Prerequisites.
- Reads every file in the project directory and Base64-encodes it
- Generates a SHA-256 signature over the manifest + files payload
- Writes `<app.id>.novaapp` to your chosen output directory

### Headless system services

NovaByte's built-in headless services are first-party `.novaapp` packages whose `service.js` runs in the OS page, preserving the global APIs and startup ordering used by their former standalone scripts. Their manifests use `system: true`, `systemService: true`, and `unrestrictedEntry: "service.js"`. They do not have a window or an HTML entry at runtime.

Only IDs in `js/apps/novaapp-manifest.json` can pass the trusted system-package gate. Startup order is declared in `js/apps/system-service-manifest.json`; the loader checks package integrity and allowlist membership before executing each entry. If a service is missing or fails verification/startup, NovaByte logs the failure, skips that service, continues loading the rest, and starts the OS with a dismissible degraded-services warning. These packages execute with OS-page access and must remain first-party code. Framework/bootstrap pieces such as `boot.js`, `kernel.js`, `app-registry.js`, and trust/security initialization remain ordinary scripts because they are prerequisites for safely loading packages.

Rebuild the built-in services after changing their source with:

```sh
node build-apps.mjs js/apps background-apps calendar-notifier default-apps event-log notifications registry scanner server-events-bridge system-dialogs system-events
```

`npm start` and `npm run dev` build the NovaApp packages automatically. To skip that build and use the packages already on disk, set `NBOSP_SKIP_APP_BUILD=1` before starting. In PowerShell:

```powershell
$env:NBOSP_SKIP_APP_BUILD = '1'
npm start
```

Remove the variable from the current shell with `Remove-Item Env:\NBOSP_SKIP_APP_BUILD` when you want the automatic build again.

---

## App Runtime

When a `.novaapp` is installed and launched, here's what actually happens:

### Install

The App Manager reads the file, validates the manifest fields (`id`, `name`, `version` are required), checks the signature (prompts the user if it fails rather than blocking outright), and saves the app data to `localStorage` under `nova_installed_apps`. It also calls `registerNovaApp()` which registers the app with the OS app registry so it appears in the launcher.

In **App Manager → Packages**, user-facing system apps remain visible in the package list. Developer tools, the built-in launcher, and headless system services are hidden by default; enable **Show hidden apps** to inspect them. The launcher and headless services cannot be opened from App Manager, and headless services are managed by NovaByte rather than launched, disabled, or uninstalled individually.

### Launch — permission gate

Declaring a permission explains what your app may request; it does not grant access by itself. Low-risk permissions—including public internet, public WebSockets, clipboard writing, notifications, and metadata—are auto-granted unless the user previously denied them. The broad `vfs:access` grant remains high-risk because it can edit shared files; use it when building a file editor or file manager. Missing required medium-or-higher permissions use the consent queue; denying one never blocks app launch, and only that capability fails when called. Optional sensitive permissions are not prompted at launch: request them with `window.nova.requestPermission(...)` when the related feature is used.

This follows the Android distinction between ordinary install-time capabilities and sensitive access: public internet is available to apps that declare it, while internal-network access, personal data, broad shared-file editing, sensors, and powerful sandbox capabilities remain explicit. Auto-grant is based on the OS risk catalogue—not on an app's `required` label—and a previous denial is never silently replaced.

Design your app so each sensitive feature is independently optional. Explain the reason at the moment of use, request the permission then, and offer a useful fallback if it is denied.

### Launch — sandbox

Third-party apps run inside an NW.js `<webview>` element, not an iframe — a separate renderer process, not a same-document sandbox. There is no `window.parent`/`contentWindow` reference between the guest and the host (a `<webview>` guest's `window.parent` is just itself), so the two sides can't reach each other via ordinary DOM references or `postMessage`. Communication with the OS happens exclusively through `window.nova`, described below.

`allow-same-origin` is **not** granted to third-party apps by default — only to an audited allowlist of first-party system apps (exempted by app id, not by holding any permission). Granting it to a third-party app gives its guest content access to cookies/localStorage/sessionStorage on the shared origin, which widens the impact of any XSS inside that app. If your app genuinely needs it, **both** of these must be true, or `sanitizeSandboxAttr()` strips it and your webview runs without it:

1. Your manifest declares `sandbox: { allowSameOrigin: true }`, **and**
2. The user has granted the `sandbox:same-origin` permission (declare it in `permissions` so it's requested at launch — see [Permissions](#permissions)).

Declaring the manifest flag without the permission (or vice versa) still gets you a sandbox with no `allow-same-origin`. This is `high` risk — expect it to draw extra scrutiny before your app is verified.

**Without this permission, raw browser storage in your app's own sandbox does not survive relaunch.** `allow-same-origin` isn't just about *access* while your app is running — a guest page can always call `localStorage.setItem()`/set cookies regardless of this permission, since the sandbox attribute doesn't disable those APIs. What the permission actually controls is whether that data is kept on the next launch: when your app's window closes, the OS clears its app-sandbox storage partition unless it holds a live `sandbox:same-origin` grant at that moment. So without the permission, any raw `localStorage`/cookie values your app writes are wiped as soon as it closes — they'll be gone on the next open, even though reads/writes work fine within a single session. This applies every time the app is fully closed (not backgrounded via `stayAliveInBackground()`), so a revoked grant takes effect the next time the app closes, not immediately. This is separate from nested browser views, which use their own persistent web-content partition.

If your app just needs data to survive across launches — settings, save state, caches — and doesn't need real same-origin semantics (postMessage origin-matching, sharing cookies with the host), don't request `sandbox:same-origin` for this. Use [`nova:storage:*`](#storage-novastorage) instead: it's durable by default, requires no permission, and isn't affected by this at all.

**Nested browser views:** creating an in-app browser view is gated separately and blocked by default. The supported Nova browser API is documented in [Building browser apps](#building-browser-apps). Legacy `<webview>` creation is proxied for compatibility; the host creates a sibling web-content view rather than a native child webview inside the app renderer. Both of these gates are required:

1. Your manifest declares `"allowNestedWebview": true` (a top-level manifest field, not nested under `sandbox`), **and**
2. The user has granted the `sandbox:nested-webview` permission (declare it in `permissions` so it's requested at launch — see [Permissions](#permissions)).

Declaring only one still blocks access. This is a critical permission because browser views expose live third-party web content and navigation; host-side network permissions continue to apply inside them.

The old advice to delay the first navigation by one second is obsolete. The current host-mediated implementation creates the web-content view outside the app renderer. Prefer `window.nova.browser.createView()`: it waits for host-side view creation before starting the first navigation and gives your app a stable Nova API.

### Building browser apps

Use the Nova browser API for an in-app browser. It creates a host-managed browser view and exposes Nova event names and Promise-based operations; app code does not need `BrowserWindow`, `webContents`, `ipcRenderer`, `require('electron')`, or direct access to `OS`. The older nested `<webview>` proxy remains available for compatibility, but new browser apps should prefer `window.nova.browser`.

#### 1. Declare browser permissions

Nested browser content is a powerful capability. Both the manifest opt-in and user grant are required:

```json
{
  "id": "com.example.browser",
  "name": "Example Browser",
  "version": "1.0.0",
  "entry": "index.html",
  "allowNestedWebview": true,
  "permissions": [
    "sandbox:nested-webview",
    "net:external"
  ]
}
```

`sandbox:nested-webview` allows the app to create a browser view. `net:external` allows it to navigate to public HTTP(S) sites and download external content. Declared public internet and WebSocket permissions are auto-granted unless previously denied. Internal NovaByte services and private-network destinations still require `net:internal`; `net:external` cannot reach them. If the nested-webview grant is absent, `window.nova.browser` is not available.

#### 2. Add the browser viewport and controls

Keep the viewport in a container with a definite height. The host-managed view fills the container:

```html
<form id="address-form">
  <button id="back" type="button" aria-label="Back">Back</button>
  <button id="forward" type="button" aria-label="Forward">Forward</button>
  <button id="reload" type="button">Reload</button>
  <input id="address" type="text" autocomplete="url" aria-label="Address or search">
  <button type="submit">Go</button>
</form>
<div id="browser-viewport" style="height: 600px"></div>
<p id="browser-status" role="status"></p>
<script src="app.js" defer></script>
```

The host enforces deferred execution for packaged external scripts even if `defer` is omitted. Keeping the attribute is useful when testing the page outside NovaByte OS.

#### 3. Create a view and connect navigation

`createView()` resolves to a `BrowserView`. It installs its event listeners before it starts the initial navigation. A URL passed to the app through `nova:open-url` takes precedence over the optional initial `url`, so links opened by the OS do not get replaced by the browser's home page.

```javascript
const HOME = 'https://example.com';
let browserView;

function addressToUrl(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(input) && !input.includes(' ')) {
    return 'https://' + input;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

async function main() {
  const address = document.getElementById('address');
  const status = document.getElementById('browser-status');
  const viewport = document.getElementById('browser-viewport');

  browserView = await window.nova.browser.createView({
    container: viewport,
    url: HOME,
    pollingInterval: 1000
  });

  browserView.addEventListener('url-change', event => {
    if (document.activeElement !== address) address.value = event.detail.url;
  });
  browserView.addEventListener('title-change', event => {
    document.title = event.detail.title || 'Browser';
  });
  browserView.addEventListener('navigation-start', () => {
    status.textContent = 'Loading…';
  });
  browserView.addEventListener('navigation-complete', () => {
    status.textContent = '';
  });
  browserView.addEventListener('navigation-error', event => {
    status.textContent = event.detail.errorDescription || event.detail.reason || 'Navigation failed';
  });
  browserView.addEventListener('state-change', event => {
    document.getElementById('back').disabled = !event.detail.canGoBack;
    document.getElementById('forward').disabled = !event.detail.canGoForward;
  });

  document.getElementById('address-form').addEventListener('submit', async event => {
    event.preventDefault();
    const url = addressToUrl(address.value);
    if (url) await browserView.navigate(url);
    address.blur();
  });
  document.getElementById('back').addEventListener('click', () => browserView.back());
  document.getElementById('forward').addEventListener('click', () => browserView.forward());
  document.getElementById('reload').addEventListener('click', () => browserView.reload());
}

main();
```

Navigation and download calls return Promises. Handle rejected Promises in UI actions so permission denials and host errors are visible; don’t silently treat them as successful loads.

#### Browser API reference

```javascript
const view = await window.nova.browser.createView({
  container,          // required DOM Element
  url: 'https://…',   // optional; a pending OS open-url target takes precedence
  pollingInterval: 1000 // optional: 0 disables polling; otherwise 250–10000 ms
});
```

`BrowserView` exposes:

| Member | Behavior |
|--------|----------|
| `element` | The host-managed view element. Prefer the methods below instead of relying on implementation-specific element APIs. |
| `url`, `title`, `loading` | Latest known state. URL and title are also refreshed by polling, which catches client-side history changes. |
| `canGoBack`, `canGoForward` | Latest history availability (`null` until state is first queried). |
| `getState()` | Promise for `{ url, title, loading, canGoBack, canGoForward }`. |
| `navigate(url)` | Navigate to a URL; the host enforces network permissions. |
| `back()`, `forward()`, `reload()`, `stop()` | Browser navigation controls. |
| `find(query, options)` | Search page text; resolves with the find result, including match count and active match. Options: `backward`, `matchCase`, `wordStart`, `medialCapitalAsWordStart`. |
| `stopFinding(action)` | End page search; `action` is `clear`, `keep`, or `activate` (defaults to `clear`). |
| `setZoom(factor)` | Set page zoom from `0.25` through `5`. |
| `setZoomMode(mode)` | Set `per-view`, `per-origin`, or `automatic` zoom behavior. |
| `setUserAgent(userAgent)` | Override the view's user-agent string (maximum 512 characters). |
| `clearData(types)` | Clear selected site-data categories for this app's browser partition (for example `['cookies', 'cache', 'localStorage', 'indexedDB']`). |
| `executeScript(code)` | Execute JavaScript in the loaded site and resolve with its result. Treat page script execution as privileged; it runs with that site's access. |
| `on(type, listener)` | Listen for an event and receive an unsubscribe function. `addEventListener` / `removeEventListener` are also supported. |
| `destroy()` | Stop polling and remove the view. Call this when permanently discarding a view. |

Nova events use `CustomEvent`; read event-specific information from `event.detail`.

| Event | Detail |
|-------|--------|
| `navigation-start` | Top-level navigation started. |
| `navigation-redirect` | Navigation redirect details. |
| `navigation-commit` | Top-level committed URL and navigation details. |
| `navigation-complete` | Current state after the page load completes. |
| `navigation-error` | `{ url, reason, errorCode, errorDescription, isTopLevel }`. |
| `url-change` | `{ url, previousUrl }`, including in-page URL changes discovered by polling. |
| `title-change` | `{ title, previousTitle }`. |
| `state-change` | Current URL/title/loading/history state. |
| `state-error` | `{ error }` when the host cannot refresh browser state. |
| `new-window` | `{ url, disposition, width, height, window }`; decide whether to block, open a tab, or display a popup. |
| `download-request` | `{ url }` when page content requests a download. |
| `close`, `crash`, `destroy` | View lifecycle notifications. |

#### Downloads and popups

Page-initiated downloads are denied by default at the native webview boundary. Handle `download-request` and use Nova's save-dialog-backed download method instead of granting a website filesystem access:

```javascript
browserView.addEventListener('download-request', async event => {
  try {
    const result = await window.nova.browser.download({
      url: event.detail.url,
      filename: 'download'
    });
    if (result.cancelled) return;
  } catch (error) {
    console.error('Download failed:', error);
  }
});
```

`download({ url, filename })` fetches through the app's permission-checked network bridge, then asks the user where to save the file. The current limit is 100 MB and the payload is buffered in memory; this is not a resumable/background download manager.

For `new-window`, create a view in your tab or popup container, then attach the pending popup to preserve the opener relationship:

```javascript
browserView.addEventListener('new-window', async event => {
  const popupView = await window.nova.browser.createView({ container: popupViewport });
  await event.detail.window.attach(popupView);
  if (event.detail.url) await popupView.navigate(event.detail.url);
});
```

Always provide a user-visible way to close popup views and call `destroy()` when a tab or popup is removed.

#### Browser-app recommendations and boundaries

- Store bookmarks, history, preferences, and tab metadata with [`nova:storage:*`](#storage-novastorage); don’t expose the host `OS` object to app code.
- The OS gives each app a persistent browser-content partition. Cookies and site storage are isolated from the app's own storage and other apps. The current public API does not let an app select arbitrary partitions or implement a private/incognito profile.
- `canGoBack` and `canGoForward` reflect URL history observed by the view, including changes found by polling. Use them to update toolbar state, but keep browser history UI in your app if it needs durable history across app launches.
- Keep browser controls in the app's trusted UI, validate/normalize address-bar input, and never treat arbitrary user text as an executable URL scheme. Only HTTP(S) navigation is supported for nested browser views.
- Treat `executeScript()` as a powerful escape into the current site's page context. Use it only for explicit features and never interpolate untrusted strings into the script source.
- A browser app is responsible for tabs, history/bookmarks UI, downloads UI, popup policy, and user-facing error pages. The API does not provide Chrome extensions, browser-engine internals, certificate-warning bypass, per-site permission prompts, download progress/resume, or profile management.
- Use [`window.nova.openUrl(url)`](#ipc-api-windownova) to hand a link to the OS-selected browser app rather than opening the system's external desktop browser.

### Launch — window.nova bridge

Before your app's HTML executes, the runtime injects `window.nova` into the guest's page. You don't need to request it, import it, or wait for a handshake — it's there as soon as your script runs:

```javascript
window.nova.ipc(type, payload)        // → Promise, resolves with `result`, rejects with {code, message}
window.nova.requestPermission(...)    // convenience wrapper around nova:request-permission
window.nova.onEvent(eventName, cb)    // subscribe to pushed events (see Event bus below)
```

The `nova:ready` handshake (app metadata + granted permissions) now fires automatically on load — you don't need to send it yourself. If you want the result (e.g. to check what was actually granted), call it directly and use the response:

```javascript
const info = await window.nova.ipc('nova:ready', {});
console.log(info.permissions, info.optionalPermissions);
```

`window.fetch` and `XMLHttpRequest` inside your app are also transparently routed through this bridge — plain `fetch(url, opts)` calls work as expected and don't need to be rewritten to use `nova.ipc` directly, as long as the relevant `net:*` permission is granted.

There is no `window.__novaPrivateStore` — for isolated, namespaced storage, use `nova:storage:*` (see [Storage](#storage-novastorage) below), which is backed by the host, not raw `localStorage` inside the guest. Host-backed storage is always durable across launches regardless of permissions — raw `localStorage`/cookies inside the guest are not (see [Launch — sandbox](#launch--sandbox)).

---

## Permissions

Permissions are declared in `manifest.json` and checked before the app loads. Low-risk permissions are auto-granted unless previously denied; required medium-or-higher permissions are requested at launch, while optional sensitive permissions are requested when needed. Denying a permission does not block app launch. Grants persist across sessions via HMAC-signed localStorage entries. Unused app grants expire after 30 days of inactivity.

### Full permission list

40 permissions across 9 categories. This mirrors `app-permission-manager.js` exactly — if you're hand-writing a manifest, these are the only strings `validateManifest` recognizes without a warning. (`data:export`/`data:backup`, previously listed here, don't exist as real permissions — they were dead metadata with no backing handler and have been removed from the OS entirely; the export feature in Settings isn't permission-gated.)

All three Sandbox permissions (`sandbox:nested-webview`, `sandbox:same-origin`, `sandbox:escape-popups`) work differently from every other permission in this table: the permission grant alone does nothing. Each also requires a matching manifest flag — `allowNestedWebview`, `sandbox.allowSameOrigin`, and `allowPopupsToEscapeSandbox` respectively — and both the grant and the flag must be present or the underlying sandbox attribute is never added. See each row's description below for the exact manifest key.

`clipboard:read`/`clipboard:write` are distinct: reading clipboard contents remains high-risk, while writing is low-risk and auto-granted when declared. Existing apps with `vfs:read` retain the old clipboard fallback for compatibility; new manifests should request the clipboard permission they actually need.

`vfs:metadata` is worth calling out specifically: it existed in the permission registry from the start, but the handler behind it (`nova:vfs:stat`) checked `vfs:read` instead — declaring `vfs:metadata` alone in a manifest silently did nothing. That's now fixed; `vfs:metadata` genuinely gates `nova:vfs:stat` on its own (an app with `vfs:read` still works too, since full read is a superset of metadata-only access).

`system:background`, `system:background:live`, and `system:autostart` are three deliberately separate grants for background execution, not one permission in disguise — see [Background execution](#background-execution--novabackground) below for how they differ and how to use each.

| Permission | Category | Risk | Useful for |
|------------|----------|------|------------|
| `vfs:access` | Filesystem | High | Reading and editing user files throughout the shared NovaByte VFS; one grant covers read/write |
| `vfs:read` | Filesystem | Medium | Reading shared VFS files and your own app data |
| `vfs:write` | Filesystem | High | Writing only to your own app data |
| `vfs:delete` | Filesystem | Critical | Deleting shared files and your own app data |
| `vfs:metadata` | Filesystem | Low | Listing/sizing files without reading contents |
| `net:internal` | Network | High | Calling this OS's own API/server endpoints — also reaches private-network and cloud metadata addresses (169.254.169.254), not just same-origin |
| `net:external` | Network | Low | Calling public internet services (declare in the manifest; auto-granted unless previously denied) |
| `net:websocket` | Network | Low | Public WebSocket connections (declare in the manifest; auto-granted unless previously denied) |
| `mail:read` | Email | High | Inbox viewers, search, unread-count widgets |
| `mail:write` | Email | Critical | Mark-as-read/move tools, compose-preview UIs |
| `mail:send` | Email | Critical | Send-on-your-behalf tools (needs its own SMTP config UI — see below) |
| `mail:delete` | Email | Critical | Cleanup/triage tools (spam pruning, bulk delete) |
| `calendar:read` | Calendar | Medium | Agenda widgets, scheduling assistants |
| `calendar:write` | Calendar | High | Event creation, meeting schedulers |
| `calendar:delete` | Calendar | High | Calendar cleanup/sync tools |
| `contacts:read` | Contacts | Medium | Address-book pickers, CRM-style lookups |
| `contacts:write` | Contacts | High | Contact import/sync tools |
| `contacts:delete` | Contacts | High | Dedup/cleanup tools |
| `device:notifications` | Device | Low | Alerts, reminders, background-task completion pings |
| `device:geolocation` | Device | High | Maps, weather, location-tagged content |
| `device:camera` | Device | Critical | Photo capture, video chat, QR/barcode scanning |
| `device:microphone` | Device | Critical | Voice recording, voice chat, dictation |
| `clipboard:read` | Clipboard | High | Paste-in tools, import-from-clipboard features — can expose whatever any other app or the user copied, not just your own app's data |
| `clipboard:write` | Clipboard | Low | Copy-to-clipboard features (auto-granted when declared; does not allow reading clipboard contents) |
| `system:info` | System | Medium | Diagnostics, "about this device" panels — also gates reading settings values like `username`, `region`, `timezone`, and `devMode` |
| `system:settings` | System | Medium | Preference sync, theme/settings dashboards |
| `system:apps` | System | Medium | Launchers, app-store-style installers, dock/dashboard replacements |
| `system:app-launch` | System | Low | Launching an installed app without access to app inventory or management |
| `system:events` | System | Medium | Reacting to OS-level events (theme change, etc.) |
| `system:root` | System | Critical | Running the app's `unrestrictedEntry` as its complete host-page implementation instead of loading its HTML entry in the app sandbox; requires Developer Mode, Root Access, and a separate explicit confirmation |
| `system:background` | System | Medium | Periodic sync/checks while closed — reminders, cache refresh, polling (see below) |
| `system:background:live` | System | High | Staying alive after the window closes — timers, active transfers, live connections (see below) |
| `system:autostart` | System | High | Launching automatically at OS startup with no user action at all (see below) |
| `admin:apps` | Admin | High | Fleet/security audit tools — see actual grants per app, not just declared ones (needs admin mode, see below) |
| `admin:users` | Admin | Critical | Session monitors, force-logout tools (needs admin mode) |
| `admin:system` | Admin | Critical | Security-policy dashboards, lockout/IP-block tuning (needs admin mode) |
| `admin:audit` | Admin | High | Security/activity log viewers (needs admin mode) |
| `sandbox:nested-webview` | Sandbox | Critical | Apps that create their own `<webview>` for in-app browsing (browser-style apps). Also requires `"allowNestedWebview": true` in the manifest — the permission alone does nothing. |
| `sandbox:same-origin` | Sandbox | High | Apps that need a stable origin for cross-tab logic or an IPC bridge depending on `window.location.origin` matching, or that need `localStorage`/cookies to survive relaunch (see [Launch — sandbox](#launch--sandbox)). Also requires `"sandbox": { "allowSameOrigin": true }` in the manifest — the permission alone does nothing. |
| `sandbox:escape-popups` | Sandbox | High | Apps whose popups need to open as normal, unsandboxed browser windows (e.g. OAuth flows, external checkout). Also requires `"allowPopupsToEscapeSandbox": true` in the manifest — the permission alone does nothing. |

`admin:*` additionally requires the machine itself to be in admin mode — a separate, local-only toggle in Settings → Privacy & Security → Admin Access. Granting an app one of the four `admin:*` permissions doesn't put the machine in admin mode by itself; both gates have to pass, or the call is denied with a message telling you the machine isn't in admin mode. `mail:*` requires an email account to already be connected via the Email app — there's no way for a sandboxed app to supply its own account credentials; `mail:*` always acts on whatever account the user has connected, and calls fail with a clear error if nothing's connected.

### Required vs optional

```json
{
  "permissions": ["vfs:read", "net:internal"],
  "optionalPermissions": ["device:notifications"]
}
```

Required medium-or-higher-risk permissions are prompted for at launch, but a denial does not block the app from loading — check what was actually granted and degrade gracefully if a required capability is missing. Low-risk permissions are auto-granted regardless of whether they appear in `permissions` or `optionalPermissions`, unless the user previously denied them. Optional sensitive permissions are not prompted at launch; users can grant them manually from Settings → Apps, or your app can request one at runtime with `window.nova.requestPermission(...)` and handle denial gracefully.

### Requesting a permission at runtime

Use the `window.nova.requestPermission` convenience wrapper (or call `nova.ipc('nova:request-permission', ...)` directly — they're equivalent):

```javascript
const { granted } = await window.nova.requestPermission('vfs:write', 'Needed to save your documents.');
console.log(granted); // true or false
```

`permanent` defaults to `true` (grant persists) unless explicitly set to `false`. The convenience wrapper above doesn't expose it — if you need a one-time, non-persistent grant, call `nova.ipc` directly instead:

```javascript
const { granted } = await window.nova.ipc('nova:request-permission', {
  permission: 'vfs:write',
  reason: 'Needed to save your documents.',
  permanent: false,
});
```

#### Rate limiting

Every call to `requestPermission` shows a live dialog again, even if the permission was previously denied — there's no persisted-denial short-circuit. That re-prompt-every-time behavior means a buggy or malicious app calling `requestPermission()` in a loop could otherwise spam the user with dialogs indefinitely, so requests for the same `appId:permission` pair are rate-limited:

- Up to **3 prompts within a rolling 60-second window** are shown normally.
- The next request in that window is **auto-denied with no dialog shown at all** (`granted` resolves to `false` immediately) and a cooldown starts.
- The cooldown is **5 seconds base**, and **doubles for each consecutive denial** for that `appId:permission` pair, capped at **15 minutes**. A grant resets the denial streak back to zero.
- Rate-limited requests are logged to `EventLog` (category `permissions`, severity `warn`) so they're visible for debugging, even though nothing is shown to the user.

Your app can't tell the difference between "the user clicked deny" and "auto-denied by the rate limiter" just from `requestPermission`'s return value — both currently resolve `granted: false`.

If you need to check cooldown status without triggering a new prompt (e.g. to show your own "please wait" UI), use the `nova:permission-rate-limited` channel:

```javascript
const status = await window.nova.ipc('nova:permission-rate-limited', {
  permission: 'vfs:write',
});
// { limited: false }
// or, mid-cooldown: { limited: true, retryAfterMs: 4213 }
```

There's no `window.nova.*` convenience wrapper for this one — call `nova.ipc` directly as shown above.

Calling `resetPermission` clears both the grant and any rate-limit cooldown state for that `appId:permission` pair.

---

## Private Storage

There is no `window.__novaPrivateStore` object injected into your app. Isolated, per-app key-value storage is provided host-side via `nova:storage:*` over the `window.nova.ipc` bridge:

```javascript
await window.nova.ipc('nova:storage:set', { key: 'settings', value: JSON.stringify({ theme: 'dark' }) });
const { value } = await window.nova.ipc('nova:storage:get', { key: 'settings' });
await window.nova.ipc('nova:storage:delete', { key: 'settings' });
```

See [Storage — `nova:storage:*`](#storage-novastorage) below for the full reference. Keys are namespaced per app ID host-side — your app can never read or overwrite another app's data, and there's no separate namespacing scheme to remember on your end.

---

## IPC API — `window.nova`

Apps communicate with the OS via `window.nova.ipc(type, payload)`, injected automatically before your app's script runs — no import, no handshake required to start using it.

```javascript
try {
  const result = await window.nova.ipc('nova:<category>:<action>', {
    // ... payload fields
  });
  console.log(result);
} catch (err) {
  // err.code and err.message are set for IPC-level errors (see Error codes below)
  console.error(err.code, err.message);
}
```

### Handshake — `nova:ready`

This now fires automatically on load — you don't need to send it yourself. Call it directly if you want the response (your app's metadata and granted permissions):

```javascript
const info = await window.nova.ipc('nova:ready', {});
// {
//   success: true,
//   appId: 'com.example.myapp',
//   permissions: ['vfs:read', 'device:notifications'],
//   optionalPermissions: ['net:external'],
//   osVersion: '3.0.0',
//   securityPatch: '2026-05-01'
// }
```

### App lifecycle and launch intents — `window.nova.app`

`nova:open-url` and app launches carry options into the new app session. Use the app facade instead of reading host globals:

```javascript
const info = await window.nova.app.getInfo();
const options = await window.nova.app.getLaunchOptions();

const removeLaunchListener = window.nova.app.onLaunch(({ options, reason }) => {
  if (options.url) navigateTo(options.url);
  if (options.sharedText) showSharedText(options.sharedText);
});

const removeStateListener = window.nova.app.onStateChange(({ visible, focused }) => {
  // Pause animations or defer nonessential refresh work while not visible.
});
```

`onLaunch` reports this app window's initial options; it is not an app-to-app broadcast channel. `onStateChange` reports this document's visibility/focus and returns an unsubscribe function. These lifecycle signals do not grant background execution; background work still requires the relevant `system:background*` permission.

### Appearance — `window.nova.appearance`

Reading the small, non-sensitive appearance snapshot and subscribing to its changes require no permission. Apps can follow the OS theme, accent, high-contrast, reduced-motion, and transparent-surface preferences without broad `system:info` or `system:events` access:

```javascript
const current = await window.nova.appearance.get();
const unsubscribe = await window.nova.appearance.onChange(appearance => {
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.style.setProperty('--accent', appearance.accentColor || '');
  document.documentElement.classList.toggle('high-contrast', appearance.highContrast);
  document.documentElement.classList.toggle('reduce-motion', appearance.reduceMotion);
});
// later, when the view is disposed:
unsubscribe();
```

The API deliberately does not expose unrelated OS settings. `set` accepts only the supported appearance fields and validated values; it does not require broad `system:settings` access. `onChange` calls the callback immediately with the current snapshot, then when one of those appearance preferences changes.

```javascript
await window.nova.appearance.set({
  theme: 'nord',
  accentColor: '#5e81ac',
  highContrast: false,
  reduceMotion: true,
  transparentSurfaces: true
});
```

### User-mediated sharing — `window.nova.share`

Opening the OS share sheet itself needs no permission: the user chooses whether to copy content, open a link in the OS default browser, email it, or cancel. The app cannot silently write to the clipboard or launch a recipient through this chooser:

```javascript
const result = await window.nova.share({
  title: 'Share this page',
  text: 'Useful note',
  url: 'https://example.com/article'
});
if (result.cancelled) return;
```

Only credential-free HTTP(S) links are accepted. Text is limited to 4000 characters, and the chooser is rate-limited. The returned `action` identifies the user's choice.

### Picker-scoped files — `window.nova.files`

Use these methods when an app needs to import or export a document the user explicitly selects. They do not require broad `vfs:read` or `vfs:write`; the picker mediates access to one chosen VFS file or save destination. The picker can show shared user files and the calling app's own private data, never another app's private `/data/<app-id>/` folder. They do not provide unrestricted access to host disk or persistent file handles:

```javascript
const opened = await window.nova.files.open({
  title: 'Import notes',
  accept: ['text/plain', 'application/json']
});
if (!opened.cancelled) {
  console.log(opened.file.name, opened.file.content);
}

const saved = await window.nova.files.save({
  title: 'Export notes',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  content: 'Exported content'
});
if (!saved.cancelled) console.log('Saved:', saved.file.path);
```

Open/save calls return `{ cancelled: true }` when dismissed. The first version is text-only and capped at 10 MB. Use the existing `nova:vfs:*` APIs when your app needs ongoing access to its own VFS data; use `nova:files` for a user-selected import/export flow.

### Filesystem — `nova:vfs:*`

The broad `vfs:access` permission enables reading and editing the shared user-visible tree with one grant. Separate `vfs:read` and `vfs:write` permissions remain available for narrower access; `vfs:write` alone is limited to your app's private data. `vfs:delete` is still separate and required to delete files. This is **NovaByte's own OS-managed virtual filesystem** — the same data the built-in Files app shows (worker/IndexedDB-backed), never real Node `fs` or real host disk.

**Ownership scoping:** `vfs:read` and `vfs:access` can see shared files and your app's own `/data/<your-app-id>/` folder, but never another app's private `/data/<other-app-id>/` folder. `vfs:access` can create, edit, rename, move, and make folders in the shared tree as well as your app's own data. `vfs:write` without `vfs:access` remains limited to your app's private data. `vfs:delete` is separate, and apps cannot delete the filesystem root, `/data`, or the Trash folder. Deleting your app's private files keeps them private while they are in Trash; no grant gives access to another app's private data.

`<your-app-id>` above is filled in automatically by the host from whatever you pass — **you should never write your own literal app id into a path**. See [`/data/` path rewriting](#data-path-rewriting--read-this-before-you-build-anything) just below for the exact rules; getting this wrong is the single most common reason a fresh app's file tree looks empty, wrong, or throws `NOT_FOUND`.

```javascript
// Read a file (requires vfs:read or vfs:access)
const { content, size, modified } = await window.nova.ipc('nova:vfs:read', { path: '/docs/notes.txt' });

// List a folder's contents (requires vfs:read or vfs:access) — separate channel from read
const { files } = await window.nova.ipc('nova:vfs:list', { path: '/docs' });
// files: [{ id, name, type, mimeType, size, modified, created }, ...]

// Get metadata only, no file content (requires vfs:metadata — vfs:read or vfs:access also
// works, since full read is a superset of metadata-only access)
const { stat } = await window.nova.ipc('nova:vfs:stat', { path: '/docs/notes.txt' });
// stat: { id, name, type, mimeType, size, path, parentId, created, modified, accessed, tags }

// Write a shared file (requires vfs:access)
await window.nova.ipc('nova:vfs:write', { path: '/Documents/notes.txt', content: 'Hello' });

// Or use the narrower vfs:write grant to write only under your app's /data/
await window.nova.ipc('nova:vfs:write', { path: '/data/notes.txt', content: 'Hello' });

// Create a shared folder (requires vfs:access); 'path' is the parent folder.
await window.nova.ipc('nova:vfs:mkdir', { path: '/Documents/', name: 'exports' });

// Or create one under your app root with vfs:write; omit path for app root.
// NOTE: 'path' must include the trailing slash ('/data/', not '/data') — see
// the path-rewriting section right below for why this distinction matters.
await window.nova.ipc('nova:vfs:mkdir', { path: '/data/', name: 'exports' });

// Rename a shared file/folder (requires vfs:access)
await window.nova.ipc('nova:vfs:rename', { path: '/Documents/notes.txt', name: 'renamed.txt' });

// Rename a file/folder in your app data (requires vfs:write)
await window.nova.ipc('nova:vfs:rename', { path: '/data/notes.txt', name: 'renamed.txt' });

// Move a shared file/folder (requires vfs:access); source and destination
// must both be in the shared tree or your own app data.
await window.nova.ipc('nova:vfs:move', { path: '/Documents/notes.txt', destPath: '/Documents/exports/' });

// Delete a shared or app-owned file (requires vfs:delete)
await window.nova.ipc('nova:vfs:delete', { path: '/Documents/notes.txt' });

// Move a file/folder under your app data with vfs:write
await window.nova.ipc('nova:vfs:move', { path: '/data/notes.txt', destPath: '/data/exports/notes.txt' });

// Delete a file (requires vfs:delete)
await window.nova.ipc('nova:vfs:delete', { path: '/data/notes.txt' });
```

#### `/data/` path rewriting — read this before you build anything

**The most common first-app bug is a caller mistake, not a platform issue** — passing the wrong `/data/`-related path shape. The error messages you'll hit (`NOT_FOUND`, `PERMISSION_DENIED`) are the system correctly enforcing scoping; they just don't make *which path shape you got wrong* obvious. Every `/data/`-prefixed path you send is rewritten host-side before it's resolved:

> Any path starting with `/data/` (**the trailing slash matters**) has the segment immediately after `/data/` replaced with your own app id, unconditionally — regardless of what you put there.

That means:

| You send | Host resolves it as | Result |
|---|---|---|
| `/data/notes.txt` | `/data/<your-app-id>/notes.txt` | ✅ correct — this is the intended usage |
| `/data/<your-app-id>/notes.txt` | `/data/<your-app-id>/<your-app-id>/notes.txt` | ❌ double-nested. `NOT_FOUND` / "Parent folder not found" — **never include your own app id in the path**, the host adds it for you |
| `/data` *(no trailing slash)* | `/data` unchanged — rewrite doesn't fire | ⚠️ resolves to the shared data root. The host filters private app folders so you can only see your own `/data/<your-app-id>/` subtree. |
| `/data/` *(trailing slash, nothing else)* | `/data/<your-app-id>/` | ✅ correct — this is the right way to refer to your own app root as a whole, e.g. for `list` or as `mkdir`'s parent |

**Practical takeaways:**
- Treat `/data/` (with the trailing slash) as your app's root constant. Don't hardcode your own app id into any path — the host does that for you, and doing it yourself double-nests.
- If `list`/`write`/`mkdir` on what you thought was "my own root" is returning folders that aren't yours, you almost certainly sent bare `/data` without a trailing slash.
- If you get `NOT_FOUND: Parent folder not found` on a path you were sure existed, check whether you accidentally concatenated your own app id into a `/data/`-prefixed path — that's the #1 cause.
- A leading double-slash from concatenation (e.g. `'/data/' + '/foo.txt'` → `/data//foo.txt`) is harmless — empty path segments are skipped during resolution — but avoid it for readability.

#### Auto-created subfolders in your app root

The first time your app's `/data/<your-app-id>/` folder is set up, the host pre-populates it with four subfolders, before your code ever runs:

```
/data/<your-app-id>/
  files/          — general-purpose app files (suggested default for user content)
  cache/          — disposable/regenerable data
  databases/      — structured/serialized data (JSON, etc.)
  shared_prefs/   — simple key-value settings
```

This mirrors Android's internal-storage convention by name, but **nothing in the VFS enforces any behavioral difference between them** — they're plain folders with suggestive names, not special-cased storage tiers. Writing directly to your app root (e.g. `/data/notes.txt`) works exactly the same as writing into one of these subfolders; using them is a naming convention for your own organization, not a requirement.

**Why this matters for you:** if your app lists its own root right after install and expects an empty folder, you'll see these four folders already sitting there. That's expected — it isn't stray data left by a previous run, and you don't need to (and can't meaningfully) delete and recreate them. If you're building a file browser or similar UI, decide up front whether to show these to the user as-is or filter them out of the view — most simple content apps (a notes app, a text editor) will want to hide or ignore them rather than surface OS-internal scaffolding as if it were user-created content.

### Notifications — `nova:notifications:*`

```javascript
// Show a notification (requires device:notifications)
const res = await window.nova.ipc('nova:notifications:show', {
  title: 'Done',
  body: 'Your file was saved.',
});
// { success: true }
```

`nova:notifications:clear` clears all notifications for the calling app's session (requires `device:notifications`).

Optional fields on `nova:notifications:show`, sanitized/clamped by the OS gateway before display — invalid values silently fall back rather than erroring: `type` (`'info' | 'success' | 'warning' | 'error'`, default `'info'`), `icon` (name from the OS icon set, default none), `action` (one of a small set of built-in action strings, e.g. `'open-settings'`), `actionLabel` (label for that action button). `title` and `body` are length-capped server-side. The action button is clickable both on the initial toast and later from the persistent notification panel — clicking `'open-settings'`/`'settings'`/`'openSettings'` opens the Settings app.

Rate limited to 10 notifications per app per minute. Once exceeded, further calls reject with `{ code: 'RATE_LIMITED' }` until the window rolls over.

### Clipboard — `nova:clipboard:*`

```javascript
// Read clipboard (requires clipboard:read; vfs:read is a legacy fallback)
const { text } = await window.nova.ipc('nova:clipboard:read', {});

// Write clipboard (declare clipboard:write; low-risk grant is auto-granted)
await window.nova.ipc('nova:clipboard:write', { text: 'Hello' });
```

Reads/writes hit the real system clipboard via `navigator.clipboard`, not just an in-OS value:

- **Read** tries `navigator.clipboard.readText()` first. If that throws (no permission, no focus, insecure context), it falls back to the last value this OS instance itself wrote, so same-session copy/paste inside Nova keeps working even when the browser clipboard API is unavailable.
- **Write** tries `navigator.clipboard.writeText()` first, falling back to a legacy `execCommand('copy')` shim if that fails. If both fail, the call rejects with a `CLIPBOARD_UNAVAILABLE` error instead of silently no-oping.

### Window — `nova:window:*`

```javascript
await window.nova.ipc('nova:window:close', {});
await window.nova.ipc('nova:window:minimize', {});
await window.nova.ipc('nova:window:maximize', {});
await window.nova.ipc('nova:window:setTitle', { title: 'My App — Editing' });
await window.nova.ipc('nova:window:resize', { width: 1200, height: 800 });

const state = await window.nova.ipc('nova:window:getState', {});
// { width, height, x, y, maximized, minimized }
```

### App launcher

See [App management — `nova:app:*` / `window.nova.apps`](#app-management-novaapp-windownovaapps) below for the full reference (launch, info, list, install, uninstall).

### Network — `fetch()` / `nova:net:fetch`

You generally don't need to call `nova:net:fetch` directly — `window.fetch` and `XMLHttpRequest` inside your app are already routed through the bridge, so plain `fetch(url, opts)` works as-is once the relevant `net:*` permission is granted:

```javascript
// Requires net:external (or net:internal for same-origin requests)
const res = await fetch('https://api.example.com/data', {
  headers: { 'Accept': 'application/json' },
});
const data = await res.json();
```

**Exception — fetching your own bundled files:** a same-origin `fetch()` for a file this app already ships (e.g. `module.wasm` in the `native-cpp` template, loaded internally by Emscripten's glue code) does not require a `net:*` permission. It's treated the same as a `<script src>` or `<img src>` reading a bundled asset, not as outbound network access.

### WebSocket — `nova:net:websocket` / `window.nova.websocket`

Requires `net:websocket`. Don't call the raw `nova:net:websocket` / `nova:net:ws:send` / `nova:net:ws:close` IPC methods directly — use the `window.nova.websocket()` wrapper, which handles requestId bookkeeping and event dispatch for you:

```javascript
const ws = await window.nova.websocket('wss://example.com/socket');

// onMessage receives { wsId, data } — not the bare server message. `data`
// is the raw string from the underlying WebSocket's own message event
// (JSON.parse it yourself if the server sends JSON).
ws.onMessage((envelope) => {
  const data = JSON.parse(envelope.data);
  console.log('received:', data);
});
ws.onError((err) => console.error('ws error:', err));
ws.onClose(() => console.log('closed'));

ws.send('hello');
ws.close(1000, 'done');
```

> **Don't skip this:** `onMessage`'s callback argument is `{wsId, data}`, not the raw message. Treating it as the bare payload is an easy mistake — it'll connect, subscribe, and receive real frames with no errors anywhere, while silently never firing your actual message-handling logic.

The returned promise resolves once the connection is open. **Note:** it only resolves from the host's `onopen` handler — there's no host-side rejection path if the connection never opens (bad host, refused connection, TLS failure before handshake). In those cases the call just sits until the IPC layer's own timeout fires and rejects with a generic "IPC request timed out" error rather than a specific connection-failure reason. Treat that timeout as a real connection failure, not a hung guest.

### Geolocation — `nova:device:geolocation`

```javascript
// Requires device:geolocation
const { coords, timestamp } = await window.nova.ipc('nova:device:geolocation', {
  options: { timeout: 5000 }, // passed through to getCurrentPosition
});
// coords: { latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed }
```

### Camera / Microphone — `window.nova.getUserMedia`

A live `MediaStream` can't cross the IPC bridge — `nova:device:camera`/`nova:device:microphone` are authorization-only checks. Use the `getUserMedia` convenience wrapper instead of calling them directly; it checks the app-level permission first, then calls the real `navigator.mediaDevices.getUserMedia()` in your own document (which still goes through the browser's own permission gate too):

```javascript
// Requires device:camera and/or device:microphone matching your constraints
try {
  const stream = await window.nova.getUserMedia({ video: true });
  // use stream, then stop tracks when done:
  stream.getTracks().forEach(t => t.stop());
} catch (err) {
  // PERMISSION_DENIED from the app-level check, or a standard
  // getUserMedia DOMException (NotAllowedError, NotFoundError, NotReadableError)
}
```

### Calendar — `nova:calendar:*` / `window.nova.calendar`

Reads and writes the **same shared calendar data** the built-in Calendar app uses — not an isolated per-app store.

```javascript
// requires calendar:read
const { events } = await window.nova.calendar.list();

// requires calendar:write
await window.nova.calendar.save({ id: 'my-event', title: 'Standup', date: '2026-07-20' });

// requires calendar:delete
await window.nova.calendar.remove('my-event');
```

### Contacts — `nova:contacts:*` / `window.nova.contacts`

Same shared-data model as Calendar — reads/writes the real Contacts app's data.

```javascript
// requires contacts:read
const { contacts } = await window.nova.contacts.list();

// requires contacts:write
await window.nova.contacts.save({ id: 'c1', name: 'Jane Doe', email: 'jane@example.com' });

// requires contacts:delete
await window.nova.contacts.remove('c1');
```

### App management — `nova:app:*` / `window.nova.apps`

```javascript
// List installed apps (requires system:apps)
const { apps } = await window.nova.apps.list();
// Each app retains `icon` and adds `iconUrl` for direct rendering:
// <img src="${apps[0].iconUrl}" alt="">
// `iconUrl` is a package image data URL, a safe local /assets path, or a
// generated SVG data URL for built-in icon names. It is null when unavailable.

// Launch an installed app (requires system:app-launch; max 6 per minute)
await window.nova.apps.launch('com.example.otherapp');

// Get info about this app (no permission)
const info = await window.nova.ipc('nova:app:info', { appId: 'com.example.otherapp' });

// Listing, installing, and uninstalling still require system:apps.
// Install a package — fails closed. Only succeeds
// for a package that's fully signed, trust-store-verified, and unmodified.
// Anything that would normally need a human to click through a warning
// dialog (untrusted signer, tampered contents, already installed) is
// rejected outright rather than silently bypassed — install that manually
// via App Manager instead.
await window.nova.apps.install(packageObject);

// Uninstall an app (requires system:apps) — only works on real,
// file-installed .novaapp packages, not built-in system apps.
await window.nova.apps.uninstall('com.example.otherapp');

// Send the user to Settings → Default Apps (requires system:apps) — for
// a "Set as default" button in your own app's UI. `category` is optional;
// omit it to land on the general Default Apps list, or pass one of the
// category ids (e.g. 'music', 'browser') to open Settings with that row
// highlighted and a banner naming your app as the requester.
await window.nova.apps.openDefaultAppsSettings('music');

// A currently selected sandboxed Home app can take the user directly
// to Home app selection without requesting the broader system:apps grant.
await window.nova.home.openDefaultAppsSettings();

// Home-only app drawer APIs. Settings and App Manager are always listed
// and launchable by the currently selected Home app. Other apps appear
// in list() with system:apps, and can be launched with system:app-launch
// or system:apps.
const { apps, fullAccess } = await window.nova.home.apps.list();
await window.nova.home.apps.launch('com.nbosp.settings');
await window.nova.home.apps.launch('com.nbosp.appmanager');
```

**`openDefaultAppsSettings` is rate-limited** to 3 calls per minute per app id, using the same sliding-window pattern as `nova:notifications:show` — this exists because, unlike a real click, there's no reliable host-side signal that this call came from an actual user gesture rather than a script loop (the sandbox's postMessage boundary doesn't carry browser user-activation state). The limit bounds how often a misbehaving app can steal window focus by repeatedly popping Settings open; it doesn't require a click, since the platform genuinely can't verify one happened. Calls beyond the limit reject with `{ code: 'RATE_LIMITED' }` (see [Error codes](#error-codes)) — design your "Set as default" button assuming a real click, and you'll never hit it in normal use.

This call only opens Settings to the right place — it never changes the user's default itself. The user still has to pick your app from the picker; there's no way to set a default programmatically without their action.

`window.nova.home.openDefaultAppsSettings()` is limited to the currently selected Home app, opens the Home app row, and shares the 3-per-minute rate limit. Other apps receive `PERMISSION_DENIED`.

`window.nova.home.apps.list()` and `.launch(appId)` are also restricted to the selected Home app. Without `system:apps`, the list contains only Settings and App Manager; `system:apps` enables listing other registered apps. Those two core apps can always be launched, while launching any other app requires `system:app-launch` or `system:apps`. Home launches are limited to 6 per minute and do not accept caller-supplied launch options or file intents.

### Admin — `nova:admin:*` / `window.nova.admin`

Requires **both** the relevant `admin:*` permission grant on your app *and* the machine's local admin-mode flag to be on (Settings → Privacy & Security → Admin Access, off by default). If the machine isn't in admin mode, calls reject with a message saying so — that's a correct, working denial, not a bug to work around.

```javascript
// requires admin:audit — reads the live server event log (a 500-entry
// ring buffer, not a persisted audit trail)
const { logs } = await window.nova.admin.auditQuery({ limit: 10 });

// requires admin:system — read or update server-side security settings
// (password policy, lockout thresholds, IP blocking, etc.)
const { settings } = await window.nova.admin.systemGet();
await window.nova.admin.systemSet({ sessionTimeoutMinutes: 30 });

// requires admin:users — list/revoke active sessions (this OS is
// single-user; "sessions" here means active browser/app sessions, not
// separate user accounts)
const { sessions } = await window.nova.admin.usersList();
await window.nova.admin.usersRevoke(sessionId);

// requires admin:apps — admin-scoped view of the same app registry
// system:apps already exposes; distinguishes "an app I granted
// system:apps can manage apps for itself" from "an admin-mode app can
// audit what's installed system-wide"
const { apps } = await window.nova.admin.appsList();
```

### Mail — `nova:mail:*` / `window.nova.mail`

Acts on whatever email account is currently connected in the host Email app — there's no separate mail identity for sandboxed apps, and no way to supply your own credentials through this API. If nothing's connected, every call rejects with a clear "no email account connected" message.

```javascript
// requires mail:read
const { data } = await window.nova.mail.folders();
const { data } = await window.nova.mail.messages({ folder: 'INBOX', page: 1, limit: 20 });
const { data } = await window.nova.mail.message(uid, 'INBOX');
const { data } = await window.nova.mail.search('invoice', 'INBOX');
const { data } = await window.nova.mail.account(); // { restored, type, host, user }

// requires mail:write — batch mark-read/move, plus HTML preview
// rendering. Does NOT cover delete, even though it's the same server
// endpoint as mail:delete's batch op.
await window.nova.mail.markRead([101, 102], 'INBOX');
await window.nova.mail.move([101], 'Archive', 'INBOX');
const { token } = await window.nova.mail.preview('<p>Hello</p>');

// requires mail:send — smtpHost/smtpPort are mandatory. The server has
// no way to infer your account's real SMTP host from its IMAP/POP3/EWS
// host (they're frequently different, e.g. Gmail's imap.gmail.com vs
// smtp.gmail.com) — get this from the same account config your user
// already set up in the Email app, don't guess at it.
await window.nova.mail.send({
  to: 'someone@example.com',
  subject: 'Hello',
  text: 'Hi there',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
});

// requires mail:delete
await window.nova.mail.remove([101], 'INBOX');
```

**Getting an SMTP host to actually pass in:** the platform intentionally won't supply `smtpHost`/`smtpPort` for you (see above), so a real app has two paths, and each implies different UI work:

- **Use `mail:*` against the already-connected Email app account** — your app needs its own small config surface to ask the user for their SMTP host/port (mirroring the same fields the built-in Email app already collects), since there's no way to read that back out of the connected session. This is the right choice when you want to act on the *same* account/mailbox the user already set up, not a separate one.
- **Build an independent mail integration over `net:external`** — for any provider with an HTTP/REST API (Gmail API, Microsoft Graph, etc.), skip `mail:*` entirely and call the provider's API directly via `nova:net:fetch`, handling your own OAuth/auth flow. This gets you a fully separate account/session from whatever's connected in the Email app, and sidesteps the SMTP-host problem entirely since REST APIs don't need one. Note this only works for providers with an HTTP API — raw IMAP/SMTP/POP3 (the wire protocols) aren't reachable through `net:external` at all; there's no host-side handler for arbitrary non-HTTP protocols.

### System info — `nova:system:info`

```javascript
// Requires system:info
const info = await window.nova.ipc('nova:system:info', {});
// { osVersion, securityPatch, platform, ... }
```

### Settings — `nova:settings:get` / `nova:settings:set`

Read and write arbitrary OS-level settings keys. Get and set are gated by **different** permissions — reading a settings value only requires `system:info` (the same low-risk permission that gates `nova:system:info` above), while writing requires `system:settings`:

```javascript
// Requires system:info
const { value } = await window.nova.ipc('nova:settings:get', { key: 'theme' });

// Requires system:settings
await window.nova.ipc('nova:settings:set', { key: 'theme', value: 'dark' });
```

This is a shared, OS-wide key space, not per-app storage — if you want isolated data scoped to your own app, use [Private Storage](#private-storage) (`nova:storage:*`) instead.

A small set of security-sensitive keys — `lockPin`, `pinSalt`, `biometricCredentialId`, `lockoutUntil`, `wrongPinCount`, and `bootPassword` — are blocked from **both** get and set, regardless of permission. No app can read or write these through the settings API; both calls fail with `INVALID_ARGS`. This exists so that holding `system:info` can't be used to read the user's PIN hash, and holding `system:settings` can't be used to reset `lockoutUntil` and bypass the lock screen.

For common appearance customization, prefer `window.nova.appearance.set(...)`. It changes only validated theme/accent/accessibility preferences and doesn't grant access to arbitrary OS settings.

### Event bus — `nova:events:*`

Use `window.nova.onEvent`, which handles the subscribe call and dispatches pushed events to your callback:

```javascript
window.nova.onEvent('system:themeChanged', (data) => {
  console.log('theme changed:', data);
});
```

Calling `nova.ipc('nova:events:unsubscribe', { event: 'system:themeChanged' })` directly still works if you need to unsubscribe explicitly.

**Event names are restricted to a fixed allowlist** — subscribing to any name outside this list fails with `INVALID_ARGS`, even if you hold `system:events`. Common appearance, volume, workspace, power, and network change events do not require `system:events`; notifications, app inventory/lifecycle events, and mail/calendar/contact events remain protected. Mail/calendar/contact events also require their corresponding read permission:

| Event | Fires when |
|---|---|
| `system:notification` | A system notification is shown |
| `system:volumeChanged` | Volume is changed |
| `system:themeChanged` | Light/dark theme is switched |
| `system:workspaceChanged` | The active workspace changes |
| `system:power` | Power state changes (e.g. battery/charging) |
| `system:network` | Network connectivity changes |
| `app:installed` | An app is installed |
| `app:uninstalled` | An app is uninstalled |
| `app:launched` | An app is launched |
| `mail:new` | New mail arrives |
| `mail:updated` | Mail state changes |
| `calendar:reminder` | A calendar reminder fires |
| `calendar:updated` | Calendar data changes |
| `contacts:updated` | Contacts data changes |

There's no event for arbitrary custom app-to-app messaging — the bus is OS-to-app only, not app-to-app.

### Background execution — `nova:background:*`

Three separate permissions cover three genuinely different questions — none of them implies another, the same way `vfs:read` doesn't imply `vfs:write`:

| Permission | Answers | Your app needs to have been opened by the user first? |
|------------|---------|---------|
| `system:background` | "Can this app periodically wake up and do a little work while closed?" | No — the OS can wake it even if it's never been launched this session |
| `system:background:live` | "Can this app keep running after its window is closed?" | Yes — it has to already be open and choose to stay alive |
| `system:autostart` | "Can this app launch itself at OS startup with no user action at all?" | No — this is the biggest ask of the three |

#### Tier 1 — scheduled wake (`system:background`)

The OS periodically (roughly every 15 minutes) spins your app up headlessly — no window, no visible UI — and gives it a short window (a few seconds) to do work: check state, sync data, refresh a cache. It does **not** grant `device:notifications` — a wake handler that wants to alert the user still needs that permission separately and will get `PERMISSION_DENIED` from `nova:notifications:show` without it, exactly as it would in the foreground.

```javascript
// Requires system:background
window.nova.onBackgroundWake((info) => {
  // info.wokeAt    — ISO timestamp
  // info.deadlineMs — how long you have before the host tears this down regardless

  // do your check/sync/refresh here — keep it brief
  doQuickSync();

  // Optional: signal you're done early so the host doesn't wait out the
  // full deadline before cleaning up.
  window.nova.backgroundWakeDone();
});
```

If you never call `backgroundWakeDone()`, the host just waits out `deadlineMs` and tears the sandbox down anyway — calling it is a courtesy, not a requirement.

#### Tier 2 — stay alive after close (`system:background:live`)

Holding this permission is **not** enough by itself to keep your app running — that would mean every app with the grant gets backgrounded on every close whether it wants to or not. Your app has to explicitly opt in for the current session:

```javascript
// Requires system:background:live
const { enabled } = await window.nova.stayAliveInBackground();
// Call again with `false` if you change your mind before the window closes:
// await window.nova.stayAliveInBackground(false);
```

Once opted in, closing the window keeps your app's process running instead of terminating it. The user sees a one-time "App started running in the background" toast, plus a persistent, non-dismissible entry pinned to the top of the notification panel with a **Terminate** button — that button is the only way the process stops short of the app exiting on its own. If the user reopens your app from the launcher while it's live in the background, the OS reattaches your existing running instance into the new window (same process, same in-memory state) rather than starting a second copy, and the pinned notification clears since the app is visibly open again. Closing it again re-backgrounds it without needing to call `stayAliveInBackground()` a second time, since your app never actually stopped.

#### Tier 3 — autostart at OS boot (`system:autostart`)

The biggest ask of the three: your app can launch itself when NovaByte OS starts, before the user has opened anything. This is opt-in on two separate axes — your app needs the grant, *and* the user has to have added your app to their own "start at boot" list (via the app's detail page in App Manager, which only shows that toggle for apps that declared `system:autostart`). Neither one alone is enough. There's no runtime API for this tier — nothing to call from your app's JS. It either launches at boot or it doesn't, based on those two checks.

Autostart never runs behind a lock screen — if the machine is locked at boot, autostart apps wait until the user unlocks before launching.

### Storage — `nova:storage:*`

Per-app key-value storage via the OS bridge (there is no `__novaPrivateStore` — see [Private Storage](#private-storage) above):

```javascript
await window.nova.ipc('nova:storage:set', { key: 'myKey', value: 'myValue' });
const { value } = await window.nova.ipc('nova:storage:get', { key: 'myKey' });
await window.nova.ipc('nova:storage:delete', { key: 'myKey' });
await window.nova.ipc('nova:storage:clear', {});
const { keys } = await window.nova.ipc('nova:storage:keys', {});
```

### File picker — `nova:dialog:*`

```javascript
// Open file picker (requires vfs:read or vfs:access)
const file = await window.nova.ipc('nova:dialog:open', {
  accept: ['.txt', '.md'],
  multiple: false,
});
// { path, name, content }

// Save file picker (requires vfs:write or vfs:access)
await window.nova.ipc('nova:dialog:save', {
  filename: 'notes.txt',
  content: 'Hello',
});
```

### Styled file picker — `nova:sysdialog:*`

A second, additional file-picker pair, separate from `nova:dialog:*` above and not a replacement for it — both keep working independently, so switching to this one is opt-in. Where `nova:dialog:*` renders its own minimal one-off overlay, `nova:sysdialog:*` opens the same shared, Files-app-styled VFS browser (`SystemDialogs`) that built-in apps like TextEdit use for Save As / Open — real folder navigation with back/up buttons and a path bar, an icon grid instead of a plain list, and no "save as type" dropdown (the payload already tells the host what kind of file this is; a type selector would be redundant). `vfs:access` also satisfies either operation; otherwise `vfs:read` opens and `vfs:write` saves within your app data.

```javascript
// Open picker (requires vfs:read or vfs:access)
const result = await window.nova.ipc('nova:sysdialog:open', {
  title: 'Import',            // optional, defaults to "Open"
  startFolderId: undefined,   // optional VFS folder id to start in; defaults to root
});
if (result.cancelled) {
  // user backed out of the dialog — not an error
} else {
  const { id, name, content, mimeType, size, path } = result.file;
}

// Save picker (requires vfs:write or vfs:access) — writes the file itself once a
// destination is chosen, then returns the new node's info.
const result = await window.nova.ipc('nova:sysdialog:save', {
  title: 'Save As',            // optional, defaults to "Save As"
  suggestedName: 'notes.txt',  // optional, prefills the filename box
  startFolderId: undefined,    // optional VFS folder id to start in; defaults to root
  content: 'Hello',
  mimeType: 'text/plain',      // optional, defaults to 'text/plain'
});
if (result.cancelled) {
  // user backed out of the dialog — not an error
} else {
  const { id, name, path } = result.file;
}
```

Both channels are on the same interactive, long-timeout tier as `nova:dialog:*` and `nova:download` — the call can legitimately sit open for minutes while a person navigates folders, so it won't hit the normal 30-second IPC timeout.

### Error codes

`window.nova.ipc` rejects (throws) rather than resolving with an `{ error }` field — always wrap calls in `try/catch` or attach `.catch()`. The thrown error has `.code` and `.message` set:

| Code | Meaning |
|------|---------|
| `PERMISSION_DENIED` | Required permission not granted |
| `INVALID_ARGS` | Missing or invalid payload fields |
| `NOT_FOUND` | File or resource not found |
| `QUOTA_EXCEEDED` | Storage limit reached |
| `NETWORK_ERROR` | Fetch failed |
| `RATE_LIMITED` | Too many calls to a rate-limited API in the current window (e.g. notifications) |
| `UNAVAILABLE` | The underlying OS service isn't available, a required upstream connection isn't set up yet (e.g. no email account connected), or a machine-level gate is closed (e.g. `admin:*` when the machine isn't in admin mode) |
| `UNVERIFIED` | `nova:app:install` rejected an unsigned or trust-store-unverified package — this is a correct, fail-closed rejection, not a bug |
| `GEOLOCATION_ERROR` | The browser's geolocation API itself failed or timed out (separate from `PERMISSION_DENIED`, which means the app-level grant was missing) |

---

## Security


### `eval()` auditing

`eval()` faces two separate, independent checks — don't confuse one for the other:

- **Install-time:** the Content Scanner flags literal `eval(` (and `new Function(`) as dynamic-code patterns and can block install before your app ever runs. See [Content Scanner](#content-scanner--avoiding-false-positives-on-install) for what's actually flagged and how to avoid false positives.
- **Runtime:** no longer includes `unsafe-eval` — `eval()` and `new Function()` are blocked by the browser at runtime, full stop, regardless of how they're invoked (including indirect forms like `window['ev' + 'al']` that could slip past the install-time scanner's literal-text check). There is no legitimate runtime path to dynamic code execution anymore. The sandbox's capability shim still reports any attempted call via the internal `nova:audit:eval` channel, logging to `EventLog` (category `security`, severity `warn`) — this is kept for observability and back-compat, but in practice the CSP will have already thrown before the app's `eval()` call does anything.

  Note this runtime CSP is actually enforced from **two independent places**, both stripped of `unsafe-eval`: the client-side `RELAXED_CSP_META` meta tag injected by `app-sandbox.js`, and the server-sent `Content-Security-Policy` header set by the `/api/apps/serve/:sandboxId/*` route in `index.js` that actually serves packaged app files. The header is at least as authoritative as the meta tag — it's set before the browser even parses the HTML — so both had to be patched for the fix to be complete.

Practical takeaway: both gates now actually block. The scanner stops the obvious case at install time; the CSP — enforced identically at both the header and meta-tag level — stops dynamic constructions at runtime. There's no supported way for an app to use `eval()` or `new Function()` in this sandbox.

### Best practices

- Request the minimum permissions your app actually needs
- Handle optional permission denial gracefully — the app should still function
- Don't use `eval()` — use safer alternatives
- Validate and sanitize all user input and any file content you read
- Don't collect data you don't need
- External scripts in the packaged entry HTML are deferred by the NovaByte host, so `app.js` can initialize against the parsed entry-page DOM directly. Add `defer` to the script tag as well if you also run the page outside NovaByte OS. Dynamically created scripts and documents retain normal browser timing.

### Content Scanner — avoiding false positives on install

Every dropped file and every file inside a `.novaapp` package is run through a static heuristic scanner (`window.Scanner`) before it's trusted — on drag-and-drop into Files/Desktop, and on App Manager package install. It isn't an AV engine; it's a small set of cheap tripwire checks. A handful of ordinary build patterns will trip it if you're not aware of the rules:

- **Reference your script, don't inline it.** In `index.html`, use `<script src="app.js"></script>` — a local relative path to a sibling file in your package. An inline `<script>...</script>` block with actual code inside it is flagged and blocks install, no exceptions. This isn't about how the runtime loads your app (each file in a `.novaapp` package stays a separate file — nothing gets bundled into one HTML at build or runtime); it's purely about what the scanner allows: a `src` reference to local code is fine, code sitting directly inside the HTML is not.
- **"Local" means local.** The `src` path can't have a scheme (`http://`, `data:`, etc.), can't be protocol-relative (`//...`), can't be absolute (`/...`), and can't contain `..` traversal. Keep it a plain relative filename like `app.js` or `js/app.js`.
- **Don't `eval()` decoded/assembled strings.** `atob(...)`, `Buffer.from(..., 'base64')`, and `String.fromCharCode(...)` are all fine on their own (normal for crypto, binary data, images). What blocks is piping the result of one of those *into* `eval(...)`, `new Function(...)`, `document.write(...)`, or `.innerHTML =`. If you need to decode binary data, decode it and use it as data — don't hand it to something that executes it.
- **Avoid literal `eval(` and `new Function(` entirely** — both are flagged outright, independent of the base64 rule above.
- **If your app renders user-supplied HTML/Markdown/SVG**, keep iframes sandboxed. An `<iframe>` with no `sandbox` attribute at all is always rejected; a sandboxed iframe combining `allow-same-origin` with `allow-scripts` is rejected too (that combination lets framed content script its way back out of the sandbox) — everything else with a proper `sandbox` attribute and a local or `https://` `src` is fine.
- **Don't ship high-entropy content under a text-like extension.** If a file is declared `.js`, `.json`, `.svg`, `.html`, `.md`, `.txt`, etc. but its actual bytes look like packed/encoded binary (high Shannon entropy), it's flagged as likely disguised content — even with no other red flag matching.
- **Don't double up extensions.** Something like `readme.pdf.exe` is flagged purely for having an executable extension trailing behind a plausible document one, regardless of actual file content.

None of this affects `vendor/` libraries dropped in as single minified files (JS/CSS) — those get bundled at Build time via the normal template pipeline, not evaluated as a hostile drop.

---

## Package format

A `.novaapp` file is plain JSON:

```json
{
  "novabyte_app": true,
  "compiled_at": 1700000000000,
  "manifest": { "id": "...", "name": "...", "version": "...", "entry": "...", "permissions": [] },
  "files": {
    "index.html": "<base64-encoded content>",
    "app.js": "<base64-encoded content>"
  },
  "signature": "<Ed25519 signature, base64url>",
  "signer": "NovaByte Trusted Signing"
}
```

File contents are Base64-encoded. `signature` is an Ed25519 signature over the `novabyte_app`, `manifest`, `files`, and `compiled_at` fields — not a plain checksum. A checksum only tells you a file wasn't corrupted in transit; it says nothing about who produced it, since anyone can compute a new one after modifying the package. A signature can only be produced by whoever holds the matching private key, which is what makes trust meaningful.

### Package signatures

Signed doesn't automatically mean trusted. The runtime checks two separate things on install:

1. **Is the signature valid?** — does it verify against the public key that produced it.
2. **Is that public key trusted by the OS?** — the OS trust store determines which signers are trusted.

An app can carry a perfectly valid signature from some other key — that's still reported as **Unverified**. Trust isn't about "was this signed," it's about "was this signed with the one key the OS actually trusts."

> **Why not a shared secret?** An earlier revision signed packages with HMAC-SHA256 using a shared secret — the same key typed into both the signing tool and every installer. That only proves a package wasn't altered after the key was typed in; it can't prove *who* signed it, since anyone holding the key (which has to be shared to verify anything) can forge arbitrary packages. Worse, one install path had a fallback that accepted `signature === sha256(payload)` — the "signature" was just a hash the installer recomputed from the package's own contents, which any attacker can do for their own unmodified payload. It verified nothing about origin. Ed25519 public/private key signing fixes this structurally: the private key never leaves the signer, only the public key ships in the trust store, and a valid signature can only have been produced by whoever holds the matching private key.

**Self-signing** — you can sign your own `.novaapp` with your own keypair for local testing. It will only be trusted if the corresponding public key is in the OS trust store. Self-signing proves the package hasn't been tampered with since you signed it.

**Revocation** — trust can be pulled from one specific signed package after the fact, by its exact signature, without touching the signing key itself or any other package that key ever signed. A few things worth knowing:

- Revocation is keyed by the exact signature string, not by app id/name/version — those fields are dev-controlled and could be reused or spoofed, whereas a signature is a fixed value only producible once, at sign time.
- Revoking a signature does **not** revoke the key — every other package signed with that key stays trusted. If the private key itself is ever compromised, that's a different, more drastic case: revoking individual signatures isn't enough, the trust store entry itself needs to be replaced and everything re-signed.
- Revocations persist to disk (`revoked-signatures.json`) and apply across every NBOSP process on that machine, not just the one that revoked it. A mistaken revocation can be undone.

**What the user sees:**

- **Verified** — signed with NovaByte's trusted key, not revoked. Installs normally.
- **Unverified** — unsigned, self-signed, signed with any other key, or individually revoked. The install still proceeds, but the OS shows a clear warning first so the user can back out if they don't recognize the source.

Unverified doesn't mean blocked — NBOSP doesn't gatekeep what you can run on your own machine. It means the OS is telling you the truth about what it can and can't vouch for, and leaving the decision with you.

## Distribution

### Direct distribution

Share the `.novaapp` file directly. Users drag and drop it into the App Manager, or click Install and pick the file. That's the whole install flow — no separate installer, no admin rights required.

Unverified packages still install, but with a warning so users can decide whether to trust them.

### Updates

There's no built-in update pipeline in NBOSP. The simplest approach is a GitHub Releases pipeline:

1. Bump `version` in `manifest.json`
2. Build and tag a release
3. Attach the `.novaapp` to the release
4. Tell your users to re-download and reinstall

When a user installs an app that's already installed, the App Manager detects the version conflict and prompts them to replace it.

---

## Compatibility

The `.novaapp` format is used by NovaByte OS and compatible NBOSP forks. Runtime APIs and permissions can differ between hosts and forks; check the target system documentation and test against the environments you intend to support.

---
