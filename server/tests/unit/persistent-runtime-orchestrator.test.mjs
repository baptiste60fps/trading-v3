import assert from 'assert/strict';
import { PersistentRuntimeOrchestrator } from '../../src/core/runtime/PersistentRuntimeOrchestrator.mjs';

class FakeConfigStore {
  constructor({ symbols = ['AAPL', 'MSFT'], runtime = {} } = {}) {
    this.symbols = symbols;
    this.runtime = runtime;
  }

  getEnabledSymbols() {
    return this.symbols.slice();
  }

  getRuntimeConfig() {
    return {
      symbols: null,
      loopIntervalMs: 60_000,
      idleIntervalMs: 300_000,
      startupWarmup: true,
      ...this.runtime,
    };
  }
}

class FakeStrategy {
  constructor(symbol, { shouldFail = false, warmupRateLimitCount = 0, runRateLimitCount = 0 } = {}) {
    this.symbol = symbol;
    this.shouldFail = shouldFail;
    this.warmupRateLimitCount = warmupRateLimitCount;
    this.runRateLimitCount = runRateLimitCount;
    this.warmupCalls = [];
    this.runCalls = [];
  }

  async warmup(atMs) {
    this.warmupCalls.push(atMs);
    if (this.warmupRateLimitCount > 0) {
      this.warmupRateLimitCount -= 1;
      const error = new Error('too many requests');
      error.category = 'rate_limit';
      error.statusCode = 429;
      throw error;
    }
  }

  async runOnce(atMs) {
    this.runCalls.push(atMs);
    if (this.runRateLimitCount > 0) {
      this.runRateLimitCount -= 1;
      const error = new Error('too many requests');
      error.category = 'rate_limit';
      error.statusCode = 429;
      throw error;
    }
    if (this.shouldFail) throw new Error(`${this.symbol}_failed`);

    return {
      features: {
        symbol: this.symbol,
        currentPrice: 100,
        marketState: {
          sessionLabel: 'regular_open',
        },
      },
      decision: {
        action: 'hold',
      },
      executionResult: {
        status: 'noop',
      },
    };
  }
}

const makeScheduler = () => {
  const scheduled = [];
  const cleared = [];

  return {
    scheduled,
    cleared,
    setTimeout(fn, delay) {
      const token = { fn, delay };
      scheduled.push(token);
      return token;
    },
    clearTimeout(token) {
      cleared.push(token);
    },
  };
};

