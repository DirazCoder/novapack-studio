'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  _canonicalJson,
  isPluginDomNode,
  listProjectFiles,
  NOVABYTE_TRUSTED_SIGNING_PUBLIC_KEY,
  resolveProjectPath,
  _validatePluginManifest,
  _validatePluginRelativePath,
  activatePlugins,
  createPluginManager,
  deactivatePlugins,
  verifyPluginSignature,
} = require('./plugins.js');

const studioVersion = require('../../package.json').version;

test('plugin trust anchor matches NovaByte Trusted Signing', () => {
  assert.equal(NOVABYTE_TRUSTED_SIGNING_PUBLIC_KEY, 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY');
});

test('plugin archive paths reject traversal, absolute, and Windows stream paths', () => {
  for (const invalid of ['../outside.js', '/outside.js', 'C:\\outside.js', 'folder/file:stream', '__proto__']) {
    assert.throws(() => _validatePluginRelativePath(invalid), /Invalid plugin path/);
  }
  assert.equal(_validatePluginRelativePath('lib/index.js'), path.join('lib', 'index.js'));
});

test('panel content validation accepts cross-realm DOM node shapes', () => {
  const foreignRealmElement = Object.create(null);
  foreignRealmElement.nodeType = 1;
  foreignRealmElement.nodeName = 'DIV';
  foreignRealmElement.cloneNode = () => ({});
  assert.equal(isPluginDomNode(foreignRealmElement), true);
  assert.equal(isPluginDomNode({ nodeType: 9, nodeName: '#document', cloneNode() {} }), false);
  assert.equal(isPluginDomNode({ nodeType: 1, nodeName: 'DIV' }), false);
  assert.equal(isPluginDomNode(null), false);
});

test('project file paths reject traversal and symlink escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-project-path-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(project, 'nested'));
  fs.writeFileSync(path.join(project, '.hidden'), 'hidden');
  fs.writeFileSync(path.join(project, 'nested', 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => resolveProjectPath(project, '..\\outside\\secret.txt'), /outside the open project/);
  assert.equal(resolveProjectPath(project, '..folder\\file.txt'), path.join(project, '..folder', 'file.txt'));
  assert.equal(resolveProjectPath(project, 'new\\nested\\file.txt'), path.join(project, 'new', 'nested', 'file.txt'));

  const externalLink = path.join(project, 'external');
  try {
    fs.symlinkSync(outside, externalLink, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Directory junctions are unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.throws(() => resolveProjectPath(project, path.join('external', 'secret.txt')), /resolves outside the open project/);
  assert.throws(() => resolveProjectPath(project, path.join('external', 'new.txt')), /resolves outside the open project/);
  assert.deepEqual(listProjectFiles(project), ['.hidden', 'nested/inside.txt']);
});

test('plugin manifest requires a valid entry point and compatible Studio range', () => {
  const manifest = {
    id: 'example.plugin',
    name: 'Example',
    version: '1.0.0',
    main: 'index.js',
    engines: { studio: '>=1.0.0 <2.0.0' },
  };
  assert.equal(_validatePluginManifest(manifest, new Set(['index.js']), studioVersion), manifest);
  assert.throws(() => _validatePluginManifest(manifest, new Set(), studioVersion), /entry point does not exist/);
  assert.throws(() => _validatePluginManifest({
    ...manifest,
    engines: { studio: '>=9.0.0' },
  }, new Set(['index.js']), studioVersion), /requires Studio/);
});

test('plugin signatures verify the canonical file digest map and detect tampering', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-signature-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.stringify({ id: 'example.plugin', version: '1.0.0' });
  const main = 'module.exports = {};';
  fs.writeFileSync(path.join(directory, 'plugin.json'), manifest);
  fs.writeFileSync(path.join(directory, 'index.js'), main);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const hashes = {
    'index.js': crypto.createHash('sha256').update(main).digest('hex'),
    'plugin.json': crypto.createHash('sha256').update(manifest).digest('hex'),
  };
  const signature = crypto.sign(null, Buffer.from(_canonicalJson({ files: hashes })), privateKey).toString('base64url');
  fs.writeFileSync(path.join(directory, 'signature.json'), JSON.stringify({
    algorithm: 'Ed25519',
    publicKey: rawPublicKey,
    signature,
  }));
  assert.equal(verifyPluginSignature(directory, rawPublicKey).status, 'verified');
  fs.appendFileSync(path.join(directory, 'index.js'), '\n// modified');
  assert.equal(verifyPluginSignature(directory, rawPublicKey).status, 'invalid');
});

test('local plugin installation requires trust before activation and supports uninstall', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-manager-'));
  const source = path.join(root, 'source');
  const pluginRoot = path.join(root, 'app-data');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({
    id: 'example.plugin',
    name: 'Example Plugin',
    version: '1.0.0',
    main: 'index.js',
    engines: { studio: '>=1.0.0 <2.0.0' },
  }));
  fs.writeFileSync(path.join(source, 'index.js'), [
    'module.exports = {',
    '  activate(api) { api.started = true; },',
    '  deactivate(api) { api.stopped = true; },',
    '};',
  ].join('\n'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = createPluginManager({ rootDirectory: pluginRoot, studioVersion });
  const installed = await manager.installFolder(source);
  assert.equal(installed.enabled, false);
  assert.equal(installed.trusted, false);
  assert.equal(manager.list()[0].signature, 'unsigned');
  assert.deepEqual((await activatePlugins(manager, () => ({}))).active, []);

  manager.setEnabled(installed.id, { enabled: true, trusted: true });
  const result = await activatePlugins(manager, () => ({}));
  assert.equal(result.active.length, 1);
  const api = result.active[0].api;
  assert.equal(api.started, true);
  assert.deepEqual(await deactivatePlugins(result.active), []);
  assert.equal(api.stopped, true);

  await manager.uninstall(installed.id);
  assert.equal(manager.list().length, 0);
});
