// [NOVAPACK_EDITOR_JS] -- from NovaPack Studio, not NBOSP
'use strict';
/**
 * editor.js — CodeMirror 6 wrapper (Batch 1: tabs, find/replace, settings, preview)
 * Exposes window.CM so app.js (non-module) can call into it.
 */

import { EditorState, Compartment }           from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
         highlightSpecialChars, drawSelection, dropCursor,
         rectangularSelection, crosshairCursor,
         highlightActiveLine }                from '@codemirror/view';
import { defaultKeymap, history,
         historyKeymap, indentWithTab }        from '@codemirror/commands';
import { foldGutter, indentOnInput,
         syntaxHighlighting, defaultHighlightStyle,
         bracketMatching, foldKeymap,
         indentUnit, HighlightStyle }          from '@codemirror/language';
import { search, openSearchPanel,
         closeSearchPanel, SearchQuery,
         setSearchQuery, findNext, findPrevious,
         replaceNext, replaceAll,
         searchKeymap }                        from '@codemirror/search';
import { tags }                                from '@lezer/highlight';
import { javascript }                          from '@codemirror/lang-javascript';
import { css }                                 from '@codemirror/lang-css';
import { html }                                from '@codemirror/lang-html';
import { json }                                from '@codemirror/lang-json';
import { markdown }                            from '@codemirror/lang-markdown';
import { cpp }                                  from '@codemirror/lang-cpp';
import { autocompletion, completionKeymap,
         closeBrackets, closeBracketsKeymap,
         completeAnyWord }                     from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap }      from '@codemirror/lint';
import { MergeView, goToNextChunk as _goToNextChunk, goToPreviousChunk as _goToPreviousChunk } from '@codemirror/merge';
import { tsFacet, tsSync, tsAutocomplete,
         tsLinter }                            from '@valtown/codemirror-ts';

// typescript + @typescript/vfs are Node-context modules (they read real
// files off disk via fs/os/path internals) — loaded via runtime require(),
// not bundled, so esbuild leaves them as real Node modules resolved from
// node_modules at load time. This only works because editor.js runs inside
// NW.js's Node-backed renderer, same context app.js already uses for fs/path.
// See package.json esbuild config: --external:typescript --external:@typescript/vfs
//
// Module.createRequire anchors resolution to the app's start path so that
// require('typescript') works correctly when called from inside an IIFE bundle,
// where there's no __dirname context for Node to walk up from.
// Use globalThis.require so esbuild doesn't intercept the call or try to
// resolve/bundle Node built-ins. NW.js exposes require on globalThis so
// this works fine at runtime while being invisible to esbuild's bundler.
const _nwr = globalThis.require;
const ts  = _nwr('typescript');
const vfs = _nwr('@typescript/vfs');

// ── Language picker ───────────────────────────────────────────────────────
// Recognized languages bring their own keyword/snippet completion source
// (wired automatically via CM's languageData mechanism). Anything else
// — plain text, unknown extensions — gets word-from-buffer completion
// instead of nothing.

const plainTextWordCompletion = EditorState.languageData.of(() => [
  { autocomplete: completeAnyWord },
]);

function langForExt(ext) {
  switch (ext) {
    case '.js': case '.mjs': case '.cjs': case '.ts': case '.jsx': case '.tsx':
      return javascript({ jsx: ext === '.jsx' || ext === '.tsx',
                          typescript: ext === '.ts' || ext === '.tsx' });
    case '.css': return css();
    case '.html': case '.htm': return html();
    case '.json': return json();
    case '.md': case '.markdown': return markdown();
    // Same extension set builder.js's CPP_SOURCE_EXTENSIONS detects for
    // compilation (.cpp/.cc/.cxx/.c), plus header extensions (.h/.hpp) --
    // headers are never compiled directly but are real C/C++ source that
    // should highlight the same way.
    case '.cpp': case '.cc': case '.cxx': case '.c': case '.h': case '.hpp':
      return cpp();
    default: return [plainTextWordCompletion];
  }
}