export const register = async ({ test }) => {
  test('PersistentRuntimeOrchestrator warms up enabled symbols, runs a startup cycle and schedules the next open-market pass', async () => {
    const strategies = new Map();
    const scheduler = makeScheduler();
    const logs = [];
    const orchestrator = new PersistentRuntimeOrchestrator({
      runtimeMode: 'paper',
      configStore: new FakeConfigStore(),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: true,
            sessionLabel: 'regular_open',
          };
        },
      },
      strategyFactory(symbol) {
        const strategy = new FakeStrategy(symbol);
        strategies.set(symbol, strategy);
        return strategy;
      },
      scheduler,
      now: (() => {
        let tick = 1_700_000_000_000;
        return () => {
          tick += 1_000;
          return tick;
        };
      })(),
      logger: {
        info(message) {
          logs.push(message);
        },
        error(message) {
          logs.push(message);
        },
      },
    });

    await orchestrator.start();
    const state = orchestrator.getState();

    assert.equal(state.cycleCount, 1);
    assert.deepEqual(state.symbols, ['AAPL', 'MSFT']);
    assert.equal(strategies.get('AAPL').warmupCalls.length, 1);
    assert.equal(strategies.get('MSFT').warmupCalls.length, 1);
    assert.equal(strategies.get('AAPL').runCalls.length, 1);
    assert.equal(strategies.get('MSFT').runCalls.length, 1);
    assert.equal(state.lastScheduleDelayMs, 60_000);
    assert.equal(scheduler.scheduled.length, 1);
    assert.ok(logs.some((entry) => entry.includes('Starting paper orchestrator')));

    await orchestrator.stop('unit_test_done');
    const stoppedState = await orchestrator.waitUntilStopped();
    assert.equal(stoppedState.stopReason, 'unit_test_done');
    assert.equal(stoppedState.status, 'stopped');
  });

  test('PersistentRuntimeOrchestrator keeps running remaining symbols after one strategy fails and uses idle scheduling when the market is closed', async () => {
    const scheduler = makeScheduler();
    const orchestrator = new PersistentRuntimeOrchestrator({
      runtimeMode: 'live',
      configStore: new FakeConfigStore({ symbols: ['AAPL', 'NVDA'] }),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: false,
            sessionLabel: 'after_close',
          };
        },
      },
      strategyFactory(symbol) {
        return new FakeStrategy(symbol, { shouldFail: symbol === 'AAPL' });
      },
      scheduler,
      now: (() => {
        let tick = 1_800_000_000_000;
        return () => {
          tick += 500;
          return tick;
        };
      })(),
      logger: {
        info() {},
        error() {},
      },
    });

    await orchestrator.start();
    assert.equal(orchestrator.getState().lastResults.length, 2);
    assert.equal(orchestrator.getState().lastResults[0].ok, false);
    assert.equal(orchestrator.getState().lastResults[1].ok, true);
    assert.equal(orchestrator.getState().lastScheduleDelayMs, 300_000);
    assert.equal(scheduler.scheduled.length, 1);

    await scheduler.scheduled[0].fn();
    assert.equal(orchestrator.getState().cycleCount, 2);

    await orchestrator.stop('unit_test_stop');
    assert.ok(scheduler.cleared.length >= 1);
  });

  test('PersistentRuntimeOrchestrator pauses 30 seconds and retries until warmup succeeds after rate limiting', async () => {
    const strategy = new FakeStrategy('SPY', { warmupRateLimitCount: 2 });
    const sleepCalls = [];
    const orchestrator = new PersistentRuntimeOrchestrator({
      runtimeMode: 'paper',
      configStore: new FakeConfigStore({ symbols: ['SPY'] }),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: true,
            sessionLabel: 'regular_open',
          };
        },
      },
      strategyFactory() {
        return strategy;
      },
      sleep(delayMs) {
        sleepCalls.push(delayMs);
        return Promise.resolve();
      },
      logger: {
        info() {},
        error() {},
      },
    });

    await orchestrator.start();

    assert.equal(strategy.warmupCalls.length, 3);
    assert.deepEqual(sleepCalls, [30_000, 30_000]);

    await orchestrator.stop('unit_test_stop');
  });

  test('PersistentRuntimeOrchestrator pauses 30 seconds and retries until cycle execution succeeds after rate limiting', async () => {
    const strategy = new FakeStrategy('SPY', { runRateLimitCount: 2 });
    const sleepCalls = [];
    const orchestrator = new PersistentRuntimeOrchestrator({
      runtimeMode: 'paper',
      configStore: new FakeConfigStore({ symbols: ['SPY'] }),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: true,
            sessionLabel: 'regular_open',
          };
        },
      },
      strategyFactory() {
        return strategy;
      },
      sleep(delayMs) {
        sleepCalls.push(delayMs);
        return Promise.resolve();
      },
      logger: {
        info() {},
        error() {},
      },
    });

    await orchestrator.start();

    assert.equal(strategy.runCalls.length, 3);
    assert.deepEqual(sleepCalls, [30_000, 30_000]);
    assert.equal(orchestrator.getState().lastResults[0].ok, true);

    await orchestrator.stop('unit_test_stop');
  });

  test('PersistentRuntimeOrchestrator notifies lifecycle hooks for daily reporting', async () => {
    const hookEvents = {
      started: [],
      evaluated: [],
      completed: [],
    };
    const orchestrator = new PersistentRuntimeOrchestrator({
      runtimeMode: 'paper',
      configStore: new FakeConfigStore({ symbols: ['AAPL'] }),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: true,
            sessionLabel: 'regular_open',
          };
        },
      },
      strategyFactory() {
        return new FakeStrategy('AAPL');
      },
      onCycleStarted(payload) {
        hookEvents.started.push(payload);
      },
      onStrategyEvaluated(payload) {
        hookEvents.evaluated.push(payload);
      },
      onCycleCompleted(payload) {
        hookEvents.completed.push(payload);
      },
      logger: {
        info() {},
        error() {},
      },
    });

    await orchestrator.start();

    assert.equal(hookEvents.started.length, 1);
    assert.equal(hookEvents.evaluated.length, 1);
    assert.equal(hookEvents.completed.length, 1);
    assert.equal(hookEvents.started[0].symbols[0], 'AAPL');
    assert.equal(hookEvents.evaluated[0].ok, true);
    assert.equal(hookEvents.completed[0].results.length, 1);

    await orchestrator.stop('unit_test_stop');
  });
};
