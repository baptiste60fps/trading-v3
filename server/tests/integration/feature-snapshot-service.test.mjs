import assert from 'assert/strict';
import path from 'path';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { AlpacaHttpClient } from '../../src/core/api/AlpacaHttpClient.mjs';
import { AlpacaMarketDataProvider } from '../../src/core/api/AlpacaMarketDataProvider.mjs';
import { FileCacheStore } from '../../src/core/cache/FileCacheStore.mjs';
import { MarketCalendar } from '../../src/core/market/MarketCalendar.mjs';
import { IndicatorEngine } from '../../src/core/indicators/IndicatorEngine.mjs';
import { BarsRepository } from '../../src/services/features/BarsRepository.mjs';
import { FeatureSnapshotService } from '../../src/services/features/FeatureSnapshotService.mjs';

const createService = () => {
  const serverRootDir = path.resolve(process.cwd());
  const localEnv = loadLocalEnv(serverRootDir);
  const keyId = process.env.ALPACA_API_KEY ?? localEnv.values.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY ?? localEnv.values.ALPACA_SECRET_KEY;

  assert.ok(keyId, 'ALPACA_API_KEY is required for Alpaca integration tests');
  assert.ok(secretKey, 'ALPACA_SECRET_KEY is required for Alpaca integration tests');

  const barsRepository = new BarsRepository({
    marketDataProvider: new AlpacaMarketDataProvider({
      client: new AlpacaHttpClient({
        keyId,
        secretKey,
        paper: true,
      }),
      feed: 'iex',
      adjustment: 'raw',
    }),
    cacheStore: new FileCacheStore({
      rootDir: path.resolve(serverRootDir, 'storage/cache'),
      defaultTtlMs: 60_000,
    }),
  });

  return new FeatureSnapshotService({
    configStore: {
      getSymbolConfig() {
        return {
          timeframes: ['1h', '1d'],
          evaluationTimeframes: ['1h'],
          lookbackBars: 60,
        };
      },
      getRelatedSymbols() {
        return ['QQQ'];
      },
    },
    barsRepository,
    indicatorEngine: new IndicatorEngine(),
    marketCalendar: new MarketCalendar({
      timezone: 'America/New_York',
    }),
  });
};

export const register = async ({ test }) => {
  test('FeatureSnapshotService builds a real Alpaca-backed snapshot', async () => {
    const service = createService();
    const snapshot = await service.build({
      symbol: 'AAPL',
      atMs: Date.now(),
      runtimeMode: 'paper',
    });

    assert.equal(snapshot.symbol, 'AAPL');
    assert.ok(snapshot.currentPrice > 0);
    assert.ok(snapshot.timeframes['1d']);
    assert.ok(snapshot.timeframes['1d'].values.barCount > 0);
    assert.equal(snapshot.relatedSymbols.length, 1);
    assert.equal(snapshot.relatedSymbols[0].symbol, 'QQQ');
    assert.ok(snapshot.relatedSymbols[0].timeframes['1d'].values.barCount > 0);
  });
};
