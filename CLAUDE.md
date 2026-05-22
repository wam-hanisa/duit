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
pool-memory.js      Per-pool deploy history + snapshots + cooldown helpers
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
  screening.js      Pool discovery from Meteora API (multi-category)
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

### Screening Config Keys

| Key | Default | Purpose |
|-----|---------|---------|
| `category` | `"trending"` | Primary Meteora pool category |
| `secondaryCategory` | `null` | Optional 2nd category (overlaps trending heavily) |
| `extraCategories` | `[]` | Extra categories array — e.g. `["new","top"]` (deduped + merged) |
| `poolPageSize` | `100` | Meteora API page_size per category |
| `timeframe` | `"1h"` | Timeframe for volatility metric |
| `minTvl` / `maxTvl` | 15k / 300k | TVL range |
| `minVolume` | 300 | Min 24h volume |
| `minOrganic` / `minQuoteOrganic` | 45 / 40 | Jupiter organic score thresholds |
| `minHolders` | 300 | Min holder count |
| `minMcap` / `maxMcap` | 50k / 80M | Market cap range |
| `minBinStep` / `maxBinStep` | 80 / 250 | DLMM bin step range |
| `minFeeActiveTvlRatio` / `maxFeeActiveTvlRatio` | 0.10 / 3.0 | Fee/active-TVL bounds |
| `minTokenAgeHours` / `maxTokenAgeHours` | 2 / `null` | Min 2h (avoid fresh-launch rugs); max removed May 22 — aged-but-trending tokens are survivors (99% of memes die in 3-7 days), and toxicity is token-specific tail risk, not age-driven. Other rules (volume/TVL/fee-ratio/organic) gate quality regardless of age. |
| `minTokenFeesSol` | 30 | Min global priority+jito fees paid |
| `maxBundlePct` | 7 | Max coordinated wallet concentration |
| `maxBotHoldersPct` | 55 | Max % of bot-classified holders (Jupiter audit) |
| `maxTop10Pct` | 60 | Max top-10 holder concentration |
| `maxSingleHolderPct` | 15 | Max % owned by any single non-pool wallet |
| `maxVolatility` | 5 | Reject pools above this volatility |
| `excludeHighSupplyConcentration` | `false` | If true, exclude high-supply-concentration pools (filter is conservative — leave off) |

### Re-Entry Cooldown Config Keys (see Re-Entry Cooldown System section)

| Key | Default | Purpose |
|-----|---------|---------|
| `reentryAfterLossHours` | 6 | Max cooldown window for any negative close |
| `reentryMinCooldownMin` | 30 | Hard minimum before smart re-entry check kicks in |
| `reentryAfterPumpMinutes` | 60 | Cooldown after a "pumped above" exit (mean-reversion risk) |
| `whaleDumpCooldownHours` | 12 | Base cooldown for whale-dump closes |
| `whaleDumpEscalationHours` | 48 | Cooldown when 2+ consecutive whale dumps |
| `whaleDumpBlacklistCount` | 3 | Refuse deploy entirely after this many consecutive dumps |

### Repeat-Deploy Cooldown Config Keys (this one benches *winners*)

| Key | Default (code) | Purpose |
|-----|---------|---------|
| `repeatDeployCooldownEnabled` | `true` → **set `false` (May 20)** | Benches a token after N consecutive *fee-generating (winning)* deploys. **Disabled** — it was benching proven winners and starving the candidate pool (45 winner-cooldowns accumulated vs 29 loss-cooldowns; see Performance Analysis). A winner should stay a candidate as long as its current indicators pass the normal filters. |
| `repeatDeployCooldownTriggerCount` | 3 | Consecutive winning deploys before the bench triggers |
| `repeatDeployCooldownHours` | 12 | Bench duration |
| `repeatDeployCooldownScope` | `token` | `pool` \| `token` \| `both` — `token` benches every pool of the mint |
| `repeatDeployCooldownMinFeeEarnedPct` | 0 | Min fee % for a deploy to count as "fee-generating" (0 = any fee at all counts) |

### Management Config Keys

