import assert from 'assert/strict';
import { DeterministicEntryPolicy } from '../../src/core/strategy/DeterministicEntryPolicy.mjs';

const buildFeatures = (assetClass = 'crypto') => ({
  assetClass,
  position: null,
  marketState: {
    isOpen: true,
    isPreClose: false,
    isNoTradeOpen: false,
    sessionLabel: assetClass === 'crypto' ? 'continuous_open' : 'regular_open',
  },
});

export const register = async ({ test }) => {
  test('DeterministicEntryPolicy builds an open_long decision from a matched pattern', async () => {
    const policy = new DeterministicEntryPolicy({
      enabled: true,
      patternSignalEngine: {
        async evaluateTrendPullbackContinuation() {
          return {
            matched: true,
            confidence: 0.91,
            requestedSizePct: 0.0042,
            reasoning: ['trend_pullback_continuation', 'signal_score_9'],
            signalContext: {
              patternName: 'trend_pullback_continuation',
              entrySignalScore: 9,
            },
          };
        },
      },
    });

    const decision = await policy.evaluate({
      symbol: 'BTC/USD',
      features: buildFeatures(),
      executionConfig: {
        deterministicEntry: {
          enabled: true,
          allowedSymbols: ['BTC/USD', 'ETH/USD'],
          allowedAssetClasses: ['crypto'],
          patterns: {
            trendPullbackContinuation: {},
          },
        },
      },
      strategyConfig: {
        assetClass: 'crypto',
        strategyRules: {
          stopLossPct: 0.035,
          takeProfitPct: 0.065,
        },
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.reasoning[0], 'deterministic_entry:trend_pullback_continuation');
    assert.equal(decision.stopLossPct, 0.035);
    assert.equal(decision.takeProfitPct, 0.065);
    assert.equal(decision.signalContext.bypassedLlm, true);
  });

  test('DeterministicEntryPolicy stays inactive outside its allowed universe', async () => {
    const policy = new DeterministicEntryPolicy({
      enabled: true,
      patternSignalEngine: {
        async evaluateTrendPullbackContinuation() {
          throw new Error('should_not_run');
        },
      },
    });

    const decision = await policy.evaluate({
      symbol: 'AAPL',
      features: buildFeatures('stock'),
      executionConfig: {
        deterministicEntry: {
          enabled: true,
          allowedSymbols: ['BTC/USD'],
          allowedAssetClasses: ['crypto'],
          patterns: {
            trendPullbackContinuation: {},
          },
        },
      },
      strategyConfig: {
        assetClass: 'stock',
      },
    });

    assert.equal(decision, null);
  });

  test('DeterministicEntryPolicy picks the strongest matched pattern', async () => {
    const policy = new DeterministicEntryPolicy({
      enabled: true,
      patternSignalEngine: {
        async evaluateTrendPullbackContinuation() {
          return {
            matched: true,
            confidence: 0.86,
            requestedSizePct: 0.004,
            reasoning: ['trend_pullback_continuation'],
            signalContext: {
              patternName: 'trend_pullback_continuation',
            },
          };
        },
        async evaluateBreakoutRetest() {
          return {
            matched: true,
            confidence: 0.92,
            requestedSizePct: 0.003,
            reasoning: ['breakout_retest'],
            signalContext: {
              patternName: 'breakout_retest',
            },
          };
        },
      },
    });

    const decision = await policy.evaluate({
      symbol: 'ETH/USD',
      features: buildFeatures(),
      executionConfig: {
        deterministicEntry: {
          enabled: true,
          allowedSymbols: ['ETH/USD'],
          allowedAssetClasses: ['crypto'],
          patterns: {
            trendPullbackContinuation: {
              enabled: true,
            },
            breakoutRetest: {
              enabled: true,
            },
          },
        },
      },
      strategyConfig: {
        assetClass: 'crypto',
      },
    });

    assert.equal(decision.signalContext.deterministicPattern, 'breakout_retest');
    assert.ok(decision.signalContext.deterministicMatchedPatterns.includes('trend_pullback_continuation'));
    assert.ok(decision.signalContext.deterministicMatchedPatterns.includes('breakout_retest'));
  });
};
