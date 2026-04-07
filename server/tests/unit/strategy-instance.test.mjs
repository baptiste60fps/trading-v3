import assert from 'assert/strict';
import { StrategyInstance } from '../../src/core/strategy/StrategyInstance.mjs';

class FakeConfigStore {
  getSymbolConfig() {
    return {
      strategy: 'llm_long_v1',
    };
  }
}

class FakeFeatureSnapshotService {
  constructor() {
    this.calls = 0;
  }

  async build({ symbol, atMs, runtimeMode }) {
    this.calls += 1;
    return {
      symbol,
      atMs,
      runtimeMode,
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
      shortBars: [],
      timeframes: {},
      relatedSymbols: [],
    };
  }
}

class FakeDecisionEngine {
  constructor() {
    this.calls = 0;
  }

  async decide() {
    this.calls += 1;
    return {
      action: 'skip',
      confidence: 0.1,
      reasoning: ['test'],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
    };
  }
}

class FakeExecutionEngine {
  constructor() {
    this.calls = [];
  }

  async executeDecision() {
    this.calls.push(arguments[0]);
    return {
      executionIntent: null,
      executionResult: {
        accepted: false,
        brokerOrderId: null,
        filledQty: null,
        avgFillPrice: null,
        status: 'noop',
        error: null,
      },
    };
  }
}

export const register = async ({ test }) => {
  test('StrategyInstance warms up then evaluates once', async () => {
    const featureSnapshotService = new FakeFeatureSnapshotService();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService,
      decisionEngine: new FakeDecisionEngine(),
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());
    const state = strategy.getState();

    assert.equal(featureSnapshotService.calls, 2);
    assert.equal(result.decision.action, 'skip');
    assert.equal(state.symbol, 'AAPL');
    assert.equal(state.warmedUp, true);
    assert.ok(state.lastEvaluationMs);
  });

  test('StrategyInstance forwards evaluation data to the console logger when present', async () => {
    const logs = [];
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine: new FakeDecisionEngine(),
      executionEngine: new FakeExecutionEngine(),
      consoleLogger: {
        logEvaluation(payload) {
          logs.push(payload);
        },
      },
    });

    await strategy.runOnce(Date.now());

    assert.equal(logs.length, 1);
    assert.equal(logs[0].symbol, 'AAPL');
    assert.equal(logs[0].decision.action, 'skip');
    assert.equal(logs[0].executionResult.status, 'noop');
  });

  test('StrategyInstance forwards the model decision unchanged to execution', async () => {
    class HoldDecisionEngine {
      async decide() {
        return {
          action: 'hold',
          confidence: 0.6,
          reasoning: ['llm_hold'],
          requestedSizePct: null,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const featureSnapshotService = new FakeFeatureSnapshotService();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService,
      decisionEngine: new HoldDecisionEngine(),
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(result.decision.action, 'hold');
    assert.equal(executionEngine.calls[0].decision.action, 'hold');
    assert.equal(result.fallbackExit, null);
  });

  test('StrategyInstance bypasses the LLM opening decision when the equity market is closed and no position is open', async () => {
    class ClosedFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          marketState: {
            isOpen: false,
            isPreClose: false,
            isNoTradeOpen: false,
            sessionLabel: 'market_closed',
          },
        };
      }
    }

    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new ClosedFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'skip');
    assert.deepEqual(result.decision.reasoning, ['market_gate', 'market_closed']);
    assert.equal(executionEngine.calls[0].decision.action, 'skip');
  });
};