| Key | Default | Purpose |
|-----|---------|---------|
| `deployAmountSol` | 1.2 | Base deploy amount |
| `maxDeployAmount` | 50 | Hard ceiling |
| `maxPositions` | 1 | Concurrent position limit |
| `gasReserve` | 0.15 | Reserved SOL for tx fees |
| `positionSizePct` | 0.35 | % of available SOL per deploy |
| `minSolToOpen` | 1.45 | Don't screen below this SOL balance |
| `stopLossPct` | -13 | Hard stop loss |
| `takeProfitPct` | 8 | Hard take profit |
| `trailingTriggerPct` | 3 | Activate trailing TP at this peak |
| `trailingDropPct` | 1.2 | Close when peak drops by this % |
| `outOfRangeWaitMinutes` | 15 | OOR close trigger |
| `outOfRangeBinsToClose` | 10 | Rule 3 distance trigger |
| `oorCooldownTriggerCount` | 3 | Consecutive LOSING OOR closes → cooldown (only losses count) |
| `oorCooldownHours` | 24 | Cooldown after repeated losing OOR closes |
| `breakEvenExitEnabled` | true | Enable break-even-after-negative exit |
| `breakEvenExitPct` | 1 | Close at +1% if previously underwater 15+ min |
| `breakEvenMinAge` | 30 | Min position age for break-even check |
| `breakEvenMinNegativeMinutes` | 15 | Must be negative this long first |

### Schedule

| Key | Default | Purpose |
|-----|---------|---------|
| `managementIntervalMin` | 7 | Mgmt cycle frequency |
| `screeningIntervalMin` | 15 | Screening cycle frequency |
| `healthCheckIntervalMin` | 60 | Health check |

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

Runs every 30s. Fetches fresh position data and checks exit rules in priority order:

| Priority | Exit Type | Trigger | Config Keys |
|----------|-----------|---------|-------------|
| 1st | **Stop Loss** | `pnl_pct <= stopLossPct` | `stopLossPct` |
| 2nd | **Whale Dump Detector** | Fast PnL drop in 30s window (configurable score) | `whaleDumpScoreThreshold`, `whaleFastDropPct`, `whaleCrashDropPct` |
| 3rd | **Trailing Take Profit** | Peak reached `trailingTriggerPct`, then dropped by `trailingDropPct` | `trailingTriggerPct`, `trailingDropPct`, `trailingTakeProfit` |
| 4th | **Out of Range (time)** | Price above upper bin for `outOfRangeWaitMinutes` | `outOfRangeWaitMinutes` |
| 5th | **Break-Even Exit** | PnL recovers to `breakEvenExitPct` after `breakEvenMinNegativeMinutes` negative | `breakEvenExitPct`, `breakEvenMinNegativeMinutes`, `breakEvenMinAge` |
| 6th | **Low Yield** | `fee_per_tvl_24h < minFeePerTvl24h` AND age >= `minAgeBeforeYieldCheck` | `minFeePerTvl24h`, `minAgeBeforeYieldCheck` |

Also runs `getDeterministicCloseRule()` (index.js) as backup with 6 rules:

| Rule # | Trigger | Notes |
|--------|---------|-------|
| Rule 1 | `pnl_pct <= stopLossPct` | Same as poller stop loss |
| Rule 2 | `pnl_pct >= takeProfitPct` | Hard TP — no trailing, instant close at threshold |
| Rule 3 | Active bin > upper bin + `outOfRangeBinsToClose` | Price pumped far above range (10+ bins) |
| Rule 4 | OOR + `minutes_out_of_range >= outOfRangeWaitMinutes` | Same as poller OOR |
| Rule 5 | `fee_per_tvl_24h < minFeePerTvl24h` AND age >= 60 min | Hardcoded 60 min (bug: ignores `minAgeBeforeYieldCheck`) |
| Rule 6 | Break-even after negative — see Break-Even Exit | Backup for poller |

When either system detects a close trigger → fires management cycle immediately.

### System 2: Management Cron

Runs on schedule (`managementIntervalMin`). For each position:
1. Checks trailing TP + deterministic rules
2. Assigns action: **CLOSE**, **CLAIM**, **INSTRUCTION**, or **STAY**
3. All STAY → logs "skipping LLM", done
4. Action needed → calls LLM to execute (LLM cannot override CLOSE decisions)

The LLM prompt says: "Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute."

### Trailing Take Profit Flow

```
1. Position deployed at PnL 0%
2. PnL rises to trailingTriggerPct (3%) → trailing TP ACTIVATED, peak tracking starts
3. PnL keeps rising... 4%... 5% (peak updated)
4. PnL drops to 3.5% (dropped 1.5% from peak of 5%)
5. Drop >= trailingDropPct (1.2%) → TRIGGERED
6. 15-second recheck to confirm (anti-spike protection)
7. Still dropped → CLOSE
```

