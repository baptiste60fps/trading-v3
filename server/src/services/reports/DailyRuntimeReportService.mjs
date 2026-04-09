import fs from 'fs';
import path from 'path';

const MAX_SHORT_BARS = 240;
const MAX_EVENT_BARS = 30;
const MAX_CYCLE_SUMMARIES = 10_000;

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
  t: Number.isFinite(Number(bar?.timestamp)) ? Number(bar.timestamp) : null,
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

const isAcceptedExecutionStatus = (status) => ['dry_run', 'accepted', 'filled', 'closed'].includes(String(status ?? ''));

const clone = (value) => JSON.parse(JSON.stringify(value));

export class DailyRuntimeReportService {
  constructor({
    configStore,
    dailyMarketReportService = null,
    dailyGitCommitService = null,
    now = () => Date.now(),
  } = {}) {
    this.configStore = configStore;
    this.dailyMarketReportService = dailyMarketReportService;
    this.dailyGitCommitService = dailyGitCommitService;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.currentSession = null;
    this.recordedEvents = new Set();
    this.recordedCycleKeys = new Set();
  }

  async onCycleStarted({ atMs = this.now(), symbols = [], reason = 'scheduled', runtimeMode = null } = {}) {
    const session = await this.#ensureSession({
      atMs,
      symbols,
      runtimeMode,
    });
    session.report.lastCycleReason = safeString(reason, 'scheduled');
    session.report.updatedAtMs = this.now();
    this.#writeCurrentReport();
    return session.report;
  }

  async onStrategyEvaluated({
    symbol,
    atMs = this.now(),
    cycle = null,
    reason = 'scheduled',
    ok = false,
    result = null,
    summary = null,
    error = null,
  } = {}) {
    const session = await this.#ensureSession({
      atMs,
      symbols: symbol ? [symbol] : [],
    });

    const safeSymbol = safeString(symbol, 'UNKNOWN');
    const report = session.report;
    report.updatedAtMs = this.now();
    report.symbolsTracked = Array.from(new Set([...(report.symbolsTracked ?? []), safeSymbol])).sort();

    const cycleKey = `${session.sessionDate}:${cycle ?? 'na'}:${safeSymbol}:${Number(atMs)}`;
    if (!this.recordedCycleKeys.has(cycleKey)) {
      this.recordedCycleKeys.add(cycleKey);
      report.cycleSummaries.push({
        cycle,
        reason,
        atMs,
        symbol: safeSymbol,
        ok: ok === true,
        decisionAction: safeString(summary?.decisionAction ?? result?.decision?.action),
        decisionReasoning: Array.isArray(result?.decision?.reasoning) ? result.decision.reasoning.slice(0, 5) : [],
        executionStatus: safeString(summary?.executionStatus ?? result?.executionResult?.status),
        executionErrorCategory: safeString(result?.executionResult?.error?.category),
        executionErrorMessage: safeString(result?.executionResult?.error?.message),
        marketSession: safeString(summary?.marketSession ?? result?.features?.marketState?.sessionLabel),
        currentPrice: toFiniteOrNull(summary?.currentPrice ?? result?.features?.currentPrice),
        error: safeString(error?.message ?? error ?? summary?.error ?? result?.executionResult?.error?.message),
      });
      if (report.cycleSummaries.length > MAX_CYCLE_SUMMARIES) {
        report.cycleSummaries.splice(0, report.cycleSummaries.length - MAX_CYCLE_SUMMARIES);
      }
    }

    if (ok && result) {
      const features = result.features ?? {};
      report.market.currentState = features.marketState ?? report.market.currentState;
      const portfolioState = features.portfolioState ?? null;
      if (portfolioState) {
        report.accountLatest = {
          cash: toFiniteOrNull(portfolioState.cash),
          equity: toFiniteOrNull(portfolioState.equity),
          exposurePct: toFiniteOrNull(portfolioState.exposurePct),
          positions: (Array.isArray(portfolioState.positions) ? portfolioState.positions : []).map((position) => summarizePosition(position)),
        };
      }

      report.symbols[safeSymbol] = {
        symbol: safeSymbol,
        assetClass: safeString(features.assetClass, 'stock'),
        strategyProfile: safeString(this.configStore.getStrategyProfile?.(safeSymbol), 'single_stock'),
        updatedAtMs: Number(atMs),
        marketState: features.marketState ?? null,
        currentPrice: toFiniteOrNull(features.currentPrice),
        position: summarizePosition(features.position),
        riskState: features.riskState ?? null,
        decision: result.decision ?? null,
        executionIntent: result.executionIntent ?? null,
        executionResult: result.executionResult ?? null,
        shortBars: compactBars(features.shortBars),
        timeframes: compactTimeframes(features.timeframes),
        relatedSymbols: (Array.isArray(features.relatedSymbols) ? features.relatedSymbols : []).map((entry) => ({
          symbol: safeString(entry?.symbol),
          timeframes: compactTimeframes(entry?.timeframes),
        })),
      };

      this.#recordExecutionEvents({
        report,
        symbol: safeSymbol,
        atMs,
        result,
      });
    } else {
      report.symbols[safeSymbol] = {
        ...(report.symbols[safeSymbol] ?? { symbol: safeSymbol }),
        updatedAtMs: Number(atMs),
        error: safeString(error?.message ?? error ?? summary?.error),
      };
    }

    this.#writeCurrentReport();
    return clone(report);
  }

  async onCycleCompleted({ cycle = null, completedAtMs = this.now(), reason = 'scheduled', results = [] } = {}) {
    const session = await this.#ensureSession({ atMs: completedAtMs });
    session.report.updatedAtMs = this.now();
    session.report.lastCompletedCycle = {
      cycle,
      reason,
      completedAtMs,
      okCount: (Array.isArray(results) ? results : []).filter((entry) => entry?.ok).length,
      totalCount: Array.isArray(results) ? results.length : 0,
    };
    this.#writeCurrentReport();
    return clone(session.report);
  }

  getCurrentReport() {
    return this.currentSession?.report ? clone(this.currentSession.report) : null;
  }

  async flushCurrentSessionGitCommit() {
    if (!this.currentSession?.report) {
      return { committed: false, skipped: true, reason: 'no_current_session' };
    }
    return await this.#commitSessionArtifacts(this.currentSession.report);
  }

  async #ensureSession({ atMs = this.now(), symbols = [], runtimeMode = null } = {}) {
    const timezone = this.configStore.getMarketConfig().timezone;
    const sessionDate = formatSessionDate(atMs, timezone);

    if (this.currentSession?.sessionDate === sessionDate) {
      this.#mergeSymbols(symbols);
      return this.currentSession;
    }

    if (this.currentSession?.report) {
      await this.#commitSessionArtifacts(this.currentSession.report);
    }

    this.recordedEvents.clear();
    this.recordedCycleKeys.clear();

    const wakeupReport = this.dailyMarketReportService
      ? await this.dailyMarketReportService.generate({
          atMs,
          targetSessionDate: sessionDate,
          symbols: Array.isArray(symbols) && symbols.length ? symbols : undefined,
          writeReport: true,
        })
      : null;

    const report = {
      type: 'runtime_daily_report',
      generatedAtMs: this.now(),
      updatedAtMs: this.now(),
      sessionDate,
      runtime: {
        mode: runtimeMode ?? this.configStore.getRuntimeConfig().mode,
        executionDryRun: this.configStore.getExecutionConfig().dryRun,
        llmEnabled: this.configStore.getLlmConfig().enabled === true,
        llmProvider: this.configStore.getLlmConfig().provider,
        llmModel: this.configStore.getLlmConfig().model,
      },
      market: {
        timezone,
        currentState: null,
      },
      symbolsTracked: Array.isArray(symbols) && symbols.length
        ? Array.from(new Set(symbols.map((entry) => String(entry).toUpperCase()))).sort()
        : this.configStore.getEnabledSymbols(),
      wakeupReport,
      wakeupReportPath: wakeupReport?.reportPath ?? null,
      accountLatest: null,
      entries: [],
      exits: [],
      cycleSummaries: [],
      symbols: {},
      lastCycleReason: null,
      lastCompletedCycle: null,
      reportPath: null,
    };

    this.currentSession = {
      sessionDate,
      report,
    };
    this.#writeCurrentReport();
    return this.currentSession;
  }

  #mergeSymbols(symbols) {
    if (!this.currentSession?.report || !Array.isArray(symbols) || !symbols.length) return;
    this.currentSession.report.symbolsTracked = Array.from(
      new Set([
        ...(this.currentSession.report.symbolsTracked ?? []),
        ...symbols.map((entry) => String(entry).toUpperCase()),
      ]),
    ).sort();
  }

  #recordExecutionEvents({ report, symbol, atMs, result }) {
    const executionIntent = result?.executionIntent ?? null;
    const executionResult = result?.executionResult ?? null;
    if (!executionIntent || !executionResult?.accepted || !isAcceptedExecutionStatus(executionResult.status)) return;

    const eventKey = `${symbol}:${executionIntent.action}:${Number(atMs)}:${safeString(executionResult.status, 'unknown')}`;
    if (this.recordedEvents.has(eventKey)) return;
    this.recordedEvents.add(eventKey);

    const features = result?.features ?? {};
    const bars = compactBars(features.shortBars, MAX_EVENT_BARS);

    if (executionIntent.action === 'open_long') {
      report.entries.push({
        atMs: Number(atMs),
        symbol,
        assetClass: safeString(features.assetClass, 'stock'),
        action: 'open_long',
        status: executionResult.status,
        brokerOrderId: safeString(executionResult.brokerOrderId),
        qty: toFiniteOrNull(executionIntent.qty),
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
      const qty = toFiniteOrNull(position?.qty);
      const exitPrice = toFiniteOrNull(executionResult.avgFillPrice ?? executionIntent.referencePrice ?? features.currentPrice);
      const pnl = qty !== null && entryPrice !== null && exitPrice !== null ? (exitPrice - entryPrice) * qty : null;
      report.exits.push({
        atMs: Number(atMs),
        symbol,
        assetClass: safeString(features.assetClass, 'stock'),
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

  #writeCurrentReport() {
    if (!this.currentSession?.report) return null;
    const reportsConfig = this.configStore.getReportsConfig?.() ?? {};
    const runtimeDailyConfig = reportsConfig.runtimeDaily ?? {};
    if (runtimeDailyConfig.enabled === false) return null;

    const storage = this.configStore.getStorageConfig();
    const outputSubdir = safeString(runtimeDailyConfig.outputSubdir, 'runtime-daily');
    const reportsDir = path.resolve(storage.reportsDir, outputSubdir);
    fs.mkdirSync(reportsDir, { recursive: true });
    const filePath = path.resolve(reportsDir, `runtime-report-${this.currentSession.sessionDate}.json`);
    this.currentSession.report.reportPath = filePath;
    fs.writeFileSync(filePath, `${JSON.stringify(this.currentSession.report, null, 2)}\n`, 'utf8');
    return filePath;
  }

  async #commitSessionArtifacts(report) {
    if (!this.dailyGitCommitService?.commitArtifacts || !report) {
      return { committed: false, skipped: true, reason: 'service_unavailable' };
    }

    const gitConfig = this.configStore.getGitConfig?.() ?? {};
    const storage = this.configStore.getStorageConfig?.() ?? {};
    const paths = [
      report.reportPath,
      report.wakeupReportPath,
      gitConfig.includeRuntimeSessionState !== false
        ? path.resolve(storage.runsDir ?? path.resolve(process.cwd(), 'storage/runs'), `runtime-session-${report.sessionDate}.json`)
        : null,
    ].filter(Boolean);

    return await this.dailyGitCommitService.commitArtifacts({
      sessionDate: report.sessionDate,
      runtimeMode: report.runtime?.mode ?? null,
      symbols: report.symbolsTracked ?? [],
      paths,
    });
  }
}
