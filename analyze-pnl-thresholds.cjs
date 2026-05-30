#!/usr/bin/env node
/*
 * analyze-pnl-thresholds.cjs
 * ---------------------------------------------------------------------------
 * Extracts the PnL distribution and close-reason breakdown from lessons.json
 * (with pool-memory.json fallback) so you can pick stopLossPct and
 * trailingDropPct / trailingTriggerPct from your OWN data instead of guessing.
 *
 * What it prints:
 *   1. Overall PnL distribution: min, p1, p5, p10, p25, median, p75, p90, p95, p99, max
 *   2. Loss-only distribution (informs stopLossPct floor)
 *   3. Win-only distribution (informs trailingTriggerPct + drop)
 *   4. Breakdown by close_reason (which exits realize which PnL)
 *   5. SL "what-if" simulation: at SL = -X%, how many trades would have hit it
 *   6. Suggested SL / trailing based on percentiles
 *
 * Usage:
 *   node analyze-pnl-thresholds.cjs
 *   node analyze-pnl-thresholds.cjs --since=2026-05-15
 *   node analyze-pnl-thresholds.cjs --until=2026-05-25
 *   node analyze-pnl-thresholds.cjs --source=pool-memory    # use pool-memory.json instead
 * ---------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
);
const SINCE = args.since ? Date.parse(args.since) : null;
const UNTIL = args.until ? Date.parse(args.until) : null;
const SOURCE = args.source || "lessons";

// ── load trades ─────────────────────────────────────────────────────────────
function loadFromLessons() {
  const p = path.join(__dirname, "lessons.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  return (data.performance || [])
    .filter((r) => r && typeof r.pnl_pct === "number")
    .map((r) => ({
      pnl_pct: r.pnl_pct,
      pnl_usd: r.pnl_usd,
      close_reason: r.close_reason || "?",
      minutes_held: r.minutes_held,
      volatility: r.signal_snapshot?.volatility ?? r.volatility,
      pool_name: r.pool_name,
      ts: Date.parse(r.recorded_at || 0) || 0,
    }));
}

function loadFromPoolMemory() {
  const p = path.join(__dirname, "pool-memory.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const out = [];
  for (const [, pool] of Object.entries(data || {})) {
    for (const d of pool?.deploys || []) {
      if (typeof d.pnl_pct !== "number") continue;
      out.push({
        pnl_pct: d.pnl_pct,
        pnl_usd: d.pnl_usd,
        close_reason: d.close_reason || "?",
        minutes_held: d.minutes_held,
        volatility: d.volatility_at_deploy,
        pool_name: pool.name,
        ts: Date.parse(d.closed_at || d.deployed_at || 0) || 0,
      });
    }
  }
  return out;
}

let trades;
try {
  trades = SOURCE === "pool-memory" ? loadFromPoolMemory() : loadFromLessons();
} catch (e) {
  console.error(`Could not load ${SOURCE}.json:`, e.message);
  process.exit(1);
}
if (SINCE || UNTIL) {
  trades = trades.filter((t) => (!SINCE || t.ts >= SINCE) && (!UNTIL || t.ts <= UNTIL));
}
if (!trades.length) {
  console.log("No trades to analyze.");
  process.exit(0);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const sum = (a) => a.reduce((s, x) => s + x, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "  n/a");

function percentiles(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return {
    n: v.length,
    min: v[0],
    p1: at(0.01),
    p5: at(0.05),
    p10: at(0.10),
    p25: at(0.25),
    med: at(0.50),
    p75: at(0.75),
    p90: at(0.90),
    p95: at(0.95),
    p99: at(0.99),
    max: v[v.length - 1],
  };
}

function printDist(label, values) {
  const d = percentiles(values);
  if (!d) return console.log(`  ${label}: no data`);
  console.log(
    `  ${label.padEnd(14)} n=${String(d.n).padStart(4)} | min ${fmt(d.min).padStart(7)} | p5 ${fmt(d.p5).padStart(7)} | p10 ${fmt(d.p10).padStart(7)} | p25 ${fmt(d.p25).padStart(7)} | med ${fmt(d.med).padStart(7)} | p75 ${fmt(d.p75).padStart(7)} | p90 ${fmt(d.p90).padStart(7)} | p95 ${fmt(d.p95).padStart(7)} | max ${fmt(d.max).padStart(7)}`
  );
}

// ── 1. Overall ──────────────────────────────────────────────────────────────
console.log("================ PnL THRESHOLD ANALYSIS ================");
console.log(`source: ${SOURCE}.json | trades: ${trades.length}` +
  (SINCE || UNTIL ? ` | window: ${args.since || "(start)"} -> ${args.until || "(latest)"}` : ""));
const all = trades.map((t) => t.pnl_pct);
const wins = trades.filter((t) => t.pnl_pct > 0);
const losses = trades.filter((t) => t.pnl_pct <= 0);
const totalUsd = sum(trades.map((t) => t.pnl_usd || 0));
console.log(
  `overall: win ${Math.round(100 * wins.length / trades.length)}% | avg PnL ${fmt(avg(all))}% | total $${fmt(totalUsd)}`
);

console.log("\n=== PnL DISTRIBUTION ===");
printDist("ALL", all);
printDist("WINS", wins.map((t) => t.pnl_pct));
printDist("LOSSES", losses.map((t) => t.pnl_pct));

// ── 2. By close_reason ──────────────────────────────────────────────────────
console.log("\n=== BY CLOSE REASON ===");
const byReason = new Map();
for (const t of trades) {
  const key = String(t.close_reason).toLowerCase().slice(0, 40);
  if (!byReason.has(key)) byReason.set(key, []);
  byReason.get(key).push(t);
}
const reasonRows = [...byReason.entries()]
  .map(([k, ts]) => ({
    reason: k,
    n: ts.length,
    win: Math.round(100 * ts.filter((t) => t.pnl_pct > 0).length / ts.length),
    avg: avg(ts.map((t) => t.pnl_pct)),
    min: Math.min(...ts.map((t) => t.pnl_pct)),
    max: Math.max(...ts.map((t) => t.pnl_pct)),
    usd: sum(ts.map((t) => t.pnl_usd || 0)),
  }))
  .sort((a, b) => b.n - a.n);
console.log("  reason".padEnd(43) + "|  n  | win% | avgPnL | minPnL | maxPnL | total$");
for (const r of reasonRows) {
  console.log(
    "  " + r.reason.padEnd(40) +
      ` | ${String(r.n).padStart(3)} | ${String(r.win).padStart(3)}% | ${fmt(r.avg).padStart(6)}% | ${fmt(r.min).padStart(6)}% | ${fmt(r.max).padStart(6)}% | ${fmt(r.usd).padStart(7)}`
  );
}

// ── 3. SL what-if simulation ────────────────────────────────────────────────
console.log("\n=== STOP-LOSS WHAT-IF (hit rate at each level) ===");
console.log("  If SL had been set at -X%, this fraction of trades would have hit it.");
console.log("  (note: trades that already SL'd are counted at their realized PnL)");
console.log("  SL%   | trades hit | % of all | sum loss saved/added vs realized");
for (const sl of [-3, -5, -7, -8, -10, -12, -13, -15, -20, -25, -30]) {
  const hits = trades.filter((t) => t.pnl_pct <= sl);
  const realizedOnHits = sum(hits.map((t) => t.pnl_pct));
  const ifClippedAtSl = hits.length * sl;
  const delta = ifClippedAtSl - realizedOnHits;  // positive = SL would have lost less
  console.log(
    `  ${String(sl).padStart(4)}% |   ${String(hits.length).padStart(3)}      |  ${String(Math.round(100 * hits.length / trades.length)).padStart(3)}%   |  ${fmt(delta).padStart(8)}% (sum of pnl deltas)`
  );
}

// ── 4. Win distribution buckets (informs trailing) ──────────────────────────
console.log("\n=== WIN BUCKETS (informs trailingTriggerPct / trailingDropPct) ===");
const winBands = [
  ["0 to 1%", (p) => p > 0 && p <= 1],
  ["1 to 2%", (p) => p > 1 && p <= 2],
  ["2 to 3%", (p) => p > 2 && p <= 3],
  ["3 to 4%", (p) => p > 3 && p <= 4],
  ["4 to 5%", (p) => p > 4 && p <= 5],
  ["5 to 7%", (p) => p > 5 && p <= 7],
  ["7 to 10%", (p) => p > 7 && p <= 10],
  ["10%+", (p) => p > 10],
];
console.log("  band     |   n  | % of wins | cumulative");
let cum = 0;
for (const [label, fn] of winBands) {
  const n = wins.filter((t) => fn(t.pnl_pct)).length;
  cum += n;
  const pct = wins.length ? Math.round(100 * n / wins.length) : 0;
  const cumPct = wins.length ? Math.round(100 * cum / wins.length) : 0;
  console.log(`  ${label.padEnd(8)} |  ${String(n).padStart(3)} |    ${String(pct).padStart(3)}%   |   ${String(cumPct).padStart(3)}%`);
}

// ── 5. Top losses & wins (raw inspection) ───────────────────────────────────
console.log("\n=== TOP 10 WORST LOSSES (sets the SL ceiling) ===");
const worst = [...trades].sort((a, b) => a.pnl_pct - b.pnl_pct).slice(0, 10);
for (const t of worst) {
  console.log(
    `  ${(t.pool_name || "?").padEnd(20)} ${fmt(t.pnl_pct).padStart(7)}%  ${fmt(t.pnl_usd).padStart(7)}$  vol ${fmt(t.volatility).padStart(5)}  ${String(t.minutes_held ?? "?").padStart(4)}m  ${t.close_reason}`
  );
}
console.log("\n=== TOP 10 BEST WINS (shows what your trailing cuts off) ===");
const best = [...trades].sort((a, b) => b.pnl_pct - a.pnl_pct).slice(0, 10);
for (const t of best) {
  console.log(
    `  ${(t.pool_name || "?").padEnd(20)} ${fmt(t.pnl_pct).padStart(7)}%  ${fmt(t.pnl_usd).padStart(7)}$  vol ${fmt(t.volatility).padStart(5)}  ${String(t.minutes_held ?? "?").padStart(4)}m  ${t.close_reason}`
  );
}

// ── 6. Suggestions ──────────────────────────────────────────────────────────
console.log("\n=== SUGGESTED THRESHOLDS (rule-of-thumb from your distribution) ===");
const lossDist = percentiles(losses.map((t) => t.pnl_pct));
const winDist = percentiles(wins.map((t) => t.pnl_pct));
if (lossDist) {
  console.log(`  Loss distribution: min ${fmt(lossDist.min)}% | p10 ${fmt(lossDist.p10)}% | p25 ${fmt(lossDist.p25)}% | median ${fmt(lossDist.med)}%`);
  console.log(`  → stopLossPct candidates:`);
  console.log(`     ${fmt(lossDist.p10)}%  (catches worst 10% of losses)`);
  console.log(`     ${fmt(lossDist.p5)}%   (catches worst 5%)`);
  console.log(`     ${fmt(Math.min(-5, lossDist.p25))}%  (catches everything past loss p25)`);
  console.log(`     Note: tighter SL closes more losers but also kills positions in normal vol swings.`);
}
if (winDist) {
  console.log(`  Win distribution:  median ${fmt(winDist.med)}% | p75 ${fmt(winDist.p75)}% | p90 ${fmt(winDist.p90)}% | max ${fmt(winDist.max)}%`);
  console.log(`  → trailingTriggerPct candidates:`);
  console.log(`     ${fmt(winDist.med)}%   (activates on median win — current behavior)`);
  console.log(`     ${fmt(winDist.p75)}%   (only trails the top 25% of wins — lets small wins run uncapped)`);
  console.log(`  → trailingDropPct candidates: 2-4× memecoin tick noise (often 2.5%-5%).`);
  console.log(`     Current 1.2%-1.5% drop fires on noise — you'd close around your median win.`);
}
console.log("\nDONE.");
