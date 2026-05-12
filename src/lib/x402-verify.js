/**
 * @powforge/mcp-pay-gate — x402-bip122-exact verifier
 *
 * 10-step verification per x402-foundation/x402 PR #1311 spec, cross-checked
 * against the Python reference implementation in PR #1873
 * (research/h-mcp-auth-1-log.md §20).
 *
 * Wire format (research §19):
 *
 *   PaymentRequirements (server emits in 402 challenge body):
 *     {
 *       scheme: "exact",
 *       network: "bip122:000000000019d6689c085ae165831e93",
 *       amount: "<msat string>",
 *       asset: "BTC",
 *       payTo: "anonymous",
 *       maxTimeoutSeconds: 3600,
 *       extra: { paymentMethod: "lightning", invoice: "<bolt11>" }
 *     }
 *
 *   PaymentPayload (client sends in X-PAYMENT or Authorization: x402 <b64>):
 *     {
 *       x402Version: 2,
 *       resource: { url, description, mimeType },
 *       accepted: <full requirements quoted to client>,
 *       payload: { invoice: "<bolt11>" }
 *     }
 *
 * Seams (all optional, all overridable for tests):
 *   - decodeBolt11Fn(bolt11) -> { payment_hash, amount_msat, timestamp, expiry }
 *   - checkPaidFn(payment_hash) -> Promise<boolean>
 *   - settlementCache: { isSettled, markSettled }
 *   - mintedInvoices: { has(payment_hash) } (optional; if absent, step 6 skipped)
 *   - nowFn() -> ms epoch
 *
 * On success returns:
 *   { verified: true, paymentHash, amountMsat, rail: 'x402-bip122-exact' }
 *
 * On failure returns:
 *   { verified: false, reason: '<reason_token>' }
 */

'use strict';

const NETWORK_MAINNET = 'bip122:000000000019d6689c085ae165831e93';
const SCHEME_EXACT = 'exact';
const ASSET_BTC = 'BTC';
const PAY_TO_ANON = 'anonymous';
const PAYMENT_METHOD_LIGHTNING = 'lightning';

/**
 * Decode a base64 string back to a JSON object.
 */
function decodeBase64Json(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const text = buf.toString('utf-8');
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

/**
 * Default BOLT11 decoder using `light-bolt11-decoder`. Lazy-loaded so the
 * package can be required in environments where the decoder isn't installed
 * (tests inject decodeBolt11Fn instead).
 */
function defaultDecodeBolt11(bolt11) {
  // eslint-disable-next-line global-require
  const { decode } = require('light-bolt11-decoder');
  const decoded = decode(bolt11);

  // light-bolt11-decoder returns:
  //   { paymentRequest, sections: [...], expiry, route_hints }
  // Section objects have `name` + `value` (string) or `letters` keys.
  let paymentHash = null;
  let amountMsat = null;
  let timestamp = null;
  let expiry = decoded.expiry;

  for (const s of decoded.sections || []) {
    if (s.name === 'payment_hash') paymentHash = s.value;
    else if (s.name === 'amount') amountMsat = s.value; // string of msats
    else if (s.name === 'timestamp') timestamp = s.value; // unix seconds
    else if (s.name === 'expiry' && expiry == null) expiry = s.value;
  }

  return {
    payment_hash: paymentHash,
    amount_msat: amountMsat,
    timestamp,
    expiry,
  };
}

/**
 * Parse an Authorization header or X-PAYMENT header into a PaymentPayload.
 *
 * Authorization: x402 <b64>   -> strip prefix
 * X-PAYMENT: <b64>            -> use as-is
 */
function parsePaymentPayloadHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return null;
  let b64 = headerValue.trim();
  if (b64.startsWith('x402 ')) b64 = b64.slice(5).trim();
  return decodeBase64Json(b64);
}

/**
 * Run the 10-step verifier on a parsed PaymentPayload + PaymentRequirements.
 *
 * @param {object} payload     PaymentPayload (already parsed from base64 JSON)
 * @param {object} requirements PaymentRequirements the server originally emitted
 * @param {object} ctx         { decodeBolt11Fn?, checkPaidFn, settlementCache, mintedInvoices?, nowFn? }
 * @returns {Promise<{ verified, paymentHash?, amountMsat?, rail?, reason? }>}
 */
