import assert from 'assert/strict';
import { ExecutionEngine } from '../../src/core/runtime/ExecutionEngine.mjs';

class FakePortfolioService {
  async canOpenLong() {
    return {
      allowed: true,
      reason: null,
      adjustedNotional: 800,
    };
  }
}

class FractionalStopPortfolioService {
  async canOpenLong() {
    return {
      allowed: true,
      reason: null,
      adjustedNotional: 875,
    };
  }
}

class TinyStopPortfolioService {
  async canOpenLong() {
    return {
      allowed: true,
      reason: null,
      adjustedNotional: 80,
    };
  }
}

class RejectingPortfolioService {
  async canOpenLong() {
    return {
      allowed: false,
      reason: 'risk_limits',
      adjustedNotional: 0,
    };
  }
}

class FakeBrokerGateway {
  constructor() {
    this.submitted = [];
    this.closed = [];
  }

  async submit(intent) {
    this.submitted.push(intent);
    return {
      accepted: true,
      brokerOrderId: 'paper-order-1',
      filledQty: null,
      avgFillPrice: null,
      status: 'accepted',
      error: null,
    };
  }

  async close(symbol) {
    this.closed.push(symbol);
    return {
      accepted: true,
      brokerOrderId: 'paper-close-1',
      filledQty: null,
      avgFillPrice: null,
      status: 'closed',
      error: null,
    };
  }
}

class FakeConfigStore {
  getSymbolConfig() {
    return {
      risk: {
        maxPositionPct: 0.1,
      },
    };
  }
}

class StopLossConfigStore {
  getSymbolConfig() {
    return {
      brokerProtection: {
        enabled: true,
        simpleStopLossPct: 0.02,
      },
      risk: {
        maxPositionPct: 0.1,
      },
    };
  }
}

class CryptoConfigStore {
  getSymbolConfig() {
    return {
      assetClass: 'crypto',
      brokerProtection: {
        enabled: true,
        simpleStopLossPct: 0.02,
      },
      risk: {
        maxPositionPct: 0.1,
      },
    };
  }
}

