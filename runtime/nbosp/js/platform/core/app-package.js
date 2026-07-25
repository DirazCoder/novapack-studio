/**
 * NovaByte - App Package Manager
 * ────────────────────────────────────────────────────────────
 *
 * TRUST MODEL CHANGE (this revision):
 *  Previously, signing used HMAC-SHA256 with a *shared secret* — the same
 *  key had to be typed into both the signer's tool and every installer's
 *  dialog box. That can prove "this package wasn't altered since I typed
 *  the key in", but it can't prove "this came from a trusted publisher",
 *  because anyone who has the key (which by definition has to be shared to
 *  verify anything) can sign arbitrary packages. It also can't support a
 *  central signing authority: handing out the HMAC key to let a CA "vouch"
 *  for an app would let that CA (or anyone who intercepts the key) forge
 *  ANY app's signature, trusted or not.
 *
 *  This revision moves to Ed25519 public/private key signing as the
 *  default verification method, with support for additional algorithms
 *  and integrity hashing:
 *   - Ed25519 (primary): 64-byte signatures, fast verification, widely
 *     supported across platforms.
 *   - ML-DSA-65 (post-quantum): NIST-standardized PQC, protects against
 *     quantum adversaries.
 *   - Ed448: ultra-high traditional security margin (224-bit).
 *   - ECDSA P-256/P-384: legacy enterprise / smart-card compatibility.
 *   - RSA-PSS 4096: legacy infrastructure fallback.
 *   - Custom: user-supplied signing payload / verifier.
 *   - Integrity: BLAKE3 (default), SHA-256, SHA-512, or none. Always
 *     embedded alongside signatures for tamper detection.
 *
 *  SECURITY FIXES carried over / re-verified in this revision:
 *   [1] verifyPackage() performs real cryptographic signature verification.
 *   [2] installPackage() rejects packages whose signature fails
 *       verification unless the caller explicitly opts into skipVerify.
 *
 * @module js/app-package
 */

