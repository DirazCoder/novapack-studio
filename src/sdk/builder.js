// [NOVAPACK_BUILDER_JS] -- from NovaPack Studio, not NBOSP
'use strict';

/**
 * NovaByte Studio — Builder
 * Packages an app directory into a .novaapp file.
 * Ported from novaapp-cli.js, runs as a Node.js module inside NW.js.
 */

const fs    = require('fs');
const path  = require('path');
const { execFileSync } = require('child_process');
const ignore = require('ignore');

const AppPackage = (typeof window !== 'undefined' && window.__NB_SDK && window.__NB_SDK['AppPackage'])
  || require('./app-package.js');

// ── C++ / WebAssembly compilation ───────────────────────────────────────────
//
// Studio does not bundle or install a compiler. It only looks for `emcc`
// (the Emscripten compiler driver) already on the user's PATH, and compiles
// with it if found. If it's not found, build() fails with install
// instructions instead of silently skipping the C++ files or trying to
// fetch/install a toolchain itself — a build that "succeeds" while quietly
// leaving out the app's actual logic would be worse than a clear failure.
//
// Every call below goes through execFileSync with an argv array, never a
// shell string — emcc's arguments are entirely Studio-controlled constants
// (file paths discovered on disk, not user-supplied flags), so there's no
// string-concatenation-into-a-shell-command surface here.

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

/**
 * Locate emcc directly by attempting to run it, rather than shelling out to
 * `where`/`which` first. This replaces an earlier version that used
 * `where`/`which` to search for a specific filename (emcc.bat on Windows,
 * emcc elsewhere) -- that approach broke in practice for two independent
 * reasons discovered against a real Windows install:
 *   1. Emscripten's Windows build doesn't always ship emcc.bat -- some
 *      versions (confirmed: 6.0.6) ship emcc.exe directly instead, so
 *      searching only for the .bat name found nothing even with a fully
 *      correct PATH.
 *   2. `where.exe`'s own lookup proved unreliable in the same session where
 *      directly invoking the .exe by its full path worked fine -- so even
 *      fixing the filename wouldn't have been a complete fix.
 * Directly attempting `emcc --version` sidesteps both: Node's own
 * execFileSync PATH resolution is what actually matters at runtime (it's
 * the same resolution compileCppSources() below relies on to invoke emcc),
 * so testing via that exact mechanism can't disagree with itself the way
 * asking a separate lookup tool did.
 *
 * @returns {string|null} 'emcc' if callable via PATH resolution, or null
 */
function findEmcc() {
  try {
    // shell:true on Windows for the same reason compileCppSources() needs
    // it -- Windows can't exec .bat/.cmd files (and, per the discovery
    // above, apparently not all .exe launcher stubs either, in a shell
    // without cmd's own PATHEXT/lookup behavior) via execFile's normal
    // non-shell path. The command run is a fixed literal ('emcc', with a
    // fixed argument) -- nothing from user input reaches this call, so
    // shell:true doesn't reopen an injection surface here.
    execFileSync('emcc', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return 'emcc';
  } catch {
    return null; // emcc isn't runnable via PATH resolution
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
 * @returns {{compiled: string[], errors: Array<{file:string, message:string}>}}
 */
function compileCppSources(cppFiles, emccPath, log) {
  const compiled = [];
  const errors = [];
  // execFileSync cannot launch a .bat/.cmd file directly on Windows --
  // Node's own docs are explicit about this: those files require shell:true
  // (or exec/spawn's shell option) rather than execFile's normal exec-family
  // syscall path. emcc on Windows IS emcc.bat (see findEmcc's binName), so
  // without this the compile call fails with an unhelpful ENOENT/EINVAL even
  // though findEmcc() already proved emcc.bat exists and is on PATH.
  // shell:true here does NOT reopen the injection surface we avoided
  // elsewhere (see the CVE-2026-47668 discussion) -- every argument below is
  // still passed as a separate array element, never concatenated into a
  // single command string; only srcFile/outJs come from disk (real file
  // paths found by our own directory walk), and everything else is a fixed
  // literal. shell:true only changes *how* Windows launches a .bat file, not
  // whether arguments get shell-interpreted as one blob.
  const needsShell = process.platform === 'win32';

  for (const srcFile of cppFiles) {
    const outJs = srcFile.replace(/\.(cpp|cc|cxx|c)$/i, '.js');
    log(`Compiling ${path.basename(srcFile)}...`);
    try {
      execFileSync(emccPath, [
        srcFile,
        '-o', outJs,
        '-O2',
        '-std=c++23',
        '-s', 'WASM=1',
        '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_NAME=Module',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","HEAPF64"]',
        '-s', 'EXPORTED_FUNCTIONS=["_malloc","_free"]',
      ], { stdio: ['ignore', 'pipe', 'pipe'], shell: needsShell });
      compiled.push(srcFile);
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString('utf8') : e.message;
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
    if (!manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id)) {
        err(`Invalid app ID "${manifest.id}" — use reverse domain format (e.g. com.example.app)`);
        return { success: false, error: 'Invalid app ID' };
      }
    }

    // Validate permissions against known list
    if (manifest.permissions) {
      const validPerms = Object.values(AppPackage.PERMISSION_TYPES || {});
      if (validPerms.length > 0) {
        const invalid = manifest.permissions.filter(p => !validPerms.includes(p));
        if (invalid.length) {
          warn(`Unknown permissions will be stripped: ${invalid.join(', ')}`);
          manifest.permissions = manifest.permissions.filter(p => validPerms.includes(p));
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
      const emccPath = findEmcc();
      if (!emccPath) {
        const hints = emccInstallHints();
        err('emcc not found on PATH — Emscripten is required to compile this project\'s C++ sources.');
        err(`Install it, then re-run build. See ${hints.docs}`);
        return {
          success: false,
          error: 'emscripten_not_found',
          installHints: hints,
        };
      }
      const { compiled, errors } = compileCppSources(cppFiles, emccPath, log);
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
  const re      = /nova:[a-z:]+/g;

  for (const [, encoded] of Object.entries(pkg.files)) {
    try {
      const content = Buffer.from(encoded, 'base64').toString('utf8');
      const matches = content.match(re);
      if (matches) matches.forEach(m => actions.add(m));
    } catch { /* binary file */ }
  }

  return [...actions].sort();
}

module.exports = { build, inspect, verify, listActions, loadPackage, collectProjectFiles, walkProjectFiles, detectCppSources, findEmcc, emccInstallHints };