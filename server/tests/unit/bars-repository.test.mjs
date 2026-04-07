import assert from 'assert/strict';
import path from 'path';
import { MarketDataProvider } from '../../src/core/api/MarketDataProvider.mjs';
import { FileCacheStore } from '../../src/core/cache/FileCacheStore.mjs';
import { BarsRepository } from '../../src/services/features/BarsRepository.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

class FakeMarketDataProvider extends MarketDataProvider {
  constructor() {
    super({ providerName: 'fake-provider' });
    this.calls = 0;
  }

  supportsTimeframe(timeframe) {
    return ['1m', '5m', '15m', '1h', '1d'].includes(timeframe);
  }

  async getBars({ symbol, timeframe, startMs }) {
    this.calls += 1;
    if (!['1m', '1h'].includes(timeframe)) throw new Error(`Fake provider only supports 1m and 1h in test, received ${timeframe}`);

    const stepMs = timeframe === '1h' ? 3_600_000 : 60_000;
    const closeBase = timeframe === '1h' ? 100 : 10;

    return [
      { symbol, timeframe, startMs, endMs: startMs + stepMs, open: closeBase, high: closeBase + 1, low: closeBase - 1, close: closeBase + 0.5, volume: 100, tradeCount: 2, source: 'fake' },
      { symbol, timeframe, startMs: startMs + stepMs, endMs: startMs + 2 * stepMs, open: closeBase + 0.5, high: closeBase + 2, low: closeBase, close: closeBase + 1.5, volume: 110, tradeCount: 3, source: 'fake' },
      { symbol, timeframe, startMs: startMs + 2 * stepMs, endMs: startMs + 3 * stepMs, open: closeBase + 1.5, high: closeBase + 3, low: closeBase + 1, close: closeBase + 2.5, volume: 90, tradeCount: 2, source: 'fake' },
      { symbol, timeframe, startMs: startMs + 3 * stepMs, endMs: startMs + 4 * stepMs, open: closeBase + 2.5, high: closeBase + 4, low: closeBase + 2, close: closeBase + 3.5, volume: 80, tradeCount: 2, source: 'fake' },
    ];
  }
}

export const register = async ({ test }) => {
  test('BarsRepository aggregates larger timeframes and reuses cache', async () => {
    const provider = new FakeMarketDataProvider();
    const cache = new FileCacheStore({
      rootDir: path.join(makeTempDir(), 'bars-cache'),
      defaultTtlMs: 60_000,
    });

    const repository = new BarsRepository({
      marketDataProvider: provider,
      cacheStore: cache,
    });

    const startMs = Date.parse('2026-03-25T13:30:00.000Z');
    const first = await repository.getBars({
      symbol: 'AAPL',
      timeframe: '2m',
      startMs,
      endMs: startMs + 240_000,
    });
    const second = await repository.getBars({
      symbol: 'AAPL',
      timeframe: '2m',
      startMs,
      endMs: startMs + 240_000,
    });

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(provider.calls, 1);
  });

  test('BarsRepository rejects unsupported sub-minute historical requests', async () => {
    const repository = new BarsRepository({
      marketDataProvider: new FakeMarketDataProvider(),
      cacheStore: null,
    });

    const startMs = Date.parse('2026-03-25T13:30:00.000Z');
    await assert.rejects(
      () =>
        repository.getBars({
          symbol: 'AAPL',
          timeframe: '10s',
          startMs,
          endMs: startMs + 60_000,
        }),
      /sub-minute timeframe/i,
    );
  });

  test('BarsRepository chooses the coarsest compatible direct timeframe', async () => {
    const provider = new FakeMarketDataProvider();
    const repository = new BarsRepository({
      marketDataProvider: provider,
      cacheStore: null,
    });

    const startMs = Date.parse('2026-03-25T13:30:00.000Z');
    const bars = await repository.getBars({
      symbol: 'AAPL',
      timeframe: '4h',
      startMs,
      endMs: startMs + 4 * 3_600_000,
      limit: 4,
    });

    assert.equal(provider.calls, 1);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].timeframe, '4h');
  });

  test('BarsRepository keeps asset class in the cache key', async () => {
    const provider = new FakeMarketDataProvider();
    const cache = new FileCacheStore({
      rootDir: path.join(makeTempDir(), 'bars-cache-asset-class'),
      defaultTtlMs: 60_000,
    });
    const repository = new BarsRepository({
      marketDataProvider: provider,
      cacheStore: cache,
    });
    const startMs = Date.parse('2026-03-25T13:30:00.000Z');

    await repository.getBars({
      symbol: 'BTC/USD',
      assetClass: 'crypto',
      timeframe: '1m',
      startMs,
      endMs: startMs + 240_000,
    });
    await repository.getBars({
      symbol: 'BTC/USD',
      assetClass: 'stock',
      timeframe: '1m',
      startMs,
      endMs: startMs + 240_000,
    });

    assert.equal(provider.calls, 2);
  });
};
