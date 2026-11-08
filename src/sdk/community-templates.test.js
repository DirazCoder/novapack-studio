'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  TEMPLATE_FORMAT,
  TEMPLATE_FORMAT_VERSION,
  _canonicalCommunityTemplateJson,
  _verifyCommunityTemplateBundle,
  normalizeCommunityTemplateRow,
  validateCommunityTemplateBundle,
  validateTemplateContent,
  validateTemplateFilePath,
} = require('./community-templates.js');

function signedBundle(template) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyText = publicKeyBytes.toString('base64url');
  const payload = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_FORMAT_VERSION,
    template,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(_canonicalCommunityTemplateJson(payload)),
    privateKey,
  ).toString('base64url');
  return {
    ...payload,
    signature: { algorithm: 'Ed25519', publicKey: publicKeyText, signature },
  };
}

function validTemplate(overrides = {}) {
  return {
    name: 'Community Starter',
    description: 'A starter project.',
    author: 'NovaByte Community',
    releaseVersion: '1.0.0',
    category: 'web',
    icon: 'box',
    manifest: { permissions: [] },
    files: { 'index.html': Buffer.from('<h1>Welcome</h1>').toString('base64') },
    ...overrides,
  };
}

test('community template signatures cover the exact canonical template data', () => {
  const bundle = signedBundle(validTemplate());
  assert.equal(
    _verifyCommunityTemplateBundle(bundle, bundle.signature.publicKey).template.name,
    'Community Starter',
  );
  assert.throws(() => _verifyCommunityTemplateBundle({
    ...bundle,
    template: { ...bundle.template, description: 'Changed after signing.' },
  }, bundle.signature.publicKey), /failed NovaByte signature verification/);
  assert.throws(() => _verifyCommunityTemplateBundle({
    ...bundle,
    signature: { ...bundle.signature, publicKey: 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY' },
  }), /failed NovaByte signature verification/);
});

test('community template validation rejects unsafe or oversized project files', () => {
  for (const filename of [
    '../escape.js',
    '/absolute.js',
    'C:/absolute.js',
    'folder\\escape.js',
    '.hidden',
    'folder/.hidden',
    'node_modules/pkg/index.js',
    '__proto__/pollute.js',
    'manifest.json',
  ]) {
    assert.throws(() => validateTemplateFilePath(filename), /Unsafe starter filename/);
  }
  assert.equal(validateTemplateFilePath('src/index.js'), 'src/index.js');
  assert.throws(() => validateTemplateContent(validTemplate({
    files: { 'index.html': Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
  })), /2 MB import limit/);
  assert.throws(() => validateTemplateContent(validTemplate({ releaseVersion: 'not-semver' })), /valid SemVer/);
});

test('community catalog metadata must match the signed template', () => {
  const bundle = signedBundle(validTemplate());
  const listing = {
    name: 'Community Starter',
    author: 'NovaByte Community',
    description: 'A starter project.',
    version: '1.0.0',
    category: 'web',
  };
  assert.doesNotThrow(() => validateCommunityTemplateBundle(bundle, listing, bundle.signature.publicKey));
  assert.throws(() => validateCommunityTemplateBundle(bundle, {
    ...listing,
    name: 'Different template',
  }, bundle.signature.publicKey), /does not match the community catalog listing/);
});

test('community catalog rows require bounded metadata and the trusted package bucket', () => {
  const row = normalizeCommunityTemplateRow({
    template_id: 'com.example.starter',
    name: 'Starter',
    version: '1.0.0',
    author: 'Example',
    description: 'A community starter.',
    category: 'web',
    file: 'https://jcrptxtmieveoijdbtqa.supabase.co/storage/v1/object/public/published-packages/com.example.starter/1.0.0.nbtemplate',
    size: '1200',
    published_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(row.id, 'com.example.starter');
  assert.equal(row.size, 1200);
  assert.throws(() => normalizeCommunityTemplateRow({
    template_id: 'invalid id',
  }), /invalid entry/);
  assert.throws(() => normalizeCommunityTemplateRow({
    template_id: 'com.example.starter',
    name: 'Starter',
    version: '1.0.0',
    author: 'Example',
    description: 'A community starter.',
    category: 'web',
    file: 'https://example.com/starter.nbtemplate',
    size: 1200,
  }), /untrusted download URL/);
});
