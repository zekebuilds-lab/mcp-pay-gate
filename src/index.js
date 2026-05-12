/**
 * @powforge/mcp-pay-gate
 *
 * Dual-rail Lightning paywall middleware for MCP servers. Accepts L402
 * macaroons (legacy clients) and x402-bip122-exact payments (forward-compat
 * clients), settling both into the same LNBits backend.
 *
 * v0.2.0 — real x402-bip122-exact verifier (research/h-mcp-auth-1-log §20).
 *
 * Public exports:
 *   createMcpPayGate(config)          factory returning { middleware, config }
 *   createPayGateMiddleware(config)   shorthand for { middleware }
 *   mcpPayGateMiddleware(config)      Express-shaped middleware function
 *   buildL402Challenge(opts)          string for WWW-Authenticate
 *   buildX402Challenge(opts)          legacy compact x402 challenge string
 *   formatX402Header(requirements)    invoice-bearing x402 header
 *   buildX402PaymentRequirements      mint+package PaymentRequirements
 *   verifyX402Payment(payload, req)   raw 10-step verifier
 *   parsePaymentPayloadHeader         decode base64 PaymentPayload
 *   buildSettlementResponse           SettlementResponse builder
 *   encodeSettlementResponseHeader    base64 the SettlementResponse
 *   createSettlementCache             in-memory replay cache
 *   makeLnbitsInvoiceFn               LNBits invoice mint adapter
 *   makeLnbitsCheckPaidFn             LNBits paid-check adapter
 *   defaultVerifyL402                 override seam for L402 path
 *   makeDefaultVerifyX402             factory for default x402 verifier
 *   DEFAULT_POW_GATE_URL              constant
 *   DEFAULT_X402_PRICE_MSAT           constant (3000 msat = 3 sats)
 *   NETWORK_MAINNET                   bip122 CAIP-2 mainnet id
 *   VERSION                           package version string
 */

'use strict';

const {
  createMcpPayGate,
  createPayGateMiddleware,
  mcpPayGateMiddleware,
  buildL402Challenge,
  buildX402Challenge,
  defaultVerifyL402,
  makeDefaultVerifyX402,
  DEFAULT_POW_GATE_URL,
  DEFAULT_X402_PRICE_MSAT,
} = require('./middleware.js');

const {
  verifyX402Payment,
  parsePaymentPayloadHeader,
  buildSettlementResponse,
  encodeSettlementResponseHeader,
  defaultDecodeBolt11,
  NETWORK_MAINNET,
  SCHEME_EXACT,
  ASSET_BTC,
  PAY_TO_ANON,
  PAYMENT_METHOD_LIGHTNING,
} = require('./lib/x402-verify.js');

const {
  buildX402PaymentRequirements,
  formatX402Header,
} = require('./lib/x402-challenge.js');

const {
  createSettlementCache,
  DEFAULT_TTL_MS,
} = require('./lib/settlement-cache.js');

const {
  makeLnbitsInvoiceFn,
  makeLnbitsCheckPaidFn,
} = require('./lib/lnbits.js');

const VERSION = '0.2.0';

module.exports = {
  // Factories / middleware
  createMcpPayGate,
  createPayGateMiddleware,
  mcpPayGateMiddleware,

  // Challenge builders
  buildL402Challenge,
  buildX402Challenge,
  buildX402PaymentRequirements,
  formatX402Header,

  // Verifier internals
  verifyX402Payment,
  parsePaymentPayloadHeader,
  buildSettlementResponse,
  encodeSettlementResponseHeader,
  defaultDecodeBolt11,
  defaultVerifyL402,
  makeDefaultVerifyX402,

  // Replay cache
  createSettlementCache,
  DEFAULT_TTL_MS,

  // LNBits adapter
  makeLnbitsInvoiceFn,
  makeLnbitsCheckPaidFn,

  // Constants
  DEFAULT_POW_GATE_URL,
  DEFAULT_X402_PRICE_MSAT,
  NETWORK_MAINNET,
  SCHEME_EXACT,
  ASSET_BTC,
  PAY_TO_ANON,
  PAYMENT_METHOD_LIGHTNING,
  VERSION,
};
