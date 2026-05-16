# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## How Positions Get Closed

Two parallel systems monitor positions and trigger closes. The LLM is only the executor — it does NOT decide when to close.

### System 1: 30-Second PnL Poller (fast detection, no LLM)

Runs every 30s (`index.js` line 764). Fetches fresh position data from chain and checks exit rules in `updatePnlAndCheckExits()` (state.js) in priority order:

| Priority | Exit Type | Trigger | Config Keys |
|----------|-----------|---------|-------------|
| 1st | **Stop Loss** | `pnl_pct <= stopLossPct` | `stopLossPct` |
| 2nd | **Trailing Take Profit** | Peak reached `trailingTriggerPct`, then dropped by `trailingDropPct` from peak | `trailingTriggerPct`, `trailingDropPct`, `trailingTakeProfit` |
| 3rd | **Out of Range (time)** | Price above upper bin for `outOfRangeWaitMinutes` | `outOfRangeWaitMinutes` |
| 4th | **Low Yield** | `fee_per_tvl_24h < minFeePerTvl24h` AND age >= `minAgeBeforeYieldCheck` | `minFeePerTvl24h`, `minAgeBeforeYieldCheck` |

Also runs `getDeterministicCloseRule()` (index.js) as backup with 5 rules:

| Rule # | Trigger | Notes |
|--------|---------|-------|
| Rule 1 | `pnl_pct <= stopLossPct` | Same as poller stop loss |
| Rule 2 | `pnl_pct >= takeProfitPct` | Hard TP — no trailing, instant close at threshold |
| Rule 3 | Active bin > upper bin + `outOfRangeBinsToClose` | Price pumped far above range (10+ bins) |
| Rule 4 | OOR + `minutes_out_of_range >= outOfRangeWaitMinutes` | Same as poller OOR |
| Rule 5 | `fee_per_tvl_24h < minFeePerTvl24h` AND age >= 60 min | Hardcoded 60 min (bug: ignores `minAgeBeforeYieldCheck`) |