async function verifyX402Payment(payload, requirements, ctx = {}) {
  const decodeBolt11 = ctx.decodeBolt11Fn || defaultDecodeBolt11;
  const checkPaid = ctx.checkPaidFn;
  const cache = ctx.settlementCache;
  const minted = ctx.mintedInvoices; // optional Map-like with has()
  const nowFn = ctx.nowFn || (() => Date.now());

  if (!payload || typeof payload !== 'object') {
    return { verified: false, reason: 'payload_invalid' };
  }
  if (!requirements || typeof requirements !== 'object') {
    return { verified: false, reason: 'requirements_invalid' };
  }
  if (typeof checkPaid !== 'function') {
    return { verified: false, reason: 'checkPaidFn_required' };
  }
  if (!cache || typeof cache.isSettled !== 'function' || typeof cache.markSettled !== 'function') {
    return { verified: false, reason: 'settlement_cache_required' };
  }

  const accepted = payload.accepted;
  if (!accepted || typeof accepted !== 'object') {
    return { verified: false, reason: 'payload_accepted_missing' };
  }

  // Step 1: scheme matches
  if (accepted.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
    return { verified: false, reason: 'scheme_mismatch' };
  }

  // Step 2: network matches between client-quoted accepted and the
  // requirements record. Operators running testnet override requirements.network
  // upstream; the verifier does not pin to mainnet itself.
  if (accepted.network !== requirements.network) {
    return { verified: false, reason: 'network_mismatch' };
  }

  // Step 3: asset + payTo match (literals per spec)
  if (accepted.asset !== ASSET_BTC || requirements.asset !== ASSET_BTC) {
    return { verified: false, reason: 'asset_mismatch' };
  }
  if (accepted.payTo !== PAY_TO_ANON || requirements.payTo !== PAY_TO_ANON) {
    return { verified: false, reason: 'pay_to_mismatch' };
  }

  // Step 4: paymentMethod literal lightning on both sides
  const acceptedExtra = accepted.extra || {};
  const reqExtra = requirements.extra || {};
  if (acceptedExtra.paymentMethod !== PAYMENT_METHOD_LIGHTNING
      || reqExtra.paymentMethod !== PAYMENT_METHOD_LIGHTNING) {
    return { verified: false, reason: 'payment_method_mismatch' };
  }

  // Step 5: invoice consistency across payload.payload, payload.accepted.extra,
  // and the server's requirements.extra.
  const payloadInvoice = payload.payload && payload.payload.invoice;
  const acceptedInvoice = acceptedExtra.invoice;
  const reqInvoice = reqExtra.invoice;
  if (!payloadInvoice || !acceptedInvoice || !reqInvoice) {
    return { verified: false, reason: 'invoice_missing' };
  }
  if (payloadInvoice !== acceptedInvoice || acceptedInvoice !== reqInvoice) {
    return { verified: false, reason: 'invoice_substitution' };
  }

  // Step 7 (decode early so step 6 can also key off paymentHash): BOLT11 decode
  let decoded;
  try {
    decoded = decodeBolt11(payloadInvoice);
  } catch (_err) {
    return { verified: false, reason: 'bolt11_decode_failed' };
  }
  if (!decoded || !decoded.payment_hash || !decoded.amount_msat) {
    return { verified: false, reason: 'bolt11_decode_incomplete' };
  }

  const paymentHash = decoded.payment_hash;
  const amountMsat = String(decoded.amount_msat);
  const timestamp = Number(decoded.timestamp) || 0;
  const expiry = Number(decoded.expiry) || 0;

  // Step 6: invoice issued by THIS server (optional check — only enforced if
  // mintedInvoices is wired). Ops without a minted-invoices store accept any
  // valid + paid invoice; LNBits paid-check then provides the auth.
  if (minted && typeof minted.has === 'function') {
    if (!minted.has(paymentHash)) {
      return { verified: false, reason: 'invoice_not_issued_here' };
    }
  }

  // Step 8: not expired (timestamp + expiry > now)
  const nowMs = nowFn();
  const expiresAtMs = (timestamp + expiry) * 1000;
  if (expiresAtMs > 0 && expiresAtMs < nowMs) {
    return { verified: false, reason: 'invoice_expired' };
  }

  // Step 9: amount equals requirements.amount (msat string compare to avoid
  // float drift; spec says EXACT).
  if (String(requirements.amount) !== amountMsat) {
    return { verified: false, reason: 'amount_mismatch' };
  }

  // Step 10a: replay check
  if (cache.isSettled(paymentHash)) {
    return { verified: false, reason: 'replay_detected' };
  }

  // Step 10b: LNBits paid-check
  let paid = false;
  try {
    paid = await checkPaid(paymentHash);
  } catch (_err) {
    return { verified: false, reason: 'lnbits_unreachable' };
  }
  if (!paid) {
    return { verified: false, reason: 'invoice_not_paid' };
  }

  // Mark settled with TTL = expiry + 60s buffer (mirrors PR #1873 default).
  const ttlMs = Math.max((expiry + 60) * 1000, 60 * 1000);
  cache.markSettled(paymentHash, ttlMs);

  return {
    verified: true,
    paymentHash,
    amountMsat,
    rail: 'x402-bip122-exact',
  };
}

/**
 * Build a SettlementResponse JSON object per spec §20.
 */
function buildSettlementResponse({ paymentHash, network, invoice, settledAt }) {
  return {
    success: true,
    transaction: paymentHash,
    network: network || NETWORK_MAINNET,
    payer: PAY_TO_ANON,
    extra: {
      invoice,
      settledAt: typeof settledAt === 'number' ? settledAt : Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * Encode a SettlementResponse object as base64 JSON for the PAYMENT-RESPONSE header.
 */
function encodeSettlementResponseHeader(settlementResponse) {
  return Buffer.from(JSON.stringify(settlementResponse), 'utf-8').toString('base64');
}

module.exports = {
  verifyX402Payment,
  parsePaymentPayloadHeader,
  decodeBase64Json,
  defaultDecodeBolt11,
  buildSettlementResponse,
  encodeSettlementResponseHeader,
  NETWORK_MAINNET,
  SCHEME_EXACT,
  ASSET_BTC,
  PAY_TO_ANON,
  PAYMENT_METHOD_LIGHTNING,
};
