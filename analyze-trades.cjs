#!/usr/bin/env node
/**
 * Trade performance analyzer.
 *
 * Reads logs/trades.jsonl (flat per-trade records written by trade-log.js)
 * and merges older history from pool-memory.json (deduped), then prints:
 * overall stats, daily table, per-strategy, per-slot, per-close-trigger,
 * fee-vs-price attribution, and biggest winners/losers.
 *
 * Usage:
 *   node analyze-trades.cjs                       # everything
 *   node analyze-trades.cjs --since=2026-07-01    # window start
 *   node analyze-trades.cjs --until=2026-07-14    # window end (exclusive)
 *   node analyze-trades.cjs --strategy=bid_ask    # filter
 *   node analyze-trades.cjs --slot=2              # filter
 *   node analyze-trades.cjs --days=7              # last N days shorthand
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const TRADES_FILE = path.join(ROOT, "logs", "trades.jsonl");
const POOL_MEMORY_FILE = path.join(ROOT, "pool-memory.json");

// ── args ─────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/i);
  if (m) args[m[1]] = m[2] ?? true;
}
let since = args.since ? Date.parse(args.since) : null;
const until = args.until ? Date.parse(args.until) : null;
if (args.days) since = Date.now() - Number(args.days) * 86400000;

function categorize(reason) {
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

// ── load trades.jsonl ────────────────────────────────────────────
const trades = [];
const seen = new Set(); // dedup keys
if (fs.existsSync(TRADES_FILE)) {
  for (const line of fs.readFileSync(TRADES_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (t.pnl_usd == null || !t.closed_at) continue;
    t._source = "trade_log";
    trades.push(t);
    if (t.position) seen.add(`pos:${t.position}`);
    seen.add(`pc:${t.pool}:${String(t.closed_at).slice(0, 16)}`);
  }
}

// ── merge pool-memory history (records not already in trades.jsonl) ──
if (fs.existsSync(POOL_MEMORY_FILE)) {
  try {
    const pm = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    for (const [pool, data] of Object.entries(pm)) {
      for (const d of data.deploys || []) {
        if (d.pnl_usd == null || !d.closed_at) continue;
        if (seen.has(`pc:${pool}:${String(d.closed_at).slice(0, 16)}`)) continue;
        trades.push({
          _source: "pool_memory",
          closed_at: d.closed_at,
          deployed_at: d.deployed_at ?? null,
          pool,
          pool_name: data.name ?? null,
          base_mint: data.base_mint ?? null,
          slot: null,
          strategy: d.strategy ?? null,
          volatility_at_deploy: d.volatility_at_deploy ?? null,
          minutes_held: d.minutes_held ?? null,
          range_efficiency: d.range_efficiency ?? null,
          fees_earned_usd: d.fees_earned_usd ?? null,
          pnl_usd: d.pnl_usd,
          pnl_pct: d.pnl_pct ?? null,
          close_reason: d.close_reason ?? null,
          close_trigger: categorize(d.close_reason),
          win: d.pnl_usd >= 0,
        });
      }
    }
  } catch (e) {
    console.error(`pool-memory.json merge skipped: ${e.message}`);
  }
}

// ── filter ───────────────────────────────────────────────────────
let rows = trades.filter((t) => {
  const ts = Date.parse(t.closed_at);
  if (!Number.isFinite(ts)) return false;
  if (since != null && ts < since) return false;
  if (until != null && ts >= until) return false;
  if (args.strategy && t.strategy !== args.strategy) return false;
  if (args.slot && String(t.slot) !== String(args.slot)) return false;
  return true;
});
rows.sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));

if (rows.length === 0) {
  console.log("No trades in the selected window.");
  process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────
const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? "-" : n.toFixed(d));
function stats(xs) {
  const wins = xs.filter((t) => t.pnl_usd >= 0);
  const losses = xs.filter((t) => t.pnl_usd < 0);
  const net = sum(xs, (t) => t.pnl_usd);
  const grossWin = sum(wins, (t) => t.pnl_usd);
  const grossLoss = Math.abs(sum(losses, (t) => t.pnl_usd));
  return {
    n: xs.length,
    wins: wins.length,
    losses: losses.length,
    wr: xs.length ? (wins.length / xs.length) * 100 : 0,
    net,
    avg: xs.length ? net / xs.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    fees: sum(xs, (t) => t.fees_earned_usd),
    avgHoldMin: xs.length ? sum(xs, (t) => t.minutes_held) / xs.length : 0,
  };
}
function printGroup(title, groups) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(1, 58 - title.length))}`);
  console.log("group            |   n  |  WR%  |  net USD | avg USD | PF   | fees USD");
  for (const [name, xs] of groups) {
    const s = stats(xs);
    console.log(
      `${String(name).slice(0, 16).padEnd(16)} | ${String(s.n).padStart(4)} | ${fmt(s.wr, 1).padStart(5)} | ${fmt(s.net).padStart(8)} | ${fmt(s.avg, 3).padStart(7)} | ${(s.profitFactor === Infinity ? "inf" : fmt(s.profitFactor)).padStart(4)} | ${fmt(s.fees)}`
    );
  }
}
function groupBy(xs, f) {
  const m = new Map();
  for (const x of xs) {
    const k = f(x) ?? "unknown";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.entries()];
}

// ── output ───────────────────────────────────────────────────────
const s = stats(rows);
const first = rows[0].closed_at.slice(0, 10);
const last = rows[rows.length - 1].closed_at.slice(0, 10);
const fromLog = rows.filter((t) => t._source === "trade_log").length;

console.log(`═══ TRADE PERFORMANCE ═══  ${first} → ${last}`);
console.log(`Trades: ${s.n} (${fromLog} from trades.jsonl, ${s.n - fromLog} from pool-memory)`);
console.log(`Win rate: ${fmt(s.wr, 1)}%  (${s.wins}W / ${s.losses}L)`);
console.log(`Net PnL: $${fmt(s.net)}   avg $${fmt(s.avg, 3)}/trade   profit factor ${s.profitFactor === Infinity ? "inf" : fmt(s.profitFactor)}`);
console.log(`Avg win $${fmt(s.avgWin)}  avg loss $${fmt(s.avgLoss)}  fees earned $${fmt(s.fees)}  avg hold ${fmt(s.avgHoldMin, 0)}m`);

// fee vs price attribution
const feeTotal = sum(rows, (t) => t.fees_earned_usd);
console.log(`Attribution: fees +$${fmt(feeTotal)} | price/IL $${fmt(s.net - feeTotal)} → net $${fmt(s.net)}`);

// daily table
console.log(`\n── Daily ${"─".repeat(51)}`);
console.log("date       |   n  |  WR%  |  net USD | cumulative");
let cum = 0;
for (const [day, xs] of groupBy(rows, (t) => t.closed_at.slice(0, 10))) {
  const d = stats(xs);
  cum += d.net;
  console.log(`${day} | ${String(d.n).padStart(4)} | ${fmt(d.wr, 1).padStart(5)} | ${fmt(d.net).padStart(8)} | ${fmt(cum).padStart(8)}`);
}

printGroup("By strategy", groupBy(rows, (t) => t.strategy));
if (rows.some((t) => t.slot != null)) printGroup("By slot", groupBy(rows, (t) => (t.slot != null ? `slot ${t.slot}` : "unknown")));
printGroup("By close trigger", groupBy(rows, (t) => t.close_trigger || categorize(t.close_reason)));

// volatility bands (entry-quality signal)
const withVol = rows.filter((t) => Number.isFinite(t.volatility_at_deploy));
if (withVol.length >= 10) {
  printGroup("By volatility at deploy", groupBy(withVol, (t) => {
    const v = t.volatility_at_deploy;
    if (v < 2) return "< 2.0";
    if (v < 3) return "2.0 - 3.0";
    if (v < 4) return "3.0 - 4.0";
    return ">= 4.0";
  }));
}

// biggest movers
const sorted = [...rows].sort((a, b) => a.pnl_usd - b.pnl_usd);
console.log(`\n── Biggest losses ${"─".repeat(42)}`);
for (const t of sorted.slice(0, 5)) {
  console.log(` ${t.closed_at.slice(0, 16)} ${String(t.pool_name || "?").padEnd(18)} $${fmt(t.pnl_usd).padStart(7)} (${fmt(t.pnl_pct, 1)}%) ${t.close_trigger || ""}`);
}
console.log(`── Biggest wins ${"─".repeat(44)}`);
for (const t of sorted.slice(-5).reverse()) {
  console.log(` ${t.closed_at.slice(0, 16)} ${String(t.pool_name || "?").padEnd(18)} $${fmt(t.pnl_usd).padStart(7)} (${fmt(t.pnl_pct, 1)}%) ${t.close_trigger || ""}`);
}
