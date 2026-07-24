// ── Shared Nova app launch config (hoisted to module scope) ──────────────
// buildNovaAppConfig() and its helpers used to live entirely inside
// init(content) below, meaning they only existed once a user actually
// opened the App Manager window. boot.js needs the exact same rendering
// logic (files/entry wiring, permission gating, trust/tamper checks,
// sandboxed webview launch) to correctly re-register previously-installed
// apps at boot time — before App Manager has ever been opened. Hoisting
// these to the top level and exposing buildNovaAppConfig on window lets
// boot.js reuse the real implementation instead of a second, incomplete
// hand-rolled one that was missing files/entry/init entirely.
//
// The one thing that doesn't hoist as-is is the AbortController: the
// original version closed over a single `ac` created once per App-Manager-
// window-open and shared across every launch from that window. Each call
// to buildNovaAppConfig() now creates its own AbortController scoped to
// that one launch instead — every call already gets its own webview and
// listeners, so a per-launch controller is more correct than the old
// per-window one, not a shortcut.
    function buildSandboxCSP(appData) {
      const base = "default-src 'self' blob: data: 'unsafe-inline' 'unsafe-eval'; " +
        "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline' blob: data:; " +
        "img-src 'self' blob: data: https:; " +
        "font-src 'self' blob: data:; " +
        "connect-src 'self' blob: http://localhost:* https://localhost:*";

      let frameSrc = '';
      if (appData?.url) {
        try {
          const parsed = new URL(appData.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            // Scope to exactly this app's declared origin — not a wildcard —
            // so one app can't use this allowance to frame arbitrary sites.
            frameSrc = '; frame-src ' + parsed.origin;
          } else {
            console.warn('[AppManager] app declares non-http(s) url, ignoring for frame-src:', appData.url);
          }
        } catch (e) {
          console.warn('[AppManager] app declares invalid url, ignoring for frame-src:', appData.url);
        }
      }

      const escaped = (base + frameSrc).replace(/"/g, '&quot;');
      return '<meta http-equiv="Content-Security-Policy" content="' + escaped + '">\n';
    }
    // ── Text sanitisation: avoid innerHTML with user-controlled strings ──
    function escapeHtml(str) {
      const el = document.createElement('span');
      el.textContent = str;
      return el.innerHTML;
    }
    function showUntrustedAppDialog(appData, { onLaunchAnyway } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border,#333);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const isRevoked = !!appData.revoked;
        const hasSignature = !!appData.signature;
        const integrityStatus = appData.integrityStatus || 'unavailable';
        const integrityLabel = integrityStatus === 'ok' ? 'passed — contents match build-time hash'
          : integrityStatus === 'failed' ? '\u26A0\uFE0F failed — contents do not match build-time hash'
          : 'not available — package has no integrity hash to check against';
        const integrityColor = integrityStatus === 'failed' ? '#f85149' : 'var(--text-primary,#eee)';

        let title, summary, cautionText, cautionBorderColor, cautionBgColor, cautionDotColor, cautionTitle, iconEmoji;

        if (isRevoked) {
          iconEmoji = '\uD83D\uDD34';
          title = 'Revoked Package — Do Not Install';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} carries a signature that has been individually revoked by NovaByte OS.
            This package was previously verified as signed by a trusted authority, but was subsequently pulled from the trust list — most likely because it was found to be harmful, deceptive, or non-compliant after review.`;
          cautionTitle = 'Why this is serious';
          cautionText = 'A revoked signature means NovaByte OS once recognised the publisher, but has since decided this specific package should not be trusted. Other packages from the same publisher may still be trusted, but this one is not. Installing it bypasses an explicit security decision.';
          cautionBorderColor = 'rgba(248,81,73,0.35)';
          cautionBgColor = 'rgba(248,81,73,0.1)';
          cautionDotColor = '#f85149';
        } else if (hasSignature) {
          iconEmoji = '\u26A0\uFE0F';
          title = 'Untrusted App — Unknown Publisher';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} is signed, but the signer is not in NovaByte OS's trust store.
            This usually means the app is self-signed by an individual developer, or signed by an authority that hasn't been reviewed and added to the system trust list.`;
          cautionTitle = 'What this means';
          cautionText = `NovaByte OS cannot confirm the identity of the publisher or guarantee that the package has not been modified since it was signed. This doesn't prove the app is malicious — it just means nobody vetted the publisher on your behalf. Proceed only if you obtained the package directly from a developer or source you personally trust.`;
          cautionBorderColor = 'rgba(210,153,34,0.3)';
          cautionBgColor = 'rgba(210,153,34,0.08)';
          cautionDotColor = '#d29922';
        } else {
          iconEmoji = '\u26A0\uFE0F';
          title = 'Untrusted App — Not Signed';
          summary = `<b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} is not digitally signed.
            NovaByte OS cannot verify who created the package, when it was built, or whether it has been altered since distribution.`;
          cautionTitle = 'What this means';
          cautionText = 'An unsigned package provides no cryptographic proof of origin. Anyone could have created or modified it. Only proceed if you inspected the package yourself and trust its source completely.';
          cautionBorderColor = 'rgba(210,153,34,0.25)';
          cautionBgColor = 'rgba(210,153,34,0.06)';
          cautionDotColor = '#d29922';
        }

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid ${cautionBorderColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">${iconEmoji}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">${title}</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">${summary}</div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:${cautionBgColor};border:1px solid ${cautionBorderColor};border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:${cautionDotColor};flex-shrink:0;margin-top:7px;box-shadow:0 0 6px ${cautionDotColor};"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">${cautionTitle}</div>
                ${cautionText}
              </div>
            </div>

            <div id="nb-untrusted-more" style="display:none;padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;animation:nb-fade-in 150ms ease-out;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">${isRevoked ? 'present, but revoked by NovaByte OS' : hasSignature ? 'present, but not from a recognised signer' : 'none — package is not signed'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:${integrityColor};text-align:right;">${integrityLabel}</span></div>
                ${isRevoked ? '<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Revocation reason</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;">Removed from trust list by NovaByte OS</span></div>' : ''}
              </div>
              <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));font-size:12px;color:var(--text-muted,#999);line-height:1.6;">
                Only install or run apps obtained from sources you trust. A missing or unrecognised signature means NovaByte OS cannot confirm who published this app or guarantee it has not been modified since distribution.${isRevoked ? ' A revoked signature means NovaByte OS reviewed this package and explicitly decided it should no longer be trusted — installing it overrides that decision.' : ''} If you do not trust the source, cancel this operation and remove the package.
              </div>
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <button id="nb-untrusted-more-btn" style="background:none;border:1px solid var(--border,#444);color:var(--text-muted,#ccc);padding:7px 14px;border-radius:7px;font-size:12px;cursor:pointer;transition:all 0.12s;font-weight:500;">More Info</button>
            <div style="display:flex;gap:8px;">
              <button id="nb-untrusted-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
              <button id="nb-untrusted-launch-btn" style="display:none;background:rgba(248,81,73,0.15);border:1px solid ${isRevoked ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.3)'};color:#f85149;padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:${isRevoked ? 700 : 600};">${isRevoked ? 'Install Despite Revocation' : 'Install Anyway'}</button>
            </div>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-untrusted-more-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-untrusted-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-untrusted-launch-btn:hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-untrusted-launch-btn:active { transform:scale(0.97); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        box.querySelector('#nb-untrusted-more-btn').addEventListener('click', () => {
          const panel = box.querySelector('#nb-untrusted-more');
          const isHidden = panel.style.display === 'none';
          panel.style.display = isHidden ? 'block' : 'none';
          box.querySelector('#nb-untrusted-more-btn').textContent = isHidden ? 'Less Info' : 'More Info';
          box.querySelector('#nb-untrusted-launch-btn').style.display = isHidden ? 'inline-block' : 'none';
        });
        box.querySelector('#nb-untrusted-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        box.querySelector('#nb-untrusted-launch-btn').addEventListener('click', () => {
          cleanup();
          if (typeof onLaunchAnyway === 'function') onLaunchAnyway();
          resolve(true);
        });

        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) {
            cleanup();
            resolve(false);
          }
        });
      });
    }

    // ── Tamper-detected dialog ────────────────────────────────────────
    // Shown when AppPackage.verifyIntegrity() fails — i.e. the package's
    // contents no longer match the BLAKE3/SHA hash that was embedded at
    // build time. This is a DIFFERENT risk from showUntrustedAppDialog:
    // that dialog answers "do we know who signed this?", this one answers
    // "does the content match what was signed?". A package can be validly
    // signed by a fully trusted publisher and still fail this check if it
    // was corrupted or altered after signing — so a trusted signer does
    // NOT make this warning go away, and the two dialogs are intentionally
    // not merged.
    //
    // Because this indicates the file itself may have been altered
    // (rather than just "nobody vouched for the publisher"), there is no
    // one-click "Install Anyway" to match showUntrustedAppDialog's pattern.
    // Proceeding requires typing a confirmation phrase — friction that's
    // proportionate to "this specific file may not be what it claims to be."
    function showTamperDetectedDialog(appData, { mismatchedFiles = [] } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.4);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const fileList = mismatchedFiles.slice(0, 8).map(f => escapeHtml(f)).join(', ')
          + (mismatchedFiles.length > 8 ? `, and ${mismatchedFiles.length - 8} more` : '');

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">Tamper Detected — Package Modified</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} failed its integrity check.
                The package's contents no longer match the hash that was recorded when it was built. This is true regardless of whether the package is signed by a trusted publisher — a valid signature only proves who signed the <i>original</i> file, not that these are still its unmodified contents.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">Why this is serious</div>
                A mismatch here usually means the file was altered after it was packaged — by corruption in transit, or by someone modifying it deliberately. NovaByte OS cannot tell which. Installing this package means running code that is provably different from what its integrity hash says it should be.
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:#f85149;text-align:right;">\u26A0\uFE0F failed — contents do not match build-time hash</span></div>
                ${fileList ? `<div style="display:flex;flex-direction:column;gap:4px;"><span style="color:var(--text-muted,#999);">Affected file(s)</span><span style="font-weight:500;color:var(--text-primary,#eee);word-break:break-all;">${fileList}</span></div>` : ''}
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <label for="nb-tamper-confirm-input" style="font-size:12px;color:var(--text-muted,#999);">To install anyway, type <b style="color:var(--text-primary,#ddd);">install tampered</b> below:</label>
              <input id="nb-tamper-confirm-input" type="text" autocomplete="off" spellcheck="false" style="background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid var(--border,#444);border-radius:7px;padding:8px 10px;font-size:12.5px;color:var(--text-primary,#eee);font-family:inherit;outline:none;" placeholder="install tampered" />
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-tamper-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
            <button id="nb-tamper-install-btn" disabled style="background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.25);color:rgba(248,81,73,0.5);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:not-allowed;transition:all 0.12s;font-weight:700;">Install Despite Tampering</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-tamper-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-tamper-install-btn:not(:disabled):hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-tamper-install-btn:not(:disabled):active { transform:scale(0.97); }
          #nb-tamper-confirm-input:focus { border-color:rgba(248,81,73,0.5); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        const input = box.querySelector('#nb-tamper-confirm-input');
        const installBtn = box.querySelector('#nb-tamper-install-btn');
        input.addEventListener('input', () => {
          const match = input.value.trim().toLowerCase() === 'install tampered';
          installBtn.disabled = !match;
          installBtn.style.cursor = match ? 'pointer' : 'not-allowed';
          installBtn.style.color = match ? '#f85149' : 'rgba(248,81,73,0.5)';
          installBtn.style.borderColor = match ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.25)';
        });

        box.querySelector('#nb-tamper-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        installBtn.addEventListener('click', () => {
          if (installBtn.disabled) return;
          cleanup();
          resolve(true);
        });
      });
    }

    // ── Malicious file dialog ──────────────────────────────────────────
    // Shown when Scanner.scanText() flags a file inside a .novaapp package
    // during install. Deliberately NOT the same shape as the trust/tamper
    // dialogs above: those are "proceed at your own risk" gates with a
    // type-to-confirm override, because a valid-but-untrusted signature or
    // a hash mismatch is ambiguous — it could be a legitimate publishing
    // mistake. A Scanner hit is not ambiguous in the same way: it means a
    // file inside the package matched a known-bad pattern (disguised
    // executable, embedded script in a rendered file, obfuscated code,
    // packed binary masquerading as text). There's no legitimate reason
    // for that to be present, so this dialog only acknowledges and cancels
    // — no path to install anyway.
    function showMaliciousFileDialog(appData, { fileName, reason } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.5);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.04) inset,0 0 40px rgba(248,81,73,0.08);animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData?.name || appData?.id || 'This app');
        const safeId = escapeHtml(appData?.id || '');
        const safeFile = escapeHtml(fileName || 'a file in this package');
        const safeReason = escapeHtml(reason || 'It matched a pattern associated with malicious files.');

        box.innerHTML = `
          <div style="padding:20px 24px 16px;background:linear-gradient(180deg,rgba(248,81,73,0.12),transparent);border-bottom:1px solid rgba(248,81,73,0.25);display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.5);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:#f85149;margin-bottom:5px;letter-spacing:-0.01em;">Malicious File</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} was blocked before install. This application may cause damage to your device, steal data, or behave in ways you didn't authorize — installation cannot continue.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
              <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
              <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">What was found</div>
                <span style="color:var(--text-primary,#eee);font-weight:500;">${safeFile}</span> — ${safeReason}
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.55;">
                This scan is a heuristic check, not a full antivirus — it looks for known red flags like disguised executables, hidden scripts inside files that shouldn't have any, and obfuscated or packed code. A block here means something concrete tripped that check. If you trust the source and believe this is a false positive, get an updated package from the publisher rather than forcing this one through — NovaByte OS won't install a file that fails this check.
              </div>
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-malware-ok-btn" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.5);color:#f85149;padding:7px 18px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:700;">Cancel Install</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-malware-ok-btn:hover { background:rgba(248,81,73,0.28);border-color:rgba(248,81,73,0.7);box-shadow:0 0 14px rgba(248,81,73,0.2); }
          #nb-malware-ok-btn:active { transform:scale(0.97); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        box.querySelector('#nb-malware-ok-btn').addEventListener('click', () => {
          cleanup();
          resolve();
        });
      });
    }

    // ── Combined trust + integrity dialog ─────────────────────────────
    // Used ONLY when BOTH checks fail at once — i.e. exactly the 3 real
    // combos: unsigned+tampered, untrusted-signer+tampered, revoked+tampered.
    // (verified+tampered has no trust problem, so it still uses the plain
    // showTamperDetectedDialog alone — no combo needed there.)
    // This is a single popup with two distinct labeled sections (trust
    // issue, then integrity issue) rather than two dialogs chained, and
    // rather than one blended paragraph — the two questions ("who signed
    // this?" and "does it match what was signed?") stay visually separate
    // so neither reads as explaining away the other. Always requires
    // typing "install tampered" to proceed, same bar as tamper alone,
    // since tampering is present in every case this dialog covers.
    function showCombinedTrustIntegrityDialog(appData, { mismatchedFiles = [] } = {}) {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:nb-fade-in 180ms ease-out;';

        const box = document.createElement('div');
        box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid rgba(248,81,73,0.4);border-radius:14px;max-width:540px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.55),0 0 0 1px rgba(255,255,255,0.04) inset;animation:nb-slide-up 220ms cubic-bezier(0.16,1,0.3,1);';

        const safeName = escapeHtml(appData.name || appData.id || 'This app');
        const safeId = escapeHtml(appData.id || '');
        const safeVersion = escapeHtml(appData.version || 'unknown');
        const isRevoked = !!appData.revoked;
        const hasSignature = !!appData.signature;
        const fileList = mismatchedFiles.slice(0, 8).map(f => escapeHtml(f)).join(', ')
          + (mismatchedFiles.length > 8 ? `, and ${mismatchedFiles.length - 8} more` : '');

        // Same 3-way trust sub-state branch as showUntrustedAppDialog,
        // reused here for the top section's copy only.
        let trustTitle, trustSummary, trustSignatureLabel;
        if (isRevoked) {
          trustTitle = 'Revoked Signature';
          trustSummary = `This package's signature was individually revoked by NovaByte OS — it was previously trusted, but has since been pulled from the trust list, most likely because it was found to be harmful, deceptive, or non-compliant after review.`;
          trustSignatureLabel = 'present, but revoked by NovaByte OS';
        } else if (hasSignature) {
          trustTitle = 'Unknown Publisher';
          trustSummary = `This package is signed, but the signer is not in NovaByte OS's trust store. NovaByte OS cannot confirm the identity of the publisher.`;
          trustSignatureLabel = 'present, but not from a recognised signer';
        } else {
          trustTitle = 'Not Signed';
          trustSummary = `This package is not digitally signed. NovaByte OS cannot verify who created it or whether it has been altered since distribution.`;
          trustSignatureLabel = 'none — package is not signed';
        }

        box.innerHTML = `
          <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">Two Problems Found — ${escapeHtml(trustTitle)} &amp; Tamper Detected</div>
              <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
                <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} failed two independent checks: NovaByte OS cannot confirm who published it, <i>and</i> its contents no longer match the hash recorded at build time. These are separate risks — either one alone would be worth pausing on; together, proceed only if you're certain of both the source and the copy you have.
              </div>
            </div>
          </div>

          <div style="padding:16px 24px;display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto;">
            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);">Trust issue — ${escapeHtml(trustTitle)}</div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(210,153,34,0.08);border:1px solid rgba(210,153,34,0.3);border-radius:8px;">
                <div style="width:6px;height:6px;border-radius:50%;background:#d29922;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #d29922;"></div>
                <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">${trustSummary}</div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);">Integrity issue — Tamper Detected</div>
              <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:8px;">
                <div style="width:6px;height:6px;border-radius:50%;background:#f85149;flex-shrink:0;margin-top:7px;box-shadow:0 0 6px #f85149;"></div>
                <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
                  The package's contents no longer match the hash recorded when it was built. This is true regardless of who signed it — a valid signature only proves who signed the <i>original</i> file, not that these are still its unmodified contents.
                </div>
              </div>
            </div>

            <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted,#999);margin-bottom:10px;">Package Details</div>
              <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">${trustSignatureLabel}</span></div>
                <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Integrity</span><span style="font-weight:500;color:#f85149;text-align:right;">\u26A0\uFE0F failed — contents do not match build-time hash</span></div>
                ${fileList ? `<div style="display:flex;flex-direction:column;gap:4px;"><span style="color:var(--text-muted,#999);">Affected file(s)</span><span style="font-weight:500;color:var(--text-primary,#eee);word-break:break-all;">${fileList}</span></div>` : ''}
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <label for="nb-combo-confirm-input" style="font-size:12px;color:var(--text-muted,#999);">To install anyway, type <b style="color:var(--text-primary,#ddd);">install tampered</b> below:</label>
              <input id="nb-combo-confirm-input" type="text" autocomplete="off" spellcheck="false" style="background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid var(--border,#444);border-radius:7px;padding:8px 10px;font-size:12.5px;color:var(--text-primary,#eee);font-family:inherit;outline:none;" placeholder="install tampered" />
            </div>
          </div>

          <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <button id="nb-combo-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
            <button id="nb-combo-install-btn" disabled style="background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.25);color:rgba(248,81,73,0.5);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:not-allowed;transition:all 0.12s;font-weight:700;">Install Despite Both</button>
          </div>
        `;

        const styleEl = document.createElement('style');
        styleEl.textContent = `
          @keyframes nb-fade-in { from { opacity: 0; } to { opacity: 1; } }
          @keyframes nb-slide-up { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
          #nb-combo-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
          #nb-combo-install-btn:not(:disabled):hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
          #nb-combo-install-btn:not(:disabled):active { transform:scale(0.97); }
          #nb-combo-confirm-input:focus { border-color:rgba(248,81,73,0.5); }
        `;
        document.head.appendChild(styleEl);

        overlay.appendChild(backdrop);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => {
          overlay.remove();
          styleEl.remove();
        };

        const input = box.querySelector('#nb-combo-confirm-input');
        const installBtn = box.querySelector('#nb-combo-install-btn');
        input.addEventListener('input', () => {
          const match = input.value.trim().toLowerCase() === 'install tampered';
          installBtn.disabled = !match;
          installBtn.style.cursor = match ? 'pointer' : 'not-allowed';
          installBtn.style.color = match ? '#f85149' : 'rgba(248,81,73,0.5)';
          installBtn.style.borderColor = match ? 'rgba(248,81,73,0.4)' : 'rgba(248,81,73,0.25)';
        });

        box.querySelector('#nb-combo-cancel-btn').addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        installBtn.addEventListener('click', () => {
          if (installBtn.disabled) return;
          cleanup();
          resolve(true);
        });

        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) {
            cleanup();
            resolve(false);
          }
        });
      });
    }
    function buildNovaAppConfig(appData) {
      const appId = appData.id;
      console.log('[AppManager][DIAG] launch appId=', JSON.stringify(appId), 'partition=', 'persist:app_' + appId);

      return {
        id: appId,
        name: appData.name,
        icon: appData.icon || '/assets/no_app_icon.svg',
        description: appData.description || '',
        defaultSize: appData.defaultSize || [800, 560],
        minSize: appData.minSize || [400, 300],
        minSecurityPatch: appData.minSecurityPatch || null,
        permissions: appData.permissions || [],
        optionalPermissions: appData.optionalPermissions || [],
        entry: appData.entry || 'index.html',
        files: appData.files || {},
        sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
        type: appData.type || 'package',
        resizable: appData.resizable !== false,
        transparent: !!appData.transparent,
        alwaysOnTop: !!appData.alwaysOnTop,
        startMinimized: !!appData.startMinimized,
        frame: appData.frame !== false,

        async init(contentEl, state, options) {
          // Scoped to this one launch — see the header comment above for
          // why this replaced the old per-window `ac` from init(content).
          const ac = new AbortController();
          try { await window.AppDirs?.ensureAppDataFolder?.(appId); } catch (_e) { /* best-effort */ }
          console.log('[AM.init]', appId, 'AppSandbox?', typeof AppSandbox, 'FrameSecurity?', typeof FrameSecurity);

          // ── Permission gate (parent-side, before iframe loads) ──
          // Matches the pattern already used for built-in apps (see
          // app-permissions-bootstrap.js's _wrapAppInit): prompt for any
          // missing permission so the user's decision gets recorded, but
          // never block the app from launching on a denial. A denied
          // permission just means that specific capability fails
          // gracefully at call time — every host-side handler already
          // checks AppPermissionManager.isGranted() before acting and
          // returns PERMISSION_DENIED if not, so there's nothing left
          // for this gate to protect by refusing to launch at all.
          //
          // This previously called requestAll() and refused to launch the
          // app if any permission — required or optional — came back
          // denied, which meant denying even one optional permission
          // (e.g. notifications) made the entire app unusable rather than
          // just disabling that one feature.
          const requiredPerms = appData.permissions || [];
          const optionalPerms = appData.optionalPermissions || [];
          const allDangerous = [...requiredPerms, ...optionalPerms];

          if (allDangerous.length > 0 && typeof AppPermissionManager !== 'undefined') {
            const mgr = AppPermissionManager;
            const missing = allDangerous.filter(p => !mgr.isGranted(p, appId) && !(mgr.isDenied && mgr.isDenied(p, appId)));
            if (missing.length > 0) {
              await mgr.requestAll(missing, appId, appData.name || appId);
            }
          }

          if (typeof AppSandbox !== 'undefined' && typeof AppSandbox.launch === 'function') {
            const sandboxApp = {
              id: appId,
              name: appData.name,
              entry: appData.entry || 'index.html',
              files: appData.files || {},
              sandbox: appData.sandbox || { allowScripts: true, allowForms: true, allowPopups: false },
              permissions: appData.permissions || [],
              optionalPermissions: appData.optionalPermissions || [],
              type: appData.type || 'package',
              // Manifest opt-in for nested <webview> creation — see
              // isNestedWebviewPermitted() in app-sandbox.js. Must also hold
              // the 'sandbox:nested-webview' grant; this alone doesn't enable it.
              allowNestedWebview: appData.allowNestedWebview === true,
            };
            return AppSandbox.launch(sandboxApp, contentEl, state || {}, options || {});
          }

          // ── Private data shim injected into iframe ────────────
          const vfsDir = (() => { try { return window.AppDirs?.getVFSDir?.(appId, 'files'); } catch { return null; } })();
          const safeAppId = JSON.stringify(appId);
          const safeVfsDir = JSON.stringify(vfsDir);

          const bridgeScript = `(function(){
            try{
              if(!window.__novaPrivateStore) window.__novaPrivateStore={};
              var s=window.__novaPrivateStore;
              s.appId=${safeAppId};
              s.vfsDir=${safeVfsDir};
              s.getVFSDir=function(){return ${safeVfsDir}};
              s.lsKey=function(k){return'nova_app_'+${safeAppId}+'_'+k};
              s.get=function(k){try{var v=localStorage.getItem(this.lsKey(k));return v?JSON.parse(v):null}catch{return null}};
              s.set=function(k,v){try{localStorage.setItem(this.lsKey(k),JSON.stringify(v))}catch{/*quota*/}};
              s.del=function(k){localStorage.removeItem(this.lsKey(k))};
            }catch(e){console.warn('[NovaAppBridge] init failed:',e)}
          })();`;

          const bridgeStyle = '<style>#nv-bridge-shim{display:none}</style>';
          const bridgeScriptTag = '<script id="nv-bridge-shim">' + bridgeScript + '<\/script>';

          const entryKey = appData.entry || 'index.html';
          const entryB64 = appData.files?.[entryKey];

          if (!entryB64) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>';
            return;
          }

          // ── Blob URL tracking for memory cleanup ──
          let blobUrl = null;

          try {
            let html = decodeURIComponent(escape(atob(entryB64)));
            let pkgData = null;

            // ── SECURITY: Removed require('vm').runInThisContext() — this executes
            //    arbitrary untrusted code in the main context, equivalent to eval().
            //    Obfuscated packages that aren't valid JSON are now rejected outright. ──
            if (appData._wasObfuscated) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">\uD83D\uDD12 App blocked: obfuscated packages cannot be loaded. Install only apps from trusted sources.</div>';
                }
                console.warn('[AppManager] Obfuscated package blocked:', appId);
                return;
            }

            // Re-verify integrity at every launch, not just at install time —
            // stored files can be altered after install (storage corruption,
            // a bad sync/restore, manual tampering with installedApps), and
            // a package that was fine when installed is not guaranteed to
            // still be fine now. Mirrors the same up-front computation the
            // install path does, so both dialogs below can reflect the
            // CURRENT state rather than a stale install-time snapshot.
            let launchIntegrityStatus = 'unavailable'; // 'ok' | 'failed' | 'unavailable'
            let launchMismatchedFiles = [];
            if (appData.integrity && typeof AppPackage !== 'undefined' && typeof AppPackage.verifyIntegrity === 'function') {
                // Reconstruct the same pkg shape the install path verifies
                // against (manifest + files + signature + integrity), not a
                // narrower subset — AppPackage's internals aren't in this
                // file, so there's no way to confirm it only reads files+integrity.
                const pkgLike = { manifest: appData, files: appData.files, signature: appData.signature, integrity: appData.integrity };
                try {
                    const integrityOk = await AppPackage.verifyIntegrity(pkgLike);
                    launchIntegrityStatus = integrityOk ? 'ok' : 'failed';
                } catch (_) { launchIntegrityStatus = 'failed'; }

                if (launchIntegrityStatus === 'failed' && typeof AppPackage.computeIntegrity === 'function') {
                    try {
                        const fresh = await AppPackage.computeIntegrity(pkgLike, appData.integrity.method);
                        launchMismatchedFiles = Object.keys(appData.integrity.fileHashes || {})
                            .filter(f => fresh.fileHashes?.[f] !== appData.integrity.fileHashes[f]);
                    } catch (_) { /* best-effort only */ }
                }
            }

            // Trust and/or integrity failure gate. Four shapes possible:
            //  - both pass              -> no dialog, launches straight through
            //  - trust fails only       -> showUntrustedAppDialog alone
            //  - integrity fails only   -> showTamperDetectedDialog alone
            //  - both fail              -> showCombinedTrustIntegrityDialog
            //    (one popup, not two chained) — this is the only case that
            //    needs the combined dialog; a trusted-but-tampered app has
            //    no trust problem to combine, so it still uses tamper alone.
            const trustFailed = appData.verified === false;
            const integrityFailed = launchIntegrityStatus === 'failed';

            if (trustFailed && integrityFailed && !options?.userAllowedUnverified && !options?.userAllowedTampered) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showCombinedTrustIntegrityDialog(appData, { mismatchedFiles: launchMismatchedFiles });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedUnverified: true, userAllowedTampered: true });
            }

            // Unverified (unsigned, or signed by no one in the trust store)
            // apps now get a dialog with a real choice instead of a dead
             // end. `options.userAllowedUnverified` lets the "Install Anyway"
            // path re-enter init() without looping the dialog forever.
            // Only reached here if integrity is NOT also failing (the
            // combo case above already handled that and returned).
            if (trustFailed && !options?.userAllowedUnverified) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showUntrustedAppDialog({ ...appData, integrityStatus: launchIntegrityStatus });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                // Re-run init with the user's explicit one-time override.
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedUnverified: true });
            }

            // Tamper block — separate from signature trust, same as the
            // install path. Only reached here if trust is NOT also failing
            // (the combo case above already handled that). A trusted
            // signer does NOT skip this: trust and tamper are independent
            // axes, so it's possible to see only this dialog (trusted
            // publisher, corrupted local copy), only the one above
            // (untrusted publisher, unmodified files), the combined dialog
            // (both at once), or neither (the common case).
            if (integrityFailed && !options?.userAllowedTampered) {
                if (typeof contentEl?.innerHTML === 'string') {
                    contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"></div>';
                }
                const proceeded = await showTamperDetectedDialog(appData, { mismatchedFiles: launchMismatchedFiles });
                if (!proceeded) {
                    if (typeof contentEl?.innerHTML === 'string') {
                        contentEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-family:var(--font-ui,sans-serif);font-size:13px;">Launch cancelled.</div>';
                    }
                    return;
                }
                return buildNovaAppConfig(appData).init(contentEl, state, { ...options, userAllowedTampered: true });
            }

            if (pkgData && !appData.manifest) {
              appData.manifest = pkgData;
              appData.name = appData.name || pkgData.name || appData.id;
              appData.description = appData.description || pkgData.description || '';
              appData.icon = appData.icon || pkgData.icon || '/assets/no_app_icon.svg';
              appData.defaultSize = appData.defaultSize || pkgData.defaultSize || [800, 560];
              appData.minSize = appData.minSize || pkgData.minSize || [400, 300];
            }

            const sandboxId = 'sandbox_' + appId.replace(/\./g, '_') + '_' + Date.now();

            // ── Attempt sandboxed serve via API ──
            let serveFailed = false;
            try {
              const shimmedFiles = Object.assign({}, appData.files);
              let serveHtml = html;
              const relaxed = buildSandboxCSP(appData);
              const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
              if (!/<head[\s>]/i.test(serveHtml)) {
                serveHtml = inline + '\n' + relaxed + '\n' + serveHtml;
              } else {
                serveHtml = serveHtml.replace(/<head(\s[^>]*)?>/i, function(m){return m+"\n"+relaxed+inline});
              }
              console.log('[AppManager] shim injected, len now:', serveHtml.length, 'has shim marker:', serveHtml.includes('__novaPrivateStore'));
              shimmedFiles[entryKey] = btoa(
                encodeURIComponent(serveHtml).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
              );

              const regRes = await fetch('/api/apps/serve/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sandboxId, files: shimmedFiles })
              });

              if (regRes.ok) {
                const regData = await regRes.json();
                console.log('[AppManager] serve registered, baseUrl:', regData.baseUrl);
                // IMPORTANT: partition must be set on the <webview> BEFORE src.
                // Chromium's guest_view (shared by both Electron and NW.js
                // webviews) provisions the guest process's storage partition
                // at first-navigation time. If src is present when the
                // element is created/attached and partition is applied a
                // moment later in the same attribute pass, the guest can
                // already be resolving navigation against the default
                // ephemeral/unpartitioned session — so the attribute exists
                // in the DOM (looks correct on inspection) but never
                // actually took effect, and storage keeps resetting every
                // launch despite this code looking right. Setting partition
                // first, then src as a separate step, avoids that race.
                const webview = createEl('webview', {
                  // "persist:" + a stable per-app key reuses the same
                  // on-disk partition every launch, so app-local storage
                  // (localStorage/IndexedDB/__novaPrivateStore) actually
                  // persists like a real installed app. Keyed by appId
                  // (not sandboxId, which is intentionally unique per
                  // launch via Date.now() and would defeat this entirely)
                  // so every launch of the same app lands in the same
                  // partition.
                  partition: 'persist:app_' + appId,
                  style: 'width:100%;height:100%;border:none;display:block;'
                });

                if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
                  FrameSecurity.securifyFrame(webview);
                }

                contentEl.style.padding = '0';
                contentEl.appendChild(webview);
                // src set AFTER DOM attachment — matches browser.js's
                // getOrCreateWebview/navigate pattern (the one place in
                // this codebase where webview partitioning is confirmed to
                // actually persist). NW.js's <webview> custom element only
                // seems to fully back its guest process once connected to
                // the document; setting src pre-append can start
                // navigation against an unpartitioned session even with
                // partition already present as an attribute.
                webview.src = window.location.origin + regData.baseUrl + '/' + entryKey;

                webview.addEventListener('load', () => {
                  if (pkgData) {
                    try {
                      // SECURITY: Use specific origin instead of '*' for postMessage
                      const origin = new URL(webview.src).origin;
                      webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                    } catch (_e) { /* cross-origin — expected */ }
                  }
                }, { once: true, signal: ac.signal });

                return;
              }
              serveFailed = true;
            } catch (_regErr) {
              serveFailed = true;
            }

            // ── Fallback: inline HTML with blob URL ──
            console.log('[AppManager] serve failed, falling back to blob URL');
            let wrappedHtml = html
              .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
              .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '');

            for (const [relPath, raw] of Object.entries(appData.files)) {
              if (relPath === entryKey || !raw || typeof raw !== 'string') continue;
              const lower = relPath.toLowerCase();
              let tag = null;
              if (lower.endsWith('.css')) {
                tag = '<style data-ninline>\n' + raw + '\n</style>';
              } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
                tag = '<script data-ninline>\n' + raw + '\n<\/script>';
              }
              if (!tag) continue;
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + tag);
            }

            const relaxed = buildSandboxCSP(appData);
            const inline = '<script>(function(){var o=window.location.origin;window.nova={ipc:function(t,e){var r=new Promise(function(r,s){var a="s"+Math.random().toString(36).slice(2)+Date.now().toString(36),n=setTimeout(function(){p.has(a)&&(p.delete(a),s(TypeError("timeout "+t)))},3e4);p.set(a,{resolve:r,reject:s,timer:n}),window.parent.postMessage({type:t,requestId:a,payload:e||{}},o)});return r}};var p=new Map;window.addEventListener("message",function(t){if(t.origin!==o)return;var e=t.data;if(!e||!e.requestId)return;if(e.type==="nova:ready:response"&&e.result){var r=e.result.permissions||[];try{window.allowedPermissions=r,window.__novaPermResponse=e.result}catch(t){}}var s=p.get(e.requestId);if(!s)return;clearTimeout(s.timer),p.delete(e.requestId),e.error?s.reject(TypeError(e.error.message||String(e.error))):s.resolve(e.result)});window.__novaPrivateStore={}})<\/script>\n';
            if (!/<head[\s>]/i.test(wrappedHtml)) {
              wrappedHtml = inline + '\n' + relaxed + '\n' + wrappedHtml;
            } else {
              wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + inline);
            }
            wrappedHtml = wrappedHtml.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + bridgeScriptTag);

            const blob = new Blob([wrappedHtml], { type: 'text/html' });
            blobUrl = URL.createObjectURL(blob);
            // partition must be set before src — see the register-success
            // branch above for why (guest storage session is provisioned
            // at first navigation, not on later attribute updates).
            const webview = createEl('webview', {
              // Same persistent partition as the primary path for
              // consistency, but be aware this fallback likely still won't
              // actually persist storage: blob: URLs get a fresh unique
              // origin every single createObjectURL() call, and localStorage
              // is partitioned by origin first — the webview partition
              // controls which disk-backed session cookies/storage live
              // in, but only helps if the origin asking for that storage
              // is itself stable across launches, which a blob: URL isn't.
              // This path only runs when /api/apps/serve/register fails,
              // so it's a degraded fallback, not the persistence fix —
              // if apps are landing here regularly, that failure itself
              // is the bug to chase next.
              partition: 'persist:app_' + appId,
              style: 'width:100%;height:100%;border:none;display:block;'
            });

            if (webview.tagName !== 'WEBVIEW' && typeof FrameSecurity !== 'undefined' && typeof FrameSecurity.securifyFrame === 'function') {
              FrameSecurity.securifyFrame(webview);
            }

            contentEl.style.padding = '0';
            contentEl.appendChild(webview);
            // src set after DOM attachment — see primary path above.
            webview.src = blobUrl;

            // ── Revoke blob URL after load to free memory ──
            webview.addEventListener('load', () => {
              if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
              if (pkgData) {
                try {
                  const origin = new URL(webview.src).origin;
                  webview.contentWindow.postMessage({ type: '__nova_pkg_data', data: pkgData }, origin);
                } catch (_e) { /* cross-origin */ }
              }
            }, { once: true, signal: ac.signal });

          } catch (e) {
            contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ' + escapeHtml(e.message) + '</div>';
          }
        }
      };
    }

    // Exposed so boot.js can reuse the exact same launch logic when
    // re-registering previously-installed apps at boot time, instead of a
    // separate incomplete implementation that never carried files/entry
    // through. See the header comment above for the full story.
    window.buildNovaAppConfig = buildNovaAppConfig;
