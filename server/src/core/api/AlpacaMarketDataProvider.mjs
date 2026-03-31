import { MarketDataProvider } from './MarketDataProvider.mjs';
import { assertSymbolId, assertTimeframe } from '../types/validators.mjs';
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

export class AlpacaMarketDataProvider extends MarketDataProvider {
  constructor({ client, feed = 'iex', adjustment = 'raw' } = {}) {
    super({ providerName: 'alpaca-market-data' });
    this.client = client;
    this.feed = feed;
    this.adjustment = adjustment;
  }

  supportsTimeframe(timeframe) {
    return Boolean(ALPACA_DIRECT_TIMEFRAMES[timeframe]);
  }

  async getBars({ symbol, timeframe, startMs, endMs, limit = 10_000 } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeTimeframe = assertTimeframe(timeframe);
    const alpacaTimeframe = ALPACA_DIRECT_TIMEFRAMES[safeTimeframe];
    if (!alpacaTimeframe) {
      throw new Error(`AlpacaMarketDataProvider does not support direct timeframe ${safeTimeframe}`);
    }

    const response = await this.client.requestData(`/stocks/${encodeURIComponent(safeSymbol)}/bars`, {
      query: {
        timeframe: alpacaTimeframe,
        start: toIsoUtc(startMs),
        end: toIsoUtc(endMs),
        limit,
        feed: this.feed,
        adjustment: this.adjustment,
      },
    });

    const bars = Array.isArray(response?.bars) ? response.bars : [];
    return bars.map((bar) => normalizeBar(safeSymbol, safeTimeframe, bar, this.providerName));
  }

  async getLatestPrice(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const response = await this.client.requestData(`/stocks/${encodeURIComponent(safeSymbol)}/trades/latest`, {
      query: {
        feed: this.feed,
      },
    });

    const trade = response?.trade ?? response?.trades?.[safeSymbol] ?? null;
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
