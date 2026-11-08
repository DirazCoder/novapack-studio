# NovaByte Studio Plugin Developer Reference

Plugin support starts with NovaByte Studio 1.2.31. Studio 1.2.30 and earlier
versions do not support plugins. Plugins are CommonJS JavaScript modules,
loaded into the Studio desktop process.

## Important: plugin trust and access

A plugin has the same privileges as the Studio process and the signed-in user.
It can read and modify files, start processes, make network requests, and access
the Studio window. **Plugins are not sandboxed.** Only install code from a
publisher you trust.

Installing a plugin does not enable it. Before enabling an unsigned plugin,
Studio warns that it is not digitally signed and asks you to confirm; this
warning appears each time you enable it. A verified plugin asks for trust
confirmation the first time it is enabled. A trusted plugin can be disabled or
uninstalled in **Settings → Plugins**. Updating/reinstalling a package resets
its enable and trust choices.

The Studio Plugins manager includes an in-app marketplace backed by the
NovaByte public plugin catalog. Marketplace packages are downloaded from the
official package store and must match the pinned NovaByte signing key before
installation; they remain disabled until you review and enable them. The
manager also supports searching, refreshing the catalog, installing local
`.nbplugin` archives or folders, and managing installed plugins.

The **Verified signature** badge means the package matches a signature made
with NovaByte Trusted Signing's pinned Ed25519 public key. It proves integrity
and signing-key identity, not that the plugin is safe or benign. An unsigned
local plugin can still be enabled after the trust confirmation.

## Quick start

Create a folder containing `plugin.json` and `index.js`.

`plugin.json`:

```json
{
  "id": "com.example.greeting",
  "name": "Greeting Tools",
  "version": "1.0.0",
  "description": "Adds a greeting command.",
  "publisher": "Example Studio",
  "icon": "assets/icon.png",
  "main": "index.js",
  "engines": {
    "studio": ">=1.2.31 <2.0.0"
  }
}
```

`index.js`:

```js
module.exports = {
  activate(api) {
    api.commands.registerCommand(
      'say-hello',
      'Say Hello',
      () => api.notify('Hello from my plugin!'),
      { description: 'Show a greeting from the plugin.' },
    );
  },

  deactivate(api) {
    // Release plugin-owned timers, subscriptions, and other resources here.
  },
};
```

In Studio, open **Settings → Plugins → Install plugin folder**, select the
folder, then enable the installed plugin and confirm the trust prompt. The
plugin command is available from the Command Palette under **Plugins**.

`activate(api)` is required and may return a Promise. `deactivate(api)` is
optional and may also return a Promise. Studio awaits both. If activation
throws or rejects, Studio logs the error and the plugin is not activated.
During reload/shutdown, plugins are deactivated in reverse activation order.

## Manifest reference

`plugin.json` must be a JSON object at the package root.

| Field | Required | Rules |
|---|---:|---|
| `id` | Yes | Stable lowercase identifier matching `[a-z0-9][a-z0-9.-]{2,127}`. Use a reverse-domain name such as `com.example.greeting`. |
| `name` | Yes | 1–100 characters. |
| `version` | Yes | Valid semantic version (SemVer). |
| `main` | Yes | Relative path to an included entry-point file. |
| `engines.studio` | Yes | Valid SemVer range that includes the running Studio version. |
| `description` | No | String of at most 500 characters. |
| `publisher` | No | Publisher label shown in plugin settings. |
| `icon` | No | Relative path to an included PNG, JPEG, or WebP icon. Keep it at or below 1 MiB; SVG and external URLs are not supported. |

Use forward slashes in `main` paths on every platform. Do not use absolute
paths, `..`, backslashes, colon-containing segments, or reserved path segments
such as `constructor`, `prototype`, and `__proto__`.

The plugin manager displays a bundled `icon` in its Installed view and on a
marketplace plugin's detail page. Marketplace details are loaded from the
signed package when opened; after a detail page has been viewed, its icon is
also cached for that listing in the current session. If the icon is missing or
invalid, Studio displays a monogram fallback. The detail page shows catalog
metadata and supported manifest fields as text; it does not display screenshots
or execute the plugin.

When a newer compatible marketplace version is available, the Marketplace
offers an Update action. Updating replaces the installed package and disables
it until you explicitly enable and trust the updated version.

## Complete `api` reference

