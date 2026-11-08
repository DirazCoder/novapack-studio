'use strict';

const crypto = require('crypto');
const semver = require('semver');

const TEMPLATE_MARKETPLACE_URL = 'https://jcrptxtmieveoijdbtqa.supabase.co';
const TEMPLATE_MARKETPLACE_PUBLIC_KEY = 'sb_publishable_K_MKjtuMcwlXJyB67Bmu3A_2vFQ2PGX';
const NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY = 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY';
const TEMPLATE_FORMAT = 'novapack-studio-user-template';
const TEMPLATE_FORMAT_VERSION = 1;
const MAX_TEMPLATE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TEMPLATE_FILES_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_FILES = 1000;
const PUBLIC_KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const encoder = new TextEncoder();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateTemplateFilePath(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')
    || filename.includes('\\') || filename.startsWith('/') || /^[a-zA-Z]:/.test(filename)) {
    throw new Error(`Unsafe starter filename: ${filename}`);
  }
  const segments = filename.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || segment.startsWith('.') || segment.includes(':')
    || ['__proto__', 'prototype', 'constructor', 'node_modules'].includes(segment.toLowerCase()))) {
    throw new Error(`Unsafe starter filename: ${filename}`);
  }
  if (['manifest.json', 'novaapp.json'].includes(segments.at(-1).toLowerCase())) {
    throw new Error(`Unsafe starter filename: ${filename}`);
  }
  return segments.join('/');
}