Trailing TP also combines with OOR: profitable + OOR for `outOfRangeWaitMinutes` → closes as "Trailing TP: Out of range for Xm" (most common close reason).

### After Close

```
close_position called by LLM
  → Claim fees
  → Remove liquidity
  → recordPerformance() → lessons.json
  → Pool-memory snapshot
  → Auto-swap base token → SOL via Jupiter
  → Telegram notification
  → smart-wallet-maintenance.autoAddFromPool() — learn top LPers
  → If below maxPositions → trigger screening cycle
```

---

## Screening Pipeline & Why Deploys Fail

The screening-to-deploy pipeline has **4 layers** where candidates can be rejected.

### Layer 0: Multi-Category Meteora API Fetch (screening.js)

`discoverPools()` builds a category list from `category + secondaryCategory + extraCategories`, then fetches each in parallel via `Promise.allSettled`. Pools are merged by `pool_address` (primary order wins on dedup).

**Reality check**: The Meteora pool-discovery API only has ~15-20 DLMM pools matching even loose filters at any time. All categories (trending/new/top) return nearly identical pools (95%+ overlap). The dual/quad-category fetch adds 0-3 extra pools in practice. **The candidate universe is a market reality, not a filter problem.**

Logs: `Multi-category fetch: trending:100(+100) volume:100(+34) new:100(+72) top:100(+28) → 234 unique pools`

### Layer 1: Hard Filters (code, before LLM)

After `getTopCandidates()` returns pools, `index.js` applies hard filters:
- **Blocked launchpad** — pool's launchpad is in `blockedLaunchpads`
- **Bot holders %** — Jupiter audit says bots > `maxBotHoldersPct` → dropped
- **Pool-memory cooldown** — pool address has active cooldown (set by past closes)
- **Base-mint cooldown** — token-wide cooldown via `isBaseMintOnCooldown`

If ALL candidates fail → "No candidates available", LLM never runs.

### Layer 2: Lone Candidate Skip (index.js `getLoneCandidateSkipReason()`)

If only **1 candidate** survives Layer 1, code applies extra safety:
- `is_wash` = true → skip
- `is_rugpull` + no smart wallets → skip
- `is_pvp` + no smart wallets → skip
- Token fees < `minTokenFeesSol` → skip
- Top10 holders > `maxTop10Pct` → skip
- Bot holders > `maxBotHoldersPct` → skip
- No narrative + no smart wallets → skip

### Layer 3: LLM Decision

If 2+ candidates pass, LLM chooses. It can still say "no deploy". Hard rules in prompt.js force skip on:
- `fees_sol < X`
- `volatility > 5`
- pool_memory last_outcome.pnl_pct < 0 within 24h
- pool_memory last close "pumped" within 60m
- Any single non-pool holder > 15%

### Layer 4: Safety Checks (executor.js `runSafetyChecks`)

Even after LLM calls `deploy_position`:
- **Pool threshold validation** (`validateDeployPoolThresholds`) — fresh Meteora API fetch, re-checks TVL/fee-ratio/volatility/bin-step
- **Token-level whale-dump cooldown** — `findRecentWhaleDumpByBaseMint` scans ALL pools by base_mint, blocks if any same-token pool dumped recently
- **Pool-level whale-dump cooldown** — 12h base, 48h escalated, refuse-on-3 (see Re-Entry Cooldown System)
- **Smart re-entry check** — fresh data comparison vs loss snapshot (see Re-Entry Cooldown System)
- **Pump cooldown** — block re-entry within `reentryAfterPumpMinutes` of a "pumped above" close
- **Single holder concentration** — reject if any non-pool wallet owns > `maxSingleHolderPct`
- **Bin step / range** — must be within `[minBinStep, maxBinStep]` and total range >= `max(35, minBinsBelow)`
- **Duplicates** — no duplicate pool_address, no duplicate base_mint (per-position)
- **Max positions reached** — force-fresh scan
- **SOL balance** — must cover `amount_y + gasReserve`
- **Single-side SOL only** — `amount_x > 0` rejected

---

## Re-Entry Cooldown System

Five complementary cooldowns prevent revenge trades while allowing intelligent re-entry. All evaluated in `runSafetyChecks` before deploy.

### 1. Token-Level Whale Dump Cooldown (executor.js)

**Trigger**: Same `base_mint` had a whale-dump close in ANY pool within `whaleDumpCooldownHours` (default 12h).

