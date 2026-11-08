// [NOVAPACK_BUILDER_JS] -- from NovaPack Studio, not NBOSP
'use strict';

/**
 * NovaByte Studio — Builder
 * Packages an app directory into a .novaapp file.
 * Ported from novaapp-cli.js, runs as a Node.js module inside NW.js.
 */

const fs    = require('fs');
const path  = require('path');
const { execFile } = require('child_process');
const ignore = require('ignore');

const AppPackage = (typeof window !== 'undefined' && window.__NB_SDK && window.__NB_SDK['AppPackage'])
  || require('./app-package.js');
const { PERMISSION_IDS, LEGACY_PERMISSION_ALIASES } = require('./permissions.js');

// ── C++ / WebAssembly compilation ───────────────────────────────────────────
//
// Native compilation prefers the platform-specific Emscripten SDK shipped
// alongside Studio, then falls back to an SDK already available on PATH.
// Child processes are asynchronous so compiling never blocks NW.js's UI
// thread or triggers Atomics.wait restrictions in the renderer.

const CPP_SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);

/**
 * Find every C/C++ source file in the project, using the same
 * walkProjectFiles traversal (and skip rules) as the rest of the bundler,
 * so "what counts as part of this project" stays defined in one place.
 *
 * @param {string} absDir
 * @returns {string[]} Absolute paths to .cpp/.cc/.cxx/.c files, if any
 */
function detectCppSources(absDir) {
  const found = [];
  walkProjectFiles(absDir, (full, rel) => {
    if (CPP_SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) found.push(full);
  });
  return found;
}