registerApp({
  id: 'app-manager',
  name: 'App Manager',
  version: '3.0.2',
  icon: 'package',
  description: 'Install, manage, and customise .novaapp packages and web apps',
  defaultSize: [980, 640],
  minSize: [720, 480],
  // Routes a dropped file straight into the install flow, no matter which
  // tab/view is currently showing. Without this, only the empty-state drop
  // zone inside renderDetail() could catch a drop — anywhere else in the
  // window, the window manager's generic content-level drop handler would
  // take over instead (since no onDrop meant "no app-specific handling"),
  // silently writing the .novaapp file into the Files vault and opening it
  // there rather than installing it.
  async onDrop(file, state) {
    if (!file || typeof file.name !== 'string') return;
    if (!file.name.endsWith('.novaapp')) {
      Notify.show({ title: 'Invalid File', body: 'Please select a valid .novaapp package.', type: 'error', appName: 'App Manager' });
      return;
    }
    const processFile = state?.content?._novaAppProcessFile;
    if (typeof processFile === 'function') {
      processFile(file);
    } else {
      // App Manager window isn't fully initialized yet (rare timing edge,
      // e.g. dropping mid-boot) — fail loudly rather than silently no-op.
      Notify.show({ title: 'Not Ready', body: 'App Manager is still loading — try the drop again in a moment.', type: 'error', appName: 'App Manager' });
    }
  },
  async init(content) {
    // ── NovaByte runtime guard — refuses to launch without AppDirs ──
    if (!window.AppDirs?.getVFSDir('com.nbosp.appmanager', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">\u26A0\uFE0F</div><div style="font-size:14px;text-align:center"><b>com.nbosp.appmanager</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    const APPS_KEY = 'nova_installed_apps';
    const LOG_KEY = 'nova_appmanager_log';

    // ── AbortController for clean teardown of all listeners ──
    const ac = new AbortController();
    const listenerOpts = { signal: ac.signal };

    // ── Helpers ────────────────────────────────────────────────────
    const PackageStore = window.NovaAppPackageStore || null;

    // Builds the CSP injected into sandboxed app HTML. Only the webapp
    // template needs frame-src — everything else gets none, since no other
    // template embeds external content. We validate appData.url rather than
    // trusting it outright: it's written by the app's own creator (or by
    // hand-editing manifest.json), not vetted, so a malformed or javascript:
    // value here must not end up unescaped inside an HTML attribute.

    function resolveIcon(app) {
      if (!app?.icon || typeof app.icon !== 'string') return null;
      if (/^data:|^https?:\/\//i.test(app.icon)) return app.icon;
      const files = app.files || app._files || {};
      const encoded = files[app.icon];
      if (encoded && typeof encoded === 'string') {
        const ext = (app.icon.split('.').pop() || '').toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'ico' ? 'image/x-icon'
          : 'image/png';
        return `data:${mime};base64,${encoded}`;
      }
      return null;
    }

    async function getStoredApps() {
      try {
        const list = PackageStore?.loadRegistry
          ? PackageStore.loadRegistry()
          : JSON.parse(localStorage.getItem(APPS_KEY) || '[]');
        return PackageStore?.hydrateApps ? await PackageStore.hydrateApps(list) : list;
      } catch (e) {
        console.warn('[AppManager] Failed to load installed packages:', e);
        return [];
      }
    }

    function saveStoredApps(list) {
      try {
        if (PackageStore?.saveRegistry) {
          PackageStore.saveRegistry(list);
        } else {
          localStorage.setItem(APPS_KEY, JSON.stringify(list));
        }
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
          console.warn('[AppManager] localStorage quota exceeded while saving app metadata.');
        } else {
          console.warn('[AppManager] Failed to save installed app metadata:', e);
        }
      }
    }

    function getLog() {
      try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); }
      catch { return []; }
    }

    function pushLog(entry) {
      const log = getLog();
      log.unshift({ ...entry, ts: Date.now() });
      if (log.length > 200) log.length = 200;
      try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }
      catch { /* quota — discard oldest silently */ }
    }

    function getPinned() { return OS.settings.get('pinnedApps') || []; }
    function getDisabled() {
      try {
        const raw = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
        return raw.map(x => typeof x === 'string' ? x : x?.id).filter(Boolean);
      }
      catch { return []; }
    }
    function setDisabled(list) {
      try { localStorage.setItem('nova_disabled_apps', JSON.stringify(list)); }
      catch { /* quota */ }
    }
    function getBootApps() {
      try { return JSON.parse(localStorage.getItem('nova_boot_apps') || '[]'); }
      catch { return []; }
    }
    function setBootApps(list) {
      try { localStorage.setItem('nova_boot_apps', JSON.stringify(list)); }
      catch { /* quota */ }
    }


    // ── URL host extraction (cached per URL string) ──
    const hostCache = new Map();
    function extractHost(urlStr) {
      if (hostCache.has(urlStr)) return hostCache.get(urlStr);
      let host = urlStr;
      try { host = new URL(urlStr).host; } catch { /* not a valid URL */ }
      hostCache.set(urlStr, host);
      return host;
    }

    // ── Debounced search input ──
    function debounce(fn, ms) {
      let timer = 0;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
      };
    }

    // ── Untrusted-app dialog ──────────────────────────────────────────
    // Shown whenever a package's signature doesn't match any entry in
    // TrustStore. Replaces the old hard block that just printed a static
    // "blocked" message with no way forward — the user should be able to
    // see *why* it's untrusted and still choose to run it if they want,
    // the same way browsers let you click through an unknown-publisher
    // warning rather than refusing outright.
    //
    // trust-store.js defines three distinct untrusted states:
    //   1. No signature at all            → unsigned package
    //   2. Signature from unknown pub      → not in trust store
    //   3. Revoked signature               → cryptographically valid but individually pulled
    // This dialog surfaces each state accurately so the user can make an
    // informed decision rather than seeing a single generic warning.


    function registerNovaApp(appData) {
      if (!appData?.files) {
        console.warn('[AppManager] Package files missing for', appData?.id, '- app was not registered');
        return;
      }

      if (appData.icon && !/^data:|^https?:\/\//i.test(appData.icon) && appData.files[appData.icon]) {
        const encoded = appData.files[appData.icon];
        const ext = (appData.icon.split('.').pop() || '').toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'ico' ? 'image/x-icon'
          : 'image/png';
        appData = { ...appData, icon: `data:${mime};base64,${encoded}` };
      }

      const cfg = buildNovaAppConfig(appData);
      OS.apps[appData.id] = cfg;
      const ri = APP_REGISTRY.findIndex(a => a.id === appData.id);
      if (ri > -1) APP_REGISTRY[ri] = cfg;
      else APP_REGISTRY.push(cfg);
    }

    let installedApps = await getStoredApps();
    installedApps.forEach(a => registerNovaApp(a));

    let lastInstalledSignature = computeInstalledSignature();

    function computeInstalledSignature() {
      try {
        const list = PackageStore?.loadRegistry
          ? PackageStore.loadRegistry()
          : JSON.parse(localStorage.getItem(APPS_KEY) || '[]');
        return list.map(a => a.id + ':' + (a.version || '')).sort().join('|');
      } catch {
        return '';
      }
    }

    async function syncInstalledApps() {
      const sig = computeInstalledSignature();
      if (sig === lastInstalledSignature) return;
      lastInstalledSignature = sig;

      const fresh = await getStoredApps();
      const oldById = new Map(installedApps.map(a => [a.id, a]));
      const newById = new Map(fresh.map(a => [a.id, a]));

      for (const app of fresh) {
        const prev = oldById.get(app.id);
        if (!prev || prev.version !== app.version) {
          registerNovaApp(app);
        }
      }

      installedApps = fresh;
      if (selectedPkgId && !newById.has(selectedPkgId)) {
        selectedPkgId = null;
      }
      if (typeof renderList === 'function') renderList();
      if (typeof renderDetail === 'function') renderDetail();
    }

    window.addEventListener('storage', e => {
      if (e.key === APPS_KEY) syncInstalledApps();
    });

    setInterval(syncInstalledApps, 2000);

    // ── Shared state ───────────────────────────────────────────────
    let activeTab = 'packages';
    let selectedPkgId = null;

    // ── Root layout ────────────────────────────────────────────────
    content.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;height:100%;';

    // ── Tab bar ────────────────────────────────────────────────────
    const tabBar = createEl('div', {
      style: 'display:flex;align-items:center;gap:2px;padding:10px 14px 0;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
    });

    const TABS = [
      { id: 'packages', label: 'Packages', icon: 'package' },
      { id: 'webapps', label: 'Web Apps', icon: 'globe' }
    ];
    const tabBtns = {};

    TABS.forEach(t => {
      const btn = createEl('button', {
        style: 'display:flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:10px 10px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.12s;background:none;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-1px;'
      });
      btn.innerHTML = svgIcon(t.icon, 13) + ' ' + t.label;
      btn.dataset.tab = t.id;
      btn.addEventListener('click', () => switchTab(t.id), listenerOpts);
      tabBar.appendChild(btn);
      tabBtns[t.id] = btn;
    });
    content.appendChild(tabBar);

    function refreshTabStyles() {
      for (const btn of Object.values(tabBtns)) {
        const active = btn.dataset.tab === activeTab;
        btn.style.color = active ? 'var(--text-primary)' : 'var(--text-muted)';
        btn.style.background = active ? 'var(--bg-elevated)' : 'none';
        btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
      }
    }

    const body = createEl('div', { style: 'flex:1;display:flex;overflow:hidden;' });
    content.appendChild(body);

    function switchTab(id) {
      activeTab = id;
      refreshTabStyles();
      body.innerHTML = '';
      if (id === 'packages') renderPackagesPanel();
      else renderWebAppsPanel();
    }

    // ══════════════════════════════════════════════════════════════
    // PACKAGES PANEL
    // ══════════════════════════════════════════════════════════════
    function renderPackagesPanel() {
      const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

      // ── Sidebar ────────────────────────────────────────────────
      const sidebar = createEl('div', {
        style: 'width:300px;min-width:260px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
      });

      // Toolbar: search + install
      const toolbar = createEl('div', { style: 'padding:10px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
      const searchEl = createEl('input', {
        type: 'text', id: 'app-installer-search-input', name: 'app-installer-search',
        placeholder: 'Search\u2026',
        style: 'flex:1;padding:5px 9px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;'
      });
      const installBtn = createEl('button', {
        style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;'
      });
      installBtn.innerHTML = svgIcon('plus', 12) + ' Install';
      toolbar.append(searchEl, installBtn);
      sidebar.appendChild(toolbar);

      const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:6px;' });
      sidebar.appendChild(listEl);

      // ── Detail panel ───────────────────────────────────────────
      const detail = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

      // Hidden file input
      const fileInput = createEl('input', {
        type: 'file', accept: '.novaapp', id: 'app-install-input', name: 'app-install', style: 'display:none;'
      });
      fileInput.addEventListener('change', e => {
        if (e.target.files[0]) processFile(e.target.files[0]);
        fileInput.value = '';
      }, listenerOpts);
      root.appendChild(fileInput);
      installBtn.addEventListener('click', () => fileInput.click(), listenerOpts);

      // ── Use disabled Set for O(1) lookups instead of Array.includes ──
      // ── Verification badge ──────────────────────────────────────────────
      // Reads app.verified/app.signer/app.revoked. verified/signer are set
      // once at install time from AppPackage.verifyAgainstTrustStore's
      // result (see processFile) and never re-derived here. revoked,
      // however, CAN change after install — see boot.js's post-install
      // revocation scan, which flags app.revoked = true on restart if
      // NovaByte pulls a signature after the app was already installed.
      // That scan deliberately does NOT flip app.verified back to false
      // (verified reflects what was true when installed, revoked reflects
      // current trust status), so this badge must check revoked FIRST —
      // otherwise a revoked app keeps showing "✓ Verified" forever, which
      // would flatly contradict the revocation warning the user already
      // saw on boot.
      function verifyBadgeHtml(app, { compact } = {}) {
        const size = compact ? '9px' : '10px';
        const pad = compact ? '1px 6px' : '2px 7px';
        const badges = [];
        if (app.tampered) {
          badges.push(`<span title="Files no longer match what was signed — this app may have been modified since install" style="display:inline-flex;align-items:center;gap:3px;font-size:${size};font-weight:700;color:var(--text-danger,#f85149);background:rgba(248,81,73,0.12);padding:${pad};border-radius:5px;white-space:nowrap;">\u26A0\uFE0F Tampered</span>`);
        }
        if (app.revoked) {
          badges.push(`<span title="Signature revoked by NovaByte OS — this app is no longer trusted" style="display:inline-flex;align-items:center;gap:3px;font-size:${size};font-weight:700;color:var(--text-danger,#f85149);background:rgba(248,81,73,0.12);padding:${pad};border-radius:5px;white-space:nowrap;">\u2715 Revoked</span>`);
        }
        if (app.verified && !app.revoked) {
          badges.push(`<span title="${escapeHtml('Signed by ' + (app.signer || 'a trusted signer'))}" style="display:inline-flex;align-items:center;gap:3px;font-size:${size};font-weight:600;color:var(--text-success,#3fb950);background:var(--bg-success-muted,rgba(63,185,80,0.12));padding:${pad};border-radius:5px;white-space:nowrap;">\u2713 Verified</span>`);
        } else if (!app.revoked) {
          // Not verified and not revoked (revoked already implies "not a
          // trusted signer" via its own pill above, so don't also stack
          // "Unverified" on top of "Revoked" — that'd be saying the same
          // thing twice). This has to be an explicit check, not a
          // badges.length===0 fallback: tampered is independent of trust
          // status, so a tampered+unverified app must show BOTH, and a
          // length-based fallback would never fire once tampered pushed
          // something into the array first.
          badges.push(`<span title="Not signed by a trusted signer" style="display:inline-flex;align-items:center;gap:3px;font-size:${size};font-weight:600;color:var(--text-muted,#999);background:var(--bg-inset,rgba(255,255,255,0.06));padding:${pad};border-radius:5px;white-space:nowrap;">\u26A0 Unverified</span>`);
        } else {
          // Revoked, and this WAS verified at install time (app.verified
          // is still true underneath — see the comment above this
          // function: revoked deliberately doesn't flip verified back to
          // false, since verified is a historical record of install-time
          // trust). But the badge is about CURRENT trust status, not
          // history, so a revoked signer shows as Unverified here even
          // though the underlying data still remembers it was once
          // legitimately signed.
          badges.push(`<span title="Signature revoked — no longer treated as a trusted signer" style="display:inline-flex;align-items:center;gap:3px;font-size:${size};font-weight:600;color:var(--text-muted,#999);background:var(--bg-inset,rgba(255,255,255,0.06));padding:${pad};border-radius:5px;white-space:nowrap;">\u26A0 Unverified</span>`);
        }
        return badges.join(compact ? '' : ' ');
      }

      function renderList() {
        listEl.innerHTML = '';
        const q = searchEl.value.trim().toLowerCase();
        const disabledSet = new Set(getDisabled());
        let visible = installedApps;

        if (q) {
          visible = visible.filter(a =>
            a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
          );
        }

        // Sort only visible items (not the source array)
        const sorted = [...visible].sort((a, b) => a.name.localeCompare(b.name));

        if (!sorted.length) {
          const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.8;' });
          msg.innerHTML = q
            ? '<div style="font-size:13px;">No apps match.</div>'
            : '<div style="font-size:32px;margin-bottom:10px;">\uD83D\uDCE6</div><div style="font-size:12px;">No packages installed.<br>Click <strong style="color:var(--text-primary);">Install</strong> or drop a <code style="color:var(--accent);">.novaapp</code> file.</div>';
          listEl.appendChild(msg);
          return;
        }

        // ── Build list with DocumentFragment for batch DOM write ──
        const fragment = document.createDocumentFragment();

        sorted.forEach(app => {
          const isSel = app.id === selectedPkgId;
          const isDis = disabledSet.has(app.id);
          const item = createEl('div', {
            style: `display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}`
          });
          const iconWrap = createEl('div', {
            style: `width:34px;height:34px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};`
          });
          const iconSrc = resolveIcon(app);
          if (iconSrc) {
            const _img = createEl('img', { src: iconSrc, draggable: 'false', style: 'width:100%;height:100%;object-fit:cover;border-radius:8px;pointer-events:none;' });
            _img.onerror = () => { iconWrap.innerHTML = svgIcon('/assets/no_app_icon.svg', 17); };
            iconWrap.appendChild(_img);
          } else {
            iconWrap.innerHTML = svgIcon(app.icon || '/assets/no_app_icon.svg', 17);
          }
          const meta = createEl('div', { style: 'flex:1;min-width:0;' });
          // SECURITY: Use escapeHtml for user-controlled app.name
          meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${isDis ? 'var(--text-muted)' : 'var(--text-primary)'};">${escapeHtml(app.name)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:5px;">v${escapeHtml(app.version || '1.0.0')}${isDis ? ' \u00B7 disabled' : ''} ${verifyBadgeHtml(app, { compact: true })}</div>`;
          item.append(iconWrap, meta);

          item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; }, listenerOpts);
          item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; }, listenerOpts);
          item.addEventListener('click', () => { selectedPkgId = app.id; renderList(); renderDetail(); }, listenerOpts);

          fragment.appendChild(item);
        });

        listEl.appendChild(fragment);
      }

      function renderDetail() {
        detail.innerHTML = '';
        const app = installedApps.find(a => a.id === selectedPkgId);

        if (!app) {
          const drop = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text-muted);padding:40px;' });
          const dropBox = createEl('div', { style: 'width:110px;height:110px;border:2px dashed var(--border-default);border-radius:24px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;' });
          dropBox.innerHTML = svgIcon('package', 44);
          const dropLabel = createEl('div', { style: 'text-align:center;line-height:1.9;' });
          dropLabel.innerHTML = '<div style="font-size:16px;font-weight:600;color:var(--text-secondary);">Install a .novaapp Package</div><div style="font-size:12px;margin-top:4px;">Drop a <code style="color:var(--accent);">.novaapp</code> file here,<br>or click <strong style="color:var(--text-primary);">Install</strong>.</div>';
          drop.append(dropBox, dropLabel);

          drop.addEventListener('dragover', e => {
            e.preventDefault();
            dropBox.style.borderColor = 'var(--accent)';
            dropBox.style.background = 'var(--accent-muted)';
          }, listenerOpts);
          drop.addEventListener('dragleave', () => {
            dropBox.style.borderColor = 'var(--border-default)';
            dropBox.style.background = '';
          }, listenerOpts);
          drop.addEventListener('drop', e => {
            // Intentionally NOT calling processFile here, and NOT stopping
            // propagation: this zone only owns the visual highlight reset.
            // The actual install is handled once, centrally, by the
            // registerApp-level onDrop hook (via wm.js's content listener),
            // so every .novaapp drop — whether it lands here or anywhere
            // else in the window — goes through the same Scanner check
            // before install, with no risk of firing processFile twice.
            e.preventDefault();
            dropBox.style.borderColor = 'var(--border-default)';
            dropBox.style.background = '';
          }, listenerOpts);

          detail.appendChild(drop);
          return;
        }

        const disabledSet = new Set(getDisabled());
        const isDis = disabledSet.has(app.id);
        // isBoot reflects reality, not just the stored preference list:
        // list membership alone doesn't mean the grant still holds — it can
        // be revoked from the Permissions section, or expire via the 30-day
        // unused-app sweep, independently of this list. If the grant is
        // gone, the button should show "off" immediately on next render
        // rather than keep claiming "Starts at Boot" for an entry that
        // launchAutostartApps() will silently skip at next boot anyway.
        const hasAutostartGrant = typeof AppPermissionManager !== 'undefined' &&
          AppPermissionManager.isGranted('system:autostart', app.id);
        const isBoot = getBootApps().includes(app.id) && hasAutostartGrant;
        // The boot toggle itself should only ever appear for an app that
        // actually declared system:autostart in its manifest (required or
        // optional) — same principle as every other permission in this
        // list: a permission being *requestable* at all is gated by the
        // app asking for it up front, not by whatever buttons App Manager
        // happens to render. Without this, any installed app could be
        // pushed into requesting a permission it never declared, purely
        // because the button existed — that's App Manager granting
        // capabilities on the app's behalf, not the app asking for them.
        const declaresAutostart =
          (app.permissions || []).includes('system:autostart') ||
          (app.optionalPermissions || []).includes('system:autostart');

        // ── Header ─────────────────────────────────────────────
        const header = createEl('div', {
          style: 'padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:14px;flex-shrink:0;'
        });
        const hIcon = createEl('div', {
          style: `width:56px;height:56px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};`
        });
        const iconSrc = resolveIcon(app);
        if (iconSrc) {
          const _img = createEl('img', { src: iconSrc, draggable: 'false', style: 'width:100%;height:100%;object-fit:cover;border-radius:13px;pointer-events:none;' });
          _img.onerror = () => { hIcon.innerHTML = svgIcon('/assets/no_app_icon.svg', 28); };
          hIcon.appendChild(_img);
        } else {
          hIcon.innerHTML = svgIcon(app.icon || '/assets/no_app_icon.svg', 28);
        }
        const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
        // SECURITY: escapeHtml for app.name and app.author (user-controlled)
        hMeta.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text-primary);">${escapeHtml(app.name)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;display:flex;align-items:center;gap:7px;">v${escapeHtml(app.version || '1.0.0')} \u00B7 ${escapeHtml(app.author || 'Unknown')} ${verifyBadgeHtml(app)}</div>`;
        header.append(hIcon, hMeta);
        detail.appendChild(header);

        // ── Actions ─────────────────────────────────────────────
        const actionBar = createEl('div', {
          style: 'padding:10px 20px;border-bottom:1px solid var(--border-subtle);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--bg-sunken);'
        });

        function makeActionBtn(label, iconName, style, onClick) {
          const btn = createEl('button', {
            style: `display:flex;align-items:center;gap:6px;padding:6px 13px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s;${style}`
          });
          btn.innerHTML = svgIcon(iconName, 12) + ' ' + label;
          btn.addEventListener('click', onClick, listenerOpts);
          return btn;
        }

        const launchBtn = makeActionBtn(
          isDis ? 'Disabled' : 'Launch', 'play',
          isDis
            ? 'background:var(--bg-elevated);border:1px solid var(--border-default);color:var(--text-muted);cursor:not-allowed;'
            : 'background:var(--accent);border:1px solid transparent;color:#fff;',
          () => { if (!isDis) WM.createWindow(app.id); }
        );

        const toggleBtn = makeActionBtn(
          isDis ? 'Enable' : 'Disable',
          isDis ? 'done' : 'no-entry',
          isDis
            ? 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:var(--text-success);'
            : 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:var(--text-warning);',
          () => {
            const d = getDisabled();
            setDisabled(isDis ? d.filter(id => id !== app.id) : [...d, app.id]);
            selectedPkgId = app.id;
            renderList();
            renderDetail();
            Notify.show({
              title: isDis ? 'App Enabled' : 'App Disabled',
              body: `${app.name} ${isDis ? 'enabled' : 'disabled'}`,
              type: 'success', appName: 'App Manager'
            });
          }
        );

        const uninstBtn = makeActionBtn(
          'Uninstall', 'trash',
          'background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#f85149;',
          () => doUninstall(app.id)
        );

        const bootBtn = makeActionBtn(
          isBoot ? 'Starts at Boot' : 'Start at Boot',
          isBoot ? 'done' : 'shutdown',
          isBoot
            ? 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:var(--text-success);'
            : 'background:var(--bg-elevated);border:1px solid var(--border-default);color:var(--text-secondary);',
          async () => {
            if (isBoot) {
              // Turning it off is just a preference change — no permission
              // implications, so no dialog. The system:autostart grant
              // itself is untouched; revoking that is a separate action in
              // the Permissions section, same as any other permission.
              setBootApps(getBootApps().filter(id => id !== app.id));
              selectedPkgId = app.id;
              renderList();
              renderDetail();
              Notify.show({ title: 'Removed from Boot', body: `${app.name} will no longer start automatically.`, type: 'success', appName: 'App Manager' });
              return;
            }

            // Turning it on requires the actual grant, same as any other
            // permission — being in this list is a user preference, not
            // authorization by itself (see launchAutostartApps() in
            // boot.js, which checks both). isGranted() first so an app that
            // already holds the grant (e.g. declared it in its manifest and
            // was granted at install) doesn't get re-prompted here.
            const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
            let granted = mgr ? mgr.isGranted('system:autostart', app.id) : false;
            if (mgr && !granted) {
              granted = await mgr.requestPermission('system:autostart', app.id, {
                appName: app.name,
                reason: 'Launch automatically when NovaByte starts, with no need to open it first.',
              });
            }
            if (!granted) {
              Notify.show({ title: 'Permission Required', body: `${app.name} needs the "Start automatically" permission to boot with NovaByte.`, type: 'warn', appName: 'App Manager' });
              return;
            }
            setBootApps([...getBootApps().filter(id => id !== app.id), app.id]);
            selectedPkgId = app.id;
            renderList();
            renderDetail();
            Notify.show({ title: 'Added to Boot', body: `${app.name} will start automatically next time.`, type: 'success', appName: 'App Manager' });
          }
        );

        actionBar.append(launchBtn, toggleBtn, ...(declaresAutostart ? [bootBtn] : []), uninstBtn);
        detail.appendChild(actionBar);

        // ── Info ────────────────────────────────────────────────
        const bodyEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px;' });
        if (app.description) {
          bodyEl.appendChild(createEl('div', {
            style: 'color:var(--text-secondary);line-height:1.65;font-size:13px;',
            textContent: app.description // textContent — safe, no HTML injection
          }));
        }

        // Permissions
        const allPerms = [
          ...(app.permissions || []).map(p => ({ p, req: true })),
          ...(app.optionalPermissions || []).map(p => ({ p, req: false }))
        ];

        if (allPerms.length) {
          const s = createEl('div');
          s.innerHTML = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px;">Permissions</div>';
          const row = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' });

          function permStyle(p) {
            if (['vfs:delete', 'admin:system'].includes(p)) {
              return 'background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.35);color:#f85149;';
            }
            if (['vfs:write', 'device:geolocation', 'system:settings'].includes(p)) {
              return 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:#d29922;';
            }
            return 'background:var(--accent-muted);border:1px solid rgba(88,166,255,0.3);color:var(--accent);';
          }

          allPerms.forEach(({ p, req }) => {
            const t = createEl('span', { style: `font-size:11px;padding:3px 9px;border-radius:6px;${permStyle(p)}` });
            t.textContent = p + (req ? '' : ' (opt)');
            row.appendChild(t);
          });
          s.appendChild(row);
          bodyEl.appendChild(s);
        }

        detail.appendChild(bodyEl);
      }

      function processFile(file) {
        if (!file.name.endsWith('.novaapp')) {
          Notify.show({ title: 'Invalid File', body: 'Please select a valid .novaapp package.', type: 'error', appName: 'App Manager' });
          return;
        }

        const reader = new FileReader();
        reader.onload = async ev => {
          try {
            const raw = ev.target.result;
            let pkg;

            try {
              pkg = JSON.parse(raw);
            } catch (_) {
              // SECURITY: Removed require('vm').runInThisContext() — this was executing
              // arbitrary untrusted code in the main context (equivalent to eval()).
              // Obfuscated packages must now be in valid JSON format.
              throw new Error('Package is not valid JSON. Obfuscated .novaapp files are no longer supported for security reasons.');
            }

            if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) {
              throw new Error('Missing required manifest fields (id, name, version).');
            }

            // ── Malware/heuristic scan ──
            // Runs before trust/integrity checks: a valid signature or
            // matching hash says nothing about whether the *contents* are
            // safe to run, only who signed them / whether they've changed
            // since. Scan every file entry in the package, not just the
            // manifest's declared entry point — a payload could be stashed
            // in any bundled file.
            if (window.Scanner?.scanBase64 && pkg.files && typeof pkg.files === 'object') {
              for (const [relPath, rawB64] of Object.entries(pkg.files)) {
                if (typeof rawB64 !== 'string') continue;
                let verdict;
                try {
                  verdict = await window.Scanner.scanBase64(relPath, rawB64);
                } catch (err) {
                  console.warn('[AppManager] Scanner error on', relPath, err);
                  continue;
                }
                if (!verdict.safe) {
                  await showMaliciousFileDialog(pkg.manifest, { fileName: relPath, reason: verdict.reason });
                  return;
                }
              }
            }

            // ── Signature verification against the trust store ──
            // SECURITY: The previous implementation's fallback accepted any
            // package where `signature === sha256(payload)` — that's not a
            // verification, it's an attacker computing the hash of their own
            // (arbitrary, unmodified) payload and pasting it into the
            // signature field, which will always match. It proved nothing
            // about who published the package. Real verification requires
            // checking against a public key from a trust store: only the
            // holder of the matching PRIVATE key could have produced a
            // signature that validates, so this can't be self-satisfied.
            // ── Integrity check — computed up front, before the trust-store
            // check, purely so BOTH dialogs below can show it as a package
            // detail. Trust (who signed it) and integrity (is it unmodified)
            // are separate axes — a package can fail one without failing the
            // other — so this result is informational at this point; the
            // actual "block install" decision for tampering still happens
            // in its own step further down, with its own harder confirmation.
            let integrityStatus = 'unavailable'; // 'ok' | 'failed' | 'unavailable'
            let mismatchedFiles = [];
            if (pkg.integrity && typeof AppPackage !== 'undefined' && typeof AppPackage.verifyIntegrity === 'function') {
              try {
                const integrityOk = await AppPackage.verifyIntegrity(pkg);
                integrityStatus = integrityOk ? 'ok' : 'failed';
              } catch (_) { integrityStatus = 'failed'; }

              if (integrityStatus === 'failed') {
                // verifyIntegrity() only returns a boolean, so recompute
                // per-file hashes here purely to show the user which
                // file(s) look altered — this list is informational only.
                try {
                  const fresh = await AppPackage.computeIntegrity(pkg, pkg.integrity.method);
                  mismatchedFiles = Object.keys(pkg.integrity.fileHashes || {})
                    .filter(f => fresh.fileHashes?.[f] !== pkg.integrity.fileHashes[f]);
                } catch (_) { /* best-effort only */ }
              }
            }

            let verified = false;
            let signer = null;
            let result = null;
            try {
              if (typeof AppPackage !== 'undefined' && typeof AppPackage.verifyAgainstTrustStore === 'function'
                  && typeof TrustStore !== 'undefined') {
                const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
                result = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
                verified = result.trusted;
                signer = result.signer;
                if (result.revoked) {
                  // Cryptographically valid, but this specific signed
                  // package was individually pulled — surface that
                  // distinction rather than just showing the generic
                  // "Unverified" state, since the two mean very different
                  // things to a user deciding whether to proceed.
                  signer = null;
                  console.warn('[AppManager] Package signature is on the revocation list — refusing trust regardless of otherwise-valid signature.');
                }
              }
            } catch (_) { verified = false; }

            // Trust and/or integrity failure gate. Same four shapes as the
            // launch path, and for the same reason: a combo (both fail)
            // gets ONE dialog instead of two chained ones; either failing
            // alone still uses its own existing single dialog unchanged.
            const trustFailed = !verified;
            const integrityFailed = integrityStatus === 'failed';

            if (trustFailed && integrityFailed) {
              const proceeded = await showCombinedTrustIntegrityDialog(
                { ...pkg.manifest, signature: pkg.signature, revoked: result?.revoked, integrityStatus },
                { mismatchedFiles }
              );
              if (!proceeded) return;
            } else if (trustFailed) {
              const proceeded = await showUntrustedAppDialog(
                { ...pkg.manifest, signature: pkg.signature, revoked: result?.revoked, integrityStatus },
                {}
              );
              if (!proceeded) return;
            } else if (integrityFailed) {
              // ── Tamper block — separate from signature trust ──
              // A valid, trusted signature only proves who signed the
              // ORIGINAL package; it says nothing about whether these bytes
              // are still that original. Deliberately not folded into
              // showUntrustedAppDialog: that dialog answers "do we trust
              // the publisher?", this one answers "is this still what the
              // publisher shipped?" — reached here only when trust passed
              // but bytes were altered afterward (trusted signer, tampered).
              const proceeded = await showTamperDetectedDialog(pkg.manifest, { mismatchedFiles });
              if (!proceeded) return;
            }

            // ── Handle replacement of existing install ──
            const idx = installedApps.findIndex(a => a.id === pkg.manifest.id);
            if (idx > -1) {
              const replaceResult = await showModal(
                'App Already Installed',
                `"${pkg.manifest.name}" is already installed (v${installedApps[idx].version}). Replace with v${pkg.manifest.version}?`,
                [{ label: 'Cancel' }, { label: 'Replace', value: 'confirm', primary: true }]
              );
              if (replaceResult !== 'confirm') return;
              delete OS.apps[pkg.manifest.id];
              const ri = APP_REGISTRY.findIndex(a => a.id === pkg.manifest.id);
              if (ri > -1) APP_REGISTRY.splice(ri, 1);
              if (PackageStore?.removeApp) await PackageStore.removeApp(pkg.manifest.id, { updateRegistry: false });
              installedApps.splice(idx, 1);
            }

            // ── Inline bundle CSS/JS into HTML for offline-ready blob ──
            const entryKey = pkg.manifest.entry || 'index.html';
            try {
              const entryB64 = pkg.files[entryKey];
              if (entryB64 && typeof entryB64 === 'string') {
                let html = decodeURIComponent(escape(atob(entryB64)));
                html = html
                  .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
                  .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>/gi, '');

                for (const [relPath, rawB64] of Object.entries(pkg.files)) {
                  if (relPath === entryKey || !rawB64 || typeof rawB64 !== 'string') continue;
                  const lower = relPath.toLowerCase();
                  let tag = null;
                  if (lower.endsWith('.css')) {
                    const css = decodeURIComponent(escape(atob(rawB64)));
                    tag = '<style data-ninline>\n' + css + '\n</style>';
                  } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
                    const js = decodeURIComponent(escape(atob(rawB64)));
                    tag = '<script data-ninline>\n' + js + '\n<\/script>';
                  }
                  if (!tag) continue;
                  if (/<head(\s[^>]*)?>/i.test(html)) {
                    html = html.replace(/<head(\s[^>]*)?>/i, (m) => m + '\n' + tag);
                  } else {
                    html = tag + '\n' + html;
                  }
                }
                pkg.files[entryKey] = btoa(unescape(encodeURIComponent(html)));
              }
            } catch (inlineErr) {
              console.warn('[AppManager] Inline bundling failed, using original files:', inlineErr);
            }

            const appData = {
              ...pkg.manifest,
              files: pkg.files,
              signature: pkg.signature,
              integrity: pkg.integrity || null,
              verified,
              signer,
              source: 'file',
              installedAt: Date.now(),
              revoked: result?.revoked || false,
              tampered: integrityFailed
            };
            if (PackageStore?.installApp) {
              Object.assign(appData, await PackageStore.installApp(appData));
            }
            installedApps.push(appData);
            saveStoredApps(installedApps);
             registerNovaApp(appData);
             pushLog({ action: 'install', appId: appData.id, label: `${appData.name} v${appData.version} installed` });
             selectedPkgId = appData.id;
             try { await window.AppDirs?.ensureAppDataFolder?.(appData.id); } catch (_e) { /* best-effort */ }
            renderList();
            renderDetail();
            if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
            if (typeof WM !== 'undefined' && typeof WM.updateTaskbar === 'function') WM.updateTaskbar();
            Notify.show({ title: 'App Installed', body: `${appData.name} v${appData.version} installed successfully.`, type: 'success', appName: 'App Manager' });
          } catch (err) {
            Notify.show({ title: 'Install Failed', body: String(err.message || err), type: 'error', appName: 'App Manager' });
          }
        };
        reader.readAsText(file);
      }

      // Exposed so the registerApp-level onDrop hook (below, outside this
      // closure) can route a dropped .novaapp straight into the install
      // flow, regardless of which tab/view is currently showing — the
      // in-page drop zone above only exists in the empty "no app selected"
      // state, so without this a drop anywhere else in the window would
      // fall through to the window manager's generic fallback instead.
      content._novaAppProcessFile = processFile;

      async function doUninstall(appId) {
        const app = installedApps.find(a => a.id === appId);
        if (!app) return;
        const uninstallResult = await showModal(
          'Uninstall App',
          `Uninstall "${app.name}" v${app.version}? This cannot be undone.`,
          [{ label: 'Cancel' }, { label: 'Uninstall', value: 'confirm', danger: true }]
        );
        if (uninstallResult !== 'confirm') return;

        pushLog({ action: 'uninstall', appId: app.id, label: `${app.name} v${app.version} uninstalled` });

        // Close any open windows for this app before removing it — otherwise
        // the window is left running against an app whose registry entry,
        // files, and permissions are about to be deleted out from under it.
        if (typeof WM !== 'undefined' && WM.closeWindow) {
          const openWindowIds = [];
          for (const [wid, wstate] of OS.windows) {
            if (wstate.appId === appId) openWindowIds.push(wid);
          }
          await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
        }

        try {
          if (PackageStore?.removeApp) await PackageStore.removeApp(appId, { updateRegistry: false });
        } catch (e) {
          console.warn('[AppManager] Failed to remove stored package files for', appId, e);
        }
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
            await AppSandbox.clearAppPartition(appId);
          }
        } catch (e) {
          console.warn('[AppManager] Failed to clear storage partition for', appId, e);
        }
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.storageClear) {
            await AppSandbox.storageClear(appId);
          }
        } catch (e) {
          console.warn('[AppManager] Failed to clear nova:storage for', appId, e);
        }
        try {
          if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
            await AppDirs.removeAppData(appId);
          }
        } catch (e) {
          console.warn('[AppManager] Failed to clear app data for', appId, e);
        }
        installedApps = installedApps.filter(a => a.id !== appId);
        saveStoredApps(installedApps);
        delete OS.apps[appId];
        const ri = APP_REGISTRY.findIndex(a => a.id === appId);
        if (ri > -1) APP_REGISTRY.splice(ri, 1);

        // Remove from pinned, boot, disabled
        OS.settings.set('pinnedApps', getPinned().filter(id => id !== appId));
        setDisabled(getDisabled().filter(id => id !== appId));
        setBootApps(getBootApps().filter(id => id !== appId));

        // Remove any desktop shortcut (.lnk) files pointing to this app
        try {
          const desktopFolder = FS.specialFolders?.desktop;
          if (desktopFolder) {
            const files = FS.listDir(desktopFolder);
            for (const f of files) {
              if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
                try {
                  const data = JSON.parse(f.content || '{}');
                  if (data?.type === 'app-shortcut' && data?.target === appId) {
                    await FS.permanentDelete(f.id);
                  }
                } catch { /* skip invalid shortcuts */ }
              }
            }
          }
        } catch (e) {
          console.warn('[AppManager] Failed to clean up desktop shortcuts for', appId, e);
        }

        if (WM.updateTaskbar) WM.updateTaskbar();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
        selectedPkgId = null;
        renderList();
        renderDetail();
        if (typeof refreshStats === 'function') refreshStats();
        Notify.show({ title: 'App Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'App Manager' });
      }

      // ── Debounced search to avoid excessive re-renders ──
      searchEl.addEventListener('input', debounce(renderList, 150), listenerOpts);
      root.addEventListener('dragover', e => e.preventDefault(), listenerOpts);
      root.addEventListener('drop', e => {
        // Intentionally NOT calling processFile here, and NOT stopping
        // propagation — see the matching comment on the empty-state drop
        // zone in renderDetail(). This listener predates that one and was
        // the actual cause of files getting processed twice (once here,
        // once via the registerApp-level onDrop that fires when the event
        // bubbles to wm.js's content listener): both ran processFile
        // independently, so a single drop showed the install/warning
        // dialog twice. Now there's exactly one path — this just prevents
        // the browser's default "navigate to dropped file" behavior.
        e.preventDefault();
      }, listenerOpts);

      root.append(sidebar, detail);
      body.appendChild(root);
      renderList();
      renderDetail();
    }

    // ══════════════════════════════════════════════════════════════
    // WEB APPS PANEL
    // ══════════════════════════════════════════════════════════════
    function renderWebAppsPanel() {
      const wam = typeof WebAppManager !== 'undefined' ? WebAppManager : null;

      function getAllWebApps() { return wam ? wam.getAllApps() : []; }

      const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

      // ── Sidebar ──────────────────────────────────────────────────
      const sidebar = createEl('div', {
        style: 'width:300px;min-width:260px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;'
      });

      const toolbar = createEl('div', { style: 'padding:9px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
      const searchEl = createEl('input', {
        type: 'text', id: 'notes-tasks-search-input', name: 'notes-tasks-search',
        placeholder: 'Search\u2026',
        style: 'flex:1;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;min-width:0;'
      });
      const addBtn = createEl('button', {
        style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;'
      });
      addBtn.innerHTML = svgIcon('plus', 12) + ' Add';
      toolbar.append(searchEl, addBtn);
      sidebar.appendChild(toolbar);

      const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:5px;' });
      sidebar.appendChild(listEl);

      // ── Right panel ──────────────────────────────────────────────
      const right = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

      let selectedWebId = null;

      function launchWebApp(wa) {
        // Delegates to the shared helper in registry.js so every launch
        // path (this Open button, launchpad, desktop shortcut, taskbar)
        // builds the window identically. See registry.js openWebApp().
        if (typeof window.openWebApp === 'function') {
          window.openWebApp(wa.id);
          return;
        }
        // Fallback if registry.js hasn't loaded for some reason.
        const tempId = 'webapp_' + wa.id;
        if (!OS.apps[tempId] && typeof window.buildWebAppEntry === 'function') {
          OS.apps[tempId] = window.buildWebAppEntry(wa);
        }
        WM.createWindow(tempId);
      }

      function renderList() {
        listEl.innerHTML = '';
        const q = searchEl.value.trim().toLowerCase();
        let apps = getAllWebApps();
        if (q) apps = apps.filter(a =>
          a.name.toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q)
        );

        if (!apps.length) {
          const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.9;' });
          msg.innerHTML = q
            ? '<div style="font-size:13px;">No matches found.</div>'
            : '<div style="font-size:34px;margin-bottom:10px;">\uD83C\uDF10</div><div style="font-size:12px;">No web apps yet.<br>Click <strong style="color:var(--text-primary);">+ Add</strong> to get started.</div>';
          listEl.appendChild(msg);
          return;
        }

        // ── Batch DOM write with DocumentFragment ──
        const fragment = document.createDocumentFragment();

        apps.forEach(wa => {
          const isSel = wa.id === selectedWebId;
          const host = extractHost(wa.url);
          const item = createEl('div', {
            style: `display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}`
          });
          const iconEl = createEl('div', {
            style: 'width:32px;height:32px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;'
          });
          if (wa.icon) {
            if (/^data:|^https?:\/\//i.test(wa.icon)) {
              const img = createEl('img', { src: wa.icon, style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:9px;', draggable: 'false' });
              img.onerror = () => { iconEl.innerHTML = svgIcon('globe', 16); };
              iconEl.appendChild(img);
            } else {
              iconEl.textContent = wa.icon;
            }
          } else {
            iconEl.innerHTML = svgIcon('globe', 16);
          }
          const meta = createEl('div', { style: 'flex:1;min-width:0;' });
          // SECURITY: escapeHtml for user-controlled wa.name
          meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);font-size:12px;">${escapeHtml(wa.name)}</div><div style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(host)}</div>`;
          item.append(iconEl, meta);

          item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; }, listenerOpts);
          item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; }, listenerOpts);
          item.addEventListener('click', () => { selectedWebId = wa.id; renderList(); renderDetail(); }, listenerOpts);

          fragment.appendChild(item);
        });

        listEl.appendChild(fragment);
      }

      function renderDetail() {
        right.innerHTML = '';
        const wa = getAllWebApps().find(a => a.id === selectedWebId);

        if (!wa) {
          // ── Add form ────────────────────────────────────────────
          const wrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px;display:flex;align-items:flex-start;justify-content:center;' });
          const card = createEl('div', { style: 'width:100%;max-width:420px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:14px;overflow:hidden;' });
          const hdr = createEl('div', { style: 'padding:16px 18px;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);' });
          hdr.innerHTML = `<div style="font-size:14px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;">${svgIcon('plus', 15)} Add Web App</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Pin any website as an app.</div>`;
          card.appendChild(hdr);

          const cbody = createEl('div', { style: 'padding:16px 18px;display:flex;flex-direction:column;gap:12px;' });

          function mkField(label, type, ph, fieldId, fieldName) {
            const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
            const labelEl = createEl('label', {
              style: 'font-size:11px;font-weight:600;color:var(--text-muted);',
              textContent: label // textContent — safe
            });
            w.appendChild(labelEl);
            const inp = createEl('input', {
              type, id: fieldId, name: fieldName, placeholder: ph,
              style: 'padding:8px 10px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;width:100%;transition:border-color 0.15s;'
            });
            inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)', listenerOpts);
            inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)', listenerOpts);
            w.appendChild(inp);
            return { w, inp };
          }

          const { w: wUrl, inp: urlInp } = mkField('URL *', 'url', 'https://example.com', 'web-app-url-input', 'web-app-url');
          const { w: wName, inp: nameInp } = mkField('Name *', 'text', 'My App', 'web-app-name-input', 'web-app-name');

          // ── Custom icon (optional) ──────────────────────────────
          // Icons are stored inline as a data: URL string (see
          // WebAppManager.LIMITS.MAX_ICON_LENGTH — currently 2048 chars),
          // so any uploaded image must be downscaled + compressed to fit.
          // If the user skips this, addApp() falls back to a DuckDuckGo
          // favicon lookup automatically.
          let customIconDataUrl = null; // set once a valid image is processed

          const wIcon = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
          const iconLabel = createEl('label', {
            style: 'font-size:11px;font-weight:600;color:var(--text-muted);',
            textContent: 'Icon (optional)'
          });
          const iconRow = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });

          const iconPreview = createEl('div', {
            style: 'width:40px;height:40px;border-radius:10px;background:var(--bg-sunken);border:1px solid var(--border-default);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;'
          });
          iconPreview.innerHTML = svgIcon('globe', 16);

          const iconFileInp = createEl('input', {
            type: 'file', accept: 'image/*', id: 'web-app-icon-input', name: 'web-app-icon',
            style: 'display:none;'
          });
          const iconPickBtn = createEl('button', {
            style: 'padding:7px 10px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);cursor:pointer;font-size:12px;'
          });
          iconPickBtn.textContent = 'Choose image\u2026';
          const iconClearBtn = createEl('button', {
            style: 'padding:7px 10px;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;display:none;'
          });
          iconClearBtn.textContent = 'Remove';

          const iconErrEl = createEl('div', { style: 'font-size:11px;color:var(--text-danger);min-height:14px;' });

          // Downscale + compress an uploaded image into a small square data
          // URL that fits under MAX_ICON_LENGTH. Tries a shrinking sequence
          // of sizes/qualities since source images vary wildly in detail.
          function processIconFile(file) {
            iconErrEl.textContent = '';
            if (!file.type.startsWith('image/')) {
              iconErrEl.textContent = 'Please choose an image file.';
              return;
            }
            const MAX_ICON_LEN = 2048; // mirrors WebAppManager.LIMITS.MAX_ICON_LENGTH
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              const attempts = [
                [64, 0.7], [48, 0.7], [40, 0.6], [32, 0.6], [24, 0.5]
              ];
              let result = null;
              for (const [size, quality] of attempts) {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                // Cover-fit the source image into the square canvas.
                const scale = Math.max(size / img.width, size / img.height);
                const dw = img.width * scale, dh = img.height * scale;
                ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= MAX_ICON_LEN) { result = dataUrl; break; }
              }
              if (!result) {
                iconErrEl.textContent = 'Image is too complex to fit as an icon. Try a simpler image.';
                return;
              }
              customIconDataUrl = result;
              iconPreview.innerHTML = '';
              const previewImg = createEl('img', { src: result, style: 'width:100%;height:100%;object-fit:cover;', draggable: 'false' });
              iconPreview.appendChild(previewImg);
              iconClearBtn.style.display = '';
            };
            img.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              iconErrEl.textContent = 'Could not read that image.';
            };
            img.src = objectUrl;
          }

          iconPickBtn.addEventListener('click', () => iconFileInp.click(), listenerOpts);
          iconFileInp.addEventListener('change', () => {
            const file = iconFileInp.files && iconFileInp.files[0];
            if (file) processIconFile(file);
          }, listenerOpts);
          iconClearBtn.addEventListener('click', () => {
            customIconDataUrl = null;
            iconFileInp.value = '';
            iconErrEl.textContent = '';
            iconPreview.innerHTML = svgIcon('globe', 16);
            iconClearBtn.style.display = 'none';
          }, listenerOpts);

          iconRow.append(iconPreview, iconPickBtn, iconClearBtn, iconFileInp);
          wIcon.append(iconLabel, iconRow, iconErrEl);

          const errEl = createEl('div', { style: 'font-size:11px;color:var(--text-danger);min-height:14px;' });
          const saveBtn = createEl('button', {
            style: 'padding:10px;background:var(--accent);color:#fff;border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:7px;'
          });
          saveBtn.innerHTML = svgIcon('plus', 13) + ' Add Web App';
          saveBtn.addEventListener('click', () => {
            const url = urlInp.value.trim();
            const name = nameInp.value.trim();
            errEl.textContent = '';

            if (!url) { errEl.textContent = 'URL is required.'; return; }
            try { new URL(url); } catch { errEl.textContent = 'Please enter a valid URL.'; return; }
            if (!name) { errEl.textContent = 'Name is required.'; return; }

            const addedApp = wam ? wam.addApp({ name, url, icon: customIconDataUrl || undefined }) : null;
            if (addedApp) {
              Notify.show({ title: 'App Added', body: `"${name}" is now available.`, type: 'success', appName: 'App Manager' });
              selectedWebId = addedApp.id;
              renderList();
              renderDetail();
            }
          }, listenerOpts);

          cbody.append(wUrl, wName, wIcon, errEl, saveBtn);
          card.appendChild(cbody);
          wrap.appendChild(card);
          right.appendChild(wrap);
          return;
        }

        // ── Detail view ─────────────────────────────────────────
        const host = extractHost(wa.url);

        const hdr = createEl('div', {
          style: 'padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--bg-sunken);'
        });
        const hIcon = createEl('div', {
          style: 'width:48px;height:48px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;'
        });
        if (wa.icon) {
          if (/^data:|^https?:\/\//i.test(wa.icon)) {
            const img = createEl('img', { src: wa.icon, style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:13px;', draggable: 'false', crossorigin: 'anonymous' });
            img.onerror = () => { hIcon.innerHTML = svgIcon('globe', 24); };
            hIcon.appendChild(img);
          } else {
            hIcon.textContent = wa.icon;
          }
        } else {
          hIcon.innerHTML = svgIcon('globe', 24);
        }
        const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
        // SECURITY: escapeHtml for user-controlled wa.name and host
        hMeta.innerHTML = `<div style="font-size:16px;font-weight:700;color:var(--text-primary);">${escapeHtml(wa.name)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(host)}</div>`;
        hdr.append(hIcon, hMeta);
        right.appendChild(hdr);

        const abar = createEl('div', {
          style: 'padding:9px 18px;border-bottom:1px solid var(--border-subtle);display:flex;gap:7px;flex-shrink:0;'
        });

        function mkBtn(label, icon, sty, fn) {
          const b = createEl('button', {
            style: `display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;${sty}`
          });
          b.innerHTML = svgIcon(icon, 12) + ' ' + label;
          b.addEventListener('click', fn, listenerOpts);
          abar.appendChild(b);
          return b;
        }

        mkBtn('Open', 'external-link', 'background:var(--accent);border:1px solid transparent;color:#fff;', () => launchWebApp(wa));
        mkBtn('Remove', 'trash', 'background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.25);color:#f85149;', async () => {
          const removeResult = await showModal(
            'Remove Web App',
            `Remove "${wa.name}"?`,
            [{ label: 'Cancel' }, { label: 'Remove', value: 'confirm', danger: true }]
          );
          if (removeResult !== 'confirm') return;
          // removeWebApp (registry.js) also unpins from taskbar and deletes
          // any desktop .lnk shortcut — not just the WebAppManager record —
          // so nothing is left behind with a dead reference.
          if (typeof window.removeWebApp === 'function') {
            await window.removeWebApp(wa.id);
          } else if (wam) {
            wam.removeApp(wa.id);
          }
          selectedWebId = null;
          renderList();
          renderDetail();
          Notify.show({ title: 'Removed', body: `"${wa.name}" removed`, type: 'success', appName: 'App Manager' });
        });

        right.appendChild(abar);
      }

      addBtn.addEventListener('click', () => { selectedWebId = null; renderList(); renderDetail(); }, listenerOpts);
      searchEl.addEventListener('input', debounce(renderList, 150), listenerOpts);
      root.append(sidebar, right);
      body.appendChild(root);
      renderList();
      renderDetail();
    }

    // ── Boot ────────────────────────────────────────────────────────
    refreshTabStyles();
    switchTab('packages');
  }
});