```javascript
findRecentWhaleDumpByBaseMint(args.base_mint) // scans all pools by mint
countConsecutiveWhaleDumpsByBaseMint(args.base_mint) // for escalation
```

- 1 dump → 12h cooldown (default `whaleDumpCooldownHours`)
- 2+ consecutive dumps → 48h cooldown (default `whaleDumpEscalationHours`)
- 3+ consecutive dumps → permanent refusal (recommend blacklist)

**Why**: Embrace had pool A dump twice on May 18, then a new pool B for the same token dumped on May 19. Pool-address-only cooldown missed it. Token-level cooldown catches all pools of the same token.

### 2. Pool-Level Whale Dump Cooldown (executor.js)

Same as #1 but for the specific `pool_address`. Includes a high-volatility penalty: if last deploy had `volatility_at_deploy >= 5` and held < 30 min → +30 min extra cooldown (these die in 9-19 min on average).

### 3. Smart Re-Entry (non-whale-dump losses)

After a non-whale-dump loss, the cooldown is **conditional**, not blanket:

```
1. Hard minimum 30m cooldown (no exceptions)
2. After 30m: fetch fresh pool data from Meteora API
3. Compare vs the loss snapshot:
   ✅ Current volatility ≤ volatility_at_deploy (calmed down)
   ✅ TVL ≥ minTvl (didn't collapse)
   ✅ Fee/TVL ≥ minFeeActiveTvlRatio (still active)
   ✅ Current volatility ≤ maxVolatility (not spiking)
4. ALL pass → re-entry ALLOWED (logged as smart_reentry)
   ANY fail → blocked with specific reason
```

Log example: `[smart_reentry] ✅ Pool 9eSpnMgE… re-entry allowed after 45m (lost -4.53%). conditions stabilized: vol 2.10 (was 4.85), TVL $17200, fee/TVL 0.85%`

### 4. Pump Cooldown

After a "pumped above range" close (Rule 3 / Rule 3-like exits), block re-entry for `reentryAfterPumpMinutes` (default 60). Prevents mean-reversion losses — if a pool pumped above your range, the move is usually exhausted.

### 5. OOR Cooldown (pool-memory.js)

After `oorCooldownTriggerCount` (default 3) consecutive **losing** OOR closes → set `oorCooldownHours` (default 24) cooldown on the pool AND base_mint.

**Critical fix**: Originally counted ALL OOR closes including profitable trailing-TP-via-OOR exits. Now only `pnl_pct < 0` OOR closes count toward the trigger. A winning streak of trailing-TP-via-OOR wins no longer triggers an inappropriate cooldown.

### Why Whale Dumps Get Special Treatment

Range efficiency is 100% on EVERY observed whale dump (the position was in-range when the whale hit). The standard OOR detection cannot help. The 30s whale-dump detector + cooldowns are the only defense.

---

