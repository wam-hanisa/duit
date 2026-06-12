import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const USER_CONFIG_2_PATH = path.join(__dirname, "user-config-2.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Build the per-slot config sections (screening / management / strategy) from a
 * parsed user-config object. Called once for the primary config (slot 1) and
 * once per additional slot file (e.g. user-config-2.json for slot 2). Keeping
 * this a factory lets each slot run a different strategy + independent filters
 * and exit rules while sharing the same construction logic.
 */
function buildSlotSections(uu) {
  const legacyBinsBelow = numericConfig(uu.binsBelow);
  const configuredMinBinsBelow = numericConfig(uu.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
  const configuredMaxBinsBelow = numericConfig(uu.maxBinsBelow)
    ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
  const configuredDefaultBinsBelow = numericConfig(uu.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
  const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
  const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
  const strategyDefaultBinsBelow = Math.max(
    strategyMinBinsBelow,
    Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
  );

  return {
    // ─── Pool Screening Thresholds ───────────
    screening: {
      excludeHighSupplyConcentration: uu.excludeHighSupplyConcentration ?? true,
      minFeeActiveTvlRatio: uu.minFeeActiveTvlRatio ?? 0.05,
      maxFeeActiveTvlRatio: uu.maxFeeActiveTvlRatio ?? null, // null = no cap; set to e.g. 2.0 to block extreme pump pools
      maxVolatility: uu.maxVolatility ?? null, // null = no cap; pools with volatility above this are rejected (e.g. 5)
      maxSingleHolderPct: uu.maxSingleHolderPct ?? null, // null = no cap; reject if any single non-pool holder owns more than this %
      reentryAfterLossHours: uu.reentryAfterLossHours ?? 6, // normal-loss cooldown hours (smart-check window applies after reentryMinCooldownMin)
      reentryMinCooldownMin: uu.reentryMinCooldownMin ?? 30, // hard minimum minutes before smart re-entry check kicks in
      reentryAfterPumpMinutes: uu.reentryAfterPumpMinutes ?? 60, // block same pool re-entry for X minutes after a "pumped above" close
      // Whale-dump-specific cooldowns (data-driven: <6h re-entries failed 100%, 12h+ won 67%)
      whaleDumpCooldownHours: uu.whaleDumpCooldownHours ?? 12, // base cooldown for any whale-dump close
      whaleDumpEscalationHours: uu.whaleDumpEscalationHours ?? 48, // applied when 2+ consecutive whale dumps in same pool
      whaleDumpBlacklistCount: uu.whaleDumpBlacklistCount ?? 3, // refuse deploy entirely after this many consecutive whale dumps
      whaleDumpTotalCount:    uu.whaleDumpTotalCount    ?? 3,   // refuse if TOTAL whale dumps (not just consecutive) in window hits this — catches periodic dumpers
      whaleDumpTotalWindowHours: uu.whaleDumpTotalWindowHours ?? 168, // rolling window (7d) for the total-dump-count check
      toxicTokenMinDeploys:   uu.toxicTokenMinDeploys   ?? 3,   // min deploys before the cumulative-PnL toxic check applies
      toxicTokenMaxNetUsd:    uu.toxicTokenMaxNetUsd    ?? -8,  // refuse a mint whose net realized PnL across all its pools is <= this
      minTvl:            uu.minTvl            ?? 10_000,
      maxTvl:            uu.maxTvl !== undefined ? uu.maxTvl : 150_000,
      minVolume:         uu.minVolume         ?? 500,
      minOrganic:        uu.minOrganic        ?? 60,
      minQuoteOrganic:   uu.minQuoteOrganic   ?? 60,
      minHolders:        uu.minHolders        ?? 500,
      minMcap:           uu.minMcap           ?? 150_000,
      maxMcap:           uu.maxMcap           ?? 10_000_000,
      minBinStep:        uu.minBinStep        ?? 80,
      maxBinStep:        uu.maxBinStep        ?? 125,
      timeframe:         uu.timeframe         ?? "5m",
      category:          uu.category          ?? "trending",
      secondaryCategory: uu.secondaryCategory ?? null, // optional 2nd Meteora category (e.g. "volume") merged with primary for more candidate variety
      extraCategories:   uu.extraCategories   ?? [],   // additional Meteora categories array, e.g. ["new","top"] — all are deduped + merged
      poolPageSize:      uu.poolPageSize      ?? 100,  // Meteora API page_size per category (was 50; raise for broader fetch)
      minTokenFeesSol:   uu.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
      useDiscordSignals: uu.useDiscordSignals ?? false,
      discordSignalMode: uu.discordSignalMode ?? "merge", // merge | only
      avoidPvpSymbols:   uu.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
      blockPvpSymbols:   uu.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
      maxBundlePct:      uu.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
      maxBotHoldersPct:  uu.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
      maxTop10Pct:       uu.maxTop10Pct       ?? 60,  // max top 10 holders concentration
      allowedLaunchpads: uu.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
      blockedLaunchpads:  uu.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
      minTokenAgeHours:   uu.minTokenAgeHours   ?? null, // null = no minimum
      maxTokenAgeHours:   uu.maxTokenAgeHours   ?? null, // null = no maximum
      athFilterPct:       uu.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    },

    // ─── Position Management ────────────────
    management: {
      minClaimAmount:        uu.minClaimAmount        ?? 5,
      autoSwapAfterClaim:    uu.autoSwapAfterClaim    ?? false,
      evolveThresholdsEnabled: uu.evolveThresholdsEnabled ?? false, // OFF: respect manual tuning. ON: auto-evolve screening thresholds every 5 closes
      deterministicScreening: uu.deterministicScreening ?? false, // ON: deploy top-scored safe candidate without the LLM (skips LLM cost/retry loops)
      outOfRangeBinsToClose: uu.outOfRangeBinsToClose ?? 10,
      outOfRangeWaitMinutes: uu.outOfRangeWaitMinutes ?? 30,
      minProfitToCloseOorPct: uu.minProfitToCloseOorPct ?? 0, // don't OOR-close a profitable position below this % (fees > profit); 0 = disabled
      maxOorHoldMinutes:     uu.maxOorHoldMinutes     ?? 45, // hard cap: OOR-close regardless of the min-profit gate after this long (frees the position slot)
      oorCooldownTriggerCount: uu.oorCooldownTriggerCount ?? 3,
      oorCooldownHours:       uu.oorCooldownHours       ?? 12,
      repeatDeployCooldownEnabled: uu.repeatDeployCooldownEnabled ?? true,
      repeatDeployCooldownTriggerCount: uu.repeatDeployCooldownTriggerCount ?? 3,
      repeatDeployCooldownHours: uu.repeatDeployCooldownHours ?? 12,
      repeatDeployCooldownScope: uu.repeatDeployCooldownScope ?? "token", // pool | token | both
      repeatDeployCooldownMinFeeEarnedPct: uu.repeatDeployCooldownMinFeeEarnedPct ?? uu.repeatDeployCooldownMinFeeYieldPct ?? 0,
      minVolumeToRebalance:  uu.minVolumeToRebalance  ?? 1000,
      stopLossPct:           uu.stopLossPct           ?? uu.emergencyPriceDropPct ?? -50,
      takeProfitPct:         uu.takeProfitPct         ?? uu.takeProfitFeePct ?? 5,
      minFeePerTvl24h:       uu.minFeePerTvl24h       ?? 7,
      minAgeBeforeYieldCheck: uu.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
      minSolToOpen:          uu.minSolToOpen          ?? 0.55,
      deployAmountSol:       uu.deployAmountSol       ?? 0.5,
      gasReserve:            uu.gasReserve            ?? 0.2,
      positionSizePct:       uu.positionSizePct       ?? 0.35,
      // Trailing take-profit
      trailingTakeProfit:    uu.trailingTakeProfit    ?? true,
      trailingTriggerPct:    uu.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
      trailingDropPct:       uu.trailingDropPct       ?? 1.5,  // close when drops X% from peak
      // Break-even exit — close when PnL recovers after prolonged negative period
      breakEvenExitEnabled:         uu.breakEvenExitEnabled         ?? false,
      breakEvenExitPct:             uu.breakEvenExitPct             ?? 1,    // close when PnL reaches this % (e.g. 1 = +1%)
      breakEvenMinAge:              uu.breakEvenMinAge              ?? 30,   // position must be at least X minutes old
      breakEvenMinNegativeMinutes:  uu.breakEvenMinNegativeMinutes  ?? 15,   // must have been negative for at least X minutes
      // Whale watch — detect whale dumps and close before big IL
      whaleWatchEnabled:            uu.whaleWatchEnabled            ?? false,
      whaleDumpScoreThreshold:      uu.whaleDumpScoreThreshold      ?? 3,    // total score >= this triggers close
      whaleHolderBigDropPct:        uu.whaleHolderBigDropPct        ?? 5,    // big drop = whale moving large supply (+3 score)
      whaleHolderSmallDropPct:      uu.whaleHolderSmallDropPct      ?? 3,    // small drop on any top10 holder (+1 score)
      whaleFastDropPct:             uu.whaleFastDropPct             ?? 3,    // PnL drop in 30s window (+2 score)
      whaleCrashDropPct:            uu.whaleCrashDropPct            ?? 6,    // PnL crash in 30s window (+3 score)
      whaleTvlDropPct:              uu.whaleTvlDropPct              ?? 10,   // pool TVL drop in 30s window (+1 score)
      whaleDeclineStreakCount:      uu.whaleDeclineStreakCount      ?? 3,    // consecutive declining 30s polls → slow-grind dump warning (+2 score); 0 = off
      whaleDeclineStreakMinDropPct: uu.whaleDeclineStreakMinDropPct ?? 2,    // cumulative drop over the streak required to fire
      // Smart-wallet auto-maintenance — auto-add high performers, auto-remove inactive
      smartWalletAutoAddEnabled:    uu.smartWalletAutoAddEnabled    ?? false,
      smartWalletAutoRemoveEnabled: uu.smartWalletAutoRemoveEnabled ?? false,
      smartWalletMinWinRate:        uu.smartWalletMinWinRate        ?? 0.6,  // LPer must have >=60% win rate to auto-add
      smartWalletMinRoi:            uu.smartWalletMinRoi            ?? 0.1,  // LPer must have >=10% ROI to auto-add
      smartWalletMaxTotal:          uu.smartWalletMaxTotal          ?? 50,   // cap on total tracked wallets
      smartWalletMaxAddsPerCycle:   uu.smartWalletMaxAddsPerCycle   ?? 2,    // max wallets to add per profitable close
      smartWalletInactivityDays:    uu.smartWalletInactivityDays    ?? 30,   // remove if no positions for X days
      smartWalletPruneIntervalHrs:  uu.smartWalletPruneIntervalHrs  ?? 24,   // run prune cron every X hours
      pnlSanityMaxDiffPct:   uu.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
      // SOL mode — positions, PnL, and balances reported in SOL instead of USD
      solMode:               uu.solMode               ?? false,
    },

    // ─── Strategy Mapping ───────────────────
    strategy: {
      strategy:     uu.strategy     ?? "bid_ask",
      minBinsBelow: strategyMinBinsBelow,
      maxBinsBelow: strategyMaxBinsBelow,
      defaultBinsBelow: strategyDefaultBinsBelow,
    },
  };
}

const __slot1 = buildSlotSections(u);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds (slot 1) ───
  screening: __slot1.screening,

  // ─── Position Management (slot 1) ─────────
  management: __slot1.management,

  // ─── Strategy Mapping (slot 1) ────────────
  strategy: __slot1.strategy,

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    screeningMaxSteps: u.screeningMaxSteps ?? 10, // tighter cap for SCREENER — blocked deploys retry-loop up to this; screening needs ~3-8 steps
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    enabled: u.hiveMindEnabled ?? true,
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

// ─── Multi-Slot Config ──────────────────────────────────────────────
// Each slot is one concurrent position with its own strategy + filters +
// exit rules. Slot 1 is the primary user-config.json and references the live
// config.screening/management/strategy objects BY REFERENCE — this is what
// keeps update_config + reloadScreeningThresholds working on slot 1. Slot 2
// (optional) is built from user-config-2.json. If that file is absent there is
// exactly one slot and every slot-aware code path collapses to legacy behavior.
const u2 = fs.existsSync(USER_CONFIG_2_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_2_PATH, "utf8"))
  : null;

config.slots = [
  { id: 1, screening: config.screening, management: config.management, strategy: config.strategy },
];

if (u2) {
  const slot2 = buildSlotSections(u2);
  config.slots.push({ id: 2, screening: slot2.screening, management: slot2.management, strategy: slot2.strategy });
  // Global hard cap = number of slots (executor backstop). Each slot is gated to
  // 1 position by the per-slot occupancy check in index.js.
  config.risk.maxPositions = config.slots.length;
}

/**
 * Resolve a slot's full config block by slot id. Unknown/null id falls back to
 * slot 1 — the single back-compat choke point for legacy callers.
 */
export function resolveSlotConfig(slotId) {
  return config.slots.find((s) => s.id === slotId) ?? config.slots[0];
}

/**
 * Resolve the slot id for a tracked position record. Orphan/pre-existing
 * positions with no slot tag default to slot 1.
 */
export function resolveSlotForPosition(trackedPos) {
  return trackedPos?.slot ?? 1;
}

/** Number of configured slots (1 when user-config-2.json is absent). */
export function slotCount() {
  return config.slots.length;
}

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 *
 * @param {number} walletSol   Available SOL balance.
 * @param {object} [slotMgmt]  Per-slot management config (defaults to slot 1's).
 */
export function computeDeployAmount(walletSol, slotMgmt = config.management) {
  const reserve  = slotMgmt.gasReserve      ?? 0.2;
  const pct      = slotMgmt.positionSizePct ?? 0.35;
  const floor    = slotMgmt.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 *
 * NOTE: this only refreshes slot 1 (the primary user-config.json). Slot 2 has
 * no live-reload path — auto-evolve is OFF by default, so this is acceptable.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.maxFeeActiveTvlRatio !== undefined) s.maxFeeActiveTvlRatio = fresh.maxFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.secondaryCategory != null) s.secondaryCategory = fresh.secondaryCategory;
    if (fresh.extraCategories   != null) s.extraCategories   = fresh.extraCategories;
    if (fresh.poolPageSize      != null) s.poolPageSize      = fresh.poolPageSize;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.maxVolatility     !== undefined) s.maxVolatility     = fresh.maxVolatility;
    if (fresh.maxSingleHolderPct !== undefined) s.maxSingleHolderPct = fresh.maxSingleHolderPct;
    if (fresh.reentryAfterLossHours  != null) s.reentryAfterLossHours  = fresh.reentryAfterLossHours;
    if (fresh.reentryMinCooldownMin  != null) s.reentryMinCooldownMin  = fresh.reentryMinCooldownMin;
    if (fresh.reentryAfterPumpMinutes != null) s.reentryAfterPumpMinutes = fresh.reentryAfterPumpMinutes;
    if (fresh.whaleDumpCooldownHours  != null) s.whaleDumpCooldownHours  = fresh.whaleDumpCooldownHours;
    if (fresh.whaleDumpEscalationHours != null) s.whaleDumpEscalationHours = fresh.whaleDumpEscalationHours;
    if (fresh.whaleDumpBlacklistCount != null) s.whaleDumpBlacklistCount = fresh.whaleDumpBlacklistCount;
    if (fresh.whaleDumpTotalCount     != null) s.whaleDumpTotalCount     = fresh.whaleDumpTotalCount;
    if (fresh.whaleDumpTotalWindowHours != null) s.whaleDumpTotalWindowHours = fresh.whaleDumpTotalWindowHours;
    if (fresh.toxicTokenMinDeploys    != null) s.toxicTokenMinDeploys    = fresh.toxicTokenMinDeploys;
    if (fresh.toxicTokenMaxNetUsd     != null) s.toxicTokenMaxNetUsd     = fresh.toxicTokenMaxNetUsd;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
