import assert from 'assert/strict';
import { DecisionEngine } from '../../src/core/llm/DecisionEngine.mjs';

class FakeDecisionModelClient {
  constructor(response) {
    this.response = response;
  }

  async generateDecision() {
    return this.response;
  }
}

const featureSnapshot = {
  symbol: 'AAPL',
  atMs: Date.now(),
  currentPrice: 150,
  marketState: {
    isOpen: true,
    isPreClose: false,
    isNoTradeOpen: false,
    sessionLabel: 'regular_open',
  },
  portfolioState: {
    cash: 10_000,
    equity: 10_000,
    exposurePct: 0.1,
  },
  position: null,
  riskState: {
    canOpen: true,
    canClose: true,
    flags: [],
  },
  timeframes: {
    '1h': {
      values: {
        lastClose: 150,
        rsi14: 58,
      },
    },
  },
  relatedSymbols: [],
};

export const register = async ({ test }) => {
  test('DecisionEngine normalizes strict JSON responses', async () => {
    const engine = new DecisionEngine({
      modelClient: new FakeDecisionModelClient(
        JSON.stringify({
          action: 'open_long',
          confidence: 0.81,
          reasoning: ['trend is aligned', 'risk is acceptable'],
          requestedSizePct: 0.07,
          stopLossPct: 0.02,
          takeProfitPct: 0.05,
        }),
      ),
      llmConfig: {
        model: 'llama3.1:8b',
      },
    });

    const decision = await engine.decide({
      symbol: 'AAPL',
      features: featureSnapshot,
      strategyConfig: {
        risk: { maxPositionPct: 0.1 },
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.confidence, 0.81);
    assert.deepEqual(decision.reasoning, ['trend is aligned', 'risk is acceptable']);
    assert.equal(decision.requestedSizePct, 0.07);
  });

  test('DecisionEngine falls back safely on invalid responses', async () => {
    const engine = new DecisionEngine({
      modelClient: new FakeDecisionModelClient('not-json'),
    });

    const decision = await engine.decide({
      symbol: 'AAPL',
      features: featureSnapshot,
      strategyConfig: {},
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.confidence, 0);
    assert.ok(decision.reasoning[0].startsWith('decision_engine_fallback:'));
  });
};
