import { PatternSignalEngine } from './PatternSignalEngine.mjs';

const clone = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
};

const deepMerge = (base, extra) => {
  if (Array.isArray(base) && Array.isArray(extra)) return extra.slice();
  if (base && typeof base === 'object' && extra && typeof extra === 'object' && !Array.isArray(base) && !Array.isArray(extra)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      result[key] = key in base ? deepMerge(base[key], value) : clone(value);
    }
    return result;
  }
  return clone(extra);
};

const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const normalizeSymbol = (value) => String(value ?? '').trim().toUpperCase();
const normalizeStringList = (value) => Array.isArray(value)
  ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  : [];

export class DeterministicEntryPolicy {
  constructor({
    configStore = null,
    patternSignalEngine = null,
    enabled = true,
  } = {}) {
    this.configStore = configStore;
    this.patternSignalEngine = patternSignalEngine ?? new PatternSignalEngine({ configStore });
    this.enabled = enabled !== false;
  }

  async evaluate({
    symbol,
    features,
    strategyConfig = {},
    executionConfig = {},
  } = {}) {
    if (!this.enabled) return null;
    if (features?.position) return null;

    const policyConfig = this.#resolvePolicyConfig({
      executionConfig,
      strategyConfig,
    });

    if (policyConfig.enabled !== true) return null;
    if (!this.#isAllowedSymbol(symbol, policyConfig)) return null;
    if (!this.#isAllowedAssetClass(features, strategyConfig, policyConfig)) return null;

    const patternMatches = await this.#evaluatePatterns({
      symbol,
      features,
      strategyConfig,
      policyConfig,
    });
    const winningPattern = this.#pickWinningPattern(patternMatches);
    if (!winningPattern) return null;

    const patternName = String(winningPattern.signalContext?.patternName ?? 'trend_pullback_continuation');

    return {
      action: 'open_long',
      confidence: Number(winningPattern.confidence ?? 0.82),
      reasoning: [
        `deterministic_entry:${patternName}`,
        ...(Array.isArray(winningPattern.reasoning) ? winningPattern.reasoning : []).slice(0, 3),
      ],
      requestedSizePct: toPositiveFiniteOrNull(winningPattern.requestedSizePct),
      stopLossPct: toPositiveFiniteOrNull(
        winningPattern.patternConfig?.stopLossPct
        ?? strategyConfig?.strategyRules?.stopLossPct
        ?? null
      ),
      takeProfitPct: toPositiveFiniteOrNull(
        winningPattern.patternConfig?.takeProfitPct
        ?? strategyConfig?.strategyRules?.takeProfitPct
        ?? null
      ),
      signalContext: {
        ...(winningPattern.signalContext ?? {}),
        deterministicEntryPolicy: 'trend_pullback_high_conviction_v1',
        deterministicPattern: patternName,
        deterministicMatchedPatterns: patternMatches
          .filter((entry) => entry?.matched === true)
          .map((entry) => String(entry?.signalContext?.patternName ?? '').trim())
          .filter(Boolean),
        bypassedLlm: true,
      },
    };
  }

  async #evaluatePatterns({ symbol, features, strategyConfig, policyConfig }) {
    const patterns = [];
    const trendPullbackConfig = policyConfig?.patterns?.trendPullbackContinuation ?? {};
    if (trendPullbackConfig.enabled !== false) {
      const result = await this.patternSignalEngine.evaluateTrendPullbackContinuation({
        symbol,
        features,
        strategyConfig,
        patternConfig: trendPullbackConfig,
      });
      patterns.push({
        ...result,
        patternConfig: trendPullbackConfig,
      });
    }

    const breakoutRetestConfig = policyConfig?.patterns?.breakoutRetest ?? {};
    if (breakoutRetestConfig.enabled === true) {
      const result = await this.patternSignalEngine.evaluateBreakoutRetest({
        symbol,
        features,
        strategyConfig,
        patternConfig: breakoutRetestConfig,
      });
      patterns.push({
        ...result,
        patternConfig: breakoutRetestConfig,
      });
    }

    return patterns;
  }

  #pickWinningPattern(patternMatches = []) {
    const matches = (Array.isArray(patternMatches) ? patternMatches : [])
      .filter((entry) => entry?.matched === true);
    if (!matches.length) return null;

    matches.sort((left, right) => {
      const confidenceDelta = Number(right?.confidence ?? 0) - Number(left?.confidence ?? 0);
      if (confidenceDelta !== 0) return confidenceDelta;
      return Number(right?.requestedSizePct ?? 0) - Number(left?.requestedSizePct ?? 0);
    });
    return matches[0];
  }

  #resolvePolicyConfig({ executionConfig = {}, strategyConfig = {} } = {}) {
    const globalConfig = executionConfig?.deterministicEntry ?? {};
    const symbolConfig = strategyConfig?.deterministicEntry ?? {};
    return deepMerge(globalConfig, symbolConfig);
  }

  #isAllowedSymbol(symbol, policyConfig) {
    const safeSymbol = normalizeSymbol(symbol);
    if (!safeSymbol) return false;

    const blockedSymbols = new Set(normalizeStringList(policyConfig?.blockedSymbols).map(normalizeSymbol));
    if (blockedSymbols.has(safeSymbol)) return false;

    const allowedSymbols = normalizeStringList(policyConfig?.allowedSymbols).map(normalizeSymbol);
    if (!allowedSymbols.length) return true;
    return allowedSymbols.includes(safeSymbol);
  }

  #isAllowedAssetClass(features, strategyConfig, policyConfig) {
    const assetClass = String(features?.assetClass ?? strategyConfig?.assetClass ?? '').trim().toLowerCase();
    const allowedAssetClasses = normalizeStringList(policyConfig?.allowedAssetClasses).map((entry) => entry.toLowerCase());
    if (!allowedAssetClasses.length) return true;
    return allowedAssetClasses.includes(assetClass);
  }
}