Studio passes the same `api` object to `activate(api)` and `deactivate(api)`.
The supported, versioned surface is `api.version === 1`.

### Metadata and notification

| Member | Description |
|---|---|
| `api.version` | Plugin API version number (`1`). |
| `api.studio.version` | Running Studio version string. |
| `api.studio.plugin.id` | Installed plugin ID. |
| `api.studio.plugin.name` | Installed plugin name. |
| `api.studio.plugin.version` | Installed plugin version. |
| `api.notify(message)` | Shows a Studio toast prefixed with the plugin name. The value is converted to a string and truncated to 500 characters. |

### Commands

```js
const dispose = api.commands.registerCommand(id, label, action, options);
```

Registers a Command Palette command under **Plugins** (or under the category
specified in `options.category`). `action` is called with the plugin's `api`
object. The returned function unregisters the command; Studio also unregisters
it automatically when the plugin is deactivated. The command can be found by
its label, description, command ID, or plugin name. Opening the Command Palette
refreshes the registered command list.

| Argument | Type | Details |
|---|---|---|
| `id` | string | 1–64 characters; letters, digits, `.` and `-`; must start with a letter or digit. Unique within this plugin. |
| `label` | string | Non-empty, at most 100 characters. |
| `action` | function | Called when the command is selected; receives `api`. May be synchronous or async. Thrown errors and rejected Promises are logged to the developer console and reported with a Studio notification. |
| `options.description` | string | Optional explanatory text in the Command Palette. |
| `options.category` | string | Optional category, trimmed and limited to 40 characters. The resulting category is `Plugins · {category}`. |
| `options.when` | function | Optional synchronous, no-argument predicate. It may be called repeatedly while listing commands; a falsy result hides the command. |

Invalid arguments or a duplicate command ID throw an error. A command ID is
scoped to the plugin, so different plugins may use the same ID.

### Menu-style command registration

```js
const dispose = api.menus.registerItem(menu, id, label, action, options);
```

This registers a Command Palette command in the category **Plugins · {menu}**;
it does not add an item to a native application menu. `id`, `label`, `action`,
and `options` have the same behavior as `registerCommand`, except
`options.category` is overridden by `menu`. `menu` must be a non-empty string
of at most 40 characters. The returned disposer unregisters the command.

### Events

```js
const unsubscribe = api.events.on(eventName, listener);
```

Listeners receive the event detail object as their only argument. The returned
function unsubscribes the listener. Studio removes subscriptions automatically
when the plugin is deactivated.

| Event | Detail object |
|---|---|
| `project:open` | `{ directory: string, name: string }` |
| `tab:change` | `{ previous: string, current: string }` |
| `build:start` | `{ projectDirectory: string, outputDirectory: string }` |
| `build:log` | `{ projectDirectory: string, type: string, message: string }`; emitted for builder log messages. |
| `build:complete` | `{ projectDirectory: string, outputFile: string \| null }` |
| `build:error` | `{ projectDirectory: string, error: string }` |
| `view:change` | `{ previous: string, current: string }` |
| `file:open` | `{ path: string, isImage: boolean, reusedTab: boolean }` |
| `file:save` | `{ path: string }` |
| `file:close` | `{ path: string }` |
| `editor:change` | `{ path: string, isDirty: boolean, length: number }`; emitted after editor changes, without sending document contents. |
| `theme:change` | `{ previous: string, current: string }`; emitted only when the selected theme changes. |
| `tab:change` / `view:change` | `previous` and `current` contain built-in view IDs or registered plugin view IDs (`plugin:{pluginId}:{viewId}`). |

Only the listed event names are supported. An unsupported name or non-function
listener throws a `TypeError`. Event listeners may be async; Studio does not
wait for them. Synchronous exceptions and rejected Promises are logged to the
developer console.

### Modal panels

```js
const panel = api.panels.create({ id, title, content });
```

Creates a hidden modal and moves the supplied DOM element, text node, comment,
or document fragment into its body. Nodes created in a plugin's own JavaScript
realm are supported; they do not have to pass the host realm's `instanceof
Node` check. The plugin must build and populate `content` itself.

| Member | Description |
|---|---|
| `panel.element` | The dialog `<section>` element. |
| `panel.show()` | Shows the modal and focuses its close button. |
| `panel.hide()` | Hides the modal. |
| `panel.dispose()` | Removes the modal from the document. Safe to call more than once. |

`id` follows the same 1–64-character ID rule as command IDs and is unique among
the plugin's panels. `title` must be non-empty and at most 100 characters.
`content` must be a DOM element, text node, comment, or document fragment.
Clicking the backdrop or close button hides the modal. Studio automatically
disposes registered panels on plugin deactivation.

Example:

```js
const content = document.createElement('div');
const heading = document.createElement('p');
heading.textContent = 'Plugin panel content';
content.append(heading);

