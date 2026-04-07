import fs from 'fs';
import path from 'path';
import { getTimeframeMs, normalizeEpochMs, sortBars } from '../market/time.mjs';
import { assertSymbolId, assertTimeframe } from '../types/validators.mjs';
import { BarsRepository } from '../../services/features/BarsRepository.mjs';
import { FeatureSnapshotService } from '../../services/features/FeatureSnapshotService.mjs';
import { PortfolioService } from '../../services/portfolio/PortfolioService.mjs';
import { DailyMarketReportService } from '../../services/reports/DailyMarketReportService.mjs';
import { ExecutionEngine } from '../runtime/ExecutionEngine.mjs';
import { ReplayMarketDataProvider } from './ReplayMarketDataProvider.mjs';
import { SimulatedBrokerGateway } from './SimulatedBrokerGateway.mjs';
import { SimpleRuleDecisionEngine } from './SimpleRuleDecisionEngine.mjs';

const DIRECT_TIMEFRAME_CANDIDATES = ['1d', '1h', '15m', '5m', '1m'];
const MAX_SHORT_BARS = 240;
const MAX_EVENT_BARS = 30;

const unique = (values) => Array.from(new Set(values));

const pickHistoricalShortTimeframe = (evaluationTimeframes = []) => {
  const list = Array.isArray(evaluationTimeframes) ? evaluationTimeframes : [];
  return list.find((timeframe) => getTimeframeMs(timeframe) >= getTimeframeMs('1m')) ?? '1m';
};

const toFinite = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const safeString = (value, fallback = null) => {
  const text = String(value ?? '').trim();
  return text ? text : fallback;
};

const formatSessionDate = (atMs, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));

const compactBar = (bar) => ({
  t: Number.isFinite(Number(bar?.timestamp ?? bar?.endMs)) ? Number(bar.timestamp ?? bar.endMs) : null,
  o: toFiniteOrNull(bar?.open),
  h: toFiniteOrNull(bar?.high),
  l: toFiniteOrNull(bar?.low),
  c: toFiniteOrNull(bar?.close),
  v: toFiniteOrNull(bar?.volume),
});

const compactBars = (bars, limit = MAX_SHORT_BARS) =>
  (Array.isArray(bars) ? bars : [])
    .slice(-limit)
    .map((bar) => compactBar(bar));

const compactTimeframeSnapshot = (snapshot) => ({
  lastClose: toFiniteOrNull(snapshot?.values?.lastClose),
  rsi14: toFiniteOrNull(snapshot?.values?.rsi14),
  atrPct14: toFiniteOrNull(snapshot?.values?.atrPct14),
  priceVsSma20: toFiniteOrNull(snapshot?.values?.priceVsSma20),
  emaGap12_26: toFiniteOrNull(snapshot?.values?.emaGap12_26),
  barCount: Number.isFinite(Number(snapshot?.values?.barCount)) ? Number(snapshot.values.barCount) : 0,
});

const compactTimeframes = (timeframes) => {
  const result = {};
  for (const [timeframe, snapshot] of Object.entries(timeframes ?? {})) {
    result[timeframe] = compactTimeframeSnapshot(snapshot);
  }
  return result;
};

const summarizePosition = (position) => {
  if (!position) return null;
  return {
    symbol: safeString(position.symbol),
    qty: toFiniteOrNull(position.qty),
    entryPrice: toFiniteOrNull(position.entryPrice),
    currentPrice: toFiniteOrNull(position.currentPrice),
    marketValue: toFiniteOrNull(position.marketValue),
    unrealizedPnl: toFiniteOrNull(position.unrealizedPnl),
    openedAtMs: Number.isFinite(Number(position.openedAtMs)) ? Number(position.openedAtMs) : null,
  };
};

const summarizeAccountState = (portfolioState) => ({
  cash: toFiniteOrNull(portfolioState?.cash),
  equity: toFiniteOrNull(portfolioState?.equity),
  exposurePct: toFiniteOrNull(portfolioState?.exposurePct),
  positions: (Array.isArray(portfolioState?.positions) ? portfolioState.positions : []).map((position) => summarizePosition(position)),
});

