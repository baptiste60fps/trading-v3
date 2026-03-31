import fs from 'fs';
import path from 'path';
import { getTimeframeMs, normalizeEpochMs, sortBars } from '../market/time.mjs';
import { assertSymbolId, assertTimeframe } from '../types/validators.mjs';
import { BarsRepository } from '../../services/features/BarsRepository.mjs';
import { FeatureSnapshotService } from '../../services/features/FeatureSnapshotService.mjs';
import { PortfolioService } from '../../services/portfolio/PortfolioService.mjs';
import { ExecutionEngine } from '../runtime/ExecutionEngine.mjs';
import { ReplayMarketDataProvider } from './ReplayMarketDataProvider.mjs';
import { SimulatedBrokerGateway } from './SimulatedBrokerGateway.mjs';
import { SimpleRuleDecisionEngine } from './SimpleRuleDecisionEngine.mjs';

const DIRECT_TIMEFRAME_CANDIDATES = ['1d', '1h', '15m', '5m', '1m'];

const unique = (values) => Array.from(new Set(values));

const pickHistoricalShortTimeframe = (evaluationTimeframes = []) => {
  const list = Array.isArray(evaluationTimeframes) ? evaluationTimeframes : [];
  return list.find((timeframe) => getTimeframeMs(timeframe) >= getTimeframeMs('1m')) ?? '1m';
};

const toFinite = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const findPosition = (snapshot, symbol) =>
  (snapshot?.positions ?? []).find((position) => String(position?.symbol ?? '').toUpperCase() === symbol) ?? null;

const computeMaxDrawdownPct = (events = []) => {
  let peak = null;
  let maxDrawdownPct = 0;

  for (const event of events) {
    const equity = Number(event?.equity);
    if (!Number.isFinite(equity) || equity <= 0) continue;
    peak = peak === null ? equity : Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak);
    }
  }

  return maxDrawdownPct;
};

export class BacktestEngine {
  constructor({
    configStore,
    marketCalendar,
    sourceMarketDataProvider,
    indicatorEngine,
  } = {}) {
    this.configStore = configStore;
    this.marketCalendar = marketCalendar;
    this.sourceMarketDataProvider = sourceMarketDataProvider;
    this.indicatorEngine = indicatorEngine;
    this.sourceRangeCache = new Map();
  }

