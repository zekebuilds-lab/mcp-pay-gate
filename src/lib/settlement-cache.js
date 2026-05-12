/**
 * @powforge/mcp-pay-gate — settlement cache
 *
 * In-memory replay protection for x402-bip122-exact. Once a BOLT11
 * payment_hash settles (verified via LNBits paid-check), it gets recorded
 * here with an expiry timestamp. Subsequent requests presenting the same
 * payment_hash are rejected as replays.
 *
 * Multi-instance operators must wire a Redis-backed cache via the
 * `settlementCache` config seam. The default in-memory map only works for
 * single-process deployments. Documented as v0.3.0 deferred per
 * research/h-mcp-auth-1-log.md §23.
 *
 * Mirrors the Python ref impl in PR #1873
 * (`x402.mechanisms.bip122.settlement_cache`).
 *
 * API:
 *   const cache = createSettlementCache({ defaultTtlMs })
 *   cache.markSettled(paymentHash, ttlMs?)
 *   cache.isSettled(paymentHash) -> boolean
 *   cache.prune() -> number of entries removed
 *   cache.size() -> current entry count (test helper)
 */

'use strict';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function createSettlementCache(opts = {}) {
  const defaultTtlMs = Number.isFinite(opts.defaultTtlMs) && opts.defaultTtlMs > 0
    ? opts.defaultTtlMs
    : DEFAULT_TTL_MS;
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();

  // Map<paymentHashHex, { settledAt, expiresAt }>
  const store = new Map();

  function markSettled(paymentHash, ttlMs) {
    if (typeof paymentHash !== 'string' || paymentHash.length === 0) {
      throw new Error('settlement-cache: paymentHash must be non-empty string');
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs;
    const settledAt = nowFn();
    store.set(paymentHash, { settledAt, expiresAt: settledAt + ttl });
    // Opportunistic prune — 1% of writes trigger a sweep so the Map can't
    // grow unbounded over a long-running process. Operators who want
    // deterministic pruning can call cache.prune() on a timer.
    if (Math.random() < 0.01) prune();
  }

  function isSettled(paymentHash) {
    if (typeof paymentHash !== 'string' || paymentHash.length === 0) return false;
    const entry = store.get(paymentHash);
    if (!entry) return false;
    if (nowFn() >= entry.expiresAt) {
      store.delete(paymentHash);
      return false;
    }
    return true;
  }

  function prune() {
    const now = nowFn();
    let removed = 0;
    for (const [hash, entry] of store.entries()) {
      if (now >= entry.expiresAt) {
        store.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  function size() {
    return store.size;
  }

  return { markSettled, isSettled, prune, size };
}

module.exports = { createSettlementCache, DEFAULT_TTL_MS };
