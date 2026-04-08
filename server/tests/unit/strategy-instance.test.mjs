import assert from 'assert/strict';
import { StrategyInstance } from '../../src/core/strategy/StrategyInstance.mjs';

class FakeConfigStore {
  getSymbolConfig() {
    return {
      strategy: 'llm_long_v1',
    };
  }

  getExecutionConfig() {
    return {
      openRejectionCooldownMs: 300_000,
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

class RejectingOpenExecutionEngine extends FakeExecutionEngine {
  async executeDecision(payload) {
    this.calls.push(payload);
    return {
      executionIntent: payload?.decision?.action === 'open_long'
        ? {
            symbol: payload.symbol,
            action: 'open_long',
          }
        : null,
      executionResult: payload?.decision?.action === 'open_long'
        ? {
            accepted: false,
            brokerOrderId: null,
            filledQty: null,
            avgFillPrice: null,
            status: 'rejected',
            error: {
              category: 'validation',
              message: 'fractional orders must be DAY orders',
            },
          }
        : {
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

  test('StrategyInstance lets an entry policy downgrade an LLM open into a skip', async () => {
    class OpenDecisionEngine {
      async decide() {
        return {
          action: 'open_long',
          confidence: 0.8,
          reasoning: ['llm_open'],
          requestedSizePct: 0.05,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine: new OpenDecisionEngine(),
      executionEngine,
      entryPolicy: {
        async review({ modelDecision }) {
          return {
            ...modelDecision,
            action: 'skip',
            reasoning: ['entry_policy_block:test_gate'],
            requestedSizePct: null,
          };
        },
      },
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(result.decision.action, 'skip');
    assert.equal(result.decision.reasoning[0], 'entry_policy_block:test_gate');
    assert.equal(executionEngine.calls[0].decision.action, 'skip');
  });

  test('StrategyInstance applies an open rejection cooldown after a rejected broker open', async () => {
    class OpenDecisionEngine {
      async decide() {
        return {
          action: 'open_long',
          confidence: 0.8,
          reasoning: ['llm_open'],
          requestedSizePct: 0.05,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const executionEngine = new RejectingOpenExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine: new OpenDecisionEngine(),
      executionEngine,
    });

    const firstResult = await strategy.runOnce(1_000_000);
    const secondResult = await strategy.runOnce(1_060_000);

    assert.equal(firstResult.executionResult.status, 'rejected');
    assert.equal(secondResult.decision.action, 'skip');
    assert.equal(secondResult.decision.reasoning[0], 'open_rejection_cooldown:validation');
    assert.equal(executionEngine.calls[1].decision.action, 'skip');
  });
};