  async run({
    symbol,
    startMs,
    endMs = Date.now(),
    stepTimeframe = '30m',
    initialCash = 100_000,
    decisionEngine = null,
    brokerOptions = {},
    writeReport = true,
  } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeStartMs = normalizeEpochMs(startMs, 'startMs');
    const safeEndMs = normalizeEpochMs(endMs, 'endMs');
    const safeStepTimeframe = assertTimeframe(stepTimeframe);

    if (safeEndMs <= safeStartMs) {
      throw new Error(`Backtest endMs must be after startMs, received ${safeStartMs} -> ${safeEndMs}`);
    }

    const symbolConfig = this.configStore.getSymbolConfig(safeSymbol);
    const relatedSymbols = this.configStore.getRelatedSymbols(safeSymbol);
    const lookbackBars = Number.isFinite(Number(symbolConfig.lookbackBars)) ? Number(symbolConfig.lookbackBars) : 250;
    const preloadPlan = this.#buildPreloadPlan({
      symbolConfig,
      stepTimeframe: safeStepTimeframe,
      lookbackBars,
    });
    const dataset = await this.#preloadDataset({
      symbols: unique([safeSymbol, ...relatedSymbols]),
      preloadPlan,
      startMs: safeStartMs,
      endMs: safeEndMs,
    });

    const replayMarketDataProvider = new ReplayMarketDataProvider({ dataset });
    const barsRepository = new BarsRepository({
      marketDataProvider: replayMarketDataProvider,
      cacheStore: null,
    });
    const brokerGateway = new SimulatedBrokerGateway({
      initialCash,
      ...brokerOptions,
    });
    const portfolioService = new PortfolioService({
      brokerGateway,
      configStore: this.configStore,
    });
    const featureSnapshotService = new FeatureSnapshotService({
      configStore: this.configStore,
      barsRepository,
      indicatorEngine: this.indicatorEngine,
      marketCalendar: this.marketCalendar,
      portfolioService,
    });
    const executionEngine = new ExecutionEngine({
      brokerGateway,
      portfolioService,
      configStore: this.configStore,
      dryRun: false,
    });
    const effectiveDecisionEngine = decisionEngine ?? new SimpleRuleDecisionEngine({
      symbolProfiles: this.configStore?.getStrategyProfileMap?.() ?? {},
    });
    const timelineBars = await barsRepository.getBars({
      symbol: safeSymbol,
      timeframe: safeStepTimeframe,
      startMs: safeStartMs,
      endMs: safeEndMs,
      preferCache: false,
      limit: Math.ceil((safeEndMs - safeStartMs) / getTimeframeMs(safeStepTimeframe)) + 10,
    });

    if (!timelineBars.length) {
      throw new Error(`No timeline bars available for ${safeSymbol} on ${safeStepTimeframe}`);
    }

    const events = [];
    for (const bar of timelineBars) {
      brokerGateway.setMarketState({
        atMs: bar.endMs,
        symbol: safeSymbol,
        price: bar.close,
      });

      const features = await featureSnapshotService.build({
        symbol: safeSymbol,
        atMs: bar.endMs,
        runtimeMode: 'backtest',
      });
      const decision = await effectiveDecisionEngine.decide({
        symbol: safeSymbol,
        features,
        strategyConfig: symbolConfig,
      });
      const execution = await executionEngine.executeDecision({
        symbol: safeSymbol,
        decision,
        features,
      });
      const portfolioState = await portfolioService.getSnapshot();
      const position = findPosition(portfolioState, safeSymbol);

      events.push({
        atMs: bar.endMs,
        price: features.currentPrice ?? bar.close,
        action: decision.action,
        confidence: decision.confidence,
        reasoning: decision.reasoning ?? [],
        signalContext: decision.signalContext ?? null,
        executionStatus: execution.executionResult.status,
        equity: portfolioState.equity,
        cash: portfolioState.cash,
        exposurePct: portfolioState.exposurePct,
        positionQty: position?.qty ?? 0,
      });
    }

    const finalPortfolioState = await portfolioService.getSnapshot();
    const closedTrades = brokerGateway.getClosedTrades();
    const costSummary = brokerGateway.getCostSummary();
    const costDrag = costSummary.totalFees + costSummary.totalSlippageCost;
    const metrics = {
      initialEquity: initialCash,
      finalEquity: finalPortfolioState.equity,
      netPnl: finalPortfolioState.equity - initialCash,
      netReturnPct: initialCash > 0 ? (finalPortfolioState.equity - initialCash) / initialCash : 0,
      grossPnlBeforeCosts: finalPortfolioState.equity - initialCash + costDrag,
      costDrag,
      totalFees: costSummary.totalFees,
      totalSlippageCost: costSummary.totalSlippageCost,
      stepCount: events.length,
      tradeCount: closedTrades.length,
      wins: closedTrades.filter((trade) => trade.pnl > 0).length,
      losses: closedTrades.filter((trade) => trade.pnl < 0).length,
      winRate: closedTrades.length ? closedTrades.filter((trade) => trade.pnl > 0).length / closedTrades.length : 0,
      maxDrawdownPct: computeMaxDrawdownPct(events),
      openPositions: finalPortfolioState.positions.length,
    };

    const report = {
      runtimeMode: 'backtest',
      symbol: safeSymbol,
      window: {
        startMs: safeStartMs,
        endMs: safeEndMs,
        stepTimeframe: safeStepTimeframe,
      },
      relatedSymbols,
      decisionEngine: effectiveDecisionEngine.constructor?.name ?? 'anonymous-decision-engine',
      costModel: costSummary,
      metrics,
      finalPortfolioState,
      closedTrades,
      events,
      generatedAtMs: Date.now(),
      reportPath: null,
    };

    if (writeReport !== false) {
      report.reportPath = this.#writeReport(report, safeSymbol);
    }

    return report;
  }

  #buildPreloadPlan({ symbolConfig, stepTimeframe, lookbackBars }) {
    const timeframes = Array.isArray(symbolConfig?.timeframes) ? symbolConfig.timeframes : [];
    const evaluationTimeframe = pickHistoricalShortTimeframe(symbolConfig?.evaluationTimeframes);
    const requestedTimeframes = unique([...timeframes, evaluationTimeframe, stepTimeframe]);
    const plan = new Map();

    for (const timeframe of requestedTimeframes) {
      const safeTimeframe = assertTimeframe(timeframe);
      const directTimeframe = this.#resolveDirectTimeframe(safeTimeframe);
      const requiredHistoryMs = getTimeframeMs(safeTimeframe) * Math.max(lookbackBars, 20);
      plan.set(directTimeframe, Math.max(plan.get(directTimeframe) ?? 0, requiredHistoryMs));
    }

    return plan;
  }

  async #preloadDataset({ symbols, preloadPlan, startMs, endMs }) {
    const dataset = {};

    for (const symbol of symbols) {
      dataset[symbol] = {};
      for (const [timeframe, historyMs] of preloadPlan.entries()) {
        const preloadStartMs = Math.max(1, startMs - historyMs);
        dataset[symbol][timeframe] = await this.#fetchRange({
          symbol,
          timeframe,
          startMs: preloadStartMs,
          endMs,
        });
      }
    }

    return dataset;
  }

  async #fetchRange({ symbol, timeframe, startMs, endMs, chunkBars = 8_000 }) {
    const cacheKey = `${symbol}|${timeframe}|${startMs}|${endMs}|${chunkBars}`;
    if (this.sourceRangeCache.has(cacheKey)) {
      return this.sourceRangeCache.get(cacheKey);
    }

    const timeframeMs = getTimeframeMs(timeframe);
    const windowSizeMs = timeframeMs * chunkBars;
    const rows = [];
    const seen = new Set();

    for (let windowStartMs = startMs; windowStartMs < endMs; windowStartMs += windowSizeMs) {
      const windowEndMs = Math.min(endMs, windowStartMs + windowSizeMs);
      const bars = await this.sourceMarketDataProvider.getBars({
        symbol,
        timeframe,
        startMs: windowStartMs,
        endMs: windowEndMs,
        limit: chunkBars,
      });

      for (const bar of bars) {
        const key = `${bar.symbol}:${bar.timeframe}:${bar.startMs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(bar);
      }
    }

    const sorted = sortBars(rows);
    this.sourceRangeCache.set(cacheKey, sorted);
    return sorted;
  }

  #resolveDirectTimeframe(targetTimeframe) {
    if (typeof this.sourceMarketDataProvider?.supportsTimeframe === 'function' && this.sourceMarketDataProvider.supportsTimeframe(targetTimeframe)) {
      return targetTimeframe;
    }

    if (getTimeframeMs(targetTimeframe) < getTimeframeMs('1m')) {
      return '1m';
    }

    const targetMs = getTimeframeMs(targetTimeframe);
    for (const candidate of DIRECT_TIMEFRAME_CANDIDATES) {
      const candidateMs = getTimeframeMs(candidate);
      if (targetMs >= candidateMs && targetMs % candidateMs === 0) {
        if (typeof this.sourceMarketDataProvider?.supportsTimeframe !== 'function' || this.sourceMarketDataProvider.supportsTimeframe(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error(`Unable to resolve a direct timeframe for backtest preload: ${targetTimeframe}`);
  }

  #writeReport(report, symbol) {
    const storage = this.configStore.getStorageConfig();
    const reportsDir = path.resolve(storage.reportsDir, 'backtests');
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.resolve(reportsDir, `backtest-${symbol}-${Date.now()}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return filePath;
  }
}
