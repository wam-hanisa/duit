/**
 * Flat per-trade evaluation log — logs/trades.jsonl, one JSON line per
 * completed trade, written at close time from recordPerformance().
 *
 * Purpose: a single machine-readable source of truth for performance
 * analysis. Unlike actions-*.jsonl (stringified-JSON-in-JSON, historically
 * truncated) or pool-memory.json (needs a manual join for slot/bins/peak),
 * every line here is a complete, self-contained trade record:
 * identity + entry context + range shape + outcome + close trigger.
 *
 * Analyze with: node analyze-trades.cjs [--since=YYYY-MM-DD]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, "logs", "trades.jsonl");

/**
 * Map a free-text close_reason to a stable category so analysis never has
 * to regex the prose again. Order matters: first match wins.
 */
export function categorizeCloseReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("whale")) return "whale_dump";
  if (r.includes("stop loss")) return "stop_loss";
  if (r.includes("take profit")) return "take_profit";
  if (r.includes("break-even") || r.includes("break even")) return "break_even";
  if (r.includes("pumped")) return "pumped_above";
  if (r.includes("out of range")) return "oor";
  if (r.includes("low yield")) return "low_yield";
  if (r.includes("trailing")) return "trailing_tp";
  if (r.includes("agent decision")) return "agent_decision";
  return "other";
}

/**
 * Append one completed trade. Never throws — a logging failure must not
 * break the close path.
 */
export function recordTrade(entry) {
  try {
    fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    fs.appendFileSync(TRADES_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    log("trade_log_error", `Failed to append trades.jsonl: ${err.message}`);
  }
}
