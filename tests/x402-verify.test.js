/**
 * @powforge/mcp-pay-gate — x402-verify library unit tests
 *
 * Granular coverage for the 10-step verifier in `src/lib/x402-verify.js`,
 * exercising each rejection branch and the happy path. These tests run
 * against the verifier directly (no middleware wrapper) so a regression
 * in any single step shows up as a precise failure.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyX402Payment,
  parsePaymentPayloadHeader,
  buildSettlementResponse,
  encodeSettlementResponseHeader,
  NETWORK_MAINNET,
  createSettlementCache,
} = require('../src/index.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HASH = 'b'.repeat(64);
const AMOUNT = '5000';
const BOLT11 = 'lnbc-fake-fixture';

function reqs(over = {}) {
  return {
    scheme: 'exact',
    network: NETWORK_MAINNET,
    amount: AMOUNT,
    asset: 'BTC',
    payTo: 'anonymous',
    maxTimeoutSeconds: 3600,
    extra: { paymentMethod: 'lightning', invoice: BOLT11 },
    ...over,
  };
}

function pay(requirements, over = {}) {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { invoice: requirements.extra.invoice },
    ...over,
  };
}

function decoder(over = {}) {
  return () => ({
    payment_hash: HASH,
    amount_msat: AMOUNT,
    timestamp: Math.floor(Date.now() / 1000),
    expiry: 3600,
    ...over,
  });
}

function ctx(over = {}) {
  return {
    decodeBolt11Fn: decoder(),
    checkPaidFn: async () => true,
    settlementCache: createSettlementCache(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Step-by-step rejection coverage
// ---------------------------------------------------------------------------

test('step 1: scheme mismatch rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.accepted = { ...p.accepted, scheme: 'wrong' };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'scheme_mismatch');
});

test('step 2: network mismatch rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.accepted = { ...p.accepted, network: 'bip122:wrong' };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'network_mismatch');
});

test('step 3: asset mismatch rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.accepted = { ...p.accepted, asset: 'ETH' };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'asset_mismatch');
});

test('step 3b: payTo mismatch rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.accepted = { ...p.accepted, payTo: 'someone-else' };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'pay_to_mismatch');
});

test('step 4: paymentMethod mismatch rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.accepted = { ...p.accepted, extra: { ...p.accepted.extra, paymentMethod: 'liquid' } };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'payment_method_mismatch');
});

test('step 5: invoice substitution rejects', async () => {
  const r = reqs();
  const p = pay(r);
  p.payload = { invoice: 'lnbc-different-invoice' };
  const result = await verifyX402Payment(p, r, ctx());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invoice_substitution');
});

test('step 6: invoice not in mintedInvoices rejects when store is wired', async () => {
  const r = reqs();
  const p = pay(r);
  const c = ctx({ mintedInvoices: new Map() }); // empty
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invoice_not_issued_here');
});

test('step 6: invoice in mintedInvoices passes the issued-here check', async () => {
  const r = reqs();
  const p = pay(r);
  const minted = new Map([[HASH, { mintedAt: Date.now() }]]);
  const c = ctx({ mintedInvoices: minted });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, true);
});

test('step 8: expired invoice rejects', async () => {
  const r = reqs();
  const p = pay(r);
  // timestamp far in the past + small expiry == expired
  const c = ctx({
    decodeBolt11Fn: decoder({ timestamp: Math.floor(Date.now() / 1000) - 7200, expiry: 3600 }),
  });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invoice_expired');
});

test('step 9: amount mismatch rejects (decoded != requirements.amount)', async () => {
  const r = reqs();
  const p = pay(r);
  const c = ctx({ decodeBolt11Fn: decoder({ amount_msat: '9999' }) });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'amount_mismatch');
});

test('step 10a: replay rejects before LNBits is queried', async () => {
  const r = reqs();
  const p = pay(r);
  const cache = createSettlementCache();
  cache.markSettled(HASH);
  let lnbitsCalled = false;
  const c = ctx({
    settlementCache: cache,
    checkPaidFn: async () => { lnbitsCalled = true; return true; },
  });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'replay_detected');
  assert.equal(lnbitsCalled, false, 'replay must short-circuit before LNBits');
});

test('step 10b: LNBits paid=false rejects', async () => {
  const r = reqs();
  const p = pay(r);
  const c = ctx({ checkPaidFn: async () => false });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'invoice_not_paid');
});

test('step 10b: LNBits throw rejects with lnbits_unreachable', async () => {
  const r = reqs();
  const p = pay(r);
  const c = ctx({ checkPaidFn: async () => { throw new Error('connection refused'); } });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'lnbits_unreachable');
});

test('happy path: verified + cache populated', async () => {
  const r = reqs();
  const p = pay(r);
  const cache = createSettlementCache();
  const c = ctx({ settlementCache: cache });
  const result = await verifyX402Payment(p, r, c);
  assert.equal(result.verified, true);
  assert.equal(result.paymentHash, HASH);
  assert.equal(result.amountMsat, AMOUNT);
  assert.equal(result.rail, 'x402-bip122-exact');
  assert.equal(cache.isSettled(HASH), true);
});

// ---------------------------------------------------------------------------
// Helper unit tests
// ---------------------------------------------------------------------------

test('parsePaymentPayloadHeader strips x402 prefix and decodes b64 JSON', () => {
  const obj = { x402Version: 2, accepted: { scheme: 'exact' }, payload: { invoice: 'x' } };
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
  assert.deepEqual(parsePaymentPayloadHeader('x402 ' + b64), obj);
  assert.deepEqual(parsePaymentPayloadHeader(b64), obj);
});

test('parsePaymentPayloadHeader returns null for malformed input', () => {
  assert.equal(parsePaymentPayloadHeader('not-base64-or-json'), null);
  assert.equal(parsePaymentPayloadHeader(''), null);
  assert.equal(parsePaymentPayloadHeader(null), null);
});

test('buildSettlementResponse + encodeSettlementResponseHeader roundtrip', () => {
  const sr = buildSettlementResponse({
    paymentHash: HASH,
    network: NETWORK_MAINNET,
    invoice: BOLT11,
    settledAt: 1739116800,
  });
  assert.equal(sr.success, true);
  assert.equal(sr.transaction, HASH);
  assert.equal(sr.network, NETWORK_MAINNET);
  assert.equal(sr.payer, 'anonymous');
  assert.equal(sr.extra.invoice, BOLT11);
  assert.equal(sr.extra.settledAt, 1739116800);

  const b64 = encodeSettlementResponseHeader(sr);
  const round = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  assert.deepEqual(round, sr);
});
