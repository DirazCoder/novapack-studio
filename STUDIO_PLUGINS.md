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

## API Level 1: Studio 1.2.31–1.2.33

Studio passes the same `api` object to `activate(api)` and `deactivate(api)`.
Studio 1.2.31–1.2.33 provide API Level 1 (`api.version === 1`). Studio 1.2.34
and later provide API Level 2 (`api.version === 2`), which retains the Level 1
surface and adds the APIs in the API Level 2 section below.

### Metadata and notification

| Member | Description |
|---|---|
| `api.version` | Plugin API version number (`1` in Studio 1.2.31–1.2.33; `2` in Studio 1.2.34 and later). |
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

## API Level 2: Studio 1.2.34+

API Level 2 keeps the Level 1 APIs and adds the following methods. APIs that
touch project files still require an open project. Plugin registrations are
removed when the plugin is deactivated.

### Plugin themes (`api.ui`)

Register a theme in both Studio theme pickers. Theme IDs are namespaced to the
registering plugin (`plugin:{pluginId}:{id}`); only the listed Studio color
tokens and hexadecimal colors are accepted.

```js
const disposeTheme = api.ui.registerTheme({
  id: 'ocean',
  label: 'Ocean',
  swatch: '#22a6b3',
  colors: {
    '--bg-base': '#101b2d',
    '--bg-panel': '#17263d',
    '--bg-raised': '#203450',
    '--accent': '#22a6b3',
    '--accent-hover': '#35c3cc',
    '--on-accent': '#071a1c',
    '--text-primary': '#edf7ff',
    '--text-mid': '#b3c9df',
    '--text-muted': '#829bb5',
    '--text-faint': '#607993',
    '--border': '#2d4662',
    '--border-mid': '#385572',
  },
});
```

| Method | Behavior |
|---|---|
| `api.ui.registerTheme({ id, label, colors, swatch? })` | Registers a theme and returns a disposer. `id` follows the command ID rule; `label` is 1–64 characters. `colors` must contain at least one valid color. Optional `swatch` is a hexadecimal color; by default it uses `colors['--accent']` or `#58a6ff`. |

Supported `colors` keys are `--bg-base`, `--bg-panel`, `--bg-raised`,
`--bg-hover`, `--bg-active`, `--bg-overlay`, `--border`, `--border-mid`,
`--accent`, `--accent-dim`, `--accent-hover`, `--on-accent`,
`--text-primary`, `--text-mid`, `--text-muted`, `--text-faint`, `--red`,
`--yellow`, `--orange`, `--blue`, `--hover-wash`, and
`--hover-wash-strong`. Values must be `#RGB` or `#RRGGBB`, except the two
hover-wash tokens, which also accept `rgba(r, g, b, a)` with RGB channels from
0–255 and alpha from 0–1. Omitted tokens inherit from NovaByte Dark. Themes
are removed on deactivation; if a plugin's theme is active when it is removed,
Studio returns to NovaByte Dark. A selected plugin theme is restored when its
plugin registers it on a later launch.

`api.ui.getThemes()` includes registered plugin themes. Use the returned ID
with `api.ui.setTheme(themeId)` to select one. Registered themes appear in
Studio's theme pickers and in the Command Palette's **Theme** category.

### Persistent plugin storage (`api.storage`)

Storage is JSON-backed and namespaced to the calling plugin. It uses Studio's
local persistence and does not share keys with other plugins.

| Method | Behavior |
|---|---|
| `api.storage.get(key, fallbackValue?)` | Returns the parsed value, or `fallbackValue` (default `undefined`) when the key is missing. Invalid stored JSON throws. |
| `api.storage.set(key, value)` | Stores a JSON-serializable value. Throws for invalid keys, values, or storage errors. |
| `api.storage.delete(key)` | Removes a key and returns whether it existed. |
| `api.storage.keys()` | Returns this plugin's keys in sorted order. |
| `api.storage.clear()` | Removes this plugin's keys only. |

