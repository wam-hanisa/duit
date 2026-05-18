/**
 * SOL Momentum Check — skip deploys when SOL is dumping.
 *
 * Meme tokens trade in SOL pairs, so when SOL itself is crashing, even a
 * "good" meme pool will bleed value as SOL converts wrap around the IL
 * math. Better to wait one screening cycle than deploy into a downtrend.
 *
 * Maintains a rolling 60-minute price history (sampled per screening cycle).
 * Computes 5m, 15m, and 60m price changes. Returns a verdict:
 *   - "skip": SOL dropping fast — delay this deploy
 *   - "ok": stable or uptrend
 *   - "caution": mild drift, deploy with care
 */

import { log } from "./logger.js";

const PRICE_HISTORY_MAX_MS = 65 * 60 * 1000; // 65 min — covers 60m window plus jitter
const PRICE_HISTORY = []; // [{ price, ts }] ascending by ts

// Cache the last fetch for 60s — multiple screening cycles in a row shouldn't hammer the API
let _lastFetchAt = 0;
let _lastPrice = null;
const FETCH_TTL_MS = 60_000;

async function fetchSolPrice() {
  const now = Date.now();
  if (now - _lastFetchAt < FETCH_TTL_MS && _lastPrice != null) {
    return _lastPrice;
  }
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log("sol_momentum_warn", `CoinGecko returned ${res.status}`);
      return _lastPrice;
    }
    const data = await res.json();
    const price = Number(data?.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) return _lastPrice;
    _lastPrice = price;
    _lastFetchAt = now;
    return price;
  } catch (e) {
    log("sol_momentum_warn", `SOL price fetch failed: ${e.message}`);
    return _lastPrice; // fall back to last known
  }
}

function prunePriceHistory() {
  const cutoff = Date.now() - PRICE_HISTORY_MAX_MS;
  while (PRICE_HISTORY.length > 0 && PRICE_HISTORY[0].ts < cutoff) {
    PRICE_HISTORY.shift();
  }
}

function priceAtAgo(targetAgoMs) {
  // Find the price closest to `targetAgoMs` milliseconds ago
  const target = Date.now() - targetAgoMs;
  let best = null;
  let bestDiff = Infinity;
  for (const entry of PRICE_HISTORY) {
    const diff = Math.abs(entry.ts - target);
    if (diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }
  // Only consider it valid if we have a sample within ~50% of the target window
  if (best && bestDiff < targetAgoMs * 0.5) return best.price;
  return null;
}

/**
 * Check SOL momentum and return a verdict.
 *
 * @param {Object} mgmtConfig - config.management
 * @returns {Promise<{verdict: string, reason: string|null, current_price: number|null}>}
 */
export async function checkSolMomentum(mgmtConfig) {
  if (!mgmtConfig?.solMomentumCheckEnabled) {
    return { verdict: "ok", reason: null, current_price: null };
  }

  const price = await fetchSolPrice();
  if (price == null) {
    return { verdict: "ok", reason: "SOL price unavailable — proceeding without momentum check", current_price: null };
  }

  // Record this sample
  PRICE_HISTORY.push({ price, ts: Date.now() });
  prunePriceHistory();

  // Need at least one historical sample to compare
  const price15m = priceAtAgo(15 * 60 * 1000);
  const price60m = priceAtAgo(60 * 60 * 1000);

  const skipDropPct = mgmtConfig.solMomentumSkipDropPct ?? 2;      // SOL dropping >2% in 15m → skip
  const cautionDropPct = mgmtConfig.solMomentumCautionDropPct ?? 1; // SOL dropping >1% in 15m → caution

  if (price15m != null) {
    const change15m = ((price - price15m) / price15m) * 100;
    if (change15m <= -skipDropPct) {
      return {
        verdict: "skip",
        reason: `SOL dropping ${change15m.toFixed(2)}% in last 15m ($${price15m.toFixed(2)} → $${price.toFixed(2)}) — skipping deploy`,
        current_price: price,
        change_15m: change15m,
      };
    }
    if (change15m <= -cautionDropPct) {
      return {
        verdict: "caution",
        reason: `SOL drifting down ${change15m.toFixed(2)}% in 15m — deploy with care`,
        current_price: price,
        change_15m: change15m,
      };
    }
  }

  // 60m crash check (slower bleed)
  if (price60m != null) {
    const change60m = ((price - price60m) / price60m) * 100;
    if (change60m <= -(skipDropPct * 2.5)) {
      // E.g., -5% in 60m even if 15m looks stable = sustained downtrend
      return {
        verdict: "skip",
        reason: `SOL down ${change60m.toFixed(2)}% over 60m — sustained downtrend, skipping deploy`,
        current_price: price,
        change_60m: change60m,
      };
    }
  }

  return { verdict: "ok", reason: null, current_price: price };
}

/**
 * Force-reset history (for testing / config changes).
 */
export function resetSolMomentum() {
  PRICE_HISTORY.length = 0;
  _lastFetchAt = 0;
  _lastPrice = null;
}
