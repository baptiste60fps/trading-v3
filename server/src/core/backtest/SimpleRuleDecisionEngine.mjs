import { isFiniteNumber } from '../types/validators.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ALLOWED_STRATEGY_PROFILES = new Set([
  'single_stock',
  'single_stock_quality',
  'consumer_quality_soft',
  'financial_quality',
  'high_beta_stock',
  'crypto_momentum',
  'index_etf',
]);

const getValues = (features, timeframe) => features?.timeframes?.[timeframe]?.values ?? {};

const hasMetricData = (values = {}, keys = []) => keys.some((key) => isFiniteNumber(values?.[key]));

const averageRelatedMetric = (features, timeframes, key) => {
  const list = Array.isArray(timeframes) ? timeframes : [timeframes];

  for (const timeframe of list) {
    const values = (features?.relatedSymbols ?? [])
      .map((entry) => entry?.timeframes?.[timeframe]?.values?.[key])
      .filter((value) => isFiniteNumber(value));

    if (values.length) {
      return {
        value: values.reduce((sum, value) => sum + value, 0) / values.length,
        timeframe,
      };
    }
  }

  return {
    value: null,
    timeframe: null,
  };
};

const pickContextValues = (features, primaryTimeframe, fallbackTimeframes = [], keys = ['emaGap12_26', 'rsi14']) => {
  const primary = getValues(features, primaryTimeframe);
  const primaryHasData = hasMetricData(primary, keys);
  if (primaryHasData) {
    return {
      values: primary,
      timeframe: primaryTimeframe,
      source: 'primary',
    };
  }

  for (const timeframe of fallbackTimeframes) {
    const values = getValues(features, timeframe);
    const hasData = hasMetricData(values, keys);
    if (hasData) {
      return {
        values,
        timeframe,
        source: 'fallback',
      };
    }
  }

  return {
    values: {},
    timeframe: null,
    source: 'missing',
  };
};