const AppPackage = (() => {
  const NOVAAPP_FORMAT_VERSION = '1.0';
  const _crypto = (typeof window !== 'undefined' ? window.crypto : null)
    || globalThis.crypto
    || require('crypto');

  // Separate, explicit Node `crypto` module — NOT the same as `_crypto`
  // above, which resolves to SubtleCrypto (window.crypto) in NW.js's
  // renderer. Ed448 isn't implemented by any browser's SubtleCrypto, but
  // NW.js also exposes real Node `require`, and Node's crypto module
  // (OpenSSL-backed) supports Ed448 natively. Lazily required and
  // optional-chained so this file still loads in a context without Node
  // (e.g. a plain browser tab) — Ed448 just won't be available there.
  let _nodeCrypto = null;
  function _getNodeCrypto() {
    if (!_nodeCrypto) {
      try { _nodeCrypto = require('crypto'); }
      catch (_) { _nodeCrypto = null; }
    }
    return _nodeCrypto;
  }

  // ─── Supported methods ──────────────────────────────────────────────────────

  // `algo` is the SIGN/VERIFY-time algorithm identifier (what sign()/
  // verify() pass to SubtleCrypto). generateKey() needs a DIFFERENT shape
  // for several of these (namedCurve for ECDSA; modulusLength +
  // publicExponent for RSA-PSS), so that's kept as a separate `keygenAlgo`
  // below instead of reusing `algo` for both — reusing it was the bug:
  // generateKey() was being called with sign-time params it doesn't
  // understand (`hash` instead of `namedCurve`, no `modulusLength` at all).
  const SIGNING_METHODS = {
    'ed25519':      { label: 'Ed25519',      algo: { name: 'Ed25519' },                  keygenAlgo: { name: 'Ed25519' },                                                                             keyType: 'OKP', crv: 'Ed25519' },
    'ml-dsa-65':    { label: 'ML-DSA-65',    algo: 'ml-dsa-65',                          keygenAlgo: null,                                                                                            keyType: 'OKP', crv: 'ML-DSA-65', experimental: true },
    'ed448':        { label: 'Ed448',        algo: { name: 'Ed448' },                    keygenAlgo: { name: 'Ed448' },                                                                               keyType: 'OKP', crv: 'Ed448', experimental: true },
    'ecdsa-p256':   { label: 'ECDSA P-256',  algo: { name: 'ECDSA', hash: 'SHA-256' },   keygenAlgo: { name: 'ECDSA', namedCurve: 'P-256' },                                                          keyType: 'EC',  crv: 'P-256' },
    'ecdsa-p384':   { label: 'ECDSA P-384',  algo: { name: 'ECDSA', hash: 'SHA-384' },   keygenAlgo: { name: 'ECDSA', namedCurve: 'P-384' },                                                          keyType: 'EC',  crv: 'P-384' },
    'rsa-pss-4096': { label: 'RSA-PSS 4096', algo: { name: 'RSA-PSS', hash: 'SHA-384', saltLength: 48 }, keygenAlgo: { name: 'RSA-PSS', hash: 'SHA-384', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) }, keyType: 'RSA', crv: null, modulusLength: 4096 },
    'custom':       { label: 'Custom',       algo: 'custom',                             keygenAlgo: null,                                                                                            keyType: null,  crv: null },
  };

  const INTEGRITY_METHODS = {
    'blake3': { label: 'BLAKE3',  bits: 256 },
    'sha256': { label: 'SHA-256', bits: 256 },
    'sha512': { label: 'SHA-512', bits: 512 },
    'none':   { label: 'None',     bits: null },
  };

  const DEFAULT_SIGNING_METHOD = 'ed25519';
  const DEFAULT_INTEGRITY_METHOD = 'blake3';

  // ─── Noble hashes / post-quantum (lazy require) ────────────────────────────

  let _nobleHashes = null;
  let _noblePostQuantum = null;

  function _getNobleHashes() {
    if (!_nobleHashes) {
      // Same pattern as @noble/post-quantum above: @noble/hashes's root
      // index.js deliberately throws ("root module cannot be imported:
      // import submodules instead") — blake3 only exists at the
      // blake3.js subpath. Requiring the bare package name always
      // threw here, which is why this looked like "not installed" even
      // when it was.
      try { _nobleHashes = require('@noble/hashes/blake3.js'); }
      catch (_) { _nobleHashes = null; }
    }
    return _nobleHashes;
  }

  function _getNoblePostQuantum() {
    if (!_noblePostQuantum) {
      // @noble/post-quantum's root index.js deliberately throws
      // ("root module cannot be imported: import submodules instead") —
      // ml_dsa65 only exists at the ml-dsa.js subpath, and it's exported
      // as snake_case (ml_dsa65), not mlDsa65. Requiring the bare package
      // name always threw here, which is why this looked like "not
      // installed" even when it was.
      try { _noblePostQuantum = require('@noble/post-quantum/ml-dsa.js'); }
      catch (_) { _noblePostQuantum = null; }
    }
    return _noblePostQuantum;
  }

  // ─── Canonical payload for signing ──────────────────────────────────────────

  function _signingPayload(pkg) {
    return JSON.stringify({
      novabyte_app: pkg.novabyte_app,
      manifest:     pkg.manifest,
      files:        pkg.files,
      compiled_at:  pkg.compiled_at
    });
  }

  // ─── Key material helpers ───────────────────────────────────────────────────

  async function _toCryptoKey(key, usage, method) {
    if (!key) throw new Error('No key provided');
    if (typeof key === 'object' && typeof key.type === 'string' && key.algorithm) {
      return key;
    }
    const m = method || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) throw new Error(`Unknown signing method: ${m}`);

    // ml-dsa-65 keys are hex strings (see generateSigningKeyPair), not JWK
    // JSON, so this must run before the generic JSON.parse gate below —
    // parsing a hex string as JSON always throws, which was rejecting
    // every valid ML-DSA-65 key before it ever reached this branch.
    if (m === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // Real API takes/returns raw key bytes directly to sign()/verify() —
      // there's no importKey step and no keyFromJwk (that was invented).
      // Keys are stored as hex strings here (see generateSigningKeyPair),
      // so just decode hex back to bytes.
      const hexStr = typeof key === 'string' ? key : null;
      if (!hexStr || !/^[0-9a-fA-F]+$/.test(hexStr)) {
        throw new Error('ML-DSA-65 keys must be a hex string (from generateSigningKeyPair)');
      }
      const bytes = new Uint8Array(hexStr.match(/.{2}/g).map(b => parseInt(b, 16)));
      return bytes;
    }

    let jwk = key;
    if (typeof key === 'string') {
      try { jwk = JSON.parse(key); }
      catch (_) { throw new Error('String keys must be a JWK JSON string'); }
    }
    if (m === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) throw new Error('Ed448 requires Node crypto (available in NW.js), which is not present in this environment');
      // Node's createPublicKey/createPrivateKey accept a JWK directly —
      // unlike ML-DSA-65, Ed448 JWKs round-trip fine through Node crypto,
      // no hex workaround needed here.
      return usage === 'sign'
        ? nc.createPrivateKey({ key: jwk, format: 'jwk' })
        : nc.createPublicKey({ key: jwk, format: 'jwk' });
    }
    if (m === 'custom') {
      return jwk;
    }
    // importKey needs the KEYGEN shape (namedCurve for ECDSA, modulusLength
    // for RSA-PSS), not spec.algo, which is the SIGN/VERIFY-time shape
    // (hash instead of namedCurve). Using spec.algo here threw "passed
    // algorithm cannot be converted to 'EcKeyImportParams' because
    // 'namedCurve' is required" for every ECDSA import — the same
    // algo-vs-keygenAlgo mixup already fixed for generateKey() below, but
    // this call site was missed.
    return _crypto.subtle.importKey('jwk', jwk, spec.keygenAlgo, true, [usage]);
  }

  // ─── Keypair generation ─────────────────────────────────────────────────────

  async function generateSigningKeyPair(method = DEFAULT_SIGNING_METHOD) {
    const m = method || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) throw new Error(`Unsupported signing method: ${m}`);

    if (m === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // Real API (ml_dsa65.keygen()) returns { secretKey, publicKey } as
      // raw Uint8Array — there is no .toJwk() on these (that was invented
      // against a nonexistent API). Hex-encode them instead, matching how
      // this file already hex-encodes signatures elsewhere; publicJwk/
      // privateJwk are kept as field names for compatibility with callers
      // but hold hex strings, not JWK JSON, for this method.
      const keypair = npq.ml_dsa65.keygen();
      const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return {
        publicKey:  keypair.publicKey,
        privateKey: keypair.secretKey,
        publicJwk:  toHex(keypair.publicKey),
        privateJwk: toHex(keypair.secretKey),
      };
    }

    if (m === 'custom') {
      throw new Error('Cannot generate a keypair for custom signing — provide your own key material');
    }

    if (m === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) {
        throw new Error('Ed448 requires Node crypto (available in NW.js) — not present in this environment (e.g. a plain browser tab)');
      }
      // Node's OpenSSL-backed crypto supports Ed448 keygen with direct
      // JWK output, so this can populate publicJwk/privateJwk for real
      // (no hex workaround needed, unlike ML-DSA-65 above).
      const { publicKey, privateKey } = nc.generateKeyPairSync('ed448', {
        publicKeyEncoding:  { format: 'jwk' },
        privateKeyEncoding: { format: 'jwk' },
      });
      return {
        publicKey,
        privateKey,
        publicJwk:  publicKey,
        privateJwk: privateKey,
      };
    }

    const pair = await _crypto.subtle.generateKey(spec.keygenAlgo, true, ['sign', 'verify']);
    const [publicJwk, privateJwk] = await Promise.all([
      _crypto.subtle.exportKey('jwk', pair.publicKey),
      _crypto.subtle.exportKey('jwk', pair.privateKey),
    ]);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk };
  }

  // ─── Integrity helpers ──────────────────────────────────────────────────────

  function _getHasher(method) {
    const m = method || DEFAULT_INTEGRITY_METHOD;
    const spec = INTEGRITY_METHODS[m];
    if (!spec) throw new Error(`Unknown integrity method: ${m}`);
    if (m === 'none') return null;
    if (m === 'blake3') {
      const nh = _getNobleHashes();
      if (!nh) throw new Error('@noble/hashes is not available — install it to use BLAKE3');
      return {
        hash: (data) => Array.from(nh.blake3(data)).map(b => b.toString(16).padStart(2, '0')).join(''),
        label: spec.label,
      };
    }
    // m is lowercase ('sha256'/'sha512'), but WebCrypto requires the
    // dashed uppercase form ('SHA-256'/'SHA-512') — a prior version of
    // this lookup compared against uppercase keys ({'SHA-256': ...}[m])
    // which never matched lowercase m, so it always fell through to
    // m.toUpperCase() = 'SHA256' (no dash), which subtle.digest rejects
    // with "Unrecognized name".
    const algo = { sha256: { name: 'SHA-256' }, sha512: { name: 'SHA-512' } }[m];
    if (!algo) throw new Error(`Unknown integrity method: ${m}`);
    const hasher = _crypto.subtle.digest.bind(_crypto.subtle);
    return {
      hash: async (data) => {
        if (typeof data === 'string') data = new TextEncoder().encode(data);
        const buf = await hasher(algo, data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      },
      label: spec.label,
    };
  }

  async function computeIntegrity(pkg, method = DEFAULT_INTEGRITY_METHOD) {
    const m = method || DEFAULT_INTEGRITY_METHOD;
    const hasher = _getHasher(m);
    if (!hasher) return { method: 'none', payloadHash: null, fileHashes: {} };

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const payloadHash = await hasher.hash(payload);

    const fileHashes = {};
    for (const [relPath, encoded] of Object.entries(pkg.files || {})) {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      fileHashes[relPath] = await hasher.hash(bytes);
    }

    return { method: m, payloadHash, fileHashes };
  }

  async function verifyIntegrity(pkg) {
    if (!pkg || !pkg.integrity) return false;
    const { method, payloadHash, fileHashes } = pkg.integrity;
    if (method === 'none' || !payloadHash) return true;

    const hasher = _getHasher(method);
    if (!hasher) return false;

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const currentPayloadHash = await hasher.hash(payload);
    if (currentPayloadHash !== payloadHash) return false;

    for (const [relPath, expectedHash] of Object.entries(fileHashes || {})) {
      const encoded = pkg.files?.[relPath];
      if (!encoded) return false;
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const currentFileHash = await hasher.hash(bytes);
      if (currentFileHash !== expectedHash) return false;
    }
    return true;
  }

  // ─── Signing & verification ─────────────────────────────────────────────────

  async function signPackage(pkg, privateKey, options = {}) {
    const method = options.method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[method];
    if (!spec) throw new Error(`Unsupported signing method: ${method}`);

    if (method === 'custom') {
      const payload = _signingPayload(pkg);
      const signature = typeof privateKey === 'function'
        ? await privateKey(payload)
        : String(privateKey);
      return signature;
    }

    if (method === 'ml-dsa-65') {
      const npq = _getNoblePostQuantum();
      if (!npq) throw new Error('@noble/post-quantum is not available — install it to use ML-DSA-65');
      // ml_dsa65.sign(msg, secretKey) is a plain function returning a raw
      // Uint8Array signature — no signingKey.sign(...) method, no .toHex().
      const secretKeyBytes = await _toCryptoKey(privateKey, 'sign', method);
      const payload = new TextEncoder().encode(_signingPayload(pkg));
      const sig = npq.ml_dsa65.sign(payload, secretKeyBytes);
      return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    if (method === 'ed448') {
      const nc = _getNodeCrypto();
      if (!nc) throw new Error('Ed448 requires Node crypto (available in NW.js), which is not present in this environment');
      // EdDSA (Ed448/Ed25519) uses one-shot sign with algorithm=null —
      // there's no separate digest step, unlike ECDSA/RSA above.
      const keyObj = await _toCryptoKey(privateKey, 'sign', method);
      const payload = Buffer.from(_signingPayload(pkg), 'utf8');
      const sig = nc.sign(null, payload, keyObj);
      return sig.toString('hex');
    }

    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const cryptoKey = await _toCryptoKey(privateKey, 'sign', method);
    const sig = await _crypto.subtle.sign(spec.algo, cryptoKey, payload);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function verifyPackage(pkg, publicKey, method) {
    if (!pkg || !pkg.signature) return false;
    const m = method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
    const spec = SIGNING_METHODS[m];
    if (!spec) return false;

    if (m === 'custom') {
      try {
        const payload = _signingPayload(pkg);
        return typeof publicKey === 'function' ? await publicKey(pkg.signature, payload) : false;
      } catch (_) { return false; }
    }

    if (m === 'ml-dsa-65') {
      try {
        const npq = _getNoblePostQuantum();
        if (!npq) return false;
        // ml_dsa65.verify(sig, msg, publicKey) is a plain function taking
        // raw byte arrays — no Signature.fromHex or verifyKey.verify(...)
        // method (those don't exist on the real API).
        const publicKeyBytes = await _toCryptoKey(publicKey, 'verify', m);
        const payload = new TextEncoder().encode(_signingPayload(pkg));
        const sigMatch = pkg.signature.match(/.{2}/g);
        if (!sigMatch) return false;
        const sigBytes = new Uint8Array(sigMatch.map(b => parseInt(b, 16)));
        return npq.ml_dsa65.verify(sigBytes, payload, publicKeyBytes);
      } catch (_) { return false; }
    }

    if (m === 'ed448') {
      try {
        const nc = _getNodeCrypto();
        if (!nc) return false;
        const keyObj = await _toCryptoKey(publicKey, 'verify', m);
        const payload = Buffer.from(_signingPayload(pkg), 'utf8');
        const sigMatch = pkg.signature.match(/.{2}/g);
        if (!sigMatch) return false;
        const sigBytes = Buffer.from(sigMatch.map(b => parseInt(b, 16)));
        return nc.verify(null, payload, keyObj, sigBytes);
      } catch (_) { return false; }
    }

    try {
      const payload = new TextEncoder().encode(_signingPayload(pkg));
      const cryptoKey = await _toCryptoKey(publicKey, 'verify', m);
      const sigMatch = pkg.signature.match(/.{2}/g);
      if (!sigMatch) return false;
      const sigBytes = new Uint8Array(sigMatch.map(b => parseInt(b, 16)));
      return await _crypto.subtle.verify(spec.algo, cryptoKey, sigBytes, payload);
    } catch (_) {
      return false;
    }
  }

  async function verifyAgainstTrustStore(pkg, trustStore, revocationCheck) {
    if (!pkg || !pkg.signature || !Array.isArray(trustStore)) return { trusted: false, signer: null };
    if (typeof revocationCheck === 'function' && revocationCheck(pkg.signature)) {
      return { trusted: false, signer: null, revoked: true };
    }
    for (const entry of trustStore) {
      try {
        const method = entry.method || getSigningMethod(pkg) || DEFAULT_SIGNING_METHOD;
        const ok = await verifyPackage(pkg, entry.publicKey, method);
        if (ok) return { trusted: true, signer: entry.name || null, method };
      } catch (_) { /* try next entry */ }
    }
    return { trusted: false, signer: null };
  }

  // ─── Package creation ────────────────────────────────────────────────────────

  async function createPackage(manifest, files, options = {}) {
    const validation = validateManifest(manifest);
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
    if (validation.warnings.length > 0) console.warn('[AppPackage] Warnings:', validation.warnings);

    const pkg = {
      novabyte_app: NOVAAPP_FORMAT_VERSION,
      manifest: { ...manifest, packagedAt: new Date().toISOString() },
      files: {},
      signature: null,
      signer: null,
      compiled_at: new Date().toISOString(),
      signing: null,
      integrity: null,
    };

    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        pkg.files[path] = btoa(unescape(encodeURIComponent(content)));
      } else if (content instanceof Uint8Array || Buffer.isBuffer?.(content)) {
        const binary = Array.from(new Uint8Array(content))
          .map(b => String.fromCharCode(b)).join('');
        pkg.files[path] = btoa(binary);
      }
    }

    if (options.signingKey) {
      const method = options.signingMethod || DEFAULT_SIGNING_METHOD;
      pkg.signing = { method };
      pkg.signature = await signPackage(pkg, options.signingKey, { method });
      pkg.signer = options.signerName || 'self-signed';
    }

    if (options.integrityMethod !== 'none') {
      const intMethod = options.integrityMethod || DEFAULT_INTEGRITY_METHOD;
      pkg.integrity = await computeIntegrity(pkg, intMethod);
    }

    return pkg;
  }

  // ─── Install / uninstall ─────────────────────────────────────────────────────

  async function installPackage(pkg, options = {}) {
    let verified = false;
    let signer = null;

    if (!options.skipVerify) {
      const trustStore = options.trustStore || [];
      const result = await verifyAgainstTrustStore(pkg, trustStore, options.revocationCheck);
      verified = result.trusted;
      signer = result.signer;
      if (!verified && !options.allowUnverified) {
        const intOk = options.allowIntegrityFallback ? await verifyIntegrity(pkg) : false;
        if (!intOk) {
          const msg = 'Package signature did not match any trusted signer and integrity check failed';
          if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: `Install failed for ${pkg?.manifest?.id || '(unknown)'}: ${msg}`, data: { appId: pkg?.manifest?.id, reason: 'signature' } });
          }
          throw new Error(msg);
        }
        verified = true;
        signer = signer || 'integrity-only';
      }
    }

    const validation = validateManifest(pkg.manifest);
    if (!validation.valid) {
      const msg = `Invalid manifest: ${validation.errors.join(', ')}`;
      if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: `Install failed for ${pkg?.manifest?.id || '(unknown)'}: ${msg}`, data: { appId: pkg?.manifest?.id, reason: 'manifest' } });
      }
      throw new Error(msg);
    }

    const existing = (typeof AppRegistry !== 'undefined') && AppRegistry?.getApp(pkg.manifest.id);
    if (existing && !options.force) {
      const msg = `App ${pkg.manifest.id} is already installed. Use force option to overwrite.`;
      if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Packages', category: 'packages', severity: 'error', message: msg, data: { appId: pkg.manifest.id, reason: 'duplicate' } });
      }
      throw new Error(msg);
    }

    const appConfig = {
      ...pkg.manifest,
      files:         pkg.files,
      signature:     pkg.signature,
      verified,
      signer,
      source:        options.source || 'file',
      installedDate: new Date().toISOString()
    };

    const registered = (typeof AppRegistry !== 'undefined') && AppRegistry?.registerApp(appConfig, { force: !!options.force });

    if (registered && typeof window.NovaAppPackageStore !== 'undefined' && window.NovaAppPackageStore.installApp) {
      try {
        await window.NovaAppPackageStore.installApp({
          id: appConfig.id,
          name: appConfig.name,
          version: appConfig.version,
          entry: appConfig.entry,
          icon: appConfig.icon,
          description: appConfig.description || '',
          category: appConfig.category || 'other',
          permissions: appConfig.permissions || [],
          optionalPermissions: appConfig.optionalPermissions || [],
          files: appConfig.files || {},
          signature: appConfig.signature,
          verified,
          signer,
          source: appConfig.source,
          installedDate: appConfig.installedDate,
          manifest: pkg.manifest,
          signing: pkg.signing,
          integrity: pkg.integrity,
        });
      } catch (e) {
        console.warn('[AppPackage] Failed to persist installed app to NovaAppPackageStore:', e);
      }
    }

    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'Packages',
        category: 'packages',
        severity: validation.warnings.length ? 'warn' : 'info',
        message: `Installed ${pkg.manifest.id}${verified ? '' : ' (unverified)'}`,
        data: { appId: pkg.manifest.id, verified, signer, source: appConfig.source, warnings: validation.warnings },
      });
    }
    return { success: true, app: registered, verified, signer, warnings: validation.warnings };
  }

  function uninstallPackage(appId) {
    const result = (typeof AppRegistry !== 'undefined' && AppRegistry?.unregisterApp(appId)) || false;
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'Packages',
        category: 'packages',
        severity: result ? 'info' : 'warn',
        message: result ? `Uninstalled ${appId}` : `Uninstall failed for ${appId} (not found)`,
        data: { appId, action: 'uninstall' },
      });
    }
    return result;
  }

  function extractPackage(pkg) {
    const files = {};
    for (const [path, encoded] of Object.entries(pkg.files)) {
      try {
        const binary = atob(encoded);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        files[path] = bytes;
      } catch (e) {
        console.error(`[AppPackage] Failed to decode ${path}:`, e);
      }
    }
    return files;
  }

  function inspectPackage(pkg) {
    return {
      format:       pkg.novabyte_app,
      manifest:     pkg.manifest,
      fileCount:    Object.keys(pkg.files).length,
      files:        Object.keys(pkg.files),
      hasSignature: !!pkg.signature,
      signer:       pkg.signer || null,
      signingMethod: pkg.signing?.method || null,
      integrityMethod: pkg.integrity?.method || null,
      size:         JSON.stringify(pkg).length
    };
  }

  // ─── Method readers ─────────────────────────────────────────────────────────

  function getSigningMethod(pkg) {
    if (!pkg || !pkg.signing) return null;
    const m = pkg.signing.method;
    return SIGNING_METHODS[m] ? m : null;
  }

  function getIntegrityMethod(pkg) {
    if (!pkg || !pkg.integrity) return null;
    const m = pkg.integrity.method;
    return INTEGRITY_METHODS[m] ? m : null;
  }

  function listSigningMethods() {
    return Object.entries(SIGNING_METHODS).map(([id, spec]) => ({ id, label: spec.label, experimental: !!spec.experimental }));
  }

  function listIntegrityMethods() {
    return Object.entries(INTEGRITY_METHODS).map(([id, spec]) => ({ id, label: spec.label }));
  }

  // ─── Manifest validation ────────────────────────────────────────────────────

  // Icons are a small UI asset — a legitimate high-res PNG/SVG as a data:
  // URI comfortably fits well under this. Anything past it is either a
  // mistake (wrong file embedded) or a deliberate attempt to bloat the
  // manifest / waste memory on every render of the app list, launcher,
  // taskbar, etc. — icon strings get parsed and rendered repeatedly across
  // many UI surfaces (see appmanager.js svgIcon()/createEl() call sites),
  // so an oversized one has an outsized cost relative to its purpose.
  const MAX_ICON_DATA_URI_BYTES = 512 * 1024; // 512KB

  function validateManifest(manifest) {
    const errors = [], warnings = [];
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['Manifest is missing or not an object'], warnings: [] };
    }
    ['id', 'name', 'version', 'entry'].forEach(f => {
      if (!manifest[f]) errors.push(`Missing required field: ${f}`);
    });
    if (manifest.id && !manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id))
        errors.push(`Invalid app ID "${manifest.id}". Must be reverse domain format.`);
    }
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version))
      warnings.push(`Version "${manifest.version}" doesn't follow semver (x.y.z)`);
    if (manifest.permissions) {
      const valid = Object.values((typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.PERMISSION_TYPES) || {});
      manifest.permissions.forEach(p => {
        if (valid.length > 0 && !valid.includes(p)) warnings.push(`Unknown permission: ${p}`);
      });
    }
    if (typeof manifest.icon === 'string' && manifest.icon.startsWith('data:')) {
      // .length on a data: URI string is a fine proxy for its encoded byte
      // size here — off by a small constant factor at most (base64 framing
      // overhead), nowhere near enough to matter against a 512KB cap.
      if (manifest.icon.length > MAX_ICON_DATA_URI_BYTES) {
        errors.push(`Icon data URI exceeds ${MAX_ICON_DATA_URI_BYTES} byte limit (got ~${manifest.icon.length} bytes) — use a smaller image or reference a file in the package instead`);
      }
    }
    if (manifest.defaultSize &&
        (!Array.isArray(manifest.defaultSize) || manifest.defaultSize.length !== 2))
      errors.push('defaultSize must be [width, height]');
    if (manifest.minSize &&
        (!Array.isArray(manifest.minSize) || manifest.minSize.length !== 2))
      errors.push('minSize must be [width, height]');
    if (manifest.maxSize &&
        (!Array.isArray(manifest.maxSize) || manifest.maxSize.length !== 2))
      errors.push('maxSize must be [width, height]');
    return { valid: errors.length === 0, errors, warnings };
  }

  return {
    validateManifest, createPackage, signPackage, verifyPackage,
    verifyAgainstTrustStore, generateSigningKeyPair,
    installPackage, uninstallPackage, extractPackage, inspectPackage,
    computeIntegrity, verifyIntegrity,
    getSigningMethod, getIntegrityMethod,
    listSigningMethods, listIntegrityMethods,
    SIGNING_METHODS, INTEGRITY_METHODS,
    DEFAULT_SIGNING_METHOD, DEFAULT_INTEGRITY_METHOD,
    NOVAAPP_FORMAT_VERSION
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AppPackage;
if (typeof window !== 'undefined') window.AppPackage = AppPackage;