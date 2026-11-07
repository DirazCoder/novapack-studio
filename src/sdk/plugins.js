'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const semver = require('semver');
const yauzl = require('yauzl-promise');

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_MANIFEST_BYTES = 256 * 1024;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const NOVABYTE_TRUSTED_SIGNING_PUBLIC_KEY = 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY';

function _validatePluginRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')
    || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
    || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Invalid plugin path: ${relativePath}`);
  }
  const segments = relativePath.replace(/\/$/, '').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':')
    || ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()))) {
    throw new Error(`Invalid plugin path: ${relativePath}`);
  }
  return segments.join(path.sep);
}

function resolveProjectPath(projectDirectory, relativePath) {
  const projectPath = path.resolve(projectDirectory);
  const projectRealPath = fs.realpathSync(projectPath);
  const targetPath = path.resolve(projectPath, relativePath);
  const relativeTarget = path.relative(projectPath, targetPath);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    throw new Error('Project path is outside the open project');
  }

  let existingPath = targetPath;
  while (true) {
    try {
      fs.lstatSync(existingPath);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) throw error;
      existingPath = parentPath;
    }
  }

  const existingRealPath = fs.realpathSync(existingPath);
  const relativeExisting = path.relative(projectRealPath, existingRealPath);
  if (relativeExisting === '..' || relativeExisting.startsWith(`..${path.sep}`) || path.isAbsolute(relativeExisting)) {
    throw new Error('Project path resolves outside the open project');
  }

  const safeTargetPath = path.resolve(existingRealPath, path.relative(existingPath, targetPath));
  const relativeSafeTarget = path.relative(projectRealPath, safeTargetPath);
  if (relativeSafeTarget === '..' || relativeSafeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSafeTarget)) {
    throw new Error('Project path resolves outside the open project');
  }
  return safeTargetPath;
}

function listProjectFiles(projectDirectory) {
  const root = resolveProjectPath(projectDirectory, '.');
  const pending = [root];
  const files = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.isFile()) {
        files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isPluginDomNode(value) {
  return value !== null
    && typeof value === 'object'
    && [1, 3, 8, 11].includes(value.nodeType)
    && typeof value.nodeName === 'string'
    && typeof value.cloneNode === 'function';
}

function _validatePluginManifest(manifest, files, studioVersion) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('plugin.json must contain a JSON object');
  }
  const { id, name, version, main, engines } = manifest;
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error('Plugin ID must be a lowercase stable ID (3-128 characters)');
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new Error('Plugin name must contain 1-100 characters');
  }
  if (!semver.valid(version)) throw new Error('Plugin version must be valid SemVer');
  if (typeof main !== 'string') throw new Error('Plugin manifest is missing its main entry point');
  const mainPath = _validatePluginRelativePath(main);
  if (!files.has(mainPath)) throw new Error(`Plugin entry point does not exist: ${main}`);
  if (!engines || typeof engines.studio !== 'string' || !semver.validRange(engines.studio)) {
    throw new Error('Plugin must declare a valid engines.studio SemVer range');
  }
  if (!semver.satisfies(studioVersion, engines.studio)) {
    throw new Error(`Plugin requires Studio ${engines.studio}; this version is ${studioVersion}`);
  }
  if (manifest.description != null
    && (typeof manifest.description !== 'string' || manifest.description.length > 500)) {
    throw new Error('Plugin description must be 500 characters or fewer');
  }
  return manifest;
}

function _canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(_canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _pluginFileDigests(directory) {
  const files = Object.create(null);
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Plugin contains a symbolic link: ${relative}`);
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target, relative);
      else if (entry.isFile()) {
        if (relative !== 'signature.json') {
          files[relative] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        }
      } else {
        throw new Error(`Plugin contains an unsupported file type: ${relative}`);
      }
    }
  };
  visit(directory);
  return files;
}