const baseFeatures = {
  symbol: 'AAPL',
  atMs: Date.now(),
  currentPrice: 100,
  marketState: {
    isOpen: true,
    isPreClose: false,
    isNoTradeOpen: false,
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
};

export const register = async ({ test }) => {
  test('ExecutionEngine creates dry-run open intents from LLM decisions', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new FakePortfolioService(),
      configStore: new FakeConfigStore(),
      dryRun: true,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'open_long',
        confidence: 0.82,
        reasoning: ['trend aligned'],
        requestedSizePct: 0.08,
      },
      features: baseFeatures,
    });

    assert.ok(result.executionIntent);
    assert.equal(result.executionIntent.action, 'open_long');
    assert.equal(result.executionIntent.notional, 800);
    assert.equal(result.executionIntent.referencePrice, 100);
    assert.equal(result.executionResult.status, 'dry_run');
  });

  test('ExecutionEngine converts broker-protected entries to qty-based intents with a simple stop loss', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new FakePortfolioService(),
      configStore: new StopLossConfigStore(),
      dryRun: true,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'open_long',
        confidence: 0.82,
        reasoning: ['trend aligned'],
        requestedSizePct: 0.08,
      },
      features: baseFeatures,
    });

    assert.ok(result.executionIntent);
    assert.equal(result.executionIntent.action, 'open_long');
    assert.equal(result.executionIntent.notional, null);
    assert.equal(result.executionIntent.referencePrice, 100);
    assert.equal(result.executionIntent.stopLossPct, 0.02);
    assert.equal(result.executionIntent.qty, 8);
    assert.equal(result.executionResult.status, 'dry_run');
  });

  test('ExecutionEngine floors broker-protected stock entries to whole shares', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new FractionalStopPortfolioService(),
      configStore: new StopLossConfigStore(),
      dryRun: true,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'open_long',
        confidence: 0.82,
        reasoning: ['trend aligned'],
        requestedSizePct: 0.08,
      },
      features: baseFeatures,
    });

    assert.ok(result.executionIntent);
    assert.equal(result.executionIntent.qty, 8);
    assert.equal(result.executionIntent.notional, null);
    assert.equal(result.executionResult.status, 'dry_run');
  });

  test('ExecutionEngine noops broker-protected stock entries when notional is below one whole share', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new TinyStopPortfolioService(),
      configStore: new StopLossConfigStore(),
      dryRun: true,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'open_long',
        confidence: 0.82,
        reasoning: ['trend aligned'],
        requestedSizePct: 0.08,
      },
      features: {
        ...baseFeatures,
        currentPrice: 100,
      },
    });

    assert.equal(result.executionIntent, null);
    assert.equal(result.executionResult.status, 'noop');
    assert.equal(result.executionResult.error.message, 'insufficient_notional_for_whole_share_stop_order');
  });

  test('ExecutionEngine disables broker-side simple stop loss for crypto intents', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new FakePortfolioService(),
      configStore: new CryptoConfigStore(),
      dryRun: true,
    });

    const result = await engine.executeDecision({
      symbol: 'BTC/USD',
      decision: {
        action: 'open_long',
        confidence: 0.8,
        reasoning: ['crypto setup'],
        requestedSizePct: 0.05,
      },
      features: {
        ...baseFeatures,
        symbol: 'BTC/USD',
        assetClass: 'crypto',
        currentPrice: 90000,
      },
    });

    assert.ok(result.executionIntent);
    assert.equal(result.executionIntent.assetClass, 'crypto');
    assert.equal(result.executionIntent.stopLossPct, null);
    assert.equal(result.executionIntent.notional, 800);
    assert.equal(result.executionIntent.qty, null);
    assert.equal(result.executionResult.status, 'dry_run');
  });

  test('ExecutionEngine noops when portfolio gates reject opening', async () => {
    const engine = new ExecutionEngine({
      brokerGateway: new FakeBrokerGateway(),
      portfolioService: new RejectingPortfolioService(),
      configStore: new FakeConfigStore(),
      dryRun: false,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'open_long',
        confidence: 0.82,
        reasoning: ['trend aligned'],
        requestedSizePct: 0.08,
      },
      features: baseFeatures,
    });

    assert.equal(result.executionIntent, null);
    assert.equal(result.executionResult.status, 'noop');
    assert.equal(result.executionResult.error.message, 'risk_limits');
  });

  test('ExecutionEngine calls broker close on close_long', async () => {
    const broker = new FakeBrokerGateway();
    const engine = new ExecutionEngine({
      brokerGateway: broker,
      portfolioService: new FakePortfolioService(),
      configStore: new FakeConfigStore(),
      dryRun: false,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'close_long',
        confidence: 0.9,
        reasoning: ['stop trigger'],
      },
      features: {
        ...baseFeatures,
        position: {
          symbol: 'AAPL',
          side: 'long',
          qty: 10,
          entryPrice: 100,
          openedAtMs: Date.now(),
        },
      },
    });

    assert.equal(broker.closed[0], 'AAPL');
    assert.equal(result.executionIntent.referencePrice, 100);
    assert.equal(result.executionResult.status, 'closed');
  });

  test('ExecutionEngine noops when the portfolio snapshot marks broker auth unavailable', async () => {
    const broker = new FakeBrokerGateway();
    const engine = new ExecutionEngine({
      brokerGateway: broker,
      portfolioService: new FakePortfolioService(),
      configStore: new FakeConfigStore(),
      dryRun: false,
    });

    const result = await engine.executeDecision({
      symbol: 'AAPL',
      decision: {
        action: 'close_long',
        confidence: 0.9,
        reasoning: ['manual exit'],
      },
      features: {
        ...baseFeatures,
        portfolioState: {
          ...baseFeatures.portfolioState,
          brokerReady: false,
          errorCategory: 'auth',
          error: 'unauthorized',
        },
        position: {
          symbol: 'AAPL',
          side: 'long',
          qty: 10,
          entryPrice: 100,
          openedAtMs: Date.now(),
        },
      },
    });

    assert.equal(result.executionIntent, null);
    assert.equal(result.executionResult.status, 'noop');
    assert.equal(result.executionResult.error.message, 'broker_auth_unavailable');
    assert.equal(broker.closed.length, 0);
  });
};
