import { SimpleRuleDecisionEngine } from '../backtest/SimpleRuleDecisionEngine.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const hasThreshold = (value) => Number.isFinite(Number(value));
const normalizeReasoning = (reasoning) => Array.isArray(reasoning)
  ? reasoning.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  : [];
const toBarNumber = (bar, key) => {
  const numeric = Number(bar?.[key]);
  return Number.isFinite(numeric) ? numeric : null;
};
const normalizeShortBars = (bars) => (Array.isArray(bars) ? bars : [])
  .map((bar) => ({
    open: toBarNumber(bar, 'open'),
    high: toBarNumber(bar, 'high'),
    low: toBarNumber(bar, 'low'),
    close: toBarNumber(bar, 'close'),
    endMs: toBarNumber(bar, 'endMs') ?? toBarNumber(bar, 'timestamp'),
  }))
  .filter((bar) => [bar.high, bar.low, bar.close].every((value) => Number.isFinite(value)));

export class PatternSignalEngine {
  constructor({
    configStore = null,
  } = {}) {
    this.configStore = configStore;
    this.ruleEngine = new SimpleRuleDecisionEngine({
      symbolProfiles: this.configStore?.getStrategyProfileMap?.() ?? {},
    });
  }

  async evaluateTrendPullbackContinuation({
    symbol,
    features,
    strategyConfig = null,
    patternConfig = {},
  } = {}) {
    const heuristicDecision = await this.ruleEngine.decide({
      symbol,
      features,
      strategyConfig,
    });

    const signalContext = heuristicDecision?.signalContext ?? {};
    const gateFailures = [];

    if (heuristicDecision?.action !== 'open_long') {
      gateFailures.push(...normalizeReasoning(heuristicDecision?.reasoning));
      return this.#buildResult({
        matched: false,
        confidence: 0,
        gateFailures,
        reasoning: ['heuristic_not_open_long'],
        heuristicDecision,
        patternName: 'trend_pullback_continuation',
      });
    }

    this.#applyCommonContextGates({
      signalContext,
      patternConfig,
      gateFailures,
    });

    if (gateFailures.length) {
      return this.#buildResult({
        matched: false,
        confidence: 0,
        gateFailures,
        reasoning: ['pattern_gates_failed'],
        heuristicDecision,
        patternName: 'trend_pullback_continuation',
      });
    }

    const requestedSizePct = this.#resolveRequestedSizePct({
      heuristicRequestedSizePct: heuristicDecision?.requestedSizePct,
      patternConfig,
    });

    return this.#buildResult({
      matched: true,
      confidence: clamp(Number(heuristicDecision?.confidence ?? 0.75) + Number(patternConfig.confidenceBoost ?? 0.08), 0.7, 0.96),
      gateFailures: [],
      reasoning: [
        'trend_pullback_continuation',
        ...normalizeReasoning(heuristicDecision?.reasoning).slice(0, 2),
      ],
      heuristicDecision,
      requestedSizePct,
      patternName: 'trend_pullback_continuation',
    });
  }

  async evaluateBreakoutRetest({
    symbol,
    features,
    strategyConfig = null,
    patternConfig = {},
  } = {}) {
    const heuristicDecision = await this.ruleEngine.decide({
      symbol,
      features,
      strategyConfig,
    });

    const signalContext = heuristicDecision?.signalContext ?? {};
    const gateFailures = [];

    if (heuristicDecision?.action !== 'open_long') {
      gateFailures.push(...normalizeReasoning(heuristicDecision?.reasoning));
      return this.#buildResult({
        matched: false,
        confidence: 0,
        gateFailures,
        reasoning: ['heuristic_not_open_long'],
        heuristicDecision,
        patternName: 'breakout_retest',
      });
    }

    this.#applyCommonContextGates({
      signalContext,
      patternConfig,
      gateFailures,
    });

    const breakoutAnalysis = this.#analyzeBreakoutRetest({
      shortBars: features?.shortBars,
      patternConfig,
    });

    if (!breakoutAnalysis.matched) {
      gateFailures.push(...breakoutAnalysis.gateFailures);
    }

    if (gateFailures.length) {
      return this.#buildResult({
        matched: false,
        confidence: 0,
        gateFailures,
        reasoning: ['pattern_gates_failed'],
        heuristicDecision,
        patternName: 'breakout_retest',
        extraSignalContext: breakoutAnalysis.signalContext,
      });
    }

    const requestedSizePct = this.#resolveRequestedSizePct({
      heuristicRequestedSizePct: heuristicDecision?.requestedSizePct,
      patternConfig,
    });

    return this.#buildResult({
      matched: true,
      confidence: clamp(Number(heuristicDecision?.confidence ?? 0.76) + Number(patternConfig.confidenceBoost ?? 0.1), 0.72, 0.97),
      gateFailures: [],
      reasoning: [
        'breakout_retest',
        ...normalizeReasoning(heuristicDecision?.reasoning).slice(0, 2),
      ],
      heuristicDecision,
      requestedSizePct,
      patternName: 'breakout_retest',
      extraSignalContext: breakoutAnalysis.signalContext,
    });
  }

  #applyCommonContextGates({ signalContext, patternConfig, gateFailures }) {
    if (signalContext?.scoutEntry === true && patternConfig.allowScoutEntries !== true) {
      gateFailures.push('scout_entry_not_allowed');
    }
    if ((signalContext?.entrySignalScore ?? -Infinity) < Number(patternConfig.minimumSignalScore ?? 9)) {
      gateFailures.push('signal_score_too_low');
    }
    if ((signalContext?.contextScore ?? -Infinity) < Number(patternConfig.minimumContextScore ?? 3)) {
      gateFailures.push('context_score_too_low');
    }
    if (patternConfig.requireMediumTrendConfirmed !== false && signalContext?.mediumTrendConfirmed !== true) {
      gateFailures.push('medium_trend_not_confirmed');
    }
    if (patternConfig.allowMissingCriticalContext !== true && signalContext?.missingCriticalContext === true) {
      gateFailures.push('missing_critical_context');
    }
    if (patternConfig.allowWeakRelatedContext !== true && signalContext?.weakRelatedContext === true) {
      gateFailures.push('weak_related_context');
    }
    if (patternConfig.allowDegradedRelatedContext !== true && signalContext?.degradedRelatedContext === true) {
      gateFailures.push('degraded_related_context');
    }
    if (patternConfig.allowOverextendedContext !== true && signalContext?.overextendedMediumContext === true) {
      gateFailures.push('overextended_medium_context');
    }

    const fastRsi14 = Number(signalContext?.fastRsi14);
    const fastPriceVsSma20 = Number(signalContext?.fastPriceVsSma20);
    const fastEmaGap12_26 = Number(signalContext?.fastEmaGap12_26);
    const mediumEmaGap12_26 = Number(signalContext?.mediumEmaGap12_26);
    const relatedTrend = Number(signalContext?.relatedTrend);

    if (hasThreshold(patternConfig.minimumFastRsi) && !Number.isFinite(fastRsi14)) gateFailures.push('fast_rsi_missing');
    if (hasThreshold(patternConfig.minimumFastRsi) && fastRsi14 < Number(patternConfig.minimumFastRsi)) gateFailures.push('fast_rsi_too_low');
    if (hasThreshold(patternConfig.maximumFastRsi) && !Number.isFinite(fastRsi14)) gateFailures.push('fast_rsi_missing');
    if (hasThreshold(patternConfig.maximumFastRsi) && fastRsi14 > Number(patternConfig.maximumFastRsi)) gateFailures.push('fast_rsi_too_high');
    if (hasThreshold(patternConfig.minimumFastPriceVsSma) && !Number.isFinite(fastPriceVsSma20)) gateFailures.push('fast_price_vs_sma_missing');
    if (hasThreshold(patternConfig.minimumFastPriceVsSma) && fastPriceVsSma20 < Number(patternConfig.minimumFastPriceVsSma)) gateFailures.push('fast_price_vs_sma_too_low');
    if (hasThreshold(patternConfig.maximumFastPriceVsSma) && !Number.isFinite(fastPriceVsSma20)) gateFailures.push('fast_price_vs_sma_missing');
    if (hasThreshold(patternConfig.maximumFastPriceVsSma) && fastPriceVsSma20 > Number(patternConfig.maximumFastPriceVsSma)) gateFailures.push('fast_price_vs_sma_too_high');
    if (hasThreshold(patternConfig.minimumFastEmaGap) && !Number.isFinite(fastEmaGap12_26)) gateFailures.push('fast_ema_gap_missing');
    if (hasThreshold(patternConfig.minimumFastEmaGap) && fastEmaGap12_26 < Number(patternConfig.minimumFastEmaGap)) gateFailures.push('fast_ema_gap_too_low');
    if (hasThreshold(patternConfig.minimumMediumEmaGap) && !Number.isFinite(mediumEmaGap12_26)) gateFailures.push('medium_ema_gap_missing');
    if (hasThreshold(patternConfig.minimumMediumEmaGap) && mediumEmaGap12_26 < Number(patternConfig.minimumMediumEmaGap)) gateFailures.push('medium_ema_gap_too_low');
    if (hasThreshold(patternConfig.minimumRelatedTrend) && !Number.isFinite(relatedTrend)) gateFailures.push('related_trend_missing');
    if (hasThreshold(patternConfig.minimumRelatedTrend) && relatedTrend < Number(patternConfig.minimumRelatedTrend)) gateFailures.push('related_trend_too_low');
  }

  #analyzeBreakoutRetest({ shortBars, patternConfig }) {
    const bars = normalizeShortBars(shortBars);
    const minimumBars = Number(patternConfig.minimumShortBars ?? 16);
    if (bars.length < minimumBars) {
      return {
        matched: false,
        gateFailures: ['insufficient_short_bars'],
        signalContext: {
          shortBarCount: bars.length,
        },
      };
    }

    const lookbackBars = Math.max(minimumBars, Number(patternConfig.lookbackBars ?? 18));
    const breakoutWindowBars = Math.max(3, Number(patternConfig.breakoutWindowBars ?? 6));
    const analysisBars = bars.slice(-lookbackBars);
    const setupBars = analysisBars.slice(0, -breakoutWindowBars);
    const breakoutBars = analysisBars.slice(-breakoutWindowBars);
    if (!setupBars.length || breakoutBars.length < 2) {
      return {
        matched: false,
        gateFailures: ['insufficient_breakout_window'],
        signalContext: {
          shortBarCount: bars.length,
        },
      };
    }

    const referenceHigh = Math.max(...setupBars.map((bar) => bar.high));
    const minBreakoutPct = Number(patternConfig.minBreakoutPct ?? 0.0012);
    const breakoutIndex = breakoutBars.findIndex((bar) => bar.close >= referenceHigh * (1 + minBreakoutPct));
    if (breakoutIndex < 0) {
      return {
        matched: false,
        gateFailures: ['no_recent_breakout'],
        signalContext: {
          shortBarCount: bars.length,
          referenceHigh: toFiniteOrNull(referenceHigh),
        },
      };
    }

    const breakoutBar = breakoutBars[breakoutIndex];
    const postBreakoutBars = breakoutBars.slice(breakoutIndex + 1);
    if (!postBreakoutBars.length) {
      return {
        matched: false,
        gateFailures: ['breakout_not_yet_retested'],
        signalContext: {
          referenceHigh: toFiniteOrNull(referenceHigh),
          breakoutClose: toFiniteOrNull(breakoutBar.close),
        },
      };
    }

    const retestLow = Math.min(...postBreakoutBars.map((bar) => bar.low));
    const maxRetestDepthPct = Number(patternConfig.maxRetestDepthPct ?? 0.0035);
    const minRetestPullbackPct = Number(patternConfig.minRetestPullbackPct ?? 0.0004);
    const maxPostBreakoutStretchPct = Number(patternConfig.maxPostBreakoutStretchPct ?? 0.0045);
    const minRecoveryPct = Number(patternConfig.minRecoveryPct ?? 0.0004);
    const minRetestHoldPct = Number(patternConfig.minRetestHoldPct ?? 0);
    const latestBar = breakoutBars.at(-1);
    const previousBar = breakoutBars.at(-2) ?? latestBar;

    const retestDepthPct = referenceHigh > 0 ? (referenceHigh - retestLow) / referenceHigh : null;
    const pullbackFromBreakoutPct = breakoutBar.close > 0 ? (breakoutBar.close - retestLow) / breakoutBar.close : null;
    const stretchPct = breakoutBar.high > 0 ? (latestBar.close - breakoutBar.high) / breakoutBar.high : null;
    const recoveryPct = referenceHigh > 0 ? (latestBar.close - referenceHigh) / referenceHigh : null;

    const gateFailures = [];
    if (!Number.isFinite(retestDepthPct) || retestDepthPct > maxRetestDepthPct) gateFailures.push('retest_too_deep');
    if (!Number.isFinite(pullbackFromBreakoutPct) || pullbackFromBreakoutPct < minRetestPullbackPct) gateFailures.push('retest_too_shallow');
    if (!Number.isFinite(recoveryPct) || recoveryPct < minRetestHoldPct) gateFailures.push('retest_failed_to_hold_breakout');
    if (!Number.isFinite(stretchPct) || stretchPct > maxPostBreakoutStretchPct) gateFailures.push('post_breakout_too_stretched');
    if (!(latestBar.close > previousBar.close && (latestBar.close - previousBar.close) / Math.max(previousBar.close, 1) >= minRecoveryPct)) {
      gateFailures.push('recovery_not_confirmed');
    }

    return {
      matched: gateFailures.length === 0,
      gateFailures,
      signalContext: {
        breakoutReferenceHigh: toFiniteOrNull(referenceHigh),
        breakoutClose: toFiniteOrNull(breakoutBar.close),
        retestLow: toFiniteOrNull(retestLow),
        breakoutRetestDepthPct: toFiniteOrNull(retestDepthPct),
        breakoutRetestPullbackPct: toFiniteOrNull(pullbackFromBreakoutPct),
        breakoutRetestStretchPct: toFiniteOrNull(stretchPct),
        breakoutRetestRecoveryPct: toFiniteOrNull(recoveryPct),
        shortBarCount: bars.length,
      },
    };
  }

  #resolveRequestedSizePct({ heuristicRequestedSizePct, patternConfig }) {
    const raw = Number(heuristicRequestedSizePct);
    const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : Number(patternConfig.fallbackRequestedSizePct ?? 0.01);
    const scaled = safeRaw * Number(patternConfig.requestedSizeScale ?? 0.5);
    return clamp(scaled, Number(patternConfig.minRequestedSizePct ?? 0.005), Number(patternConfig.maxRequestedSizePct ?? 0.012));
  }

  #buildResult({
    matched,
    confidence,
    gateFailures,
    reasoning,
    heuristicDecision,
    requestedSizePct = null,
    patternName = 'trend_pullback_continuation',
    extraSignalContext = null,
  }) {
    return {
      matched: matched === true,
      confidence: toFiniteOrNull(confidence) ?? 0,
      requestedSizePct: toFiniteOrNull(requestedSizePct),
      reasoning: Array.isArray(reasoning) ? reasoning : [],
      gateFailures: Array.isArray(gateFailures) ? gateFailures : [],
      signalContext: {
        ...(heuristicDecision?.signalContext ?? {}),
        ...(extraSignalContext ?? {}),
        patternName,
        heuristicAction: heuristicDecision?.action ?? null,
        heuristicConfidence: toFiniteOrNull(heuristicDecision?.confidence),
      },
    };
  }
}