const isAcceptedExecutionStatus = (status) => ['dry_run', 'accepted', 'filled', 'closed'].includes(String(status ?? ''));

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
    dailyMarketReportService = null,
    now = () => Date.now(),
  } = {}) {
    this.configStore = configStore;
    this.marketCalendar = marketCalendar;
    this.sourceMarketDataProvider = sourceMarketDataProvider;
    this.indicatorEngine = indicatorEngine;
    this.dailyMarketReportService = dailyMarketReportService;
    this.now = typeof now === 'function' ? now : () => Date.now();
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
    const assetClass = safeString(this.configStore.getAssetClass?.(safeSymbol), symbolConfig?.assetClass ?? 'stock');
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
      assetClass,
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
    const entries = [];
    const exits = [];
    const cycleSummaries = [];
    const latestSymbolState = new Map();
    const recordedExecutionEvents = new Set();

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
      const executionIntent = execution.executionIntent ?? null;
      const executionResult = execution.executionResult ?? null;
      const portfolioState = await portfolioService.getSnapshot();
      const position = findPosition(portfolioState, safeSymbol);
      const result = {
        features,
        decision,
        executionIntent,
        executionResult,
      };

      latestSymbolState.set(safeSymbol, result);
      cycleSummaries.push({
        cycle: events.length + 1,
        reason: 'backtest_replay',
        atMs: bar.endMs,
        symbol: safeSymbol,
        ok: true,
        decisionAction: safeString(decision?.action),
        executionStatus: safeString(executionResult?.status),
        marketSession: safeString(features?.marketState?.sessionLabel),
        currentPrice: toFiniteOrNull(features?.currentPrice ?? bar.close),
        error: safeString(executionResult?.error?.message),
      });
      this.#recordExecutionEvents({
        entries,
        exits,
        recordedExecutionEvents,
        symbol: safeSymbol,
        atMs: bar.endMs,
        result,
      });

      events.push({
        atMs: bar.endMs,
        price: features.currentPrice ?? bar.close,
        action: decision.action,
        confidence: decision.confidence,
        reasoning: decision.reasoning ?? [],
        signalContext: decision.signalContext ?? null,
        executionStatus: executionResult?.status,
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

    const timezone = this.configStore.getMarketConfig?.().timezone ?? 'UTC';
    const sessionDate = formatSessionDate(safeEndMs, timezone);
    const llmConfig = this.configStore.getLlmConfig?.() ?? {};
    const wakeupReportService = this.dailyMarketReportService ?? this.#createBacktestDailyMarketReportService({
      portfolioService,
      featureSnapshotService,
    });
    const wakeupReport = wakeupReportService
      ? await wakeupReportService.generate({
          atMs: safeEndMs,
          targetSessionDate: sessionDate,
          symbols: [safeSymbol],
          writeReport: false,
        })
      : null;
    const latestState = latestSymbolState.get(safeSymbol) ?? null;

    const report = {
      type: 'backtest_daily_report',
      reportFamily: 'backtests',
      generatedAtMs: this.now(),
      updatedAtMs: this.now(),
      sessionDate,
      runtimeMode: 'backtest',
      runtime: {
        mode: 'backtest',
        executionDryRun: false,
        llmEnabled: effectiveDecisionEngine?.constructor?.name === 'DecisionEngine',
        llmProvider: effectiveDecisionEngine?.constructor?.name === 'DecisionEngine' ? safeString(llmConfig.provider) : null,
        llmModel: effectiveDecisionEngine?.constructor?.name === 'DecisionEngine' ? safeString(llmConfig.model) : null,
      },
      market: {
        timezone,
        currentState: latestState?.features?.marketState ?? null,
      },
      symbolsTracked: [safeSymbol],
      wakeupReport,
      wakeupReportPath: wakeupReport?.reportPath ?? null,
      accountLatest: summarizeAccountState(finalPortfolioState),
      entries,
      exits,
      cycleSummaries,
      symbols: latestState
        ? {
            [safeSymbol]: this.#buildSymbolReport({
              symbol: safeSymbol,
              result: latestState,
            }),
          }
        : {},
      lastCycleReason: 'backtest_replay',
      lastCompletedCycle: {
        cycle: events.length,
        reason: 'backtest_replay',
        completedAtMs: safeEndMs,
        okCount: events.length,
        totalCount: events.length,
      },
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
      const symbolConfig = this.configStore.getSymbolConfig(symbol);
      const assetClass = safeString(this.configStore.getAssetClass?.(symbol), symbolConfig?.assetClass ?? 'stock');
      dataset[symbol] = {};
      for (const [timeframe, historyMs] of preloadPlan.entries()) {
        const preloadStartMs = Math.max(1, startMs - historyMs);
        dataset[symbol][timeframe] = await this.#fetchRange({
          symbol,
          assetClass,
          timeframe,
          startMs: preloadStartMs,
          endMs,
        });
      }
    }

    return dataset;
  }

  async #fetchRange({ symbol, assetClass = 'stock', timeframe, startMs, endMs, chunkBars = 8_000 }) {
    const cacheKey = `${symbol}|${assetClass}|${timeframe}|${startMs}|${endMs}|${chunkBars}`;
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
        assetClass,
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

  #buildSymbolReport({ symbol, result }) {
    const features = result?.features ?? {};
    return {
      symbol,
      strategyProfile: safeString(this.configStore.getStrategyProfile?.(symbol), 'single_stock'),
      updatedAtMs: Number(features?.atMs ?? this.now()),
      marketState: features.marketState ?? null,
      currentPrice: toFiniteOrNull(features.currentPrice),
      position: summarizePosition(features.position),
      riskState: features.riskState ?? null,
      decision: result?.decision ?? null,
      executionIntent: result?.executionIntent ?? null,
      executionResult: result?.executionResult ?? null,
      shortBars: compactBars(features.shortBars),
      timeframes: compactTimeframes(features.timeframes),
      relatedSymbols: (Array.isArray(features.relatedSymbols) ? features.relatedSymbols : []).map((entry) => ({
        symbol: safeString(entry?.symbol),
        timeframes: compactTimeframes(entry?.timeframes),
      })),
    };
  }

  #recordExecutionEvents({ entries, exits, recordedExecutionEvents, symbol, atMs, result }) {
    const executionIntent = result?.executionIntent ?? null;
    const executionResult = result?.executionResult ?? null;
    if (!executionIntent || !executionResult?.accepted || !isAcceptedExecutionStatus(executionResult.status)) return;

    const eventKey = `${symbol}:${executionIntent.action}:${Number(atMs)}:${safeString(executionResult.status, 'unknown')}`;
    if (recordedExecutionEvents.has(eventKey)) return;
    recordedExecutionEvents.add(eventKey);

    const features = result?.features ?? {};
    const bars = compactBars(features.shortBars, MAX_EVENT_BARS);

    if (executionIntent.action === 'open_long') {
      entries.push({
        atMs: Number(atMs),
        symbol,
        action: 'open_long',
        status: executionResult.status,
        brokerOrderId: safeString(executionResult.brokerOrderId),
        qty: toFiniteOrNull(executionIntent.qty ?? executionResult.filledQty),
        referencePrice: toFiniteOrNull(executionIntent.referencePrice),
        stopLossPct: toFiniteOrNull(executionIntent.stopLossPct),
        reasoning: Array.isArray(result?.decision?.reasoning) ? result.decision.reasoning.slice() : [],
        bars,
      });
      return;
    }

    if (executionIntent.action === 'close_long') {
      const position = features.position ?? null;
      const entryPrice = toFiniteOrNull(position?.entryPrice);
      const qty = toFiniteOrNull(position?.qty ?? executionResult.filledQty);
      const exitPrice = toFiniteOrNull(executionResult.avgFillPrice ?? executionIntent.referencePrice ?? features.currentPrice);
      const pnl = qty !== null && entryPrice !== null && exitPrice !== null ? (exitPrice - entryPrice) * qty : null;
      exits.push({
        atMs: Number(atMs),
        symbol,
        action: 'close_long',
        status: executionResult.status,
        brokerOrderId: safeString(executionResult.brokerOrderId),
        qty,
        entryPrice,
        exitPrice,
        pnl,
        reasoning: Array.isArray(result?.decision?.reasoning) ? result.decision.reasoning.slice() : [],
        bars,
      });
    }
  }

  #createBacktestDailyMarketReportService({ portfolioService, featureSnapshotService }) {
    if (!this.configStore || !this.marketCalendar || !portfolioService || !featureSnapshotService) return null;

    const configStore = {
      getRuntimeConfig: () => ({
        ...(this.configStore.getRuntimeConfig?.() ?? {}),
        mode: 'backtest',
      }),
      getMarketConfig: () => this.configStore.getMarketConfig?.() ?? { timezone: 'UTC' },
      getExecutionConfig: () => ({
        ...(this.configStore.getExecutionConfig?.() ?? {}),
        dryRun: false,
      }),
      getReportsConfig: () => ({
        ...(this.configStore.getReportsConfig?.() ?? {}),
        daily: {
          ...(this.configStore.getReportsConfig?.()?.daily ?? {}),
          includeLlmAnalysis: false,
        },
      }),
      getNewsConfig: () => ({
        ...(this.configStore.getNewsConfig?.() ?? {}),
        enabled: false,
      }),
      getEnabledSymbols: () => this.configStore.getEnabledSymbols?.() ?? [],
      getSymbolConfig: (symbol) => this.configStore.getSymbolConfig?.(symbol) ?? {},
      getStrategyProfile: (symbol) => this.configStore.getStrategyProfile?.(symbol) ?? 'single_stock',
      getRelatedSymbols: (symbol) => this.configStore.getRelatedSymbols?.(symbol) ?? [],
    };

    return new DailyMarketReportService({
      configStore,
      marketCalendar: this.marketCalendar,
      portfolioService,
      featureSnapshotService,
      rssFeedService: null,
      modelClient: null,
      llmConfig: {
        enabled: false,
        provider: null,
        model: null,
      },
    });
  }

  #writeReport(report, symbol) {
    const storage = this.configStore.getStorageConfig();
    const backtestsConfig = this.configStore.getReportsConfig?.()?.backtests ?? {};
    if (backtestsConfig.enabled === false) return null;
    const reportsDir = path.resolve(storage.reportsDir, safeString(backtestsConfig.outputSubdir, 'backtests'));
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.resolve(reportsDir, `backtest-report-${symbol}-${report.sessionDate}-${Date.now()}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return filePath;
  }
}
