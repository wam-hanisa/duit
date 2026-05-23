/**
 * Whale Watch — detects whale dump activity on open positions.
 *
 * Three signals combine into a score (higher = more dangerous):
 *   Signal A: Top holder concentration drop (+1 to +3)
 *   Signal B: Volume spike with price drop (+1 to +3)
 *   Signal C: Pool TVL drop (+1)
 *
 * If total score >= threshold → whale dump detected → trigger close.
 *
 * Runs every 30s alongside the PnL poller in index.js. Does NOT close
 * positions itself — returns a verdict, and index.js fires the management
 * cycle which routes through the LLM executor.
 */

import { log } from "./logger.js";
import { getTokenHolders } from "./tools/token.js";

// Per-position cache of last snapshot — keeps holders/tvl/pnl from last check
// Map<position_address, snapshot>
const _snapshots = new Map();

// Per-position throttle — don't fetch holders more often than this
// Holder API is rate-limited, so we cap to every 90s per position
const HOLDER_FETCH_INTERVAL_MS = 90_000;
const _lastHolderFetch = new Map();

/**
 * Detect whale activity for a single position.
 *
 * @param {Object} position - Live position data from getMyPositions()
 * @param {Object} trackedPos - state.json record for this position (may be null)
 * @param {Object} mgmtConfig - config.management object
 * @returns {Object|null} { score, signals, action } if dump detected; null otherwise
 */
