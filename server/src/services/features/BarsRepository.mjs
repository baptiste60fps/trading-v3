import { aggregateBars, getTimeframeMs } from '../../core/market/time.mjs';
import { assertSymbolId, assertTimeframe } from '../../core/types/validators.mjs';

const DIRECT_TIMEFRAME_CANDIDATES = ['1d', '1h', '15m', '5m', '1m'];

const buildCacheKey = ({ symbol, timeframe, startMs, endMs, limit, direct }) =>
  JSON.stringify({
    symbol,
    timeframe,
    startMs,
    endMs,
    limit,
    direct,
  });

export class BarsRepository {
  constructor({ marketDataProvider, cacheStore, cacheNamespace = 'bars' } = {}) {
    this.marketDataProvider = marketDataProvider;
    this.cacheStore = cacheStore;
    this.cacheNamespace = cacheNamespace;
  }

  async getBars({ symbol, timeframe, startMs, endMs, preferCache = true, limit = 10_000 } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeTimeframe = assertTimeframe(timeframe);
    const direct = this.#resolveDirectTimeframe(safeTimeframe);
    const targetMs = getTimeframeMs(safeTimeframe);
    const directMs = getTimeframeMs(direct);
    const directLimit = direct === safeTimeframe ? limit : Math.max(limit, Math.ceil((limit * targetMs) / directMs));

    const cacheKey = buildCacheKey({
      symbol: safeSymbol,
      timeframe: safeTimeframe,
      startMs,
      endMs,
      limit,
      direct,
    });

    if (preferCache && this.cacheStore) {
      const cached = await this.cacheStore.get(this.cacheNamespace, cacheKey);
      if (Array.isArray(cached) && cached.length) return cached;
    }

    let result = [];
    if (direct === safeTimeframe) {
      result = await this.marketDataProvider.getBars({
        symbol: safeSymbol,
        timeframe: safeTimeframe,
        startMs,
        endMs,
        limit: directLimit,
      });
    } else {
      const rawBars = await this.marketDataProvider.getBars({
        symbol: safeSymbol,
        timeframe: direct,
        startMs,
        endMs,
        limit: directLimit,
      });
      result = aggregateBars(rawBars, safeTimeframe, {
        anchorMs: rawBars[0]?.startMs ?? startMs,
      });
    }

    if (this.cacheStore && result.length) {
      await this.cacheStore.set(this.cacheNamespace, cacheKey, result);
    }

    return result;
  }

  #resolveDirectTimeframe(targetTimeframe) {
    const targetMs = getTimeframeMs(targetTimeframe);

    if (typeof this.marketDataProvider?.supportsTimeframe === 'function' && this.marketDataProvider.supportsTimeframe(targetTimeframe)) {
      return targetTimeframe;
    }

    if (targetMs < getTimeframeMs('1m')) {
      throw new Error(`Historical repository does not support sub-minute timeframe ${targetTimeframe}. Use a live tick aggregator.`);
    }

    for (const candidate of DIRECT_TIMEFRAME_CANDIDATES) {
      const candidateMs = getTimeframeMs(candidate);
      if (targetMs >= candidateMs && targetMs % candidateMs === 0) {
        if (typeof this.marketDataProvider?.supportsTimeframe !== 'function' || this.marketDataProvider.supportsTimeframe(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error(`Unable to resolve a direct provider timeframe for ${targetTimeframe}`);
  }
}
