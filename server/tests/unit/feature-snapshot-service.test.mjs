import assert from 'assert/strict';
import { IndicatorEngine } from '../../src/core/indicators/IndicatorEngine.mjs';
import { FeatureSnapshotService } from '../../src/services/features/FeatureSnapshotService.mjs';

const makeBars = (symbol, timeframe, count, stepMs, startPrice = 100) => {
  const startMs = Date.parse('2026-03-25T13:30:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + index;
    return {
      symbol,
      timeframe,
      startMs: startMs + index * stepMs,
      endMs: startMs + (index + 1) * stepMs,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100 + index,
      tradeCount: 5 + index,
      source: 'test',
    };
  });
};

class FakeBarsRepository {
  async getBars({ symbol, timeframe }) {
    if (timeframe === '1m') return makeBars(symbol, timeframe, 120, 60_000, symbol === 'AAPL' ? 100 : 200);
    if (timeframe === '5m') return makeBars(symbol, timeframe, 80, 300_000, symbol === 'AAPL' ? 100 : 200);
    if (timeframe === '1h') return makeBars(symbol, timeframe, 60, 3_600_000, symbol === 'AAPL' ? 100 : 200);
    return [];
  }
}

class FakeConfigStore {
  getSymbolConfig() {
    return {
      timeframes: ['1m', '5m', '1h'],
      evaluationTimeframes: ['10s', '1m'],
      lookbackBars: 60,
    };
  }

  getRelatedSymbols() {
    return ['QQQ'];
  }
}

class FakeMarketCalendar {
  getMarketState() {
    return {
      isOpen: true,
      isPreClose: false,
      isNoTradeOpen: false,
      sessionLabel: 'regular_open',
    };
  }
}

class FakePortfolioService {
  async getSnapshot() {
    return {
      cash: 8_000,
      equity: 10_000,
      exposurePct: 0.2,
      positions: [
        {
          symbol: 'AAPL',
          side: 'long',
          qty: 5,
          entryPrice: 120,
          currentPrice: 130,
          marketValue: 650,
          openedAtMs: Date.parse('2026-03-25T14:00:00.000Z'),
        },
      ],
    };
  }
}

export const register = async ({ test }) => {
  test('FeatureSnapshotService builds main and related indicator snapshots', async () => {
    const service = new FeatureSnapshotService({
      configStore: new FakeConfigStore(),
      barsRepository: new FakeBarsRepository(),
      indicatorEngine: new IndicatorEngine(),
      marketCalendar: new FakeMarketCalendar(),
      portfolioService: new FakePortfolioService(),
    });

    const snapshot = await service.build({
      symbol: 'AAPL',
      atMs: Date.parse('2026-03-25T20:00:00.000Z'),
      runtimeMode: 'backtest',
    });

    assert.equal(snapshot.symbol, 'AAPL');
    assert.equal(snapshot.runtimeMode, 'backtest');
    assert.equal(snapshot.marketState.isOpen, true);
    assert.ok(snapshot.currentPrice > 0);
    assert.ok(snapshot.shortBars.length > 0);
    assert.equal(snapshot.portfolioState.positions.length, 1);
    assert.equal(snapshot.position?.symbol, 'AAPL');
    assert.equal(snapshot.position?.qty, 5);
    assert.deepEqual(Object.keys(snapshot.timeframes), ['1m', '5m', '1h']);
    assert.equal(snapshot.relatedSymbols.length, 1);
    assert.equal(snapshot.relatedSymbols[0].symbol, 'QQQ');
    assert.ok(snapshot.timeframes['1m'].values.lastClose > 0);
    assert.ok(snapshot.relatedSymbols[0].timeframes['1m'].values.lastClose > 0);
  });
};
