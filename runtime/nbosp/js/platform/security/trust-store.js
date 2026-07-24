/**
 * NovaByte - Trust Store
 * ────────────────────────────────────────────────────────────
 * A small, explicit list of public keys NBOSP trusts to vouch for app
 * packages, analogous to a browser's shipped root CA list. Each entry
 * holds ONLY a public key — never a secret — so shipping this file to
 * every install is safe: it lets installs *verify* signatures, it can
 * never let anyone *forge* one.
 *
 * Where entries come from:
 *  - "NovaByte Trusted Signing" is the built-in signing authority run by
 *    NovaByte. Developers who want the "Trusted" badge submit their
 *    package to that authority (see NovaPack Studio's signing flow),
 *    which reviews it and signs it with a private key ONLY NovaByte
 *    holds, offline. This file ships the matching public key.
 *  - Additional partner/enterprise CAs can be appended the same way if
 *    NovaByte ever delegates trust to other signing authorities.
 *  - Individual developers can still self-sign (createPackage with a
 *    signingKey) for their own testing, but self-signed packages will
 *    not match anything in this trust store, so they'll always surface
 *    as "Unverified" to end users — which is correct: nobody but the
 *    developer themselves vouches for a self-signed app.
 *
 * NOTE on the key below: this is a real public key, not a placeholder.
 * It corresponds to NovaByte's own private signing key, held offline
 * and never distributed to developers — that's what the "Verified"
 * badge means for a stock/NovaByte-signed install (see the README's
 * Security section).
 *
 * Swapping it out: if your fork isn't licensed for NovaByte Services,
 * this key is yours to replace like any other trust store entry —
 * point it at your own offline signing key and your fork's "Verified"
 * badge will mean packages reviewed and signed by you instead. The
 * key only has to stay as-is (unmodified, unremoved, still checked)
 * if your fork is NovaByte Services-licensed — see below.
 *
 * This file is part of NBOSP itself (Apache 2.0) — it's bundled in
 * every clone and fork, no separate license needed to have it or fork
 * it as-is.
 *
 * The one condition: if your fork wants a NovaByte Services license
 * (see the README's Licensing section — this covers Nova Core
 * Services, NovaBridge, Sentinel, and the other bundled components),
 * this check — verifying package signatures against the trust store —
 * has to stay intact: not removed, not bypassed, not turned into a
 * no-op, and the NovaByte key above has to stay the one it verifies
 * against. We won't issue a NovaByte Services license to a fork where
 * this has been altered, because a fork that hands out "Trusted"
 * badges to unreviewed/unsigned packages breaks verification for
 * users and for us. Forking NBOSP without a NovaByte Services license
 * is unaffected either way — do what you want with your fork,
 * including swapping this key for your own; this condition only bites
 * if you also want that license.
 *
 * Revocation:
 *  - A signature can be individually revoked without touching the signing
 *    key itself or any other package ever signed. Revocation is keyed by
 *    the exact signature string on the package (pkg.signature), not by
 *    app id/name/version — those are dev-controlled fields a bad actor
 *    could reuse or spoof; the signature is a fixed, unforgeable value
 *    produced once at sign time, so it's the only safe revocation key.
 *  - Revoking a signature does NOT revoke the signing key. Every other
 *    package ever signed with that key remains trusted. This is
 *    deliberately narrow — the whole point is to avoid "one bad app means
 *    distrust everything NovaByte has ever signed."
 *  - If the signing key itself is compromised (the actual key leaks),
 *    revoking individual signatures here is NOT sufficient — that
 *    scenario requires removing/replacing the trust store entry itself
 *    (see `list()`/`add()`) and re-signing everything with a new key.
 *    Revocation here only covers "this one specific app turned out bad,"
 *    not "the key itself is no longer trustworthy."
 *
 * @module js/platform/security/trust-store
 */

