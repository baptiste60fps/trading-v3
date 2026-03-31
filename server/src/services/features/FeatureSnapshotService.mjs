import { getTimeframeMs } from '../../core/market/time.mjs';
import { assertRuntimeMode, assertSymbolId, isFiniteNumber } from '../../core/types/validators.mjs';

const pickHistoricalShortTimeframe = (evaluationTimeframes = []) => {
  const list = Array.isArray(evaluationTimeframes) ? evaluationTimeframes : [];
  return list.find((timeframe) => getTimeframeMs(timeframe) >= getTimeframeMs('1m')) ?? '1m';
};

const emptyPortfolioState = Object.freeze({
  cash: 0,
  equity: 0,
  exposurePct: 0,
  positions: [],
});

const emptyRiskState = Object.freeze({
  canOpen: true,
  canClose: true,
  flags: [],
});

const makeIndicatorSnapshot = ({ symbol, timeframe, atMs }) => ({
  symbol,
  timeframe,
  atMs,
  values: {
    barCount: 0,
  },
});

const resolveSymbolPosition = (portfolioState, symbol) => {
  const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];
  return positions.find((entry) => String(entry?.symbol ?? '').toUpperCase() === symbol) ?? null;
};

export class FeatureSnapshotService {
  constructor({
    configStore,
    barsRepository,
    indicatorEngine,
    marketCalendar,
    portfolioService = null,
  } = {}) {
    this.configStore = configStore;
    this.barsRepository = barsRepository;
    this.indicatorEngine = indicatorEngine;
    this.marketCalendar = marketCalendar;
    this.portfolioService = portfolioService;
  }

  async build({
    symbol,
    atMs = Date.now(),
    runtimeMode = 'backtest',
    position = null,
    riskState = emptyRiskState,
    portfolioState = null,
  } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeRuntimeMode = assertRuntimeMode(runtimeMode);
    const symbolConfig = this.configStore.getSymbolConfig(safeSymbol);
    const relatedSymbols = this.configStore.getRelatedSymbols(safeSymbol);
    const timeframes = Array.isArray(symbolConfig.timeframes) && symbolConfig.timeframes.length ? symbolConfig.timeframes : ['1m', '5m', '15m', '1h', '1d'];
    const evaluationTimeframe = pickHistoricalShortTimeframe(symbolConfig.evaluationTimeframes);
    const lookbackBars = Number.isFinite(Number(symbolConfig.lookbackBars)) ? Number(symbolConfig.lookbackBars) : 250;

    const marketState = this.marketCalendar.getMarketState(atMs, safeSymbol);
    const resolvedPortfolioState = portfolioState ?? (this.portfolioService ? await this.portfolioService.getSnapshot() : emptyPortfolioState);
    const resolvedPosition = position ?? resolveSymbolPosition(resolvedPortfolioState, safeSymbol);

    const mainTimeframes = await this.#buildSymbolSnapshots({
      symbol: safeSymbol,
      atMs,
      timeframes,
      lookbackBars,
    });

    const shortBars = await this.#loadBars({
      symbol: safeSymbol,
      timeframe: evaluationTimeframe,
      atMs,
      lookbackBars: Math.min(lookbackBars, 180),
    });

    const currentPrice = this.#resolveCurrentPrice(shortBars, mainTimeframes);

    const relatedSnapshots = await Promise.all(
      relatedSymbols.map(async (relatedSymbol) => ({
        symbol: relatedSymbol,
        relation: 'related',
        timeframes: await this.#buildSymbolSnapshots({
          symbol: relatedSymbol,
          atMs,
          timeframes,
          lookbackBars,
        }),
      })),
    );

    return {
      symbol: safeSymbol,
      atMs,
      runtimeMode: safeRuntimeMode,
      currentPrice,
      shortBars,
      timeframes: mainTimeframes,
      relatedSymbols: relatedSnapshots,
      marketState,
      portfolioState: resolvedPortfolioState,
      position: resolvedPosition,
      riskState,
    };
  }

  async #buildSymbolSnapshots({ symbol, atMs, timeframes, lookbackBars }) {
    const snapshots = await Promise.all(
      timeframes.map(async (timeframe) => {
        const bars = await this.#loadBars({
          symbol,
          timeframe,
          atMs,
          lookbackBars,
        });

        if (!bars.length) return [timeframe, makeIndicatorSnapshot({ symbol, timeframe, atMs })];

        return [
          timeframe,
          this.indicatorEngine.compute({
            symbol,
            timeframe,
            bars,
            atMs,
          }),
        ];
      }),
    );

    return Object.fromEntries(snapshots);
  }

  async #loadBars({ symbol, timeframe, atMs, lookbackBars }) {
    const timeframeMs = getTimeframeMs(timeframe);
    const endMs = atMs;
    const startMs = endMs - timeframeMs * Math.max(lookbackBars, 20);

    try {
      return await this.barsRepository.getBars({
        symbol,
        timeframe,
        startMs,
        endMs,
        limit: Math.max(lookbackBars, 20),
      });
    } catch (error) {
      if (/sub-minute timeframe/i.test(error?.message ?? '')) return [];
      throw error;
    }
  }

  #resolveCurrentPrice(shortBars, mainTimeframes) {
    const lastShortBar = shortBars[shortBars.length - 1];
    if (lastShortBar && isFiniteNumber(lastShortBar.close)) return lastShortBar.close;

    for (const snapshot of Object.values(mainTimeframes ?? {})) {
      if (isFiniteNumber(snapshot?.values?.lastClose)) return snapshot.values.lastClose;
    }

    return null;
  }
}
