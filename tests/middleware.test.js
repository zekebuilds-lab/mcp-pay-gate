/**
 * @powforge/mcp-pay-gate — middleware tests (v0.2.0)
 *
 * Covers:
 *
 *   1. No auth header                          -> 402 with dual-rail WWW-Authenticate
 *   2. Valid L402 token                        -> next() called, req.payAuth populated
 *   3. Invalid L402 token                      -> 401 with L402 challenge
 *   4. x402 verifier seam (negative)           -> 402 dual-rail (fall-through)
 *   5. x402 via X-PAYMENT header is recognized -> verifier seam invoked
 *   6. x402 happy path                         -> next() + req.payAuth.rail x402-bip122-exact
 *   7. x402 not paid                           -> 402 dual-rail
 *   8. x402 replay attack                      -> 402 dual-rail
 *   9. Header builders                         -> well-formed headers
 *
 * x402 happy/not-paid/replay tests use injected `decodeBolt11Fn` +
 * `checkPaidFn` + a pre-built `settlementCache` so no real BOLT11 or
 * LNBits is needed. This matches the spec test pattern in PR #1873.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMcpPayGate,
  buildL402Challenge,
  buildX402Challenge,
  formatX402Header,
  createSettlementCache,
  NETWORK_MAINNET,
  VERSION,
} = require('../src/index.js');

// ---------------------------------------------------------------------------
// Helpers — minimal Express-shape req/res mocks.
// ---------------------------------------------------------------------------

function makeReq({ authorization, xPayment } = {}) {
  const headers = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  if (xPayment !== undefined) headers['x-payment'] = xPayment;
  return { headers };
}

function makeRes() {
  const state = {
    statusCode: null,
    headers: {},
    jsonBody: null,
    ended: false,
  };
  return {
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return state.headers[name.toLowerCase()];
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.jsonBody = body;
      state.ended = true;
      return this;
    },
    _state: state,
  };
}

function makeNext() {
  let called = false;
  let calledWith;
  function next(err) {
    called = true;
    calledWith = err;
  }
  next.wasCalled = () => called;
  next.calledWith = () => calledWith;
  return next;
}

// ---------------------------------------------------------------------------
// Helper — build a valid x402 PaymentPayload + matching requirements.
// ---------------------------------------------------------------------------

const FAKE_PAYMENT_HASH = 'a'.repeat(64);
const FAKE_AMOUNT_MSAT = '3000';
const FAKE_BOLT11 = 'lnbc30n1pjfake-fixture-not-decoded';
const FAKE_NETWORK = NETWORK_MAINNET;

function buildFakeRequirements(overrides = {}) {
  return {
    scheme: 'exact',
    network: FAKE_NETWORK,
    amount: FAKE_AMOUNT_MSAT,
    asset: 'BTC',
    payTo: 'anonymous',
    maxTimeoutSeconds: 3600,
    extra: {
      paymentMethod: 'lightning',
      invoice: FAKE_BOLT11,
    },
    ...overrides,
  };
}

function buildFakePayload(requirements, payloadOverrides = {}) {
  const accepted = requirements;
  const payload = {
    x402Version: 2,
    resource: { url: 'https://example.test/r', description: 'test', mimeType: 'application/json' },
    accepted,
    payload: { invoice: requirements.extra.invoice },
    ...payloadOverrides,
  };
  return payload;
}

function encodeAuthHeader(payload) {
  return 'x402 ' + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

// Stub BOLT11 decoder — returns a deterministic decode for FAKE_BOLT11.
function makeFakeDecodeBolt11({ amountMsat, expiry } = {}) {
  return function fakeDecode(_bolt11) {
    return {
      payment_hash: FAKE_PAYMENT_HASH,
      amount_msat: amountMsat || FAKE_AMOUNT_MSAT,
      timestamp: Math.floor(Date.now() / 1000),
      expiry: expiry != null ? expiry : 3600,
    };
  };
}

// ---------------------------------------------------------------------------
// Path 1 — no auth header at all -> 402 with dual-rail WWW-Authenticate.
// ---------------------------------------------------------------------------

test('no auth header returns 402 with dual-rail WWW-Authenticate', async () => {
  const { middleware } = createMcpPayGate({
    verifyL402Fn: async () => ({ ok: false, reason: 'should-not-be-called' }),
    verifyX402Fn: async () => ({ ok: false, reason: 'should-not-be-called' }),
  });

  const req = makeReq();
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), false, 'next() should NOT be called on 402');
  assert.equal(res._state.statusCode, 402, 'status must be 402');

  const wwwAuth = res._state.headers['www-authenticate'];
  assert.ok(Array.isArray(wwwAuth), 'WWW-Authenticate must be a list (dual-rail)');
  assert.equal(wwwAuth.length, 2, 'must advertise exactly 2 rails');
  assert.ok(
    wwwAuth.some((s) => s.startsWith('L402 ')),
    'must advertise L402 rail',
  );
  assert.ok(
    wwwAuth.some((s) => s.startsWith('x402 ')),
    'must advertise x402 rail',
  );

  assert.ok(res._state.jsonBody, 'must emit JSON body');
  assert.equal(res._state.jsonBody.error, 'payment required');
  assert.ok(Array.isArray(res._state.jsonBody.rails), 'body must include rails array');
  assert.equal(res._state.jsonBody.rails.length, 2);
});

// ---------------------------------------------------------------------------
// Path 2 — valid L402 token -> next() called, req.payAuth populated.
// ---------------------------------------------------------------------------

test('valid L402 token calls next() and populates req.payAuth', async () => {
  const fakePayload = { sub: 'agent-42', sats: 10, rail: 'l402-test' };
  const { middleware } = createMcpPayGate({
    verifyL402Fn: async (token, _ctx) => {
      assert.equal(token, 'macaroon123:preimage456', 'token must be parsed without "L402 " prefix');
      return { ok: true, payload: fakePayload };
    },
  });

  const req = makeReq({ authorization: 'L402 macaroon123:preimage456' });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), true, 'next() must be called on valid L402');
  assert.equal(next.calledWith(), undefined, 'next() must be called without an error');
  assert.equal(res._state.statusCode, null, 'no status code should be set');
  assert.equal(res._state.ended, false, 'response should not be ended');

  assert.ok(req.payAuth, 'req.payAuth must be set');
  assert.equal(req.payAuth.rail, 'l402');
  assert.deepEqual(req.payAuth.payload, fakePayload);
});

// ---------------------------------------------------------------------------
// Path 3 — invalid L402 token -> 401 with L402 challenge header.
// ---------------------------------------------------------------------------

test('invalid L402 token returns 401 with L402 challenge', async () => {
  const { middleware } = createMcpPayGate({
    verifyL402Fn: async () => ({ ok: false, reason: 'preimage_mismatch' }),
  });

  const req = makeReq({ authorization: 'L402 bad:token' });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), false, 'next() must not be called for invalid token');
  assert.equal(res._state.statusCode, 401, 'status must be 401 for invalid l402');

  const wwwAuth = res._state.headers['www-authenticate'];
  assert.ok(typeof wwwAuth === 'string', 'L402 challenge is single header string on 401');
  assert.ok(wwwAuth.startsWith('L402 '), 'must re-issue L402 challenge');

  assert.ok(res._state.jsonBody, 'must emit error body');
  assert.equal(res._state.jsonBody.error, 'invalid l402 token');
  assert.equal(res._state.jsonBody.reason, 'preimage_mismatch');
});

// ---------------------------------------------------------------------------
// Path 4 — verifyX402Fn returns ok=false (covers any reject reason). The
// middleware re-emits the dual-rail 402 so the caller can fall back to L402.
// ---------------------------------------------------------------------------

test('x402 rejected by verifier returns 402 dual-rail', async () => {
  const { middleware } = createMcpPayGate({
    verifyX402Fn: async () => ({ ok: false, reason: 'amount_mismatch' }),
  });

  const req = makeReq({ authorization: 'x402 someBase64Payload' });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), false);
  assert.equal(res._state.statusCode, 402, 'must re-emit 402 (not 401) so client can pick a rail');

  const wwwAuth = res._state.headers['www-authenticate'];
  assert.ok(Array.isArray(wwwAuth), 'WWW-Authenticate must be dual-rail array');
  assert.equal(wwwAuth.length, 2);
  assert.ok(wwwAuth.some((s) => s.startsWith('L402 ')));
  assert.ok(wwwAuth.some((s) => s.startsWith('x402 ')));
});

// ---------------------------------------------------------------------------
// Path 5 — X-PAYMENT header form is recognized and routed to x402 verifier.
// ---------------------------------------------------------------------------

test('x402 via X-PAYMENT header is recognized and routed to x402 verifier', async () => {
  let verifyCalled = false;
  const { middleware } = createMcpPayGate({
    verifyX402Fn: async (payload, _ctx) => {
      verifyCalled = true;
      assert.equal(payload, 'xPaymentHeaderPayload');
      return { ok: false, reason: 'still_invalid' };
    },
  });

  const req = makeReq({ xPayment: 'xPaymentHeaderPayload' });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(verifyCalled, true, 'verifyX402Fn must be invoked when X-PAYMENT header present');
  assert.equal(next.wasCalled(), false);
  assert.equal(res._state.statusCode, 402);
});

// ---------------------------------------------------------------------------
// Path 6 — x402 HAPPY PATH (build/130 ISC-25)
// ---------------------------------------------------------------------------

test('x402 happy path: valid payload + paid invoice -> next() with rail=x402-bip122-exact', async () => {
  const settlementCache = createSettlementCache();
  let checkPaidCalls = 0;

  const { middleware } = createMcpPayGate({
    settlementCache,
    decodeBolt11Fn: makeFakeDecodeBolt11(),
    checkPaidFn: async (hash) => {
      checkPaidCalls += 1;
      assert.equal(hash, FAKE_PAYMENT_HASH, 'checkPaid must receive decoded payment_hash');
      return true;
    },
  });

  const requirements = buildFakeRequirements();
  const payload = buildFakePayload(requirements);
  const auth = encodeAuthHeader(payload);

  const req = makeReq({ authorization: auth });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), true, 'next() must be called on verified x402');
  assert.equal(checkPaidCalls, 1, 'checkPaidFn must be called exactly once');

  assert.ok(req.payAuth, 'req.payAuth must be set');
  assert.equal(req.payAuth.rail, 'x402-bip122-exact');
  assert.equal(req.payAuth.paymentHash, FAKE_PAYMENT_HASH);
  assert.equal(req.payAuth.amountMsat, FAKE_AMOUNT_MSAT);

  // PAYMENT-RESPONSE header must be set with base64 SettlementResponse.
  const paymentResponse = res._state.headers['payment-response'];
  assert.ok(typeof paymentResponse === 'string' && paymentResponse.length > 0,
    'PAYMENT-RESPONSE header must be set');
  const decoded = JSON.parse(Buffer.from(paymentResponse, 'base64').toString('utf-8'));
  assert.equal(decoded.success, true);
  assert.equal(decoded.transaction, FAKE_PAYMENT_HASH);
  assert.equal(decoded.network, FAKE_NETWORK);

  // Cache must record the settlement so subsequent replay attempts fail.
  assert.equal(settlementCache.isSettled(FAKE_PAYMENT_HASH), true,
    'settlement cache must record the payment_hash on success');
});

// ---------------------------------------------------------------------------
// Path 7 — x402 NOT PAID (build/130 ISC-26)
// ---------------------------------------------------------------------------

test('x402 invoice not paid -> 402 dual-rail (LNBits says paid=false)', async () => {
  const settlementCache = createSettlementCache();
  const { middleware } = createMcpPayGate({
    settlementCache,
    decodeBolt11Fn: makeFakeDecodeBolt11(),
    checkPaidFn: async () => false,
  });

  const requirements = buildFakeRequirements();
  const payload = buildFakePayload(requirements);
  const auth = encodeAuthHeader(payload);

  const req = makeReq({ authorization: auth });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), false, 'next() must NOT be called when invoice unpaid');
  assert.equal(res._state.statusCode, 402);

  // Cache must NOT record a hash for an unpaid invoice.
  assert.equal(settlementCache.isSettled(FAKE_PAYMENT_HASH), false,
    'unpaid invoice must not enter settlement cache');
});

// ---------------------------------------------------------------------------
// Path 8 — x402 REPLAY ATTACK (build/130 ISC-27)
// ---------------------------------------------------------------------------

test('x402 replay: payment_hash already in settlement cache -> 402 dual-rail', async () => {
  const settlementCache = createSettlementCache();
  // Pre-seed the cache as if this hash already settled in a prior request.
  settlementCache.markSettled(FAKE_PAYMENT_HASH, 60 * 1000);

  let checkPaidCalled = false;
  const { middleware } = createMcpPayGate({
    settlementCache,
    decodeBolt11Fn: makeFakeDecodeBolt11(),
    checkPaidFn: async () => {
      checkPaidCalled = true;
      return true; // even if LNBits says paid, replay must still reject
    },
  });

  const requirements = buildFakeRequirements();
  const payload = buildFakePayload(requirements);
  const auth = encodeAuthHeader(payload);

  const req = makeReq({ authorization: auth });
  const res = makeRes();
  const next = makeNext();

  await middleware(req, res, next);

  assert.equal(next.wasCalled(), false, 'next() must NOT be called on replay');
  assert.equal(res._state.statusCode, 402, 'must respond 402 on replay');
  assert.equal(checkPaidCalled, false,
    'replay should short-circuit BEFORE LNBits check (saves a network round-trip)');
});

// ---------------------------------------------------------------------------
// Path 9 — header builders smoke checks
// ---------------------------------------------------------------------------

test('buildL402Challenge emits well-formed header', () => {
  const s = buildL402Challenge({ macaroon: 'm', invoice: 'lnbc1...' });
  assert.ok(s.startsWith('L402 '));
  assert.ok(s.includes('macaroon="m"'));
  assert.ok(s.includes('invoice="lnbc1..."'));
});

test('buildX402Challenge emits well-formed compact header (no invoice)', () => {
  const s = buildX402Challenge({ network: 'bitcoin', amount: 25 });
  assert.ok(s.startsWith('x402 '));
  assert.ok(s.includes('scheme="exact"'));
  assert.ok(s.includes('network="bitcoin"'));
  assert.ok(s.includes('amount="25"'));
});

test('formatX402Header emits invoice-bearing header with base64 requirements', () => {
  const requirements = buildFakeRequirements();
  const s = formatX402Header(requirements);
  assert.ok(s.startsWith('x402 '));
  assert.ok(s.includes('scheme="exact"'));
  assert.ok(s.includes(`network="${FAKE_NETWORK}"`));
  assert.ok(s.includes(`amount="${FAKE_AMOUNT_MSAT}"`));
  assert.ok(s.includes('requirements="'), 'must embed base64 requirements');
});

test('VERSION is bumped to 0.2.0', () => {
  assert.equal(VERSION, '0.2.0');
});
