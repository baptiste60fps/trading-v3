import { MarketDataProvider } from '../api/MarketDataProvider.mjs';
import { normalizeEpochMs } from '../market/time.mjs';
import { assertSymbolId, assertTimeframe } from '../types/validators.mjs';

const cloneBar = (bar) => ({ ...bar });

export class ReplayMarketDataProvider extends MarketDataProvider {
  constructor({ dataset = {} } = {}) {
    super({ providerName: 'backtest-replay-market-data' });
    this.dataset = dataset;
  }

  supportsTimeframe(timeframe) {
    const safeTimeframe = assertTimeframe(timeframe);
    return Object.values(this.dataset).some((entry) => Array.isArray(entry?.[safeTimeframe]) && entry[safeTimeframe].length > 0);
  }

  async getBars({ symbol, timeframe, startMs, endMs, limit = 10_000 } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeTimeframe = assertTimeframe(timeframe);
    const resolvedStartMs = startMs === undefined || startMs === null ? 0 : normalizeEpochMs(startMs, 'startMs');
    const resolvedEndMs = endMs === undefined || endMs === null ? Number.MAX_SAFE_INTEGER : normalizeEpochMs(endMs, 'endMs');
    const rows = Array.isArray(this.dataset?.[safeSymbol]?.[safeTimeframe]) ? this.dataset[safeSymbol][safeTimeframe] : [];
    const filtered = rows.filter((bar) => bar.startMs >= resolvedStartMs && bar.endMs <= resolvedEndMs);
    const trimmed = Number.isFinite(Number(limit)) && filtered.length > Number(limit) ? filtered.slice(filtered.length - Number(limit)) : filtered;
    return trimmed.map(cloneBar);
  }

  async getLatestPrice(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const symbolDataset = this.dataset?.[safeSymbol] ?? {};
    for (const timeframe of ['1m', '5m', '15m', '1h', '1d']) {
      const rows = symbolDataset[timeframe];
      if (Array.isArray(rows) && rows.length > 0) {
        const last = rows[rows.length - 1];
        return {
          symbol: safeSymbol,
          price: last.close,
          atMs: last.endMs,
        };
      }
    }

    return null;
  }
}