Keys must be non-empty strings of at most 128 characters. Values must be
JSON-serializable; storage quota and browser persistence errors are surfaced
to the caller. Stored data remains after a plugin is disabled or uninstalled;
use `clear()` when the plugin is being removed and its data is no longer needed.

### Native file dialogs (`api.dialogs`)

```js
api.dialogs.openFile({ accept: '.json,.txt' }, (filePath) => {
  api.notify(`Selected ${filePath}`);
});

api.dialogs.openFolder((folderPath) => {
  api.notify(`Selected ${folderPath}`);
});
```

| Method | Behavior |
|---|---|
| `api.dialogs.openFile(options, callback)` | Opens Studio's native file picker. `options.accept` is an optional file-accept filter string. Calls `callback(absolutePath)` when a file is selected. |
| `api.dialogs.openFile(callback)` | Same as above with no filter. |
| `api.dialogs.openFolder(callback)` | Opens Studio's native folder picker and calls `callback(absolutePath)` when a folder is selected. |

The callback is not called when the picker is canceled. Picker errors are
reported by Studio. These APIs select existing files or folders; they do not
provide a save-file dialog.

### Clipboard (`api.clipboard`)

| Method | Behavior |
|---|---|
| `await api.clipboard.readText()` | Reads clipboard text; rejects if clipboard access is unavailable or denied. |
| `await api.clipboard.writeText(text)` | Writes a string to the clipboard; rejects if clipboard access is unavailable or denied. |

Clipboard access follows the host runtime's permission and user-gesture rules.

### System information (`api.system`)

`api.system.getInfo()` returns a new snapshot:

```js
{
  platform: 'win32',        // Node.js process.platform
  architecture: 'x64',     // Node.js process.arch
  release: '10.0.0',       // operating-system release
  studioVersion: '1.2.34',
  nodeVersion: '...'
}
```

This intentionally exposes only platform and version information, not
environment variables or process arguments.

### Workspace integration (`api.workspace`)

| Method | Behavior |
|---|---|
| `api.workspace.getState()` | Returns a snapshot `{ activeView, views, activeFile, openFiles }`. |
| `api.workspace.switchView(viewId)` | Activates a built-in or registered plugin view; returns whether it became active. |
| `api.workspace.openFile(relativePath)` | Opens a file in the current project using the same behavior as `api.project.openFile()`. |
| `api.workspace.saveAll()` | Saves dirty editor tabs and returns whether all tabs are clean afterward. |
| `api.workspace.focusEditor()` | Focuses the current editor if it is mounted. |

### Additional project helpers (`api.project`)

These are convenience methods in addition to the Level 1 project file APIs.
They use the same project boundary checks.

| Method | Behavior |
|---|---|
| `api.project.getAbsolutePath(relativePath)` | Resolves a project-relative path to an absolute path, rejecting paths or symlinks outside the open project. |
| `api.project.getRelativePath(absolutePath)` | Returns a slash-separated project-relative path. Rejects non-absolute paths and paths outside the open project. |
| `api.project.readJson(relativePath)` | Reads and parses a project JSON file; file and parse errors are thrown. |
| `api.project.writeJson(relativePath, value)` | Writes a JSON-serializable value as two-space-indented JSON with a trailing newline. Creates parent directories as needed. |

### Command discovery and execution (`api.commands`)

| Method | Behavior |
|---|---|
| `api.commands.getCommands()` | Returns visible command descriptors `{ id, label, description, category, shortcut }`, including built-in and plugin commands. Visibility predicates are evaluated while listing. |
| `await api.commands.execute(id)` | Executes a visible registered Studio command and resolves to `true`; returns `false` if its `when` predicate currently hides it. Throws for an unknown command. Plugin command handlers are invoked through Studio's normal command wrapper. |

Use the full ID returned by `getCommands()` when executing a command. Plugin
commands are namespaced as `plugin:{pluginId}:{commandId}`.

