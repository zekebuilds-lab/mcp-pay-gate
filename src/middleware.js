/**
 * @powforge/mcp-pay-gate — middleware
 *
 * Drop-in Express middleware that accepts two Lightning payment rails:
 *
 *   1. L402 (legacy)            Authorization: L402 <macaroon>:<preimage>
 *   2. x402-bip122-exact (new)  Authorization: x402 <base64-PaymentPayload>
 *                               OR  X-PAYMENT: <base64-PaymentPayload>
 *
 * Both rails settle to the same LNBits Lightning backend. Operators do
 * not have to pick a rail; the middleware advertises both in the 402
 * challenge and accepts whichever the caller sends.
 *
 * Why dual-rail: x402 PR #1311 adds bip122-exact so the x402 spec absorbs
 * Lightning settlement. Existing L402 clients still work; new x402 clients
 * also work. One backend serves both during the migration window.
 *
 * Test seams (all overridable for tests):
 *   verifyL402Fn(token, ctx) -> { ok, reason?, payload? }
 *   verifyX402Fn(rawHeader, ctx) -> { ok, reason?, payload? }
 *   invoiceFn(memo) -> { payment_hash, bolt11 }
 *   checkPaidFn(payment_hash) -> Promise<boolean>
 *   settlementCache: { isSettled, markSettled, prune, size }
 *   mintedInvoices: Map-like
 *   decodeBolt11Fn: override BOLT11 decoder (defaults to light-bolt11-decoder)
 *   nowFn: () -> ms epoch (for expiry tests)
 *
 * Defaults forward L402 to ${POW_GATE_URL}/v1/verify.
 *
 * x402 verification follows the 10-step spec from
 * research/h-mcp-auth-1-log.md §20 (cross-checked against PR #1873
 * facilitator.py).
 */

'use strict';

const {
  makeLnbitsInvoiceFn,
  makeLnbitsCheckPaidFn,
} = require('./lib/lnbits.js');
const {
  createSettlementCache,
} = require('./lib/settlement-cache.js');
const {
  verifyX402Payment,
  parsePaymentPayloadHeader,
  buildSettlementResponse,
  encodeSettlementResponseHeader,
  NETWORK_MAINNET,
} = require('./lib/x402-verify.js');
const {
  buildX402PaymentRequirements,
  formatX402Header,
} = require('./lib/x402-challenge.js');

const DEFAULT_POW_GATE_URL = 'https://gate.powforge.dev';
const DEFAULT_X402_PRICE_MSAT = 3000; // 3 sats

function buildL402Challenge(opts) {
  const macaroon = opts.macaroon || 'pending';
  const invoice = opts.invoice || 'pending';
  return `L402 macaroon="${macaroon}", invoice="${invoice}"`;
}

/**
 * Legacy compact x402 challenge string (no minted invoice). Used as a
 * fallback when an LNBits invoiceFn is not configured. New callers should
 * prefer `formatX402Header(requirements)` which embeds a real invoice.
 */
function buildX402Challenge(opts) {
  const network = opts.network || NETWORK_MAINNET;
  const scheme = opts.scheme || 'exact';
  const amount = opts.amount != null ? opts.amount : (opts.satsAmount != null ? opts.satsAmount : 10);
  const recipient = opts.recipient || 'lnbits:invoice-on-demand';
  return `x402 scheme="${scheme}", network="${network}", amount="${amount}", recipient="${recipient}"`;
}

