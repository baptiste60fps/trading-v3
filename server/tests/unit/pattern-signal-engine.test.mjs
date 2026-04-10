import assert from 'assert/strict';
import { PatternSignalEngine } from '../../src/core/strategy/PatternSignalEngine.mjs';

export const register = async ({ test }) => {
  test('PatternSignalEngine matches a high-conviction trend pullback continuation setup', async () => {
    const engine = new PatternSignalEngine();
    engine.ruleEngine = {
      async decide() {
        return {
          action: 'open_long',
          confidence: 0.82,
          requestedSizePct: 0.012,
          reasoning: ['signal_score_9', 'context_confirmed'],
          signalContext: {
            entrySignalScore: 9,
            contextScore: 4,
            mediumTrendConfirmed: true,
            missingCriticalContext: false,
            weakRelatedContext: false,
            degradedRelatedContext: false,
            overextendedMediumContext: false,
            fastRsi14: 52,
            fastPriceVsSma20: -0.0003,
            fastEmaGap12_26: 0.0008,
            mediumEmaGap12_26: 0.0025,
            relatedTrend: -0.001,
          },
        };
      },
    };

    const result = await engine.evaluateTrendPullbackContinuation({
      symbol: 'BTC/USD',
      patternConfig: {
        minimumSignalScore: 9,
        minimumContextScore: 4,
        minimumFastRsi: 46,
        maximumFastRsi: 58,
        minimumFastPriceVsSma: -0.0015,
        maximumFastPriceVsSma: 0.001,
        minimumFastEmaGap: 0.0003,
        minimumMediumEmaGap: 0.001,
        minimumRelatedTrend: -0.002,
        requestedSizeScale: 0.4,
        minRequestedSizePct: 0.002,
        maxRequestedSizePct: 0.006,
      },
    });

    assert.equal(result.matched, true);
    assert.equal(result.signalContext.patternName, 'trend_pullback_continuation');
    assert.ok(result.requestedSizePct <= 0.006);
    assert.ok(result.confidence >= 0.82);
  });

  test('PatternSignalEngine rejects a setup when a required metric is missing', async () => {
    const engine = new PatternSignalEngine();
    engine.ruleEngine = {
      async decide() {
        return {
          action: 'open_long',
          confidence: 0.8,
          requestedSizePct: 0.01,
          reasoning: ['signal_score_9'],
          signalContext: {
            entrySignalScore: 9,
            contextScore: 4,
            mediumTrendConfirmed: true,
            missingCriticalContext: false,
            weakRelatedContext: false,
            degradedRelatedContext: false,
            overextendedMediumContext: false,
            fastPriceVsSma20: 0,
            fastEmaGap12_26: 0.0008,
            mediumEmaGap12_26: 0.0025,
            relatedTrend: 0,
          },
        };
      },
    };

    const result = await engine.evaluateTrendPullbackContinuation({
      symbol: 'BTC/USD',
      patternConfig: {
        minimumFastRsi: 46,
      },
    });

    assert.equal(result.matched, false);
    assert.ok(result.gateFailures.includes('fast_rsi_missing'));
  });

  test('PatternSignalEngine matches a disciplined breakout re-test setup', async () => {
    const engine = new PatternSignalEngine();
    engine.ruleEngine = {
      async decide() {
        return {
          action: 'open_long',
          confidence: 0.81,
          requestedSizePct: 0.01,
          reasoning: ['signal_score_8', 'context_confirmed'],
          signalContext: {
            entrySignalScore: 8,
            contextScore: 4,
            mediumTrendConfirmed: true,
            missingCriticalContext: false,
            weakRelatedContext: false,
            degradedRelatedContext: false,
            overextendedMediumContext: false,
            fastRsi14: 55,
            fastPriceVsSma20: 0.0007,
            fastEmaGap12_26: 0.0007,
            mediumEmaGap12_26: 0.002,
            relatedTrend: -0.001,
          },
        };
      },
    };

    const shortBars = [
      { high: 100.0, low: 99.7, close: 99.9 },
      { high: 100.1, low: 99.8, close: 100.0 },
      { high: 100.0, low: 99.75, close: 99.95 },
      { high: 100.15, low: 99.82, close: 100.05 },
      { high: 100.2, low: 99.9, close: 100.12 },
      { high: 100.18, low: 99.95, close: 100.1 },
      { high: 100.22, low: 100.0, close: 100.16 },
      { high: 100.25, low: 100.05, close: 100.2 },
      { high: 100.28, low: 100.08, close: 100.18 },
      { high: 100.3, low: 100.1, close: 100.24 },
      { high: 100.34, low: 100.12, close: 100.26 },
      { high: 100.36, low: 100.18, close: 100.31 },
      { high: 100.55, low: 100.26, close: 100.5 },
      { high: 100.52, low: 100.3, close: 100.37 },
      { high: 100.49, low: 100.28, close: 100.34 },
      { high: 100.58, low: 100.33, close: 100.53 },
    ];

    const result = await engine.evaluateBreakoutRetest({
      symbol: 'ETH/USD',
      features: { shortBars },
      patternConfig: {
        enabled: true,
        minimumSignalScore: 8,
        minimumContextScore: 4,
        minimumFastRsi: 49,
        maximumFastRsi: 61,
        minimumFastPriceVsSma: -0.0008,
        maximumFastPriceVsSma: 0.002,
        minimumFastEmaGap: 0.0002,
        minimumMediumEmaGap: 0.0012,
        minimumRelatedTrend: -0.002,
      },
    });

    assert.equal(result.matched, true);
    assert.equal(result.signalContext.patternName, 'breakout_retest');
    assert.ok(result.signalContext.breakoutReferenceHigh > 100);
  });
};