const tabSizeComp  = new Compartment();
const indentComp   = new Compartment();
const fontSizeComp = new Compartment();
const tsFacetComp  = new Compartment(); // ts/js type-aware completion, per file

// ── TypeScript environment (in-process, no server) ─────────────────────────
// One VirtualTypeScriptEnvironment per project root, reused across every
// open file/tab so cross-file imports resolve against real types. Building
// this is the expensive part (reads node_modules + TS lib files off disk),
// so it's cached — switching tabs within the same project must NOT rebuild it.

const _tsEnvCache = new Map(); // projectRoot -> VirtualTypeScriptEnvironment

function _isTsAwareExt(ext) {
  return ext === '.ts' || ext === '.tsx' || ext === '.js' ||
         ext === '.jsx' || ext === '.mjs' || ext === '.cjs';
}

function _getOrCreateTsEnv(projectRoot) {
  if (_tsEnvCache.has(projectRoot)) return _tsEnvCache.get(projectRoot);

  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,         // let plain .js files get real completions too
    checkJs: false,        // ...but don't lint plain JS as if it were strict TS
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    skipLibCheck: true,    // big speed win — matches what most editors do
  };

  // Lib files (lib.es2022.d.ts etc.) come from the locally installed
  // `typescript` package — no network fetch.
  const fsMap = vfs.createDefaultMapFromNodeModules(compilerOptions, ts);

  // File-system backed System: reads real source files and node_modules
  // straight off disk under projectRoot, same as `tsc` would.
  const system = vfs.createFSBackedSystem(fsMap, projectRoot, ts);

  // rootFiles starts empty — tsSync() registers each opened file as it's
  // mounted/edited, so this grows as the user opens tabs.
  const env = vfs.createVirtualTypeScriptEnvironment(system, [], ts, compilerOptions);

  _tsEnvCache.set(projectRoot, env);
  return env;
}
const wordWrapComp = new Compartment();
const themeComp    = new Compartment();

