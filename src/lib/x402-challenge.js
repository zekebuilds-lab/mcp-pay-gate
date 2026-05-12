/**
 * @powforge/mcp-pay-gate — x402-bip122-exact challenge builder
 *
 * Mints a fresh BOLT11 invoice via the configured `invoiceFn` (default
 * LNBits) and packages it into a `PaymentRequirements` object per spec §19
 * (research/h-mcp-auth-1-log.md).
 *
 * Two outputs are needed for an x402 challenge:
 *   1. The `PaymentRequirements` JSON object — emitted in the 402 body.
 *   2. A WWW-Authenticate header string advertising the scheme.
 *
 * The full `PaymentRequirements` is also base64-encoded inside the header
 * via the `requirements` parameter so callers that only read headers
 * (curl, simple HTTP clients) can still extract everything.
 */

'use strict';

const {
  NETWORK_MAINNET,
  SCHEME_EXACT,
  ASSET_BTC,
  PAY_TO_ANON,
  PAYMENT_METHOD_LIGHTNING,
} = require('./x402-verify.js');

const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;

/**
 * Mint a fresh invoice and build the PaymentRequirements payload.
 *
 * @param {object} ctx
 * @param {function} ctx.invoiceFn   async ({ memo? }) -> { payment_hash, bolt11 }
 *                                   Some adapters take memo as a positional arg
 *                                   (mcp-l402-gate-style). We try both.
 * @param {string|number} ctx.priceMsat   amount in millisats (string preferred)
 * @param {string} [ctx.network]      CAIP-2 chain id, default mainnet
 * @param {number} [ctx.maxTimeoutSeconds]
 * @param {string} [ctx.memo]
 * @param {object} [ctx.mintedInvoices] optional Map-like — if present, the
 *                                      payment_hash gets recorded here so the
 *                                      verifier's step-6 check can succeed.
 * @returns {Promise<{ requirements, paymentHash, invoice }>}
 */
async function buildX402PaymentRequirements(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('x402-challenge: ctx required');
  const invoiceFn = ctx.invoiceFn;
  if (typeof invoiceFn !== 'function') throw new Error('x402-challenge: invoiceFn required');
  const priceMsat = ctx.priceMsat;
  if (priceMsat == null || (typeof priceMsat !== 'string' && typeof priceMsat !== 'number')) {
    throw new Error('x402-challenge: priceMsat required');
  }

  const network = ctx.network || NETWORK_MAINNET;
  const maxTimeoutSeconds = Number.isFinite(ctx.maxTimeoutSeconds) && ctx.maxTimeoutSeconds > 0
    ? ctx.maxTimeoutSeconds
    : DEFAULT_MAX_TIMEOUT_SECONDS;
  const memo = ctx.memo || 'mcp-pay-gate x402';

  // mcp-l402-gate's invoiceFn takes `memo` positionally; we honor that
  // contract and document it in the JSDoc above. Operators with a different
  // shape wrap the adapter themselves.
  const mint = await invoiceFn(memo);

  if (!mint || typeof mint !== 'object') {
    throw new Error('x402-challenge: invoiceFn returned no payload');
  }
  const paymentHash = mint.payment_hash || mint.paymentHash;
  const bolt11 = mint.bolt11 || mint.paymentRequest || mint.payment_request;
  if (!paymentHash || !bolt11) {
    throw new Error('x402-challenge: invoiceFn payload missing payment_hash or bolt11');
  }

  if (ctx.mintedInvoices && typeof ctx.mintedInvoices.set === 'function') {
    ctx.mintedInvoices.set(paymentHash, { mintedAt: Date.now() });
  }

  const requirements = {
    scheme: SCHEME_EXACT,
    network,
    amount: String(priceMsat),
    asset: ASSET_BTC,
    payTo: PAY_TO_ANON,
    maxTimeoutSeconds,
    extra: {
      paymentMethod: PAYMENT_METHOD_LIGHTNING,
      invoice: bolt11,
    },
  };

  return { requirements, paymentHash, invoice: bolt11 };
}

/**
 * Format the WWW-Authenticate header value for x402.
 *
 * Two forms supported:
 *   - Compact: `x402 scheme="exact", network="...", amount="..."`
 *   - With base64 requirements: appends `, requirements="<b64>"` so callers
 *     that only inspect headers still get the full PaymentRequirements.
 */
function formatX402Header(requirements, opts = {}) {
  const includeRequirements = opts.includeRequirements !== false;
  const parts = [
    `scheme="${requirements.scheme}"`,
    `network="${requirements.network}"`,
    `amount="${requirements.amount}"`,
  ];
  if (includeRequirements) {
    const b64 = Buffer.from(JSON.stringify(requirements), 'utf-8').toString('base64');
    parts.push(`requirements="${b64}"`);
  }
  return `x402 ${parts.join(', ')}`;
}

module.exports = {
  buildX402PaymentRequirements,
  formatX402Header,
  DEFAULT_MAX_TIMEOUT_SECONDS,
};
