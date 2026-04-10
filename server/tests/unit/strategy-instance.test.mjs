import assert from 'assert/strict';
import { StrategyInstance } from '../../src/core/strategy/StrategyInstance.mjs';
import { DecisionArbiter } from '../../src/core/strategy/DecisionArbiter.mjs';
import { RuntimeSessionStateStore } from '../../src/core/runtime/RuntimeSessionStateStore.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

class FakeConfigStore {
  getSymbolConfig() {
    return {
      strategy: 'llm_long_v1',
    };
  }

  getExecutionConfig() {
    return {
      openRejectionCooldownMs: 300_000,
      cryptoProfitLock: {
        enabled: true,
        minUnrealizedPnlPct: 0.018,
        fastRsiFloor: 74,
        fastEmaGapCeiling: 0,
        fastPriceVsSmaFloor: 0.001,
        mediumWeakMinUnrealizedPnlPct: 0.024,
        mediumRsiCeiling: 42,
        mediumPriceVsSmaCeiling: -0.004,
        mediumEmaGapCeiling: -0.0015,
        fastRsiCeiling: 68,
        fastEmaGapForMediumWeakExitCeiling: 0.001,
        peakActivationUnrealizedPnlPct: 0.028,
        peakGivebackAbsPct: 0.009,
        peakRetainRatioMax: 0.76,
        fastWeakRsiCeiling: 42,
        fastWeakPriceVsSmaCeiling: -0.001,
        fastWeakEmaGapCeiling: -0.0004,
      },
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

  test('StrategyInstance uses deterministic high-conviction entries without consulting the LLM', async () => {
    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'BTC/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
      decisionArbiter: new DecisionArbiter({
        deterministicEntryPolicy: {
          async evaluate() {
            return {
              action: 'open_long',
              confidence: 0.91,
              reasoning: ['deterministic_entry:trend_pullback_continuation'],
              requestedSizePct: 0.004,
              stopLossPct: 0.035,
              takeProfitPct: 0.065,
            };
          },
        },
        llmDecisionPolicy: {
          async evaluate() {
            decisionEngine.calls += 1;
            return {
              action: 'hold',
              confidence: 0.5,
              reasoning: ['llm_hold'],
            };
          },
        },
      }),
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'open_long');
    assert.equal(executionEngine.calls[0].decision.action, 'open_long');
  });

  test('StrategyInstance forces a preclose exit for stock positions without calling the LLM', async () => {
    class OpenPositionFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
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
        };
      }
    }

    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new OpenPositionFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'close_long');
    assert.deepEqual(result.decision.reasoning, ['forced_preclose_exit', 'pre_close']);
    assert.equal(executionEngine.calls[0].decision.action, 'close_long');
  });

  test('StrategyInstance keeps crypto positions out of the forced preclose exit path', async () => {
    class CryptoPositionFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'BTC/USD',
          assetClass: 'crypto',
          marketState: {
            isOpen: true,
            isPreClose: true,
            isNoTradeOpen: false,
            sessionLabel: 'continuous_open',
          },
          position: {
            symbol: 'BTC/USD',
            qty: 0.1,
            entryPrice: 80000,
          },
        };
      }
    }

    class HoldDecisionEngine {
      constructor() {
        this.calls = 0;
      }

      async decide() {
        this.calls += 1;
        return {
          action: 'hold',
          confidence: 0.6,
          reasoning: ['crypto_hold'],
          requestedSizePct: null,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const decisionEngine = new HoldDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'BTC/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new CryptoPositionFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 1);
    assert.equal(result.decision.action, 'hold');
    assert.equal(executionEngine.calls[0].decision.action, 'hold');
  });

  test('StrategyInstance forces a crypto profit-lock exit when gains are positive and fast momentum rolls over from overbought', async () => {
    class CryptoProfitLockFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'BTC/USD',
          assetClass: 'crypto',
          currentPrice: 103,
          marketState: {
            isOpen: true,
            isPreClose: false,
            isNoTradeOpen: false,
            sessionLabel: 'continuous_open',
          },
          position: {
            symbol: 'BTC/USD',
            qty: 0.1,
            entryPrice: 100,
            currentPrice: 103,
          },
          timeframes: {
            '5m': {
              values: {
                rsi14: 79,
                emaGap12_26: -0.001,
                priceVsSma20: 0.003,
              },
            },
          },
        };
      }
    }

    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'BTC/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new CryptoProfitLockFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'close_long');
    assert.deepEqual(result.decision.reasoning, ['crypto_profit_lock', 'fast_overbought_rollover']);
    assert.equal(executionEngine.calls[0].decision.action, 'close_long');
  });

  test('StrategyInstance does not force a crypto profit-lock exit when unrealized gain is too small', async () => {
    class SmallCryptoGainFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'BTC/USD',
          assetClass: 'crypto',
          currentPrice: 101,
          marketState: {
            isOpen: true,
            isPreClose: false,
            isNoTradeOpen: false,
            sessionLabel: 'continuous_open',
          },
          position: {
            symbol: 'BTC/USD',
            qty: 0.1,
            entryPrice: 100,
            currentPrice: 101,
          },
          timeframes: {
            '5m': {
              values: {
                rsi14: 79,
                emaGap12_26: -0.001,
                priceVsSma20: 0.003,
              },
            },
          },
        };
      }
    }

    class HoldDecisionEngine {
      constructor() {
        this.calls = 0;
      }

      async decide() {
        this.calls += 1;
        return {
          action: 'hold',
          confidence: 0.6,
          reasoning: ['crypto_hold'],
          requestedSizePct: null,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const decisionEngine = new HoldDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'BTC/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new SmallCryptoGainFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 1);
    assert.equal(result.decision.action, 'hold');
    assert.equal(executionEngine.calls[0].decision.action, 'hold');
  });

  test('StrategyInstance forces a crypto profit-lock exit when medium trend fades while the position is still nicely profitable', async () => {
    class MediumFadeCryptoFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'ETH/USD',
          assetClass: 'crypto',
          currentPrice: 103,
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
            currentPrice: 103,
          },
          timeframes: {
            '5m': {
              values: {
                rsi14: 58,
                emaGap12_26: 0.0002,
                priceVsSma20: 0.0004,
              },
            },
            '1h': {
              values: {
                rsi14: 38,
                emaGap12_26: -0.002,
                priceVsSma20: -0.006,
              },
            },
          },
        };
      }
    }

    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'ETH/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new MediumFadeCryptoFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'close_long');
    assert.deepEqual(result.decision.reasoning, ['crypto_profit_lock', 'medium_trend_fade']);
    assert.equal(executionEngine.calls[0].decision.action, 'close_long');
  });

  test('StrategyInstance keeps a profitable crypto position open when the medium trend remains healthy', async () => {
    class HealthyMediumCryptoFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'ETH/USD',
          assetClass: 'crypto',
          currentPrice: 103,
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
            currentPrice: 103,
          },
          timeframes: {
            '5m': {
              values: {
                rsi14: 58,
                emaGap12_26: 0.0002,
                priceVsSma20: 0.0004,
              },
            },
            '1h': {
              values: {
                rsi14: 49,
                emaGap12_26: 0.0012,
                priceVsSma20: 0.002,
              },
            },
          },
        };
      }
    }

    class HoldDecisionEngine {
      constructor() {
        this.calls = 0;
      }

      async decide() {
        this.calls += 1;
        return {
          action: 'hold',
          confidence: 0.65,
          reasoning: ['crypto_hold'],
          requestedSizePct: null,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const decisionEngine = new HoldDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'ETH/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new HealthyMediumCryptoFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
    });

    const result = await strategy.runOnce(Date.now());

    assert.equal(decisionEngine.calls, 1);
    assert.equal(result.decision.action, 'hold');
    assert.equal(executionEngine.calls[0].decision.action, 'hold');
  });

  test('StrategyInstance forces a crypto profit-lock exit after a meaningful giveback from the session peak', async () => {
    class PeakGivebackCryptoFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
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
        };
      }
    }

    const rootDir = makeTempDir();
    const runtimeSessionStateStore = new RuntimeSessionStateStore({
      runsDir: `${rootDir}/runs`,
      timezone: 'America/New_York',
    });
    runtimeSessionStateStore.updateSymbolState('ETH/USD', 1_000_000, {
      cryptoPeakUnrealizedPnlPct: 0.043,
      cryptoPeakObservedAtMs: 990_000,
    });

    const decisionEngine = new FakeDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'ETH/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new PeakGivebackCryptoFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
      runtimeSessionStateStore,
    });

    const result = await strategy.runOnce(1_000_000);

    assert.equal(decisionEngine.calls, 0);
    assert.equal(result.decision.action, 'close_long');
    assert.deepEqual(result.decision.reasoning, ['crypto_profit_lock', 'peak_giveback_lock']);
    assert.equal(executionEngine.calls[0].decision.action, 'close_long');
  });

  test('StrategyInstance keeps a crypto position open when the giveback from peak stays modest', async () => {
    class SmallGivebackCryptoFeatureSnapshotService extends FakeFeatureSnapshotService {
      async build(payload) {
        const snapshot = await super.build(payload);
        return {
          ...snapshot,
          symbol: 'ETH/USD',
          assetClass: 'crypto',
          currentPrice: 103.8,
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
            currentPrice: 103.8,
          },
          timeframes: {
            '5m': {
              values: {
                rsi14: 37,
                emaGap12_26: -0.0009,
                priceVsSma20: -0.0015,
              },
            },
            '1h': {
              values: {
                rsi14: 47,
                emaGap12_26: 0.0008,
                priceVsSma20: -0.0002,
              },
            },
          },
        };
      }
    }

    class HoldDecisionEngine {
      constructor() {
        this.calls = 0;
      }

      async decide() {
        this.calls += 1;
        return {
          action: 'hold',
          confidence: 0.65,
          reasoning: ['crypto_hold'],
          requestedSizePct: null,
          stopLossPct: null,
          takeProfitPct: null,
        };
      }
    }

    const rootDir = makeTempDir();
    const runtimeSessionStateStore = new RuntimeSessionStateStore({
      runsDir: `${rootDir}/runs`,
      timezone: 'America/New_York',
    });
    runtimeSessionStateStore.updateSymbolState('ETH/USD', 1_000_000, {
      cryptoPeakUnrealizedPnlPct: 0.043,
      cryptoPeakObservedAtMs: 990_000,
    });

    const decisionEngine = new HoldDecisionEngine();
    const executionEngine = new FakeExecutionEngine();
    const strategy = new StrategyInstance({
      symbol: 'ETH/USD',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new SmallGivebackCryptoFeatureSnapshotService(),
      decisionEngine,
      executionEngine,
      runtimeSessionStateStore,
    });

    const result = await strategy.runOnce(1_000_000);

    assert.equal(decisionEngine.calls, 1);
    assert.equal(result.decision.action, 'hold');
    assert.equal(executionEngine.calls[0].decision.action, 'hold');
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

  test('StrategyInstance restores the open rejection cooldown after a restart from the runtime session store', async () => {
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

    const rootDir = makeTempDir();
    const runtimeSessionStateStore = new RuntimeSessionStateStore({
      runsDir: `${rootDir}/runs`,
      timezone: 'America/New_York',
    });

    const firstExecutionEngine = new RejectingOpenExecutionEngine();
    const firstStrategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine: new OpenDecisionEngine(),
      executionEngine: firstExecutionEngine,
      runtimeSessionStateStore,
    });

    await firstStrategy.runOnce(1_000_000);

    const secondExecutionEngine = new RejectingOpenExecutionEngine();
    const restartedStrategy = new StrategyInstance({
      symbol: 'AAPL',
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      featureSnapshotService: new FakeFeatureSnapshotService(),
      decisionEngine: new OpenDecisionEngine(),
      executionEngine: secondExecutionEngine,
      runtimeSessionStateStore: new RuntimeSessionStateStore({
        runsDir: `${rootDir}/runs`,
        timezone: 'America/New_York',
      }),
    });

    const secondResult = await restartedStrategy.runOnce(1_060_000);

    assert.equal(secondResult.decision.action, 'skip');
    assert.equal(secondResult.decision.reasoning[0], 'open_rejection_cooldown:validation');
    assert.equal(secondExecutionEngine.calls[0].decision.action, 'skip');
  });
};
