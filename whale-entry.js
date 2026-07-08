/**
 * Whale Entry Detector — inverse of whale-watch.
 *
 * Detects when smart money is BUYING a candidate token before deploy.
 * Used during screening to flag pools where a pump signature is building.
 *
 * Combines three existing signals into a single "whale entry" flag:
 *
 *   Signal A: OKX `smart_money_buy` flag (+2 score)
 *   Signal B: High net buyers in last 5-30m (+1 to +3 score)
 *   Signal C: Smart wallet presence in pool (+2 score)
 *   Signal D: Top holder balance increase since last screen (+3 score)
 *
 * Total score >= threshold → "🐳 WHALE ENTRY" tag in candidate block.
 */
import { log } from "./logger.js";

// In-memory cache: mint -> { top_holder_pcts: Map<addr, pct>, last_seen: timestamp }
const _holderSnapshots = new Map();
const SNAPSHOT_TTL_MS = 30 * 60 * 1000; // 30 min — keep snapshots fresh

/**
 * Detect whale entry signal for a candidate.
 *
 * @param {Object} opts
 * @param {string} opts.mint - Base token mint
 * @param {Object} opts.tokenInfo - From getTokenInfo (provides stats_5m, stats_30m, smart_money_buy)
 * @param {Array} opts.holders - Top holders from getTokenHolders (optional, for delta tracking)
 * @param {number} opts.smartWalletCount - Smart wallets present in pool
 * @returns {Object|null} { score, signals, label } if entry detected, null otherwise
 */
export function checkWhaleEntry({ mint, tokenInfo, holders, smartWalletCount = 0 }) {
  if (!mint) return null;

  const signals = [];
  let score = 0;

  // Signal A: OKX smart money buy flag
  if (tokenInfo?.smart_money_buy) {
    score += 2;
    signals.push("smart_money_buy");
  }

  // Signal B: Net buyer pressure
  const netBuyers5m  = Number(tokenInfo?.stats_5m?.net_buyers)  || 0;
  const netBuyers30m = Number(tokenInfo?.stats_30m?.net_buyers) || 0;
  const netBuyers1h  = Number(tokenInfo?.stats_1h?.net_buyers)  || 0;
  if (netBuyers5m >= 20 && netBuyers30m >= 30) {
    score += 3;
    signals.push(`net_buyers_5m=${netBuyers5m}, 30m=${netBuyers30m}`);
  } else if (netBuyers30m >= 30 && netBuyers1h >= 50) {
    score += 2;
    signals.push(`net_buyers_30m=${netBuyers30m}, 1h=${netBuyers1h}`);
  } else if (netBuyers5m >= 15) {
    score += 1;
    signals.push(`net_buyers_5m=${netBuyers5m}`);
  }

  // Signal C: Smart wallet presence
  if (smartWalletCount >= 3) {
    score += 3;
    signals.push(`${smartWalletCount}_smart_wallets`);
  } else if (smartWalletCount > 0) {
    score += 2;
    signals.push(`${smartWalletCount}_smart_wallets`);
  }

  // Signal D: Top holder accumulation since last snapshot
  if (Array.isArray(holders) && holders.length > 0) {
    const prevSnapshot = _holderSnapshots.get(mint);
    if (prevSnapshot && Date.now() - prevSnapshot.last_seen < SNAPSHOT_TTL_MS) {
      let biggestIncrease = 0;
      let increaserAddr = null;
      for (const h of holders.slice(0, 10)) {
        const prevPct = prevSnapshot.top_holder_pcts.get(h.address);
        if (prevPct == null) continue;
        const delta = (Number(h.pct) || 0) - prevPct;
        if (delta > biggestIncrease) {
          biggestIncrease = delta;
          increaserAddr = h.address;
        }
      }
      if (biggestIncrease >= 2) {
        score += 3;
        signals.push(`holder ${increaserAddr?.slice(0, 8)}... +${biggestIncrease.toFixed(2)}% supply`);
      } else if (biggestIncrease >= 0.5) {
        score += 1;
        signals.push(`holder accumulating +${biggestIncrease.toFixed(2)}%`);
      }
    }

    // Update snapshot
    const top_holder_pcts = new Map();
    for (const h of holders.slice(0, 10)) {
      if (h.address && h.pct != null) top_holder_pcts.set(h.address, Number(h.pct));
    }
    _holderSnapshots.set(mint, { top_holder_pcts, last_seen: Date.now() });
  }

  // Cleanup old snapshots (keep memory bounded)
  if (_holderSnapshots.size > 100) {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    for (const [k, v] of _holderSnapshots.entries()) {
      if (v.last_seen < cutoff) _holderSnapshots.delete(k);
    }
  }

  // Threshold: total >= 4 = entry detected
  if (score >= 4) {
    return {
      detected: true,
      score,
      signals,
      label: `🐳 WHALE ENTRY (score ${score}/4+): ${signals.join(", ")}`,
    };
  }
  return null;
}

/**
 * Clear snapshot for a token (e.g., when blacklisted).
 */
export function clearWhaleEntrySnapshot(mint) {
  _holderSnapshots.delete(mint);
}
