import assert from 'assert/strict';
import path from 'path';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { AlpacaHttpClient } from '../../src/core/api/AlpacaHttpClient.mjs';
import { AlpacaMarketDataProvider } from '../../src/core/api/AlpacaMarketDataProvider.mjs';

const createProvider = () => {
  const serverRootDir = path.resolve(process.cwd());
  const localEnv = loadLocalEnv(serverRootDir);
  const keyId = process.env.ALPACA_API_KEY ?? localEnv.values.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY ?? localEnv.values.ALPACA_SECRET_KEY;

  assert.ok(keyId, 'ALPACA_API_KEY is required for Alpaca integration tests');
  assert.ok(secretKey, 'ALPACA_SECRET_KEY is required for Alpaca integration tests');

  return new AlpacaMarketDataProvider({
    client: new AlpacaHttpClient({
      keyId,
      secretKey,
      paper: true,
    }),
    feed: 'iex',
    adjustment: 'raw',
  });
};

export const register = async ({ test }) => {
  test('AlpacaMarketDataProvider returns a latest price', async () => {
    const provider = createProvider();
    const latest = await provider.getLatestPrice('AAPL');

    assert.ok(latest);
    assert.equal(latest.symbol, 'AAPL');
    assert.ok(Number.isFinite(latest.price));
    assert.ok(Number.isFinite(latest.atMs));
  });

  test('AlpacaMarketDataProvider returns daily bars', async () => {
    const provider = createProvider();
    const endMs = Date.now();
    const startMs = endMs - 10 * 24 * 60 * 60 * 1000;

    const bars = await provider.getBars({
      symbol: 'AAPL',
      timeframe: '1d',
      startMs,
      endMs,
      limit: 10,
    });

    assert.ok(Array.isArray(bars));
    assert.ok(bars.length > 0);
    assert.equal(bars[0].symbol, 'AAPL');
    assert.equal(bars[0].timeframe, '1d');
  });

  test('AlpacaMarketDataProvider returns crypto latest price and daily bars', async () => {
    const provider = createProvider();
    const latest = await provider.getLatestPrice('BTC/USD', { assetClass: 'crypto' });
    const endMs = Date.now();
    const startMs = endMs - 10 * 24 * 60 * 60 * 1000;
    const bars = await provider.getBars({
      symbol: 'BTC/USD',
      assetClass: 'crypto',
      timeframe: '1d',
      startMs,
      endMs,
      limit: 10,
    });

    assert.ok(latest);
    assert.equal(latest.symbol, 'BTC/USD');
    assert.ok(Number.isFinite(latest.price));
    assert.ok(Number.isFinite(latest.atMs));
    assert.ok(Array.isArray(bars));
    assert.ok(bars.length > 0);
    assert.equal(bars[0].symbol, 'BTC/USD');
    assert.equal(bars[0].timeframe, '1d');
  });
};
