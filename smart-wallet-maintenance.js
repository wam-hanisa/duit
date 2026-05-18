/**
 * Smart Wallet Maintenance — auto-add high performers, auto-remove inactive wallets.
 *
 * Two operations:
 *
 *   1. autoAddFromPool({ poolAddress })
 *      Called after every PROFITABLE close. Studies the pool's top LPers
 *      via LPAgent and adds any whose win rate + ROI exceed thresholds.
 *      Logic: we just made money in this pool — let's track who else did.
 *
 *   2. pruneInactiveWallets()
 *      Called daily via cron. Fetches positions for each tracked wallet.
 *      If wallet has 0 positions AND hasn't been seen active for X days,
 *      remove it. Self-healing list.
 */

import { listSmartWallets, addSmartWallet, removeSmartWallet, markWalletActive } from "./smart-wallets.js";
import { studyTopLPers } from "./tools/study.js";
import { getWalletPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";

/**
 * Add top LPers from a pool we just made money in.
 *
 * @param {Object} opts
 * @param {string} opts.poolAddress - Pool we closed profitably
 * @param {Object} opts.mgmtConfig - config.management
 * @returns {Promise<{added: number, candidates: number, skipped: string|null}>}
 */
export async function autoAddFromPool({ poolAddress, mgmtConfig }) {
  if (!mgmtConfig?.smartWalletAutoAddEnabled) {
    return { added: 0, skipped: "disabled" };
  }
  if (!poolAddress) {
    return { added: 0, skipped: "no pool address" };
  }

  const minWinRate = mgmtConfig.smartWalletMinWinRate ?? 0.6;     // 60% win rate min
  const minRoi = mgmtConfig.smartWalletMinRoi ?? 0.1;             // 10% ROI min
  const maxTotal = mgmtConfig.smartWalletMaxTotal ?? 50;          // cap at 50 wallets
  const maxPerCycle = mgmtConfig.smartWalletMaxAddsPerCycle ?? 2; // max 2 adds per close

  const current = listSmartWallets();
  if (current.total >= maxTotal) {
    log("smart_wallet_maint", `Skipping auto-add — at max wallets (${current.total}/${maxTotal})`);
    return { added: 0, skipped: "max wallets reached" };
  }

  const existing = new Set(current.wallets.map((w) => w.address));

  try {
    const study = await studyTopLPers({ pool_address: poolAddress, limit: 5 });
    if (!study?.lpers?.length) {
      return { added: 0, candidates: 0, skipped: "no top LPers found for pool" };
    }

    // Filter: must hit thresholds AND not already tracked
    const candidates = study.lpers.filter((l) => {
      const wr = Number(l.summary?.win_rate) || 0;
      const roi = Number(l.summary?.roi) || 0;
      const owner = l.owner;
      return wr >= minWinRate && roi >= minRoi && owner && !existing.has(owner);
    });

    if (candidates.length === 0) {
      log("smart_wallet_maint", `Pool ${poolAddress.slice(0, 8)}... studied but no qualifying LPers (wr>=${minWinRate}, roi>=${minRoi})`);
      return { added: 0, candidates: 0, skipped: "no LPers met thresholds" };
    }

    let added = 0;
    for (const c of candidates.slice(0, maxPerCycle)) {
      const wr = (Number(c.summary?.win_rate) || 0).toFixed(2);
      const roi = (Number(c.summary?.roi) || 0).toFixed(2);
      const result = addSmartWallet({
        name: `auto-${c.owner.slice(0, 8)}`,
        address: c.owner,
        category: "alpha",
        type: "lp",
      });
      if (result.success) {
        added++;
        log("smart_wallet_maint", `🤖 Auto-added wallet ${c.owner.slice(0, 8)}... (wr=${wr}, roi=${roi}) from pool ${poolAddress.slice(0, 8)}...`);
      }
    }
    return { added, candidates: candidates.length };
  } catch (e) {
    log("smart_wallet_maint_warn", `Auto-add failed for ${poolAddress?.slice(0, 8)}...: ${e.message}`);
    return { added: 0, error: e.message };
  }
}

/**
 * Remove wallets that have been inactive (zero positions) for too long.
 *
 * Logic:
 *   - For each LP-type wallet, fetch current positions
 *   - If has positions → mark active (updates lastActiveAt)
 *   - If has 0 positions AND lastSeenActive > inactivityDays → REMOVE
 *
 * @param {Object} opts
 * @param {Object} opts.mgmtConfig - config.management
 * @returns {Promise<{removed: number, checked: number, active: number}>}
 */
export async function pruneInactiveWallets({ mgmtConfig }) {
  if (!mgmtConfig?.smartWalletAutoRemoveEnabled) {
    return { removed: 0, skipped: "disabled" };
  }

  const inactivityDays = mgmtConfig.smartWalletInactivityDays ?? 30;
  const cutoffMs = Date.now() - inactivityDays * 24 * 60 * 60 * 1000;

  const { wallets } = listSmartWallets();
  const lpWallets = wallets.filter((w) => !w.type || w.type === "lp");
  if (lpWallets.length === 0) {
    return { removed: 0, checked: 0, active: 0 };
  }

  log("smart_wallet_maint", `Pruning check: ${lpWallets.length} LP wallets (inactivity threshold: ${inactivityDays}d)`);

  let removed = 0;
  let active = 0;
  let stillNoPositions = 0;

  for (const w of lpWallets) {
    try {
      const result = await getWalletPositions({ wallet_address: w.address }).catch(() => null);
      const positions = result?.positions || [];

      if (positions.length > 0) {
        // Has positions → currently active, mark and skip
        markWalletActive(w.address);
        active++;
      } else {
        stillNoPositions++;
        // Zero positions — check inactivity timeline
        const lastActive = w.lastActiveAt ? new Date(w.lastActiveAt).getTime() : null;
        const addedAt = w.addedAt ? new Date(w.addedAt).getTime() : null;
        const reference = lastActive || addedAt;

        if (reference && reference < cutoffMs) {
          const removeResult = removeSmartWallet({ address: w.address });
          if (removeResult.success) {
            removed++;
            const sinceMs = Date.now() - reference;
            const sinceDays = Math.floor(sinceMs / (24 * 60 * 60 * 1000));
            log("smart_wallet_maint", `🗑️  Removed inactive wallet ${w.name} (no positions, last active ${sinceDays}d ago)`);
          }
        }
      }

      // Rate-limit RPC calls
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      log("smart_wallet_maint_warn", `Failed to check wallet ${w.address?.slice(0, 8)}...: ${e.message}`);
    }
  }

  log("smart_wallet_maint", `Pruning done: ${lpWallets.length} checked, ${active} active, ${stillNoPositions} no-positions, ${removed} removed`);
  return { removed, checked: lpWallets.length, active, no_positions: stillNoPositions };
}