function verifyPluginSignature(directory, trustedPublicKey = NOVABYTE_TRUSTED_SIGNING_PUBLIC_KEY) {
  const signaturePath = path.join(directory, 'signature.json');
  if (!fs.existsSync(signaturePath)) return { status: 'unsigned' };
  try {
    const signature = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
    if (signature.algorithm !== 'Ed25519'
      || signature.publicKey !== trustedPublicKey
      || typeof signature.signature !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(signature.signature)) {
      return { status: 'invalid' };
    }
    const hashes = _pluginFileDigests(directory);
    const data = Buffer.from(_canonicalJson({ files: hashes }), 'utf8');
    const rawKey = Buffer.from(signature.publicKey, 'base64url');
    if (rawKey.length !== 32) return { status: 'invalid' };
    const key = crypto.createPublicKey({
      key: Buffer.concat([PUBLIC_KEY_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    const valid = crypto.verify(null, data, key, Buffer.from(signature.signature, 'base64url'));
    return { status: valid ? 'verified' : 'invalid' };
  } catch (error) {
    return { status: 'invalid', error };
  }
}

function _readManifest(directory) {
  const manifestPath = path.join(directory, 'plugin.json');
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('plugin.json is not a regular file or is too large');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = new Set();
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Plugin contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(path.join(current, entry.name), relative);
      else if (entry.isFile()) files.add(_validatePluginRelativePath(relative));
      else throw new Error(`Plugin contains an unsupported file type: ${relative}`);
    }
  };
  visit(directory);
  _validatePluginManifest(manifest, files, require('../../package.json').version);
  return manifest;
}

async function _extractArchive(archivePath, stagingPath) {
  const stat = await fs.promises.stat(archivePath);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error('Plugin archive must be a file smaller than 100 MB');
  }
  const zip = await yauzl.open(archivePath, { strictFilenames: true });
  const names = new Set();
  let totalSize = 0;
  let entryCount = 0;
  try {
    for await (const entry of zip) {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Plugin archive contains too many entries');
      if (entry.isEncrypted()) throw new Error('Encrypted plugin archives are not supported');
      const isDirectory = entry.filename.endsWith('/');
      const normalized = isDirectory ? entry.filename.slice(0, -1) : entry.filename;
      const relativePath = _validatePluginRelativePath(normalized);
      if (names.has(relativePath)) throw new Error(`Plugin archive contains duplicate paths: ${entry.filename}`);
      names.add(relativePath);
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (fileType === 0xa000) throw new Error(`Plugin archive contains a symbolic link: ${entry.filename}`);
      const destination = path.join(stagingPath, relativePath);
      if (!destination.startsWith(`${stagingPath}${path.sep}`)) {
        throw new Error(`Plugin archive path escapes its install directory: ${entry.filename}`);
      }
      if (isDirectory) {
        await fs.promises.mkdir(destination, { recursive: true });
        continue;
      }
      totalSize += entry.uncompressedSize;
      if (totalSize > MAX_ARCHIVE_BYTES) throw new Error('Plugin expands beyond the 100 MB limit');
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const input = await entry.openReadStream();
      const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      await pipeline(input, output);
    }
  } finally {
    await zip.close();
  }
}

function createPluginManager({ rootDirectory, studioVersion }) {
  const pluginsDirectory = path.join(rootDirectory, 'plugins');
  const registryPath = path.join(rootDirectory, 'plugins.json');

  function _ensurePaths() {
    fs.mkdirSync(pluginsDirectory, { recursive: true });
  }

  function _readRegistry() {
    if (!fs.existsSync(registryPath)) return {};
    let value;
    try {
      value = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read plugin settings: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Plugin settings file must contain an object');
    }
    return value;
  }

  function _writeRegistry(registry) {
    fs.mkdirSync(rootDirectory, { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  }

  function _inspect(directory, record = {}) {
    const manifest = _readManifest(directory);
    const signature = verifyPluginSignature(directory);
    return {
      ...manifest,
      path: directory,
      enabled: record.enabled === true,
      trusted: record.trusted === true,
      signature: signature.status,
      error: signature.status === 'invalid'
        ? 'The package signature is invalid or does not match the trusted marketplace key'
        : undefined,
    };
  }

  function list() {
    _ensurePaths();
    const registry = _readRegistry();
    const plugins = [];
    for (const entry of fs.readdirSync(pluginsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = path.join(pluginsDirectory, entry.name);
      try {
        plugins.push(_inspect(directory, registry[entry.name] || {}));
      } catch (error) {
        plugins.push({
          id: entry.name,
          name: entry.name,
          path: directory,
          enabled: false,
          trusted: false,
          signature: 'invalid',
          error: error.message,
        });
      }
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function _install(prepare) {
    _ensurePaths();
    const stagingPath = path.join(pluginsDirectory, `.install-${crypto.randomUUID()}`);
    await fs.promises.mkdir(stagingPath, { recursive: false });
    try {
      await prepare(stagingPath);
      const manifest = _readManifest(stagingPath);
      const signature = verifyPluginSignature(stagingPath);
      if (signature.status === 'invalid') {
        throw new Error('Plugin signature is invalid or was modified after signing');
      }
      const destination = path.join(pluginsDirectory, manifest.id);
      const previous = `${destination}.backup-${crypto.randomUUID()}`;
      const exists = fs.existsSync(destination);
      if (exists) await fs.promises.rename(destination, previous);
      try {
        await fs.promises.rename(stagingPath, destination);
      } catch (error) {
        if (exists) await fs.promises.rename(previous, destination);
        throw error;
      }
      if (exists) await fs.promises.rm(previous, { recursive: true, force: true });
      const registry = _readRegistry();
      registry[manifest.id] = { enabled: false, trusted: false };
      _writeRegistry(registry);
      return _inspect(destination, registry[manifest.id]);
    } catch (error) {
      await fs.promises.rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  async function installArchive(archivePath) {
    return _install((stagingPath) => _extractArchive(archivePath, stagingPath));
  }

  async function installFolder(sourceDirectory) {
    return _install(async (stagingPath) => {
      const sourceStat = await fs.promises.stat(sourceDirectory);
      if (!sourceStat.isDirectory()) throw new Error('Selected plugin path is not a folder');
      let totalSize = 0;
      let entryCount = 0;
      const copy = async (source, destination) => {
        for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
          entryCount += 1;
          if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Plugin folder contains too many entries');
          _validatePluginRelativePath(path.relative(stagingPath, path.join(destination, entry.name)).split(path.sep).join('/'));
          const sourcePath = path.join(source, entry.name);
          const destinationPath = path.join(destination, entry.name);
          if (entry.isSymbolicLink()) throw new Error(`Plugin folder contains a symbolic link: ${entry.name}`);
          if (entry.isDirectory()) {
            await fs.promises.mkdir(destinationPath, { recursive: true });
            await copy(sourcePath, destinationPath);
          } else if (entry.isFile()) {
            const stat = await fs.promises.stat(sourcePath);
            totalSize += stat.size;
            if (totalSize > MAX_ARCHIVE_BYTES) throw new Error('Plugin folder expands beyond the 100 MB limit');
            await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
          } else {
            throw new Error(`Plugin folder contains an unsupported file: ${entry.name}`);
          }
        }
      };
      await copy(sourceDirectory, stagingPath);
    });
  }

  function setEnabled(id, { enabled, trusted }) {
    const plugin = list().find((item) => item.id === id);
    if (!plugin || plugin.error) throw new Error('Plugin is missing or invalid');
    const registry = _readRegistry();
    registry[id] = {
      enabled: enabled === true,
      trusted: trusted === true || registry[id]?.trusted === true,
    };
    _writeRegistry(registry);
    return _inspect(plugin.path, registry[id]);
  }

  async function uninstall(id) {
    if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) throw new Error('Invalid plugin ID');
    const directory = path.join(pluginsDirectory, id);
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(pluginsDirectory)) throw new Error('Plugin path is outside the install directory');
    await fs.promises.rm(directory, { recursive: true, force: false });
    const registry = _readRegistry();
    delete registry[id];
    _writeRegistry(registry);
  }

  return { list, installArchive, installFolder, setEnabled, uninstall, pluginsDirectory };
}

async function activatePlugins(manager, createApi) {
  const active = [];
  const errors = [];
  for (const plugin of manager.list()) {
    if (!plugin.enabled || !plugin.trusted || plugin.error) continue;
    try {
      const entryPath = path.resolve(plugin.path, _validatePluginRelativePath(plugin.main));
      const modulePath = require.resolve(entryPath);
      delete require.cache[modulePath];
      const implementation = require(modulePath);
      if (!implementation || typeof implementation.activate !== 'function') {
        throw new Error('Plugin entry point must export activate(api)');
      }
      const api = createApi(plugin);
      await implementation.activate(api);
      active.push({ id: plugin.id, implementation, api });
    } catch (error) {
      errors.push({ id: plugin.id, error });
      console.error(`[plugins] Could not activate ${plugin.id}:`, error);
    }
  }
  return { active, errors };
}

async function deactivatePlugins(activePlugins) {
  const errors = [];
  for (const plugin of [...activePlugins].reverse()) {
    try {
      if (typeof plugin.implementation.deactivate === 'function') {
        await plugin.implementation.deactivate(plugin.api);
      }
    } catch (error) {
      errors.push({ id: plugin.id, error });
      console.error(`[plugins] Could not deactivate ${plugin.id}:`, error);
    }
  }
  return errors;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  NOVABYTE_TRUSTED_SIGNING_PUBLIC_KEY,
  _canonicalJson,
  isPluginDomNode,
  listProjectFiles,
  resolveProjectPath,
  _validatePluginManifest,
  _validatePluginRelativePath,
  activatePlugins,
  createPluginManager,
  deactivatePlugins,
  verifyPluginSignature,
};
