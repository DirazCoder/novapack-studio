<div align="center">

<div><img src="./logo.svg" width="100" height="100" alt="NovaByte Logo" /></div>

<div><img src="https://img.shields.io/badge/NovaByte_Studio-v1.2.01-22c55e?style=for-the-badge" alt="NovaByte Studio"/></div>

# NovaByte Studio

**A desktop IDE for building and packaging `.novaapp` applications for NovaByte OS and compatible NBOSP systems.**

<br>

[![NBOSP Compatible](https://img.shields.io/badge/NBOSP-Compatible-22c55e?style=flat-square)](https://github.com/NovaByteOfficial/novapack-studio)
[![Node](https://img.shields.io/badge/Node.js-26+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-22c55e?style=flat-square)](#)
[![Downloads](https://img.shields.io/badge/Download-Releases-22c55e?style=flat-square)](https://github.com/NovaByteOfficial/novapack-studio/releases)
[![License](https://img.shields.io/badge/License-Apache--2.0-22c55e?style=flat-square)](./LICENSE)

<br>

[**Getting Started**](#getting-started) · [**Templates**](#available-templates) · [**Build from source**](#build-from-source) · [**.novaapp Guide**](./NOVAAPP.md)

</div>

---

> ### ⚠️ Read this before you build anything
>
> These app-development rules prevent common first-build and install failures:
>
> 1. **Reference your script, never inline it.** In `index.html`, use `<script src="app.js" defer></script>` — a local relative path to a sibling file. An inline `<script>...code...</script>` block with actual code inside it is flagged by the install-time content scanner and **blocks install outright, no exceptions.** See the [Content Scanner guidance in the `.novaapp` guide](./NOVAAPP.md#content-scanner--avoiding-false-positives-on-install).
> 2. **No DOM-ready wrapper is needed for packaged scripts.** The NovaByte host defers external scripts in the packaged entry HTML until parsing completes, so ordinary DOM lookups in `app.js` can find elements declared in the page. Dynamically created scripts or documents retain normal browser timing.

---

## What is NovaByte Studio

NovaByte Studio is a desktop IDE (built on NW.js) for creating, building, and packaging `.novaapp` applications. It gives you a GUI to scaffold new projects from templates, edit your code with a full-featured CodeMirror 6 editor, manage your manifest and permissions, build your package, and inspect the output — all without touching a CLI.

Studio creates `.novaapp` packages for NovaByte OS and compatible NBOSP systems. See the [separate `.novaapp` guide](./NOVAAPP.md) for the manifest, runtime APIs, permissions, and package format.

---

## Download

NovaByte Studio is available for Windows, macOS, and Linux. Download the latest release for your platform from the [Releases](https://github.com/NovaByteOfficial/novapack-studio/releases) page, extract the archive, and run the executable — no install required.

### Build from source

Run `npm install` once, then use `npm run build` to build all platforms. To build only selected platforms, pass one or more flags:

```sh
npm run build -- --win
npm run build -- --mac
npm run build -- --linux
npm run build -- --win --linux
```

The flags also accept `--windows` and `--macos` aliases. A platform-specific build replaces only that platform's output under `dist/`; other platform builds are left untouched. Run `npm run build -- --help` to see usage.

---

## Getting Started

### Prerequisites

- Basic HTML, CSS, and JavaScript knowledge
- For the `native-cpp` template only: [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) (`emcc`) on your PATH. Studio doesn't bundle a compiler — Build fails with install instructions if `emcc` isn't found, rather than silently skipping the C++ source. This path is verified in CI on Windows, Linux, and macOS.

### Supported languages

| Language | How it runs | Notes |
|----------|-------------|-------|
| JavaScript | Native — runs as-is in the webview | No build step required |
| HTML | Native — runs as-is in the webview | No build step required |
| CSS | Native — runs as-is in the webview | No build step required |
| TypeScript | Editor-only (intellisense/type-checking) | Not compiled or transpiled by Build — write plain JS for anything that ships |
| C/C++ | Compiled to WebAssembly via `emcc` at Build time | Requires Emscripten on your PATH; see Prerequisites and the `native-cpp` template |

### Available templates

| Template | Description |
|----------|-------------|
| `blank` | Empty shell — start from scratch |
| `webapp` | Pins one external site as its own app — fixed URL, no address bar or navigation |
| `browser` | URL bar with back, forward, and reload — a real navigable browser view |
| `utility` | File-access tool using NovaByte's virtual filesystem |
| `game` | Game loop skeleton with canvas rendering |
| `dashboard` | Data widget grid with live update pattern |
| `form` | Structured form that saves entries via NovaByte's virtual filesystem |
| `markdown-viewer` | Live markdown preview using a bundled vendor library |
| `chat` | Message list with input — client-side state, no permissions needed |
| `native-cpp` | C++ compiled to WebAssembly, UI in HTML/CSS/JS — requires `emcc` (see Prerequisites) |

### Bundled external dependencies (`vendor/`)

Every new project includes a `vendor/` directory. Drop single-file libraries there (JS or CSS) and they are bundled automatically when you Build — no CDN required.

```
vendor/
  marked.min.js
  chart.min.js
```

Reference them in your HTML as:

```html
<script src="vendor/marked.min.js" defer></script>
```

Only copy the final built/minified file you need — don't copy entire `node_modules` folders.

### Excluding files from the build (`.studioignore`)

Add a `.studioignore` file to your project root to exclude files/folders from packaging without deleting them from disk — build logs, local test fixtures, secrets you don't want bundled, anything you're keeping around locally but don't want shipped in the `.novaapp`.

Syntax is `.gitignore`-style (globs, `!` negation, `#` comments):

```
# ignore build logs entirely
logs/

# ignore any .env file anywhere in the project
*.env

# but keep this one specific env file
!config/required.env
```

`.studioignore` itself is never packaged — dotfiles are already excluded from every build regardless.

**No exemptions, same as `.gitignore`:** there's no protected list of "important" files. If a pattern matches your `manifest.json`, your entry HTML file, or anything else the app needs to run, it gets excluded and your build breaks — that's expected behavior, not a bug to report. Write patterns carefully.

---

## Editor

NovaByte Studio includes a full-featured CodeMirror 6 editor with:

- **Multi-tab editing** — VS Code-style pinned/preview tabs with dirty indicators
- **Syntax highlighting** — JavaScript, TypeScript, HTML, CSS, JSON, Markdown and more
- **TypeScript intellisense** — in-process type-aware completion and linting via `@typescript/vfs` (no server required)
- **Find / Replace** — search panel with next/previous/replace/replace-all
- **Diff / merge view** — side-by-side file comparison, including unsaved changes vs disk
- **Image preview** — inline preview for PNG, JPG, SVG, WebP, ICO
- **HTML Preview** — split-pane live preview for HTML files with `<base>` injection for relative URLs
- **Settings** — configurable font size, tab size, and word wrap, persisted per-user
- **Git integration** — file tree badges for modified, added, deleted, and untracked files; branch switching and commit panel
- **Context menu** — rename, duplicate, delete, new file/folder, compare files
- **Command palette** — quick access to every action (`Ctrl+Shift+P`)
- **Quick open** — jump to any file (`Ctrl+P`)
- **Global search** — search across all files in the project with match highlighting
- **Workspaces** — save and restore open file sets per project
- **Build history** — persisted build log with success/failure status, timestamps, and re-run
- **Syntax check** — esbuild-powered JS syntax validation with line-precise error reporting
- **Package Inspector** — drop a `.novaapp` to inspect manifest, files, signature validity, and permission audit (declared vs detected `nova:*` actions)
- **Update checker** — GitHub Releases API integration with semver badge and changelog modal
- **Resizable file tree rail** — drag to resize, collapse/expand, persisted width
- **Pinned recent projects** — pin frequently-used projects to the top of the recents list
- **Drag-and-drop file tree** — drag files/folders to reorganize your project structure directly in the sidebar
- **Real-time file tree** — the sidebar tree updates automatically as files change on disk
- **Permission tooltips** — hover any permission in the Permissions tab or in `manifest.json` to see its risk level and description
- **Clean last build toggle** — automatically wipe the output `dist/` folder before each build from the Build tab
- **Autosave** — configurable autosave for manifest.json and editor files: off, real-time (on change), built-in intervals (5s / 15s / 30s / 60s), or a custom interval

### Themes

Eight total themes: seven built-in presets — NovaByte Dark, NovaByte Light, Midnight Blue, Amber, Nightshade, High Contrast, and Forest — plus a fully custom theme editor with per-CSS-variable color pickers and JSON import/export.

### Autosave

Studio includes flexible autosave options for both `manifest.json` and editor files. Choose from:

- **Off** — manual save only (`Ctrl+S` / `Cmd+S`)
- **Real-time** — save automatically on every change (debounced by 500ms)
- **Built-in intervals** — auto-save every 5 seconds, 15 seconds, 30 seconds, or 60 seconds
- **Custom interval** — set any interval you prefer (in seconds)

Autosave state is persisted per-user and applies to all projects.

---

## .novaapp documentation

Manifest fields, runtime APIs, permissions, security guidance, package format, and distribution are documented separately in the [`.novaapp` App Development Guide](./NOVAAPP.md).

## License

NovaByte Studio is licensed under the [Apache License, Version 2.0](./LICENSE).
