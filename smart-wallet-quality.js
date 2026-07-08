/**
 * Smart Wallet Quality Scoring — track recent performance per tracked wallet.
 *
 * Currently the screening prompt only says "smart_wallets: 3 present".
 * But not all smart wallets are equally valuable as signals:
 *   - Wallet A: last 5 trades 80% wr, +2% avg PnL → strong signal
 *   - Wallet B: last 5 trades 30% wr, -1% avg → weak/contrarian signal
 *
 * This module records each wallet's appearances in pools where we closed
 * positions, tracks the close PnL, and exposes a per-wallet quality summary
 * the LLM can use to weight signals.
 *
 * Hooks:
 *   - On every position close → recordWalletAppearance() for each smart
 *     wallet that was present in the pool.
 *   - During screening → getWalletQualityLabel() returns a short string
 *     like "(last5: 80% wr, +1.2% avg)" for each present wallet.
 *
 * Storage: smart-wallet-performance.json, rolling buffer of recent
 * appearances per wallet (default last 20 per wallet).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_PATH = path.join(__dirname, "smart-wallet-performance.json");
const MAX_APPEARANCES_PER_WALLET = 20;

function loadPerf() {
  if (!fs.existsSync(PERF_PATH)) return { wallets: {} };
  try {
    return JSON.parse(fs.readFileSync(PERF_PATH, "utf8"));
  } catch (e) {
    log("smart_wallet_quality_warn", `Failed to read perf file: ${e.message}`);
    return { wallets: {} };
  }
}

function savePerf(data) {
  try {
    fs.writeFileSync(PERF_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    log("smart_wallet_quality_warn", `Failed to write perf file: ${e.message}`);
  }
}

/**
 * Record that a smart wallet was present in a pool we closed.
 *
 * @param {Object} opts
 * @param {string} opts.address - Smart wallet address
 * @param {string} opts.pool - Pool address
 * @param {number} opts.pnl_pct - Our close PnL %
 * @param {string} [opts.pair] - Pool pair label for human readability
 */
export function recordWalletAppearance({ address, pool, pnl_pct, pair }) {
  if (!address || !Number.isFinite(Number(pnl_pct))) return;
  const data = loadPerf();
  if (!data.wallets[address]) data.wallets[address] = { appearances: [] };

  data.wallets[address].appearances.push({
    pool,
    pair: pair || null,
    pnl_pct: Number(pnl_pct),
    closed_at: new Date().toISOString(),
  });

  // Keep only the last N appearances
  if (data.wallets[address].appearances.length > MAX_APPEARANCES_PER_WALLET) {
    data.wallets[address].appearances = data.wallets[address].appearances.slice(-MAX_APPEARANCES_PER_WALLET);
  }
  savePerf(data);
}

/**
 * Get a quality summary for a wallet's recent appearances.
 *
 * @param {string} address
 * @param {Object} opts
 * @param {number} [opts.window=5] - How many recent appearances to consider
 * @returns {Object|null} { count, wr, avg_pnl, score } or null if not enough data
 */
export function getWalletQuality(address, { window = 5 } = {}) {
  const data = loadPerf();
  const recent = data.wallets[address]?.appearances?.slice(-window) || [];
  if (recent.length === 0) return null;

  const wins = recent.filter((a) => a.pnl_pct > 0).length;
  const wr = wins / recent.length;
  const avgPnl = recent.reduce((s, a) => s + (Number(a.pnl_pct) || 0), 0) / recent.length;

  // Composite score: weighted combo of win rate (0-1) and avg PnL (clipped)
  // Score range: 0 (bad) to 1 (great)
  // win rate contributes 60%, avg PnL contributes 40%
  const normalizedPnl = Math.max(0, Math.min(1, (avgPnl + 5) / 10)); // -5% maps to 0, +5% maps to 1
  const score = wr * 0.6 + normalizedPnl * 0.4;

  return {
    count: recent.length,
    wr,
    avg_pnl: avgPnl,
    score,
  };
}

/**
 * Build a short display label for a wallet given its quality data.
 *
 * Format examples:
 *   "(last5: 80% wr, +1.2% avg, ★)"  ← star = high quality
 *   "(last5: 40% wr, -0.5% avg)"
 *   ""  ← if no quality data available
 */
export function getWalletQualityLabel(address, opts = {}) {
  const q = getWalletQuality(address, opts);
  if (!q) return "";
  const wrStr = (q.wr * 100).toFixed(0);
  const pnlSign = q.avg_pnl >= 0 ? "+" : "";
  const pnlStr = q.avg_pnl.toFixed(2);
  const star = q.score >= 0.6 ? " ★" : q.score <= 0.3 ? " ⚠️" : "";
  return ` (last${q.count}: ${wrStr}% wr, ${pnlSign}${pnlStr}% avg${star})`;
}

/**
 * Get all wallet quality scores for diagnostics.
 */
export function getAllWalletQualities({ window = 5 } = {}) {
  const data = loadPerf();
  const result = {};
  for (const address of Object.keys(data.wallets || {})) {
    const q = getWalletQuality(address, { window });
    if (q) result[address] = q;
  }
  return result;
}
