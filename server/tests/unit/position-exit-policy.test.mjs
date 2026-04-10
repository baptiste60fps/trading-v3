import assert from 'assert/strict';
import { PositionExitPolicy } from '../../src/core/strategy/PositionExitPolicy.mjs';

export const register = async ({ test }) => {
  test('PositionExitPolicy forces a stock preclose exit', async () => {
    const policy = new PositionExitPolicy();

    const decision = await policy.evaluate({
      symbol: 'AAPL',
      features: {
        symbol: 'AAPL',
        assetClass: 'stock',
        marketState: {
          isOpen: true,
          isPreClose: true,
          isNoTradeOpen: false,
          sessionLabel: 'pre_close',
        },
        position: {
          symbol: 'AAPL',
          qty: 5,
          entryPrice: 150,
        },
      },
      executionConfig: {},
      symbolState: {},
    });

    assert.equal(decision.action, 'close_long');
    assert.deepEqual(decision.reasoning, ['forced_preclose_exit', 'pre_close']);
    assert.equal(decision.signalContext.decisionSource, undefined);
  });

  test('PositionExitPolicy forces a crypto giveback exit when a profitable peak degrades enough', async () => {
    const policy = new PositionExitPolicy();

    const decision = await policy.evaluate({
      symbol: 'ETH/USD',
      features: {
        symbol: 'ETH/USD',
        assetClass: 'crypto',
        currentPrice: 102.9,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
          sessionLabel: 'continuous_open',
        },
        position: {
          symbol: 'ETH/USD',
          qty: 0.5,
          entryPrice: 100,
          currentPrice: 102.9,
        },
        timeframes: {
          '5m': {
            values: {
              rsi14: 34,
              emaGap12_26: -0.0008,
              priceVsSma20: -0.0018,
            },
          },
          '1h': {
            values: {
              rsi14: 45,
              emaGap12_26: 0.0003,
              priceVsSma20: -0.0006,
            },
          },
        },
      },
      executionConfig: {
        cryptoProfitLock: {
          enabled: true,
          minUnrealizedPnlPct: 0.018,
          peakActivationUnrealizedPnlPct: 0.028,
          peakGivebackAbsPct: 0.009,
          peakRetainRatioMax: 0.76,
          fastWeakRsiCeiling: 42,
          fastWeakPriceVsSmaCeiling: -0.001,
          fastWeakEmaGapCeiling: -0.0004,
          mediumRsiCeiling: 42,
          mediumPriceVsSmaCeiling: -0.004,
          mediumEmaGapCeiling: -0.0015,
        },
      },
      symbolState: {
        cryptoPeakUnrealizedPnlPct: 0.043,
      },
    });

    assert.equal(decision.action, 'close_long');
    assert.deepEqual(decision.reasoning, ['crypto_profit_lock', 'peak_giveback_lock']);
    assert.equal(decision.signalContext.peakUnrealizedPnlPct, 0.043);
  });
};