When either detects a close trigger → fires management cycle immediately (doesn't wait for cron).

### System 2: Management Cron (every `managementIntervalMin` minutes)

Runs on schedule. For each position:
1. Checks trailing TP + deterministic rules
2. Assigns action: **CLOSE**, **CLAIM**, **INSTRUCTION**, or **STAY**
3. All STAY → logs "skipping LLM", done
4. Action needed → calls LLM to execute (LLM cannot override CLOSE decisions)

The LLM prompt says: "Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute."

### Trailing Take Profit Flow

```
1. Position deployed at PnL 0%
2. PnL rises... 1%... 2%...
3. PnL hits trailingTriggerPct (3%) → Trailing TP ACTIVATED, peak tracking starts
4. PnL keeps rising... 4%... 5% (peak updated)
5. PnL drops to 3.5% (dropped 1.5% from peak of 5%)
6. Drop >= trailingDropPct (1.5%) → TRAILING TP TRIGGERED
7. 15-second recheck to confirm (anti-spike protection)
8. Still dropped → CLOSE
```

Trailing TP also combines with OOR: if position is profitable AND goes OOR for `outOfRangeWaitMinutes` → closes as "Trailing TP: Out of range for Xm" (most common close reason).

### After Close

```
close_position called by LLM
  → Claim fees
  → Remove liquidity
  → recordPerformance() → lessons.json
  → Pool-memory snapshot
  → Auto-swap base token → SOL via Jupiter
  → Telegram notification
  → If below maxPositions → trigger screening cycle
```

### Break-Even Exit (Rule 6)

Closes a position as soon as PnL recovers to a target % after being negative for a prolonged period. Frees up capital for better opportunities instead of sitting in a "stuck" position.

**Flow:**
```
1. Position deployed, PnL goes negative
2. negative_since timestamp recorded in state.js
3. Position stays negative for 15+ minutes (breakEvenMinNegativeMinutes)
4. PnL eventually recovers to +1% (breakEvenExitPct)
5. Position age >= 30 min (breakEvenMinAge)
6. → CLOSE: "break-even exit: PnL +1.00% after 45m negative"
```

**Config keys:**
```json
"breakEvenExitEnabled": true,       // enable/disable the feature
"breakEvenExitPct": 1,              // close when PnL reaches this % (1 = +1%)
"breakEvenMinAge": 30,              // position must be at least 30 min old
"breakEvenMinNegativeMinutes": 15   // must have been negative for 15+ min
```

**Implementation:** Tracked via `negative_since` in state.js position data. Check runs in both `updatePnlAndCheckExits()` (state.js, 30s poller) and `getDeterministicCloseRule()` (index.js, Rule 6). The `negative_since` timestamp is set when PnL first goes negative and cleared when PnL returns positive (after break-even check).

**Files changed:** `state.js` (negative_since tracking + exit check), `index.js` (Rule 6 backup), `config.js` (4 new config keys), `tools/executor.js` (update_config allow-list)

### Bug: Dual Low-Yield Check with Different Thresholds

`getDeterministicCloseRule()` in index.js uses hardcoded `age >= 60` minutes, while `updatePnlAndCheckExits()` in state.js correctly uses `minAgeBeforeYieldCheck` from config. The state.js version runs first (via 30s poller), so the config value is effectively used — but the index.js version can override with 60 min if the poller misses it.

---

## Screening Pipeline & Why Deploys Fail

The screening-to-deploy pipeline has **4 layers** where candidates can be rejected. When the agent screens but doesn't deploy, one of these layers blocked it:

### Layer 1: Hard Filters (code, before LLM)
After `getTopCandidates()` returns pools, `index.js` applies hard filters:
- **Blocked launchpad** — pool's launchpad is in `blockedLaunchpads`
- **Bot holders %** — Jupiter audit says bots > `maxBotHoldersPct` → dropped

If ALL candidates fail → "No candidates available", LLM never runs.

### Layer 2: Lone Candidate Skip (code, `getLoneCandidateSkipReason()` in index.js)
If only **1 candidate** survives Layer 1, code checks:
- `is_wash` = true → skip
- `is_rugpull` + no smart wallets → skip
- `is_pvp` + no smart wallets → skip
- Token fees < `minTokenFeesSol` → skip
- Top10 holders > `maxTop10Pct` → skip
- Bot holders > `maxBotHoldersPct` → skip
- No narrative + no smart wallets → skip

### Layer 3: LLM Decision
If 2+ candidates pass, LLM chooses. It can still say "no deploy".

### Layer 4: Safety Checks (executor.js `runSafetyChecks`)
Even after LLM calls `deploy_position`:
- Pool TVL outside `minTvl`/`maxTvl`
- Fee/active-TVL ratio below `minFeeActiveTvlRatio`
- Volatility = 0 or null → rejected
- Bin step outside `minBinStep`/`maxBinStep`
- Max positions reached
- Duplicate pool or base token
- Insufficient SOL balance
- `amount_x > 0` rejected (single-side SOL only)

### Pool Threshold Validation (`validateDeployPoolThresholds`)
Called first in Layer 4 — fetches fresh pool detail from Meteora API and re-checks:
- TVL within range
- Fee/active-TVL ratio above minimum
- Volatility > 0 (uses 30m minimum timeframe)
- Bin step within range

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Performance Analysis & Config Tuning (Learned from Live Data)

This section documents real performance patterns discovered from analyzing May 5-12, 2026 live trading data. Use this to guide future config tuning.

### Daily Performance Log

Real results from each day with the config that was active. SOL was in a steady uptrend the entire period ($84 → $97, +15% over 7 days). **The market was green every day — losses were caused by config, not market.**

| Day | SOL Daily | Stop Loss | OOR Wait | Mgmt Int | Deploys | SL Hits | SL Damage | Win Rate | Total PnL |
|-----|-----------|-----------|----------|----------|---------|---------|-----------|----------|-----------|
| **May 8** | +3.6% | -35% | 15m | 10m | 26 | 1 | -$5.50 | ~70% | **positive** |
| **May 9** | +0.9% | -35%→-5% | 15m | 10m | 20 | 2 | -$3.50 | ~65% | near zero |
| **May 10** | +1.3% | -5% | 15→8m | 10→5m | 35 | 2 | -$8.00 | 68% | **-0.13% avg** |
| **May 11** | +0.8% | -7% | 8→12m | 5m | 21 | 2 | -$17.11 | 40% | **-$17.30** |

### Key Insight: Market Was Never the Problem

Every stop-loss casualty had **100% range efficiency** — they stayed in range but bled slowly. In a +0.8% to +3.6% daily SOL market, these positions would have recovered if the stop loss was wider. The tight -5% to -7% SL killed positions during **normal meme token volatility**, not during crashes.

**Proof**: On May 11 without the 2 stop-loss blowouts (Apple -$7.72, chudhouse -$9.39), the other 18 trades netted **-$0.19 (break-even)**. The losses were 100% config-driven.

### Config Regime Profiles

Three tested regimes, from aggressive to conservative:

| Setting | Defaults (May 8) | Trend Mode (current) | Scalper (tested May 10) |
|---------|-------------------|----------------------|------------------------|
| `stopLossPct` | -35 | **-15** | -5 |
| `takeProfitPct` | 5 | **8** | 5 |
| `trailingDropPct` | 1.5 | **1.5** | 0.8 |
| `trailingTriggerPct` | 3 | **3** | 3 |
| `outOfRangeWaitMinutes` | 15 | **12** | 8 |
| `managementIntervalMin` | 10 | **7** | 5 |
| `minTokenFeesSol` | 30 | **40** | 75 |
| `maxBotHoldersPct` | 30 | **30** | 20 |

### How Each Setting Reacts to Market Conditions

#### `stopLossPct` — The Most Impactful Setting

| SL Value | Effect in Uptrend (+1%/day) | Effect in Choppy (0%/day) | Effect in Downtrend (-2%/day) |
|----------|---------------------------|--------------------------|------------------------------|
| -5% | Bad: kills winners during normal dips. Avg meme token swings 5-10% intraday even in uptrends | Very bad: nearly every position hits SL | Acceptable: cuts losses fast |
| -15% | Good: survives dips, catches recovery. Only rugpulls hit SL | Good: most positions survive chop | Risky: slow bleed positions hold too long |
| -35% | Risky: one rugpull = catastrophic loss (-45% UAP). But 25/26 other trades survived | Bad: lets losers bleed forever | Very bad: massive drawdowns |

**Rule**: Meme tokens swing 5-15% intraday as normal volatility. SL must be wider than the normal swing range or it becomes a guaranteed loss on every dip.

#### `outOfRangeWaitMinutes` — Entry Timing Validator

| OOR Wait | What Happens | When It Helps | When It Hurts |
|----------|-------------|---------------|---------------|
| 8 min | Closes positions aggressively | Downtrend: exits bad entries fast | Uptrend: kills positions that would recover in 10-15 min |
| 12 min | Balanced — gives recovery time | All markets: reasonable compromise | None observed |
| 15 min | Patient — waits for recovery | Strong uptrend: positions return to range | Downtrend: holds losers too long |

**Data**: On May 11 at 8 min, WhiteWhale and Goblin were closed right before recovery. On May 8 at 15 min, similar positions survived OOR and became profitable.

#### `managementIntervalMin` — Over-management Risk

| Interval | Effect | Data |
|----------|--------|------|
| 5 min | Over-manages: checks too often, triggers exit rules prematurely | May 10-11: 21-35 deploys/day but low quality decisions |
| 7 min | Balanced | Current setting |
| 10 min | Relaxed: fewer checks = positions get time to develop | May 8: 26 deploys, best day |

**Rule**: More frequent checks ≠ better performance. The LLM makes worse decisions when it sees micro-fluctuations every 5 minutes vs broader trends every 10 minutes.

#### `minTokenFeesSol` + `maxBotHoldersPct` — Candidate Pool Size

These two interact. Both tight = no candidates. Both loose = bad candidates.

| minTokenFeesSol | maxBotHoldersPct | Candidate Count | Quality |
|-----------------|------------------|-----------------|---------|
| 75 | 20% | 0-1 per cycle | Agent idles for hours, lone survivor is usually bad |
| 40 | 30% | 3-5 per cycle | Good variety, LLM can choose wisely |
| 30 | 30% | 5-8 per cycle | May 8 defaults: high volume, good selection |
| 20 | 40% | 8-10 per cycle | Too loose: low-quality tokens sneak through |

**Rule**: The agent needs 2+ candidates per screening cycle for the LLM to make meaningful comparisons. If it's down to 1, the lone-candidate skip logic often kills it anyway.

#### `takeProfitPct` — Market Regime Dependent

| TP Value | Uptrend Effect | Choppy Effect | Rationale |
|----------|---------------|---------------|-----------|
| 5% | Caps winners too early. May 8: multiple trades peaked at 3-5% then kept going | Good: locks in small gains | Use in chop |
| 8% | Good balance for mild uptrend / consolidation | Rarely triggers — most trades close via trailing TP or OOR instead | Current choice |
| 12% | Good for strong uptrend: lets runners run | Almost never triggers in flat market | Use when SOL 7d > +10% |

#### `oorCooldownHours` — Revenge Trade Prevention

| Value | Effect | Data |
|-------|--------|------|
| 12h | Agent re-deploys into same pool after half a day. ASTEROID got 5 deploys in one day | May 11: ASTEROID 5 deploys, only 1 tiny win |
| 24h | Blocks same pool for full day | Prevents revenge trading pattern |

### Market Regime Detection & Config Guide

Check SOL price action to pick the right config. Use CoinGecko API:
`https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false`
Check `market_data.price_change_percentage_7d` and `market_data.price_change_percentage_24h`.

#### Strong Uptrend (SOL 7d > +10%, daily > +1%)
```
stopLossPct: -15        # Wide — let positions survive dips
takeProfitPct: 10-12    # Let runners run
outOfRangeWaitMinutes: 12-15  # Patient — positions recover in uptrends
managementIntervalMin: 7-10   # Don't over-manage
```
This is what May 8 looked like (+3.6% daily). Wide SL + patient OOR = 70% win rate.

#### Consolidation / Mild Trend (SOL 7d +/-5%, daily < +1%)
```
stopLossPct: -15        # Still wide — meme tokens swing regardless
takeProfitPct: 8        # Take profits sooner, fewer runners
outOfRangeWaitMinutes: 12     # Balanced
managementIntervalMin: 7      # Balanced
```
Current config (May 12). SOL flattening after rally.

#### Choppy / Sideways (SOL 7d +/-3%, frequent intraday reversals)
```
stopLossPct: -10        # Tighter but not scalper-tight
takeProfitPct: 5-8      # Quick profits
outOfRangeWaitMinutes: 10     # Faster exits
managementIntervalMin: 7      # Standard
minTokenFeesSol: 50     # Higher bar — only trade active pools
```

#### Downtrend (SOL 7d < -5%)
```
stopLossPct: -10        # Tight — cut losses
takeProfitPct: 5        # Grab any profit
outOfRangeWaitMinutes: 8      # Exit fast
maxPositions: 1         # Reduce exposure
minTokenFeesSol: 60     # Only high-fee pools worth the risk
```
Consider pausing (`dryRun: true`) if SOL 7d < -15%.

### Loss Anatomy — What Actually Kills Profitability

From 80+ tracked trades, losses come from exactly 3 sources:

| Loss Source | % of Total Losses | How to Detect | How to Fix |
|-------------|-------------------|---------------|------------|
| **Stop-loss blowouts** | ~70% | range_efficiency = 100% but pnl < -5% | Widen SL to -15%. These are tokens bleeding slowly while in range — they might recover |
| **Bad token screening** | ~20% | rugpull/wash flags ignored, OKX unavailable | Harden prompt.js to never deploy when OKX data missing. Add to blacklist |
| **Premature OOR close** | ~10% | Closed OOR at 8 min, price recovered within 20 min | Use 12+ min OOR wait |

**The win rate itself is misleading.** A 40% win rate is fine IF avg win > avg loss. The problem is when avg loss is 10x avg win (which happens with SL blowouts). Fix the blowout ratio, not the win rate.

### Current Config Rationale (as of May 12, 2026)

```
stopLossPct: -15       # Wide enough for dips, tight enough vs rugpulls
takeProfitPct: 8        # SOL consolidating after +15% 7d rally — take profits sooner
trailingDropPct: 1.5    # Standard — don't change
outOfRangeWaitMinutes: 12  # Compromise between 8 (too fast) and 15 (too slow)
managementIntervalMin: 7   # Less over-management than 5, more responsive than 10
minTokenFeesSol: 40     # Low enough for candidate variety, high enough to filter dead pools
maxBotHoldersPct: 30    # Normal for meme tokens — 20% filtered everything
oorCooldownHours: 24    # Prevent revenge trades on same pool
minAgeBeforeYieldCheck: 45  # Kill dead positions in 45 min, not 2 hours
lpAgentRelayEnabled: false  # Relay is broken, skip it
strategy: "spot"        # Matches what LLM actually picks 87% of the time
maxPositions: 1         # Single position with ~2 SOL wallet
deployAmountSol: 1.2    # Sized for current wallet
```

### How To Analyze Performance

1. **Pull files from server via FileZilla**: `pool-memory.json`, `lessons.json`, `state.json`, `logs/agent-YYYY-MM-DD.log`
2. **pool-memory.json**: Each pool has `deploys[]` with `closed_at`, `pnl_pct`, `pnl_usd`, `minutes_held`, `close_reason`, `range_efficiency`
3. **Key metrics**: Win rate, avg PnL, total PnL, avg hold time. Also check close reasons distribution (trailing TP vs SL vs OOR vs low yield)
4. **Watch for**: Loss-to-win ratio (should be < 2:1), stop-loss blowouts (> -5% each), OOR within first 5 min (bad entry), revenge trades (same pool multiple losses)
5. **state.json**: Can accumulate stale entries. Clean with `echo '{"positions":{}}' > state.json` on server if bloated
6. **Compare daily logs**: Count `DEPLOYED` lines per day for trade volume. Search `Stop loss` for SL hits. Check the `-XX%` value to see if SL was actually the right call or a premature kill

---

## Deployment

Agent runs on **AWS Lightsail** (Ubuntu). The `user-config.json` is gitignored — must be manually synced to server via FileZilla.

Workflow for config changes:
1. Edit `user-config.json` locally
2. Upload to server via FileZilla
3. Agent hot-reloads automatically (no restart needed)

---

## Second Agent: duit-cepat

A yield-triggered fast management variant lives in `C:\Data\Duit\duit-cepat\`. Key differences:
- **Yield-triggered management**: When position yield > threshold, management interval drops to 1 min
- **Cron offset**: Uses `cronOffsetMin` to avoid RPC overlap with main duit agent
- **Config keys**: `yieldTriggerEnabled`, `yieldTriggerThreshold`, `fastIntervalMin`, `cronOffsetMin`
- **Status**: Created, not yet deployed to server

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- LLM bypasses rugpull/wash-trading flags when OKX data unavailable — needs prompt.js hardening.
- Agent Meridian relay constantly times out — disabled via `lpAgentRelayEnabled: false`.
- HiveMind throws intermittent 504 errors — consider `hiveMindEnabled: false` if persistent.