const panel = api.panels.create({
  id: 'welcome',
  title: 'Welcome',
  content,
});
panel.show();
```

### Workspace tabs and views (`api.views`)

Use `api.views.registerView()` to add a real tab to Studio's workspace tab row.
This is different from `api.panels.create()`, which creates a modal overlay.

```js
let workspaceView;

module.exports = {
  activate(api) {
    const content = document.createElement('main');
    const heading = document.createElement('h1');
    heading.textContent = 'My Plugin';
    const message = document.createElement('p');
    message.textContent = 'This content lives in the Studio workspace.';
    content.append(heading, message);

    workspaceView = api.views.registerView({
      id: 'home',
      title: 'My Plugin',
      content,
      onShow() {
        console.log('Plugin tab is now active');
      },
    });

    api.commands.registerCommand(
      'open-plugin-view',
      'Open My Plugin Tab',
      () => workspaceView.show(),
    );
  },

  deactivate() {
    workspaceView?.dispose();
  },
};
```

`registerView({ id, title, content, onShow?, onHide? })` creates a tab and its
content panel. `id` follows the same rule as command IDs; `title` must be
non-empty and at most 100 characters; `content` must be a DOM element, text
node, comment, or document fragment. Optional lifecycle callbacks receive the
plugin API. They may be async; thrown errors and rejected Promises are logged
to the developer console.

The returned view has:

| Member | Description |
|---|---|
| `view.id` | Fully qualified view ID: `plugin:{pluginId}:{id}`. Use this with `api.ui.switchView()`. |
| `view.element` | The view's workspace content panel element. |
| `view.show()` | Activates the workspace view. |
| `view.hide()` | Returns to the Editor if this view is active; otherwise leaves it hidden. |
| `view.dispose()` | Removes the view tab and panel. If active, returns to the Editor first. Safe to call more than once. |

Studio automatically disposes plugin views during plugin deactivation. The
optional `onShow` and `onHide` callbacks run when switching into or away from
the view. `api.views.getRegisteredViews()` returns descriptors for the
calling plugin's current views: `{ id, key, element }`.

### Project files

`api.project` provides project metadata and project-relative file operations.
The filesystem methods are synchronous unless stated otherwise.

| Method | Behavior |
|---|---|
| `api.project.getDirectory()` | Returns the current project directory, or `null` if no project is open. |
| `api.project.getName()` | Returns the current project name, or `null` if none is open. |
| `api.project.getManifest()` | Reads the project's manifest using Studio's manifest reader. Returns the parsed manifest, `null` if not found, or an object containing `_error` if parsing/shape validation failed. |
| `api.project.listFiles()` | Synchronously returns sorted project-relative file paths using `/`. Includes hidden files. Symbolic links are excluded. |
| `api.project.exists(path)` | Returns whether the project-relative path exists. |
| `api.project.stat(path)` | Returns `{ isFile, isDirectory, size, modifiedAt }`; `modifiedAt` is an ISO timestamp. Throws if the path does not exist. |
| `api.project.readFile(relativePath, encoding = 'utf8')` | Synchronously reads a file under the open project and returns the result from Node.js `fs.readFileSync`. Throws if no project is open or the resolved path (including symlinks) is outside the project. |
| `api.project.writeFile(relativePath, contents, encoding = 'utf8')` | Creates parent directories as needed and synchronously writes the file. `contents` and `encoding` follow Node.js `fs.writeFileSync`. Throws if no project is open or the resolved path (including symlinks) is outside the project. |
| `api.project.createDirectory(relativePath)` | Synchronously creates the directory and any missing parent directories. |
| `api.project.remove(relativePath)` | Synchronously removes a file or directory recursively. The open project root cannot be removed. |
| `api.project.openFile(relativePath)` | Opens a project file in Studio's editor/preview and returns `{ path, isDirty, isPreview }`, or `null` if Studio could not open it. |

These are synchronous filesystem operations; avoid large files or frequent
operations on the UI thread. The helper resolves existing path components
before accessing them to reject symlink escapes. Plugins still have full
process privileges and can bypass this helper through `api.node` or other
means; it is a convenience guard, not a security sandbox.

### Open files and tabs (`api.files`)

These methods operate on Studio's open editor tabs. File paths returned by
these methods are project-relative when a project is open.

| Method | Behavior |
|---|---|
| `api.files.getOpenFiles()` | Returns an array of `{ path, isActive, isDirty, isPreview }` descriptors. |
| `api.files.getActiveFile()` | Returns the active file descriptor `{ path, isDirty, isPreview }`, or `null`. |
| `api.files.saveCurrent()` | Saves the active file and returns `true` if it is clean afterward; returns `false` when there is no active file or saving failed. |
| `api.files.saveAll()` | Saves all dirty open files and returns whether every tab is clean afterward. |
| `api.files.close(relativePath)` | Asynchronously closes the matching project file tab. If dirty, Studio asks whether to discard changes. Resolves to `true` if closed, otherwise `false`. |

`api.project.openFile()` is the convenience for opening a file; `api.files`
provides inspection and tab lifecycle operations.

### Application and navigation (`api.app`)

| Method | Behavior |
|---|---|
| `api.app.getState()` | Returns a snapshot `{ screen, projectDirectory, projectName, activeView, theme, building }`; it does not expose the mutable internal state object. |
| `api.app.openProject(directory)` | Asynchronously asks Studio to open the directory. Throws if it is not an existing directory; otherwise resolves to `true` if it became the open project, or `false` if the request was canceled. Studio may show its normal confirmation dialogs. |

### UI (`api.ui`)

| Method | Behavior |
|---|---|
| `api.ui.notify(message)` | Alias for `api.notify(message)`. |
| `api.ui.getTheme()` | Returns the current theme ID. |
| `api.ui.getThemes()` | Returns the available `{ id, label }` themes, including `custom`. |
| `api.ui.setTheme(themeId)` | Applies and persists an available theme. Throws for an unknown theme ID; returns the selected ID. |
| `api.ui.getDensity()` | Returns `comfortable` or `compact`. |
| `api.ui.setDensity(density)` | Applies and persists `comfortable` or `compact`. Throws for other values; returns the selected density. |
| `api.ui.getViews()` | Returns the built-in Studio view IDs and all currently registered plugin view IDs. |
| `api.ui.switchView(name)` | Switches to an available built-in or plugin view ID and returns whether it became active. Throws for an unknown view. |

Built-in view IDs are `editor`, `manifest`, `design`, `permissions`, `build`,
`sign`, `git`, and `review`. Plugin view IDs are
`plugin:{pluginId}:{viewId}`.

### Build (`api.build`)

`await api.build.run()` runs Studio's normal build flow for the current project,
using the settings currently selected in the Build and Sign views. It saves the
manifest first and updates the normal UI and build history.

It resolves to `{ success: true, outputFile: string | null }` after a
successful build or `{ success: false, error: string }` if there is no project,
another build is running, manifest validation fails, or the build fails.
For an actual build attempt, `build:start` and then `build:complete` or
`build:error` are emitted; builder output is also delivered through
`build:log`. Early exits (no project, busy, or manifest save failure) return a
failure result without emitting build lifecycle events.

### Project templates (`api.templates`)

| Method | Behavior |
|---|---|
| `api.templates.list()` | Returns `{ id, name, description }` for every built-in project template. |
| `api.templates.create(options)` | Creates a project from a built-in template. |

`create` accepts `{ targetDir, template, manifest, appsRoot }`. `targetDir` is
required; `template` defaults to `blank`; `manifest` must be a plain object;
`appsRoot` optionally constrains the target to a containing directory. It
returns `{ success, files, error? }`. An unknown template or an unsafe target
returns a failure object rather than throwing. See the `TEMPLATES` list from
`api.templates.list()` before presenting a template picker.

### App permission catalog (`api.permissions`)

These are NovaByte OS app permissions for projects created by Studio; they do
not grant extra privileges to a Studio plugin.

| Method | Behavior |
|---|---|
| `api.permissions.list()` | Returns copies of all permission descriptors: `{ id, label, risk, description }`. |
| `api.permissions.get(id)` | Returns a copy of one descriptor, or `null` for an unknown ID. |
| `api.permissions.forAction(action)` | Returns the permission IDs corresponding to an app action/channel, including supported legacy aliases. Accepts values such as `nova:calendar:list` or `calendar:list`. |

### Built package inspection (`api.packages`)

| Method | Behavior |
|---|---|
| `api.packages.inspect(packagePath)` | Synchronously inspects a `.novaapp` and returns its format, manifest, file paths/count, signature metadata, compile time, and package size. Throws for an unreadable or invalid package. |
| `await api.packages.verify(packagePath, trustStore = [])` | Verifies the package against the supplied trust store (`[{ name, publicKey }]`). With the default empty trust store, signed packages are not trusted. Resolves to `{ valid, signer, reason, manifest }`; unsigned packages return `valid: false`. |
| `api.packages.listActions(packagePath)` | Synchronously returns sorted unique `nova:` action strings found in the package files. |

These helpers inspect app packages, not `.nbplugin` plugin archives.

### Editor API (`api.editor`)

`api.editor` is a live getter for Studio's current `window.CM` editor object. It
may be unavailable before the editor initializes. Its current methods are:

| Method/property | Behavior |
|---|---|
| `view` | Getter for the underlying CodeMirror `EditorView`, or `null` when not mounted. |
| `getValue()` | Returns the current editor text, or `''` when no editor is mounted. |
| `setValue(content)` | Replaces the document content. No-op without a mounted editor. |
| `replaceDocument(content, cursorOffset)` | Replaces all text, places the cursor at the clamped offset, and focuses the editor. |
| `getSelectionText()` | Returns selected text, `''` for an empty selection, or `null` without an editor. |
| `replaceSelection(text)` | Replaces the current selection and focuses the editor. |
| `selectAll()` | Selects the entire document and focuses the editor. |
| `insertAtCursor(text)` | Replaces the selection with text, places the cursor after it, scrolls to it, and focuses the editor. |
| `focus()` | Focuses the editor if mounted. |
| `gotoLine(line, column = 1)` | Moves to a 1-based line and column and scrolls it into view. Out-of-range lines are ignored. |
| `undo()` / `redo()` | Invokes editor undo or redo. |
| `openFind()` / `closeFind()` | Opens or closes the editor search panel. |
| `findNext()` / `findPrev()` | Moves to the next or previous search match. |
| `replaceNext(searchTerm, replacement, caseSensitive = false)` | Replaces the next matching term. |
| `replaceAll(searchTerm, replacement, caseSensitive = false)` | Replaces all matching terms. |
| `getSettings()` | Returns a copy of editor settings: `fontSize`, `tabSize`, and `wordWrap`. |
| `applySettings(newSettings)` | Merges and persists settings; supported keys are `fontSize`, `tabSize`, and `wordWrap`. |
| `setSyntaxDiagnostics(diagnostics)` | Replaces editor diagnostics. A diagnostic may include `editor: false` to suppress it, an `editorFrom` zero-based offset or 1-based `line` and `column`, `severity` (`warning` or error by default), and `message`. |
| `setPermissionHoverHandler(handler)` | Sets or clears the editor permission-hover callback. Pass a function or a non-function value to clear it. |
| `mount(content, ext, filePath, projectRoot, onChange, onSave, onCursorChange)` | Recreates the editor with the supplied content and callbacks. Intended for Studio integration; plugins should generally not mount or destroy Studio's editor. |
| `destroy()` | Destroys the editor and changes the editor host/empty-state visibility. Intended for Studio integration. |

This is the current editor object, not a separately versioned plugin API.
Methods that alter the document or lifecycle can interfere with Studio's open
file, save state, or other plugins; use with care.

### Design API (`api.design`)

`api.design` is a live getter for Studio's `window.NBPro` object. It may be
unavailable before the Design module initializes. Its currently exposed
members are:

| Member | Description |
|---|---|
| `init()` | Initializes the Design interface. Studio normally calls this itself. |
| `onDesignMessage(message)` | Handles an internal Design message. |
| `setDpiPreset(...)` | Sets the active DPI preset. Internal UI integration; signature is not a supported plugin contract. |
| `clearDpiPresetFlagOnly()` | Clears the active DPI preset indicator without changing the frame. Internal UI integration. |
| `insertNativeComponent(id)` | Inserts a built-in component by ID. |
| `insertCustomComponent(id)` | Inserts a custom component by ID. |
| `_internal` | Internal/testing data and helper functions; unstable and not a supported plugin API. |

The `_internal` object currently exposes `IPC_ACTIONS`, `NATIVE_COMPONENTS`,
`DPI_PRESETS`, `DPI_SCALES`, `PSEUDO_STATES`, `EASING_CURVES`, `_lineDiff`,
`_extractThemeVars`, `_coerceHex`, `_hashCode`, `_scanAppStateKeys`,
`_isPermissionDeclared`, `_readProjectManifest`, `_readIndexHtml`,
`_readStyleCss`, and `_readAppJs`. These implementation details may change
without notice. `api.design` is not a versioned plugin API.

### Node.js access (`api.node`)

`api.node` exposes Node.js modules directly:

| Member | Value |
|---|---|
| `api.node.fs` | Node.js `fs` module |
| `api.node.path` | Node.js `path` module |
| `api.node.os` | Node.js `os` module |
| `api.node.process` | The Studio process object |
| `api.node.require` | The CommonJS `require` function |

Plugins may use `api.node.require('some-module')` for modules available to
Studio. This is unrestricted process access, not a sandboxed or isolated API.

## Resource cleanup

Unregister commands and event listeners and close panels when they are no
longer needed. Studio tracks the disposer returned by each registration and
automatically calls it during deactivation/reload. Keep your own cleanup for
resources Studio cannot track, such as timers, observers, sockets, and
listeners you add directly to DOM elements.

```js
let timer;