### Project lifecycle and file operations (`api.project`)

In addition to the Level 1 project methods:

| Method | Behavior |
|---|---|
| `api.project.getRoot()` | Alias for `getDirectory()`. |
| `await api.project.saveManifest()` | Saves the current project's manifest using Studio's normal validation and UI flow. Throws if no project is open. |
| `await api.project.close()` | Closes the current project. If editor tabs are dirty, asks before discarding. Resolves `true` when closed and `false` if canceled or already closed. |
| `api.project.findFiles({ include = ['**/*'], exclude = [] })` | Returns project-relative files matching any include glob and no exclude glob. `*` matches within a path segment, `?` matches one non-slash character, and `**` spans directories. |
| `api.project.readText(path)` / `readBuffer(path)` | Convenience UTF-8 string and Buffer readers. |
| `api.project.writeText(path, text)` / `writeBuffer(path, bytes)` | Convenience writers; create parent directories and emit `project:file-change`. |
| `api.project.createFile(path, contents = '')` | Creates a new file without overwriting an existing file; returns its project-relative path. |
| `api.project.createDirectory(path)` | Creates a directory and missing parents. |
| `api.project.copy(source, destination, { overwrite = false })` | Copies a project file or directory recursively. Rejects copying a directory into itself and an existing destination unless `overwrite` is true. |
| `api.project.move(source, destination, { overwrite = false })` | Moves a project file or directory. Rejects moving a directory into itself and an existing destination unless `overwrite` is true. |
| `api.project.rename(path, newName)` | Renames a file or directory within its current parent. `newName` cannot contain path separators, and the destination must not exist. |
| `api.project.watch(path, listener)` | Watches an existing file or directory. Listener receives `{ path, eventType }`; returns a disposer. Watchers are closed on plugin deactivation. |
| `api.project.onOpen(listener)` / `onClose(listener)` / `onChange(listener)` | Event-subscription shortcuts for `project:open`, `project:close`, and `project:file-change`. Return unsubscribe functions. |

Project file change details have the shape
`{ path, eventType, source? }`. `path` is slash-separated and project-relative;
`source` is the plugin ID for changes made through these API methods and is
omitted for changes detected by Studio's filesystem watcher. Filesystem watch
notifications are platform-dependent and may be coalesced or omitted by the
operating system.

### Workspace and application (`api.workspace`, `api.app`)

`api.workspace.getState()` returns a point-in-time snapshot. Additional
workspace methods are:

| Method | Behavior |
|---|---|
| `api.workspace.getActiveView()` | Returns the current built-in or plugin view ID. |
| `api.workspace.getViews()` | Returns all built-in and registered plugin view IDs. |
| `api.workspace.getTabs()` | Alias for `api.files.getOpenFiles()`. |
| `api.workspace.getActiveTab()` | Alias for `api.files.getActiveFile()`. |
| `api.workspace.closeFile(relativePath)` | Alias for `api.files.close(relativePath)`. |
| `api.workspace.revealFile(relativePath)` | Scrolls a project file into view in the explorer and returns whether its row was found. |
| `api.workspace.refreshExplorer()` | Re-renders the file explorer for the current project. |
| `api.workspace.onViewChange(listener)` / `onTabChange(listener)` | Subscribe to `view:change` or `tab:change`; return unsubscribe functions. |

`api.app.getState()` returns `{ screen, projectDirectory, projectName,
activeView, theme, building }`. `await api.app.openProject(directory)` asks
Studio to open a directory and resolves `true` if it is now the current
project, or `false` if the request was canceled. Invalid directories throw.

### Settings, dialogs, and UI controls

`api.settings.get()` and `api.settings.set(values)` alias
`api.ui.getSettings()` and `api.ui.setSettings(values)`. Settings are limited
to `theme`, `density`, and `glassEffects`; unsupported keys throw.

