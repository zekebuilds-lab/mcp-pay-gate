/**
 * @powforge/mcp-pay-gate — LNBits HTTP adapter
 *
 * Lifted verbatim (with comment-header tweak) from
 * `@powforge/mcp-l402-gate/src/lib/lnbits.js`. The same two LNBits endpoints
 * cover both the L402 macaroon flow and the x402-bip122-exact flow:
 *
 *   POST /api/v1/payments         create invoice
 *   GET  /api/v1/payments/<hash>  read paid status
 *
 * Callers can pass a custom `fetchImpl` for tests. In production the
 * package uses globalThis.fetch (Node 18+).
 *
 * Spec context: x402-foundation/x402 PR #1311 step-10 of the verifier
 * checks paid status via this same endpoint. Research log
 * `research/h-mcp-auth-1-log.md` §21 confirms drop-in compatibility.
 */

'use strict';

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url.replace(/\/+$/, '');
}

/**
 * Build a default invoice creator bound to LNBits.
 *
 * @param {object} cfg
 * @param {string} cfg.lnbitsUrl       e.g. "https://lnbits.example/"
 * @param {string} cfg.lnbitsApiKey    invoice/read key (NOT admin)
 * @param {number} cfg.satsAmount     invoice amount, sats (LNBits expects sats)
 * @param {function} [cfg.fetchImpl]   defaults to globalThis.fetch
 * @returns {function(memo): Promise<{payment_hash, bolt11}>}
 */
function makeLnbitsInvoiceFn(cfg) {
  const base = normalizeBaseUrl(cfg.lnbitsUrl);
  const key = cfg.lnbitsApiKey;
  const sats = cfg.satsAmount;
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;

  if (!base) throw new Error('makeLnbitsInvoiceFn: lnbitsUrl required');
  if (!key) throw new Error('makeLnbitsInvoiceFn: lnbitsApiKey required');
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('makeLnbitsInvoiceFn: satsAmount must be positive');
  if (typeof fetchImpl !== 'function') throw new Error('makeLnbitsInvoiceFn: fetch unavailable, pass fetchImpl');

  return async function createInvoice(memo) {
    const res = await fetchImpl(`${base}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
      },
      body: JSON.stringify({
        out: false,
        amount: sats,
        memo: typeof memo === 'string' ? memo : 'mcp-pay-gate',
      }),
    });
    if (!res || res.status >= 400) {
      const text = res && typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`lnbits invoice mint failed: status ${res && res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    const paymentHash = body && (body.payment_hash || body.checking_id);
    const bolt11 = body && (body.bolt11 || body.payment_request);
    if (!paymentHash || !bolt11) {
      throw new Error('lnbits invoice mint returned incomplete payload');
    }
    return { payment_hash: paymentHash, bolt11 };
  };
}

/**
 * Build a default paid-check function bound to LNBits.
 *
 * @param {object} cfg
 * @param {string} cfg.lnbitsUrl
 * @param {string} cfg.lnbitsApiKey
 * @param {function} [cfg.fetchImpl]
 * @returns {function(payment_hash): Promise<boolean>}
 */
function makeLnbitsCheckPaidFn(cfg) {
  const base = normalizeBaseUrl(cfg.lnbitsUrl);
  const key = cfg.lnbitsApiKey;
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;

  if (!base) throw new Error('makeLnbitsCheckPaidFn: lnbitsUrl required');
  if (!key) throw new Error('makeLnbitsCheckPaidFn: lnbitsApiKey required');
  if (typeof fetchImpl !== 'function') throw new Error('makeLnbitsCheckPaidFn: fetch unavailable, pass fetchImpl');

  return async function checkPaid(paymentHash) {
    const res = await fetchImpl(`${base}/api/v1/payments/${encodeURIComponent(paymentHash)}`, {
      method: 'GET',
      headers: { 'X-Api-Key': key },
    });
    if (!res || res.status >= 400) return false;
    const body = await res.json();
    return !!(body && (body.paid === true || (body.details && body.details.paid === true)));
  };
}

module.exports = { makeLnbitsInvoiceFn, makeLnbitsCheckPaidFn };