const TrustStore = (() => {
  // Real public key, matching NovaByte's own offline private signing
  // key (see the module-level comment above — swappable for your own
  // if this fork isn't NovaByte Services-licensed).
  const NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY',
  };

  const entries = [
    {
      name: 'NovaByte Trusted Signing',
      id: 'novabyte-trusted-signing-v1',
      publicKey: NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK,
      // Shown in the "More Info" panel of the untrusted-app dialog.
      description: 'Reviewed and signed by NovaByte\u2019s trusted signing authority.',
    },
    // Additional trusted CAs / partners can be appended here.
  ];

  // ── Revocation list — persisted to disk ──────────────────────────────
  // Keyed by exact pkg.signature (a hex string). Lives in
  // revoked-signatures.json, next to this file, so a revocation survives
  // restarts and is visible to every NBOSP process that loads this
  // module — not just the one that called revoke(). NW.js gives this
  // file real `fs`/`path` access even though it's loaded like a browser
  // script, so this works the same way it would in plain Node.
  //
  // NOTE: this is single-machine persistence, not multi-machine sync —
  // if you ever run multiple NBOSP instances against a shared/synced
  // copy of this file (the way submission-queue.js shares Drive-synced
  // submissions.json across dev machines), the same read-modify-write
  // race caveat from that module applies here too. For a single install
  // reading its own local file, that's not a concern.
  let _fs = null;
  let _path = null;
  try {
    // Only succeeds in a Node-capable context (NW.js renderer, Node
    // itself). In a plain sandboxed browser tab, this throws and we fall
    // back to in-memory-only behavior below — better to run without
    // persistence than to crash the whole trust store on load.
    _fs = require('fs');
    _path = require('path');
  } catch (_) { /* no filesystem access available; persistence disabled */ }

  const REVOCATION_FILENAME = 'revoked-signatures.json';

  // This file relative to the NBOSP app root. Kept explicit rather than
  // derived from __dirname: this module is loaded as a plain <script src>
  // tag (see index.html), not require()'d as a CommonJS module, and
  // __dirname/__filename are only ever defined for modules loaded via
  // require() — NW.js does not set them for top-level page/script-tag
  // scope even with Node integration on. `typeof __dirname` doesn't throw
  // on that undeclared global, so the old code silently fell through to
  // '.' (i.e. process.cwd()), which is the NBOSP root the server process
  // was launched from — NOT this file's actual directory. That made
  // every lookup miss the real revoked-signatures.json (ENOENT, silently
  // swallowed as "no revocations yet"), so revocations never loaded and
  // revoked signatures kept showing as verified with no popup.
  const REVOCATION_RELATIVE_PATH = ['js', 'platform', 'security', REVOCATION_FILENAME];

  function _revocationFilePath() {
    return _path.join(process.cwd(), ...REVOCATION_RELATIVE_PATH);
  }

  function _loadRevokedFromDisk() {
    if (!_fs) return [];
    try {
      const raw = _fs.readFileSync(_revocationFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return []; // no revocations yet — normal on first run
      // A corrupt file is a real risk worth surfacing, not silently
      // swallowing — same reasoning as submission-queue.js's _readRaw().
      console.error(`[TrustStore] revoked-signatures.json exists but couldn't be read/parsed: ${err.message}. Revocation list may be incomplete until this is fixed.`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'TrustStore', category: 'security', severity: 'error', message: `Revocation list corrupt/unreadable: ${err.message}. List may be incomplete.` });
      }
      return [];
    }
  }

  function _saveRevokedToDisk(list) {
    if (!_fs) return; // no persistence available; caller already has the in-memory update
    try {
      _fs.writeFileSync(_revocationFilePath(), JSON.stringify(list, null, 2));
    } catch (err) {
      console.error(`[TrustStore] Failed to write revoked-signatures.json: ${err.message}. Revocation was applied in memory but will NOT survive a restart until this is fixed.`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'TrustStore', category: 'security', severity: 'error', message: `Failed to persist revocation list: ${err.message}. In-memory only, will not survive restart.` });
      }
    }
  }

  // Loaded once at module init. If persistence isn't available, starts
  // empty and stays in-memory-only for this session (see revoke() below).
  const revoked = _loadRevokedFromDisk();

  function list() {
    return entries.slice();
  }

  function add(entry) {
    if (!entry || !entry.publicKey || !entry.name) {
      throw new Error('Trust store entries need at least {name, publicKey}');
    }
    entries.push(entry);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'TrustStore', category: 'security', severity: 'warn', message: `Added trusted signing authority: ${entry.name}`, data: { name: entry.name, id: entry.id } });
    }
  }

  /**
   * Revoke a specific signed package by its exact signature string.
   * Idempotent — revoking an already-revoked signature just updates the
   * reason/timestamp rather than adding a duplicate entry. Persists to
   * revoked-signatures.json immediately if filesystem access is
   * available; if not (e.g. a sandboxed browser context with no Node
   * integration), the revocation still applies for THIS process's
   * lifetime, but will not survive a restart or be visible to other
   * processes — check the console warning if that happens.
   * @param {string} signature - the exact pkg.signature hex string
   * @param {string} [reason]
   * @returns {object} the revocation record
   */
  function revoke(signature, reason) {
    if (!signature || typeof signature !== 'string') {
      throw new Error('revoke() requires the exact pkg.signature string of the package being revoked');
    }
    const existing = revoked.find((r) => r.signature === signature);
    let record;
    if (existing) {
      existing.reason = reason || existing.reason;
      existing.revokedAt = Date.now();
      record = existing;
    } else {
      record = { signature, reason: reason || null, revokedAt: Date.now() };
      revoked.push(record);
    }
    if (!_fs) {
      console.warn('[TrustStore] No filesystem access in this context — revocation applied for this session only and will NOT persist. Run this from an NW.js/Node context with fs access for it to stick.');
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'TrustStore', category: 'security', severity: 'warn', message: 'Revocation applied in-memory only (no fs access) — will not persist across restart' });
      }
    }
    _saveRevokedToDisk(revoked);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'TrustStore', category: 'security', severity: 'warn', message: `Revoked signature${reason ? ': ' + reason : ''}`, data: { signature, reason: reason || null } });
    }
    return record;
  }

  /**
   * Remove a signature from the revocation list (un-revoke). Rare, but
   * needed if a revocation was applied by mistake.
   */
  function unrevoke(signature) {
    const idx = revoked.findIndex((r) => r.signature === signature);
    if (idx === -1) return false;
    revoked.splice(idx, 1);
    _saveRevokedToDisk(revoked);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'TrustStore', category: 'security', severity: 'warn', message: 'Un-revoked a previously revoked signature', data: { signature } });
    }
    return true;
  }

  function isRevoked(signature) {
    if (!signature) return false;
    return revoked.some((r) => r.signature === signature);
  }

  /**
   * Look up the full revocation record for a signature (reason,
   * revokedAt), or null if it isn't revoked. Kept separate from
   * isRevoked() so existing callers that treat it as a plain boolean
   * predicate (e.g. verifyAgainstTrustStore) aren't affected.
   */
  function getRevocation(signature) {
    if (!signature) return null;
    return revoked.find((r) => r.signature === signature) || null;
  }

  function listRevoked() {
    return revoked.slice();
  }

  return { list, add, revoke, unrevoke, isRevoked, getRevocation, listRevoked };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrustStore;
if (typeof window !== 'undefined') window.TrustStore = TrustStore;