function validateTemplateContent(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)
    || typeof template.name !== 'string' || typeof template.description !== 'string'
    || typeof template.author !== 'string' || typeof template.releaseVersion !== 'string'
    || typeof template.category !== 'string'
    || (template.icon != null && typeof template.icon !== 'string')
    || typeof template.files !== 'object' || !template.files || Array.isArray(template.files)
    || !template.manifest || typeof template.manifest !== 'object' || Array.isArray(template.manifest)) {
    throw new Error('Invalid community starter template.');
  }
  if (!template.name.trim() || template.name.trim().length > 80
    || !template.author.trim() || template.author.trim().length > 80
    || template.description.length > 240 || !template.category.trim()
    || template.category.trim().length > 40 || (template.icon && template.icon.length > 100)) {
    throw new Error('Template name and author must be 1-80 characters; description must be at most 240 characters.');
  }
  if (!semver.valid(template.releaseVersion)) {
    throw new Error('Template release version must be valid SemVer.');
  }
  if (Buffer.byteLength(JSON.stringify(template.manifest), 'utf8') > 256 * 1024) {
    throw new Error('Starter manifest exceeds the 256 KB limit.');
  }
  const names = Object.keys(template.files);
  if (!names.length) throw new Error('Starter must include at least one project file.');
  if (names.length > MAX_TEMPLATE_FILES) throw new Error('Starter contains too many files.');
  const files = Object.create(null);
  let totalBytes = 0;
  for (const filename of names) {
    const safeName = validateTemplateFilePath(filename);
    const encoded = template.files[filename];
    if (typeof encoded !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Invalid file data for ${filename}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error(`Invalid base64 file data for ${filename}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TEMPLATE_FILES_BYTES) {
      throw new Error('Starter files exceed the 2 MB import limit.');
    }
    files[safeName] = encoded;
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(template.manifest), 'utf8');
  if (manifestBytes > 256 * 1024) throw new Error('Starter manifest exceeds the 256 KB limit.');
  return { ...template, files };
}

function _verifyCommunityTemplateBundle(bundle, publicKey = NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || bundle.format !== TEMPLATE_FORMAT || bundle.version !== TEMPLATE_FORMAT_VERSION
    || !bundle.template || typeof bundle.template !== 'object' || Array.isArray(bundle.template)
    || !bundle.signature || typeof bundle.signature !== 'object' || Array.isArray(bundle.signature)
    || Object.keys(bundle).some((key) => !['format', 'version', 'template', 'signature'].includes(key))) {
    throw new Error('Invalid NovaByte community template bundle.');
  }
  const signature = bundle.signature;
  if (signature.algorithm !== 'Ed25519' || signature.publicKey !== publicKey
    || typeof signature.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.signature)) {
    throw new Error('The community template signature could not be verified.');
  }
  const publicKeyBytes = Buffer.from(publicKey, 'base64url');
  const signatureBytes = Buffer.from(signature.signature, 'base64url');
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64
    || signatureBytes.toString('base64url') !== signature.signature) {
    throw new Error('The community template signature is malformed.');
  }
  const key = crypto.createPublicKey({
    key: Buffer.concat([PUBLIC_KEY_PREFIX, publicKeyBytes]),
    format: 'der',
    type: 'spki',
  });
  const payload = encoder.encode(canonicalJson({
    format: bundle.format,
    version: bundle.version,
    template: bundle.template,
  }));
  if (!crypto.verify(null, payload, key, signatureBytes)) {
    throw new Error('The community template failed NovaByte signature verification.');
  }
  return {
    ...bundle,
    template: validateTemplateContent(bundle.template),
  };
}

function normalizeCommunityTemplateRow(row) {
  if (!row || typeof row !== 'object'
    || typeof row.template_id !== 'string' || !TEMPLATE_ID_RE.test(row.template_id)
    || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80
    || typeof row.version !== 'string' || !semver.valid(row.version)
    || typeof row.author !== 'string' || !row.author.trim() || row.author.length > 80
    || typeof row.description !== 'string' || row.description.length > 240
    || typeof row.category !== 'string' || row.category.length > 40
    || typeof row.file !== 'string') {
    throw new Error('The community template catalog contains an invalid entry.');
  }
  const size = Number(row.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TEMPLATE_JSON_BYTES) {
    throw new Error('The community template catalog contains an invalid package size.');
  }
  const file = new URL(row.file);
  if (file.protocol !== 'https:' || file.hostname !== new URL(TEMPLATE_MARKETPLACE_URL).hostname
    || file.port || file.username || file.password
    || !file.pathname.startsWith('/storage/v1/object/public/published-packages/')) {
    throw new Error('The community template catalog contains an untrusted download URL.');
  }
  return {
    id: row.template_id,
    name: row.name.trim(),
    version: row.version,
    author: row.author.trim(),
    description: row.description,
    category: row.category,
    file: file.href,
    size,
    publishedAt: typeof row.published_at === 'string' ? row.published_at : '',
  };
}

function validateCommunityTemplateBundle(bundle, listing, publicKey = NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY) {
  const verified = _verifyCommunityTemplateBundle(bundle, publicKey);
  const content = verified.template;
  if (listing && (content.name !== listing.name || content.author !== listing.author
    || content.description !== listing.description || content.releaseVersion !== listing.version
    || content.category !== listing.category)) {
    throw new Error('Signed template metadata does not match the community catalog listing.');
  }
  return verified;
}

async function fetchCommunityTemplateCatalog(fetcher = globalThis.fetch) {
  if (typeof fetcher !== 'function') throw new Error('Network requests are unavailable in this Studio runtime.');
  const url = new URL('/rest/v1/publisher_catalog_templates', TEMPLATE_MARKETPLACE_URL);
  url.search = new URLSearchParams({
    select: 'template_id,name,version,author,description,category,file,size,published_at',
    order: 'published_at.desc',
    limit: '100',
  }).toString();
  const response = await fetcher(url, {
    headers: {
      apikey: TEMPLATE_MARKETPLACE_PUBLIC_KEY,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Community template request failed (${response.status} ${response.statusText || 'HTTP error'}).`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('The community template catalog returned an invalid response.');
  return rows.map(normalizeCommunityTemplateRow);
}

async function downloadCommunityTemplate(row, fetcher = globalThis.fetch) {
  if (typeof fetcher !== 'function') throw new Error('Network requests are unavailable in this Studio runtime.');
  const template = normalizeCommunityTemplateRow({
    template_id: row.id,
    name: row.name,
    version: row.version,
    author: row.author,
    description: row.description,
    category: row.category,
    file: row.file,
    size: row.size,
    published_at: row.publishedAt,
  });
  const response = await fetcher(template.file, {
    headers: { apikey: TEMPLATE_MARKETPLACE_PUBLIC_KEY },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Community template download failed (${response.status} ${response.statusText || 'HTTP error'}).`);
  }
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_TEMPLATE_JSON_BYTES) {
    throw new Error('Community template exceeds the 4 MB JSON download limit.');
  }
  if (!response.body?.getReader) throw new Error('Template download did not provide a readable response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TEMPLATE_JSON_BYTES) throw new Error('Community template exceeds the 4 MB JSON download limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('The community template file is not valid UTF-8 JSON.');
  }
  const verified = validateCommunityTemplateBundle(bundle, template);
  const content = verified.template;
  return { listing: template, bundle: verified, template: content };
}

module.exports = {
  TEMPLATE_FORMAT,
  TEMPLATE_FORMAT_VERSION,
  MAX_TEMPLATE_JSON_BYTES,
  NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
  _canonicalCommunityTemplateJson: canonicalJson,
  _verifyCommunityTemplateBundle,
  downloadCommunityTemplate,
  fetchCommunityTemplateCatalog,
  normalizeCommunityTemplateRow,
  validateCommunityTemplateBundle,
  validateTemplateFilePath,
  validateTemplateContent,
};