| Method | Behavior |
|---|---|
| `await api.ui.showMessage({ title?, message, actions? })` | Shows a message. Without actions it resolves to `null` after dismissal. With up to four `{ id, label }` actions, resolves to the selected ID or `null` if dismissed. |
| `api.ui.createProgress({ title?, message?, percentage? })` | Creates a status-bar progress item. Returns `{ update({ title?, message?, percentage? }), dispose() }`; percentage must be from 0 to 100. |
| `api.ui.registerStatusBarItem(options)` | Alias for `api.statusBar.registerItem(options)`. |
| `api.ui.registerContextMenuItem(target, options)` | Alias for `api.contextMenus.registerItem(target, options)`. |

`api.statusBar.registerItem({ id, text, tooltip?, onClick?, priority? })`
adds a status-bar item and returns `{ element, update({ text?, tooltip? }),
dispose() }`. IDs are unique per plugin; text is limited to 100 characters.
The optional click handler receives the plugin API. Higher `priority` values
place items later in the status bar's CSS order.

`api.contextMenus.registerItem(target, { id, label, when?, action })` adds an
item to the existing Studio context menu and returns a disposer. `target` is
`editor`, `editor-tabs`, `file-tree`, or `workspace`. The optional synchronous
`when()` predicate controls visibility. `action(context, api)` receives
`{ x, y, targetPath, activeFile }`; paths may be `null` when the context is not
a file. The action may be async; failures are logged. Plugin items are removed
on deactivation.

### Native dialogs, clipboard, and system integration

| Method | Behavior |
|---|---|
| `api.dialogs.openFiles(options, callback)` | Opens a multi-file picker; callback receives an array of selected absolute paths. Optional `options.accept` is a file filter. |
| `api.dialogs.saveFile({ defaultPath?, accept? }, callback)` | Opens a save picker; callback receives the chosen absolute path. |
| `await api.dialogs.confirm(message, options?)` | Shows Studio's confirmation dialog and resolves to a boolean. |
| `await api.dialogs.prompt(message, defaultValue?, options?)` | Shows Studio's prompt and resolves to the entered string or `null` when canceled. |
| `api.system.getPaths()` | Returns `{ dataDirectory, pluginDirectory, cacheDirectory, projectDirectory }`; the project directory is `null` when no project is open. |
| `await api.system.openExternal(url)` | Opens only `http:`, `https:`, or `mailto:` URLs in the system handler. Unsupported URLs or unavailable host integration throw. |
| `api.system.revealPath(absolutePath)` | Reveals an existing absolute path in the system file manager. Throws for missing paths or unavailable host integration. |

Native picker callbacks are not invoked on cancellation. Picker and host
integration failures are reported by rejection or a thrown error rather than
returning a fabricated path. `api.clipboard.readText()` and `writeText(text)`
are asynchronous and may reject if clipboard permissions or user-gesture
requirements are not met.

### Build progress and history (`api.build`)

`api.build.run({ outDir?, clean? })` accepts only these options. `outDir` is
resolved relative to the project directory unless absolute; `clean` overrides
the Build view's clean-output setting. Studio refuses to clean an output
directory that contains the project. Resolves to `{ success: true,
outputFile }` or `{ success: false, error }` for build failures and early
exits.

| Method | Behavior |
|---|---|
| `api.build.getState()` | Returns `{ building, progress, projectDirectory }`. |
| `api.build.getHistory()` | Returns a copy of the Studio build-history entries. |
| `api.build.onProgress(listener)` | Subscribes to `build:progress`; listener receives `{ projectDirectory, progress, phase }`. Returns an unsubscribe function. |

Progress is approximate during compilation and reaches 100 only on success.
Lifecycle events are `build:start`, `build:progress`, `build:log`,
`build:complete`, and `build:error`; see the event table below.

### Templates, permissions, and packages

