/**
 * Liquidity Removal Alert — detects LP exit cascades.
 *
 * Distinct from whale-watch: this watches LIQUIDITY PROVIDERS leaving the
 * pool, not token holders dumping. When other LPers pull out fast, the
 * remaining LPs face thinner depth and worse IL on every subsequent swap.
 *
 * Single-signal trigger: if pool TVL drops by more than the configured
 * threshold between two 30s polls, fire a close. No score required —
 * LP exodus is binary: it's either happening or it's not.
 *
 * The check runs alongside whale-watch in the 30s poller. Whale-watch
 * already includes a smaller TVL drop signal as part of its composite
 * score, so the two are complementary, not duplicative.
 */

import { log } from "./logger.js";

// Per-position cache of last TVL reading
const _tvlSnapshots = new Map(); // position_address -> { tvl, last_check_at }

/**
 * Check if a position's pool is bleeding liquidity.
 *
 * @param {Object} position - Live position data
 * @param {Object} mgmtConfig - config.management
 * @returns {Object|null} { detected, reason, drop_pct, prev_tvl, current_tvl } or null
 */
export function checkLiquidityRemoval(position, mgmtConfig) {
  if (!mgmtConfig?.liquidityExitEnabled) return null;
  if (!position?.position) return null;

  const positionAddress = position.position;
  const currentTvl = Number(position.pool_tvl || position.tvl);
  if (!Number.isFinite(currentTvl) || currentTvl <= 0) return null;

  const now = Date.now();
  const prev = _tvlSnapshots.get(positionAddress);

  // First check — just snapshot, no signal yet
  if (!prev || !Number.isFinite(prev.tvl) || prev.tvl <= 0) {
    _tvlSnapshots.set(positionAddress, { tvl: currentTvl, last_check_at: now });
    return null;
  }

  // Compare against previous reading
  const dropPct = ((prev.tvl - currentTvl) / prev.tvl) * 100;
  const threshold = mgmtConfig.liquidityExitTvlDropPct ?? 20;

  // Update snapshot first so we don't re-trigger on stale data
  _tvlSnapshots.set(positionAddress, { tvl: currentTvl, last_check_at: now });

  if (dropPct >= threshold) {
    return {
      detected: true,
      drop_pct: dropPct,
      prev_tvl: prev.tvl,
      current_tvl: currentTvl,
      reason: `LP exit cascade: TVL dropped ${dropPct.toFixed(2)}% in 30s ($${Math.round(prev.tvl)} → $${Math.round(currentTvl)})`,
    };
  }
  return null;
}

/**
 * Clear snapshot when a position closes (free memory).
 */
export function clearLiquiditySnapshot(positionAddress) {
  _tvlSnapshots.delete(positionAddress);
}