const averageRelatedMetricAtExactTimeframe = (features, timeframe, key) => {
  const values = (features?.relatedSymbols ?? [])
    .map((entry) => entry?.timeframes?.[timeframe]?.values?.[key])
    .filter((value) => isFiniteNumber(value));

  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const isPresent = (value) => isFiniteNumber(value);
const normalizeStrategyProfile = (value) => {
  const normalized = String(value ?? '').trim();
  return ALLOWED_STRATEGY_PROFILES.has(normalized) ? normalized : null;
};

export class SimpleRuleDecisionEngine {
  constructor({
    requestedSizePct = 0.03,
    defaultStopLossPct = 0.02,
    defaultTakeProfitPct = 0.04,
    entryRsiMin = 52,
    entryRsiMax = 72,
    exitRsiMin = 45,
    minHoldMs = 3_600_000,
    degradedRelatedTrendFloor = -0.006,
    degradedRelatedRsiFloor = 40,
    mediumOverextendedRsi = 80,
    mediumTrendConfirmationFloor = 0,
    fastRsiCeilingWhenMediumOverextended = 40,
    pullbackFastRsiCeilingForSecondaryEntries = 35,
    fastRsiCeilingForPrimaryEntries = 60,
    symbolProfiles = {},
  } = {}) {
    this.requestedSizePct = requestedSizePct;
    this.defaultStopLossPct = defaultStopLossPct;
    this.defaultTakeProfitPct = defaultTakeProfitPct;
    this.entryRsiMin = entryRsiMin;
    this.entryRsiMax = entryRsiMax;
    this.exitRsiMin = exitRsiMin;
    this.minHoldMs = minHoldMs;
    this.degradedRelatedTrendFloor = degradedRelatedTrendFloor;
    this.degradedRelatedRsiFloor = degradedRelatedRsiFloor;
    this.mediumOverextendedRsi = mediumOverextendedRsi;
    this.mediumTrendConfirmationFloor = mediumTrendConfirmationFloor;
    this.fastRsiCeilingWhenMediumOverextended = fastRsiCeilingWhenMediumOverextended;
    this.pullbackFastRsiCeilingForSecondaryEntries = pullbackFastRsiCeilingForSecondaryEntries;
    this.fastRsiCeilingForPrimaryEntries = fastRsiCeilingForPrimaryEntries;
    this.symbolProfiles = this.#normalizeSymbolProfiles(symbolProfiles);
  }

  async decide({ symbol = null, features, strategyConfig = null } = {}) {
    const marketState = features?.marketState ?? {};
    const position = features?.position ?? null;
    const price = Number(features?.currentPrice);
    const strategySymbol = String(symbol ?? features?.symbol ?? position?.symbol ?? '').toUpperCase();
    const strategyProfile = this.#resolveProfile(strategySymbol, strategyConfig);
    const profileRules = this.#getProfileRules(strategyProfile, strategyConfig);
    const fast = getValues(features, '5m');
    const mediumContext = pickContextValues(features, '1h', ['4h', '1d']);
    const medium = mediumContext.values;
    const mediumPrimary = getValues(features, '1h');
    const mediumPrimaryHasData = hasMetricData(mediumPrimary, ['emaGap12_26', 'rsi14']);
    const relatedTrendContext = averageRelatedMetric(features, ['1h', '4h', '1d'], 'emaGap12_26');
    const relatedRsiContext = averageRelatedMetric(features, ['1h', '4h', '1d'], 'rsi14');
    const relatedTrend = relatedTrendContext.value;
    const relatedRsi = relatedRsiContext.value;
    const relatedPrimaryTrend = averageRelatedMetricAtExactTimeframe(features, '1h', 'emaGap12_26');
    const relatedPrimaryRsi = averageRelatedMetricAtExactTimeframe(features, '1h', 'rsi14');
    const relatedPrimaryHasData = isPresent(relatedPrimaryTrend) || isPresent(relatedPrimaryRsi);
    const entrySignalScore = this.#computeEntrySignalScore({
      fast,
      medium,
      relatedTrend,
      relatedRsi,
    });
    const contextGuard = this.#buildContextGuardFromValues({
      medium,
      mediumPrimary,
      mediumPrimaryHasData,
      relatedTrend,
      relatedRsi,
      relatedPrimaryTrend,
      relatedPrimaryRsi,
      relatedPrimaryHasData,
    });
    const mediumTrendConfirmed = !isPresent(medium?.emaGap12_26) || medium.emaGap12_26 > profileRules.mediumTrendConfirmationFloor;
    const baseSignalContext = {
      symbol: strategySymbol || null,
      assetClass: features?.assetClass ?? strategyConfig?.assetClass ?? null,
      strategyProfile,
      entrySignalScore,
      contextScore: contextGuard.contextScore,
      mediumContextTimeframe: mediumContext.timeframe,
      mediumContextSource: mediumContext.source,
      relatedContextTimeframe: relatedTrendContext.timeframe ?? relatedRsiContext.timeframe ?? null,
      hasMediumContext: contextGuard.hasMediumContext,
      hasRelatedContext: contextGuard.hasRelatedContext,
      severeMediumBearish: contextGuard.severeMediumBearish,
      weakRelatedContext: contextGuard.weakRelatedContext,
      degradedRelatedContext: contextGuard.degradedRelatedContext,
      missingCriticalContext: contextGuard.missingCriticalContext,
      mediumTrendConfirmed,
      overextendedMediumContext: contextGuard.overextendedMediumContext,
      fastEmaGap12_26: fast.emaGap12_26 ?? null,
      fastPriceVsSma20: fast.priceVsSma20 ?? null,
      fastRsi14: fast.rsi14 ?? null,
      fastAtrPct14: fast.atrPct14 ?? null,
      mediumEmaGap12_26: medium.emaGap12_26 ?? null,
      mediumRsi14: medium.rsi14 ?? null,
      mediumPrimaryEmaGap12_26: mediumPrimary.emaGap12_26 ?? null,
      mediumPrimaryRsi14: mediumPrimary.rsi14 ?? null,
      relatedTrend,
      relatedRsi,
      relatedPrimaryTrend,
      relatedPrimaryRsi,
    };

    if (position) {
      const stopLossPct = isFiniteNumber(position?.stopLossPct) ? position.stopLossPct : this.defaultStopLossPct;
      const takeProfitPct = isFiniteNumber(position?.takeProfitPct) ? position.takeProfitPct : this.defaultTakeProfitPct;
      const entryPrice = Number(position?.entryPrice);
      const heldMs = Math.max(0, Number(features?.atMs ?? 0) - Number(position?.openedAtMs ?? 0));
      const minimumHoldMs = profileRules.minHoldMs ?? this.minHoldMs;
      const positionSignalContext = {
        ...baseSignalContext,
        heldMs,
        minimumHoldMs,
        entryPrice: isFiniteNumber(entryPrice) ? entryPrice : null,
      };

      if (marketState.isPreClose) {
        return this.#decision('close_long', 0.74, ['preclose_window'], positionSignalContext);
      }

      if (isFiniteNumber(price) && isFiniteNumber(entryPrice) && price <= entryPrice * (1 - stopLossPct)) {
        return this.#decision('close_long', 0.94, ['stop_loss_hit'], positionSignalContext);
      }

      if (isFiniteNumber(price) && isFiniteNumber(entryPrice) && price >= entryPrice * (1 + takeProfitPct)) {
        return this.#decision('close_long', 0.9, ['take_profit_hit'], positionSignalContext);
      }

      if (heldMs < minimumHoldMs) {
        return this.#decision('hold', 0.52, ['minimum_holding_period'], positionSignalContext);
      }

      if ((fast.emaGap12_26 ?? -1) <= -0.008 || (fast.rsi14 ?? 0) < Math.max(40, this.exitRsiMin - 5) || entrySignalScore <= 0) {
        return this.#decision('close_long', 0.72, ['short_term_momentum_lost'], positionSignalContext);
      }

      return this.#decision('hold', clamp(0.5 + entrySignalScore * 0.05, 0.5, 0.82), [`signal_score_${entrySignalScore}`], positionSignalContext);
    }

    if (!marketState.isOpen || marketState.isPreClose || marketState.isNoTradeOpen) {
      return this.#decision('skip', 0.1, ['market_gate'], baseSignalContext);
    }

    if (contextGuard.severeMediumBearish) {
      return this.#decision('skip', 0.14, ['medium_context_bearish'], baseSignalContext);
    }

    if (contextGuard.missingCriticalContext && entrySignalScore < 7) {
      return this.#decision('skip', 0.18, ['missing_context_gate'], baseSignalContext);
    }

    if (contextGuard.weakRelatedContext && entrySignalScore < 7) {
      return this.#decision('skip', 0.2, ['related_context_weak'], baseSignalContext);
    }

    if (contextGuard.degradedRelatedContext && entrySignalScore <= 7) {
      return this.#decision('skip', 0.22, ['related_context_degraded'], baseSignalContext);
    }

    if (profileRules.requireMediumTrendConfirmed && !mediumTrendConfirmed) {
      return this.#decision('skip', 0.23, ['medium_trend_not_confirmed'], baseSignalContext);
    }

    if (
      contextGuard.overextendedMediumContext &&
      (fast.rsi14 ?? 100) > this.fastRsiCeilingWhenMediumOverextended
    ) {
      return this.#decision('skip', 0.26, ['medium_context_overextended'], baseSignalContext);
    }

    if (entrySignalScore < profileRules.minimumEntryScore) {
      const scoutDecision = this.#maybeBuildScoutDecision({
        entrySignalScore,
        profileRules,
        contextGuard,
        mediumContext,
        medium,
        relatedTrend,
        relatedRsi,
        fast,
        baseSignalContext,
      });
      if (scoutDecision) return scoutDecision;
      return this.#decision('skip', 0.24, ['low_conviction_context'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumMediumGap) && !isPresent(medium.emaGap12_26)) {
      return this.#decision('skip', 0.24, ['medium_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumMediumGap) && medium.emaGap12_26 < profileRules.minimumMediumGap) {
      return this.#decision('skip', 0.24, ['medium_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumMediumRsi) && !isPresent(medium.rsi14)) {
      return this.#decision('skip', 0.24, ['medium_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumMediumRsi) && medium.rsi14 < profileRules.minimumMediumRsi) {
      return this.#decision('skip', 0.24, ['medium_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumRelatedTrend) && !isPresent(relatedTrend)) {
      return this.#decision('skip', 0.24, ['related_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumRelatedTrend) && relatedTrend < profileRules.minimumRelatedTrend) {
      return this.#decision('skip', 0.24, ['related_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumRelatedRsi) && !isPresent(relatedRsi)) {
      return this.#decision('skip', 0.24, ['related_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumRelatedRsi) && relatedRsi < profileRules.minimumRelatedRsi) {
      return this.#decision('skip', 0.24, ['related_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumFastEmaGap) && !isPresent(fast.emaGap12_26)) {
      return this.#decision('skip', 0.24, ['fast_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumFastEmaGap) && fast.emaGap12_26 < profileRules.minimumFastEmaGap) {
      return this.#decision('skip', 0.24, ['fast_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumFastRsi) && !isPresent(fast.rsi14)) {
      return this.#decision('skip', 0.24, ['fast_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.minimumFastRsi) && fast.rsi14 < profileRules.minimumFastRsi) {
      return this.#decision('skip', 0.24, ['fast_context_too_weak'], baseSignalContext);
    }

    if (isFiniteNumber(profileRules.maximumFastRsi) && isPresent(fast.rsi14) && fast.rsi14 > profileRules.maximumFastRsi) {
      return this.#decision('skip', 0.24, ['fast_context_overheated'], baseSignalContext);
    }

    if (mediumContext.source === 'fallback') {
      if (isFiniteNumber(profileRules.minimumMediumGapWhenFallback) && !isPresent(medium.emaGap12_26)) {
        return this.#decision('skip', 0.24, ['fallback_context_too_weak'], baseSignalContext);
      }

      if (
        isFiniteNumber(profileRules.minimumMediumGapWhenFallback) &&
        medium.emaGap12_26 < profileRules.minimumMediumGapWhenFallback
      ) {
        return this.#decision('skip', 0.24, ['fallback_context_too_weak'], baseSignalContext);
      }

      if (isFiniteNumber(profileRules.minimumMediumRsiWhenFallback) && !isPresent(medium.rsi14)) {
        return this.#decision('skip', 0.24, ['fallback_context_too_weak'], baseSignalContext);
      }

      if (
        isFiniteNumber(profileRules.minimumMediumRsiWhenFallback) &&
        medium.rsi14 < profileRules.minimumMediumRsiWhenFallback
      ) {
        return this.#decision('skip', 0.24, ['fallback_context_too_weak'], baseSignalContext);
      }

      if (isFiniteNumber(profileRules.minimumRelatedTrendWhenFallback) && !isPresent(relatedTrend)) {
        return this.#decision('skip', 0.24, ['fallback_related_context_too_weak'], baseSignalContext);
      }

      if (
        isFiniteNumber(profileRules.minimumRelatedTrendWhenFallback) &&
        relatedTrend < profileRules.minimumRelatedTrendWhenFallback
      ) {
        return this.#decision('skip', 0.24, ['fallback_related_context_too_weak'], baseSignalContext);
      }

      if (isFiniteNumber(profileRules.minimumRelatedRsiWhenFallback) && !isPresent(relatedRsi)) {
        return this.#decision('skip', 0.24, ['fallback_related_context_too_weak'], baseSignalContext);
      }

      if (
        isFiniteNumber(profileRules.minimumRelatedRsiWhenFallback) &&
        relatedRsi < profileRules.minimumRelatedRsiWhenFallback
      ) {
        return this.#decision('skip', 0.24, ['fallback_related_context_too_weak'], baseSignalContext);
      }
    }

    if (entrySignalScore < 9) {
      if ((fast.rsi14 ?? 100) > profileRules.secondaryPullbackFastRsiCeiling) {
        return this.#decision('skip', 0.25, ['pullback_not_deep_enough'], baseSignalContext);
      }

      if ((fast.priceVsSma20 ?? 1) > profileRules.secondaryPullbackPriceVsSmaCeiling) {
        return this.#decision('skip', 0.25, ['pullback_not_deep_enough'], baseSignalContext);
      }

      if (
        strategyProfile === 'single_stock' &&
        (medium.rsi14 ?? 0) >= profileRules.secondaryMinimumMediumRsiWhenRelatedWeak &&
        (relatedTrend ?? 1) >= profileRules.secondaryRelatedTrendCeilingWhenMediumHot
      ) {
        return this.#decision('skip', 0.25, ['pullback_not_contextual'], baseSignalContext);
      }
    }

    if (profileRules.requireFastTrendTurn && (fast.emaGap12_26 ?? -1) <= profileRules.fastTrendTurnFloor) {
      return this.#decision('skip', 0.27, ['high_beta_fast_turn_not_confirmed'], baseSignalContext);
    }

    if (
      entrySignalScore >= 9 &&
      (
        (
          isPresent(medium.emaGap12_26) &&
          isFiniteNumber(profileRules.maximumMediumGapForPrimaryEntry) &&
          medium.emaGap12_26 > profileRules.maximumMediumGapForPrimaryEntry
        ) ||
        (
          isPresent(medium.rsi14) &&
          isFiniteNumber(profileRules.maximumMediumRsiForPrimaryEntry) &&
          medium.rsi14 > profileRules.maximumMediumRsiForPrimaryEntry
        )
      )
    ) {
      return this.#decision('skip', 0.28, ['primary_context_overheated'], baseSignalContext);
    }

    if (
      entrySignalScore >= 9 &&
      (fast.rsi14 ?? 100) > profileRules.primaryFastRsiCeiling &&
      (fast.priceVsSma20 ?? 0) > profileRules.primaryChasePriceVsSmaCeiling
    ) {
      return this.#decision('skip', 0.27, ['score9_chasing_strength'], baseSignalContext);
    }

    if (contextGuard.contextScore < 0) {
      return this.#decision('skip', 0.24, ['entry_filter_not_met'], baseSignalContext);
    }

    const confidence = clamp(0.46 + entrySignalScore * 0.06 + Math.max(0, contextGuard.contextScore) * 0.03, 0.46, 0.86);
    const rawRequestedSizePct = clamp(
      this.requestedSizePct + Math.max(0, entrySignalScore - 6) * 0.005 + Math.max(0, contextGuard.contextScore) * 0.0025,
      0.01,
      0.05,
    );
    const requestedSizePct = clamp(
      rawRequestedSizePct * (profileRules.requestedSizeScale ?? 1),
      0.01,
      profileRules.maxRequestedSizePct ?? 0.05,
    );

    return {
      action: 'open_long',
      confidence,
      reasoning: [`signal_score_${entrySignalScore}`],
      requestedSizePct,
      stopLossPct: profileRules.stopLossPct ?? this.defaultStopLossPct,
      takeProfitPct: profileRules.takeProfitPct ?? this.defaultTakeProfitPct,
      signalContext: baseSignalContext,
    };
  }

  #decision(action, confidence, reasoning, signalContext = null) {
    return {
      action,
      confidence,
      reasoning,
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext,
    };
  }

  #maybeBuildScoutDecision({
    entrySignalScore,
    profileRules,
    contextGuard,
    mediumContext,
    medium,
    relatedTrend,
    relatedRsi,
    fast,
    baseSignalContext,
  }) {
    if (!profileRules.enableScoutEntries) return null;
    if (entrySignalScore < (profileRules.scoutMinimumEntryScore ?? 8)) return null;
    if ((profileRules.scoutRequirePrimaryMediumContext ?? false) && mediumContext.source !== 'primary') return null;
    if ((contextGuard.contextScore ?? 0) < (profileRules.scoutMinimumContextScore ?? 3)) return null;
    if (isFiniteNumber(profileRules.scoutMinimumMediumRsi) && (medium.rsi14 ?? -Infinity) < profileRules.scoutMinimumMediumRsi) return null;
    if (isFiniteNumber(profileRules.scoutMinimumRelatedTrend) && (relatedTrend ?? -Infinity) < profileRules.scoutMinimumRelatedTrend) return null;
    if (isFiniteNumber(profileRules.scoutMinimumRelatedRsi) && (relatedRsi ?? -Infinity) < profileRules.scoutMinimumRelatedRsi) return null;
    if (isFiniteNumber(profileRules.scoutMinimumFastRsi) && (fast.rsi14 ?? -Infinity) < profileRules.scoutMinimumFastRsi) return null;
    if (isFiniteNumber(profileRules.scoutMaximumFastRsi) && (fast.rsi14 ?? Infinity) > profileRules.scoutMaximumFastRsi) return null;
    if (isFiniteNumber(profileRules.scoutMaximumFastPriceVsSma) && (fast.priceVsSma20 ?? Infinity) > profileRules.scoutMaximumFastPriceVsSma) return null;

    const baseRequestedSizePct = clamp(
      this.requestedSizePct * (profileRules.scoutRequestedSizeScale ?? 0.5),
      0.005,
      profileRules.scoutMaxRequestedSizePct ?? 0.02,
    );

    return {
      action: 'open_long',
      confidence: clamp(0.42 + Math.max(0, contextGuard.contextScore) * 0.02, 0.42, 0.64),
      reasoning: ['scout_entry', `signal_score_${entrySignalScore}`],
      requestedSizePct: baseRequestedSizePct,
      stopLossPct: profileRules.stopLossPct ?? this.defaultStopLossPct,
      takeProfitPct: profileRules.takeProfitPct ?? this.defaultTakeProfitPct,
      signalContext: {
        ...baseSignalContext,
        scoutEntry: true,
      },
    };
  }

  #computeEntrySignalScore({ fast, medium, relatedTrend, relatedRsi }) {
    let score = 0;

    if ((fast.emaGap12_26 ?? -1) > -0.0025) score += 2;
    if ((fast.priceVsSma20 ?? -1) > -0.01) score += 1;
    if ((fast.rsi14 ?? 0) >= 42 && (fast.rsi14 ?? 100) <= this.entryRsiMax + 3) score += 1;
    if ((medium.emaGap12_26 ?? -1) > -0.004) score += 1;
    if ((medium.rsi14 ?? 0) >= 45) score += 1;
    if ((relatedTrend ?? -1) > -0.008) score += 1;
    if ((relatedRsi ?? 0) > 38) score += 1;
    if ((fast.atrPct14 ?? 1) < 0.05) score += 1;

    return score;
  }

  #resolveProfile(symbol, strategyConfig = null) {
    const mappedProfile = this.symbolProfiles[symbol];
    if (mappedProfile) return mappedProfile;

    const explicitProfile = normalizeStrategyProfile(strategyConfig?.strategyProfile);
    if (explicitProfile) return explicitProfile;
    return 'single_stock';
  }

  #normalizeSymbolProfiles(input) {
    const entries = Object.entries(input ?? {});
    const normalized = {};

    for (const [symbol, profile] of entries) {
      const safeSymbol = String(symbol ?? '').toUpperCase();
      const safeProfile = normalizeStrategyProfile(profile);
      if (!safeSymbol || !safeProfile) continue;
      normalized[safeSymbol] = safeProfile;
    }

    return Object.freeze(normalized);
  }

  #getProfileRules(profile, strategyConfig = null) {
    const baseRules = this.#getBaseProfileRules(profile);
    return this.#applyRuleOverrides(baseRules, strategyConfig?.strategyRules);
  }

  #getBaseProfileRules(profile) {
    if (profile === 'index_etf') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: 0,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 30,
        secondaryPullbackPriceVsSmaCeiling: -0.004,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 58,
        primaryChasePriceVsSmaCeiling: 0,
        requireFastTrendTurn: false,
        fastTrendTurnFloor: -1,
        maximumMediumGapForPrimaryEntry: Number.POSITIVE_INFINITY,
        maximumMediumRsiForPrimaryEntry: Number.POSITIVE_INFINITY,
        minimumFastEmaGap: null,
        minimumFastRsi: null,
        maximumFastRsi: null,
        enableScoutEntries: false,
        scoutMinimumEntryScore: null,
        scoutMinimumContextScore: null,
        scoutRequirePrimaryMediumContext: false,
        scoutMinimumMediumRsi: null,
        scoutMinimumRelatedTrend: null,
        scoutMinimumRelatedRsi: null,
        scoutMinimumFastRsi: null,
        scoutMaximumFastRsi: null,
        scoutMaximumFastPriceVsSma: null,
        scoutRequestedSizeScale: null,
        scoutMaxRequestedSizePct: null,
        minimumMediumGap: null,
        minimumMediumRsi: null,
        minimumRelatedTrend: null,
        minimumRelatedRsi: null,
        minimumMediumGapWhenFallback: null,
        minimumMediumRsiWhenFallback: null,
        minimumRelatedTrendWhenFallback: null,
        minimumRelatedRsiWhenFallback: null,
        requestedSizeScale: 1,
        maxRequestedSizePct: 0.05,
      };
    }

    if (profile === 'high_beta_stock') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: 0,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 25,
        secondaryPullbackPriceVsSmaCeiling: -0.005,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 57,
        primaryChasePriceVsSmaCeiling: 0.002,
        requireFastTrendTurn: true,
        fastTrendTurnFloor: 0,
        maximumMediumGapForPrimaryEntry: 0.007,
        maximumMediumRsiForPrimaryEntry: 74,
        minimumFastEmaGap: null,
        minimumFastRsi: null,
        maximumFastRsi: null,
        enableScoutEntries: false,
        scoutMinimumEntryScore: null,
        scoutMinimumContextScore: null,
        scoutRequirePrimaryMediumContext: false,
        scoutMinimumMediumRsi: null,
        scoutMinimumRelatedTrend: null,
        scoutMinimumRelatedRsi: null,
        scoutMinimumFastRsi: null,
        scoutMaximumFastRsi: null,
        scoutMaximumFastPriceVsSma: null,
        scoutRequestedSizeScale: null,
        scoutMaxRequestedSizePct: null,
        minimumMediumGap: null,
        minimumMediumRsi: null,
        minimumRelatedTrend: null,
        minimumRelatedRsi: null,
        minimumMediumGapWhenFallback: null,
        minimumMediumRsiWhenFallback: null,
        minimumRelatedTrendWhenFallback: null,
        minimumRelatedRsiWhenFallback: null,
        requestedSizeScale: 0.8,
        maxRequestedSizePct: 0.035,
      };
    }

    if (profile === 'crypto_momentum') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: -0.002,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 42,
        secondaryPullbackPriceVsSmaCeiling: -0.0015,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 66,
        primaryChasePriceVsSmaCeiling: 0.003,
        requireFastTrendTurn: true,
        fastTrendTurnFloor: -0.0005,
        maximumMediumGapForPrimaryEntry: 0.018,
        maximumMediumRsiForPrimaryEntry: 78,
        minimumFastEmaGap: -0.001,
        minimumFastRsi: 38,
        maximumFastRsi: 72,
        enableScoutEntries: false,
        scoutMinimumEntryScore: null,
        scoutMinimumContextScore: null,
        scoutRequirePrimaryMediumContext: false,
        scoutMinimumMediumRsi: null,
        scoutMinimumRelatedTrend: null,
        scoutMinimumRelatedRsi: null,
        scoutMinimumFastRsi: null,
        scoutMaximumFastRsi: null,
        scoutMaximumFastPriceVsSma: null,
        scoutRequestedSizeScale: null,
        scoutMaxRequestedSizePct: null,
        minimumMediumGap: -0.002,
        minimumMediumRsi: 40,
        minimumRelatedTrend: -0.012,
        minimumRelatedRsi: 34,
        minimumMediumGapWhenFallback: 0,
        minimumMediumRsiWhenFallback: 45,
        minimumRelatedTrendWhenFallback: -0.006,
        minimumRelatedRsiWhenFallback: 38,
        requestedSizeScale: 0.32,
        maxRequestedSizePct: 0.015,
        stopLossPct: 0.035,
        takeProfitPct: 0.065,
        minHoldMs: 6 * 60 * 60 * 1000,
      };
    }

    if (profile === 'financial_quality') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: -0.0005,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 31,
        secondaryPullbackPriceVsSmaCeiling: -0.0025,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 60,
        primaryChasePriceVsSmaCeiling: 0.0008,
        requireFastTrendTurn: false,
        fastTrendTurnFloor: -1,
        maximumMediumGapForPrimaryEntry: 0.0055,
        maximumMediumRsiForPrimaryEntry: 72,
        minimumFastEmaGap: null,
        minimumFastRsi: null,
        maximumFastRsi: null,
        enableScoutEntries: true,
        scoutMinimumEntryScore: 8,
        scoutMinimumContextScore: 3,
        scoutRequirePrimaryMediumContext: true,
        scoutMinimumMediumRsi: 54,
        scoutMinimumRelatedTrend: -0.0005,
        scoutMinimumRelatedRsi: 47,
        scoutMinimumFastRsi: 44,
        scoutMaximumFastRsi: 49.5,
        scoutMaximumFastPriceVsSma: -0.0007,
        scoutRequestedSizeScale: 0.22,
        scoutMaxRequestedSizePct: 0.01,
        minimumMediumGap: null,
        minimumMediumRsi: null,
        minimumRelatedTrend: null,
        minimumRelatedRsi: null,
        minimumMediumGapWhenFallback: null,
        minimumMediumRsiWhenFallback: null,
        minimumRelatedTrendWhenFallback: null,
        minimumRelatedRsiWhenFallback: null,
        requestedSizeScale: 0.7,
        maxRequestedSizePct: 0.025,
      };
    }

    if (profile === 'consumer_quality_soft') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: -0.0005,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 30,
        secondaryPullbackPriceVsSmaCeiling: -0.0035,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 59,
        primaryChasePriceVsSmaCeiling: 0.0008,
        requireFastTrendTurn: false,
        fastTrendTurnFloor: -1,
        maximumMediumGapForPrimaryEntry: 0.0055,
        maximumMediumRsiForPrimaryEntry: 72,
        minimumFastEmaGap: null,
        minimumFastRsi: null,
        maximumFastRsi: null,
        enableScoutEntries: true,
        scoutMinimumEntryScore: 8,
        scoutMinimumContextScore: 3,
        scoutRequirePrimaryMediumContext: true,
        scoutMinimumMediumRsi: 56,
        scoutMinimumRelatedTrend: -0.001,
        scoutMinimumRelatedRsi: 46,
        scoutMinimumFastRsi: 44,
        scoutMaximumFastRsi: 49,
        scoutMaximumFastPriceVsSma: -0.0006,
        scoutRequestedSizeScale: 0.25,
        scoutMaxRequestedSizePct: 0.01,
        minimumMediumGap: null,
        minimumMediumRsi: null,
        minimumRelatedTrend: null,
        minimumRelatedRsi: null,
        minimumMediumGapWhenFallback: null,
        minimumMediumRsiWhenFallback: null,
        minimumRelatedTrendWhenFallback: null,
        minimumRelatedRsiWhenFallback: null,
        requestedSizeScale: 0.75,
        maxRequestedSizePct: 0.03,
      };
    }

    if (profile === 'single_stock_quality') {
      return {
        requireMediumTrendConfirmed: true,
        mediumTrendConfirmationFloor: 0,
        minimumEntryScore: 9,
        secondaryPullbackFastRsiCeiling: 28,
        secondaryPullbackPriceVsSmaCeiling: -0.004,
        secondaryMinimumMediumRsiWhenRelatedWeak: 100,
        secondaryRelatedTrendCeilingWhenMediumHot: 1,
        primaryFastRsiCeiling: 60,
        primaryChasePriceVsSmaCeiling: 0.001,
        requireFastTrendTurn: false,
        fastTrendTurnFloor: -1,
        maximumMediumGapForPrimaryEntry: 0.006,
        maximumMediumRsiForPrimaryEntry: 74,
        minimumFastEmaGap: null,
        minimumFastRsi: null,
        maximumFastRsi: null,
        enableScoutEntries: true,
        scoutMinimumEntryScore: 8,
        scoutMinimumContextScore: 4,
        scoutRequirePrimaryMediumContext: true,
        scoutMinimumMediumRsi: 60,
        scoutMinimumRelatedTrend: 0,
        scoutMinimumRelatedRsi: 48,
        scoutMinimumFastRsi: 45,
        scoutMaximumFastRsi: 50,
        scoutMaximumFastPriceVsSma: -0.0008,
        scoutRequestedSizeScale: 0.3,
        scoutMaxRequestedSizePct: 0.012,
        minimumMediumGap: null,
        minimumMediumRsi: null,
        minimumRelatedTrend: null,
        minimumRelatedRsi: null,
        minimumMediumGapWhenFallback: null,
        minimumMediumRsiWhenFallback: null,
        minimumRelatedTrendWhenFallback: null,
        minimumRelatedRsiWhenFallback: null,
        requestedSizeScale: 0.9,
        maxRequestedSizePct: 0.04,
      };
    }

    return {
      requireMediumTrendConfirmed: false,
      mediumTrendConfirmationFloor: -0.001,
      minimumEntryScore: 8,
      secondaryPullbackFastRsiCeiling: 32,
      secondaryPullbackPriceVsSmaCeiling: -0.003,
      secondaryMinimumMediumRsiWhenRelatedWeak: 70,
      secondaryRelatedTrendCeilingWhenMediumHot: 0,
      primaryFastRsiCeiling: 62,
      primaryChasePriceVsSmaCeiling: 0.001,
      requireFastTrendTurn: false,
      fastTrendTurnFloor: -1,
      maximumMediumGapForPrimaryEntry: Number.POSITIVE_INFINITY,
      maximumMediumRsiForPrimaryEntry: Number.POSITIVE_INFINITY,
      minimumFastEmaGap: null,
      minimumFastRsi: null,
      maximumFastRsi: null,
      enableScoutEntries: false,
      scoutMinimumEntryScore: null,
      scoutMinimumContextScore: null,
      scoutRequirePrimaryMediumContext: false,
      scoutMinimumMediumRsi: null,
      scoutMinimumRelatedTrend: null,
      scoutMinimumRelatedRsi: null,
      scoutMinimumFastRsi: null,
      scoutMaximumFastRsi: null,
      scoutMaximumFastPriceVsSma: null,
      scoutRequestedSizeScale: null,
      scoutMaxRequestedSizePct: null,
      minimumMediumGap: null,
      minimumMediumRsi: null,
      minimumRelatedTrend: null,
      minimumRelatedRsi: null,
      minimumMediumGapWhenFallback: null,
      minimumMediumRsiWhenFallback: null,
      minimumRelatedTrendWhenFallback: null,
      minimumRelatedRsiWhenFallback: null,
      requestedSizeScale: 1,
      maxRequestedSizePct: 0.05,
    };
  }

  #applyRuleOverrides(baseRules, rawOverrides = null) {
    if (!rawOverrides || typeof rawOverrides !== 'object') {
      return baseRules;
    }

    const merged = { ...baseRules };
    for (const [key, value] of Object.entries(rawOverrides)) {
      if (!(key in merged)) continue;

      if (value === null) {
        merged[key] = null;
        continue;
      }

      if (typeof merged[key] === 'boolean') {
        if (typeof value === 'boolean') merged[key] = value;
        continue;
      }

      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        merged[key] = numeric;
      }
    }

    return merged;
  }

  #buildContextGuardFromValues({
    medium,
    mediumPrimary,
    mediumPrimaryHasData,
    relatedTrend,
    relatedRsi,
    relatedPrimaryTrend,
    relatedPrimaryRsi,
    relatedPrimaryHasData,
  }) {
    const mediumGap = medium.emaGap12_26 ?? null;
    const mediumRsi = medium.rsi14 ?? null;
    const hasMediumContext = isPresent(mediumGap) || isPresent(mediumRsi);
    const hasRelatedContext = isPresent(relatedTrend) || isPresent(relatedRsi);
    const primaryMediumGap = mediumPrimary?.emaGap12_26 ?? null;
    const primaryMediumRsi = mediumPrimary?.rsi14 ?? null;
    const severeMediumBearish =
      (mediumPrimaryHasData && isPresent(primaryMediumGap) && primaryMediumGap < -0.008) ||
      (mediumPrimaryHasData && isPresent(primaryMediumRsi) && primaryMediumRsi < 28) ||
      (isPresent(mediumGap) && mediumGap < -0.012 && isPresent(mediumRsi) && mediumRsi < 32);
    const weakRelatedContext =
      (relatedPrimaryHasData && isPresent(relatedPrimaryTrend) && relatedPrimaryTrend < -0.012) ||
      (relatedPrimaryHasData && isPresent(relatedPrimaryRsi) && relatedPrimaryRsi < 34) ||
      (!relatedPrimaryHasData && isPresent(relatedTrend) && relatedTrend < -0.01) ||
      (!relatedPrimaryHasData && isPresent(relatedRsi) && relatedRsi < 36);
    const degradedRelatedContext =
      (relatedPrimaryHasData && isPresent(relatedPrimaryTrend) && relatedPrimaryTrend < this.degradedRelatedTrendFloor) ||
      (relatedPrimaryHasData && isPresent(relatedPrimaryRsi) && relatedPrimaryRsi < this.degradedRelatedRsiFloor) ||
      (!relatedPrimaryHasData && isPresent(relatedTrend) && relatedTrend < this.degradedRelatedTrendFloor) ||
      (!relatedPrimaryHasData && isPresent(relatedRsi) && relatedRsi < this.degradedRelatedRsiFloor);
    const missingCriticalContext = !hasMediumContext || !hasRelatedContext;
    const overextendedMediumContext =
      (mediumPrimaryHasData && isPresent(primaryMediumRsi) && primaryMediumRsi >= this.mediumOverextendedRsi) ||
      (isPresent(mediumRsi) && mediumRsi >= this.mediumOverextendedRsi);

    let contextScore = 0;

    if (!hasMediumContext) contextScore -= 2;
    else {
      if (isPresent(mediumGap)) {
        if (mediumGap > 0.002) contextScore += 2;
        else if (mediumGap > -0.002) contextScore += 1;
        else if (mediumGap < -0.004) contextScore -= 2;
      }

      if (isPresent(mediumRsi)) {
        if (mediumRsi >= 55) contextScore += 2;
        else if (mediumRsi >= 45) contextScore += 1;
        else if (mediumRsi < 35) contextScore -= 2;
      }
    }

    if (!hasRelatedContext) contextScore -= 1;
    else {
      if (isPresent(relatedTrend)) {
        if (relatedTrend > 0.002) contextScore += 1;
        else if (relatedTrend < -0.008) contextScore -= 1;
      }

      if (isPresent(relatedRsi)) {
        if (relatedRsi >= 50) contextScore += 1;
        else if (relatedRsi < 38) contextScore -= 1;
      }
    }

    return {
      contextScore,
      hasMediumContext,
      hasRelatedContext,
      severeMediumBearish,
      weakRelatedContext,
      degradedRelatedContext,
      missingCriticalContext,
      overextendedMediumContext,
    };
  }
}
