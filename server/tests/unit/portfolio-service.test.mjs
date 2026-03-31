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
};
