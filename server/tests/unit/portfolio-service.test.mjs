import assert from 'assert/strict';
import { PortfolioService } from '../../src/services/portfolio/PortfolioService.mjs';

class FakeBrokerGateway {
  async getAccountState() {
    return {
      cash: 5_000,
      equity: 10_000,
    };
  }

  async getOpenPositions() {
    return [
      {
        symbol: 'AAPL',
        qty: 10,
        entryPrice: 100,
        currentPrice: 105,
        marketValue: 1_050,
      },
      {
        symbol: 'QQQ',
        qty: 5,
        entryPrice: 200,
        currentPrice: 205,
        marketValue: 1_025,
      },
    ];
  }
}

class FakeConfigStore {
  getSymbolConfig(symbol) {
    if (symbol === 'AAPL') {
      return {
        risk: {
          maxPositionPct: 0.2,
          maxPortfolioExposurePct: 0.4,
        },
      };
    }

    return {
      risk: {
        maxPositionPct: 0.1,
        maxPortfolioExposurePct: 0.3,
      },
    };
  }
}

class UnauthorizedBrokerGateway {
  async getAccountState() {
    const error = new Error('unauthorized');
    error.category = 'auth';
    error.statusCode = 401;
    throw error;
  }
}

export const register = async ({ test }) => {
  test('PortfolioService computes snapshot and exposure', async () => {
    const service = new PortfolioService({
      brokerGateway: new FakeBrokerGateway(),
      configStore: new FakeConfigStore(),
    });

    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.cash, 5000);
    assert.equal(snapshot.equity, 10000);
    assert.equal(snapshot.positions.length, 2);
    assert.ok(snapshot.exposurePct > 0.2 && snapshot.exposurePct < 0.21);
  });

  test('PortfolioService applies symbol and portfolio exposure limits', async () => {
    const service = new PortfolioService({
      brokerGateway: new FakeBrokerGateway(),
      configStore: new FakeConfigStore(),
    });

    const allowance = await service.canOpenLong('AAPL', 3_000);
    assert.equal(allowance.allowed, true);
    assert.equal(allowance.adjustedNotional, 950);
  });

  test('PortfolioService degrades gracefully when broker auth fails', async () => {
    const service = new PortfolioService({
      brokerGateway: new UnauthorizedBrokerGateway(),
      configStore: new FakeConfigStore(),
    });

    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.cash, 0);
    assert.equal(snapshot.equity, 0);
    assert.deepEqual(snapshot.positions, []);
    assert.equal(snapshot.brokerReady, false);
    assert.equal(snapshot.errorCategory, 'auth');
  });

  test('PortfolioService blocks openings when broker auth is unavailable', async () => {
    const service = new PortfolioService({
      brokerGateway: new UnauthorizedBrokerGateway(),
      configStore: new FakeConfigStore(),
    });

    const allowance = await service.canOpenLong('AAPL', 3_000);
    assert.equal(allowance.allowed, false);
    assert.equal(allowance.reason, 'broker_auth_unavailable');
    assert.equal(allowance.adjustedNotional, 0);
  });
};
