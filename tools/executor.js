import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote, findRecentWhaleDumpByBaseMint, countConsecutiveWhaleDumpsByBaseMint, countWhaleDumpsByBaseMintInWindow, getBaseMintNetStats } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW, resolveSlotConfig } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const USER_CONFIG_2_PATH = path.join(__dirname, "../user-config-2.json");
// Slot id -> config file. Extend this if a 3rd slot is ever added.
const SLOT_FILE_PATHS = { 1: USER_CONFIG_PATH, 2: USER_CONFIG_2_PATH };
// Sections that are independent per slot. Everything else (risk/schedule/llm/
// hiveMind/api/indicators) is a single global value shared by all slots.
const PER_SLOT_SECTIONS = new Set(["screening", "management", "strategy"]);
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  // Validate against THIS deploy's slot thresholds (slot 2 may use different
  // TVL / fee-ratio / volatility / bin-step / timeframe than slot 1).
  const sc = resolveSlotConfig(args.slot).screening;
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address, sc.timeframe);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  // Quote token MUST be wrapped SOL. This agent only does single-sided SOL
  // deploys; a non-SOL quote (ZEC, USDC…) causes an on-chain "insufficient
  // funds" (custom program error 0x1) because the wallet holds no quote token.
  // Safety net behind the screening-level filter (HYPE-ZEC, WOJAK-USDC slipped
  // past the LLM on May 22 and failed at simulation).
  const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
  const quoteMint = detail?.token_y?.address;
  if (quoteMint && quoteMint !== WRAPPED_SOL_MINT) {
    const quoteSym = detail?.token_y?.symbol || `${quoteMint.slice(0, 4)}…`;
    return {
      pass: false,
      reason: `Pool quote token is ${quoteSym}, not SOL. This agent only does single-sided SOL deploys — a non-SOL quote would fail on-chain with "insufficient funds" (the wallet holds no ${quoteSym}). Refusing deploy.`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(sc.minTvl);
  const maxTvl = numberOrNull(sc.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(sc.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(sc.timeframe || "5m");
  let volatilityDetail = detail;
  if ((sc.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }
  const maxVolatility = numberOrNull(sc.maxVolatility);
  if (maxVolatility != null && maxVolatility > 0 && volatility > maxVolatility) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility.toFixed(2)} exceeds maxVolatility ${maxVolatility}. High-vol pools historically produce catastrophic losses — refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(sc.minBinStep);
  const maxStep = numberOrNull(sc.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  // Return detail so the caller can derive base_mint (LLM often omits it).
  return { pass: true, detail };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "", slot = 1 }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      maxVolatility: ["screening", "maxVolatility"],
      maxSingleHolderPct: ["screening", "maxSingleHolderPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      breakEvenExitEnabled: ["management", "breakEvenExitEnabled"],
      breakEvenExitPct: ["management", "breakEvenExitPct"],
      breakEvenMinAge: ["management", "breakEvenMinAge"],
      breakEvenMinNegativeMinutes: ["management", "breakEvenMinNegativeMinutes"],
      whaleWatchEnabled: ["management", "whaleWatchEnabled"],
      whaleDumpScoreThreshold: ["management", "whaleDumpScoreThreshold"],
      whaleHolderBigDropPct: ["management", "whaleHolderBigDropPct"],
      whaleHolderSmallDropPct: ["management", "whaleHolderSmallDropPct"],
      whaleFastDropPct: ["management", "whaleFastDropPct"],
      whaleCrashDropPct: ["management", "whaleCrashDropPct"],
      whaleTvlDropPct: ["management", "whaleTvlDropPct"],
      whaleDeclineStreakCount: ["management", "whaleDeclineStreakCount"],
      whaleDeclineStreakMinDropPct: ["management", "whaleDeclineStreakMinDropPct"],
      smartWalletAutoAddEnabled: ["management", "smartWalletAutoAddEnabled"],
      smartWalletAutoRemoveEnabled: ["management", "smartWalletAutoRemoveEnabled"],
      smartWalletMinWinRate: ["management", "smartWalletMinWinRate"],
      smartWalletMinRoi: ["management", "smartWalletMinRoi"],
      smartWalletMaxTotal: ["management", "smartWalletMaxTotal"],
      smartWalletMaxAddsPerCycle: ["management", "smartWalletMaxAddsPerCycle"],
      smartWalletInactivityDays: ["management", "smartWalletInactivityDays"],
      smartWalletPruneIntervalHrs: ["management", "smartWalletPruneIntervalHrs"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    // Resolve + validate the requested slot BEFORE touching anything. Unknown
    // slot ids must hard-fail, not silently fall back to slot 1 (that's what
    // resolveSlotConfig does for read paths — wrong behavior for a write path).
    const requestedSlot = Number(slot) || 1;
    const slotCfg = config.slots.find((s) => s.id === requestedSlot);
    if (!slotCfg) {
      return {
        success: false,
        error: `Slot ${requestedSlot} is not configured. Active slots: ${config.slots.map((s) => s.id).join(", ")}`,
        reason,
      };
    }

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed [slot ${requestedSlot}] — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Lazy-loaded, per-slot file cache. Per-slot keys (screening/management/
    // strategy) read+write the requested slot's own file; global keys
    // (risk/schedule/llm/hiveMind/api/indicators) always read+write slot 1's
    // file, since that's the only place they're defined.
    const fileCache = {};
    function loadSlotFile(slotId) {
      if (fileCache[slotId]) return fileCache[slotId];
      const p = SLOT_FILE_PATHS[slotId];
      let data = {};
      if (p && fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, "utf8"));
      }
      fileCache[slotId] = data;
      return data;
    }

    try {
      loadSlotFile(1);
      if (requestedSlot !== 1) loadSlotFile(requestedSlot);
    } catch (error) {
      return { success: false, error: `Invalid config file: ${error.message}`, reason };
    }

    // Apply to live config immediately after the persisted config is known-good.
    const touchedSlotIds = new Set();
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const isPerSlot = PER_SLOT_SECTIONS.has(section);
      const targetSlotId = isPerSlot ? requestedSlot : 1;
      const targetObj = isPerSlot ? slotCfg[section] : config[section];
      const before = targetObj[field];
      targetObj[field] = val;
      touchedSlotIds.add(targetSlotId);
      log("config", `update_config[slot ${targetSlotId}${isPerSlot ? "" : " · global"}]: ${section}.${field} ${before} → ${val} (verify: ${targetObj[field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      const st = slotCfg.strategy;
      st.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(st.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      st.maxBinsBelow = Math.max(st.minBinsBelow, Math.round(Number(st.maxBinsBelow ?? st.minBinsBelow)));
      st.defaultBinsBelow = Math.max(
        st.minBinsBelow,
        Math.min(st.maxBinsBelow, Math.round(Number(st.defaultBinsBelow ?? st.maxBinsBelow))),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      const [section, , persistPath] = CONFIG_MAP[key];
      const isPerSlot = PER_SLOT_SECTIONS.has(section);
      const fileObj = loadSlotFile(isPerSlot ? requestedSlot : 1);
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = fileObj;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        fileObj[key] = val;
      }
    }

    for (const slotId of touchedSlotIds) {
      const p = SLOT_FILE_PATHS[slotId];
      if (!p) continue;
      const fileObj = loadSlotFile(slotId);
      if (slotId === 1) fileObj._lastAgentTune = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(fileObj, null, 2));
    }

    // Restart cron jobs if intervals changed (global — affects all slots)
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Slot ${requestedSlot}: Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned [slot ${requestedSlot}]: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, slot: requestedSlot, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // Normalize Solana address args. Small models (e.g. gemini-flash) sometimes
  // pass the candidate's DISPLAY LABEL "SYMBOL-SOL (BASE58ADDR)" instead of the
  // raw address. That malformed value fails every downstream API lookup with a
  // misleading "Pool ... not found", silently blocking good candidates.
  // Repeatedly observed: HENRY-SOL, TOLYBOT-SOL (x3), ASTEROID-SOL, Bear-SOL,
  // Wish-SOL. Extract the base58 key so the real address is always used.
  const FULL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const ADDR_IN_STR = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
  for (const key of ["pool_address", "base_mint", "position_address"]) {
    const raw = args?.[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (FULL_ADDR.test(trimmed)) {
      if (trimmed !== raw) args[key] = trimmed;
      continue;
    }
    const match = trimmed.match(ADDR_IN_STR);
    if (match) {
      log("sanitize", `Normalized ${key} "${raw}" -> "${match[0]}" (model passed a label, not a raw address)`);
      args[key] = match[0];
    }
  }

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        const deploySlot = resolveSlotConfig(args.slot);
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee, slot: config.slots.length > 1 ? deploySlot.id : null, strategy: args.strategy || deploySlot.strategy.strategy }).catch(() => {});
      } else if (name === "close_position") {
        const closedTracked = args.position_address ? getTrackedPosition(args.position_address) : null;
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, reason: args.reason || null, slot: config.slots.length > 1 ? (closedTracked?.slot ?? 1) : null, strategy: closedTracked?.strategy || null }).catch(() => {});
        // Free whale-watch snapshot memory for closed positions
        if (args.position_address) {
          import("../whale-watch.js").then(({ clearWhaleSnapshot }) => clearWhaleSnapshot(args.position_address)).catch(() => {});
        }
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-add smart wallets from EVERY close — even losses can have profitable LPers in the pool.
        // The autoAddFromPool() function itself filters by per-LPer winRate/ROI, so unprofitable LPers
        // never get added; only the pool-level PnL gate was previously hiding good LPers in losing pools.
        if (config.management.smartWalletAutoAddEnabled) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) {
            import("../smart-wallet-maintenance.js").then(({ autoAddFromPool }) =>
              autoAddFromPool({ poolAddress: poolAddr, mgmtConfig: config.management })
            ).catch((e) => log("smart_wallet_maint_warn", `Auto-add hook failed: ${e.message}`));
          }
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Resolve this deploy's slot so bin-step / volatility / sizing checks use
      // the right slot's thresholds (slot 2 = bid-ask may differ from slot 1).
      const slotCfg = resolveSlotConfig(args.slot);
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;

      // LLM-omitted base_mint fallback: Gemini Flash consistently leaves
      // base_mint out of deploy_position calls (verified in actions-*.jsonl),
      // which silently bypasses the toxic-token, periodic-dumper, and base-mint
      // cooldown checks. Derive it from the already-fetched pool detail so
      // those safety rules can actually fire. Zero extra API calls (reuses
      // the fetch inside validateDeployPoolThresholds).
      if (!args.base_mint && poolThresholds.detail?.token_x?.address) {
        args.base_mint = poolThresholds.detail.token_x.address;
        log("safety", `Derived missing base_mint ${args.base_mint.slice(0, 8)}… from pool detail (LLM omitted it)`);
      }

      // Reject pools with bin_step out of configured range
      const minStep = slotCfg.screening.minBinStep;
      const maxStep = slotCfg.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? slotCfg.strategy.defaultBinsBelow ?? slotCfg.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(slotCfg.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      const maxVolatility = numberOrNull(slotCfg.screening.maxVolatility);
      if (
        maxVolatility != null &&
        maxVolatility > 0 &&
        Number.isFinite(requestedVolatility) &&
        requestedVolatility > maxVolatility
      ) {
        return {
          pass: false,
          reason: `Candidate volatility ${requestedVolatility.toFixed(2)} exceeds maxVolatility ${maxVolatility}. High-vol pools (Wish/Yae/BABYTROLL pattern) historically produce catastrophic losses — refusing deploy.`,
        };
      }

      // ─── Pre-Deploy Whale + Re-Entry Cooldown Hook ─────────────
      // Catches three loss patterns observed in May 14–17 forensics:
      //   1. Revenge re-entry into same pool minutes after a profitable "pumped above" close
      //   2. Re-entry into a pool that recently produced a negative close
      //   3. Pools where a single non-pool holder concentration > maxSingleHolderPct (whale risk)
      try {
        // TOXIC-TOKEN check (cumulative net PnL across all the mint's pools).
        // Catches reliable money-losers that don't trigger the dump rules —
        // slow bleeders like RoyalPop (-$44 net), Embrace (-$21), BABYTROLL (-$9.50).
        if (args.base_mint) {
          const toxicMinDeploys = numberOrNull(config.screening.toxicTokenMinDeploys) ?? 3;
          const toxicMaxNetUsd = numberOrNull(config.screening.toxicTokenMaxNetUsd) ?? -8;
          const mintStats = getBaseMintNetStats(args.base_mint);
          if (mintStats.deploys >= toxicMinDeploys && mintStats.netUsd <= toxicMaxNetUsd) {
            log("safety_block", `Token ${args.base_mint.slice(0, 8)}… toxic: net $${mintStats.netUsd} over ${mintStats.deploys} deploys (limit $${toxicMaxNetUsd}) — refusing deploy`);
            return {
              pass: false,
              reason: `Token ${args.base_mint.slice(0, 8)}… is net-negative: $${mintStats.netUsd} across ${mintStats.deploys} deploys (toxic threshold $${toxicMaxNetUsd}). Reliable money-loser — refusing deploy.`,
            };
          }
        }

        // PERIODIC-DUMPER check (total whale dumps in a rolling window).
        // Catches tokens like TOLYBOT that dump every ~2 days WITH wins between —
        // consecutive-counter resets on wins and 48h cooldown expires, so the
        // standard cooldowns structurally miss them. This counts TOTAL dumps for
        // the mint within whaleDumpTotalWindowHours regardless of pool or wins.
        if (args.base_mint) {
          const whaleDumpTotalCount = numberOrNull(config.screening.whaleDumpTotalCount) ?? 3;
          const whaleDumpTotalWindowHours = numberOrNull(config.screening.whaleDumpTotalWindowHours) ?? 168;
          const totalDumps = countWhaleDumpsByBaseMintInWindow(args.base_mint, whaleDumpTotalWindowHours);
          if (totalDumps >= whaleDumpTotalCount) {
            log("safety_block", `Token ${args.base_mint.slice(0, 8)}… periodic dumper: ${totalDumps} whale dumps in last ${whaleDumpTotalWindowHours}h (limit ${whaleDumpTotalCount}) — refusing deploy`);
            return {
              pass: false,
              reason: `Token ${args.base_mint.slice(0, 8)}… has ${totalDumps} whale dumps in the last ${whaleDumpTotalWindowHours}h (limit ${whaleDumpTotalCount}) — periodic dumper. Refusing deploy regardless of wins between dumps.`,
            };
          }
        }

        // BASE-MINT-LEVEL whale-dump check (token-wide, across ALL pool addresses)
        // Catches the case where a token has multiple pools — e.g. Embrace had
        // pool 9eSpnMgE (whale dumped twice on May 18) then a second pool
        // 38LYmGaH that whale-dumped on May 19. Token-level cooldown stops this.
        if (args.base_mint && args.pool_address) {
          const tokenDump = findRecentWhaleDumpByBaseMint(args.base_mint);
          if (tokenDump && tokenDump.poolAddress !== args.pool_address) {
            const minutesSinceTokenDump = (Date.now() - tokenDump.closedAtMs) / 60000;
            const whaleDumpHardHours = numberOrNull(config.screening.whaleDumpCooldownHours) ?? 12;
            const whaleDumpEscalationHours = numberOrNull(config.screening.whaleDumpEscalationHours) ?? 48;
            const whaleDumpBlacklistCount = numberOrNull(config.screening.whaleDumpBlacklistCount) ?? 3;
            const consecutiveDumps = countConsecutiveWhaleDumpsByBaseMint(args.base_mint);

            // Auto-block if token has 3+ consecutive whale dumps across any pool
            if (consecutiveDumps >= whaleDumpBlacklistCount) {
              return {
                pass: false,
                reason: `Token ${args.base_mint.slice(0, 8)}… has ${consecutiveDumps} consecutive whale dumps across all its pools. Pattern is structural — refusing deploy. Consider blacklisting this base mint.`,
              };
            }

            const effectiveCooldownHours = consecutiveDumps >= 2 ? whaleDumpEscalationHours : whaleDumpHardHours;
            if (minutesSinceTokenDump < effectiveCooldownHours * 60) {
              const label = consecutiveDumps >= 2 ? `ESCALATED (${consecutiveDumps} consecutive token-level dumps)` : "token-level whale dump";
              return {
                pass: false,
                reason: `Token ${args.base_mint.slice(0, 8)}… ${label} — another pool ${tokenDump.poolAddress.slice(0, 8)}… (${tokenDump.poolName}) closed ${minutesSinceTokenDump.toFixed(0)}m ago at ${Number(tokenDump.deploy.pnl_pct).toFixed(2)}%. Cooldown ${effectiveCooldownHours}h required across all pools of this token.`,
              };
            }
          }
        }

        const poolMemory = args.pool_address ? getPoolMemory({ pool_address: args.pool_address }) : null;
        if (poolMemory && poolMemory.known) {
          const lastDeploy = Array.isArray(poolMemory.history) && poolMemory.history.length
            ? poolMemory.history[poolMemory.history.length - 1]
            : null;
          const lastClosedAtMs = lastDeploy?.closed_at ? Date.parse(lastDeploy.closed_at) : null;
          const lastPnl = numberOrNull(lastDeploy?.pnl_pct);
          const lastReason = String(lastDeploy?.close_reason || "").toLowerCase();
          const minutesSinceLastClose = lastClosedAtMs ? (Date.now() - lastClosedAtMs) / 60000 : null;

          // Whale-dump-specific cooldown (data-driven from 11 dump events:
          // re-entries < 6h all failed, 12h+ had 67% win rate)
          // Counts consecutive whale dumps in pool history for escalation.
          const whaleDumpHardHours = numberOrNull(config.screening.whaleDumpCooldownHours) ?? 12;
          const whaleDumpEscalationHours = numberOrNull(config.screening.whaleDumpEscalationHours) ?? 48;
          const whaleDumpBlacklistCount = numberOrNull(config.screening.whaleDumpBlacklistCount) ?? 3;
          const isLastDumpWhale = lastReason.includes("whale") || lastReason.includes("🐋");
          if (isLastDumpWhale && lastPnl != null && lastPnl < 0 && minutesSinceLastClose != null) {
            // Count consecutive whale dumps from history (most recent backwards)
            let consecutiveDumps = 0;
            const history = Array.isArray(poolMemory.history) ? poolMemory.history : [];
            for (let i = history.length - 1; i >= 0; i--) {
              const reason = String(history[i]?.close_reason || "").toLowerCase();
              if (reason.includes("whale") || reason.includes("🐋")) consecutiveDumps++;
              else break;
            }

            // Auto-blacklist on 3+ consecutive whale dumps
            if (consecutiveDumps >= whaleDumpBlacklistCount) {
              log("safety_block", `Pool ${args.pool_address.slice(0, 8)}… has ${consecutiveDumps} consecutive whale dumps — recommending blacklist for token ${poolMemory.base_mint || "?"}`);
              return {
                pass: false,
                reason: `Pool ${args.pool_address.slice(0, 8)}… has ${consecutiveDumps} consecutive whale dumps in history. Pattern is structural — refusing deploy. Consider adding ${poolMemory.base_mint || args.base_mint || "this base mint"} to token-blacklist.json.`,
              };
            }

            // Escalation: 2nd whale dump within 24h → 48h cooldown
            const effectiveCooldownHours = consecutiveDumps >= 2 ? whaleDumpEscalationHours : whaleDumpHardHours;
            // High-vol deploy penalty: vol ≥5 dumped within 30 min → +30min extra
            const lastVolAtDeploy = numberOrNull(lastDeploy?.volatility_at_deploy);
            const lastHeldMin = numberOrNull(lastDeploy?.minutes_held);
            const highVolPenalty = (lastVolAtDeploy != null && lastVolAtDeploy >= 5 && lastHeldMin != null && lastHeldMin < 30) ? 0.5 : 0;
            const effectiveCooldownMs = (effectiveCooldownHours + highVolPenalty) * 60 * 60 * 1000;

            if (Date.now() - lastClosedAtMs < effectiveCooldownMs) {
              const label = consecutiveDumps >= 2 ? `ESCALATED (${consecutiveDumps} consecutive dumps)` : "whale dump";
              const penaltyNote = highVolPenalty > 0 ? ` (+30m high-vol penalty)` : "";
              return {
                pass: false,
                reason: `Pool ${args.pool_address.slice(0, 8)}… ${label}${penaltyNote} — closed ${minutesSinceLastClose.toFixed(0)}m ago at ${lastPnl.toFixed(2)}%. Cooldown ${(effectiveCooldownHours + highVolPenalty).toFixed(1)}h required (data: <6h re-entries failed 100%, 12h+ won 67%).`,
              };
            }
            // Cooldown passed — log this as recovery attempt and fall through to allow
            log("smart_reentry", `Pool ${args.pool_address.slice(0, 8)}… whale-dump cooldown (${effectiveCooldownHours}h) expired after ${(minutesSinceLastClose/60).toFixed(1)}h. Allowing deploy attempt.`);
          }

          // Smart re-entry after a recent negative close (non-whale-dump losses)
          // Hard minimum 30m cooldown, then check if pool conditions have stabilized
          const reentryAfterLossHours = numberOrNull(config.screening.reentryAfterLossHours) ?? 6;
          const reentryMinCooldownMin = numberOrNull(config.screening.reentryMinCooldownMin) ?? 30;
          if (
            lastPnl != null &&
            lastPnl < 0 &&
            minutesSinceLastClose != null &&
            minutesSinceLastClose < reentryAfterLossHours * 60
          ) {
            // Always enforce hard minimum cooldown (no instant retries)
            if (minutesSinceLastClose < reentryMinCooldownMin) {
              return {
                pass: false,
                reason: `Pool ${args.pool_address.slice(0, 8)}… closed at ${lastPnl.toFixed(2)}% ${minutesSinceLastClose.toFixed(0)}m ago. Hard cooldown ${reentryMinCooldownMin}m — too soon to re-enter.`,
              };
            }

            // After minimum cooldown: fetch fresh pool data and compare conditions
            const lastVolatility = numberOrNull(lastDeploy?.volatility_at_deploy);
            const lastCloseReason = lastReason;
            let smartReentryAllowed = false;
            let smartReentryReason = "";
            try {
              const freshPool = await fetchFreshPoolDetail(args.pool_address);
              if (freshPool) {
                const currentVol = poolDetailVolatility(freshPool);
                const currentTvl = poolDetailTvl(freshPool);
                const currentFeeRatio = poolDetailFeeActiveTvlRatio(freshPool);
                const minTvl = numberOrNull(config.screening.minTvl) ?? 0;
                const minFeeRatio = numberOrNull(config.screening.minFeeActiveTvlRatio) ?? 0;
                const maxVol = numberOrNull(config.screening.maxVolatility);

                // Conditions to allow smart re-entry:
                // 1. Current volatility is lower than when we lost (pool calmed down)
                //    OR volatility at deploy was unknown (can't compare)
                // 2. TVL is still above minimum (pool didn't collapse)
                // 3. Fee/TVL ratio still healthy (pool is still active)
                // 4. Current volatility within maxVolatility (not spiking)
                // 5. NOT a whale-dump loss (whale dumps are structural — hard cooldown)
                const isWhaleDump = lastCloseReason.includes("whale") || lastCloseReason.includes("🐋");
                const volImproved = lastVolatility == null || currentVol == null || currentVol <= lastVolatility;
                const tvlHealthy = currentTvl != null && currentTvl >= minTvl;
                const feesHealthy = currentFeeRatio != null && currentFeeRatio >= minFeeRatio;
                const volWithinLimit = maxVol == null || currentVol == null || currentVol <= maxVol;

                if (isWhaleDump) {
                  // Whale dumps already handled above by dedicated whale-dump cooldown.
                  // If we got here, that cooldown already passed — apply same conditions check.
                  if (volImproved && tvlHealthy && feesHealthy && volWithinLimit) {
                    smartReentryAllowed = true;
                    smartReentryReason = `post-whale-dump recovery: vol ${currentVol?.toFixed(2) ?? "?"} (was ${lastVolatility?.toFixed(2) ?? "?"}), TVL $${currentTvl?.toFixed(0) ?? "?"}, fee/TVL ${currentFeeRatio?.toFixed(2) ?? "?"}%`;
                  } else {
                    const reasons = [];
                    if (!volImproved) reasons.push(`vol ${currentVol?.toFixed(2)} > ${lastVolatility?.toFixed(2)} at loss`);
                    if (!tvlHealthy) reasons.push(`TVL $${currentTvl?.toFixed(0)} < min $${minTvl}`);
                    if (!feesHealthy) reasons.push(`fee/TVL ${currentFeeRatio?.toFixed(2)}% < min ${minFeeRatio}%`);
                    if (!volWithinLimit) reasons.push(`vol ${currentVol?.toFixed(2)} > max ${maxVol}`);
                    smartReentryReason = `whale-dump cooldown passed but still unstable: ${reasons.join(", ")}`;
                  }
                } else if (volImproved && tvlHealthy && feesHealthy && volWithinLimit) {
                  smartReentryAllowed = true;
                  smartReentryReason = `conditions stabilized: vol ${currentVol?.toFixed(2) ?? "?"} (was ${lastVolatility?.toFixed(2) ?? "?"}), TVL $${currentTvl?.toFixed(0) ?? "?"}, fee/TVL ${currentFeeRatio?.toFixed(2) ?? "?"}%`;
                } else {
                  const reasons = [];
                  if (!volImproved) reasons.push(`vol ${currentVol?.toFixed(2)} > ${lastVolatility?.toFixed(2)} at loss`);
                  if (!tvlHealthy) reasons.push(`TVL $${currentTvl?.toFixed(0)} < min $${minTvl}`);
                  if (!feesHealthy) reasons.push(`fee/TVL ${currentFeeRatio?.toFixed(2)}% < min ${minFeeRatio}%`);
                  if (!volWithinLimit) reasons.push(`vol ${currentVol?.toFixed(2)} > max ${maxVol}`);
                  smartReentryReason = `still unstable: ${reasons.join(", ")}`;
                }
              } else {
                smartReentryReason = "pool not found in Meteora API — cannot verify conditions";
              }
            } catch (e) {
              smartReentryReason = `condition check failed: ${e.message}`;
            }

            if (smartReentryAllowed) {
              log("smart_reentry", `✅ Pool ${args.pool_address.slice(0, 8)}… re-entry allowed after ${minutesSinceLastClose.toFixed(0)}m (lost ${lastPnl.toFixed(2)}%). ${smartReentryReason}`);
              // Allow — don't return, fall through to continue deploy
            } else {
              return {
                pass: false,
                reason: `Pool ${args.pool_address.slice(0, 8)}… closed at ${lastPnl.toFixed(2)}% ${minutesSinceLastClose.toFixed(0)}m ago. ${smartReentryReason}`,
              };
            }
          }

          // Block immediate revenge re-entry after a "pumped above range" exit (mean-reversion risk)
          const reentryAfterPumpMinutes = numberOrNull(config.screening.reentryAfterPumpMinutes) ?? 60;
          if (
            lastReason.includes("pumped") &&
            minutesSinceLastClose != null &&
            minutesSinceLastClose < reentryAfterPumpMinutes
          ) {
            return {
              pass: false,
              reason: `Pool ${args.pool_address.slice(0, 8)}… just pumped out of range ${minutesSinceLastClose.toFixed(0)}m ago. Cooldown ${reentryAfterPumpMinutes}m after a pump-exit — refusing re-entry (mean-reversion risk).`,
            };
          }
        }
      } catch (e) {
        log("executor_warn", `Pool memory pre-deploy check failed (continuing): ${e.message}`);
      }

      const maxSingleHolderPct = numberOrNull(config.screening.maxSingleHolderPct);
      if (maxSingleHolderPct != null && maxSingleHolderPct > 0 && args.base_mint) {
        try {
          const holdersResult = await getTokenHolders({ mint: args.base_mint, limit: 20 });
          const realHolders = Array.isArray(holdersResult?.holders)
            ? holdersResult.holders.filter((h) => !h.is_pool)
            : [];
          const topPct = realHolders.length ? Number(realHolders[0]?.pct) || 0 : 0;
          if (topPct > maxSingleHolderPct) {
            return {
              pass: false,
              reason: `Top single non-pool holder owns ${topPct.toFixed(2)}% of ${args.base_mint.slice(0, 8)}… (limit ${maxSingleHolderPct}%). Whale concentration risk — refusing deploy.`,
            };
          }
        } catch (e) {
          log("executor_warn", `Pre-deploy whale-holder check failed (continuing): ${e.message}`);
        }
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, slotCfg.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = slotCfg.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }

        // Block dual-sided deploy if wallet has no base token.
        // Prevents on-chain "insufficient funds" error (custom program error 0x1).
        // Force single-sided SOL by zeroing amount_x.
        const amountX = args.amount_x ?? 0;
        if (amountX > 0) {
          const baseMint = args.base_mint;
          const hasToken = baseMint && balance.tokens?.some(
            (t) => t.mint === baseMint && Number(t.balance) >= amountX
          );
          if (!hasToken) {
            log("executor_warn", `amount_x=${amountX} requested but wallet has no ${baseMint ?? "base token"} — forcing single-sided SOL deploy (amount_x=0).`);
            args.amount_x = 0;
          }
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 * Returns an object/value that JSON.stringify()s cleanly — never a blind
 * string slice, which used to cut nested JSON mid-field (e.g. losing
 * pnl_usd/pnl_pct off every close_position log with 2+ tx signatures).
 */
function summarizeResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const shortened = { ...result };
    for (const key of ["txs", "claim_txs", "close_txs"]) {
      if (Array.isArray(shortened[key]) && shortened[key].length > 0) {
        shortened[key] = `${shortened[key].length} tx(s), first ${shortened[key][0].slice(0, 12)}…`;
      }
    }
    if (JSON.stringify(shortened).length <= 1000) return shortened;
    return { ...shortened, _log_truncated: true };
  }
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return { _truncated_preview: str.slice(0, 500), _log_truncated: true, _original_length: str.length };
  }
  return result;
}