/* ── Background services: Clock + Email ───────────────────────────────── */
(function () {
  'use strict';

  const bgRoot = window.__NBOSP_BG = window.__NBOSP_BG || {};

  // ── Shared AudioContext (reused instead of creating new one per beep) ──
  let sharedAudioCtx = null;

  function getAudioContext() {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      try {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch { return null; }
    }
    // Resume if suspended (browser autoplay policy)
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }

  function bgBeep(freq, dur) {
    try {
      const actx = getAudioContext();
      if (!actx) return;
      const osc = actx.createOscillator();
      const gn = actx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq || 880;
      gn.gain.setValueAtTime(0.25, actx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (dur || 1.0));
      osc.connect(gn);
      gn.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + (dur || 1.0));
      // No setTimeout to close — we reuse the AudioContext
    } catch { /* audio not available */ }
  }

  function safeJSONParse(raw, fallback) {
    try { return JSON.parse(raw); }
    catch { return fallback; }
  }

  /* ---------------------------- Clock service ---------------------------- */
  if (!bgRoot.clock) {
    const STATE_KEY = 'nbosp_clock_state_v2';
    const ALARMS_KEY = 'nbosp_clock_v1';

    const defaults = () => ({
      timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
      stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
      lastAlarmMinute: ''
    });

    let state = safeJSONParse(localStorage.getItem(STATE_KEY), null) || defaults();

    function normaliseState() {
      state.timer = state.timer || {};
      state.stopwatch = state.stopwatch || {};
      state.timer.running = !!state.timer.running;
      state.timer.done = !!state.timer.done;
      state.timer.presetMs = Math.max(0, Number(state.timer.presetMs) || 0);
      state.timer.remainingMs = Math.max(0, Number(state.timer.remainingMs) || 0);
      state.timer.endAt = Math.max(0, Number(state.timer.endAt) || 0);

      state.stopwatch.running = !!state.stopwatch.running;
      state.stopwatch.elapsedMs = Math.max(0, Number(state.stopwatch.elapsedMs) || 0);
      state.stopwatch.startedAt = Math.max(0, Number(state.stopwatch.startedAt) || 0);
      state.stopwatch.laps = Array.isArray(state.stopwatch.laps)
        ? state.stopwatch.laps.filter(n => Number.isFinite(n) && n >= 0).map(n => Math.floor(n))
        : [];
      state.lastAlarmMinute = typeof state.lastAlarmMinute === 'string' ? state.lastAlarmMinute : '';
    }

    function persist() {
      normaliseState();
      lsSave(STATE_KEY, state);
    }

    function loadAlarms() {
      const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
      const alarms = Array.isArray(raw?.alarms) ? raw.alarms : [];
      return alarms
        .map(al => ({
          id: al?.id ?? Date.now().toString(36),
          time: typeof al?.time === 'string' ? al.time : '07:00',
          label: typeof al?.label === 'string' ? al.label : '',
          days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
          enabled: al?.enabled !== false
        }))
        .filter(al => /^\d{2}:\d{2}$/.test(al.time));
    }

    function saveAlarms(alarms) {
      const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
      raw.alarms = alarms;
      lsSave(ALARMS_KEY, raw);
    }

    function nowMs() { return Date.now(); }

    function timerMs() {
      normaliseState();
      if (state.timer.running && state.timer.endAt) {
        const rem = Math.max(0, state.timer.endAt - nowMs());
        if (rem <= 0) {
          state.timer.running = false;
          state.timer.done = true;
          state.timer.remainingMs = 0;
          state.timer.endAt = 0;
          persist();
          bgBeep(880, 0.7);
          setTimeout(() => bgBeep(1047, 0.7), 350);
          setTimeout(() => bgBeep(1319, 1.0), 700);
          return 0;
        }
        return rem;
      }
      return state.timer.remainingMs || 0;
    }

    function stopwatchMs() {
      normaliseState();
      return state.stopwatch.running
        ? state.stopwatch.elapsedMs + Math.max(0, nowMs() - state.stopwatch.startedAt)
        : state.stopwatch.elapsedMs;
    }

    bgRoot.clock = {
      state,
      persist,
      loadAlarms,
      saveAlarms,
      timerMs,
      stopwatchMs,

      startTimer(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      pauseTimer() {
        state.timer.remainingMs = timerMs();
        state.timer.running = false;
        state.timer.done = false;
        state.timer.endAt = 0;
        persist();
      },

      resetTimer() {
        state.timer.running = false;
        state.timer.done = false;
        state.timer.remainingMs = state.timer.presetMs || 0;
        state.timer.endAt = 0;
        persist();
      },

      restartTimer() {
        const amount = state.timer.presetMs || state.timer.remainingMs || 0;
        state.timer.remainingMs = amount;
        state.timer.endAt = nowMs() + amount;
        state.timer.running = amount > 0;
        state.timer.done = false;
        persist();
      },

      setTimerPreset(ms) {
        const amount = Math.max(0, Math.floor(Number(ms) || 0));
        state.timer.presetMs = amount;
        if (!state.timer.running) state.timer.remainingMs = amount;
        persist();
      },

      startStopwatch() {
        if (!state.stopwatch.running) {
          state.stopwatch.startedAt = nowMs();
          state.stopwatch.running = true;
          persist();
        }
      },

      pauseStopwatch() {
        if (state.stopwatch.running) {
          state.stopwatch.elapsedMs = stopwatchMs();
          state.stopwatch.running = false;
          state.stopwatch.startedAt = 0;
          persist();
        }
      },

      resetStopwatch() {
        state.stopwatch.running = false;
        state.stopwatch.elapsedMs = 0;
        state.stopwatch.startedAt = 0;
        state.stopwatch.laps = [];
        persist();
      },

      lapStopwatch() {
        const current = Math.floor(stopwatchMs());
        const laps = state.stopwatch.laps;
        if (!laps.length || laps[laps.length - 1] !== current) {
          laps.push(current);
          persist();
        }
        return current;
      },

      getStopwatchLaps() {
        normaliseState();
        return state.stopwatch.laps.slice();
      },

      alarmTick(checkFn) {
        const now = new Date();
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
        if (state.lastAlarmMinute === minuteKey) return;
        const seconds = now.getSeconds();
        const ms = now.getMilliseconds();
        if (seconds !== 0 || ms > 1400) return;
        state.lastAlarmMinute = minuteKey;
        persist();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dow = now.getDay();
        const alarms = loadAlarms();
        alarms.forEach((al, i) => {
          if (!al.enabled || al.time !== timeStr) return;
          if (al.days.length > 0 && !al.days.includes(dow)) return;
          if (typeof checkFn === 'function') {
            try { checkFn(al, i); } catch { /* observer error — don't block */ }
          }
          bgBeep(880, 0.8);
          setTimeout(() => bgBeep(1047, 0.8), 400);
          setTimeout(() => bgBeep(1319, 1.2), 800);
          if (al.days.length === 0) {
            al.enabled = false;
            saveAlarms(alarms);
          }
        });
      },

      ensureBooted() { return true; },

      // ── Cleanup method for clock interval ──
      destroy() {
        if (bgRoot._clockTimer) {
          clearInterval(bgRoot._clockTimer);
          bgRoot._clockTimer = null;
        }
        if (sharedAudioCtx) {
          sharedAudioCtx.close().catch(() => {});
          sharedAudioCtx = null;
        }
      }
    };

    normaliseState();
    persist();

    if (!bgRoot._clockTimer) {
      bgRoot._clockTimer = setInterval(() => {
        timerMs();
        bgRoot.clock.alarmTick();
      }, 250);
    }
  }

  /* ---------------------------- Email service ---------------------------- */
  if (!bgRoot.email) {
    const ACCTS_KEY = 'nbosp_email_accts_v2';

    const state = {
      started: false,
      accounts: [],
      syncTimers: {},
      onChange: null,
      lastBootAt: 0
    };

    const rawLoad = () => {
      try { return JSON.parse(localStorage.getItem(ACCTS_KEY) || '[]'); }
      catch { return []; }
    };

    function saveAccounts() {
      lsSave(ACCTS_KEY, state.accounts);
    }

    function clearTimers() {
      for (const id of Object.keys(state.syncTimers)) {
        clearInterval(state.syncTimers[id]);
        delete state.syncTimers[id];
      }
    }

    async function api(path, opts) {
      const r = await fetch('/api/email' + path, Object.assign({ credentials: 'include' }, opts || {}));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }

    async function connectAccount(acct) {
      if (!acct || !acct.host || !acct.user || !acct.pass) return;
      await api('/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: acct.type, host: acct.host, port: acct.port,
          ssl: acct.ssl, user: acct.user, pass: acct.pass
        })
      });
    }

    function renderHook() {
      if (typeof state.onChange === 'function') {
        try { state.onChange(); } catch { /* observer error */ }
      }
    }

    // ── AbortController for cancelling in-flight sync requests ──
    let syncAbortController = null;

    async function syncAccount(acct) {
      // ── Create per-sync abort signal ──
      const localAc = new AbortController();

      try {
        await connectAccount(acct);
        const d = await api('/messages?folder=INBOX&page=1&limit=10', { method: 'GET', signal: localAc.signal });
        const unread = (d.messages || []).filter(m => !m.seen).length;
        acct._unread = unread;
        acct._lastSync = Date.now();
        state.accounts = rawLoad();
        const target = state.accounts.find(a => a.id === acct.id);
        if (target) {
          target._unread = unread;
          target._lastSync = acct._lastSync;
          saveAccounts();
        }
        if (unread > 0 && window.Notify?.show) {
          Notify.show({ title: 'Email', body: `${unread} new in ${acct.name || acct.email || 'Email'}`, type: 'info', appName: 'Email' });
        }
        renderHook();
      } catch {
        // Network error or abort — silently handled
      }
    }

    function schedule() {
      clearTimers();
      state.accounts = rawLoad();
      state.accounts.forEach(acct => {
        const mins = parseInt(acct.syncInterval) || 0;
        if (!mins) return;
        state.syncTimers[acct.id] = setInterval(() => { syncAccount(acct); }, mins * 60000);
      });
    }

    bgRoot.email = {
      state,

      ensureBooted() {
        if (state.started) return;
        state.started = true;
        state.lastBootAt = Date.now();
        state.accounts = rawLoad();
        schedule();
        state.accounts.forEach(acct => {
          const mins = parseInt(acct.syncInterval) || 0;
          if (mins) syncAccount(acct);
        });
      },

      refreshAccounts: schedule,

      getAccounts() {
        state.accounts = rawLoad();
        return state.accounts.slice();
      },

      saveAccounts,

      setAccounts(next) {
        state.accounts = Array.isArray(next) ? next : [];
        saveAccounts();
        schedule();
        renderHook();
      },

      syncNow(acctId) {
        const list = rawLoad();
        if (acctId) {
          const acct = list.find(a => a.id === acctId);
          if (acct) return syncAccount(acct);
          return Promise.resolve();
        }
        return Promise.allSettled(list.map(acct => syncAccount(acct)));
      },

      stop() {
        clearTimers();
        // ── Cancel any in-flight sync requests ──
        if (syncAbortController) {
          syncAbortController.abort();
          syncAbortController = null;
        }
        state.started = false;
      }
    };
  }
})();