`api.templates.list({ includeUser = false, includeCommunity = false })`
returns `{ id, name, description, source }` entries. Built-in templates are
always included; local user and verified community templates are opt-in.
`api.templates.create({ targetDir, template = 'blank', manifest?, appsRoot? })`
creates a project and returns the template creator's result. `targetDir` is
required; when supplied, `appsRoot` must contain the target. Unknown built-in
templates return a failure result; invalid option shapes throw.

The permission catalog is read-only:

| Method | Behavior |
|---|---|
| `api.permissions.list()` | Returns copies of permission descriptors `{ id, label, risk, description }`. |
| `api.permissions.get(id)` | Returns a descriptor copy or `null`. |
| `api.permissions.forAction(action)` | Returns permission IDs for a Nova action/channel, including supported legacy aliases. |

Additional package inspection methods:

| Method | Behavior |
|---|---|
| `api.packages.validate(packagePath)` | Inspects a package and validates its manifest; returns validation fields plus `{ format, manifest }`. Inspection errors throw. |
| `api.packages.getManifest(packagePath)` | Returns the inspected package manifest. |
| `api.packages.listFiles(packagePath)` | Returns the inspected package's file path list. |

### Git integration (`api.git`)

Git methods operate on the open project's detected repository. They reject
when no Git repository is open; commands are invoked with argument arrays,
not through a shell.

| Method | Behavior |
|---|---|
| `await api.git.getStatus()` | Returns `{ root, files }`, where each file is `{ path, code }` and paths are repository-relative. |
| `await api.git.getDiff({ path?, staged? })` | Returns the diff text. `path` is project-relative and boundary-checked; `staged` selects the index diff. |
| `await api.git.getBranches()` | Returns the branch list loaded by Studio's Git integration. |
| `await api.git.getHistory({ limit = 50 })` | Returns `{ hash, subject, author, date }` commits; `limit` must be an integer from 1 to 200. |
| `api.git.onStatusChange(listener)` | Subscribes to `git:status`; returns an unsubscribe function. |

### Events, editor helpers, and disposables

API Level 2 adds these event names to `api.events.on(name, listener)`:

| Event | Detail |
|---|---|
| `project:close` | `{ directory, name }` for the project being closed. |
| `project:change` | `{ previousDirectory, directory, name }`, emitted when switching from one project to another. |
| `project:file-change` | `{ path, eventType, source }` for changes reported through plugin project APIs. |
| `project:manifest-save` | `{ directory, manifest, path }` after Studio saves the manifest. |
| `editor:selectionChange` | `{ path, anchor, head, from, to, text, cursor }`; offsets are zero-based, and `cursor` has 1-based line and column. |
| `settings:change` | `{ previous, current }` for settings updates, or `{ uiDensity, previous }` when only density changes. |
| `build:progress` | `{ projectDirectory, progress, phase }`. |
| `git:status` | `{ root, isRepository, files }`; each file is `{ path, code }`. `root` is `null` and `files` is empty when there is no repository. |

The existing `api.editor` object also gains `format()`, `onChange(listener)`,
`onSelectionChange(listener)`, and `showDiagnostics(diagnostics)`.
`onChange` and `onSelectionChange` return unsubscribe functions. The
underlying `window.CM` wrapper adds `getState()`, `getSelection()`,
`setSelection({ anchor, head? })`, `getCursor()`, `setCursor(offsetOrPosition)`,
and `replaceRange(text, { from, to })`. Offsets are zero-based UTF-16 document
offsets; cursor `{ line, column }` coordinates are one-based. Invalid ranges
throw; methods that change selection or text return `false` if no editor is
mounted. `setSelection` and `replaceRange` focus the editor.

`api.disposables.create()` creates a group with `add(dispose)`, `clear()`,
`dispose()`, and read-only `size`. Cleanup runs in reverse registration order.
Adding to a disposed group immediately invokes the disposer. `clear()` attempts
all disposers and throws an `AggregateError` if any fail. Groups are disposed
automatically when the plugin is deactivated.

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