export async function checkWhaleActivity(position, trackedPos, mgmtConfig) {
  if (!mgmtConfig?.whaleWatchEnabled) return null;
  if (!position?.position) return null;

  const positionAddress = position.position;
  const mint = position.base_mint || trackedPos?.base_mint;

  const now = Date.now();
  const prev = _snapshots.get(positionAddress) || {};
  const signals = { holderDrop: 0, priceDropFast: 0, tvlDrop: 0, declineStreak: 0 };
  let score = 0;
  const reasons = [];

  // ─── Signal A: Top Holder Concentration Drop ─────────────────
  // Throttled to once per 90s per position
  const lastFetch = _lastHolderFetch.get(positionAddress) || 0;
  let holders = prev.holders;
  if (mint && now - lastFetch >= HOLDER_FETCH_INTERVAL_MS) {
    try {
      const result = await getTokenHolders({ mint, limit: 10 });
      holders = result?.top_holders || result?.holders || [];
      _lastHolderFetch.set(positionAddress, now);
    } catch (e) {
      log("whale_watch_warn", `Holder fetch failed for ${positionAddress}: ${e.message}`);
    }
  }

  if (holders?.length && prev.holders?.length) {
    // Build a map of prev holdings by address for comparison
    const prevByAddr = new Map(prev.holders.map((h) => [h.address, Number(h.pct) || 0]));
    let biggestDrop = 0;
    let dropperAddr = null;
    for (const h of holders) {
      const prevPct = prevByAddr.get(h.address);
      if (prevPct == null) continue;
      const drop = prevPct - (Number(h.pct) || 0);
      if (drop > biggestDrop) {
        biggestDrop = drop;
        dropperAddr = h.address;
      }
    }

    const bigDropPct = mgmtConfig.whaleHolderBigDropPct ?? 5;   // top 1 holder dropping
    const smallDropPct = mgmtConfig.whaleHolderSmallDropPct ?? 3; // any top 5 holder dropping

    if (biggestDrop >= bigDropPct) {
      signals.holderDrop = 3;
      reasons.push(`top holder ${dropperAddr?.slice(0, 8)}... dropped ${biggestDrop.toFixed(2)}% of supply`);
    } else if (biggestDrop >= smallDropPct) {
      signals.holderDrop = 1;
      reasons.push(`holder ${dropperAddr?.slice(0, 8)}... dropped ${biggestDrop.toFixed(2)}%`);
    }
  }

  // ─── Signal B: Fast Price Drop ───────────────────────────────
  // Use PnL change between this poll and last poll
  const currentPnl = Number(position.pnl_pct);
  const prevPnl = prev.pnl_pct;
  if (Number.isFinite(currentPnl) && Number.isFinite(prevPnl)) {
    const pnlDrop = prevPnl - currentPnl;
    const fastDropPct = mgmtConfig.whaleFastDropPct ?? 3;       // -3% in one poll = ~6%/min drop
    const crashDropPct = mgmtConfig.whaleCrashDropPct ?? 6;     // -6% in one poll = crash

    if (pnlDrop >= crashDropPct) {
      signals.priceDropFast = 3;
      reasons.push(`PnL dropped ${pnlDrop.toFixed(2)}% in last 30s — crash signature`);
    } else if (pnlDrop >= fastDropPct) {
      signals.priceDropFast = 2;
      reasons.push(`PnL dropped ${pnlDrop.toFixed(2)}% in last 30s`);
    }
  }

  // ─── Signal C: Pool TVL Drop ─────────────────────────────────
  const currentTvl = Number(position.pool_tvl || position.tvl);
  const prevTvl = prev.pool_tvl;
  if (Number.isFinite(currentTvl) && Number.isFinite(prevTvl) && prevTvl > 0) {
    const tvlDropPct = ((prevTvl - currentTvl) / prevTvl) * 100;
    const tvlDropThreshold = mgmtConfig.whaleTvlDropPct ?? 10;

    if (tvlDropPct >= tvlDropThreshold) {
      signals.tvlDrop = 1;
      reasons.push(`pool TVL dropped ${tvlDropPct.toFixed(2)}% since last poll`);
    }
  }

  // ─── Signal D: Sustained decline (slow-grind dump early warning) ─
  // 36% of past dumps showed 3+ consecutive declining polls before the
  // cliff. Catch those ~10 min earlier than the single-poll crash signals.
  let declineStreak = prev.declineStreak || 0;
  let streakStartPnl = prev.streakStartPnl;
  if (Number.isFinite(currentPnl) && Number.isFinite(prevPnl)) {
    if (currentPnl < prevPnl - 0.05) {
      if (declineStreak === 0) streakStartPnl = prevPnl; // mark where the slide began
      declineStreak += 1;
    } else {
      declineStreak = 0;
      streakStartPnl = undefined;
    }
  }
  const declineStreakCount = mgmtConfig.whaleDeclineStreakCount ?? 3;
  const declineStreakMinDrop = mgmtConfig.whaleDeclineStreakMinDropPct ?? 2;
  if (
    declineStreakCount > 0 &&
    declineStreak >= declineStreakCount &&
    Number.isFinite(streakStartPnl) &&
    (streakStartPnl - currentPnl) >= declineStreakMinDrop
  ) {
    signals.declineStreak = 2;
    reasons.push(`sustained decline: ${declineStreak} polls, -${(streakStartPnl - currentPnl).toFixed(2)}% from streak start`);
  }

  // Update snapshot for next poll
  _snapshots.set(positionAddress, {
    holders: holders || prev.holders,
    pnl_pct: Number.isFinite(currentPnl) ? currentPnl : prev.pnl_pct,
    pool_tvl: Number.isFinite(currentTvl) ? currentTvl : prev.pool_tvl,
    declineStreak,
    streakStartPnl,
    last_check_at: now,
  });

  score = signals.holderDrop + signals.priceDropFast + signals.tvlDrop + signals.declineStreak;

  const threshold = mgmtConfig.whaleDumpScoreThreshold ?? 3;
  if (score >= threshold) {
    return {
      detected: true,
      score,
      threshold,
      signals,
      reason: `whale dump detected (score ${score}/${threshold}): ${reasons.join("; ")}`,
    };
  }

  // Below threshold — return null so poller doesn't trigger close
  return null;
}

/**
 * Clear snapshot for a closed position to free memory.
 */
export function clearWhaleSnapshot(positionAddress) {
  _snapshots.delete(positionAddress);
  _lastHolderFetch.delete(positionAddress);
}

/**
 * Get current whale-watch state for a position (for debugging / Telegram).
 */
export function getWhaleSnapshot(positionAddress) {
  return _snapshots.get(positionAddress) || null;
}