/** Run a child process without blocking the NW.js renderer. */
function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function findBundledEmsdk() {
  const envFile = process.platform === 'win32' ? 'emsdk_env.bat' : 'emsdk_env.sh';
  if (process.env.NOVAPACK_EMSDK) {
    const explicitRoot = path.resolve(process.env.NOVAPACK_EMSDK);
    if (fs.existsSync(path.join(explicitRoot, envFile))) return explicitRoot;
  }
  const starts = [
    process.resourcesPath,
    path.dirname(process.execPath),
    typeof __dirname !== 'undefined' ? __dirname : null,
    process.cwd(),
  ].filter(Boolean);
  const checked = new Set();
  for (const start of starts) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      if (checked.has(current)) break;
      checked.add(current);
      const envScript = path.join(current, 'emsdk', envFile);
      if (fs.existsSync(envScript)) return path.dirname(envScript);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

async function loadEmsdkEnvironment(emsdkRoot) {
  const windows = process.platform === 'win32';
  const env = {
    ...process.env,
    EM_CONFIG: path.join(emsdkRoot, '.emscripten'),
  };
  if (windows) {
    // EMSDK supports x64 Windows-host tools on ARM64 Windows through
    // emulation. Keep the host architecture aligned with the bundled SDK,
    // even when NovaByte Studio itself is running on an ARM64 Windows host.
    env.EMSDK_ARCH = 'x86_64';
    await runFile('cmd.exe', ['/d', '/c', 'call emsdk.bat activate latest'], {
      cwd: emsdkRoot,
      env,
    });
  } else {
    await runFile(path.join(emsdkRoot, 'emsdk'), ['activate', 'latest'], {
      cwd: emsdkRoot,
      env,
    });
  }

  const result = windows
    ? await runFile('cmd.exe', ['/d', '/c', 'call emsdk_env.bat >nul && set'], { cwd: emsdkRoot, env })
    : await runFile('/bin/bash', ['-c', 'source "$1/emsdk_env.sh" >/dev/null && env -0', 'novapack-emsdk', emsdkRoot], { cwd: emsdkRoot, env });

  const parsed = {};
  const entries = windows ? result.stdout.split(/\r?\n/) : result.stdout.split('\0');
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals > 0) parsed[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return { ...env, ...parsed, EM_CONFIG: env.EM_CONFIG };
}

/**
 * Check whether emcc can run with the selected environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string|null>}
 */
async function findEmcc(env = process.env) {
  try {
    await runFile('emcc', ['--version'], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 'emcc';
  } catch {
    return null;
  }
}

/**
 * Per-platform instructions shown when emcc isn't found. Studio only ever
 * points the user at the official installer/package — it never runs an
 * install script on their behalf.
 */
function emccInstallHints() {
  return {
    macos: 'brew install emscripten',
    linux: 'git clone https://github.com/emscripten-core/emsdk.git && cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh',
    windows: 'git clone https://github.com/emscripten-core/emsdk.git && cd emsdk && emsdk install latest && emsdk activate latest && emsdk_env.bat',
    docs: 'https://emscripten.org/docs/getting_started/downloads.html',
  };
}

/**
 * Compile every detected C/C++ source file to a WASM + JS glue pair using
 * emcc, with a fixed flag set Studio controls (no user-supplied compiler
 * flags reach this call). Each `foo.cpp` becomes `foo.js` + `foo.wasm` next
 * to it, so the normal collectProjectFiles() pass below picks them up like
 * any other project file — no special-casing needed there.
 *
 * @param {string[]} cppFiles - Absolute paths, from detectCppSources()
 * @param {string} emccPath
 * @param {function} log
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{compiled: string[], errors: Array<{file:string, message:string}>}>}
 */
async function compileCppSources(cppFiles, emccPath, log, env = process.env) {
  const compiled = [];
  const errors = [];
  // Windows needs a shell to launch emcc's .bat/.cmd entry point. Arguments
  // remain separate argv entries and compiler flags are Studio-controlled.
  const needsShell = process.platform === 'win32';

  for (const srcFile of cppFiles) {
    const outJs = srcFile.replace(/\.(cpp|cc|cxx|c)$/i, '.js');
    log(`Compiling ${path.basename(srcFile)}...`);
    try {
      await runFile(emccPath, [
        srcFile,
        '-o', outJs,
        '-O2',
        '-std=c++23',
        '-s', 'WASM=1',
        '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_NAME=Module',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","HEAPF64"]',
        '-s', 'EXPORTED_FUNCTIONS=["_malloc","_free"]',
      ], { stdio: ['ignore', 'pipe', 'pipe'], shell: needsShell, env });
      compiled.push(srcFile);
    } catch (e) {
      const stderr = e.stderr ? String(e.stderr) : e.message;
      errors.push({ file: srcFile, message: stderr });
    }
  }

  return { compiled, errors };
}

// ── Package loader ─────────────────────────────────────────────────────────

function loadPackage(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid .novaapp JSON: ${error.message}`);
  }
}

// ── File collection ───────────────────────────────────────────────────────

/**
 * Walk a project directory, applying the standard skip rules (node_modules,
 * dotfiles/dotdirs, manifest.json/novaapp.json excluded), and call
 * onFile(absolutePath, relativePath) for each included file. This is the
 * single source of truth for "which files belong in a NovaByte project
 * bundle" — collectProjectFiles and the run-without-building temp copy
 * both build on this instead of each re-implementing the skip rules.
 *
 * @param {string} absDir - Absolute path to the project root to walk
 * @param {function} onFile - Called as onFile(absPath, relPath) for each included file
 */
/**
 * Load and parse .studioignore from the project root, if present.
 * Uses .gitignore syntax (globs, !negation, # comments) via the `ignore`
 * package -- deliberately not hand-rolled, since glob/negation/anchoring
 * edge cases are exactly where a homegrown matcher goes subtly wrong.
 *
 * No exemptions: same philosophy as .gitignore itself -- if you ignore
 * manifest.json or your entry file, that's on you, not something this
 * function silently protects you from. This matches walkProjectFiles'
 * existing behavior for other files, which has never special-cased
 * "important" filenames either.
 *
 * @param {string} absDir - Absolute path to the project root
 * @returns {import('ignore').Ignore} Ready-to-use matcher (empty if no
 *   .studioignore exists -- matches nothing, so callers don't need to
 *   branch on whether the file was present)
 */
function loadStudioIgnore(absDir) {
  const ig = ignore();
  const ignorePath = path.join(absDir, '.studioignore');
  if (fs.existsSync(ignorePath)) {
    try {
      ig.add(fs.readFileSync(ignorePath, 'utf8'));
    } catch {
      // Unreadable .studioignore is treated as "no ignore rules" rather
      // than failing the whole build -- same fail-open spirit as the rest
      // of walkProjectFiles' skip rules below.
    }
  }
  return ig;
}

function walkProjectFiles(absDir, onFile) {
  // .studioignore itself never needs an explicit rule to stay out of the
  // package -- walk() below already skips every dotfile unconditionally,
  // same as .git, .DS_Store, etc.
  const ig = loadStudioIgnore(absDir);
  const walk = (dir, base = '') => {
    fs.readdirSync(dir).forEach(f => {
      const full = path.join(dir, f);
      const rel  = base ? `${base}/${f}` : f;
      const isDir = fs.statSync(full).isDirectory();
      // ig.ignores() takes a path relative to the root the patterns were
      // defined against (absDir here) -- for directories, `ignore` expects
      // a trailing slash to correctly match dir-only patterns (e.g. "logs/").
      if (ig.ignores(isDir ? `${rel}/` : rel)) return;
      if (isDir) {
        if (f !== 'node_modules' && !f.startsWith('.')) walk(full, rel);
      } else if (f !== 'manifest.json' && f !== 'novaapp.json' && !f.startsWith('.')) {
        onFile(full, rel);
      }
    });
  };
  walk(absDir);
}

/**
 * Recursively collect files under a project directory into a flat
 * { relativePath: base64Content } map, using walkProjectFiles for the
 * traversal/skip rules.
 *
 * @param {string} absDir - Absolute path to the project root to walk
 * @param {function} [onSkip] - Optional callback(relPath, error) for files that fail to read
 * @returns {Object<string,string>} relative path -> base64-encoded file content
 */
function collectProjectFiles(absDir, onSkip = () => {}) {
  const files = {};
  walkProjectFiles(absDir, (full, rel) => {
    try {
      const content = fs.readFileSync(full);
      files[rel] = content.toString('base64');
    } catch (e) {
      onSkip(rel, e);
    }
  });
  return files;
}

function previewProjectFiles(projectDir) {
  const absDir = path.resolve(projectDir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`Project directory not found: ${absDir}`);
  }

  const included = [];
  const excluded = [];
  const matcher = loadStudioIgnore(absDir);
  const visit = (dir, base = '') => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      const stats = fs.statSync(full);
      const isDirectory = stats.isDirectory();

      if (matcher.ignores(isDirectory ? `${rel}/` : rel)) {
        excluded.push({ path: rel, reason: 'Excluded by .studioignore' });
        continue;
      }
      if (name === 'node_modules' || name.startsWith('.')) {
        excluded.push({ path: rel, reason: name === 'node_modules' ? 'Build excludes node_modules' : 'Build excludes dotfiles and dot-directories' });
        continue;
      }
      if (isDirectory) {
        visit(full, rel);
      } else if (name === 'manifest.json' || name === 'novaapp.json') {
        excluded.push({ path: rel, reason: 'Manifest is packaged separately' });
      } else {
        included.push(rel);
      }
    }
  };
  visit(absDir);

  const generated = detectCppSources(absDir).flatMap((source) => {
    const relative = path.relative(absDir, source).split(path.sep).join('/');
    const js = relative.replace(/\.(cpp|cc|cxx|c)$/i, '.js');
    return [`${js}`, `${js.replace(/\.js$/i, '.wasm')}`]
      .map((output) => ({ path: output, reason: `Generated from ${relative} by bundled Emscripten` }));
  });

  return {
    included: included.sort((a, b) => a.localeCompare(b)),
    excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
    generated: generated.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

// ── Build ──────────────────────────────────────────────────────────────────

/**
 * Build a .novaapp from a project directory.
 * @param {object} opts
 * @param {string}   opts.projectDir   - Absolute path to the project folder
 * @param {string}   [opts.outDir]     - Output directory (defaults to projectDir)
 * @param {function} [opts.onLog]      - Progress callback (type, message)
 * @returns {{ success: boolean, outFile?: string, error?: string }}
 */
async function build({ projectDir, outDir, onLog = () => {}, signingKey, signerName, signingMethod, integrityMethod }) {
  const log  = (msg) => onLog('info',    msg);
  const warn = (msg) => onLog('warn',    msg);
  const ok   = (msg) => onLog('success', msg);
  const err  = (msg) => onLog('error',   msg);

  try {
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir)) {
      err(`Directory not found: ${absDir}`);
      return { success: false, error: 'Directory not found' };
    }

    // Find manifest
    let manifestPath = path.join(absDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const alt = path.join(absDir, 'novaapp.json');
      if (fs.existsSync(alt)) {
        manifestPath = alt;
      } else {
        err('manifest.json not found');
        return { success: false, error: 'manifest.json not found' };
      }
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      err(`Invalid manifest: ${e.message}`);
      return { success: false, error: `Invalid manifest: ${e.message}` };
    }

    // Validate required fields
    const required = ['id', 'name', 'version', 'entry'];
    const missing  = required.filter(f => !manifest[f]);
    if (missing.length) {
      err(`manifest.json missing required fields: ${missing.join(', ')}`);
      return { success: false, error: `Missing fields: ${missing.join(', ')}` };
    }

    // Validate app ID
    if (typeof manifest.id !== 'string') {
      err('Invalid app ID — expected a string');
      return { success: false, error: 'Invalid app ID' };
    }
    if (!manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id)) {
        err(`Invalid app ID "${manifest.id}" — use reverse domain format (e.g. com.example.app)`);
        return { success: false, error: 'Invalid app ID' };
      }
    }

    // Validate both declaration lists against the shared current catalog.
    // Keep documented vfs aliases intact so older projects retain their
    // compatibility behavior; unknown strings are warned about and removed.
    for (const field of ['permissions', 'optionalPermissions']) {
      if (manifest[field] === undefined) continue;
      if (!Array.isArray(manifest[field])) {
        err(`manifest.json ${field} must be an array`);
        return { success: false, error: `${field} must be an array` };
      }
      const invalid = manifest[field].filter((permission) =>
        typeof permission !== 'string' ||
        (!PERMISSION_IDS.has(permission) && !LEGACY_PERMISSION_ALIASES[permission])
      );
      if (invalid.length) {
        warn(`Unknown ${field} will be stripped: ${invalid.join(', ')}`);
        manifest[field] = manifest[field].filter((permission) =>
          typeof permission === 'string' &&
          (PERMISSION_IDS.has(permission) || LEGACY_PERMISSION_ALIASES[permission])
        );
      }
      const legacy = manifest[field].filter((permission) => LEGACY_PERMISSION_ALIASES[permission]);
      if (legacy.length) {
        warn(`Legacy permissions retained for compatibility: ${legacy.join(', ')}`);
      }
    }

    if (manifest.permissionReasons !== undefined) {
      const reasons = manifest.permissionReasons;
      if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
        err('manifest.json permissionReasons must be an object');
        return { success: false, error: 'permissionReasons must be an object' };
      }
      const declaredPermissions = new Set([
        ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
        ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
      ]);
      for (const [permission, reason] of Object.entries(reasons)) {
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
          err(`manifest.json permissionReasons.${permission} must be a non-empty string of at most 500 characters`);
          return { success: false, error: `Invalid reason for ${permission}` };
        }
        if (!PERMISSION_IDS.has(permission) && !LEGACY_PERMISSION_ALIASES[permission]) {
          warn(`Unknown permissionReasons key: ${permission}`);
        }
        if (!declaredPermissions.has(permission)) {
          warn(`permissionReasons.${permission} is unused because the permission is not declared`);
        }
      }
    }

    // Check entry file exists
    const entryPath = path.join(absDir, manifest.entry);
    if (!fs.existsSync(entryPath)) {
      err(`Entry file not found: ${manifest.entry}`);
      return { success: false, error: `Entry file not found: ${manifest.entry}` };
    }

    log(`Building ${manifest.name} v${manifest.version}...`);

    // ── C++ detection & compilation ────────────────────────────────────
    // Runs before bundling: if there are .cpp/.cc/.cxx/.c files anywhere
    // in the project, they need to become .wasm + .js glue on disk BEFORE
    // collectProjectFiles walks the directory, so the compiled output gets
    // swept into the package the same way any other file would.
    const cppFiles = detectCppSources(absDir);
    if (cppFiles.length > 0) {
      log(`Found ${cppFiles.length} C/C++ source file(s)`);
      const emsdkRoot = findBundledEmsdk();
      let emccEnv = process.env;
      if (emsdkRoot) {
        log('Preparing bundled Emscripten SDK...');
        try {
          emccEnv = await loadEmsdkEnvironment(emsdkRoot);
        } catch (error) {
          err(`Could not activate bundled Emscripten SDK: ${error.message}`);
          return { success: false, error: 'emscripten_sdk_activation_failed' };
        }
      }
      const emccPath = await findEmcc(emccEnv);
      if (!emccPath) {
        const hints = emccInstallHints();
        err(`emcc not found${emsdkRoot ? ' in the bundled SDK' : ' on PATH'} — Emscripten is required to compile this project's C++ sources.`);
        err(`Install it, then re-run build. See ${hints.docs}`);
        return {
          success: false,
          error: 'emscripten_not_found',
          installHints: hints,
        };
      }
      const { compiled, errors } = await compileCppSources(cppFiles, emccPath, log, emccEnv);
      if (errors.length > 0) {
        for (const { file, message } of errors) {
          err(`Failed to compile ${path.basename(file)}:`);
          err(message);
        }
        return {
          success: false,
          error: 'cpp_compile_failed',
          compileErrors: errors,
        };
      }
      ok(`Compiled ${compiled.length} C/C++ source file(s) to WebAssembly`);
    }

    // Bundle files
    const files = collectProjectFiles(absDir, (rel, e) => warn(`Skipping ${rel}: ${e.message}`));

    log(`Bundled ${Object.keys(files).length} file(s)`);

    // Create package object
    const pkg = {
      novabyte_app: AppPackage.NOVAAPP_FORMAT_VERSION || '1.0',
      manifest: { ...manifest, packagedAt: new Date().toISOString() },
      files,
      signature: null,
      signer: null,
      compiled_at: new Date().toISOString(),
    };

    // ── Signing ──────────────────────────────────────────────────────────
    // Real signing uses the selected algorithm (default Ed25519) via
    // AppPackage.signPackage(). See app-package.js for the full list of
    // supported methods and their WebCrypto mappings.
    if (signingKey) {
      const method = signingMethod || AppPackage.DEFAULT_SIGNING_METHOD || 'ed25519';
      pkg.signing = { method };
      pkg.signature = await AppPackage.signPackage(pkg, signingKey, { method });
      pkg.signer = signerName || 'self-signed';
      log(`Signed with ${method} (signer: ${pkg.signer})`);
    } else {
      warn('Package is unsigned. It will show as "Unverified" in NBOSP unless signed.');
    }

    // ── Integrity ────────────────────────────────────────────────────────
    // Embed integrity hashes by default (BLAKE3) so tamper detection
    // works even for packages that are not cryptographically signed.
    const finalIntegrityMethod = integrityMethod !== 'none'
      ? (integrityMethod || AppPackage.DEFAULT_INTEGRITY_METHOD || 'blake3')
      : 'none';
    if (finalIntegrityMethod !== 'none') {
      pkg.integrity = await AppPackage.computeIntegrity(pkg, finalIntegrityMethod);
      log(`Integrity: ${finalIntegrityMethod}`);
    }

    // Determine output path
    const resolvedOut = outDir || absDir;
    if (!fs.existsSync(resolvedOut)) fs.mkdirSync(resolvedOut, { recursive: true });
    const outFile = path.join(resolvedOut, `${manifest.id}.novaapp`);

    // Write
    let output;
    output = JSON.stringify(pkg, null, 2);
    fs.writeFileSync(outFile, output);

    const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(2);
    ok(`Package created: ${path.basename(outFile)}`);
    log(`Size: ${sizeKB} KB`);
    log(pkg.signature ? `Signature: ${pkg.signature.substring(0, 16)}...` : 'Signature: none (unsigned)');

    return { success: true, outFile };

  } catch (e) {
    err(`Build failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ── Inspect ────────────────────────────────────────────────────────────────

function inspect(pkgPath) {
  const pkg = loadPackage(pkgPath);
  return {
    format:       pkg.novabyte_app,
    manifest:     pkg.manifest,
    files:        Object.keys(pkg.files),
    fileCount:    Object.keys(pkg.files).length,
    hasSignature: !!pkg.signature,
    signature:    pkg.signature,
    compiledAt:   pkg.compiled_at,
    size:         fs.statSync(pkgPath).size,
  };
}

// ── Verify ─────────────────────────────────────────────────────────────────

/**
 * Verify a package's signature against a trust store (array of
 * {name, publicKey}). This replaces the previous implementation, which
 * recomputed sha256(payload) and checked it against pkg.signature — since
 * an attacker controls the payload they're hashing, that check could
 * always be satisfied by whoever created the package, signed or not. It
 * distinguished "not corrupted since I ran this same hash function" from
 * nothing else.
 *
 * @param {string} pkgPath
 * @param {Array<{name:string, publicKey:any}>} [trustStore] - defaults to empty (no one trusted)
 */
async function verify(pkgPath, trustStore = []) {
  const pkg = loadPackage(pkgPath);
  if (!pkg.signature) return { valid: false, reason: 'Package is unsigned', manifest: pkg.manifest };

  const result = await AppPackage.verifyAgainstTrustStore(pkg, trustStore);

  return {
    valid: result.trusted,
    signer: result.signer,
    reason: result.trusted
      ? `Signature valid — signed by ${result.signer}`
      : 'Signature does not match any trusted signer (may be self-signed, tampered, or from an unrecognized source)',
    manifest: pkg.manifest,
  };
}

// ── List actions ───────────────────────────────────────────────────────────

function listActions(pkgPath) {
  const pkg     = loadPackage(pkgPath);
  const actions = new Set();
  const re      = /nova:[a-zA-Z0-9:_-]+/g;

  for (const [, encoded] of Object.entries(pkg.files)) {
    try {
      const content = Buffer.from(encoded, 'base64').toString('utf8');
      const matches = content.match(re);
      if (matches) matches.forEach(m => actions.add(m));
    } catch { /* binary file */ }
  }

  return [...actions].sort();
}

module.exports = { build, inspect, verify, listActions, loadPackage, collectProjectFiles, walkProjectFiles, previewProjectFiles, detectCppSources, findEmcc, emccInstallHints };