import assert from 'assert/strict';
import { HeuristicEntryPolicy } from '../../src/core/strategy/HeuristicEntryPolicy.mjs';

const buildBaseFeatures = () => ({
  currentPrice: 100,
  marketState: {
    isOpen: true,
    isPreClose: false,
    isNoTradeOpen: false,
  },
  position: null,
  timeframes: {
    '5m': {
      values: {
        emaGap12_26: 0.0008,
        priceVsSma20: 0.0008,
        rsi14: 55,
        atrPct14: 0.01,
      },
    },
    '1h': {
      values: {
        emaGap12_26: 0.005,
        rsi14: 75,
      },
    },
  },
  relatedSymbols: [
    { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
    { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
  ],
});

export const register = async ({ test }) => {
  test('HeuristicEntryPolicy blocks overheated LLM opens that fail the quality profile gate', async () => {
    const policy = new HeuristicEntryPolicy();
    const reviewed = await policy.review({
      symbol: 'AAPL',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
      },
      features: buildBaseFeatures(),
      modelDecision: {
        action: 'open_long',
        confidence: 0.78,
        reasoning: ['llm_open'],
        requestedSizePct: 0.05,
        stopLossPct: null,
        takeProfitPct: null,
      },
    });

    assert.equal(reviewed.action, 'skip');
    assert.equal(reviewed.reasoning[0], 'entry_policy_block:primary_context_overheated');
    assert.equal(reviewed.signalContext.entryPolicy, 'heuristic_guard_v1');
    assert.equal(reviewed.signalContext.heuristicAction, 'skip');
  });

  test('HeuristicEntryPolicy clamps LLM size to the heuristic size on a valid quality setup', async () => {
    const policy = new HeuristicEntryPolicy();
    const reviewed = await policy.review({
      symbol: 'AAPL',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0008,
              priceVsSma20: 0.0006,
              rsi14: 54,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.004,
              rsi14: 68,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
        ],
      },
      modelDecision: {
        action: 'open_long',
        confidence: 0.74,
        reasoning: ['llm_open'],
        requestedSizePct: 0.05,
        stopLossPct: null,
        takeProfitPct: null,
      },
    });

    assert.equal(reviewed.action, 'open_long');
    assert.ok(reviewed.requestedSizePct <= 0.04);
    assert.equal(reviewed.signalContext.entryPolicy, 'heuristic_guard_v1');
    assert.equal(reviewed.signalContext.heuristicAction, 'open_long');
  });
};