## Screener Safety Checks (executor.js summary)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be positive finite; null/0 rejected
- Total range >= `max(35, minBinsBelow)` bins; 1-bin/tiny deploys refused
- Position count < `maxPositions` (force-fresh scan, no cache)
- No duplicate `pool_address`
- No duplicate `base_mint` across positions
- `amount_x > 0` rejected — single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance >= `amount_y + gasReserve`
- All 5 re-entry cooldowns above
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow))
clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp: `[35, 69]` — though `binsBelow: 30` config overrides defaults via `minBinsBelow` floor
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
| `/screening` | Manually trigger screening cycle |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlePct` (default 7), `maxTop10Pct` (default 60)
Jupiter audit API: `botHoldersPercentage` (5-25% normal for legitimate; up to 55% allowed for meme tokens via `maxBotHoldersPct`)

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
- Current model: `google/gemini-2.0-flash-001` (fast, cheap, sufficient)
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` → retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel`
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048

---

## Lessons & Smart Wallet Systems

### Lessons (lessons.js)
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- `recordPerformance()` called from executor.js after `close_position`

### Smart Wallet Auto-Learn (smart-wallet-maintenance.js)
- Runs after EVERY close (not just wins) via `autoAddFromPool()`
- Studies top 5 LPers in closed pool
- Filters by `smartWalletMinWinRate` (0.6) AND `smartWalletMinRoi` (0.1)
- Caps at `smartWalletMaxTotal` (50), prunes inactive `smartWalletInactivityDays` (30)
- Stored in `smart-wallets.json`

### Darwin Signal Weighting (config.darwin)
- `darwinEnabled: true`, window 60 days, recalc every 5 closes
- Adjusts strategy weights based on recent performance: boost 1.05x on win, decay 0.95x on loss
- Floor 0.3, ceiling 2.5, min samples 10

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

## Performance Analysis & Config Tuning

### Daily Performance Log

| Day | Config Notes | Deploys | Win Rate | Total PnL | Notes |
|-----|-------------|---------|----------|-----------|-------|
| **May 8** | SL -35, OOR 15m, mgmt 10m | 26 | ~70% | **positive** | Wide SL, patient OOR |
| **May 9** | SL -35→-5, OOR 15m | 20 | ~65% | near zero | Tightened mid-day |
| **May 10** | SL -5, OOR 15→8m, mgmt 10→5m | 35 | 68% | **-0.13% avg** | Over-management |
| **May 11** | SL -7, OOR 8→12m, mgmt 5m | 21 | 40% | **-$17.30** | 2 SL blowouts dominated |
| **May 18** | SL -10, OOR 18m, no cooldown system | 17 | 47% | **-$22.06** | 4 whale dumps = -$32 |
| **May 19** | NEW: smart re-entry + whale cooldowns + loose filters | 8 | **87.5%** | **+$5.42** | 1 dump only, 6 winning re-entries |
| **May 20** | repeatDeployCooldown had benched all 3 best tokens → starvation | 0 | — | **$0** | No deploys for hours (only vol-14 PHOENIX left). Fix: cleared 45 winner-cooldowns + `repeatDeployCooldownEnabled: false` |

### Volatility Band Analysis (from lessons.json, 54 trades)

Win rate stays high across all volatility, but **average PnL flips negative above ~3.0** — losses scale with volatility while wins don't:

| Volatility band | Trades | Win% | Avg PnL | Total PnL |
|---|---|---|---|---|
| **< 3.0** | 23 | 87% | **+1.22%** | **+28.1** |
| **>= 3.0** | 31 | 61% | **-2.30%** | **-58.0** |
| 2.5-3.0 (sweet spot) | 9 | 100% | +2.24% | +20.2 |
| 5.0+ (toxic) | 7 | 43% | -5.66% | -39.6 |

Winners' avg volatility = 3.28; losers' = 4.05. **`maxVolatility` 5 → 3.5 (or 3.0) is the highest-EV screening change.** Caveat: low-vol pools (1-2) still won ~88% with real fees — low volatility is NOT the enemy, high volatility (>=3.5) is. Config still at `maxVolatility: 5` pending user decision.

### Key Insights from May 18 → May 19 Improvement

**+$27.48 swing in 24 hours** came from:

1. **Smart re-entry on quality pools** — TOLYBOT/DEGEN got 3 consecutive winning re-entries each (+$9.55 total). Old blanket cooldown would have blocked these.
2. **Whale-dump 12h cooldown + escalation** — May 18 had 3 dumps in 6 hours (PIGEON, Embrace, Embrace). May 19 only had 1 dump because token-level cooldown blocked Embrace's known-bad pool. The 2nd Embrace pool (different address, same mint) still slipped through with -$4.44; base-mint cooldown now catches this.
3. **Loosened filters didn't degrade quality** — Trade count dropped 53% (17→8) but avg PnL more than doubled (-1.28% → +0.66%). The agent became selective, not reckless.

### Whale Dump Analysis (11 events across May 16-18)

From real pool-memory data:

| Metric | Value |
|--------|-------|
| Avg minutes held before dump | 45.2 min |
| Median minutes held | 19 min |
| Avg PnL on dump | -5.40% |
| Worst dump | -11.94% (Embrace re-entry at 6h) |
| **Range efficiency on EVERY dump** | **100%** (in-range when whale hit) |

**Re-entry success by time gap:**

| Gap from dump close | Win Rate | Verdict |
|---|---|---|
| < 1 hour | 50% (1 lucky bounce, 1 fresh dump) | Avoid |
| 1-6 hours | 0% | **Catastrophic** — Embrace at 6h lost -11.94% |
| 12-20 hours | **67%** | Safe re-entry window |

**Patterns**:
- 45% of dumps: "calm → cliff" (no warning, only 30s detector helps)
- 36% of dumps: "slow grind → accelerated" (3+ declining snapshots — early-exit rule could help)
- 18% of dumps: "already underwater" (bad entry timing)

**Repeat offender signal is strongest**: BABYTROLL dumped 3 consecutive times, Embrace 2 consecutive. The `whaleDumpBlacklistCount: 3` rule now catches this pattern.

### Loss Anatomy

| Loss Source | % of Total Losses | How to Detect | How to Fix |
|-------------|-------------------|---------------|------------|
| **Whale dumps** | ~50% | close_reason includes "WHALE DUMP" | Token+pool-level cooldowns (now active) |
| **Stop-loss blowouts** | ~30% | range_efficiency = 100%, pnl < -5% | Wider SL (-13 to -15) |
| **Bad token screening** | ~15% | rugpull/wash flags missed | Harden prompt.js |
| **Premature OOR close** | ~5% | Closed OOR at 8 min, price recovered in 20 min | Use 15+ min OOR wait |

### How Each Setting Reacts to Market Conditions

#### `stopLossPct` — The Most Impactful Setting

| SL Value | Uptrend (+1%/day) | Choppy (0%/day) | Downtrend (-2%/day) |
|----------|-------------------|------------------|---------------------|
| -5% | Bad: kills winners during normal dips | Very bad: nearly every position SL | Acceptable: cuts losses fast |
| -13 to -15% | **Good**: survives dips, catches recovery | Good: most positions survive chop | Risky: slow bleed holds too long |
| -35% | Risky: one rugpull = catastrophic | Bad: lets losers bleed | Very bad: massive drawdowns |

**Rule**: Meme tokens swing 5-15% intraday as normal volatility. SL must be wider than normal swing range.

#### `outOfRangeWaitMinutes`

| Value | Effect |
|-------|--------|
| 8 min | Aggressive — kills positions that would recover in 10-15 min |
| 12-15 min | **Balanced** — recovery time without holding losers forever |
| 18+ min | Patient — only for strong uptrends |

#### `managementIntervalMin`

| Value | Effect |
|-------|--------|
| 5 min | Over-manages, triggers exit rules prematurely |
| **7 min** | Current — balanced |
| 10 min | Relaxed — positions get time to develop (May 8 best day) |

#### Multi-Category Screening

| Setup | Pools per cycle | Notes |
|-------|-----------------|-------|
| trending only | ~15 | Same pools cycle constantly |
| trending + new + top | ~16-18 | ~95% overlap, marginal benefit |
| **Reality** | Meteora has ~15-20 DLMM pools matching ANY loose filters | Universe is small; categories don't help much |

### Current Config Rationale (May 20, 2026)

```jsonc
{
  // Sizing
  "deployAmountSol": 1.2,
  "maxPositions": 1,
  "positionSizePct": 0.35,
  "gasReserve": 0.15,

  // Screening filters (loosened May 19)
  "minTvl": 15000,
  "maxTvl": 300000,
  "minVolume": 300,
  "minOrganic": 45,
  "minQuoteOrganic": 40,
  "minHolders": 300,
  "minMcap": 50000,
  "maxMcap": 80000000,
  "minTokenAgeHours": 2,
  "maxTokenAgeHours": 168,
  "minFeeActiveTvlRatio": 0.10,
  "minTokenFeesSol": 30,

  // Safety filters (kept strict)
  "maxBundlePct": 7,
  "maxBotHoldersPct": 55,
  "maxTop10Pct": 60,
  "maxSingleHolderPct": 15,
  "maxVolatility": 5,
  "excludeHighSupplyConcentration": false,

  // Multi-category fetch
  "category": "trending",
  "secondaryCategory": null,
  "extraCategories": ["new", "top"],
  "poolPageSize": 100,
  "timeframe": "1h",

  // Re-entry cooldowns (data-driven)
  "reentryAfterLossHours": 6,
  "reentryMinCooldownMin": 30,
  "reentryAfterPumpMinutes": 60,
  "whaleDumpCooldownHours": 12,
  "whaleDumpEscalationHours": 48,
  "whaleDumpBlacklistCount": 3,

  // Position management
  "stopLossPct": -13,
  "takeProfitPct": 8,
  "trailingTriggerPct": 3,
  "trailingDropPct": 1.2,
  "outOfRangeWaitMinutes": 15,
  "outOfRangeBinsToClose": 10,
  "managementIntervalMin": 7,
  "screeningIntervalMin": 15,

  // Break-even exit
  "breakEvenExitEnabled": true,
  "breakEvenExitPct": 1,
  "breakEvenMinAge": 30,
  "breakEvenMinNegativeMinutes": 15,

  // Whale watch (in-position)
  "whaleWatchEnabled": true,
  "whaleDumpScoreThreshold": 2,
  "whaleFastDropPct": 2.5,
  "whaleCrashDropPct": 6,

  // OOR repeat cooldown (now only counts losing OOR)
  "oorCooldownTriggerCount": 3,
  "oorCooldownHours": 24,

  // Strategy
  "strategy": "spot",
  "binsBelow": 30
}
```

### How To Analyze Performance

1. **Pull files from server via FileZilla**: `pool-memory.json`, `lessons.json`, `state.json`, `logs/agent-YYYY-MM-DD.log`
2. **pool-memory.json**: Each pool has `deploys[]` with `closed_at`, `pnl_pct`, `pnl_usd`, `minutes_held`, `close_reason`, `range_efficiency`, `volatility_at_deploy`
3. **Key metrics**: Win rate, avg PnL, total PnL, avg hold time, close reason distribution
4. **Watch for**: Loss-to-win ratio (target < 2:1), whale dumps (filter `close_reason` includes "WHALE DUMP"), OOR < 5 min (bad entry), revenge trades (same pool/mint multiple losses)
5. **Smart re-entry log**: `grep smart_reentry agent-*.log` to see which re-entries were allowed/blocked and why
6. **state.json**: Can accumulate stale entries. Clean with `echo '{"positions":{}}' > state.json` if bloated
7. **Compare days**: Count `DEPLOYED` per day for volume, search `WHALE DUMP` for blowouts

---

## Deployment

Agent runs on **AWS Lightsail** (Ubuntu). The `user-config.json` is gitignored — manually synced via FileZilla.

Workflow:
1. **Config-only change**: Edit `user-config.json` → upload via FileZilla → **`pm2 restart duit`** (required to apply).
   ⚠️ **There is NO file watcher** — editing/uploading the file does NOT auto-apply. The only live-reload path, `reloadScreeningThresholds()`, is triggered solely by the `update_config` tool (Telegram) and `/evolve` / auto-evolution, and it refreshes **`screening.*` keys only**. `management.*` keys (stopLoss, takeProfit, trailing\*, breakEven\*, whaleWatch\*, repeatDeployCooldown\*) and `schedule.*` apply live only via the `update_config` tool — otherwise they need a restart.
2. **Code change** (`.js` files): Push to GitHub → `git pull` on server → `pm2 restart duit`

---

## Second Agent: duit-cepat

A yield-triggered fast management variant lives in `C:\Data\Duit\duit-cepat\`. Key differences:
- **Yield-triggered management**: When position yield > threshold, management interval drops to 1 min
- **Cron offset**: Uses `cronOffsetMin` to avoid RPC overlap with main duit agent
- **Config keys**: `yieldTriggerEnabled`, `yieldTriggerThreshold`, `fastIntervalMin`, `cronOffsetMin`
- **Status**: Created, not yet deployed to server

---

## Recent Fixes (May 19-22, 2026)

### ✅ Fixed
- **Non-SOL-quoted pools blocked (May 22)**: The screener returned pools quoted in non-SOL tokens (HYPE-**ZEC**, WOJAK-**USDC**) and nothing filtered them out — `getRawPoolScreeningRejectReason` checked quote organic/warnings but never that `token_y` was wrapped SOL, and prompt.js never told the LLM to require SOL. gemini-flash picked HYPE-ZEC; the deploy reached on-chain simulation and failed: `custom program error: 0x1` (`Tokenkeg… insufficient funds`) — because this agent does single-sided SOL deploys, the deposit token was ZEC, which the wallet holds none of. **Fix**: (1) screening.js now rejects any pool whose `token_y.address !== So1111…1112` *before the LLM sees it*; (2) executor.js `validateDeployPoolThresholds` re-checks the quote mint on the fresh pool detail as a safety net. Confirmed `token_y` is the quote and is `So111…112`/"SOL" for SOL pools. (The `0x1` insufficient-funds error here was the *wrong quote token*, NOT a low SOL balance.)
- **Malformed `pool_address` label sanitized (May 22)**: The screener LLM (gemini-flash) intermittently passed the candidate's *display label* `"SYMBOL-SOL (BASE58ADDR)"` as `pool_address` instead of the raw key — because `condensePool` exposes both `pool` (address) and `name` (`HENRY-SOL`). The malformed string never matched the Meteora `pool_address=` filter, so `validateDeployPoolThresholds` → `fetchFreshPoolDetail` returned null and threw a misleading `Pool ... not found`, silently blocking *good* candidates. Recurring for weeks: Wish-SOL (5/6), ASTEROID-SOL ×2 (5/8), Bear-SOL ×2 (5/10), TOLYBOT-SOL ×3 (5/21, the LLM's own note called it "the best candidate"), HENRY-SOL (5/22, pool was live at TVL $44k). **Fix**: `executeTool` (executor.js) now normalizes `pool_address`/`base_mint`/`position_address` at the dispatch chokepoint — if the arg isn't a clean base58 key it extracts the `[1-9A-HJ-NP-Za-km-z]{32,44}` run (logged as `sanitize`). Clean addresses (incl. `...pump`) pass through untouched. Also hardened the `deploy_position` arg description in definitions.js. NOTE: the rare clean-address "not found" (e.g. `3jG3...pump` 5/8, `8J69...pump` 5/11) IS genuinely a delisted/migrated pool — that path is unchanged and correct.
- **Winner-benching cooldown disabled (May 20)**: `repeatDeployCooldownEnabled: false`. The `repeatDeployCooldown` ("repeat fee-generating deploys") benched *profitable* tokens for 12h after 3 wins — 45 such winner-cooldowns had accumulated vs 29 loss-cooldowns, starving the candidate pool (May 20: 0 deploys; DEGEN/Coinini/TOLYBOT all filtered, only vol-14 PHOENIX left). Cleared all 45 winner-cooldowns from `pool-memory.json` (loss cooldowns preserved) and disabled the rule. Winners are now re-judged by current indicators each cycle — the normal screening filters (fee/TVL, volatility, organic, bot%) already gate re-entry.
- **CLAUDE.md hot-reload claim corrected (May 20)**: docs said file edits "hot-reload automatically (no restart)" — but there is no file watcher. File edits require `pm2 restart duit`; only the `update_config` tool / `/evolve` apply live, and `reloadScreeningThresholds()` refreshes `screening.*` keys only.
- **Base-mint whale-dump cooldown**: Was only checking by `pool_address`. Embrace's 2nd pool (different address, same mint) slipped through. Now `findRecentWhaleDumpByBaseMint` scans all pools by mint.
- **OOR cooldown counting wins**: 3 profitable trailing-TP-via-OOR closes triggered a 24h cooldown on a winning pool (TOLYBOT). Now only `pnl_pct < 0` OOR closes count toward the trigger.
- **Smart re-entry replaces blanket cooldown**: Instead of "loss → 6h block", checks if pool actually stabilized (vol/TVL/fees vs loss snapshot). Allows good re-entries (TOLYBOT/DEGEN streaks).
- **Whale-dump escalation**: 2nd dump in same pool → 48h cooldown. 3rd → permanent refusal. Prevents BABYTROLL/Embrace repeat-offender patterns.
- **Multi-category screening**: Added `extraCategories: ["new", "top"]` with dedup. (Reality: adds 0-3 pools, but no harm.)

### Known Issues / Tech Debt
- **No config-file watcher**: `reloadScreeningThresholds()` only reloads `screening.*` keys, and only fires from the `update_config` tool / `/evolve`. A direct `user-config.json` file edit (FileZilla) needs a `pm2 restart` to apply, and `management.*` / `schedule.*` keys never reload from file at all. Add an `fs.watch` watcher + management-reload if true live config-file updates are wanted.
- CLAUDE.md per-table "Default" columns mostly show the *deployed user-config value*, not the `config.js` code default — they can differ (e.g. `maxPositions` doc=1 but code default=3; `maxBotHoldersPct` doc=55 but code default=30). Treat the "Current Config Rationale" block as the source of truth for live values.
- `lessons.js evolveThresholds()` references `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` evolution is now meaningful since config has the key, but evolveThresholds wasn't updated). Evolution of these keys is a no-op.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- LLM bypasses rugpull/wash-trading flags when OKX data unavailable — needs prompt.js hardening.
- Agent Meridian relay constantly times out — disabled via `lpAgentRelayEnabled: false`.
- HiveMind throws intermittent 504 errors — consider `hiveMindEnabled: false` if persistent.
- Rule 5 in `getDeterministicCloseRule()` uses hardcoded 60 min instead of `minAgeBeforeYieldCheck` — state.js poller runs first so it's mostly harmless.
- "Slow grind → cliff" whale dumps (36% of dumps) had 3+ declining snapshots before the cliff. A "3 consecutive declining snapshots while in-range" early-exit rule could save ~10 min and reduce avg loss from -5.4% to ~-3%. Not implemented yet.
