import fs from 'fs';
import path from 'path';
import { OllamaDecisionModelClient } from '../../core/llm/OllamaDecisionModelClient.mjs';
import { isFiniteNumber } from '../../core/types/validators.mjs';

const WATCHLIST_BIASES = new Set(['watch_long', 'stand_aside', 'manage_open']);
const MARKET_TONES = new Set(['risk_on', 'mixed', 'risk_off']);
const CHECK_STATUSES = new Set(['ready', 'watch', 'block']);

const safeString = (value, fallback = null) => {
  const text = String(value ?? '').trim();
  return text ? text : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const parseJsonLike = (value) => {
  if (typeof value === 'string') return JSON.parse(value);
  if (value && typeof value === 'object') return value;
  throw new Error('Structured report payload must be a JSON string or object');
};

const limitStrings = (value, maxItems = 5) =>
  (Array.isArray(value) ? value : [])
    .map((entry) => safeString(entry))
    .filter(Boolean)
    .slice(0, maxItems);

const compactTimeframe = (snapshot) => ({
  lastClose: isFiniteNumber(snapshot?.values?.lastClose) ? snapshot.values.lastClose : null,
  rsi14: isFiniteNumber(snapshot?.values?.rsi14) ? snapshot.values.rsi14 : null,
  atrPct14: isFiniteNumber(snapshot?.values?.atrPct14) ? snapshot.values.atrPct14 : null,
  priceVsSma20: isFiniteNumber(snapshot?.values?.priceVsSma20) ? snapshot.values.priceVsSma20 : null,
  emaGap12_26: isFiniteNumber(snapshot?.values?.emaGap12_26) ? snapshot.values.emaGap12_26 : null,
  barCount: Number.isFinite(Number(snapshot?.values?.barCount)) ? Number(snapshot.values.barCount) : 0,
});

const averageRelatedMetric = (relatedSymbols, timeframe, key) => {
  const values = (Array.isArray(relatedSymbols) ? relatedSymbols : [])
    .map((entry) => entry?.timeframes?.[timeframe]?.values?.[key])
    .filter((entry) => isFiniteNumber(entry));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const summarizePosition = (position) => {
  if (!position) return null;
  return {
    symbol: safeString(position.symbol),
    qty: isFiniteNumber(position.qty) ? position.qty : null,
    entryPrice: isFiniteNumber(position.entryPrice) ? position.entryPrice : null,
    currentPrice: isFiniteNumber(position.currentPrice) ? position.currentPrice : null,
    marketValue: isFiniteNumber(position.marketValue) ? position.marketValue : null,
    unrealizedPnl: isFiniteNumber(position.unrealizedPnl) ? position.unrealizedPnl : null,
  };
};

const summarizeWatchlistSnapshot = ({ snapshot, strategyConfig = {} }) => {
  const relatedSymbols = Array.isArray(snapshot?.relatedSymbols) ? snapshot.relatedSymbols : [];
  return {
    symbol: safeString(snapshot?.symbol),
    assetClass: safeString(snapshot?.assetClass, 'stock'),
    strategyProfile: safeString(strategyConfig?.strategyProfile, 'single_stock'),
    currentPrice: isFiniteNumber(snapshot?.currentPrice) ? snapshot.currentPrice : null,
    marketState: snapshot?.marketState ?? null,
    position: summarizePosition(snapshot?.position),
    riskState: snapshot?.riskState ?? null,
    timeframes: {
      '5m': compactTimeframe(snapshot?.timeframes?.['5m']),
      '1h': compactTimeframe(snapshot?.timeframes?.['1h']),
      '4h': compactTimeframe(snapshot?.timeframes?.['4h']),
      '1d': compactTimeframe(snapshot?.timeframes?.['1d']),
    },
    relatedContext: {
      oneHourTrend: averageRelatedMetric(relatedSymbols, '1h', 'emaGap12_26'),
      oneHourRsi: averageRelatedMetric(relatedSymbols, '1h', 'rsi14'),
      fourHourTrend: averageRelatedMetric(relatedSymbols, '4h', 'emaGap12_26'),
      fourHourRsi: averageRelatedMetric(relatedSymbols, '4h', 'rsi14'),
    },
  };
};

const summarizeNews = (feeds) =>
  feeds.map((feed) => ({
    feedId: safeString(feed.feedId),
    name: safeString(feed.name),
    url: safeString(feed.url),
    status: safeString(feed.status, 'error'),
    error: safeString(feed.error),
    fetchedAtMs: Number.isFinite(Number(feed.fetchedAtMs)) ? Number(feed.fetchedAtMs) : null,
    itemCount: Number.isFinite(Number(feed.itemCount)) ? Number(feed.itemCount) : 0,
    source: safeString(feed.source),
    items: (Array.isArray(feed.items) ? feed.items : []).slice(0, 5).map((item) => ({
      title: safeString(item.title),
      link: safeString(item.link),
      publishedAt: safeString(item.publishedAt),
      summary: safeString(item.summary),
    })),
  }));

const trimText = (value, maxLength = 140) => {
  const text = safeString(value, '') ?? '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const normalizeWatchEntry = (entry, allowedSymbols) => {
  const symbol = safeString(entry?.symbol);
  if (!symbol || !allowedSymbols.has(symbol)) return null;
  const bias = safeString(entry?.bias, 'stand_aside');
  const normalizedBias = WATCHLIST_BIASES.has(bias) ? bias : 'stand_aside';
  const confidence = isFiniteNumber(entry?.confidence) ? clamp(entry.confidence, 0, 1) : 0.5;
  const note = safeString(entry?.note, '');
  return {
    symbol,
    bias: normalizedBias,
    confidence,
    note,
  };
};

const normalizeChecklistEntry = (entry) => {
  const item = safeString(entry?.item);
  if (!item) return null;
  const status = safeString(entry?.status, 'watch');
  return {
    item,
    status: CHECK_STATUSES.has(status) ? status : 'watch',
    note: safeString(entry?.note, ''),
  };
};

const normalizeAnalysis = (raw, watchlistSymbols) => {
  const parsed = parseJsonLike(raw);
  const allowedSymbols = new Set(watchlistSymbols);
  const marketTone = safeString(parsed?.marketTone, 'mixed');
  return {
    marketTone: MARKET_TONES.has(marketTone) ? marketTone : 'mixed',
    summary: safeString(parsed?.summary, 'No summary produced.'),
    keyRisks: limitStrings(parsed?.keyRisks, 5),
    keyCatalysts: limitStrings(parsed?.keyCatalysts, 5),
    watchlist: (Array.isArray(parsed?.watchlist) ? parsed.watchlist : [])
      .map((entry) => normalizeWatchEntry(entry, allowedSymbols))
      .filter(Boolean)
      .slice(0, watchlistSymbols.length),
    preOpenChecklist: (Array.isArray(parsed?.preOpenChecklist) ? parsed.preOpenChecklist : [])
      .map((entry) => normalizeChecklistEntry(entry))
      .filter(Boolean)
      .slice(0, 8),
  };
};

const inferBias = (entry) => {
  if (entry?.position) return 'manage_open';
  const fast = entry?.timeframes?.['5m'] ?? {};
  const medium = entry?.timeframes?.['1h'] ?? {};
  const related = entry?.relatedContext ?? {};
  if (
    (medium.emaGap12_26 ?? -1) > 0 &&
    (medium.rsi14 ?? 0) >= 48 &&
    (related.oneHourTrend ?? -1) >= 0 &&
    (fast.rsi14 ?? 0) >= 42 &&
    (fast.rsi14 ?? 100) <= 60
  ) {
    return 'watch_long';
  }
  return 'stand_aside';
};

const inferMarketTone = (watchlist) => {
  let score = 0;
  for (const entry of watchlist) {
    const medium = entry?.timeframes?.['1h'] ?? {};
    const related = entry?.relatedContext ?? {};
    if ((medium.emaGap12_26 ?? -1) > 0) score += 1;
    if ((medium.rsi14 ?? 0) >= 50) score += 1;
    if ((related.oneHourTrend ?? -1) > 0) score += 1;
  }

  if (score >= Math.max(4, watchlist.length * 1.5)) return 'risk_on';
  if (score <= 0) return 'risk_off';
  return 'mixed';
};

const buildFallbackAnalysis = ({ watchlist, newsFeeds, portfolioState, runtime, llmError = null }) => {
  const positiveSymbols = watchlist.filter((entry) => inferBias(entry) === 'watch_long').map((entry) => entry.symbol);
  const keyCatalysts = newsFeeds
    .flatMap((feed) => feed.items ?? [])
    .map((item) => safeString(item.title))
    .filter(Boolean)
    .slice(0, 5);
  const keyRisks = [];
  if (llmError) keyRisks.push(`llm_fallback:${llmError}`);
  if ((portfolioState?.exposurePct ?? 0) > 0.35) keyRisks.push('portfolio_exposure_elevated');
  if (runtime?.executionDryRun) keyRisks.push('execution_still_dry_run');
  if (newsFeeds.some((feed) => feed.status !== 'ok')) keyRisks.push('rss_feed_partial_failure');
  const isBacktest = safeString(runtime?.runtimeMode) === 'backtest';

  const preOpenChecklist = [
    {
      item: isBacktest ? 'Backtest simulated broker' : 'Alpaca paper connectivity',
      status: portfolioState?.error ? 'block' : 'ready',
      note: portfolioState?.error ?? (isBacktest ? 'Simulated broker and portfolio replay are ready.' : 'Paper account reachable.'),
    },
    {
      item: 'Ollama structured report',
      status: isBacktest ? 'ready' : (llmError ? 'watch' : 'ready'),
      note: isBacktest ? 'Historical wake-up analysis is running in deterministic fallback mode.' : (llmError ?? 'Structured JSON report generation ready.'),
    },
    {
      item: 'Execution safety mode',
      status: runtime?.executionDryRun ? 'watch' : 'ready',
      note: runtime?.executionDryRun
        ? 'Dry-run still enabled. Switch off explicitly before a live paper order test.'
        : (isBacktest ? 'Backtest execution is simulated and can route fills inside the replay engine.' : 'Paper execution can route orders.'),
    },
  ];

  return {
    marketTone: inferMarketTone(watchlist),
    summary: positiveSymbols.length
      ? `Positive momentum candidates are currently concentrated in ${positiveSymbols.join(', ')}.`
      : 'No strong long candidate stands out right now; the watchlist is mostly defensive.',
    keyRisks: keyRisks.slice(0, 5),
    keyCatalysts,
    watchlist: watchlist.map((entry) => ({
      symbol: entry.symbol,
      bias: inferBias(entry),
      confidence: inferBias(entry) === 'watch_long' ? 0.58 : 0.46,
      note: entry.position ? 'Existing position should be managed, not chased.' : 'Heuristic fallback generated without LLM.',
    })),
    preOpenChecklist,
  };
};

const buildCompactLlmWatchlist = (watchlist) =>
  watchlist.map((entry) => ({
    symbol: entry.symbol,
    strategyProfile: entry.strategyProfile,
    currentPrice: entry.currentPrice,
    hasPosition: Boolean(entry.position),
    timeframes: {
      '5m': {
        rsi14: entry?.timeframes?.['5m']?.rsi14 ?? null,
        priceVsSma20: entry?.timeframes?.['5m']?.priceVsSma20 ?? null,
        emaGap12_26: entry?.timeframes?.['5m']?.emaGap12_26 ?? null,
      },
      '1h': {
        rsi14: entry?.timeframes?.['1h']?.rsi14 ?? null,
        emaGap12_26: entry?.timeframes?.['1h']?.emaGap12_26 ?? null,
      },
      '4h': {
        rsi14: entry?.timeframes?.['4h']?.rsi14 ?? null,
        emaGap12_26: entry?.timeframes?.['4h']?.emaGap12_26 ?? null,
      },
      '1d': {
        rsi14: entry?.timeframes?.['1d']?.rsi14 ?? null,
        emaGap12_26: entry?.timeframes?.['1d']?.emaGap12_26 ?? null,
      },
    },
    relatedContext: {
      oneHourTrend: entry?.relatedContext?.oneHourTrend ?? null,
      oneHourRsi: entry?.relatedContext?.oneHourRsi ?? null,
      fourHourTrend: entry?.relatedContext?.fourHourTrend ?? null,
      fourHourRsi: entry?.relatedContext?.fourHourRsi ?? null,
    },
  }));

const buildCompactLlmNews = (newsFeeds) =>
  newsFeeds
    .filter((feed) => feed.status === 'ok')
    .map((feed) => ({
      feedId: feed.feedId,
      name: feed.name,
      items: (feed.items ?? []).slice(0, 2).map((item) => ({
        title: trimText(item.title, 140),
        publishedAt: item.publishedAt,
      })),
    }));

const formatDateParts = (atMs, timezone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(atMs));
};

export class DailyMarketReportService {
  constructor({
    configStore,
    marketCalendar,
    portfolioService,
    featureSnapshotService,
    rssFeedService,
    modelClient = null,
    llmConfig = {},
  } = {}) {
    this.configStore = configStore;
    this.marketCalendar = marketCalendar;
    this.portfolioService = portfolioService;
    this.featureSnapshotService = featureSnapshotService;
    this.rssFeedService = rssFeedService;
    this.modelClient = modelClient;
    this.llmConfig = llmConfig;
  }

  async generate({
    atMs = Date.now(),
    targetSessionDate = null,
    symbols = null,
    writeReport = true,
    includeLlmAnalysis = null,
  } = {}) {
    const runtime = this.configStore.getRuntimeConfig();
    const marketConfig = this.configStore.getMarketConfig();
    const reportsConfig = this.configStore.getReportsConfig()?.daily ?? {};
    const newsConfig = this.configStore.getNewsConfig() ?? {};
    const resolvedTargetSessionDate = safeString(targetSessionDate, formatDateParts(atMs, marketConfig.timezone));
    const watchlistSymbols = this.#resolveWatchlistSymbols(symbols, reportsConfig);

    let portfolioState = null;
    let portfolioError = null;
    try {
      portfolioState = await this.portfolioService.getSnapshot();
    } catch (error) {
      portfolioError = error?.message ?? 'portfolio_snapshot_failed';
      portfolioState = {
        cash: 0,
        equity: 0,
        exposurePct: 0,
        positions: [],
        error: portfolioError,
      };
    }

    const newsFeeds = newsConfig.enabled !== false && this.rssFeedService
      ? summarizeNews(await this.rssFeedService.fetchAll({ maxItemsPerFeed: reportsConfig.maxNewsItemsPerFeed ?? newsConfig.maxItemsPerFeed ?? 5 }))
      : [];

    const watchlist = [];
    for (const symbol of watchlistSymbols) {
      try {
        const snapshot = await this.featureSnapshotService.build({
          symbol,
          atMs,
          runtimeMode: runtime.mode,
          portfolioState,
        });
        watchlist.push(
          summarizeWatchlistSnapshot({
            snapshot,
            strategyConfig: this.configStore.getSymbolConfig(symbol),
          }),
        );
      } catch (error) {
        watchlist.push({
          symbol,
          strategyProfile: safeString(this.configStore.getStrategyProfile(symbol), 'single_stock'),
          currentPrice: null,
          marketState: this.marketCalendar.getMarketState(atMs),
          position: summarizePosition((portfolioState?.positions ?? []).find((entry) => entry.symbol === symbol) ?? null),
          riskState: null,
          timeframes: {
            '5m': compactTimeframe(null),
            '1h': compactTimeframe(null),
            '4h': compactTimeframe(null),
            '1d': compactTimeframe(null),
          },
          relatedContext: {
            oneHourTrend: null,
            oneHourRsi: null,
            fourHourTrend: null,
            fourHourRsi: null,
          },
          error: error?.message ?? 'feature_snapshot_failed',
        });
      }
    }

    const llm = await this.#buildAnalysis({
      atMs,
      targetSessionDate: resolvedTargetSessionDate,
      watchlist,
      newsFeeds,
      portfolioState,
      includeLlmAnalysis: includeLlmAnalysis ?? reportsConfig.includeLlmAnalysis !== false,
    });

    const report = {
      type: 'daily_market_report',
      generatedAtMs: Date.now(),
      reportDate: resolvedTargetSessionDate,
      runtime: {
        mode: runtime.mode,
        executionDryRun: this.configStore.getExecutionConfig().dryRun,
        llmEnabled: this.llmConfig.enabled === true,
        llmProvider: this.llmConfig.provider,
        llmModel: this.llmConfig.model,
      },
      market: {
        timezone: marketConfig.timezone,
        currentState: this.marketCalendar.getMarketState(atMs),
        targetSessionDate: resolvedTargetSessionDate,
        targetSessionOpenLocal: '09:30',
        targetWakeupLocal: '08:45',
      },
      account: {
        cash: portfolioState.cash,
        equity: portfolioState.equity,
        exposurePct: portfolioState.exposurePct,
        positionCount: Array.isArray(portfolioState.positions) ? portfolioState.positions.length : 0,
        positions: (Array.isArray(portfolioState.positions) ? portfolioState.positions : []).map((entry) => summarizePosition(entry)),
        error: portfolioError,
      },
      news: {
        feedCount: newsFeeds.length,
        okFeedCount: newsFeeds.filter((entry) => entry.status === 'ok').length,
        feeds: newsFeeds,
      },
      watchlist,
      llm,
      reportPath: null,
    };

    if (writeReport !== false) {
      report.reportPath = this.#writeReport(report, reportsConfig.outputSubdir, resolvedTargetSessionDate);
    }

    return report;
  }

  #resolveWatchlistSymbols(symbols, reportsConfig) {
    if (Array.isArray(symbols) && symbols.length) {
      return symbols.map((entry) => String(entry).toUpperCase()).filter(Boolean);
    }

    if (Array.isArray(reportsConfig.watchlistSymbols) && reportsConfig.watchlistSymbols.length) {
      return reportsConfig.watchlistSymbols.map((entry) => String(entry).toUpperCase()).filter(Boolean);
    }

    return this.configStore.getEnabledSymbols();
  }

  async #buildAnalysis({ atMs, targetSessionDate, watchlist, newsFeeds, portfolioState, includeLlmAnalysis }) {
    const runtime = {
      executionDryRun: this.configStore.getExecutionConfig().dryRun,
      runtimeMode: this.configStore.getRuntimeConfig().mode,
    };
    const fallback = buildFallbackAnalysis({
      watchlist,
      newsFeeds,
      portfolioState,
      runtime,
    });

    if (!includeLlmAnalysis || this.llmConfig.enabled !== true || !this.modelClient || typeof this.modelClient.generateJson !== 'function') {
      return {
        provider: this.llmConfig.provider,
        model: this.llmConfig.model,
        status: 'fallback',
        error: this.llmConfig.enabled === true ? 'structured_model_client_unavailable' : 'llm_disabled',
        analysis: fallback,
      };
    }

    try {
      const reportTimeoutMs = Number(this.configStore.getReportsConfig()?.daily?.llmTimeoutMs);
      const reportModelClient =
        this.llmConfig.provider === 'ollama' && Number.isFinite(reportTimeoutMs) && reportTimeoutMs > 0
          ? new OllamaDecisionModelClient({
              ...this.llmConfig,
              timeoutMs: reportTimeoutMs,
            })
          : this.modelClient;
      const raw = await reportModelClient.generateJson({
        systemPrompt: [
          'You are a pre-market paper trading briefing engine.',
          'Return strict JSON only.',
          'Do not invent facts beyond the provided inputs.',
          'Allowed marketTone values: risk_on, mixed, risk_off.',
          'Allowed watchlist bias values: watch_long, stand_aside, manage_open.',
          'Allowed checklist statuses: ready, watch, block.',
          'Expected JSON shape:',
          JSON.stringify({
            marketTone: 'risk_on | mixed | risk_off',
            summary: 'string',
            keyRisks: ['short strings'],
            keyCatalysts: ['short strings'],
            watchlist: [{ symbol: 'ticker', bias: 'watch_long | stand_aside | manage_open', confidence: 0.5, note: 'string' }],
            preOpenChecklist: [{ item: 'string', status: 'ready | watch | block', note: 'string' }],
          }),
        ].join('\n'),
        userPrompt: JSON.stringify(
          {
            generatedAtMs: atMs,
            targetSessionDate,
            runtime,
            marketState: this.marketCalendar.getMarketState(atMs),
            account: {
              cash: portfolioState.cash,
              equity: portfolioState.equity,
              exposurePct: portfolioState.exposurePct,
              positionCount: Array.isArray(portfolioState.positions) ? portfolioState.positions.length : 0,
            },
            watchlist: buildCompactLlmWatchlist(watchlist),
            newsFeeds: buildCompactLlmNews(newsFeeds),
          },
          null,
          2,
        ),
      });

      return {
        provider: this.llmConfig.provider,
        model: this.llmConfig.model,
        status: 'ready',
        error: null,
        analysis: normalizeAnalysis(raw, watchlist.map((entry) => entry.symbol)),
      };
    } catch (error) {
      return {
        provider: this.llmConfig.provider,
        model: this.llmConfig.model,
        status: 'fallback',
        error: error?.message ?? 'daily_report_llm_failed',
        analysis: buildFallbackAnalysis({
          watchlist,
          newsFeeds,
          portfolioState,
          runtime,
          llmError: error?.message ?? 'daily_report_llm_failed',
        }),
      };
    }
  }

  #writeReport(report, outputSubdir = 'daily', targetSessionDate) {
    const storage = this.configStore.getStorageConfig();
    const reportsDir = path.resolve(storage.reportsDir, outputSubdir || 'daily');
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.resolve(reportsDir, `daily-report-${targetSessionDate}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return filePath;
  }
}
