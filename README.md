# @powforge/mcp-pay-gate

[![npm](https://img.shields.io/npm/v/@powforge/mcp-pay-gate.svg)](https://www.npmjs.com/package/@powforge/mcp-pay-gate)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#requirements)

Drop-in Express middleware for MCP servers. Accepts L402 Lightning (legacy clients) and x402 `bip122/exact` (forward-compat clients) with a real 10-step verifier behind both rails. One LNBits backend serves both. v0.2.0 ships full x402 verification (BOLT11 decode, replay protection, LNBits paid-check) — no stubs.

## Why dual-rail

The pay-per-call MCP space is converging. Coinbase's x402 spec has an open PR (coinbase/x402 #2258) adding `bip122/exact`, which moves Bitcoin Lightning settlement inside x402. That means the rail choice for paid MCP endpoints collapses into a wallet-capability decision over the next 30 to 60 days.

If you ship today and pick one rail, half your future clients break. If you ship two services, you carry double the operational surface for the same revenue.

This middleware is the third option. It advertises both rails in the 402 challenge, accepts whichever the caller sends, and settles both into the same LNBits Lightning wallet. Existing L402 clients keep working. New x402 clients also work. You ship once.

## Status

As of v0.2.0 both rails are live.

- L402 rail: verification forwards to `${POW_GATE_URL}/v1/verify` by default. Production verify via `@powforge/mcp-l402-gate` in-process is recommended for full fidelity (this package does not duplicate the macaroon mint or HMAC code).
- x402 rail: full 10-step `bip122/exact` verifier per the x402-foundation/x402 PR #1311 spec, cross-checked against the Python reference impl in PR #1873. Mints a real BOLT11 invoice via the configured LNBits backend, decodes it with `light-bolt11-decoder`, validates scheme / network / asset / payTo / paymentMethod / invoice consistency / expiry / exact msat amount, short-circuits replays via an in-memory settlement cache, and confirms payment via LNBits paid-check. On success, returns a base64 `SettlementResponse` in the `PAYMENT-RESPONSE` header. 29 tests passing (12 middleware + 17 verifier-unit).

Deferred to v0.3.0: in-flight HTLC detection, BOLT12 offers, multi-instance settlement cache (Redis backend).

If you need an L402-only gate today, [`@powforge/mcp-l402-gate`](https://www.npmjs.com/package/@powforge/mcp-l402-gate) is the focused product — full L402 verify, replay protection, DoI score gating. This package is the dual-rail option for operators serving both legacy L402 and forward-compat x402 clients from one LNBits wallet.

## Requirements

- Node >= 18
- An LNBits wallet (URL + invoice/read API key) for actual settlement
- A reachable `POW_GATE_URL` if you use the default L402 verify forwarder

## Five-line integration (Express)

```js
const express = require('express');
const { mcpPayGateMiddleware } = require('@powforge/mcp-pay-gate');

const app = express();
app.use('/tools/expensive', mcpPayGateMiddleware({
  satsAmount: 10,
}));

app.post('/tools/expensive', (req, res) => {
  // Reached only when the caller settled via L402 or x402.
  res.json({ ok: true, rail: req.payAuth.rail });
});
```

## Behavior

| Caller sends | Middleware does |
|---|---|
| No `Authorization` header | 402 with two `WWW-Authenticate` headers (one L402, one x402) and a JSON body listing both rails |
| `Authorization: L402 <token>` | Calls `verifyL402Fn(token)`. On success: `req.payAuth = { rail: 'l402', payload }` and `next()`. On failure: 401 |
| `Authorization: x402 <payload>` or `X-PAYMENT: <payload>` | Decodes the base64 `PaymentPayload`, runs the 10-step `bip122/exact` verifier (scheme / network / asset / payTo / paymentMethod / invoice consistency / BOLT11 decode / expiry / exact msat amount / replay-cache + LNBits paid-check). On success: `req.payAuth = { rail: 'x402-bip122-exact', paymentHash, amountMsat, payload }`, sets `PAYMENT-RESPONSE` header, and `next()`. On failure: 402 with both challenges so the caller can retry or fall back |
| Unknown scheme | 402 with both challenges |

## Config reference

| Field | Default | Notes |
|---|---|---|
| `gateUrl` | `process.env.POW_GATE_URL` or `https://gate.powforge.dev` | Used by default L402 verify forwarder |
| `priceMsat` | 3000 (3 sats) | Exact amount in millisatoshis advertised in the x402 PaymentRequirements |
| `network` | `bip122:000000000019d6689c085ae165831e93` (mainnet CAIP-2) | x402 challenge network |
| `scheme` | `exact` | x402 challenge scheme (per PR #1311) |
| `payTo` | `anonymous` | x402 PaymentRequirements payTo (Lightning has no on-chain destination at challenge time) |
| `lnbits.url`, `lnbits.apiKey` | none | Required for the default x402 invoice mint and paid-check; can be replaced by passing custom `invoiceFn` and `checkPaidFn` seams |
| `verifyL402Fn` | forwards to gate `/v1/verify` | Override to plug `@powforge/mcp-l402-gate`'s in-process verify |
| `verifyX402Fn` | full 10-step `bip122/exact` verifier (BOLT11 decode + replay cache + LNBits paid-check) | Override only if you need to substitute a non-LNBits backend |
| `settlementCache` | in-memory `Map` with 24h TTL and opportunistic prune | Override with a Redis-backed cache for multi-instance deployments (deferred to v0.3.0) |

## What this is not

- This is not a macaroon mint. Pair it with `@powforge/mcp-l402-gate` if you want PowForge to mint and verify L402 in-process.
- This is not an LNBits client. It does not create invoices or check payment status itself; the verify functions own that.
- This is not a DoI score gate. If you want identity-scored access on top of payment, compose this with `@powforge/mcp-l402-gate` or `@powforge/mcp-identity`.

The point of this package is the dual-rail challenge response and the request-routing shape. Plug your real verify in.

## Roadmap

- v0.1 (shipped): scaffold. Dual-rail challenge, L402 verify forwarder, x402 stub.
- v0.2 (current): full x402 `bip122/exact` verification per PR #1311 spec. Real LNBits invoice mint, BOLT11 decode, in-memory replay cache, 10-step verifier, 29 tests.
- v0.3 (planned): in-flight HTLC detection (Retry-After), BOLT12 offers, Redis-backed settlement cache for multi-instance deployments.

## License

MIT.
