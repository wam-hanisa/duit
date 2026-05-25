#!/usr/bin/env node
/*
 * analyze-snapshots.cjs
 * ---------------------------------------------------------------------------
 * Thread-style snapshot-metric analysis (inspired by @dikibagast's
 * "Hindari Overfitting di Automated Trading" thread).
 *
 * Reads  lessons.json -> performance[].signal_snapshot   (entry metrics)
 * paired with the trade result (pnl_pct, pnl_usd) and buckets each metric so
 * you can see whether any is a worthwhile, NON-overfit filter.
 *
 * Discipline reminder (from the thread): statistical significance != practical
 * value. Before acting on ANY bucket, ask:
 *   1. Is the thesis concrete and clear?
 *   2. How much expected-value improvement?
 *   3. How much opportunity cost (winners removed)?
 *   4. Does the pattern REPLICATE across time windows? (use --since to test)
 *   5. Is the bucket big enough to trust? (n < ~20 is noise-prone, flagged *)
 * "The Simpler The Better" — keep zero filters until one clearly earns its place.
 *
 * Usage:
 *   node analyze-snapshots.cjs                    # all records that have a snapshot
 *   node analyze-snapshots.cjs --since=2026-05-16 # only closes on/after this date
 *   node analyze-snapshots.cjs --until=2026-05-23 # only closes on/before this date
 *   node analyze-snapshots.cjs --cat=-10          # catastrophic-loss threshold % (default -10)
 *   node analyze-snapshots.cjs --min=20           # small-bucket warning threshold (default 20)
 * ---------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

// ── args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
);
const SINCE = args.since ? Date.parse(args.since) : null;
const UNTIL = args.until ? Date.parse(args.until) : null;
const CAT = args.cat != null && args.cat !== true ? Number(args.cat) : -10; // catastrophic <= this %
const MIN_N = args.min != null && args.min !== true ? Number(args.min) : 20; // small-bucket flag

// Volume-trend thresholds (calibrate once volume_change_pct data accumulates).
const ACCEL = 20;   // volume_change_pct >  +20  => "Accelerating"
const DECEL = -20;  // volume_change_pct <  -20  => "Decelerating"  (else "Stable")

// ── load ──────────────────────────────────────────────────────────────────
const LESSONS = path.join(__dirname, "lessons.json");
let data;
try {
  data = JSON.parse(fs.readFileSync(LESSONS, "utf8"));
} catch (e) {
  console.error("Could not read lessons.json:", e.message);
  process.exit(1);
}

let perf = (data.performance || []).filter(
  (p) => p && p.signal_snapshot && typeof p.signal_snapshot === "object" && typeof p.pnl_pct === "number"
);
if (SINCE || UNTIL) {
  perf = perf.filter((p) => {
    const t = Date.parse(p.recorded_at || p.signal_snapshot?.closed_at || 0);
    if (SINCE && !(t >= SINCE)) return false;
    if (UNTIL && !(t <= UNTIL)) return false;
    return true;
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────
const sum = (a) => a.reduce((s, x) => s + x, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const get = (p, f) => p.signal_snapshot[f];
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "  n/a");
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

function percentiles(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { min: v[0], p25: at(0.25), med: at(0.5), p75: at(0.75), max: v[v.length - 1] };
}

function table(title, field, bands) {
  const have = perf.filter((p) => typeof get(p, field) === "number");
  console.log(`\n=== ${title}  (n=${have.length}${have.length ? "" : " — not logged yet"}) ===`);
  if (!have.length) {
    console.log("  (no records carry this field yet — keep running to collect data)");
    return;
  }
  const dist = percentiles(have.map((p) => get(p, field)));
  if (dist) console.log(`  distribution: min ${fmt(dist.min)} | p25 ${fmt(dist.p25)} | median ${fmt(dist.med)} | p75 ${fmt(dist.p75)} | max ${fmt(dist.max)}`);
  console.log("  " + "bucket".padEnd(13) + "| Pos | Win% | AvgPnL% | Total$ | #cat");
  for (const [label, f] of bands) {
    const b = have.filter((p) => f(get(p, field)));
    if (!b.length) {
      console.log("  " + label.padEnd(13) + "|   0 |");
      continue;
    }
    const wins = b.filter((p) => p.pnl_pct > 0).length;
    const cat = b.filter((p) => p.pnl_pct <= CAT).length;
    const flag = b.length < MIN_N ? " *" : "";
    console.log(
      "  " +
        label.padEnd(13) +
        `| ${String(b.length).padStart(3)} | ${String(pct(wins, b.length)).padStart(3)}% | ` +
        `${fmt(avg(b.map((p) => p.pnl_pct))).padStart(6)}% | ${fmt(sum(b.map((p) => p.pnl_usd || 0))).padStart(7)} | ${cat}${flag}`
    );
  }
}

// ── header ───────────────────────────────────────────────────────────────────
console.log("================ SNAPSHOT-METRIC ANALYSIS ================");
console.log(`source: ${LESSONS}`);
if (SINCE || UNTIL) console.log(`window: ${args.since || "(start)"} -> ${args.until || "(latest)"}`);
console.log(`records with snapshot + pnl: ${perf.length}`);
if (!perf.length) {
  console.log("No analyzable records. (Has the agent closed positions with signal snapshots yet?)");
  process.exit(0);
}
const dates = perf.map((p) => p.recorded_at).filter(Boolean).sort();
console.log(`closed range: ${dates[0]} -> ${dates[dates.length - 1]}`);
console.log(
  `overall: win ${pct(perf.filter((p) => p.pnl_pct > 0).length, perf.length)}% | ` +
    `avgPnL ${fmt(avg(perf.map((p) => p.pnl_pct)))}% | totalPnL $${fmt(sum(perf.map((p) => p.pnl_usd || 0)))}`
);
console.log(`(small buckets, n < ${MIN_N}, are flagged with * — treat as noise-prone)`);

// ── catastrophic losses ──────────────────────────────────────────────────────
const cat = perf.filter((p) => p.pnl_pct <= CAT).sort((a, b) => a.pnl_pct - b.pnl_pct);
console.log(`\n=== CATASTROPHIC LOSSES (pnl <= ${CAT}%): ${cat.length} ===`);
for (const p of cat) {
  const s = p.signal_snapshot;
  console.log(
    `  ${(p.pool_name || "?").padEnd(15)} ${fmt(p.pnl_pct, 1).padStart(6)}%  ` +
      `vol ${fmt(s.volatility).padStart(6)}  volΔ% ${fmt(s.volume_change_pct).padStart(7)}  ` +
      `volume ${String(Math.round(s.volume ?? NaN)).padStart(7)}  fee/tvl ${fmt(s.fee_tvl_ratio).padStart(6)}  holders ${String(s.holder_count ?? "?").padStart(6)}`
  );
}

// ── per-metric bucket tables ─────────────────────────────────────────────────
table("VOLUME TREND (volume_change_pct) — the thread's signal", "volume_change_pct", [
  ["Decelerating", (v) => v <= DECEL],
  ["Stable", (v) => v > DECEL && v < ACCEL],
  ["Accelerating", (v) => v >= ACCEL],
]);

table("VOLUME (raw at entry)", "volume", [
  ["<1000", (v) => v < 1000],
  ["1000-2500", (v) => v >= 1000 && v < 2500],
  ["2500-5000", (v) => v >= 2500 && v < 5000],
  ["5000-10k", (v) => v >= 5000 && v < 10000],
  ["10k-25k", (v) => v >= 10000 && v < 25000],
  ["25k+", (v) => v >= 25000],
]);

table("FEE / TVL RATIO", "fee_tvl_ratio", [
  ["<0.3", (v) => v < 0.3],
  ["0.3-0.6", (v) => v >= 0.3 && v < 0.6],
  ["0.6-1.0", (v) => v >= 0.6 && v < 1.0],
  ["1.0-1.5", (v) => v >= 1.0 && v < 1.5],
  ["1.5-2.5", (v) => v >= 1.5 && v < 2.5],
  ["2.5+", (v) => v >= 2.5],
]);

table("HOLDER COUNT", "holder_count", [
  ["<1000", (v) => v < 1000],
  ["1000-1499", (v) => v >= 1000 && v < 1500],
  ["1500-1999", (v) => v >= 1500 && v < 2000],
  ["2000-2999", (v) => v >= 2000 && v < 3000],
  ["3000-4999", (v) => v >= 3000 && v < 5000],
  ["5000+", (v) => v >= 5000],
]);

table("MCAP", "mcap", [
  ["<100k", (v) => v < 100000],
  ["100k-200k", (v) => v >= 100000 && v < 200000],
  ["200k-500k", (v) => v >= 200000 && v < 500000],
  ["500k-1M", (v) => v >= 500000 && v < 1000000],
  ["1M+", (v) => v >= 1000000],
]);

table("ORGANIC SCORE", "organic_score", [
  ["<55", (v) => v < 55],
  ["55-65", (v) => v >= 55 && v < 65],
  ["65-75", (v) => v >= 65 && v < 75],
  ["75-85", (v) => v >= 75 && v < 85],
  ["85+", (v) => v >= 85],
]);

table("VOLATILITY", "volatility", [
  ["<2.0", (v) => v < 2.0],
  ["2.0-2.5", (v) => v >= 2.0 && v < 2.5],
  ["2.5-3.0", (v) => v >= 2.5 && v < 3.0],
  ["3.0-3.5", (v) => v >= 3.0 && v < 3.5],
  ["3.5-5.0", (v) => v >= 3.5 && v < 5.0],
  ["5.0+", (v) => v >= 5.0],
]);

console.log("\n--------------------------------------------------------------");
console.log("Before turning ANY bucket into a filter, confirm: clear thesis +");
console.log("EV gain + low opportunity cost + replicates across windows (--since)");
console.log("+ bucket not flagged *. Otherwise it's overfitting. Simpler is better.");