async function defaultVerifyL402(token, ctx) {
  const gateUrl = ctx.gateUrl || DEFAULT_POW_GATE_URL;
  try {
    const res = await fetch(`${gateUrl}/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      return { ok: false, reason: `gate_${res.status}` };
    }
    const payload = await res.json().catch(() => ({}));
    return { ok: payload.ok === true, reason: payload.reason, payload };
  } catch (err) {
    return { ok: false, reason: 'gate_unreachable' };
  }
}

/**
 * Default x402 verifier — runs the 10-step verification against the
 * PaymentRequirements that the middleware most-recently emitted in its
 * 402 challenge. The middleware tracks `lastRequirementsByHash` so this
 * verifier can find the correct requirements record by payment_hash.
 *
 * Tests inject a different verifyX402Fn to skip the full lookup dance.
 */
function makeDefaultVerifyX402(cfg) {
  return async function defaultVerifyX402(rawHeaderValue, ctx) {
    const payload = parsePaymentPayloadHeader(rawHeaderValue);
    if (!payload) {
      return { ok: false, reason: 'payload_unparseable' };
    }

    // The client echoes the requirements inside payload.accepted. We trust
    // that as the "what was offered" side, but we still cross-check against
    // our minted-invoices store via step 6 in the verifier so a hostile
    // client cannot fabricate an offering.
    const requirements = payload.accepted;
    if (!requirements || typeof requirements !== 'object') {
      return { ok: false, reason: 'accepted_missing' };
    }

    const result = await verifyX402Payment(payload, requirements, {
      decodeBolt11Fn: cfg.decodeBolt11Fn,
      checkPaidFn: cfg.checkPaidFn,
      settlementCache: cfg.settlementCache,
      mintedInvoices: cfg.mintedInvoices,
      nowFn: cfg.nowFn,
    });

    if (!result.verified) {
      return { ok: false, reason: result.reason };
    }

    // Build a SettlementResponse for the PAYMENT-RESPONSE header.
    const settlement = buildSettlementResponse({
      paymentHash: result.paymentHash,
      network: requirements.network,
      invoice: requirements.extra && requirements.extra.invoice,
    });

    return {
      ok: true,
      payload: {
        rail: result.rail,
        paymentHash: result.paymentHash,
        amountMsat: result.amountMsat,
        settlementResponseHeader: encodeSettlementResponseHeader(settlement),
      },
    };
  };
}

function createMcpPayGate(config = {}) {
  const cfg = {
    gateUrl: config.gateUrl || process.env.POW_GATE_URL || DEFAULT_POW_GATE_URL,
    network: config.network || NETWORK_MAINNET,
    scheme: config.scheme || 'exact',
    recipient: config.recipient || 'lnbits:invoice-on-demand',

    // Lightning backend (LNBits)
    lnbitsUrl: config.lnbitsUrl || process.env.LNBITS_URL,
    lnbitsApiKey: config.lnbitsApiKey || process.env.LNBITS_INVOICE_KEY || process.env.LNBITS_ADMIN_KEY,

    // Pricing — x402 spec uses msats. Legacy `satsAmount` still supported
    // as a fallback (multiplied by 1000 if msat not provided).
    x402PriceMsat: config.x402PriceMsat
      || (config.satsAmount != null ? config.satsAmount * 1000 : DEFAULT_X402_PRICE_MSAT),
    satsAmount: config.satsAmount != null ? config.satsAmount : 10,

    // Verifier seams
    verifyL402Fn: config.verifyL402Fn || defaultVerifyL402,
    verifyX402Fn: config.verifyX402Fn, // populated below if not provided

    // x402 implementation seams
    invoiceFn: config.invoiceFn,
    checkPaidFn: config.checkPaidFn,
    settlementCache: config.settlementCache || createSettlementCache(),
    // mintedInvoices is opt-in. When set, the verifier enforces step-6
    // "invoice was minted by THIS server" (research §20). The challenge-
    // emitter populates the map on each mint. Operators not minting
    // (proxy/relay setups) leave this null and rely on the LNBits
    // paid-check (step 10) as the sole authentication.
    mintedInvoices: config.mintedInvoices || null,
    decodeBolt11Fn: config.decodeBolt11Fn,
    nowFn: config.nowFn,
    fetchImpl: config.fetchImpl,
  };

  // Lazy-build LNBits adapters if the operator gave us URL+key but no
  // pre-built fns. This makes `createMcpPayGate({ lnbitsUrl, lnbitsApiKey })`
  // a one-line setup for the common case.
  if (!cfg.invoiceFn && cfg.lnbitsUrl && cfg.lnbitsApiKey) {
    cfg.invoiceFn = makeLnbitsInvoiceFn({
      lnbitsUrl: cfg.lnbitsUrl,
      lnbitsApiKey: cfg.lnbitsApiKey,
      satsAmount: Math.max(1, Math.ceil(Number(cfg.x402PriceMsat) / 1000)),
      fetchImpl: cfg.fetchImpl,
    });
  }
  if (!cfg.checkPaidFn && cfg.lnbitsUrl && cfg.lnbitsApiKey) {
    cfg.checkPaidFn = makeLnbitsCheckPaidFn({
      lnbitsUrl: cfg.lnbitsUrl,
      lnbitsApiKey: cfg.lnbitsApiKey,
      fetchImpl: cfg.fetchImpl,
    });
  }

  // When this middleware is the SAME server that mints challenges (the
  // expected end-to-end deployment), wire a default mintedInvoices Map so
  // step-6 enforcement kicks in. The challenge-mint path populates this
  // Map via buildX402PaymentRequirements.
  if (cfg.mintedInvoices == null && typeof cfg.invoiceFn === 'function') {
    cfg.mintedInvoices = new Map();
  }

  if (!cfg.verifyX402Fn) {
    cfg.verifyX402Fn = makeDefaultVerifyX402(cfg);
  }

  /**
   * Mint a fresh PaymentRequirements (with a real BOLT11 invoice) for the
   * x402 challenge. Returns a string for WWW-Authenticate. Falls back to
   * the legacy compact challenge when no invoiceFn is wired (tests, dev).
   */
  async function mintX402ChallengeHeader() {
    if (typeof cfg.invoiceFn !== 'function') {
      return buildX402Challenge({
        network: cfg.network,
        scheme: cfg.scheme,
        amount: cfg.x402PriceMsat,
        recipient: cfg.recipient,
      });
    }
    try {
      const { requirements } = await buildX402PaymentRequirements({
        invoiceFn: cfg.invoiceFn,
        priceMsat: cfg.x402PriceMsat,
        network: cfg.network,
        mintedInvoices: cfg.mintedInvoices,
      });
      return formatX402Header(requirements);
    } catch (_err) {
      // Mint failure shouldn't take down the whole 402 — the L402 rail
      // still works. Emit the compact challenge with no invoice.
      return buildX402Challenge({
        network: cfg.network,
        scheme: cfg.scheme,
        amount: cfg.x402PriceMsat,
        recipient: cfg.recipient,
      });
    }
  }

  async function challenge402(res) {
    const l402 = buildL402Challenge({});
    const x402 = await mintX402ChallengeHeader();
    res.setHeader('WWW-Authenticate', [l402, x402]);
    res.status(402).json({
      error: 'payment required',
      rails: [
        { name: 'l402', challenge: l402 },
        { name: 'x402-bip122-exact', challenge: x402 },
      ],
      docs: 'https://powforge.dev/mcp',
    });
  }

  async function middleware(req, res, next) {
    const auth = (req.headers && req.headers['authorization']) || '';
    const xPayment = (req.headers && req.headers['x-payment']) || '';

    // No auth at all -> dual-rail challenge.
    if (!auth && !xPayment) {
      return challenge402(res);
    }

    // L402 token branch.
    if (auth.startsWith('L402 ')) {
      const token = auth.slice(5).trim();
      const result = await cfg.verifyL402Fn(token, { gateUrl: cfg.gateUrl });
      if (result && result.ok) {
        req.payAuth = { rail: 'l402', payload: result.payload || {} };
        return next();
      }
      res.setHeader('WWW-Authenticate', buildL402Challenge({}));
      return res.status(401).json({
        error: 'invalid l402 token',
        reason: (result && result.reason) || 'unknown',
      });
    }

    // x402 token branch (header form OR X-PAYMENT header).
    const x402Payload = auth.startsWith('x402 ') ? auth.slice(5).trim() : xPayment;
    if (x402Payload) {
      const result = await cfg.verifyX402Fn(x402Payload, { gateUrl: cfg.gateUrl });
      if (result && result.ok) {
        const p = result.payload || {};
        req.payAuth = {
          rail: p.rail || 'x402-bip122-exact',
          paymentHash: p.paymentHash,
          amountMsat: p.amountMsat,
          payload: p,
        };
        if (p.settlementResponseHeader) {
          res.setHeader('PAYMENT-RESPONSE', p.settlementResponseHeader);
        }
        return next();
      }
      // Re-emit dual-rail 402 so the caller can retry / fall back to L402.
      return challenge402(res);
    }

    // Auth header present but unrecognized scheme.
    return challenge402(res);
  }

  return { middleware, config: cfg };
}

function createPayGateMiddleware(config) {
  return createMcpPayGate(config).middleware;
}

function mcpPayGateMiddleware(config) {
  return createMcpPayGate(config).middleware;
}

module.exports = {
  createMcpPayGate,
  createPayGateMiddleware,
  mcpPayGateMiddleware,
  buildL402Challenge,
  buildX402Challenge,
  defaultVerifyL402,
  makeDefaultVerifyX402,
  DEFAULT_POW_GATE_URL,
  DEFAULT_X402_PRICE_MSAT,
};