module.exports = {
  activate(api) {
    timer = setInterval(() => api.notify('Still active'), 60_000);
    api.events.on('project:open', ({ name }) => {
      console.log('Opened project:', name);
    });
  },

  deactivate() {
    clearInterval(timer);
  },
};
```

## Package and install

An `.nbplugin` is a ZIP archive with `plugin.json` at its root. Keep the
manifest, entry point, and runtime files at the archive root; do not put them
inside an extra enclosing directory. You can also install a folder directly
for local development.

Studio currently limits packages to 500 archive entries and 100 MiB of
compressed archive data or expanded content. It rejects encrypted archives,
duplicate paths, absolute/traversal paths, symbolic links, and unsupported
file types.

Optional dependencies should be bundled with the plugin unless they are
available in the Studio process. `main` is loaded using CommonJS `require`.
Node modules required by the plugin must resolve from its installed location
or from the Studio runtime.

## Signature format

Marketplace packages include a root `signature.json`:

```json
{
  "algorithm": "Ed25519",
  "publicKey": "<32-byte raw public key in base64url>",
  "signature": "<Ed25519 signature in base64url>"
}
```

The signature covers UTF-8 bytes of canonical JSON for `{"files":{...}}`.
Each key is a slash-separated package-relative file path, and each value is
that file's lowercase hexadecimal SHA-256 digest. Paths are sorted; JSON object
keys are recursively sorted; and the JSON has no insignificant whitespace.
`signature.json` is excluded from the digest map. Studio accepts only the
pinned NovaByte Trusted Signing public key; self-signed packages are not
verified. Do not create or ship a `signature.json` yourself—marketplace
signatures are created by the publisher service after review.

## Troubleshooting

| Symptom | Check |
|---|---|
| Package will not install | Confirm `plugin.json` is at the package root, the ZIP is not nested in an extra folder, and the archive has no invalid paths, symlinks, encryption, or duplicate entries. |
| Manifest rejected | Validate the ID, SemVer version, existing `main` path, and `engines.studio` range. |
| Plugin does not appear enabled | Installation intentionally leaves the plugin disabled and untrusted. Enable it from **Settings → Plugins** and accept the trust warning. |
| Plugin fails to activate | Confirm `main` exports `activate(api)`, check its dependencies, then inspect the Studio developer console for `[plugins]` errors. |
| Marketplace signature is invalid | Do not edit files in a signed package. Reinstall the original marketplace package; any change to a signed file invalidates its signature. |
| Command or event keeps firing after a change | Return to a fresh plugin activation and ensure plugin-owned timers, DOM listeners, and other untracked resources are cleared in `deactivate()`. |

## Marketplace operations

Publish through the **Studio plugins** section of the NovaByte Store publisher
workflow. Plugin submissions are reviewed separately from NovaByte OS apps;
reviewed package contents are signed by NovaByte before publishing. The
signature badge is an integrity indicator, not a safety certification.