import { MarketDataProvider } from './MarketDataProvider.mjs';
import { assertAssetClass, assertSymbolId, assertTimeframe } from '../types/validators.mjs';
import { getTimeframeMs, normalizeEpochMs, toIsoUtc } from '../market/time.mjs';

const ALPACA_DIRECT_TIMEFRAMES = Object.freeze({
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '1h': '1Hour',
  '1d': '1Day',
});

const normalizeBar = (symbol, timeframe, row, source) => {
  const startMs = normalizeEpochMs(row.t ?? row.timestamp ?? row.start ?? row.startMs, 'alpaca.bar.start');
  return {
    symbol,
    timeframe,
    startMs,
    endMs: startMs + getTimeframeMs(timeframe),
    open: Number(row.o ?? row.open ?? row.openPrice),
    high: Number(row.h ?? row.high ?? row.highPrice),
    low: Number(row.l ?? row.low ?? row.lowPrice),
    close: Number(row.c ?? row.close ?? row.closePrice),
    volume: Number.isFinite(Number(row.v)) ? Number(row.v) : null,
    tradeCount: Number.isFinite(Number(row.n)) ? Number(row.n) : null,
    source,
  };
};

const extractBars = (response, safeSymbol) => {
  const legacySymbol = safeSymbol.replace('/', '');
  if (Array.isArray(response?.bars)) return response.bars;
  if (Array.isArray(response?.bars?.[safeSymbol])) return response.bars[safeSymbol];
  if (Array.isArray(response?.bars?.[legacySymbol])) return response.bars[legacySymbol];
  return [];
};

export class AlpacaMarketDataProvider extends MarketDataProvider {
  constructor({ client, feed = 'iex', adjustment = 'raw', cryptoLocation = 'us' } = {}) {
    super({ providerName: 'alpaca-market-data' });
    this.client = client;
    this.feed = feed;
    this.adjustment = adjustment;
    this.cryptoLocation = String(cryptoLocation ?? 'us').trim().toLowerCase() || 'us';
  }

  #buildCryptoPath(resource) {
    return `../v1beta3/crypto/${this.cryptoLocation}/${resource}`;
  }

  supportsTimeframe(timeframe) {
    return Boolean(ALPACA_DIRECT_TIMEFRAMES[timeframe]);
  }

  async getBars({ symbol, assetClass = 'stock', timeframe, startMs, endMs, limit = 10_000 } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeAssetClass = assertAssetClass(assetClass ?? 'stock');
    const safeTimeframe = assertTimeframe(timeframe);
    const alpacaTimeframe = ALPACA_DIRECT_TIMEFRAMES[safeTimeframe];
    if (!alpacaTimeframe) {
      throw new Error(`AlpacaMarketDataProvider does not support direct timeframe ${safeTimeframe}`);
    }

    const bars = [];
    let nextPageToken = null;
    const maxPages = 50;

    for (let page = 0; page < maxPages && bars.length < limit; page += 1) {
      const pageLimit = Math.max(1, Math.min(limit - bars.length, 10_000));
      const response = safeAssetClass === 'crypto'
        ? await this.client.requestData(this.#buildCryptoPath('bars'), {
            query: {
              symbols: safeSymbol,
              timeframe: alpacaTimeframe,
              start: toIsoUtc(startMs),
              end: toIsoUtc(endMs),
              limit: pageLimit,
              page_token: nextPageToken ?? undefined,
            },
          })
        : await this.client.requestData(`/stocks/${encodeURIComponent(safeSymbol)}/bars`, {
            query: {
              timeframe: alpacaTimeframe,
              start: toIsoUtc(startMs),
              end: toIsoUtc(endMs),
              limit: pageLimit,
              feed: this.feed,
              adjustment: this.adjustment,
              page_token: nextPageToken ?? undefined,
            },
          });

      const pageBars = extractBars(response, safeSymbol);
      bars.push(...pageBars);

      nextPageToken = response?.next_page_token ?? response?.nextPageToken ?? null;
      if (!nextPageToken || !pageBars.length) break;
    }

    return bars.map((bar) => normalizeBar(safeSymbol, safeTimeframe, bar, this.providerName));
  }

  async getLatestPrice(symbol, { assetClass = 'stock' } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeAssetClass = assertAssetClass(assetClass ?? 'stock');
    const response = safeAssetClass === 'crypto'
      ? await this.client.requestData(this.#buildCryptoPath('latest/trades'), {
          query: {
            symbols: safeSymbol,
          },
        })
      : await this.client.requestData(`/stocks/${encodeURIComponent(safeSymbol)}/trades/latest`, {
          query: {
            feed: this.feed,
          },
        });

    const legacySymbol = safeSymbol.replace('/', '');
    const trade = response?.trade ?? response?.trades?.[safeSymbol] ?? response?.trades?.[legacySymbol] ?? null;
    if (!trade) return null;

    const price = Number(trade.p ?? trade.Price ?? trade.price);
    const atMs = normalizeEpochMs(trade.t ?? trade.Timestamp ?? trade.timestamp, 'alpaca.trade.time');

    return {
      symbol: safeSymbol,
      price,
      atMs,
    };
  }
}
