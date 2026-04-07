import assert from 'assert/strict';
import { AlpacaMarketDataProvider } from '../../src/core/api/AlpacaMarketDataProvider.mjs';

class FakeClient {
  constructor() {
    this.calls = [];
  }

  async requestData(path, options = {}) {
    this.calls.push({ path, options });
    if (path === '../v1beta3/crypto/us/bars') {
      if (options.query?.symbols === 'ETH/USD') {
        if (options.query?.page_token === 'page-2') {
          return {
            bars: {
              'ETH/USD': [
                { t: '2026-04-02T01:00:00Z', o: 2110, h: 2120, l: 2100, c: 2115, v: 220.5, n: 1100 },
              ],
            },
          };
        }

        return {
          bars: {
            'ETH/USD': [
              { t: '2026-04-02T00:00:00Z', o: 2100, h: 2110, l: 2090, c: 2105, v: 210.5, n: 1000 },
            ],
          },
          next_page_token: 'page-2',
        };
      }

      return {
        bars: {
          'BTC/USD': [
            { t: '2026-04-02T00:00:00Z', o: 85000, h: 86000, l: 84500, c: 85500, v: 120.5, n: 1000 },
          ],
        },
      };
    }
    if (path === '../v1beta3/crypto/us/latest/trades') {
      return {
        trades: {
          'BTC/USD': {
            t: '2026-04-02T12:00:00Z',
            p: 85550,
          },
        },
      };
    }
    if (path === '/stocks/AAPL/bars') {
      return {
        bars: [
          { t: '2026-04-02T00:00:00Z', o: 200, h: 202, l: 199, c: 201, v: 1000, n: 50 },
        ],
      };
    }
    if (path === '/stocks/AAPL/trades/latest') {
      return {
        trade: {
          t: '2026-04-02T12:00:00Z',
          p: 201,
        },
      };
    }
    throw new Error(`Unexpected path ${path}`);
  }
}

export const register = async ({ test }) => {
  test('AlpacaMarketDataProvider routes stock requests to stock endpoints', async () => {
    const client = new FakeClient();
    const provider = new AlpacaMarketDataProvider({
      client,
      feed: 'iex',
      adjustment: 'raw',
    });

    const latest = await provider.getLatestPrice('AAPL');
    const bars = await provider.getBars({
      symbol: 'AAPL',
      timeframe: '1d',
      startMs: Date.parse('2026-03-25T00:00:00Z'),
      endMs: Date.parse('2026-04-02T00:00:00Z'),
      limit: 10,
    });

    assert.equal(latest.symbol, 'AAPL');
    assert.equal(bars[0].symbol, 'AAPL');
    assert.equal(client.calls[0].path, '/stocks/AAPL/trades/latest');
    assert.equal(client.calls[1].path, '/stocks/AAPL/bars');
  });

  test('AlpacaMarketDataProvider routes crypto requests to crypto endpoints', async () => {
    const client = new FakeClient();
    const provider = new AlpacaMarketDataProvider({
      client,
      feed: 'iex',
      adjustment: 'raw',
      cryptoLocation: 'us',
    });

    const latest = await provider.getLatestPrice('BTC/USD', { assetClass: 'crypto' });
    const bars = await provider.getBars({
      symbol: 'BTC/USD',
      assetClass: 'crypto',
      timeframe: '1d',
      startMs: Date.parse('2026-03-25T00:00:00Z'),
      endMs: Date.parse('2026-04-02T00:00:00Z'),
      limit: 10,
    });

    assert.equal(latest.symbol, 'BTC/USD');
    assert.equal(bars[0].symbol, 'BTC/USD');
    assert.equal(client.calls[0].path, '../v1beta3/crypto/us/latest/trades');
    assert.equal(client.calls[0].options.query.symbols, 'BTC/USD');
    assert.equal(client.calls[1].path, '../v1beta3/crypto/us/bars');
    assert.equal(client.calls[1].options.query.symbols, 'BTC/USD');
  });

  test('AlpacaMarketDataProvider follows crypto bars pagination', async () => {
    const client = new FakeClient();
    const provider = new AlpacaMarketDataProvider({
      client,
      cryptoLocation: 'us',
    });

    const bars = await provider.getBars({
      symbol: 'ETH/USD',
      assetClass: 'crypto',
      timeframe: '1h',
      startMs: Date.parse('2026-04-02T00:00:00Z'),
      endMs: Date.parse('2026-04-02T02:00:00Z'),
      limit: 10,
    });

    assert.equal(bars.length, 2);
    assert.equal(bars[0].symbol, 'ETH/USD');
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[0].options.query.page_token, undefined);
    assert.equal(client.calls[1].options.query.page_token, 'page-2');
  });
};
