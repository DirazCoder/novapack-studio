// [NOVAPACK_DESIGN_PRO_JS] -- NovaByte Studio Design-Pro extension
// Adds: deep layout controls, IPC action binding, native component library,
// theme/animation inspector, and developer safeguards (AST diff, code-sync).
// Loaded as a sibling script to app.js. Exposes window.NBPro.
'use strict';

(function () {
  if (window.NBPro) return; // idempotent

  // ── Module-local shortcuts to app.js globals ──────────────────────────────
  // Resolved lazily so load-order differences (script tag order vs. deferred
  // boot) don't break the module: app.js may not have defined every helper
  // yet at the moment design-pro.js is evaluated.
  const $ = (id) => document.getElementById(id);
  const _app = () => window; // app.js lives in the same window context
  const _state = () => (window.state || null);
  const _fs = () => (typeof require === 'function' ? require('fs') : null);
  const _path = () => (typeof require === 'function' ? require('path') : null);

  function _showToast(msg) {
    if (typeof window.showToast === 'function') return window.showToast(msg);
    // Fallback: console + a brief banner if showToast isn't available yet
    // (e.g. during early init).
    console.log('[NBPro]', msg);
  }

  function _noteOwnSourceWrite() {
    if (typeof window._nbproNoteOwnWrite === 'function') window._nbproNoteOwnWrite();
  }

  function _switchTab(name) {
    if (typeof window.switchTab === 'function') return window.switchTab(name);
    const btn = document.querySelector(`.tab[data-tab="${name}"]`);
    btn?.click();
  }

  // ── Manifest helpers (read/write with the same shape app.js uses) ─────────
  function _readProjectManifest() {
    const s = _state();
    if (!s || !s.projectDir) return null;
    const fs = _fs();
    if (!fs) return null;
    const p = _path();
    const candidates = ['manifest.json', 'novaapp.json'];
    for (const name of candidates) {
      const fp = p.join(s.projectDir, name);
      if (fs.existsSync(fp)) {
        try {
          return { path: fp, data: JSON.parse(fs.readFileSync(fp, 'utf8')) };
        } catch { /* corrupt; let the caller fall back */ }
      }
    }
    return null;
  }

  function _writeProjectManifest(data) {
    const s = _state();
    if (!s || !s.projectDir) return false;
    const fs = _fs(), p = _path();
    if (!fs || !p) return false;
    const candidates = ['manifest.json', 'novaapp.json'];
    for (const name of candidates) {
      const fp = p.join(s.projectDir, name);
      if (fs.existsSync(fp)) {
        try {
          fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
          return true;
        } catch (err) {
          _showToast('Could not save manifest: ' + err.message);
          return false;
        }
      }
    }
    // No existing manifest — write manifest.json
    try {
      fs.writeFileSync(p.join(s.projectDir, 'manifest.json'),
        JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      _showToast('Could not save manifest: ' + err.message);
      return false;
    }
  }

  function _readIndexHtml() {
    const s = _state();
    if (!s || !s.projectDir) return null;
    const fs = _fs(), p = _path();
    if (!fs || !p) return null;
    const projectFiles = window._designGetProjectFiles?.();
    const fp = projectFiles?.html;
    if (!fp) return null;
    try { return { path: fp, text: fs.readFileSync(fp, 'utf8') }; }
    catch (err) {
      _showToast(`Could not read entry HTML "${p.relative(s.projectDir, fp)}": ${err.message}`);
      return null;
    }
  }

  function _readStyleCss() {
    const s = _state();
    if (!s || !s.projectDir) return null;
    const fs = _fs(), p = _path();
    if (!fs || !p) return null;
    const linked = window._designGetProjectFiles?.()?.stylesheets || [];
    const files = [];
    for (const fp of linked) {
      try { files.push({ path: fp, text: fs.readFileSync(fp, 'utf8') }); }
      catch (err) {
        _showToast(`Could not read linked stylesheet "${p.relative(s.projectDir, fp)}": ${err.message}`);
        return null;
      }
    }
    return files.length
      ? { path: files[0].path, text: files.map((file) => file.text).join('\n'), files }
      : null;
  }

  function _readAppJs() {
    const s = _state();
    if (!s || !s.projectDir) return null;
    const fs = _fs(), p = _path();
    if (!fs || !p) return null;
    const linked = window._designGetProjectFiles?.()?.scripts || [];
    const scripts = [];
    for (const fp of linked) {
      try { scripts.push({ path: fp, text: fs.readFileSync(fp, 'utf8') }); }
      catch (err) {
        _showToast(`Could not read linked script "${p.relative(s.projectDir, fp)}": ${err.message}`);
        return null;
      }
    }
    if (!scripts.length) return null;
    const score = (file) => /^(?:app|main|index)(?:\.[^.]+)?$/i.test(p.basename(file.path)) ? 0 : 1;
    scripts.sort((a, b) => score(a) - score(b) || linked.indexOf(a.path) - linked.indexOf(b.path));
    return { ...scripts[0], files: scripts };
  }

  function _writeCssUpdates(cssFile, updates) {
    const fs = _fs();
    if (!fs || !cssFile?.files?.length) return false;
    const originals = new Map(cssFile.files.map((file) => [file.path, file.text]));
    const written = [];
    try {
      for (const [filePath, text] of updates) {
        if (!originals.has(filePath)) throw new Error('Refusing to write a stylesheet not linked by the entry HTML.');
        written.push(filePath);
        fs.writeFileSync(filePath, text, 'utf8');
      }
      _noteOwnSourceWrite();
      return true;
    } catch (err) {
      const rollbackErrors = [];
      for (const filePath of written.reverse()) {
        try { fs.writeFileSync(filePath, originals.get(filePath), 'utf8'); }
        catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); }
      }
      const suffix = rollbackErrors.length ? ` Rollback incomplete: ${rollbackErrors.join('; ')}` : '';
      _showToast(`Could not write linked stylesheet: ${err.message}.${suffix}`);
      return false;
    }
  }

  // ── postMessage bridge into the design iframe ─────────────────────────────
  function _postFrame(msg) {
    const frame = $('design-frame');
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      Object.assign({ source: 'nb-design-host' }, msg), '*'
    );
  }

  // Selected-element path kept in sync with app.js's _designSelectedPath.
  // We don't manage this state ourselves; we just listen to selection events
  // forwarded from the design iframe (the same 'select' messages app.js's
  // initDesignTab() already routes) and snapshot the path.
  let _proSelected = null; // { path:[..], tag, id, className, raw }
  let _proPendingAction = null; // { path, actionId } — unsaved dropdown pick, cleared on apply/unbind/reselect
  let _proPendingParams = null;

  // ── Persisted NBPro state (independent of app.js's storage key) ───────────
  const _PRO_STORAGE_KEY = 'novapack_design_pro_state';
  let _proState = {
    dpiPreset: null,            // '1280x800' | '1920x1080' | '400x300' | null
    dpiScale: 1,                // 1, 1.25, 1.5, 2
    showGridMatrix: false,
    showFlexGizmos: true,
    showPermBadges: true,
    themePreset: null,          // 'dark'|'light'|'midnight'|'amber'|null
    customComponents: [],       // [{ id, name, html, defaultProps }]
    bindings: [],               // [{ elementPath, action, eventId, perm }]
    diffPreviewEnabled: false,
    astHighlightColor: '#22c55e',
  };

  function _loadProState() {
    try {
      const raw = localStorage.getItem(_PRO_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        throw new Error('saved Design state must be an object');
      }
      const validPresets = new Set(DPI_PRESETS.map((preset) => preset.id));
      const validScales = new Set(DPI_SCALES.map((scale) => scale.id));
      const validThemes = new Set(['nb-dark', 'nb-light', 'midnight-blue', 'amber']);
      const validBindings = Array.isArray(saved.bindings)
        ? saved.bindings.filter((binding) => {
            if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
                typeof binding.elementPath !== 'string' ||
                !/^\d+(?:\.\d+)*$/.test(binding.elementPath) ||
                (binding.orphaned != null && typeof binding.orphaned !== 'boolean') ||
                (binding.targetId != null && (typeof binding.targetId !== 'string' ||
                  !/^nb-\d+(?:-\d+)*$/.test(binding.targetId))) ||
                typeof binding.action !== 'string' || !_IPC_ACTION_MAP[binding.action]) return false;
            const schema = _IPC_ACTION_MAP[binding.action].params;
            return Object.entries(binding.params || {}).every(([key, value]) => {
              const expected = schema[key];
              return expected !== undefined && (typeof expected === 'boolean'
                ? typeof value === 'boolean' || value === 'true' || value === 'false'
                : Array.isArray(expected)
                  ? Array.isArray(value) && value.every((item) => typeof item === 'string')
                  : typeof value === 'string');
            });
          }).slice(0, 1000)
        : [];
      _proState = {
        ..._proState,
        dpiPreset: saved.dpiPreset === null || validPresets.has(saved.dpiPreset) ? saved.dpiPreset : null,
        dpiScale: validScales.has(saved.dpiScale) ? saved.dpiScale : 1,
        showGridMatrix: typeof saved.showGridMatrix === 'boolean' ? saved.showGridMatrix : _proState.showGridMatrix,
        showFlexGizmos: typeof saved.showFlexGizmos === 'boolean' ? saved.showFlexGizmos : _proState.showFlexGizmos,
        showPermBadges: typeof saved.showPermBadges === 'boolean' ? saved.showPermBadges : _proState.showPermBadges,
        themePreset: saved.themePreset === null || validThemes.has(saved.themePreset) ? saved.themePreset : null,
        diffPreviewEnabled: typeof saved.diffPreviewEnabled === 'boolean' ? saved.diffPreviewEnabled : false,
        astHighlightColor: /^#[\da-f]{6}$/i.test(saved.astHighlightColor || '')
          ? saved.astHighlightColor : '#22c55e',
        customComponents: Array.isArray(saved.customComponents)
          ? saved.customComponents.filter((component) =>
            component && typeof component === 'object' &&
            /^c_[\w-]{1,80}$/.test(component.id || '') &&
            typeof component.name === 'string' && component.name.length <= 100 &&
            typeof component.html === 'string' && component.html.length <= 100000 &&
            (component.css == null || (typeof component.css === 'string' && component.css.length <= 100000)) &&
            (component.props == null || (Array.isArray(component.props) &&
              component.props.length <= 50 && component.props.every((prop) => typeof prop === 'string')))
          ).slice(0, 100)
          : [],
        bindings: validBindings,
      };
    } catch (err) {
      console.warn('[NBPro] Could not load saved Design state:', err);
      _showToast('Saved Design settings are invalid and were reset.');
    }
  }

  function _saveProState() {
    try { localStorage.setItem(_PRO_STORAGE_KEY, JSON.stringify(_proState)); }
    catch (err) {
      console.warn('[NBPro] Could not save Design state:', err);
      _showToast('Could not save Design settings: ' + err.message);
    }
  }

  // ── Inject extra runtime script into the design iframe ────────────────────
  // The design iframe is loaded via srcdoc by app.js's _designLoadFrame(),
  // which already injects a base script. We add ours by listening for the
  // iframe's 'load' event and injecting a <script> tag — the iframe is
  // same-origin (file://) and sandbox=allow-scripts, so this works.
  let _proRuntimeInjectedFor = null;
  function _injectProRuntime() {
    const frame = $('design-frame');
    if (!frame?.contentWindow?.document) return;
    if (_proRuntimeInjectedFor === frame) return; // already wired for this iframe instance
    _proRuntimeInjectedFor = frame;

    const doc = frame.contentWindow.document;
    const s = doc.createElement('script');
    // Mark synthetic so app.js's computePath() skips it as a sibling --
    // otherwise it counts as a real body child that never existed in
    // index.html on disk, offsetting every path computed after it by one
    // (surfaces as "selection out of sync" once you click a shifted element).
    s.setAttribute('data-nb-synthetic', '');
    s.textContent = '(' + _proRuntimeScript.toString() + ')();';
    doc.body ? doc.body.appendChild(s) : doc.documentElement.appendChild(s);

    // After injecting, push current NBPro visual flags so the canvas matches.
    _postFrame({ type: 'nbpro:setFlags', flags: _canvasFlags() });
  }

  function _canvasFlags() {
    return {
      showGridMatrix: _proState.showGridMatrix,
      showFlexGizmos: _proState.showFlexGizmos,
      showPermBadges: _proState.showPermBadges,
      dpiPreset: _proState.dpiPreset,
      dpiScale: _proState.dpiScale,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   PRO RUNTIME (runs inside the design iframe)
  //   Speaks the same 'nb-design' source protocol the host already routes.
  // ═════════════════════════════════════════════════════════════════════════
  function _proRuntimeScript() {
    const PATH_ATTR = 'data-nb-design-path';
    let flags = {
      showGridMatrix: false, showFlexGizmos: true,
      showPermBadges: true, dpiPreset: null, dpiScale: 1,
    };

    // ── Permission badge overlay ──────────────────────────────────────────
    // Badges are little colored chips rendered over any element whose
    // data-nb-perm attribute references a permission id (vfs:read, etc.).
    // We render them in a single overlay <div> positioned over the canvas,
    // repositioned on scroll/resize/mutation, instead of per-element (which
    // would fight the user's own layout).
    const badgeOverlay = document.createElement('div');
    badgeOverlay.setAttribute('data-nbpro-overlay', 'badges');
    badgeOverlay.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483646;';
    document.body.appendChild(badgeOverlay);

    const PERM_COLORS = {
      low: '#16a34a', medium: '#d29922', high: '#f0883e',
      critical: '#f85149', _default: '#58a6ff',
    };

    function _permRisk(id) {
      // Risk tag derived from permission id prefix — matches the host's
      // PERMISSIONS table without needing to ship a copy.
      if (/^vfs:/.test(id)) return id === 'vfs:read' ? 'medium' :
                                 id === 'vfs:write' ? 'high' :
                                 id === 'vfs:delete' ? 'critical' : 'low';
      if (/^net:/.test(id)) return 'medium';
      if (/^device:/.test(id)) return 'high';
      if (/^clipboard:/.test(id)) return id === 'clipboard:write' ? 'medium' : 'high';
      if (/^admin:/.test(id)) return 'high';
      if (/^sandbox:/.test(id)) return 'high';
      return '_default';
    }

    function _renderBadges() {
      badgeOverlay.innerHTML = '';
      if (!flags.showPermBadges) return;
      const targets = document.querySelectorAll('[data-nb-perm]');
      targets.forEach((el) => {
        const perms = (el.getAttribute('data-nb-perm') || '')
          .split(/\s+/).filter(Boolean);
        if (!perms.length) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        perms.forEach((perm, i) => {
          const chip = document.createElement('div');
          chip.className = '__nbpro_perm_chip';
          const risk = _permRisk(perm);
          const color = PERM_COLORS[risk] || PERM_COLORS._default;
          chip.style.cssText =
            'position:absolute;' +
            `left:${rect.right - (4 + (perms.length - i) * 56)}px;` +
            `top:${rect.top + 4}px;` +
            'font:600 9px/1 "JetBrains Mono",monospace;' +
            `color:${color};background:rgba(0,0,0,0.7);` +
            'border:1px solid ' + color + ';' +
            'border-radius:4px;padding:2px 5px;pointer-events:auto;' +
            'white-space:nowrap;letter-spacing:0.3px;';
          chip.textContent = perm;
          chip.title = 'Requires permission: ' + perm +
            '\nClick to remove this binding';
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            parent.postMessage({
              source: 'nb-design', type: 'nbpro:permBadgeClick',
              path: el.getAttribute(PATH_ATTR), perm,
            }, '*');
          });
          badgeOverlay.appendChild(chip);
        });
      });
    }

    // ── Flex gizmos: justify/align handles around selected flex container ─
    // Re-purposes the host's existing __nb_selected marker. We only add
    // gizmos when the selected element is itself display:flex/grid.
    const flexOverlay = document.createElement('div');
    flexOverlay.setAttribute('data-nbpro-overlay', 'flex');
    flexOverlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483645;';
    document.body.appendChild(flexOverlay);

    const JUSTIFY_OPTS = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around'];
    const ALIGN_OPTS = ['flex-start', 'center', 'flex-end', 'stretch'];
    function _splitTrackList(value) {
      const tokens = [];
      let token = '', depth = 0, brackets = 0, quote = '';
      for (const char of (value || '').trim()) {
        if (quote) {
          token += char;
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
          quote = char;
          token += char;
        } else if (char === '(') {
          depth++;
          token += char;
        } else if (char === ')') {
          depth = Math.max(0, depth - 1);
          token += char;
        } else if (char === '[') {
          brackets++;
          token += char;
        } else if (char === ']') {
          brackets = Math.max(0, brackets - 1);
          token += char;
        } else if (/\s/.test(char) && depth === 0 && brackets === 0) {
          if (token) { tokens.push(token); token = ''; }
        } else {
          token += char;
        }
      }
      if (token) tokens.push(token);
      return tokens.length === 1 && tokens[0] === 'none' ? [] : tokens;
    }

    function _buildGizmo(label, opts, current, axis /* 'justify'|'align' */) {
      const wrap = document.createElement('div');
      wrap.className = '__nbpro_gizmo __nbpro_gizmo--' + axis;
      wrap.style.cssText = 'position:absolute;display:flex;gap:2px;' +
        'background:rgba(7,9,15,0.92);border:1px solid #22c55e;border-radius:6px;' +
        'padding:3px;pointer-events:auto;';
      const cap = document.createElement('span');
      cap.style.cssText = 'font:600 8px/1 "JetBrains Mono",monospace;color:#8b949e;' +
        'padding:2px 4px;align-self:center;letter-spacing:0.5px;text-transform:uppercase;';
      cap.textContent = label;
      wrap.appendChild(cap);
      opts.forEach((opt) => {
        const b = document.createElement('button');
        const active = opt === current;
        b.style.cssText =
          `font:600 8px/1 "JetBrains Mono",monospace;border:none;border-radius:3px;` +
          `padding:3px 5px;cursor:pointer;color:${active ? '#0d1117' : '#c9d1d9'};` +
          `background:${active ? '#22c55e' : 'rgba(255,255,255,0.06)'};`;
        b.textContent = opt.split('-')[0];
        b.title = opt;
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage({
            source: 'nb-design', type: 'nbpro:flexGizmo',
            axis, value: opt,
          }, '*');
        });
        wrap.appendChild(b);
      });
      return wrap;
    }

    function _renderFlexGizmos() {
      flexOverlay.innerHTML = '';
      if (!flags.showFlexGizmos) return;
      const sel = document.querySelector('.' + '__nb_selected');
      if (!sel) return;
      const cs = getComputedStyle(sel);
      if (cs.display !== 'flex' && cs.display !== 'inline-flex' &&
          cs.display !== 'grid' && cs.display !== 'inline-grid') return;
      const rect = sel.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      const isGrid = cs.display.indexOf('grid') >= 0;
      const justifyGizmo = _buildGizmo('J',
        isGrid
          ? ['start', 'center', 'end', 'stretch']
          : JUSTIFY_OPTS,
        isGrid ? cs.justifyItems : cs.justifyContent, 'justify');
      justifyGizmo.style.top = (top - 24) + 'px';
      justifyGizmo.style.left = left + 'px';
      flexOverlay.appendChild(justifyGizmo);
      const alignGizmo = _buildGizmo('A',
        cs.display.indexOf('grid') >= 0
          ? ['start', 'center', 'end', 'stretch']
          : ALIGN_OPTS,
        cs.alignItems, 'align');
      alignGizmo.style.top = top + 'px';
      alignGizmo.style.left = (left + rect.width + 8) + 'px';
      flexOverlay.appendChild(alignGizmo);
      // Gap drag handle
      const gapHandle = document.createElement('div');
      gapHandle.className = '__nbpro_gizmo __nbpro_gizmo--gap';
      const gapVal = parseFloat(cs.gap) || 0;
      gapHandle.style.cssText =
        `position:absolute;top:${top + rect.height + 6}px;left:${left}px;` +
        `font:600 8px/1 "JetBrains Mono",monospace;` +
        `background:rgba(7,9,15,0.92);border:1px solid #22c55e;border-radius:6px;` +
        `padding:4px 8px;pointer-events:auto;cursor:ew-resize;color:#22c55e;`;
      gapHandle.textContent = 'gap: ' + cs.gap;
      gapHandle.title = 'Drag to adjust gap';
      let gStartX = 0, gStartGap = 0;
      gapHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        gStartX = e.clientX;
        gStartGap = gapVal;
        const onMove = (ev) => {
          const dx = ev.clientX - gStartX;
          const newGap = Math.max(0, Math.round(gStartGap + dx));
          parent.postMessage({
            source: 'nb-design', type: 'nbpro:flexGizmo',
            axis: 'gap', value: newGap + 'px',
          }, '*');
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
      flexOverlay.appendChild(gapHandle);
    }

    // ── Grid matrix overlay: visual row/col track editor ─────────────────
    const gridOverlay = document.createElement('div');
    gridOverlay.setAttribute('data-nbpro-overlay', 'grid');
    gridOverlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483644;';
    document.body.appendChild(gridOverlay);

    function _renderGridMatrix() {
      gridOverlay.innerHTML = '';
      if (!flags.showGridMatrix) return;
      const sel = document.querySelector('.' + '__nb_selected');
      if (!sel) return;
      const cs = getComputedStyle(sel);
      if (cs.display !== 'grid' && cs.display !== 'inline-grid') return;
      const rect = sel.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      // Parse grid-template-columns into track sizes
      const colTracks = _splitTrackList(cs.gridTemplateColumns);
      const rowTracks = _splitTrackList(cs.gridTemplateRows);
      // Render column track add/remove handles along the top edge
      const colBar = document.createElement('div');
      colBar.style.cssText =
        `position:absolute;top:${top - 18}px;left:${left}px;` +
        `display:flex;gap:2px;pointer-events:auto;`;
      colTracks.forEach((sz, i) => {
        const b = document.createElement('button');
        b.style.cssText =
          'font:600 8px/1 "JetBrains Mono",monospace;border:none;border-radius:3px;' +
          'padding:3px 6px;cursor:pointer;background:rgba(34,197,94,0.18);color:#22c55e;';
        b.textContent = '−';
        b.title = 'Remove column ' + (i + 1);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage({
            source: 'nb-design', type: 'nbpro:gridTrack',
            axis: 'column', op: 'remove', index: i,
          }, '*');
        });
        colBar.appendChild(b);
      });
      const addCol = document.createElement('button');
      addCol.style.cssText =
        'font:600 8px/1 "JetBrains Mono",monospace;border:none;border-radius:3px;' +
        'padding:3px 6px;cursor:pointer;background:rgba(34,197,94,0.18);color:#22c55e;';
      addCol.textContent = '+ col';
      addCol.title = 'Add a column track';
      addCol.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        parent.postMessage({
          source: 'nb-design', type: 'nbpro:gridTrack',
          axis: 'column', op: 'add',
        }, '*');
      });
      colBar.appendChild(addCol);
      gridOverlay.appendChild(colBar);
      // Row controls along left edge
      const rowBar = document.createElement('div');
      rowBar.style.cssText =
        `position:absolute;top:${top}px;left:${left - 56}px;` +
        `display:flex;flex-direction:column;gap:2px;pointer-events:auto;`;
      rowTracks.forEach((sz, i) => {
        const b = document.createElement('button');
        b.style.cssText =
          'font:600 8px/1 "JetBrains Mono",monospace;border:none;border-radius:3px;' +
          'padding:3px 5px;cursor:pointer;background:rgba(34,197,94,0.18);color:#22c55e;';
        b.textContent = '−';
        b.title = 'Remove row ' + (i + 1);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          parent.postMessage({
            source: 'nb-design', type: 'nbpro:gridTrack',
            axis: 'row', op: 'remove', index: i,
          }, '*');
        });
        rowBar.appendChild(b);
      });
      const addRow = document.createElement('button');
      addRow.style.cssText =
        'font:600 8px/1 "JetBrains Mono",monospace;border:none;border-radius:3px;' +
        'padding:3px 5px;cursor:pointer;background:rgba(34,197,94,0.18);color:#22c55e;';
      addRow.textContent = '+ row';
      addRow.title = 'Add a row track';
      addRow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        parent.postMessage({
          source: 'nb-design', type: 'nbpro:gridTrack',
          axis: 'row', op: 'add',
        }, '*');
      });
      rowBar.appendChild(addRow);
      gridOverlay.appendChild(rowBar);
      // Named-areas hint
      const areas = (cs.gridTemplateAreas || '').match(/"[^"]+"/g);
      if (areas && areas.length) {
        const areaHint = document.createElement('div');
        areaHint.style.cssText =
          `position:absolute;top:${top + rect.height + 6}px;left:${left}px;` +
          `font:600 8px/1.4 "JetBrains Mono",monospace;` +
          `background:rgba(7,9,15,0.92);border:1px solid #22c55e;border-radius:6px;` +
          `padding:4px 8px;color:#22c55e;pointer-events:auto;white-space:pre;`;
        areaHint.textContent = 'areas:\n' + areas.join('\n');
        gridOverlay.appendChild(areaHint);
      }
    }

    function _renderAll() {
      _renderBadges();
      _renderFlexGizmos();
      _renderGridMatrix();
    }
    window.addEventListener('scroll', _renderAll, true);
    window.addEventListener('resize', _renderAll);
    new MutationObserver(() => requestAnimationFrame(_renderAll))
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

    // Host -> iframe messages
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.source !== 'nb-design-host') return;
      if (msg.type === 'nbpro:setFlags') {
        flags = Object.assign(flags, msg.flags || {});
        _renderAll();
      } else if (msg.type === 'nbpro:rebind') {
        _renderAll();
      } else if (msg.type === 'nbpro:inspectElement') {
        // Re-select an element by path (used by Action Inspector "Pick")
        const el = document.querySelector(`[${PATH_ATTR}="${msg.path}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('__nb_selected');
          setTimeout(() => el.classList.remove('__nb_selected'), 1500);
        }
      }
    });

    // Initial render after a tick (let layout settle)
    setTimeout(_renderAll, 50);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   FEATURE 1 — Deep Layout & Spatial Controls
  // ═════════════════════════════════════════════════════════════════════════
  const DPI_PRESETS = [
    { id: '1280x800',  label: '1280 × 800',  w: 1280, h: 800,  note: 'Laptop' },
    { id: '1920x1080', label: '1920 × 1080', w: 1920, h: 1080, note: 'Desktop HD' },
    { id: '400x300',   label: '400 × 300 (min)', w: 400, h: 300, note: 'Min bounds' },
  ];
  const DPI_SCALES = [
    { id: 1,    label: '100%' },
    { id: 1.25, label: '125%' },
    { id: 1.5,  label: '150%' },
    { id: 2,    label: '200% (Retina)' },
  ];

  function _setDpiPreset(presetId) {
    _proState.dpiPreset = presetId;
    _applyDpiToFrame();
    _saveProState();
    _renderDpiBar();
  }

  // Clears just the "active preset" bookkeeping (chip highlighting, saved
  // state) without touching the frame's actual width/height -- unlike
  // _setDpiPreset(null), which also runs _applyDpiToFrame()'s "restore
  // natural sizing" branch and would wipe out a size the user just set by
  // hand-dragging the resize handle. Used when a manual resize makes the
  // previously-active preset no longer accurate.
  function _clearDpiPresetFlagOnly() {
    _proState.dpiPreset = null;
    _saveProState();
    _renderDpiBar();
  }

  function _setDpiScale(scaleId) {
    _proState.dpiScale = scaleId;
    _applyDpiToFrame();
    _saveProState();
    _renderDpiBar();
  }

  function _applyDpiToFrame() {
    const frame = $('design-frame');
    const stage = $('design-stage');
    const panWrap = stage ? stage.querySelector('.design-stage-pan') : null;
    if (!frame || !stage || !panWrap) return;
    const preset = DPI_PRESETS.find((p) => p.id === _proState.dpiPreset);
    if (!preset) {
      // Restore natural sizing (see .design-frame's default width/height
      // in style.css)
      frame.style.width = '';
      frame.style.height = '';
      stage.classList.remove('nbpro-stage-framed');
    } else {
      // Set the frame to the preset's real pixel dimensions -- this is the
      // actual viewport size the preset represents, not a pre-shrunk fit.
      // _designCenterStage (app.js) handles fitting/centering it on screen
      // via the pan/zoom transform, the same as it does for the default
      // frame size, so there's one positioning system instead of two.
      stage.classList.add('nbpro-stage-framed');
      frame.style.width = preset.w + 'px';
      frame.style.height = preset.h + 'px';
    }
    // dpiScale (100/125/150/200% chips) represents device pixel density,
    // not canvas viewing zoom -- kept as a separate transform:scale on the
    // frame itself so it stays independent of the user's free pan/zoom on
    // .design-stage-pan. CSS `zoom` was considered here instead, but it
    // has a long history of not reliably affecting <iframe> content in
    // Chromium (only recently spec'd to do so, and version-dependent) --
    // transform:scale is the well-supported option. transform-origin is
    // centered so scaling doesn't shift the frame's visual position away
    // from wherever centering/panning already placed it.
    frame.style.transformOrigin = 'center center';
    frame.style.transform = _proState.dpiScale === 1 ? '' : `scale(${_proState.dpiScale})`;
    if (typeof window._designCenterStage === 'function') window._designCenterStage();
  }

  function _renderDpiBar() {
    const bar = $('nbpro-dpi-bar');
    if (!bar) return;
    const presetHtml = DPI_PRESETS.map((p) => {
      const active = p.id === _proState.dpiPreset;
      return `<button class="nbpro-chip ${active ? 'nbpro-chip--active' : ''}" ` +
        `data-dpi-preset="${p.id}" title="${p.note}">${p.label}</button>`;
    }).join('');
    const scaleHtml = DPI_SCALES.map((s) => {
      const active = s.id === _proState.dpiScale;
      return `<button class="nbpro-chip ${active ? 'nbpro-chip--active' : ''}" ` +
        `data-dpi-scale="${s.id}">${s.label}</button>`;
    }).join('');
    bar.innerHTML =
      `<span class="nbpro-bar-label">DPI / Window:</span>` +
      presetHtml +
      `<span class="nbpro-bar-sep"></span>` +
      `<span class="nbpro-bar-label">Scale:</span>` +
      scaleHtml +
      `<button class="nbpro-chip nbpro-chip--ghost" data-dpi-reset>Reset</button>`;
    bar.querySelectorAll('[data-dpi-preset]').forEach((b) => {
      b.addEventListener('click', () => _setDpiPreset(b.dataset.dpiPreset));
    });
    bar.querySelectorAll('[data-dpi-scale]').forEach((b) => {
      b.addEventListener('click', () => _setDpiScale(parseFloat(b.dataset.dpiScale)));
    });
    bar.querySelector('[data-dpi-reset]')?.addEventListener('click', () => {
      _proState.dpiPreset = null;
      _proState.dpiScale = 1;
      _applyDpiToFrame();
      _saveProState();
      _renderDpiBar();
    });
  }

  function _canvasSelectionMatches(kind) {
    // kind: 'grid' checks display:grid/inline-grid, 'flex-or-grid' also
    // allows flex/inline-flex (Flex Gizmos renders on grid containers too).
    const frame = $('design-frame');
    if (!frame?.contentWindow) return false;
    const sel = frame.contentWindow.document.querySelector('.__nb_selected');
    if (!sel) return false;
    const display = frame.contentWindow.getComputedStyle(sel).display;
    if (kind === 'grid') return display === 'grid' || display === 'inline-grid';
    return ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display);
  }

  function _toggleGridMatrix() {
    _proState.showGridMatrix = !_proState.showGridMatrix;
    _saveProState();
    _postFrame({ type: 'nbpro:setFlags', flags: _canvasFlags() });
    _renderLayoutBar();
    // The overlay only draws when the current canvas selection is itself a
    // grid container -- with nothing suitable selected the toggle still
    // "works" (state flips, chip goes green) but nothing appears on canvas,
    // which reads as broken. A toast at least explains why, but only when
    // it'd actually be invisible -- no need to nag if it's already showing.
    if (_proState.showGridMatrix && !_canvasSelectionMatches('grid')) {
      _showToast('Grid Matrix on — select a grid container on the canvas to see it');
    }
  }

  function _toggleFlexGizmos() {
    _proState.showFlexGizmos = !_proState.showFlexGizmos;
    _saveProState();
    _postFrame({ type: 'nbpro:setFlags', flags: _canvasFlags() });
    _renderLayoutBar();
    if (_proState.showFlexGizmos && !_canvasSelectionMatches('flex-or-grid')) {
      _showToast('Flex Gizmos on — select a flex or grid container on the canvas to see it');
    }
  }

  function _renderLayoutBar() {
    const bar = $('nbpro-layout-bar');
    if (!bar) return;
    bar.innerHTML =
      `<button class="nbpro-chip ${_proState.showGridMatrix ? 'nbpro-chip--active' : ''}" ` +
      `data-toggle="grid-matrix">⊞ Grid Matrix</button>` +
      `<button class="nbpro-chip ${_proState.showFlexGizmos ? 'nbpro-chip--active' : ''}" ` +
      `data-toggle="flex-gizmos">⇄ Flex Gizmos</button>` +
      `<button class="nbpro-chip nbpro-chip--ghost" data-action="grid-areas">⌗ Named Areas</button>`;
    bar.querySelector('[data-toggle="grid-matrix"]')?.addEventListener('click', _toggleGridMatrix);
    bar.querySelector('[data-toggle="flex-gizmos"]')?.addEventListener('click', _toggleFlexGizmos);
    bar.querySelector('[data-action="grid-areas"]')?.addEventListener('click', _openGridAreasEditor);
  }

  function _openGridAreasEditor() {
    const modal = $('nbpro-modal-grid-areas');
    if (!modal) return;
    // Pull current selected grid container's gridTemplateAreas
    const frame = $('design-frame');
    let currentAreas = '';
    if (frame?.contentWindow) {
      const sel = frame.contentWindow.document.querySelector('.__nb_selected');
      if (sel) {
        const cs = frame.contentWindow.getComputedStyle(sel);
        if (cs.display === 'grid' || cs.display === 'inline-grid') {
          currentAreas = cs.gridTemplateAreas || '';
        }
      }
    }
    const ta = modal.querySelector('#nbpro-ga-input');
    if (ta) ta.value = currentAreas || `"header header"\n"sidebar main"\n"footer footer"`;
    modal.classList.remove('hidden');
  }

  function _applyGridAreas() {
    const modal = $('nbpro-modal-grid-areas');
    const ta = modal?.querySelector('#nbpro-ga-input');
    if (!ta) return;
    const val = ta.value.trim();
    // Validate the row dimensions and the rectangular shape required by CSS Grid.
    const lines = val.split('\n').map((l) => l.trim()).filter(Boolean);
    let valid = val === '' || lines.length > 0;
    let colCount = 0;
    const positions = new Map();
    lines.forEach((line, rowIndex) => {
      const m = line.match(/^"([^"]+)"$/);
      if (!m) { valid = false; return; }
      const names = m[1].trim().split(/\s+/);
      if (names.some((name) =>
        name !== '.' &&
        (!/^(?:[_a-z]|--?[_a-z])[-_a-z0-9]*$/i.test(name) || /^(span|auto|none)$/i.test(name))
      )) { valid = false; return; }
      if (colCount === 0) colCount = names.length;
      else if (!names.length || names.length !== colCount) { valid = false; return; }
      names.forEach((name, col) => {
        if (name === '.') return;
        if (!positions.has(name)) positions.set(name, []);
        positions.get(name).push([rowIndex, col]);
      });
    });
    const err = modal.querySelector('#nbpro-ga-error');
    for (const cells of positions.values()) {
      const rows = cells.map(([row]) => row);
      const cols = cells.map(([, col]) => col);
      const height = Math.max(...rows) - Math.min(...rows) + 1;
      const width = Math.max(...cols) - Math.min(...cols) + 1;
      if (height * width !== cells.length) valid = false;
    }
    if (val && typeof CSS !== 'undefined' && CSS.supports &&
        !CSS.supports('grid-template-areas', val)) valid = false;
    if (!valid) {
      if (err) {
        err.textContent = 'Use quoted rows with matching column counts and rectangular area names (use . for empty cells).';
        err.classList.add('error');
      }
      return;
    }
    if (err) { err.textContent = ''; err.classList.remove('error'); }
    if (!_canvasSelectionMatches('grid')) {
      if (err) { err.textContent = 'Select a grid container before applying named areas.'; err.classList.add('error'); }
      return;
    }
    const gaField = $('da-grid-areas');
    if (gaField) {
      gaField.value = val;
      gaField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    modal.classList.add('hidden');
  }

  // ── Receive canvas-side flex/grid gizmo events ──────────────────────────
  function _onFlexGizmo(msg) {
    if (!['justify', 'align', 'gap'].includes(msg.axis)) return;
    const isGrid = _canvasSelectionMatches('grid');
    const fieldId = msg.axis === 'gap'
      ? (isGrid ? 'da-grid-gap' : 'da-flex-gap')
      : msg.axis === 'justify'
        ? (isGrid ? 'da-grid-justify' : 'da-flex-justify')
        : (isGrid ? 'da-grid-align' : 'da-flex-align');
    const target = $(fieldId);
    if (!target) return;
    target.value = msg.value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    if (target.tagName === 'SELECT') target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function _onGridTrack(msg) {
    // Adjust grid-template-columns / grid-template-rows for the selected
    // container. We mutate the field's value and re-dispatch input.
    const fieldId = msg.axis === 'column' ? 'da-grid-columns' : 'da-grid-rows';
    const field = $(fieldId);
    if (!field) return;
    const tracks = _expandGridTracks(field.value);
    if (msg.op === 'add') {
      tracks.push('1fr');
    } else if (msg.op === 'remove') {
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= tracks.length) return;
      tracks.splice(msg.index, 1);
    } else {
      return;
    }
    field.value = tracks.join(' ');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _expandGridTracks(value) {
    const tokens = [];
    let token = '';
    let depth = 0;
    let bracketDepth = 0;
    let quote = '';
    for (const char of value.trim()) {
      if (quote) {
        token += char;
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
        token += char;
      } else if (char === '(') {
        depth++;
        token += char;
      } else if (char === ')') {
        depth = Math.max(0, depth - 1);
        token += char;
      } else if (char === '[') {
        bracketDepth++;
        token += char;
      } else if (char === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        token += char;
      } else if (/\s/.test(char) && depth === 0 && bracketDepth === 0) {
        if (token) { tokens.push(token); token = ''; }
      } else {
        token += char;
      }
    }
    if (token) tokens.push(token);
    if (tokens.length === 1 && tokens[0] === 'none') return [];
    return tokens.flatMap((item) => {
      const repeat = item.match(/^repeat\(\s*(\d+)\s*,\s*(.+)\)$/i);
      if (!repeat) return [item];
      const count = Math.min(100, Number(repeat[1]));
      const inner = _expandGridTracks(repeat[2]);
      return inner.length ? Array.from({ length: count }, () => inner).flat() : [item];
    });
  }

  function _onPermBadgeClick(msg) {
    _switchInspectorTab('actions');
    _showToast(`Permission ${msg.perm} — edit the action in the Actions inspector`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   FEATURE 2 — Visual State & IPC Action Binding
  // ═════════════════════════════════════════════════════════════════════════
  // Catalog of native desktop IPC actions the user can wire to a click
  // without writing code. Each entry has the permission it requires, the
  // nova: IPC channel it sends, and a small parameter schema.
  const IPC_ACTIONS = [
    { id: 'vfs:openFile',   label: 'Open File Dialog',     perm: 'vfs:read',     channel: 'nova:dialog:open',    params: { accept: ['.txt', '.md'], multiple: false } },
    { id: 'vfs:saveFile',   label: 'Save File Dialog',     perm: 'vfs:write',    channel: 'nova:dialog:save',    params: { filename: '', content: '' } },
    { id: 'vfs:readFile',   label: 'Read File',            perm: 'vfs:read',     channel: 'nova:vfs:read',       params: { path: '' } },
    { id: 'vfs:writeFile',  label: 'Write File',           perm: 'vfs:write',    channel: 'nova:vfs:write',      params: { path: '', content: '' } },
    { id: 'clipboard:read', label: 'Read Clipboard',       perm: 'clipboard:read', channel: 'nova:clipboard:read', params: {} },
    { id: 'clipboard:write',label: 'Write Clipboard',      perm: 'clipboard:write', channel: 'nova:clipboard:write', params: { text: '' } },
    { id: 'win:minimize',   label: 'Minimize Window',      perm: null,           channel: 'nova:window:minimize', params: {} },
    { id: 'win:maximize',   label: 'Maximize/Restore',     perm: null,           channel: 'nova:window:maximize', params: {} },
    { id: 'win:close',      label: 'Close Window',         perm: null,           channel: 'nova:window:close',   params: {} },
    { id: 'notify',         label: 'Show Notification',    perm: 'device:notifications', channel: 'nova:notifications:show', params: { title: '', body: '' } },
    { id: 'net:fetch',      label: 'HTTP Request',         perm: 'net:external', handler: 'fetch', params: { url: '', method: 'GET' } },
    { id: 'shell:open',     label: 'Open URL in OS browser', perm: null,         handler: 'openUrl', params: { url: '' } },
  ];
  const _IPC_ACTION_MAP = Object.fromEntries(IPC_ACTIONS.map((a) => [a.id, a]));

  function _renderActionInspector() {
    const panel = $('nbpro-action-inspector');
    if (!panel) return;
    const sel = _proSelected;
    if (!sel) {
      panel.innerHTML = '<div class="nbpro-empty">Select an element on the canvas to bind an action.</div>';
      return;
    }
    const existing = _proState.bindings.find((b) =>
      !b.orphaned && b.elementPath === sel.path.join('.'));
    // Prefer whatever's pending in the dropdown for this element (an unsaved
    // pick that hasn't hit "Apply" yet) over the saved binding, so re-renders
    // triggered by the select's own change event don't stomp the user's pick.
    const pathStr = sel.path.join('.');
    const currentActionId = (_proPendingAction && _proPendingAction.path === pathStr)
      ? _proPendingAction.actionId
      : (existing?.action || '');
    const actionOpts = IPC_ACTIONS.map((a) => {
      const selAttr = a.id === currentActionId ? ' selected' : '';
      const permTag = a.perm ? `  [${a.perm}]` : '  [no perm]';
      return `<option value="${a.id}"${selAttr}>${a.label}${permTag}</option>`;
    }).join('');
    const action = _IPC_ACTION_MAP[currentActionId];
    const permDeclared = _isPermissionDeclared(action?.perm);
    const permWarn = action?.perm && !permDeclared
      ? `<div class="nbpro-warn">⚠ This action requires <code>${action.perm}</code>, which is not enabled in your manifest.json. <button class="nbpro-link" data-jump-perm="${action.perm}">Enable it</button></div>`
      : '';
    const pendingParams = _proPendingParams?.path === pathStr &&
      currentActionId === _proPendingParams.actionId
      ? _proPendingParams.values
      : null;
    const savedParams = pendingParams || (existing?.action === currentActionId ? existing.params || {} : {});
    const paramsHtml = action ? Object.entries(action.params).map(([k, defaultValue]) => {
      const value = savedParams[k] ?? defaultValue;
      const control = typeof defaultValue === 'boolean'
        ? `<input class="nbpro-param-input" type="checkbox" data-param="${k}"${value === true || value === 'true' ? ' checked' : ''}>`
        : `<input class="nbpro-param-input" data-param="${k}"${Array.isArray(defaultValue) ? ' data-param-type="list"' : ''} value="${_escapeHtmlAttr(Array.isArray(value) ? value.join(', ') : value ?? '')}" placeholder="${k}">`;
      return `<div class="nbpro-param-row">
        <label class="nbpro-param-label">${k}</label>
        ${control}
      </div>`;
    }).join('') : '';
    panel.innerHTML =
      `<div class="nbpro-ai-head">
        <span class="nbpro-ai-tag">${_esc(sel.tag)}</span>
        ${sel.id ? `<span class="nbpro-ai-id">#${_esc(sel.id)}</span>` : ''}
        ${sel.className ? `<span class="nbpro-ai-cls">.${_esc(sel.className.split(/\s+/)[0])}</span>` : ''}
      </div>
      <div class="nbpro-ai-row">
        <label class="nbpro-ai-label">Action</label>
        <select class="nbpro-ai-select" id="nbpro-ai-action">
          <option value="">— None —</option>
          ${actionOpts}
        </select>
      </div>
      ${permWarn}
      <div class="nbpro-ai-params">${paramsHtml}</div>
      <div class="nbpro-ai-actions">
        <button class="nbpro-btn nbpro-btn--ghost" id="nbpro-ai-unbind">Remove binding</button>
        <button class="nbpro-btn nbpro-btn--primary" id="nbpro-ai-apply">Apply &amp; inject code</button>
      </div>
      <details class="nbpro-ai-details">
        <summary>Generated handler code</summary>
        <pre class="nbpro-ai-code" id="nbpro-ai-code"></pre>
      </details>`;
    panel.querySelector('#nbpro-ai-action')?.addEventListener('change', (e) => {
      _proPendingAction = { path: pathStr, actionId: e.target.value };
      _proPendingParams = null;
      _renderActionInspector(); // re-render with new action's params
    });
    panel.querySelectorAll('.nbpro-param-input').forEach((input) => {
      const updateParams = () => {
        _proPendingParams = { path: pathStr, actionId: currentActionId, values: _currentParamValues() };
        _renderGeneratedCode();
      };
      input.addEventListener('input', updateParams);
      input.addEventListener('change', updateParams);
    });
    panel.querySelector('[data-jump-perm]')?.addEventListener('click', (e) => {
      const perm = e.target.dataset.jumpPerm;
      _jumpToPermission(perm);
    });
    panel.querySelector('#nbpro-ai-apply')?.addEventListener('click', () => _applyBinding());
    panel.querySelector('#nbpro-ai-unbind')?.addEventListener('click', () => _unbindCurrent());
    _renderGeneratedCode();
  }

  function _currentActionSelection() {
    const sel = $('nbpro-ai-action');
    return sel ? sel.value : '';
  }

  function _currentParamValues() {
    const out = {};
    document.querySelectorAll('.nbpro-param-input').forEach((el) => {
      out[el.dataset.param] = el.type === 'checkbox'
        ? el.checked
        : el.dataset.paramType === 'list'
          ? el.value.split(',').map((value) => value.trim()).filter(Boolean)
          : el.value;
    });
    return out;
  }

  function _selectionElementExpression(sel) {
    if (sel?.targetId) {
      return `document.querySelector('[data-nb-studio-action="' + ${JSON.stringify(sel.targetId)} + '"]')`;
    }
    if (sel?.id) return `document.getElementById(${JSON.stringify(sel.id)})`;
    const className = sel?.className?.trim().split(/\s+/)[0];
    if (className) return `document.getElementsByClassName(${JSON.stringify(className)})[0] || null`;
    if (sel?.tag && /^[a-z][a-z0-9-]*$/i.test(sel.tag)) {
      return `document.querySelector(${JSON.stringify(sel.tag)})`;
    }
    return 'null';
  }

  function _escapeHtmlAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function _renderGeneratedCode() {
    const codeEl = $('nbpro-ai-code');
    if (!codeEl) return;
    const actionId = _currentActionSelection();
    const action = _IPC_ACTION_MAP[actionId];
    if (!action) { codeEl.textContent = '// No action selected'; return; }
    const sel = _proSelected;
    const pathStr = sel?.path?.join('.') || '';
    const binding = _proState.bindings.find((item) =>
      !item.orphaned && item.elementPath === pathStr);
    const pendingParams = _proPendingParams?.path === pathStr &&
      _proPendingParams.actionId === actionId
      ? _proPendingParams.values
      : null;
    codeEl.textContent = _renderActionBindingCode({
      action: actionId,
      params: pendingParams || _currentParamValues(),
      id: sel?.id || '',
      className: sel?.className || '',
      tag: sel?.tag || 'button',
      targetId: binding?.targetId || `nb-${pathStr.replace(/\./g, '-')}`,
    });
  }

  function _renderActionBindingCode(binding) {
    const action = _IPC_ACTION_MAP[binding.action];
    if (!action) return '';
    const suppliedParams = binding.params || {};
    const params = Object.fromEntries(Object.entries(action.params).map(([key, defaultValue]) => {
      const value = suppliedParams[key] ?? defaultValue;
      return [key, typeof defaultValue === 'boolean'
        ? value === true || value === 'true'
        : Array.isArray(defaultValue)
          ? Array.isArray(value) ? value.map(String) : String(value).split(',').map((part) => part.trim()).filter(Boolean)
          : String(value)];
    }));
    const element = _selectionElementExpression(binding);
    let invoke;
    if (action.handler === 'fetch') {
      invoke = `const response = await fetch(${JSON.stringify(params.url)}, { method: ${JSON.stringify(params.method)} });\n` +
        `    if (!response.ok) throw new Error('HTTP ' + response.status);\n` +
        `    const result = await response.text();`;
    } else if (action.handler === 'openUrl') {
      invoke = `const result = await window.nova.openUrl(${JSON.stringify(params.url)});`;
    } else {
      invoke = `const result = await window.nova.ipc(${JSON.stringify(action.channel)}, ${JSON.stringify(params, null, 2)});`;
    }
    return `// Auto-generated by NovaByte Studio — IPC binding for selected element\n` +
      `${element}?.addEventListener('click', async () => {\n` +
      `  try {\n` +
      `    ${invoke}\n` +
      `    console.log(${JSON.stringify(action.id + ' result:')}, result);\n` +
      `  } catch (err) {\n` +
      `    console.error(${JSON.stringify(action.id + ' failed:')}, err);\n` +
      `  }\n` +
      `});`;
  }

  function _isPermissionDeclared(permId) {
    if (!permId) return true;
    const m = _readProjectManifest();
    if (!m) return false;
    const granted = (m.data && m.data.permissions) || [];
    return granted.includes(permId);
  }

  function _jumpToPermission(permId) {
    if (typeof window.switchTab === 'function') window.switchTab('permissions');
    setTimeout(() => {
      const card = document.querySelector(`[data-perm-id="${permId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const cb = card.querySelector('input[type=checkbox]');
        if (cb && !cb.checked) cb.checked = true;
        card.classList.add('nbpro-flash');
        setTimeout(() => card.classList.remove('nbpro-flash'), 1500);
      }
    }, 200);
  }

  function _applyBinding() {
    const sel = _proSelected;
    if (!sel) { _showToast('Select an element first'); return; }
    const actionId = _currentActionSelection();
    if (!actionId) { _showToast('Pick an action'); return; }
    const action = _IPC_ACTION_MAP[actionId];
    if (!action) { _showToast('That action is no longer available'); return; }
    const oldBindings = _proState.bindings;
    const pathStr = sel.path.join('.');
    const previous = oldBindings.find((binding) =>
      !binding.orphaned && binding.elementPath === pathStr);
    const targetId = previous?.targetId || `nb-${pathStr.replace(/\./g, '-')}`;
    // Update binding state.
    _proState.bindings = oldBindings.filter((b) => b.elementPath !== pathStr);
    _proState.bindings.push({
      elementPath: pathStr,
      tag: sel.tag,
      id: sel.id,
      className: sel.className,
      targetId,
      action: actionId,
      params: _currentParamValues(),
      perm: action.perm,
    });
    _proPendingAction = null;
    _proPendingParams = null;
    if (!_injectBindingAttrs(pathStr, action.perm || '', targetId, previous?.perm || '')) {
      _proState.bindings = oldBindings;
      _saveProState();
      _renderActionInspector();
      return;
    }
    if (!_injectHandlerToAppJs()) {
      _proState.bindings = oldBindings;
      _saveProState();
      _injectBindingAttrs(pathStr, previous?.perm || '', previous?.targetId || '');
      _renderActionInspector();
      return;
    }
    _saveProState();
    _postFrame({
      type: 'applyLive', path: pathStr,
      attr: { 'data-nb-perm': action.perm || '', 'data-nb-studio-action': targetId },
    });
    _renderActionInspector();
    _postFrame({ type: 'nbpro:rebind' });
    _showToast(`Bound "${action.label}" to <${sel.tag}>`);
  }

  function _unbindCurrent() {
    const sel = _proSelected;
    if (!sel) return;
    const pathStr = sel.path.join('.');
    const previousBindings = _proState.bindings;
    const removed = previousBindings.find((binding) => binding.elementPath === pathStr);
    _proState.bindings = previousBindings.filter((binding) => binding.elementPath !== pathStr);
    _proPendingAction = null;
    _proPendingParams = null;
    if (!_injectBindingAttrs(pathStr, '', '', removed?.perm || '')) {
      _proState.bindings = previousBindings;
      _renderActionInspector();
      return;
    }
    if (!_injectHandlerToAppJs()) {
      _proState.bindings = previousBindings;
      _injectBindingAttrs(pathStr, removed?.perm || '', removed?.targetId || '');
      _renderActionInspector();
      return;
    }
    _saveProState();
    _postFrame({
      type: 'applyLive', path: pathStr,
      attr: { 'data-nb-perm': '', 'data-nb-studio-action': '' },
    });
    _renderActionInspector();
    _postFrame({ type: 'nbpro:rebind' });
    _showToast('Binding removed');
  }

  function _injectBindingAttrs(pathStr, permId, targetId, previousPerm = '') {
    const perm = _patchSourceAttribute(pathStr, 'data-nb-perm', permId);
    if (!perm.ok) return false;
    const target = _patchSourceAttribute(pathStr, 'data-nb-studio-action', targetId);
    if (target.ok) return true;
    _patchSourceAttribute(pathStr, 'data-nb-perm', previousPerm);
    return false;
  }

  function _patchSourceAttribute(pathStr, name, value) {
    try {
      const parse5 = (typeof require === 'function') ? require('parse5') : null;
      const idx = _readIndexHtml();
      const fs = _fs();
      if (!parse5 || !idx || !fs) throw new Error('index.html or parser is unavailable');
      const path = pathStr.split('.').map(Number);
      if (!path.length || path.some((part) => !Number.isInteger(part) || part < 0)) {
        throw new Error('invalid element path');
      }
      const doc = parse5.parse(idx.text, { sourceCodeLocationInfo: true });
      const node = _findNodeByPath(doc, path);
      const loc = node?.sourceCodeLocation;
      if (!node || !loc?.startTag) throw new Error('selected element no longer matches index.html');
      const existing = node.attrs?.find((attr) => attr.name === name);
      const cleanValue = value == null ? '' : String(value);
      if ((existing?.value || '') === cleanValue) return { ok: true, changed: false };

      let edits;
      const attrLocation = loc.attrs?.[name];
      if (attrLocation) {
        edits = [{
          start: attrLocation.startOffset,
          end: attrLocation.endOffset,
          replacement: cleanValue
            ? `${name}="${_escapeAttr(cleanValue)}"`
            : '',
        }];
      } else if (cleanValue) {
        let insertAt = loc.startTag.endOffset - 1;
        if (idx.text[insertAt - 1] === '/') insertAt--;
        edits = [{ start: insertAt, end: insertAt, replacement: ` ${name}="${_escapeAttr(cleanValue)}"` }];
      } else {
        return { ok: true, changed: false };
      }
      const edited = edits.sort((a, b) => b.start - a.start).reduce(
        (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
        idx.text
      );
      fs.writeFileSync(idx.path, edited, 'utf8');
      _noteOwnSourceWrite();
      return { ok: true, changed: true };
    } catch (err) {
      console.warn(`[NBPro] Could not update ${name} in index.html:`, err);
      _showToast(`Could not update ${name} in index.html: ${err.message}`);
      return { ok: false, changed: false };
    }
  }

  function _escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function _findNodeByPath(doc, pathArr) {
    let node = doc;
    for (const idx of pathArr) {
      if (!node || !node.childNodes) return null;
      node = node.childNodes.filter((child) => child.tagName)[idx];
      if (!node) return null;
    }
    return node;
  }

  function _injectHandlerToAppJs() {
    const code = _proState.bindings
      .filter((binding) => !binding.orphaned)
      .map(_renderActionBindingCode)
      .filter(Boolean)
      .join('\n\n');
    let appFile = _readAppJs();
    if (!appFile) {
      if (!code) return true;
      const createdPath = window._designEnsureEntryScript?.();
      if (!createdPath) {
        _showToast('No linked project script is available for IPC bindings.');
        return false;
      }
      try { appFile = { path: createdPath, text: _fs().readFileSync(createdPath, 'utf8') }; }
      catch (err) {
        _showToast('Could not read the new project script: ' + err.message);
        return false;
      }
    }
    // Append (or replace) a managed block in the selected entry script.
    const MARKER_START = '// ── NBPro auto-injected IPC bindings ───────────────────────';
    const MARKER_END   = '// ── /NBPro auto-injected IPC bindings ────────────────────';
    const startIdx = appFile.text.indexOf(MARKER_START);
    const endIdx = startIdx >= 0 ? appFile.text.indexOf(MARKER_END, startIdx) : -1;
    if (startIdx >= 0 && endIdx < 0 && !code) {
      _showToast('Could not remove IPC handlers: the generated block is incomplete.');
      return false;
    }
    const block = code ? `${MARKER_START}\n${code}\n${MARKER_END}` : '';
    const newText = startIdx >= 0 && endIdx >= 0
      ? appFile.text.slice(0, startIdx) + block + appFile.text.slice(endIdx + MARKER_END.length)
      : block ? appFile.text.replace(/\s*$/, '') + `\n\n${block}\n` : appFile.text;
    try {
      _fs().writeFileSync(appFile.path, newText, 'utf8');
      return true;
    } catch (err) {
      _showToast('Could not write project script: ' + err.message);
      return false;
    }
  }

  // ── Reactive data binding ────────────────────────────────────────────────
  // Bind an element's textContent to a top-level state key in a linked script, or to
  // a key in a local JSON file. We scan app.js for `state.X = ` assignments
  // to surface candidate keys.
  function _scanAppStateKeys() {
    const appFile = _readAppJs();
    if (!appFile) return [];
    const keys = new Set();
    // Match `state.foo = ` and `state.bar.baz = ` patterns
    const re = /state\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let m;
    for (const file of appFile.files || [appFile]) {
      while ((m = re.exec(file.text)) !== null) keys.add(m[1]);
      re.lastIndex = 0;
    }
    return Array.from(keys).sort();
  }

  function _renderDataBindingInspector() {
    const panel = $('nbpro-data-inspector');
    if (!panel) return;
    const sel = _proSelected;
    if (!sel) {
      panel.innerHTML = '<div class="nbpro-empty">Select a text element to bind to state.</div>';
      return;
    }
    const keys = _scanAppStateKeys();
    const opts = keys.map((k) => `<option value="${k}">${k}</option>`).join('');
    panel.innerHTML =
      `<div class="nbpro-ai-head">
        <span class="nbpro-ai-tag">${_esc(sel.tag)}</span>
        ${sel.id ? `<span class="nbpro-ai-id">#${_esc(sel.id)}</span>` : ''}
      </div>
      <div class="nbpro-ai-row">
        <label class="nbpro-ai-label">Bind to state key</label>
        <select class="nbpro-ai-select" id="nbpro-db-key">
          <option value="">— None —</option>
          <optgroup label="Linked script state">${opts}</optgroup>
          <option value="__file:local.json">— Load from local JSON —</option>
        </select>
      </div>
      <div class="nbpro-ai-row" id="nbpro-db-file-row" style="display:none;">
        <label class="nbpro-ai-label">JSON file path</label>
        <input class="nbpro-ai-input" id="nbpro-db-file" placeholder="data.json">
      </div>
      <div class="nbpro-ai-row">
        <label class="nbpro-ai-label">JSON path</label>
        <input class="nbpro-ai-input" id="nbpro-db-jpath" placeholder="user.name">
      </div>
      <div class="nbpro-ai-actions">
        <button class="nbpro-btn nbpro-btn--primary" id="nbpro-db-apply">Bind</button>
      </div>
      <details class="nbpro-ai-details">
        <summary>Generated binding code</summary>
        <pre class="nbpro-ai-code" id="nbpro-db-code"></pre>
      </details>`;
    panel.querySelector('#nbpro-db-key')?.addEventListener('change', (e) => {
      const isFile = e.target.value === '__file:local.json';
      panel.querySelector('#nbpro-db-file-row').style.display = isFile ? '' : 'none';
      _renderDataBindingCode();
    });
    panel.querySelector('#nbpro-db-file')?.addEventListener('input', _renderDataBindingCode);
    panel.querySelector('#nbpro-db-jpath')?.addEventListener('input', _renderDataBindingCode);
    panel.querySelector('#nbpro-db-apply')?.addEventListener('click', _applyDataBinding);
    _renderDataBindingCode();
  }

  function _renderDataBindingCode() {
    const codeEl = $('nbpro-db-code');
    if (!codeEl) return;
    codeEl.dataset.ready = 'false';
    const key = $('nbpro-db-key')?.value || '';
    const isFile = key === '__file:local.json';
    const file = $('nbpro-db-file')?.value || 'data.json';
    const jpath = $('nbpro-db-jpath')?.value.trim() || '';
    const sel = _proSelected;
    const element = sel?.id || sel?.className ? _selectionElementExpression(sel) : null;
    if (!element) { codeEl.textContent = '// Element needs an id or class'; return; }
    if (!key) { codeEl.textContent = '// Pick a state key'; return; }
    if (jpath && jpath.split('.').some((part) => !part)) {
      codeEl.textContent = '// JSON path segments cannot be empty';
      return;
    }
    const suffix = sel?.path?.length ? sel.path.join('_') : 'element';
    const lookup = (source) => jpath
      ? `_nbproGetPath(${source}, ${JSON.stringify(jpath.split('.'))})`
      : source;
    if (isFile) {
      codeEl.textContent =
        `// Generated file data binding\n` +
        `function _nbproGetPath(obj, parts) { return parts.reduce((value, part) => value == null ? undefined : value[part], obj); }\n` +
        `async function _nbpro_bind_${suffix}() {\n` +
        `  try {\n` +
        `    const res = await fetch(${JSON.stringify(file)});\n` +
        `    if (!res.ok) throw new Error('HTTP ' + res.status);\n` +
        `    const data = await res.json();\n` +
        `    const val = ${lookup('data')};\n` +
        `    const el = ${element};\n` +
        `    if (el) el.textContent = val == null ? '' : String(val);\n` +
        `  } catch (err) { console.error('Data binding failed:', err); }\n` +
        `}\n` +
        `window._nbproRefreshBindings = window._nbproRefreshBindings instanceof Map ? window._nbproRefreshBindings : new Map();\n` +
        `window._nbproRefreshBindings.set(${JSON.stringify(suffix)}, _nbpro_bind_${suffix});\n` +
        `window._nbproRefreshDataBindings = function () { window._nbproRefreshBindings.forEach(function (bind) { bind(); }); };\n` +
        `_nbpro_bind_${suffix}();\n`;
    } else {
      codeEl.textContent =
        `// Generated state data binding\n` +
        `function _nbproGetPath(obj, parts) { return parts.reduce((value, part) => value == null ? undefined : value[part], obj); }\n` +
        `function _nbpro_bind_${suffix}() {\n` +
        `  const appState = typeof state !== 'undefined' ? state : window.state;\n` +
        `  const el = ${element};\n` +
        `  if (!el || !appState) return;\n` +
        `  const val = ${lookup(`appState[${JSON.stringify(key)}]`)};\n` +
        `  el.textContent = val == null ? '' : String(val);\n` +
        `}\n` +
        `window._nbproRefreshBindings = window._nbproRefreshBindings instanceof Map ? window._nbproRefreshBindings : new Map();\n` +
        `window._nbproRefreshBindings.set(${JSON.stringify(suffix)}, _nbpro_bind_${suffix});\n` +
        `window._nbproRefreshDataBindings = function () { window._nbproRefreshBindings.forEach(function (bind) { bind(); }); };\n` +
        `_nbpro_bind_${suffix}();\n` +
        `// Call window._nbproRefreshDataBindings() after changing state.\n`;
    }
    codeEl.dataset.ready = 'true';
  }

  function _applyDataBinding() {
    const codeEl = $('nbpro-db-code');
    if (!codeEl) return;
    const code = codeEl.textContent;
    if (!code || codeEl.dataset.ready !== 'true') { _showToast('Configure the binding first'); return; }
    let appFile = _readAppJs();
    if (!appFile) {
      const createdPath = window._designEnsureEntryScript?.();
      if (!createdPath) { _showToast('No linked project script is available for data bindings.'); return; }
      try { appFile = { path: createdPath, text: _fs().readFileSync(createdPath, 'utf8') }; }
      catch (err) { _showToast('Could not read the new project script: ' + err.message); return; }
    }
    const suffix = _proSelected?.path?.join('_') || 'element';
    const MARKER_START = `// ── NBPro auto-injected data binding ${suffix} ─────────────────────`;
    const MARKER_END   = `// ── /NBPro auto-injected data binding ${suffix} ───────────────────`;
    const block = `${MARKER_START}\n(() => {\n${code}\n})();\n${MARKER_END}\n`;
    let newText;
    const startIdx = appFile.text.indexOf(MARKER_START);
    if (startIdx >= 0) {
      const endIdx = appFile.text.indexOf(MARKER_END, startIdx);
      if (endIdx < 0) {
        _showToast('Could not update this data binding: its generated block is incomplete.');
        return;
      }
      newText = appFile.text.slice(0, startIdx) + block + appFile.text.slice(endIdx + MARKER_END.length);
    } else {
      newText = appFile.text + '\n\n' + block;
    }
    try {
      _fs().writeFileSync(appFile.path, newText, 'utf8');
      _showToast('Data binding injected into the entry script');
    } catch (err) {
      _showToast('Could not write project script: ' + err.message);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   FEATURE 3 — Native Desktop UI Component Library + Custom Component Creator
  // ═════════════════════════════════════════════════════════════════════════
  // Native desktop component snippets. Each entry generates HTML+CSS that
  // gets inserted into the canvas (and source files) on drag/click.
  const NATIVE_COMPONENTS = [
    {
      id: 'nb-titlebar', label: 'Title Bar', icon: '▭',
      html: `<div class="nb-titlebar" data-nb-perm="">
        <span class="nb-titlebar-title">My App</span>
        <div class="nb-titlebar-controls">
          <button class="nb-titlebar-btn nb-titlebar-btn--min" data-nb-action="win:minimize">−</button>
          <button class="nb-titlebar-btn nb-titlebar-btn--max" data-nb-action="win:maximize">▢</button>
          <button class="nb-titlebar-btn nb-titlebar-btn--close" data-nb-action="win:close">×</button>
        </div>
      </div>`,
      css: `.nb-titlebar{display:flex;align-items:center;justify-content:space-between;height:32px;padding:0 12px;background:#0e121c;border-bottom:1px solid rgba(255,255,255,0.07);-webkit-app-region:drag;user-select:none}
.nb-titlebar-title{font:600 12px/1 "JetBrains Mono",monospace;color:#e6edf3}
.nb-titlebar-controls{display:flex;gap:8px;-webkit-app-region:no-drag}
.nb-titlebar-btn{width:14px;height:14px;border-radius:50%;border:none;cursor:pointer;font:600 8px/14px "JetBrains Mono",monospace;color:transparent;background:#f85149}
.nb-titlebar-btn--max{background:#d29922}
.nb-titlebar-btn--close{background:#22c55e}
.nb-titlebar-btn:hover{color:#0d1117}`,
    },
    {
      id: 'nb-accordion', label: 'Accordion Sidebar', icon: '☰',
      html: `<div class="nb-accordion">
        <details class="nb-accordion-item" open>
          <summary class="nb-accordion-head">Section 1</summary>
          <div class="nb-accordion-body">Content goes here</div>
        </details>
        <details class="nb-accordion-item">
          <summary class="nb-accordion-head">Section 2</summary>
          <div class="nb-accordion-body">More content</div>
        </details>
      </div>`,
      css: `.nb-accordion{display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,0.07);border-radius:8px;overflow:hidden}
.nb-accordion-item{background:#0e121c}
.nb-accordion-head{padding:10px 14px;cursor:pointer;font:600 12px/1 "JetBrains Mono",monospace;color:#e6edf3;list-style:none}
.nb-accordion-head::-webkit-details-marker{display:none}
.nb-accordion-head::before{content:"▸";display:inline-block;margin-right:8px;transition:transform 180ms ease}
.nb-accordion-item[open] .nb-accordion-head::before{transform:rotate(90deg)}
.nb-accordion-body{padding:8px 14px 14px;font:400 12px/1.5 "JetBrains Mono",monospace;color:#c9d1d9}`,
    },
    {
      id: 'nb-form-group', label: 'Form Group', icon: '▦',
      html: `<div class="nb-form-group">
        <label class="nb-form-label">Email</label>
        <input class="nb-form-input" type="email" placeholder="you@example.com">
        <span class="nb-form-hint nb-form-hint--ok">Valid</span>
      </div>`,
      css: `.nb-form-group{display:flex;flex-direction:column;gap:6px}
.nb-form-label{font:600 11px/1 "JetBrains Mono",monospace;color:#c9d1d9}
.nb-form-input{padding:8px 10px;border:1px solid rgba(255,255,255,0.12);border-radius:6px;background:#0e121c;color:#e6edf3;font:400 13px/1.4 "JetBrains Mono",monospace;outline:none}
.nb-form-input:focus{border-color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,0.2)}
.nb-form-input:invalid{border-color:#f85149}
.nb-form-hint{font:400 10px/1 "JetBrains Mono",monospace}
.nb-form-hint--ok{color:#22c55e}
.nb-form-hint--err{color:#f85149}`,
    },
    {
      id: 'nb-segmented', label: 'Segmented Control', icon: '⊙',
      html: `<div class="nb-segmented" role="tablist">
        <button class="nb-segmented-btn nb-segmented-btn--active" role="tab">Day</button>
        <button class="nb-segmented-btn" role="tab">Week</button>
        <button class="nb-segmented-btn" role="tab">Month</button>
      </div>`,
      css: `.nb-segmented{display:inline-flex;background:rgba(255,255,255,0.06);border-radius:8px;padding:2px;gap:2px}
.nb-segmented-btn{padding:6px 14px;border:none;background:transparent;color:#8b949e;font:600 12px/1 "JetBrains Mono",monospace;border-radius:6px;cursor:pointer;transition:background 180ms ease,color 180ms ease}
.nb-segmented-btn:hover{color:#c9d1d9}
.nb-segmented-btn--active{background:#22c55e;color:#0d1117}`,
    },
    {
      id: 'nb-toggle', label: 'Toggle Slider', icon: '◑',
      html: `<label class="nb-toggle">
        <input type="checkbox" checked>
        <span class="nb-toggle-track"><span class="nb-toggle-thumb"></span></span>
        <span class="nb-toggle-label">Enable notifications</span>
      </label>`,
      css: `.nb-toggle{display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.nb-toggle input{display:none}
.nb-toggle-track{width:36px;height:20px;background:rgba(255,255,255,0.1);border-radius:20px;position:relative;transition:background 180ms ease}
.nb-toggle-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;background:#e6edf3;border-radius:50%;transition:transform 180ms cubic-bezier(0.16,1,0.3,1)}
.nb-toggle input:checked + .nb-toggle-track{background:#22c55e}
.nb-toggle input:checked + .nb-toggle-track .nb-toggle-thumb{transform:translateX(16px)}
.nb-toggle-label{font:400 12px/1 "JetBrains Mono",monospace;color:#c9d1d9}`,
    },
    {
      id: 'nb-dropzone', label: 'Dropzone', icon: '⤓',
      html: `<div class="nb-dropzone" data-nb-perm="vfs:read">
        <div class="nb-dropzone-icon">⤓</div>
        <div class="nb-dropzone-text">Drop files here or click to browse</div>
        <div class="nb-dropzone-hint">Requires vfs:read</div>
      </div>`,
      css: `.nb-dropzone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px;border:2px dashed rgba(34,197,94,0.4);border-radius:12px;background:rgba(34,197,94,0.04);cursor:pointer;transition:background 180ms ease,border-color 180ms ease}
.nb-dropzone:hover,.nb-dropzone--over{background:rgba(34,197,94,0.1);border-color:#22c55e}
.nb-dropzone-icon{font-size:32px;color:#22c55e}
.nb-dropzone-text{font:600 12px/1 "JetBrains Mono",monospace;color:#e6edf3}
.nb-dropzone-hint{font:400 10px/1 "JetBrains Mono",monospace;color:#8b949e}`,
    },
  ];

  function _renderNativePalette() {
    const wrap = $('nbpro-native-palette');
    if (!wrap) return;
    wrap.innerHTML = NATIVE_COMPONENTS.map((c) =>
      `<button class="nbpro-palette-item" data-nb-comp="${_escapeHtmlAttr(c.id)}" draggable="true">
        <span class="nbpro-palette-icon">${c.icon}</span>
        <span class="nbpro-palette-label">${c.label}</span>
      </button>`).join('') +
      `<div class="nbpro-palette-divider"></div>
       <div class="nbpro-palette-section">Custom Components</div>
       <div id="nbpro-custom-palette"></div>
       <button class="nbpro-palette-item nbpro-palette-item--ghost" id="nbpro-save-as-comp">
         <span class="nbpro-palette-icon">+</span>
         <span class="nbpro-palette-label">Save selection as component…</span>
       </button>`;
    wrap.querySelectorAll('[data-nb-comp]').forEach((btn) => {
      btn.addEventListener('click', () => _insertNativeComponent(btn.dataset.nbComp));
      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/nbpro-comp', btn.dataset.nbComp);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
    wrap.querySelector('#nbpro-save-as-comp')?.addEventListener('click', _saveSelectionAsComponent);
    _renderCustomPalette();
  }

  function _renderCustomPalette() {
    const wrap = $('nbpro-custom-palette');
    if (!wrap) return;
    if (!_proState.customComponents.length) {
      wrap.innerHTML = '<div class="nbpro-empty-mini">No custom components yet</div>';
      return;
    }
    wrap.innerHTML = _proState.customComponents.map((c) =>
      `<button class="nbpro-palette-item" data-nb-custom="${_escapeHtmlAttr(c.id)}" draggable="true" title="${_escapeHtmlAttr(c.name)}">
        <span class="nbpro-palette-icon">⬢</span>
        <span class="nbpro-palette-label">${_esc(c.name)}</span>
        <span class="nbpro-palette-del" data-del="${_escapeHtmlAttr(c.id)}" title="Delete">×</span>
      </button>`).join('');
    wrap.querySelectorAll('[data-nb-custom]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        _insertCustomComponent(btn.dataset.nbCustom);
      });
      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/nbpro-custom', btn.dataset.nbCustom);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
    wrap.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _proState.customComponents = _proState.customComponents.filter((c) => c.id !== btn.dataset.del);
        _saveProState();
        _renderCustomPalette();
      });
    });
  }

  function _insertNativeComponent(compId) {
    const comp = NATIVE_COMPONENTS.find((c) => c.id === compId);
    if (!comp) return;
    if (_injectComponentHtml(comp.html, comp.css)) _showToast(`Inserted ${comp.label}`);
  }

  function _insertCustomComponent(compId) {
    const comp = _proState.customComponents.find((c) => c.id === compId);
    if (!comp) return;
    if (_injectComponentHtml(comp.html, comp.css || '')) _showToast(`Inserted ${comp.name}`);
  }

  function _injectComponentHtml(html, css) {
    if (!_readIndexHtml()) {
      _showToast('No readable entry HTML found');
      return false;
    }
    if (css && !_injectCssBlock(css)) return false;
    if (!_injectHtmlIntoBody(html)) return false;
    if (typeof window._designInvalidate === 'function') window._designInvalidate();
    return true;
  }

  function _injectCssBlock(css) {
    let cssFile = _readStyleCss();
    if (!cssFile) {
      const createdPath = window._designEnsureEntryStylesheet?.();
      if (!createdPath) { _showToast('No linked stylesheet is available.'); return false; }
      cssFile = _readStyleCss();
    }
    if (!cssFile?.files?.length) return false;
    const MARKER_START = '/* --- nbpro:components --- */';
    const MARKER_END   = '/* --- /nbpro:components --- */';
    const target = cssFile.files.find((file) => file.text.includes(MARKER_START)) || cssFile.files[0];
    const startIdx = target.text.indexOf(MARKER_START);
    let existing = '';
    if (startIdx >= 0) {
      const endIdx = target.text.indexOf(MARKER_END, startIdx);
      if (endIdx < 0) {
        _showToast(`Could not update "${_path().relative(_state().projectDir, target.path)}": the generated component block is incomplete.`);
        return false;
      }
      existing = target.text.slice(startIdx + MARKER_START.length, endIdx).trim() + '\n';
    }
    // Dedup by hashing — skip if the exact CSS body is already present.
    const hash = _hashCode(css);
    if (existing.indexOf(`/*css:${hash}*/`) >= 0) return true;
    const block = `\n/*css:${hash}*/\n${css}\n`;
    const newSection = MARKER_START + '\n' + existing + block + MARKER_END + '\n';
    let newText;
    if (startIdx >= 0) {
      const endIdx = target.text.indexOf(MARKER_END, startIdx);
      newText = target.text.slice(0, startIdx) + newSection + target.text.slice(endIdx + MARKER_END.length);
    } else {
      newText = target.text + '\n\n' + newSection;
    }
    return _writeCssUpdates(cssFile, new Map([[target.path, newText]]));
  }

  function _hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  function _injectHtmlIntoBody(html) {
    const idx = _readIndexHtml();
    if (!idx) { _showToast('No entry HTML found'); return false; }
    const insert = '\n' + html + '\n';
    let newText;
    if (/<\/body>/i.test(idx.text)) {
      newText = idx.text.replace(/<\/body\s*>/i, (close) => insert + close);
    } else if (/<\/html\s*>/i.test(idx.text)) {
      newText = idx.text.replace(/<\/html\s*>/i, (close) => insert + close);
    } else {
      newText = idx.text + insert;
    }
    try {
      _fs().writeFileSync(idx.path, newText, 'utf8');
      _noteOwnSourceWrite();
      return true;
    } catch (err) {
      _showToast('Could not write index.html: ' + err.message);
      return false;
    }
  }

  function _saveSelectionAsComponent() {
    const frame = $('design-frame');
    if (!frame?.contentWindow?.document) { _showToast('No selection'); return; }
    const sel = frame.contentWindow.document.querySelector('.__nb_selected');
    if (!sel) { _showToast('Select an element on the canvas first'); return; }
    const modal = $('nbpro-modal-save-comp');
    if (!modal) return;
    // Snapshot outerHTML (cleaned of internal marker classes)
    const clone = sel.cloneNode(true);
    clone.classList.remove('__nb_hover', '__nb_selected', '__nb_dragging');
    clone.querySelectorAll('[data-nb-design-path]').forEach((n) => n.removeAttribute('data-nb-design-path'));
    clone.removeAttribute('data-nb-design-path');
    if (!clone.getAttribute('class')) clone.removeAttribute('class');
    modal.querySelector('#nbpro-sc-html').value = clone.outerHTML;
    modal.querySelector('#nbpro-sc-name').value = '';
    modal.querySelector('#nbpro-sc-props').value = '';
    modal.classList.remove('hidden');
  }

  function _confirmSaveComponent() {
    const modal = $('nbpro-modal-save-comp');
    const name = modal.querySelector('#nbpro-sc-name').value.trim();
    const html = modal.querySelector('#nbpro-sc-html').value;
    const props = modal.querySelector('#nbpro-sc-props').value.trim();
    if (!name) { _showToast('Give the component a name'); return; }
    if (!html) { _showToast('No HTML captured'); return; }
    const id = 'c_' + Date.now().toString(36);
    _proState.customComponents.push({
      id, name, html,
      props: props ? props.split(/[,\n]\s*/).filter(Boolean) : [],
    });
    _saveProState();
    _renderCustomPalette();
    modal.classList.add('hidden');
    _showToast(`Saved "${name}" to your custom components`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   FEATURE 4 — Theme & Micro-Animation Inspector
  // ═════════════════════════════════════════════════════════════════════════
  // The theme manager reads CSS variables defined in linked stylesheets (:root and
  // [data-theme="..."] blocks) and presents them as an editable palette.
  // Edits write back to the matching linked stylesheet via surgical regex replacement of the
  // matching `--var: value;` line.

  function _extractThemeVars(cssText) {
    // Returns { scope: { varName: value } }, where `scope` is the *entire*
    // selector list exactly as it appears in the source (e.g.
    // ':root, [data-theme="nb-dark"]'), not just the fragment that looks
    // like a theme selector. The old regex tried to recognize ':root' and
    // '[data-theme="..."]' as separate alternatives, which split compound
    // selectors like ":root, [data-theme=\"nb-dark\"] { ... }" into two
    // duplicate scopes ("` :root`" and "`[data-theme=\"nb-dark\"]`")
    // sharing the same block. That looked merely like duplicated rows in
    // the Theme tab, but the real damage was on write-back: neither
    // fragment matches the actual selector text in the file, so "Write to
    // silently no-opped for every :root/data-theme block while
    // still showing a success toast.
    const out = {};
    // Selectors never legitimately contain /* */, so stripping comments
    // first can't eat real code -- and it stops the selector-capture group
    // below from running unbounded back into a preceding comment block
    // (which happened when comments sat directly above these rules, as
    // they do in this project's CSS files).
    const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    // Matches "<selector list>{...}" where the selector list contains
    // :root or [data-theme="..."] somewhere in it (so we don't pick up
    // unrelated rules), capturing the full selector text verbatim.
    const re = /([^{}]*(?::root|\[data-theme="[^"]+"\])[^{}]*)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(noComments)) !== null) {
      const scope = m[1].trim().replace(/\s+/g, ' ');
      const body = m[2];
      const vars = {};
      const varRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
      let vm;
      while ((vm = varRe.exec(body)) !== null) {
        vars[vm[1]] = vm[2].trim();
      }
      if (Object.keys(vars).length) out[scope] = vars;
    }
    return out;
  }

  function _extractColorsFromCss(cssText) {
    const colorRe = /(#[0-9a-fA-F]{3,8})\b|(rgba?\([^)]+\))|(hsla?\([^)]+\))/g;
    const seen = [];
    const seenSet = new Set();
    let m;
    while ((m = colorRe.exec(cssText)) !== null) {
      const val = m[0];
      if (!seenSet.has(val)) {
        seenSet.add(val);
        seen.push(val);
      }
    }
    const out = {};
    seen.forEach((val, i) => {
      out[`--nb-color-${i + 1}`] = val;
    });
    return out;
  }

  function _writeExtractedVarsToCss() {
    const cssFile = _readStyleCss();
    if (!cssFile?.files?.length) { _showToast('No linked stylesheet found'); return; }
    const vars = _extractColorsFromCss(cssFile.text);
    if (!Object.keys(vars).length) { _showToast('No color values found to extract'); return; }
    const entries = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    const rootBlock = `\n:root {\n${entries}\n}\n`;
    const varValues = new Set(Object.values(vars));
    const colorValRe = /(#[0-9a-fA-F]{3,8})\b|(rgba?\([^)]+\))|(hsla?\([^)]+\))/g;
    const updates = new Map();
    cssFile.files.forEach((file, index) => {
      let text = file.text.replace(colorValRe, (match) => {
        if (varValues.has(match)) {
          for (const [k, v] of Object.entries(vars)) {
            if (v === match) return `var(${k})`;
          }
        }
        return match;
      });
      if (index === 0) text = rootBlock + text;
      updates.set(file.path, text);
    });
    if (_writeCssUpdates(cssFile, updates)) {
      _showToast(`Extracted ${Object.keys(vars).length} CSS variables into linked stylesheets`);
      _renderThemeManager();
    }
  }

  function _renderThemeManager() {
    const panel = $('nbpro-theme-manager');
    if (!panel) return;
    const cssFile = _readStyleCss();
    if (!cssFile) {
      panel.innerHTML = '<div class="nbpro-empty">No linked stylesheet found in this project.</div>';
      return;
    }
    const vars = _extractThemeVars(cssFile.text);
    const scopes = Object.keys(vars);
    if (!scopes.length) {
      panel.innerHTML = '<div class="nbpro-empty">No CSS variables found in linked stylesheets.</div>' +
        '<button class="nbpro-btn nbpro-btn--primary" id="nbpro-tm-extract" style="margin-top:12px;">Extract CSS Variables from Colors</button>';
      const btn = panel.querySelector('#nbpro-tm-extract');
      if (btn) btn.addEventListener('click', () => {
        _writeExtractedVarsToCss();
      });
      return;
    }
    const presetRow =
      `<div class="nbpro-theme-presets">
        <span class="nbpro-bar-label">Preset:</span>
        <button class="nbpro-chip${_proState.themePreset === 'nb-dark' ? ' nbpro-chip--active' : ''}" data-theme-preset="nb-dark">Dark</button>
        <button class="nbpro-chip${_proState.themePreset === 'nb-light' ? ' nbpro-chip--active' : ''}" data-theme-preset="nb-light">Light</button>
        <button class="nbpro-chip${_proState.themePreset === 'midnight-blue' ? ' nbpro-chip--active' : ''}" data-theme-preset="midnight-blue">Midnight</button>
        <button class="nbpro-chip${_proState.themePreset === 'amber' ? ' nbpro-chip--active' : ''}" data-theme-preset="amber">Amber</button>
        <button class="nbpro-chip nbpro-chip--ghost" data-theme-preset="preview">Preview on canvas</button>
      </div>`;
    const scopeHtml = scopes.map((scope) => {
      const varList = Object.entries(vars[scope]).map(([name, val]) => {
        const isColor = /^(#|rgb|hsl|rgba|hsla)/.test(val);
        const colorInput = isColor
          ? `<input type="color" class="nbpro-var-color" data-var="${_escapeHtmlAttr(name)}" data-scope="${_escapeHtmlAttr(scope)}" value="${_coerceHex(val)}">`
          : '';
        return `<div class="nbpro-var-row">
          <span class="nbpro-var-name">${_esc(name)}</span>
          <input class="nbpro-var-input" data-var="${_escapeHtmlAttr(name)}" data-scope="${_escapeHtmlAttr(scope)}" value="${_escapeHtmlAttr(val)}">
          ${colorInput}
        </div>`;
      }).join('');
      return `<details class="nbpro-scope" open>
        <summary class="nbpro-scope-head">${_esc(scope)}</summary>
        <div class="nbpro-scope-body">${varList}</div>
      </details>`;
    }).join('');
    panel.innerHTML = presetRow + scopeHtml +
      `<div class="nbpro-ai-actions">
        <button class="nbpro-btn nbpro-btn--ghost" id="nbpro-tm-revert">Revert</button>
        <button class="nbpro-btn nbpro-btn--primary" id="nbpro-tm-apply">Write to stylesheets</button>
      </div>`;
    panel.querySelectorAll('.nbpro-var-input').forEach((el) => {
      el.addEventListener('input', (e) => {
        const sib = e.target.parentElement.querySelector('.nbpro-var-color');
        if (sib && /^#/.test(e.target.value)) sib.value = _coerceHex(e.target.value);
        _updateThemeVarLive(e.target.dataset.scope, e.target.dataset.var, e.target.value);
      });
    });
    panel.querySelectorAll('.nbpro-var-color').forEach((el) => {
      el.addEventListener('input', (e) => {
        const txt = e.target.parentElement.querySelector('.nbpro-var-input');
        if (txt) {
          txt.value = e.target.value;
          _updateThemeVarLive(txt.dataset.scope, txt.dataset.var, e.target.value);
        }
      });
    });
    panel.querySelectorAll('[data-theme-preset]').forEach((btn) => {
      btn.addEventListener('click', () => _applyThemePreset(btn.dataset.themePreset));
    });
    panel.querySelector('#nbpro-tm-apply')?.addEventListener('click', () => _writeThemeVarsToCss());
    panel.querySelector('#nbpro-tm-revert')?.addEventListener('click', () => {
      _revertThemeLive();
      _renderThemeManager();
    });
    // Snapshot for revert
    _themeLiveSnapshot = JSON.parse(JSON.stringify(vars));
  }

  let _themeLiveSnapshot = null;
  let _themeLiveOverrides = {}; // scope -> { varName: newValue }

  function _coerceHex(v) {
    if (!v) return '#000000';
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
    // Try rgb()/rgba()
    const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) {
      const toHex = (n) => parseInt(n, 10).toString(16).padStart(2, '0');
      return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
    }
    return '#000000';
  }

  function _updateThemeVarLive(scope, name, value) {
    if (value && typeof CSS !== 'undefined' && CSS.supports && !CSS.supports(name, value)) {
      _showToast(`Invalid CSS value for ${name}`);
      return;
    }
    if (!_themeLiveOverrides[scope]) _themeLiveOverrides[scope] = {};
    _themeLiveOverrides[scope][name] = value;
    // Apply to the design iframe's documentElement so the user sees the
    // change instantly without a full reload.
    const frame = $('design-frame');
    if (frame?.contentDocument) {
      // scope is the full selector list verbatim (e.g. ':root,
      // [data-theme="nb-dark"]' for the default theme's block, not just
      // one half of it) -- check for :root anywhere in that list rather
      // than requiring exact equality, or the compound-scope case falls
      // through to the data-theme branch and only live-previews when the
      // iframe happens to already be on that exact theme.
      if (/(^|[,\s]):root(\s*,|\s*$|\s+)/.test(scope) || scope === ':root') {
        _rememberThemeOriginal(frame.contentDocument.documentElement, name);
        if (value) frame.contentDocument.documentElement.style.setProperty(name, value);
        else frame.contentDocument.documentElement.style.removeProperty(name);
      } else {
        const m = scope.match(/\[data-theme="([^"]+)"\]/);
        if (m && frame.contentDocument.documentElement.getAttribute('data-theme') === m[1]) {
          _rememberThemeOriginal(frame.contentDocument.documentElement, name);
          if (value) frame.contentDocument.documentElement.style.setProperty(name, value);
          else frame.contentDocument.documentElement.style.removeProperty(name);
        }
      }
    }
  }

  let _themeLiveOriginals = {};
  let _themeOriginalDataTheme;
  let _themeOriginalFrame = null;

  function _rememberThemeOriginal(element, name) {
    const frame = $('design-frame');
    if (_themeOriginalFrame !== frame) {
      _themeLiveOriginals = {};
      _themeOriginalDataTheme = undefined;
      _themeOriginalFrame = frame;
    }
    if (Object.prototype.hasOwnProperty.call(_themeLiveOriginals, name)) return;
    _themeLiveOriginals[name] = {
      value: element.style.getPropertyValue(name),
      priority: element.style.getPropertyPriority(name),
    };
  }

  function _revertThemeLive() {
    const frame = $('design-frame');
    if (frame?.contentDocument) {
      const root = frame.contentDocument.documentElement;
      Object.entries(_themeLiveOriginals).forEach(([name, original]) => {
        if (original.value) root.style.setProperty(name, original.value, original.priority);
        else root.style.removeProperty(name);
      });
      if (_themeOriginalDataTheme !== undefined) {
        if (_themeOriginalDataTheme === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', _themeOriginalDataTheme);
      }
    }
    _themeLiveOriginals = {};
    _themeOriginalDataTheme = undefined;
    _themeOriginalFrame = null;
    _themeLiveOverrides = {};
  }

  function _writeThemeVarsToCss() {
    const cssFile = _readStyleCss();
    if (!cssFile?.files?.length) { _showToast('No linked stylesheet found'); return; }
    if (Object.values(_themeLiveOverrides).some((vars) =>
      Object.values(vars).some((value) => /[;{}]/.test(value))
    )) {
      _showToast('A CSS variable value contains characters that cannot be written safely.');
      return;
    }
    const updatedScopes = new Set();
    const updates = new Map();
    for (const file of cssFile.files) {
      let text = file.text;
      Object.entries(_themeLiveOverrides).forEach(([scope, vars]) => {
        const selectorPattern = scope.split(/\s+/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        const scopeRe = new RegExp(
          '(' + selectorPattern + '\\s*\\{)([^}]*)\\}',
          'g'
        );
        text = text.replace(scopeRe, (_full, head, body) => {
          updatedScopes.add(scope);
          let newBody = body;
          Object.entries(vars).forEach(([name, value]) => {
            const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const varRe = new RegExp('(' + escapedName + '\\s*:\\s*)([^;]*);');
            if (varRe.test(newBody)) {
              newBody = value
                ? newBody.replace(varRe, (_match, prefix) => prefix + value + ';')
                : newBody.replace(varRe, '');
            } else if (value) {
              newBody = newBody.replace(/\s*$/, '') + `\n  ${name}: ${value};\n`;
            }
          });
          return head + newBody + '}';
        });
      });
      if (text !== file.text) updates.set(file.path, text);
    }
    if (Object.keys(_themeLiveOverrides).length && updatedScopes.size === 0) {
      _showToast('Could not find the edited CSS variable scopes in linked stylesheets.');
      return;
    }
    if (_writeCssUpdates(cssFile, updates)) {
      _showToast('Theme variables written to linked stylesheets');
      _themeLiveOverrides = {};
      _themeLiveOriginals = {};
      _renderThemeManager();
    }
  }

  function _applyThemePreset(presetId) {
    if (presetId === 'preview') {
      // "Preview on canvas" is meant to preview whichever preset chip is
      // currently selected -- it was previously hardcoded to always pull
      // nb-dark's vars regardless of selection (and nothing ever tracked
      // a "currently selected preset" in the first place, so the button's
      // own highlighted/active look didn't correspond to real state
      // either). Fall back to nb-dark only if nothing's been picked yet.
      const activePreset = _proState.themePreset || 'nb-dark';
      const cssFile = _readStyleCss();
      if (!cssFile) return;
      const vars = _extractThemeVars(cssFile.text);
      const scopeKey = Object.keys(vars).find((s) => s === ':root' || s.indexOf(`[data-theme="${activePreset}"]`) >= 0)
        || Object.keys(vars).find((s) => s.indexOf(activePreset) >= 0)
        || ':root';
      const previewVars = vars[scopeKey] || {};
      const frame = $('design-frame');
      if (!frame?.contentDocument) return;
      Object.entries(previewVars).forEach(([name, value]) => {
        _rememberThemeOriginal(frame.contentDocument.documentElement, name);
        frame.contentDocument.documentElement.style.setProperty(name, value);
      });
      _showToast(`Previewing ${activePreset} theme on canvas`);
      return;
    }
    if (_themeOriginalDataTheme === undefined && presetId) {
      const frame = $('design-frame');
      if (frame?.contentDocument) {
        if (_themeOriginalFrame !== frame) {
          _themeLiveOriginals = {};
          _themeOriginalFrame = frame;
        }
        _themeOriginalDataTheme = frame.contentDocument.documentElement.hasAttribute('data-theme')
          ? frame.contentDocument.documentElement.getAttribute('data-theme')
          : null;
      }
    }
    // Apply preset by setting data-theme on the iframe
    const frame = $('design-frame');
    if (!frame?.contentDocument) return;
    frame.contentDocument.documentElement.setAttribute('data-theme', presetId);
    _proState.themePreset = presetId;
    _saveProState();
    _renderThemeManager();
    _showToast(`Canvas switched to ${presetId} preset`);
  }

  function _applySavedThemeToFrame() {
    const frame = $('design-frame');
    if (!frame?.contentDocument || !_proState.themePreset) return;
    frame.contentDocument.documentElement.setAttribute('data-theme', _proState.themePreset);
  }

  // ── Transitions & hover-state inspector ──────────────────────────────────
  const PSEUDO_STATES = [':hover', ':active', ':focus', ':focus-visible', ':disabled'];
  const EASING_CURVES = [
    { id: 'ease', label: 'ease' },
    { id: 'ease-in', label: 'ease-in' },
    { id: 'ease-out', label: 'ease-out' },
    { id: 'ease-in-out', label: 'ease-in-out' },
    { id: 'linear', label: 'linear' },
    { id: 'cubic-bezier(0.16,1,0.3,1)', label: 'spring' },
    { id: 'cubic-bezier(0.34,1.56,0.64,1)', label: 'overshoot' },
  ];
  const TRANSITION_PROPS = [
    { id: 'all', label: 'all' },
    { id: 'background', label: 'background' },
    { id: 'color', label: 'color' },
    { id: 'transform', label: 'transform' },
    { id: 'opacity', label: 'opacity' },
    { id: 'border-color', label: 'border' },
    { id: 'box-shadow', label: 'shadow' },
  ];

  function _renderAnimationInspector() {
    const panel = $('nbpro-anim-inspector');
    if (!panel) return;
    const sel = _proSelected;
    if (!sel) {
      panel.innerHTML = '<div class="nbpro-empty">Select an element to edit transitions and hover states.</div>';
      return;
    }
    const firstClass = sel.className?.trim().split(/\s+/)[0];
    const selector = sel.id
      ? '#' + _cssEscapeIdent(sel.id)
      : firstClass ? '.' + _cssEscapeIdent(firstClass) : sel.tag;
    panel.innerHTML =
      `<div class="nbpro-ai-head">
        <span class="nbpro-ai-tag">${_esc(sel.tag)}</span>
        ${sel.id ? `<span class="nbpro-ai-id">#${_esc(sel.id)}</span>` : ''}
        ${firstClass ? `<span class="nbpro-ai-cls">.${_esc(firstClass)}</span>` : ''}
      </div>
      <div class="nbpro-ai-row">
        <label class="nbpro-ai-label">Property</label>
        <select class="nbpro-ai-select" id="nbpro-ti-prop">
          ${TRANSITION_PROPS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="nbpro-ai-row nbpro-ai-row--pair">
        <div>
          <label class="nbpro-ai-label">Duration (ms)</label>
          <input type="range" class="nbpro-range" id="nbpro-ti-dur" min="0" max="2000" step="50" value="180">
          <output class="nbpro-range-out" id="nbpro-ti-dur-out">180</output>
        </div>
        <div>
          <label class="nbpro-ai-label">Delay (ms)</label>
          <input type="range" class="nbpro-range" id="nbpro-ti-delay" min="0" max="1000" step="20" value="0">
          <output class="nbpro-range-out" id="nbpro-ti-delay-out">0</output>
        </div>
      </div>
      <div class="nbpro-ai-row">
        <label class="nbpro-ai-label">Easing curve</label>
        <select class="nbpro-ai-select" id="nbpro-ti-easing">
          ${EASING_CURVES.map((e) => `<option value="${e.id}">${e.label}</option>`).join('')}
        </select>
      </div>
      <div class="nbpro-timeline" id="nbpro-ti-timeline">
        <div class="nbpro-timeline-track"></div>
        <div class="nbpro-timeline-marker"></div>
      </div>
      <div class="nbpro-ai-actions">
        <button class="nbpro-btn nbpro-btn--ghost" id="nbpro-ti-preview">Preview</button>
        <button class="nbpro-btn nbpro-btn--primary" id="nbpro-ti-apply">Add transition</button>
      </div>
      <div class="nbpro-pseudo-section">
        <div class="nbpro-pseudo-title">Pseudo-class states</div>
        ${PSEUDO_STATES.map((ps) => {
          const cls = ps.replace(/[^a-z-]/g, '');
          return `<div class="nbpro-pseudo-row">
            <button class="nbpro-chip nbpro-chip--ghost" data-pseudo="${ps}">${ps}</button>
            <input class="nbpro-pseudo-input" data-pseudo-input="${ps}" placeholder="background:#22c55e; transform:scale(1.05)">
          </div>`;
        }).join('')}
      </div>
      <div class="nbpro-ai-actions">
        <button class="nbpro-btn nbpro-btn--primary" id="nbpro-ti-apply-pseudo">Write pseudo-state rules</button>
      </div>`;
    panel.querySelector('#nbpro-ti-dur')?.addEventListener('input', (e) => {
      $('nbpro-ti-dur-out').textContent = e.target.value;
      _updateTimeline();
    });
    panel.querySelector('#nbpro-ti-delay')?.addEventListener('input', (e) => {
      $('nbpro-ti-delay-out').textContent = e.target.value;
      _updateTimeline();
    });
    panel.querySelector('#nbpro-ti-preview')?.addEventListener('click', _previewTransition);
    panel.querySelector('#nbpro-ti-apply')?.addEventListener('click', () => _applyTransitionRule(selector));
    panel.querySelector('#nbpro-ti-apply-pseudo')?.addEventListener('click', () => _applyPseudoRules(selector));
    panel.querySelectorAll('[data-pseudo]').forEach((btn) => {
      btn.addEventListener('click', () => _previewPseudoState(btn.dataset.pseudo));
    });
    _updateTimeline();
  }

  function _updateTimeline() {
    const timeline = $('nbpro-ti-timeline');
    if (!timeline) return;
    const dur = parseInt($('nbpro-ti-dur')?.value || '180', 10);
    const delay = parseInt($('nbpro-ti-delay')?.value || '0', 10);
    const marker = timeline.querySelector('.nbpro-timeline-marker');
    const track = timeline.querySelector('.nbpro-timeline-track');
    if (!marker || !track) return;
    const total = Math.max(500, dur + delay + 100);
    const durPct = (dur / total) * 100;
    const delayPct = (delay / total) * 100;
    track.style.cssText = `position:relative;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;`;
    track.innerHTML = `<div style="position:absolute;left:${delayPct}%;width:${durPct}%;height:100%;background:#22c55e;border-radius:3px;transition:width 50ms linear;"></div>`;
  }

  function _previewTransition() {
    const frame = $('design-frame');
    if (!frame?.contentWindow?.document) return;
    const sel = frame.contentWindow.document.querySelector('.__nb_selected');
    if (!sel) return;
    const prop = $('nbpro-ti-prop')?.value || 'all';
    const dur = $('nbpro-ti-dur')?.value || '180';
    const delay = $('nbpro-ti-delay')?.value || '0';
    const easing = $('nbpro-ti-easing')?.value || 'ease';
    const original = sel.style.transition;
    sel.style.transition = `${prop} ${dur}ms ${easing} ${delay}ms`;
    // Toggle a fake state to demonstrate the transition
    const toggleBg = sel.style.background;
    sel.style.background = 'rgba(34,197,94,0.3)';
    setTimeout(() => {
      sel.style.background = toggleBg;
      setTimeout(() => { sel.style.transition = original; }, parseInt(dur, 10) + parseInt(delay, 10) + 50);
    }, 100);
  }

  function _applyTransitionRule(selector) {
    selector = _ensureScopedSelector(selector);
    if (!selector) return;
    const prop = $('nbpro-ti-prop')?.value || 'all';
    const dur = $('nbpro-ti-dur')?.value || '180';
    const delay = $('nbpro-ti-delay')?.value || '0';
    const easing = $('nbpro-ti-easing')?.value || 'ease';
    const rule = `${selector} { transition: ${prop} ${dur}ms ${easing} ${delay}ms; }\n`;
    _injectCssBlock(rule);
    if (typeof window._designInvalidate === 'function') window._designInvalidate();
    _showToast(`Added transition to ${selector}`);
  }

  // Pseudo-state and transition rules get written into the component stylesheet block
  // as `${selector} { ... }`, so a bare-tag selector (no id/class on the
  // element) would silently target every matching tag on the page instead
  // of just the one you picked -- e.g. writing `div:hover { ... }` and
  // having it apply to every div in the document. If the current selection
  // has no id/class, this assigns a scoped, stable class to the live
  // element (persisted into index.html) before any rule references it.
  function _ensureScopedSelector(selector) {
    const sel = _proSelected;
    if (selector && (selector[0] === '#' || selector[0] === '.')) return selector;
    if (!sel || !sel.path || !sel.path.length) {
      _showToast('Select an element with an id or class first');
      return null;
    }
    const generated = `nb-el-${sel.path.join('-')}`;
    const ok = _assignClassToSource(sel.path.join('.'), generated);
    if (!ok) {
      _showToast('Could not scope this element -- add an id or class to it first');
      return null;
    }
    sel.className = sel.className ? `${sel.className} ${generated}` : generated;
    return `.${generated}`;
  }

  function _assignClassToSource(pathStr, className) {
    try {
      const parse5 = (typeof require === 'function') ? require('parse5') : null;
      if (!parse5) return false;
      const idx = _readIndexHtml();
      if (!idx) return false;
      const doc = parse5.parse(idx.text, { sourceCodeLocationInfo: true });
      const path = pathStr.split('.').map(Number);
      const node = _findNodeByPath(doc, path);
      if (!node || !node.attrs) return false;
      const existing = node.attrs.find((a) => a.name === 'class');
      const classes = existing ? existing.value.split(/\s+/).filter(Boolean) : [];
      if (classes.includes(className)) return true;
      classes.push(className);
      return _patchSourceAttribute(pathStr, 'class', classes.join(' ')).ok;
    } catch (err) {
      console.warn('[NBPro] assignClassToSource failed:', err);
      _showToast('Could not assign a class to the selected element: ' + err.message);
      return false;
    }
  }

  function _previewPseudoState(pseudo) {
    const frame = $('design-frame');
    if (!frame?.contentWindow?.document) return;
    const sel = frame.contentWindow.document.querySelector('.__nb_selected');
    if (!sel) return;
    const input = document.querySelector(`[data-pseudo-input="${pseudo}"]`);
    if (!input || !input.value.trim()) { _showToast(`Enter CSS for ${pseudo}`); return; }
    // Apply the declarations inline for ~1.2s as a live preview
    const decls = input.value.split(';').map((d) => d.trim()).filter(Boolean);
    const saved = {};
    decls.forEach((d) => {
      const [k, ...v] = d.split(':');
      if (!k || !v.length) return;
      const prop = k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      saved[prop] = sel.style[prop];
      sel.style[prop] = v.join(':').trim();
    });
    setTimeout(() => {
      Object.entries(saved).forEach(([k, v]) => { sel.style[k] = v; });
    }, 1200);
  }

  function _applyPseudoRules(selector) {
    const rules = [];
    PSEUDO_STATES.forEach((ps) => {
      const input = document.querySelector(`[data-pseudo-input="${ps}"]`);
      if (input && input.value.trim()) {
        // Convert inline-style declarations (background:#xxx; color:#yyy)
        // into a CSS rule body.
        const body = input.value.trim().replace(/;?\s*$/, ';');
        rules.push({ ps, body });
      }
    });
    if (!rules.length) { _showToast('Enter CSS for at least one pseudo-state'); return; }
    selector = _ensureScopedSelector(selector);
    if (!selector) return;
    const cssRules = rules.map((r) => `${selector}${r.ps} { ${r.body} }`);
    _injectCssBlock(cssRules.join('\n') + '\n');
    if (typeof window._designInvalidate === 'function') window._designInvalidate();
    _showToast(`Wrote ${cssRules.length} pseudo-state rule(s) for ${selector}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   FEATURE 5 — Developer-Centric Safeguards
  //   (AST Diff Preview + Code-Sync Conflict Resolver)
  // ═════════════════════════════════════════════════════════════════════════
  // Snapshots HTML and CSS source *before* a Design tab edit is applied,
  // and shows a side-by-side diff in a modal. When code is edited manually
  // in the Editor tab while the Design tab is open, we re-parse and
  // highlight the affected DOM elements on the canvas.

  let _astSnapshot = {
    html: null, css: {}, htmlPath: null, projectDir: null, ts: 0,
  };
  let _diffQueue = []; // pending edits waiting for review

  function _captureAstSnapshot() {
    const html = _readIndexHtml();
    const css = _readStyleCss();
    _astSnapshot = {
      html: html ? html.text : null,
      css: Object.fromEntries((css?.files || []).map((file) => [file.path, file.text])),
      htmlPath: html?.path || null,
      projectDir: _state()?.projectDir || null,
      ts: Date.now(),
    };
  }

  function _takeAstSnapshotNow() {
    _captureAstSnapshot();
    _showToast('Snapshot captured');
  }

  // Compute a line-level diff between two strings. Returns an array of
  // { type: 'equal'|'add'|'del', text } segments.
  function _lineDiff(a, b) {
    const aLines = (a || '').split('\n');
    const bLines = (b || '').split('\n');
    const n = aLines.length, m = bLines.length;
    if (n * m > 1000000) {
      let prefix = 0;
      while (prefix < n && prefix < m && aLines[prefix] === bLines[prefix]) prefix++;
      let suffix = 0;
      while (suffix < n - prefix && suffix < m - prefix &&
          aLines[n - suffix - 1] === bLines[m - suffix - 1]) suffix++;
      return [
        ...aLines.slice(0, prefix).map((text) => ({ type: 'equal', text })),
        ...aLines.slice(prefix, n - suffix).map((text) => ({ type: 'del', text })),
        ...bLines.slice(prefix, m - suffix).map((text) => ({ type: 'add', text })),
        ...aLines.slice(n - suffix).map((text) => ({ type: 'equal', text })),
      ];
    }
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (aLines[i] === bLines[j]) {
        out.push({ type: 'equal', text: aLines[i] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: 'del', text: aLines[i] });
        i++;
      } else {
        out.push({ type: 'add', text: bLines[j] });
        j++;
      }
    }
    while (i < n) { out.push({ type: 'del', text: aLines[i++] }); }
    while (j < m) { out.push({ type: 'add', text: bLines[j++] }); }
    return out;
  }

  function _computeAstDiff() {
    const html = _readIndexHtml();
    const css = _readStyleCss();
    const htmlDiff = _astSnapshot.html === null && !html
      ? []
      : _lineDiff(_astSnapshot.html ?? '', html?.text ?? '');
    const currentCss = Object.fromEntries((css?.files || []).map((file) => [file.path, file.text]));
    const cssDiff = [];
    const cssPaths = [...new Set([
      ...Object.keys(_astSnapshot.css || {}),
      ...Object.keys(currentCss),
    ])].sort();
    for (const cssPath of cssPaths) {
      const diff = _lineDiff(_astSnapshot.css?.[cssPath] ?? '', currentCss[cssPath] ?? '');
      if (diff.some((segment) => segment.type !== 'equal')) {
        cssDiff.push({ type: 'equal', text: `/* ${cssPath} */` }, ...diff);
      }
    }
    return { htmlDiff, cssDiff, htmlPath: html?.path, cssPath: cssPaths };
  }

  function _renderAstDiffPanel() {
    const modal = $('nbpro-modal-ast-diff');
    if (!modal) return;
    if (!_state()?.projectDir || _astSnapshot.projectDir !== _state().projectDir) {
      modal.querySelector('#nbpro-ast-diff-left').textContent = 'Capture a snapshot for the current project before reviewing changes.';
      modal.querySelector('#nbpro-ast-diff-right').textContent = '';
      modal.querySelector('#nbpro-ast-diff-stats').textContent = 'No snapshot for this project';
      modal.classList.remove('hidden');
      return;
    }
    const { htmlDiff, cssDiff, htmlPath, cssPath } = _computeAstDiff();
    const renderDiff = (diff, filePath) => {
      if (!diff.length) return `<div class="nbpro-diff-empty">No changes in ${_esc(filePath)}</div>`;
      const lines = diff.slice(0, 500).map((seg) => {
        const cls = seg.type === 'add' ? 'nbpro-diff-add' :
                    seg.type === 'del' ? 'nbpro-diff-del' : 'nbpro-diff-eq';
        const prefix = seg.type === 'add' ? '+' : seg.type === 'del' ? '−' : ' ';
        return `<div class="nbpro-diff-line ${cls}"><span class="nbpro-diff-sign">${prefix}</span><span class="nbpro-diff-text">${_esc(seg.text)}</span></div>`;
      }).join('');
      return `<div class="nbpro-diff-path">${_esc(filePath)}</div><div class="nbpro-diff-body">${lines}</div>`;
    };
    modal.querySelector('#nbpro-ast-diff-left').innerHTML =
      `<div class="nbpro-diff-title">Entry HTML</div>` + renderDiff(htmlDiff, htmlPath || '(no file)');
    modal.querySelector('#nbpro-ast-diff-right').innerHTML =
      `<div class="nbpro-diff-title">Linked stylesheets</div>` +
      renderDiff(cssDiff, cssPath.length ? cssPath.map((filePath) => _path().relative(_state().projectDir, filePath)).join(', ') : '(no linked stylesheets)');
    const stats = {
      add: htmlDiff.concat(cssDiff).filter((s) => s.type === 'add').length,
      del: htmlDiff.concat(cssDiff).filter((s) => s.type === 'del').length,
    };
    modal.querySelector('#nbpro-ast-diff-stats').textContent =
      `+${stats.add} additions / −${stats.del} deletions`;
    modal.classList.remove('hidden');
  }

  function _esc(s) {
    return String(s || '').replace(/[&<>]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  }

  function _cssEscapeIdent(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
    const chars = Array.from(String(value));
    return chars.map((char, index) => {
      const code = char.codePointAt(0);
      if (code === 0) return '\uFFFD';
      if ((code >= 1 && code <= 31) || code === 127 ||
          (index === 0 && code >= 48 && code <= 57) ||
          (index === 1 && chars[0] === '-' && code >= 48 && code <= 57)) {
        return '\\' + code.toString(16) + ' ';
      }
      if (index === 0 && char === '-' && chars.length === 1) return '\\-';
      if (code >= 128 || char === '-' || char === '_' ||
          (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122)) return char;
      return '\\' + char;
    }).join('');
  }

  function _acceptAstDiff() {
    // Snapshot the current state as the new baseline.
    _captureAstSnapshot();
    $('nbpro-modal-ast-diff')?.classList.add('hidden');
    _showToast('Changes accepted — new baseline set');
  }

  function _revertAstDiff() {
    // Restore the snapshot, overwriting current files.
    const html = _readIndexHtml();
    const fs = _fs();
    if (!_state()?.projectDir || _astSnapshot.projectDir !== _state().projectDir) {
      _showToast('Capture a snapshot for the current project before reverting.');
      return;
    }
    const htmlPath = _astSnapshot.htmlPath || html?.path || null;
    const baselineCss = _astSnapshot.css || {};
    if (!fs || (!htmlPath && !Object.keys(baselineCss).length) ||
        (_astSnapshot.html === null && !Object.keys(baselineCss).length)) {
      _showToast('No captured HTML/CSS baseline is available to restore.');
      return;
    }
    let currentHtml = null;
    const currentCss = new Map();
    try {
      currentHtml = htmlPath && fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null;
      for (const cssPath of Object.keys(baselineCss)) {
        currentCss.set(cssPath, fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : null);
      }
    } catch (err) {
      _showToast('Could not read current files for rollback: ' + err.message);
      return;
    }
    const restoreFile = (filePath, content) => {
      if (!filePath) return;
      if (content === null) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
    };
    try {
      for (const [cssPath, text] of Object.entries(baselineCss)) restoreFile(cssPath, text);
      if (_astSnapshot.html !== null) restoreFile(htmlPath, _astSnapshot.html);
    } catch (err) {
      const rollbackErrors = [];
      for (const [filePath, content] of [[htmlPath, currentHtml], ...currentCss]) {
        try { restoreFile(filePath, content); }
        catch (rollbackErr) { rollbackErrors.push(rollbackErr.message); }
      }
      const rollbackMessage = rollbackErrors.length
        ? ` Rollback was incomplete: ${rollbackErrors.join('; ')}`
        : '';
      _showToast('Could not revert to baseline: ' + err.message + rollbackMessage);
      return;
    }
    _noteOwnSourceWrite();
    if (typeof window._designInvalidate === 'function') window._designInvalidate();
    $('nbpro-modal-ast-diff')?.classList.add('hidden');
    _showToast('Reverted to baseline');
  }

  // ── Code-Sync Conflict Resolver ──────────────────────────────────────────
  // Monitors file writes (from app.js's editor save path) and detects when
  // the design iframe's source has drifted. When drift is detected, the
  // affected DOM elements get a brief highlight on the canvas.
  let _lastKnownHash = { html: null, css: null };
  let _lastKnownProjectDir = null;
  let _syncPollTimer = null;

  function _hashString(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  function _hashCssFiles(css) {
    return _hashString((css?.files || [])
      .map((file) => `${file.path}\0${file.text}`)
      .join('\0'));
  }

  function _captureKnownHashes() {
    const html = _readIndexHtml();
    const css = _readStyleCss();
    _lastKnownHash.html = html ? _hashString(html.text) : null;
    _lastKnownHash.css = _hashCssFiles(css);
    _lastKnownProjectDir = _state()?.projectDir || null;
  }

  function _pollForSyncDrift() {
    if (state && state.activeTab !== 'design') return;
    const projectDir = _state()?.projectDir || null;
    if (projectDir !== _lastKnownProjectDir) {
      _captureAstSnapshot();
      _captureKnownHashes();
      return;
    }
    const html = _readIndexHtml();
    const entryPath = window._designGetProjectFiles?.().html || null;
    if (entryPath !== (_astSnapshot.htmlPath || null)) {
      _captureAstSnapshot();
      _captureKnownHashes();
      return;
    }
    const css = _readStyleCss();
    const htmlHash = html ? _hashString(html.text) : null;
    const cssHash = _hashCssFiles(css);
    if (_lastKnownHash.html !== null && _lastKnownHash.html !== htmlHash) {
      _onSourceDrift('html', html);
      _lastKnownHash.html = htmlHash;
    }
    if (_lastKnownHash.css !== null && _lastKnownHash.css !== cssHash) {
      _onSourceDrift('css', css);
      _lastKnownHash.css = cssHash;
    }
  }

  function _onSourceDrift(kind, file) {
    // Reload the iframe to pick up the external changes, then highlight.
    if (typeof window._designInvalidate === 'function') window._designInvalidate();
    setTimeout(() => {
      _postFrame({ type: 'nbpro:flashAll' });
      _showToast(`External ${kind} change detected — canvas resynced`);
    }, 300);
  }

  function _startSyncPolling() {
    if (_syncPollTimer) clearInterval(_syncPollTimer);
    _captureKnownHashes();
    _syncPollTimer = setInterval(_pollForSyncDrift, 1500);
  }

  // Called by app.js right after it writes entry HTML/linked stylesheets from the
  // Design tab's own edit paths (debounced field edits, delete/insert/
  // duplicate, undo/redo). Those writes are expected -- not an external
  // change -- but _pollForSyncDrift has no way to tell the difference on
  // its own, since it only ever compares content hashes. Without this,
  // every own-write gets misread as drift and force-reloads the canvas
  // mid-edit (see _onSourceDrift), which is what was deselecting the
  // element and showing "External html change detected" while just
  // typing into the text field. Re-capturing the hash immediately after
  // our own write keeps the next poll tick from seeing a diff.
  window._nbproNoteOwnWrite = function () {
    _captureKnownHashes();
  };

  window._nbproOnProjectLoaded = function () {
    _captureAstSnapshot();
    _captureKnownHashes();
  };

  // ═════════════════════════════════════════════════════════════════════════
  //   Inspector tab routing (the right-hand panel under the design canvas)
  // ═════════════════════════════════════════════════════════════════════════
  const INSPECTOR_TABS = [
    { id: 'attrs',    label: 'Attrs',    render: null /* app.js's existing panel */, panelId: null },
    { id: 'actions',  label: 'Actions',  render: _renderActionInspector, panelId: 'nbpro-action-inspector' },
    { id: 'data',     label: 'Data',     render: _renderDataBindingInspector, panelId: 'nbpro-data-inspector' },
    { id: 'theme',    label: 'Theme',    render: _renderThemeManager, panelId: 'nbpro-theme-manager' },
    { id: 'anim',     label: 'Animate',  render: _renderAnimationInspector, panelId: 'nbpro-anim-inspector' },
    { id: 'native',   label: 'Native',   render: _renderNativePalette, panelId: 'nbpro-native-palette' },
    { id: 'diff',     label: 'Diff',     render: null /* opens a modal */, panelId: null },
  ];

  function _switchInspectorTab(id) {
    const tabs = $('nbpro-inspector-tabs');
    const body = $('nbpro-inspector-body');
    if (!tabs || !body) return;
    tabs.querySelectorAll('.nbpro-ins-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === id);
    });
    // Hide the existing app.js Attributes panel when switching away.
    const existing = $('design-attrs');
    if (existing) existing.style.display = (id === 'attrs') ? '' : 'none';
    body.style.display = (id === 'attrs') ? 'none' : '';
    if (id === 'diff') {
      _renderAstDiffPanel();
      body.innerHTML = '<div class="nbpro-empty">Diff opened in modal — close it to return.</div>';
      return;
    }
    const tab = INSPECTOR_TABS.find((t) => t.id === id);
    if (tab && tab.render) {
      // Each render function looks up its own container by ID (e.g. #nbpro-action-inspector)
      // instead of writing into #nbpro-inspector-body directly, so that container has to
      // exist before render() runs or it silently no-ops on `if (!panel) return`.
      body.innerHTML = tab.panelId ? `<div id="${tab.panelId}"></div>` : '';
      try { tab.render(); } catch (err) {
        body.innerHTML = `<div class="nbpro-empty nbpro-warn">Error: ${err.message}</div>`;
      }
    } else {
      body.innerHTML = '';
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   Message router — called from app.js's existing nb-design listener
  // ═════════════════════════════════════════════════════════════════════════
  function onDesignMessage(msg) {
    if (!msg || msg.source !== 'nb-design') return;
    switch (msg.type) {
      case 'select':
      case 'contextmenu': {
        const nextPath = (msg.element?.path || '').split('.').map(Number).filter(Number.isSafeInteger);
        if (_proSelected?.path.join('.') !== nextPath.join('.')) {
          _proPendingAction = null;
          _proPendingParams = null;
        }
        _proSelected = {
          path: nextPath,
          tag: msg.element?.tag,
          id: msg.element?.id,
          className: msg.element?.className,
        };
        // Re-render whichever inspector tab is currently active.
        const active = document.querySelector('.nbpro-ins-tab.active');
        if (active) _switchInspectorTab(active.dataset.tab);
        break;
      }
      case 'pathChanged':
        if (_proSelected && msg.tag === _proSelected.tag && /^\d+(?:\.\d+)*$/.test(msg.path || '')) {
          _proSelected.path = msg.path.split('.').map(Number);
          const active = document.querySelector('.nbpro-ins-tab.active');
          if (active && active.dataset.tab === 'actions') _renderActionInspector();
        }
        break;
      case 'bindingPathsChanged': {
        if (!Array.isArray(msg.paths)) break;
        const paths = new Map(msg.paths.filter((entry) =>
          Array.isArray(entry) && entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string' &&
          /^\d+(?:\.\d+)*$/.test(entry[1])
        ));
        let changed = false;
        _proState.bindings = _proState.bindings.flatMap((binding) => {
          if (!binding.targetId) return [binding];
          const path = paths.get(binding.targetId);
          if (!path) {
            if (binding.orphaned) return [binding];
            changed = true;
            return [{ ...binding, orphaned: true }];
          }
          if (path !== binding.elementPath || binding.orphaned) {
            changed = true;
            return [{ ...binding, elementPath: path, orphaned: false }];
          }
          return [binding];
        });
        if (changed) {
          _saveProState();
          if (!_injectHandlerToAppJs()) {
            _showToast('Could not synchronize generated action handlers after a canvas structure change.');
          }
        }
        break;
      }
      case 'nbpro:flexGizmo':
        _onFlexGizmo(msg);
        break;
      case 'nbpro:gridTrack':
        _onGridTrack(msg);
        break;
      case 'nbpro:permBadgeClick':
        _onPermBadgeClick(msg);
        break;
      default:
        // Unknown NBPro messages are ignored.
        break;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   Init — wires DOM events, injects runtime, captures baseline
  // ═════════════════════════════════════════════════════════════════════════
  function init() {
    _loadProState();

    // Inject NBPro chrome into the Design tab if it isn't already there
    // (the HTML container elements are added by index.html edits; this is
    // a fallback for if those edits aren't present yet).
    _ensureChrome();

    // Wire up DPI/layout bars
    _renderDpiBar();
    _renderLayoutBar();

    // Wire inspector tabs
    document.querySelectorAll('.nbpro-ins-tab').forEach((btn) => {
      btn.addEventListener('click', () => _switchInspectorTab(btn.dataset.tab));
    });

    // Wire modal dismiss / action buttons
    document.querySelectorAll('[data-nbpro-close]').forEach((el) => {
      el.addEventListener('click', () => {
        const modal = el.closest('.nbpro-modal');
        modal?.classList.add('hidden');
      });
    });
    $('nbpro-ga-apply')?.addEventListener('click', _applyGridAreas);
    $('nbpro-sc-confirm')?.addEventListener('click', _confirmSaveComponent);
    $('nbpro-ast-diff-accept')?.addEventListener('click', _acceptAstDiff);
    $('nbpro-ast-diff-revert')?.addEventListener('click', _revertAstDiff);
    $('nbpro-ast-diff-refresh')?.addEventListener('click', _renderAstDiffPanel);

    // Toolbar buttons
    $('nbpro-btn-ast-diff')?.addEventListener('click', () => {
      _renderAstDiffPanel();
    });
    $('nbpro-btn-snapshot')?.addEventListener('click', _takeAstSnapshotNow);

    // Inject runtime into the iframe when it loads. We listen on the
    // iframe's load event so we re-inject after every reload (which
    // happens when the user saves index.html externally, etc.).
    window._nbproOnDesignFrameCreated = (frame) => {
      if (!frame || frame.dataset.nbproLoadWired) return;
      frame.dataset.nbproLoadWired = '1';
      _proSelected = null;
      _proPendingAction = null;
      const activeTab = document.querySelector('.nbpro-ins-tab.active');
      if (activeTab) _switchInspectorTab(activeTab.dataset.tab);
      frame.addEventListener('load', () => {
        if ($('design-frame') !== frame) return;
        _injectProRuntime();
        _applyDpiToFrame();
        _applySavedThemeToFrame();
      });
    };
    const frame = $('design-frame');
    window._nbproOnDesignFrameCreated(frame);
    if (frame?.contentDocument?.readyState === 'complete') {
      _injectProRuntime();
      _applyDpiToFrame();
      _applySavedThemeToFrame();
    }

    // Start code-sync polling
    _startSyncPolling();

    // Capture initial AST snapshot when a project is loaded — defer to
    // next tick so app.js's loadProject has had a chance to set state.
    setTimeout(() => {
      _captureAstSnapshot();
      _captureKnownHashes();
    }, 500);

    // Re-render native palette once
    _renderNativePalette();
  }

  // Fallback: ensure the NBPro chrome elements exist in the DOM even if
  // index.html wasn't updated. We insert them as siblings of the existing
  // design-attrs panel. This is a defensive measure — the proper integration
  // is via the index.html edits, but this keeps NBPro functional if those
  // edits are missing.
  function _ensureChrome() {
    // index.html now ships #nbpro-dpi-bar as a static empty placeholder
    // (inside the DPI/Window popup markup), not just as something this
    // function creates on demand -- so "the element exists" no longer
    // means "the chrome is built." Check for actual content instead,
    // otherwise this bails before ever populating the inspector tabs.
    if ($('nbpro-dpi-bar')?.children.length) return; // chrome already built

    const designAttrs = $('design-attrs');
    if (!designAttrs) return;

    // DPI + layout bars used to be injected here as an in-canvas toolbar
    // row, but that's now dead weight: index.html ships #nbpro-dpi-bar and
    // #nbpro-layout-bar statically inside #design-dpi-popup instead (opened
    // from the Window button in .design-fs-actions). Building a second
    // #nbpro-dpi-bar here would create a duplicate id and put a stale
    // toolbar row back into the canvas area that the popup redesign was
    // meant to remove.

    // Right-side inspector tabs + body, stacked above design-attrs inside
    // a shared fixed-width column. If index.html already has the
    // .design-attrs-col wrapper, reuse it; otherwise build one so the tab
    // bar never lands as a raw flex sibling of design-attrs (that layout
    // has no width constraint of its own and squishes the canvas).
    let col = designAttrs.closest('.design-attrs-col');
    if (!col) {
      const parent = designAttrs.parentElement;
      if (!parent) return;
      col = document.createElement('div');
      col.className = 'design-attrs-col';
      col.id = 'design-attrs-col';
      parent.insertBefore(col, designAttrs);
      if (designAttrs.parentElement !== col) col.appendChild(designAttrs);
    }

    // Reuse the tabs/body elements if index.html already shipped them
    // statically, otherwise create them — but either way we still need to
    // populate the buttons and insert into the DOM, since the static
    // markup ships as empty placeholder divs, not pre-filled chrome.
    let tabs = $('nbpro-inspector-tabs');
    let body = $('nbpro-inspector-body');
    const isNewTabs = !tabs;
    const isNewBody = !body;
    if (!tabs) {
      tabs = document.createElement('div');
      tabs.className = 'nbpro-ins-tabs';
      tabs.id = 'nbpro-inspector-tabs';
    }
    if (!body) {
      body = document.createElement('div');
      body.className = 'nbpro-ins-body';
      body.id = 'nbpro-inspector-body';
      body.style.display = 'none';
    }
    tabs.innerHTML = INSPECTOR_TABS.map((t) =>
      `<button class="nbpro-ins-tab ${t.id === 'attrs' ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('');
    if (isNewTabs) col.insertBefore(tabs, designAttrs);
    if (isNewBody) col.insertBefore(body, designAttrs);
    // Not wiring click listeners here — init() already does a
    // querySelectorAll('.nbpro-ins-tab') pass right after calling
    // _ensureChrome(), which will pick these buttons up whether they're
    // the static ones (now filled in) or freshly created ones. Binding
    // here too would give every button two listeners, double-firing
    // _switchInspectorTab() on each click.

    // Modals (appended to body)
    const modals = `
      <div class="nbpro-modal hidden" id="nbpro-modal-grid-areas">
        <div class="nbpro-modal-card">
          <div class="nbpro-modal-head">
            <span class="nbpro-modal-title">Edit CSS Grid Named Areas</span>
            <button class="nbpro-modal-x" data-nbpro-close>×</button>
          </div>
          <div class="nbpro-modal-body">
            <p class="nbpro-modal-hint">One row per line. Each row is a quoted string of space-separated area names. All rows must have the same number of columns.</p>
            <textarea class="nbpro-modal-area" id="nbpro-ga-input" rows="6" spellcheck="false"></textarea>
            <div class="nbpro-modal-err" id="nbpro-ga-error"></div>
          </div>
          <div class="nbpro-modal-foot">
            <button class="nbpro-btn nbpro-btn--ghost" data-nbpro-close>Cancel</button>
            <button class="nbpro-btn nbpro-btn--primary" id="nbpro-ga-apply">Apply</button>
          </div>
        </div>
      </div>
      <div class="nbpro-modal hidden" id="nbpro-modal-save-comp">
        <div class="nbpro-modal-card">
          <div class="nbpro-modal-head">
            <span class="nbpro-modal-title">Save as Custom Component</span>
            <button class="nbpro-modal-x" data-nbpro-close>×</button>
          </div>
          <div class="nbpro-modal-body">
            <div class="nbpro-form-row">
              <label class="nbpro-form-label">Component name</label>
              <input class="nbpro-form-input" id="nbpro-sc-name" placeholder="My Card">
            </div>
            <div class="nbpro-form-row">
              <label class="nbpro-form-label">Props (comma-separated)</label>
              <input class="nbpro-form-input" id="nbpro-sc-props" placeholder="title, subtitle">
            </div>
            <div class="nbpro-form-row">
              <label class="nbpro-form-label">HTML</label>
              <textarea class="nbpro-form-area" id="nbpro-sc-html" rows="8" spellcheck="false"></textarea>
            </div>
          </div>
          <div class="nbpro-modal-foot">
            <button class="nbpro-btn nbpro-btn--ghost" data-nbpro-close>Cancel</button>
            <button class="nbpro-btn nbpro-btn--primary" id="nbpro-sc-confirm">Save component</button>
          </div>
        </div>
      </div>
      <div class="nbpro-modal hidden" id="nbpro-modal-ast-diff">
        <div class="nbpro-modal-card nbpro-modal-card--wide">
          <div class="nbpro-modal-head">
            <span class="nbpro-modal-title">AST Diff Preview</span>
            <span class="nbpro-modal-sub" id="nbpro-ast-diff-stats"></span>
            <button class="nbpro-modal-x" data-nbpro-close>×</button>
          </div>
          <div class="nbpro-modal-body nbpro-diff-split">
            <div class="nbpro-diff-side" id="nbpro-ast-diff-left"></div>
            <div class="nbpro-diff-side" id="nbpro-ast-diff-right"></div>
          </div>
          <div class="nbpro-modal-foot">
            <button class="nbpro-btn nbpro-btn--ghost" id="nbpro-ast-diff-refresh">Refresh</button>
            <button class="nbpro-btn nbpro-btn--danger" id="nbpro-ast-diff-revert">Revert to baseline</button>
            <button class="nbpro-btn nbpro-btn--primary" id="nbpro-ast-diff-accept">Accept changes</button>
          </div>
        </div>
      </div>
    `;
    const div = document.createElement('div');
    div.innerHTML = modals;
    while (div.firstChild) {
      const child = div.firstChild;
      if (child.contains(document.body)) {
        div.removeChild(child);
        continue;
      }
      document.body.appendChild(child);
    }

    // Re-wire modal close buttons now that they exist
    document.querySelectorAll('[data-nbpro-close]').forEach((el) => {
      if (el.dataset.nbproWired) return;
      el.dataset.nbproWired = '1';
      el.addEventListener('click', () => {
        const modal = el.closest('.nbpro-modal');
        modal?.classList.add('hidden');
      });
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────
  window.NBPro = {
    init,
    onDesignMessage,
    // Called from app.js's frame resize-handle drag: clears the active DPI
    // preset once the user hand-sizes the frame, since the preset chip
    // would otherwise keep showing "active" for a size no longer in effect.
    setDpiPreset: _setDpiPreset,
    clearDpiPresetFlagOnly: _clearDpiPresetFlagOnly,
    // Lets app.js's canvas drop handler insert a Native-tab component by id
    // (built-in or custom) -- the palette buttons already call the local
    // _insertNativeComponent/_insertCustomComponent directly on click, but
    // drag-and-drop from the palette originates in app.js's frameEl 'drop'
    // listener, which has no access to this module's closure-private
    // functions or NATIVE_COMPONENTS/customComponents data otherwise.
    insertNativeComponent: _insertNativeComponent,
    insertCustomComponent: _insertCustomComponent,
    // Exposed for testing / external scripting
    _internal: {
      IPC_ACTIONS,
      NATIVE_COMPONENTS,
      DPI_PRESETS,
      DPI_SCALES,
      PSEUDO_STATES,
      EASING_CURVES,
      _lineDiff,
      _extractThemeVars,
      _coerceHex,
      _hashCode,
      _scanAppStateKeys,
      _isPermissionDeclared,
      _readProjectManifest,
      _readIndexHtml,
      _readStyleCss,
      _readAppJs,
    },
  };

  // Auto-init on DOMContentLoaded if app.js hasn't done it for us.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
  } else {
    setTimeout(init, 100);
  }
})();