// ── CSS-variable-driven theme builder ─────────────────────────────────────
// Reads the app's live CSS custom properties from documentElement so the
// editor always matches whatever data-theme is currently active, including
// nb-light (where oneDark would be doubly wrong: dark chrome + dark syntax
// colours on a white background).

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildThemeExt() {
  const bg        = _cssVar('--bg-panel');
  const bgRaised  = _cssVar('--bg-raised');
  const bgHover   = _cssVar('--bg-hover');
  const bgActive  = _cssVar('--bg-active');
  const border    = _cssVar('--border-mid');
  const fg        = _cssVar('--text-primary');
  const fgMid     = _cssVar('--text-mid');
  const fgMuted   = _cssVar('--text-muted');
  const fgFaint   = _cssVar('--text-faint');
  const accent    = _cssVar('--accent');
  const red       = _cssVar('--red');
  const yellow    = _cssVar('--yellow');
  const orange    = _cssVar('--orange');
  const blue      = _cssVar('--blue');

  const cmTheme = EditorView.theme({
    '&': {
      background:    bg,
      color:         fg,
    },
    '.cm-content': {
      caretColor: accent,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: accent,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      background: bgActive,
    },
    '.cm-panels': {
      background: bgRaised,
      color:      fg,
    },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${border}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${border}` },
    '.cm-searchMatch': {
      outline:    `1px solid ${accent}`,
      background: bgHover,
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      background: bgActive,
    },
    '.cm-activeLine': { background: bgHover },
    '.cm-activeLineGutter': { background: bgHover },
    '.cm-gutters': {
      background: bgRaised,
      color:      fgFaint,
      border:     'none',
      borderRight: `1px solid ${border}`,
    },
    '.cm-lineNumbers .cm-gutterElement': { color: fgFaint },
    '.cm-foldPlaceholder': {
      background: bgHover,
      border:     `1px solid ${border}`,
      color:      fgMuted,
    },
    '.cm-tooltip': {
      background: bgRaised,
      border:     `1px solid ${border}`,
      color:      fg,
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: bgActive,
      color:      fg,
    },
  }, { dark: _cssVar('--text-primary').startsWith('#f') || _cssVar('--text-primary').startsWith('#e') });

  const highlight = HighlightStyle.define([
    { tag: tags.keyword,          color: accent },
    { tag: tags.controlKeyword,   color: accent },
    { tag: tags.operatorKeyword,  color: accent },
    { tag: tags.definitionKeyword,color: accent },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: fg },
    { tag: [tags.propertyName, tags.function(tags.variableName)], color: blue },
    { tag: [tags.variableName, tags.labelName], color: fgMid },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: orange },
    { tag: [tags.definition(tags.name), tags.separator], color: fg },
    { tag: [tags.typeName, tags.className, tags.number, tags.changed,
            tags.annotation, tags.modifier, tags.self, tags.namespace], color: yellow },
    { tag: [tags.operator, tags.operatorKeyword, tags.url,
            tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: fgMid },
    { tag: [tags.meta, tags.comment], color: fgMuted, fontStyle: 'italic' },
    { tag: tags.strong,           fontWeight: 'bold' },
    { tag: tags.emphasis,         fontStyle: 'italic' },
    { tag: tags.strikethrough,    textDecoration: 'line-through' },
    { tag: tags.link,             color: blue, textDecoration: 'underline' },
    { tag: tags.heading,          fontWeight: 'bold', color: accent },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: orange },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: red },
    { tag: tags.invalid,          color: red },
  ]);

  return [cmTheme, syntaxHighlighting(highlight)];
}

function tabSizeExt(n)   { return EditorState.tabSize.of(n); }
function indentUnitExt(n){ return indentUnit.of(' '.repeat(n)); }
function fontSizeExt(n)  { return EditorView.theme({ '&': { fontSize: n + 'px !important' } }); }
function wordWrapExt(on) { return on ? EditorView.lineWrapping : []; }

// ── Default settings ──────────────────────────────────────────────────────

const DEFAULT_SETTINGS = { fontSize: 13, tabSize: 2, wordWrap: false };
let _settings = { ...DEFAULT_SETTINGS };

try {
  const saved = localStorage.getItem('cm_settings');
  if (saved) _settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
} catch { /* ignore */ }

function saveSettings() {
  try { localStorage.setItem('cm_settings', JSON.stringify(_settings)); } catch { /* ignore */ }
}

// ── Base extensions ───────────────────────────────────────────────────────

function baseExtensions(onChangeCb, onSaveCb, onCursorChange) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    themeComp.of(buildThemeExt()),
    search({ top: true }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...searchKeymap,
      indentWithTab,
      { key: 'Mod-s', run: () => { onSaveCb(); return true; } },
    ]),
    tabSizeComp.of(tabSizeExt(_settings.tabSize)),
    indentComp.of(indentUnitExt(_settings.tabSize)),
    fontSizeComp.of(fontSizeExt(_settings.fontSize)),
    wordWrapComp.of(wordWrapExt(_settings.wordWrap)),
    closeBrackets(),
    autocompletion(),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...lintKeymap]),
    lintGutter(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeCb();
      if (update.selectionSet && onCursorChange) onCursorChange();
    }),
  ];
}

// ── Single editor view ────────────────────────────────────────────────────

let _view          = null;
let _onSaveCb      = null;
let _onChangeCb    = null;
let _themeObserver = null;

function _destroyView() {
  if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
  if (_view) { _view.destroy(); _view = null; }
}

function _startThemeObserver() {
  _themeObserver = new MutationObserver(() => {
    if (!_view) return;
    _view.dispatch({ effects: themeComp.reconfigure(buildThemeExt()) });
  });
  _themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });
}

function _buildTsExtensions(filePath, ext, projectRoot) {
  if (!projectRoot || !_isTsAwareExt(ext)) return [];
  try {
    const env = _getOrCreateTsEnv(projectRoot);
    return [
      tsFacet.of({ path: filePath, env }),
      tsSync(),
      tsLinter(),
      EditorState.languageData.of(() => [{ autocomplete: tsAutocomplete() }]),
    ];
  } catch (e) {
    // Don't let a broken tsconfig / unreadable node_modules / etc. take
    // down the whole editor — fall back to keyword/word completion only.
    console.warn('[ts] environment setup failed, falling back to basic completion:', e);
    return [];
  }
}

function _createView(host, content, ext, filePath, projectRoot, onChangeCb, onSaveCb, onCursorChange) {
  _destroyView();
  _onSaveCb    = onSaveCb;
  _onChangeCb  = onChangeCb;

  const state = EditorState.create({
    doc: content,
    extensions: [
      ...baseExtensions(onChangeCb, onSaveCb, onCursorChange),
      langForExt(ext),
      tsFacetComp.of(_buildTsExtensions(filePath, ext, projectRoot)),
    ],
  });

  _view = new EditorView({ state, parent: host });
  _startThemeObserver();

  return _view;
}

// ── Public API ────────────────────────────────────────────────────────────

window.CM = {
  get view() { return _view; },
  getValue() {
    return _view ? _view.state.doc.toString() : '';
  },

  setValue(content) {
    if (!_view) return;
    _view.dispatch({
      changes: { from: 0, to: _view.state.doc.length, insert: content },
    });
  },

  // Inserts text at the current selection (replacing it, if any), then
  // places the cursor at the end of the inserted text and scrolls it into
  // view. Used by the "Insert nova: Snippet" command -- deliberately a
  // plain text insert, not a real snippet-with-tabstops system (no
  // placeholder/tab-to-next-field support), since that would need a
  // CodeMirror snippet extension wired in separately.
  insertAtCursor(text) {
    if (!_view) return;
    const { from, to } = _view.state.selection.main;
    const insertPos = from + text.length;
    _view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: insertPos, head: insertPos },
      effects: EditorView.scrollIntoView(insertPos, { y: 'center' }),
    });
    _view.focus();
  },

  focus() { _view?.focus(); },

  // Jump the cursor to a 1-based line number (optionally a column, also
  // 1-based) and scroll it into view. Used by global project search to land
  // on a specific match. No-op if no editor is mounted or the line is out
  // of range for the current document.
  gotoLine(line, column = 1) {
    if (!_view) return;
    const doc = _view.state.doc;
    if (line < 1 || line > doc.lines) return;
    const lineInfo = doc.line(line);
    const col      = Math.max(1, Math.min(column, lineInfo.length + 1));
    const pos      = lineInfo.from + (col - 1);
    _view.dispatch({
      selection: { anchor: pos, head: pos },
      effects:   EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    _view.focus();
  },

  destroy() {
    _destroyView();
    const host  = document.getElementById('cm-editor-host');
    const empty = document.getElementById('editor-empty-state');
    if (host) host.classList.add('hidden');
    empty?.classList.remove('hidden');
  },

  async mount(content, ext, filePath, projectRoot, onChange, onSave, onCursorChange) {
    const host  = document.getElementById('cm-editor-host');
    const empty = document.getElementById('editor-empty-state');
    if (!host) return;
    _destroyView();
    host.innerHTML = '';
    host.classList.remove('hidden');
    empty?.classList.add('hidden');
    await _createView(host, content, ext, filePath, projectRoot, onChange, onSave, onCursorChange);
  },

  // ── Find / Replace ──────────────────────────────────────────────────────

  openFind() { if (_view) openSearchPanel(_view); },
  closeFind() { if (_view) closeSearchPanel(_view); },
  findNext()  { if (_view) findNext(_view); },
  findPrev()  { if (_view) findPrevious(_view); },

  replaceNext(searchTerm, replacement, caseSensitive = false) {
    if (!_view) return;
    _view.dispatch({ effects: setSearchQuery.of(
      new SearchQuery({ search: searchTerm, replace: replacement, caseSensitive })
    )});
    replaceNext(_view);
  },

  replaceAll(searchTerm, replacement, caseSensitive = false) {
    if (!_view) return;
    _view.dispatch({ effects: setSearchQuery.of(
      new SearchQuery({ search: searchTerm, replace: replacement, caseSensitive })
    )});
    replaceAll(_view);
  },

  // ── Settings ────────────────────────────────────────────────────────────

  getSettings() { return { ..._settings }; },

  applySettings(newSettings) {
    _settings = { ..._settings, ...newSettings };
    saveSettings();
    if (!_view) return;
    _view.dispatch({ effects: [
      ...('tabSize' in newSettings
        ? [tabSizeComp.reconfigure(tabSizeExt(_settings.tabSize)),
           indentComp.reconfigure(indentUnitExt(_settings.tabSize))]
        : []),
      ...('fontSize' in newSettings
        ? [fontSizeComp.reconfigure(fontSizeExt(_settings.fontSize))]
        : []),
      ...('wordWrap' in newSettings
        ? [wordWrapComp.reconfigure(wordWrapExt(_settings.wordWrap))]
        : []),
    ]});
  },
};

// ── Diff / merge view ───────────────────────────────────────────────────────
// Separate from window.CM on purpose: a diff comparison isn't a tab, has no
// save/dirty lifecycle, and (usually) both sides are read-only. Reusing the
// singleton _view above would mean either tearing down the user's actual
// open file to show a diff, or bolting a second meaning onto the same state
// — so this gets its own small singleton instead.

let _diffView          = null;
let _diffThemeObserver = null;

function _destroyDiffView() {
  if (_diffThemeObserver) { _diffThemeObserver.disconnect(); _diffThemeObserver = null; }
  if (_diffView) { _diffView.destroy(); _diffView = null; }
}

window.CMDiff = {
  /**
   * Mount a side-by-side diff. Either side can independently be made
   * editable (e.g. "current unsaved buffer vs last saved on disk", where
   * the left/current side should stay editable; "file A vs file B", where
   * both are typically read-only).
   *
   * @param {object} opts
   * @param {string} opts.host        - container element id
   * @param {string} opts.left        - left/"a" side content
   * @param {string} opts.right       - right/"b" side content
   * @param {string} [opts.ext]       - file extension, drives syntax highlighting on both sides
   * @param {boolean} [opts.leftEditable]  - default false (read-only)
   * @param {boolean} [opts.rightEditable] - default false (read-only)
   * @param {function} [opts.onLeftChange] - called with new left-side content on edit, if leftEditable
   */
  mount({ host, left, right, ext = '', leftEditable = false, rightEditable = false, onLeftChange }) {
    const el = document.getElementById(host);
    if (!el) return;
    _destroyDiffView();
    el.innerHTML = '';

    const lang = langForExt(ext);

    const sideExtensions = (editable, onChange) => [
      lineNumbers(),
      highlightSpecialChars(),
      foldGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      lang,
      themeComp.of(buildThemeExt()),
      EditorView.editable.of(editable),
      EditorState.readOnly.of(!editable),
      ...(editable ? [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
      ] : []),
    ];

    _diffView = new MergeView({
      a: { doc: left,  extensions: sideExtensions(leftEditable,  onLeftChange) },
      b: { doc: right, extensions: sideExtensions(rightEditable, null) },
      parent: el,
    });

    _diffThemeObserver = new MutationObserver(() => {
      if (!_diffView) return;
      _diffView.a.dispatch({ effects: themeComp.reconfigure(buildThemeExt()) });
      _diffView.b.dispatch({ effects: themeComp.reconfigure(buildThemeExt()) });
    });
    _diffThemeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
  },

  getLeftValue()  { return _diffView ? _diffView.a.state.doc.toString() : ''; },
  getRightValue() { return _diffView ? _diffView.b.state.doc.toString() : ''; },

  // Jump to the next/previous changed chunk. goToNextChunk/goToPreviousChunk
  // are CodeMirror "commands" (view => boolean) — run against editor A is
  // enough since the merge view keeps both sides vertically aligned.
  goToNextChunk()     { if (_diffView) _goToNextChunk(_diffView.a); },
  goToPreviousChunk() { if (_diffView) _goToPreviousChunk(_diffView.a); },

  destroy() {
    _destroyDiffView();
    const hosts = document.querySelectorAll('[data-cmdiff-host]');
    hosts.forEach(h => h.classList.add('hidden'));
  },
};