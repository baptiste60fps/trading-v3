const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  clear: '\x1b[2J',
  home: '\x1b[H',
};

const toFiniteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const colorize = (value, color, enabled) => {
  if (!enabled || !color) return value;
  return `${ANSI[color]}${value}${ANSI.reset}`;
};

const formatMoney = (value) => {
  const numeric = toFiniteOrNull(value);
  return numeric === null ? 'n/a' : `${numeric.toFixed(2)}$`;
};

const formatSignedMoney = (value, colors = true) => {
  const numeric = toFiniteOrNull(value);
  if (numeric === null) return 'n/a';
  const sign = numeric > 0 ? '+' : '';
  const rendered = `${sign}${numeric.toFixed(2)}$`;
  if (numeric > 0) return colorize(rendered, 'green', colors);
  if (numeric < 0) return colorize(rendered, 'red', colors);
  return colorize(rendered, 'dim', colors);
};

const formatSignedPct = (value, colors = true) => {
  const numeric = toFiniteOrNull(value);
  if (numeric === null) return 'n/a';
  const percent = numeric * 100;
  const sign = percent > 0 ? '+' : '';
  const rendered = `${sign}${percent.toFixed(2)}%`;
  if (percent > 0) return colorize(rendered, 'green', colors);
  if (percent < 0) return colorize(rendered, 'red', colors);
  return colorize(rendered, 'dim', colors);
};

const formatPct = (value) => {
  const numeric = toFiniteOrNull(value);
  return numeric === null ? 'n/a' : `${(numeric * 100).toFixed(2)}%`;
};

const formatQty = (value) => {
  const numeric = toPositiveFiniteOrNull(value);
  return numeric === null ? 'n/a' : numeric.toFixed(6);
};

const stripAnsi = (value) => String(value ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const truncate = (value, maxLength) => {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}\u2026`;
};
const padCell = (value, width) => {
  const text = String(value ?? '');
  const visibleLength = stripAnsi(text).length;
  if (visibleLength >= width) return truncate(text, width);
  return `${text}${' '.repeat(width - visibleLength)}`;
};

const formatTimestamp = (atMs, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date(atMs))
    .replace(',', '');

const formatSessionDate = (atMs, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));

const resolveStopPrice = (referencePrice, stopLossPct) => {
  const safeReferencePrice = toPositiveFiniteOrNull(referencePrice);
  const safeStopLossPct = toPositiveFiniteOrNull(stopLossPct);
  if (safeReferencePrice === null || safeStopLossPct === null) return null;
  const stopPrice = Math.min(safeReferencePrice * (1 - safeStopLossPct), safeReferencePrice - 0.01);
  return stopPrice > 0 ? stopPrice : null;
};

const isAcceptedExecutionStatus = (status) => ['dry_run', 'accepted', 'filled', 'closed'].includes(String(status ?? ''));
const extractDecisionFallbackReason = (decision) => {
  const entries = Array.isArray(decision?.reasoning) ? decision.reasoning : [];
  const match = entries.find((entry) => String(entry ?? '').startsWith('decision_engine_fallback:'));
  return match ? String(match).slice('decision_engine_fallback:'.length) : null;
};
const hasNoMarketData = (features) => {
  if (toPositiveFiniteOrNull(features?.currentPrice) !== null) return false;
  const snapshots = Object.values(features?.timeframes ?? {});
  if (!snapshots.length) return true;
  return snapshots.every((snapshot) => {
    const lastClose = toPositiveFiniteOrNull(snapshot?.values?.lastClose ?? snapshot?.lastClose);
    return lastClose === null;
  });
};

export class ConsoleTradingLogger {
  constructor({
    timezone = 'America/New_York',
    enabled = true,
    colors = true,
    writer = console.log,
    preview = false,
    previewWriter = null,
    previewTitle = 'Baptisto Trading V3',
    isTty = process.stdout?.isTTY === true,
    runtimeSessionStateStore = null,
  } = {}) {
    this.timezone = timezone;
    this.enabled = enabled !== false;
    this.colors = colors !== false;
    this.writer = typeof writer === 'function' ? writer : console.log;
    this.previewEnabled = this.enabled && preview === true;
    this.previewTitle = String(previewTitle ?? 'Baptisto Trading V3');
    this.isTty = isTty === true;
    this.runtimeSessionStateStore = runtimeSessionStateStore;
    this.previewWriter = typeof previewWriter === 'function'
      ? previewWriter
      : ((frame) => process.stdout.write(frame));
    this.sessionState = {
      sessionDate: null,
      baselineEquity: null,
      previousEquity: null,
    };
    this.activeBlockingAlerts = new Map();
    this.previewState = {
      latestEvaluations: new Map(),
      latestPortfolioState: null,
      latestAtMs: null,
      recentEvents: [],
    };
  }

  logEvaluation({
    symbol = null,
    atMs = Date.now(),
    features = null,
    decision = null,
    executionIntent = null,
    executionResult = null,
  } = {}) {
    if (!this.enabled) return;

    const safeSymbol = String(symbol ?? features?.symbol ?? '').toUpperCase() || 'UNKNOWN';
    const timeMs = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now();
    const prefix = colorize(`[TRADE][${safeSymbol}][${formatTimestamp(timeMs, this.timezone)}]`, 'cyan', this.colors);
    const blockers = this.#collectBlockingAlerts({
      symbol: safeSymbol,
      features,
      decision,
      executionResult,
    });
    const blockingLines = this.#buildBlockingAlertLines({
      prefix,
      blockers,
    });

    const portfolioLine = this.#buildPortfolioLine({
      prefix,
      timeMs,
      features,
      decision,
      executionResult,
    });

    const deskLine = this.#buildDeskLine({
      prefix,
      features,
      executionIntent,
      executionResult,
    });

    const executionLine = this.#buildExecutionLine({
      prefix,
      features,
      executionIntent,
      executionResult,
    });
    this.#rememberPreviewState({
      symbol: safeSymbol,
      atMs: timeMs,
      features,
      decision,
      executionIntent,
      executionResult,
      blockers,
      blockingLines,
      executionLine,
    });

    if (this.previewEnabled) {
      this.#renderPreviewFrame();
      return;
    }

    for (const line of blockingLines) {
      this.writer(line);
    }
    if (portfolioLine) this.writer(portfolioLine);
    if (deskLine) this.writer(deskLine);
    if (executionLine) this.writer(executionLine);
  }

  #buildBlockingAlertLines({ prefix, blockers }) {
    const lines = [];
    const nextAlerts = new Map();

    for (const blocker of blockers) {
      nextAlerts.set(blocker.key, blocker);
      if (!this.activeBlockingAlerts.has(blocker.key)) {
        lines.push(
          `${prefix} ${colorize('TRADING BLOCKER', 'red', this.colors)} ${colorize(blocker.label, 'red', this.colors)} | ${colorize(blocker.message, 'red', this.colors)}`,
        );
      }
    }

    for (const [key, blocker] of this.activeBlockingAlerts.entries()) {
      if (nextAlerts.has(key)) continue;
      lines.push(`${prefix} ${colorize('TRADING BLOCKER RESOLVED', 'green', this.colors)} ${colorize(blocker.label, 'green', this.colors)}`);
    }

    this.activeBlockingAlerts = nextAlerts;
    return lines;
  }

  #collectBlockingAlerts({ symbol, features, decision, executionResult }) {
    const alerts = [];
    const brokerReady = features?.portfolioState?.brokerReady;
    const brokerErrorCategory = String(features?.portfolioState?.errorCategory ?? '').toLowerCase();
    const brokerError = String(features?.portfolioState?.error ?? '').trim();
    if (brokerReady === false) {
      const label = ['auth', 'permission'].includes(brokerErrorCategory) ? 'BROKER AUTH' : 'BROKER';
      alerts.push({
        key: `broker:${brokerErrorCategory || 'unavailable'}`,
        label,
        message: brokerError || 'Broker gateway unavailable',
      });
    }

    const fallbackReason = extractDecisionFallbackReason(decision);
    if (fallbackReason) {
      alerts.push({
        key: `llm:${fallbackReason}`,
        label: 'LLM',
        message: fallbackReason,
      });
    }

    const executionErrorMessage = String(executionResult?.error?.message ?? '').trim();
    if (executionErrorMessage === 'broker_auth_unavailable' || executionErrorMessage === 'broker_unavailable') {
      alerts.push({
        key: `execution:${executionErrorMessage}`,
        label: 'EXECUTION',
        message: executionErrorMessage,
      });
    }

    if (features?.marketState?.isOpen === true && hasNoMarketData(features)) {
      alerts.push({
        key: `market-data:${symbol}`,
        label: 'MARKET DATA',
        message: `No live price or timeframe bars available for ${symbol}`,
      });
    }

    return alerts.filter((alert, index, list) => list.findIndex((entry) => entry.key === alert.key) === index);
  }

  #buildPortfolioLine({ prefix, timeMs, features, decision, executionResult }) {
    const equity = toFiniteOrNull(features?.portfolioState?.equity);
    const deltas = this.#resolvePortfolioDeltas(equity, timeMs);
    const marketLabel = String(features?.marketState?.sessionLabel ?? 'unknown');
    const decisionAction = String(decision?.action ?? 'skip');
    const executionStatus = String(executionResult?.status ?? 'noop');

    return `${prefix} Equity ${formatMoney(equity)} | Portfolio Delta ${formatSignedMoney(deltas.portfolioDelta, this.colors)} | Session Delta ${formatSignedMoney(deltas.sessionDelta, this.colors)} | Market ${marketLabel} | Decision ${decisionAction} | Exec ${executionStatus}`;
  }

  #buildDeskLine({ prefix, features, executionIntent, executionResult }) {
    const cash = toFiniteOrNull(features?.portfolioState?.cash);
    const equity = toFiniteOrNull(features?.portfolioState?.equity);
    const exposurePct = toFiniteOrNull(features?.portfolioState?.exposurePct);
    const positionSummary = this.#formatDeskPosition({
      features,
      executionIntent,
      executionResult,
    });

    return `${prefix} Desk Equity ${formatMoney(equity)} | Cash ${formatMoney(cash)} | Exposure ${formatPct(exposurePct)} | Position ${positionSummary}`;
  }

  #rememberPreviewState({
    symbol,
    atMs,
    features,
    decision,
    executionIntent,
    executionResult,
    blockers,
    blockingLines,
    executionLine,
  }) {
    this.previewState.latestAtMs = atMs;
    this.previewState.latestPortfolioState = features?.portfolioState ?? this.previewState.latestPortfolioState;
    this.previewState.latestEvaluations.set(symbol, {
      symbol,
      atMs,
      assetClass: features?.assetClass ?? null,
      currentPrice: features?.currentPrice ?? null,
      marketSession: features?.marketState?.sessionLabel ?? 'unknown',
      decisionAction: decision?.action ?? 'skip',
      decisionConfidence: decision?.confidence ?? null,
      executionStatus: executionResult?.status ?? 'noop',
      executionAccepted: executionResult?.accepted === true,
      position: features?.position ?? null,
      portfolioState: features?.portfolioState ?? null,
      blockers,
      signalContext: decision?.signalContext ?? null,
    });

    for (const line of blockingLines) {
      this.#pushRecentEvent(line);
    }
    if (executionLine) {
      this.#pushRecentEvent(executionLine);
    } else if (executionIntent && executionResult?.status === 'rejected') {
      this.#pushRecentEvent(
        `[TRADE][${symbol}][${formatTimestamp(atMs, this.timezone)}] ${String(executionIntent?.action ?? '').toUpperCase()} rejected | ${executionResult?.error?.message ?? executionResult?.status ?? 'rejected'}`,
      );
    }
  }

  #pushRecentEvent(line) {
    const rendered = String(line ?? '').trim();
    if (!rendered) return;
    const list = this.previewState.recentEvents;
    if (list[list.length - 1] === rendered) return;
    list.push(rendered);
    if (list.length > 8) list.shift();
  }

  #renderPreviewFrame() {
    if (!this.isTty) return;

    const frame = [
      `${ANSI.clear}${ANSI.home}${ANSI.bold}${this.previewTitle}${ANSI.reset}`,
      this.#buildPreviewSummaryLine(),
      this.#buildPreviewBlockersLine(),
      '',
      this.#buildPreviewSymbolTable(),
      '',
      this.#buildPreviewPositionsSection(),
      '',
      this.#buildPreviewRecentEventsSection(),
      '',
    ].join('\n');

    this.previewWriter(frame);
  }

  #buildPreviewSummaryLine() {
    const portfolioState = this.previewState.latestPortfolioState ?? {};
    const latestAtMs = this.previewState.latestAtMs ?? Date.now();
    const equity = toFiniteOrNull(portfolioState?.equity);
    const cash = toFiniteOrNull(portfolioState?.cash);
    const exposurePct = toFiniteOrNull(portfolioState?.exposurePct);
    const deltas = this.#resolvePortfolioDeltas(equity, latestAtMs);
    const positions = Array.isArray(portfolioState?.positions) ? portfolioState.positions : [];

    return [
      `Updated ${formatTimestamp(latestAtMs, this.timezone)}`,
      `Equity ${formatMoney(equity)}`,
      `Cash ${formatMoney(cash)}`,
      `Exposure ${formatPct(exposurePct)}`,
      `Portfolio ${formatSignedMoney(deltas.portfolioDelta, this.colors)}`,
      `Session ${formatSignedMoney(deltas.sessionDelta, this.colors)}`,
      `Open Positions ${positions.length}`,
      `Symbols ${this.previewState.latestEvaluations.size}`,
    ].join(' | ');
  }

  #buildPreviewBlockersLine() {
    const blockers = Array.from(this.activeBlockingAlerts.values());
    if (!blockers.length) {
      return `${colorize('Blockers', 'dim', this.colors)} | none`;
    }

    return `Blockers | ${blockers.map((entry) => `${colorize(entry.label, 'red', this.colors)} ${colorize(entry.message, 'red', this.colors)}`).join(' | ')}`;
  }

  #buildPreviewSymbolTable() {
    const header = [
      padCell('Symbol', 10),
      padCell('Session', 16),
      padCell('Price', 11),
      padCell('Decision', 11),
      padCell('Exec', 11),
      padCell('Position', 20),
      padCell('UPNL', 12),
      padCell('Conf', 8),
    ].join(' ');
    const separator = '-'.repeat(stripAnsi(header).length);
    const rows = Array.from(this.previewState.latestEvaluations.values())
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
      .map((entry) => {
        const position = entry.position;
        const positionText = position
          ? `${colorize('LONG', 'green', this.colors)} ${formatQty(position?.qty)}`
          : colorize('FLAT', 'dim', this.colors);
        const upnl = position?.unrealizedPnl ?? null;
        return [
          padCell(entry.symbol, 10),
          padCell(entry.marketSession, 16),
          padCell(formatMoney(entry.currentPrice), 11),
          padCell(entry.decisionAction, 11),
          padCell(entry.executionStatus, 11),
          padCell(positionText, 20),
          padCell(formatSignedMoney(upnl, this.colors), 12),
          padCell(entry.decisionConfidence === null || entry.decisionConfidence === undefined ? 'n/a' : entry.decisionConfidence.toFixed(2), 8),
        ].join(' ');
      });

    return ['Symbols', header, separator, ...(rows.length ? rows : ['No symbol evaluations yet'])].join('\n');
  }

  #buildPreviewPositionsSection() {
    const positions = Array.isArray(this.previewState.latestPortfolioState?.positions)
      ? this.previewState.latestPortfolioState.positions
      : [];
    if (!positions.length) {
      return 'Positions\nFLAT';
    }

    const rows = positions.map((position) => {
      const pnl = toFiniteOrNull(position?.unrealizedPnl);
      return [
        padCell(String(position?.symbol ?? 'UNKNOWN').toUpperCase(), 10),
        padCell(formatQty(position?.qty), 12),
        padCell(formatMoney(position?.entryPrice), 11),
        padCell(formatMoney(position?.currentPrice), 11),
        padCell(formatSignedMoney(pnl, this.colors), 12),
      ].join(' ');
    });

    return [
      'Positions',
      `${padCell('Symbol', 10)} ${padCell('Qty', 12)} ${padCell('Entry', 11)} ${padCell('Current', 11)} ${padCell('UPNL', 12)}`,
      ...rows,
    ].join('\n');
  }

  #buildPreviewRecentEventsSection() {
    const events = this.previewState.recentEvents.slice(-6);
    return ['Recent Events', ...(events.length ? events : ['No recent execution events'])].join('\n');
  }

  #buildExecutionLine({ prefix, features, executionIntent, executionResult }) {
    if (!executionIntent) return null;

    const action = String(executionIntent?.action ?? '');
    const status = String(executionResult?.status ?? 'noop');
    const isAccepted = executionResult?.accepted === true && isAcceptedExecutionStatus(status);

    if (!isAccepted) {
      if (status === 'noop') return null;
      const errorMessage = executionResult?.error?.message ?? status;
      return `${prefix} ${colorize(action.toUpperCase(), 'yellow', this.colors)} rejected | ${colorize(errorMessage, 'red', this.colors)}`;
    }

    if (action === 'open_long') {
      const qty = executionIntent?.qty ?? (
        toPositiveFiniteOrNull(executionIntent?.notional) !== null && toPositiveFiniteOrNull(executionIntent?.referencePrice) !== null
          ? Number(executionIntent.notional) / Number(executionIntent.referencePrice)
          : null
      );
      const entryPrice = executionResult?.avgFillPrice ?? executionIntent?.referencePrice ?? features?.currentPrice ?? null;
      const stopPrice = resolveStopPrice(executionIntent?.referencePrice ?? entryPrice, executionIntent?.stopLossPct);
      return `${prefix} ${colorize('OPEN LONG', 'green', this.colors)} qty=${formatQty(qty)} @ ${formatMoney(entryPrice)} | stop=${formatMoney(stopPrice)} | status=${status}`;
    }

    if (action === 'close_long') {
      const position = features?.position ?? null;
      const qty = toPositiveFiniteOrNull(position?.qty);
      const entryPrice = toPositiveFiniteOrNull(position?.entryPrice);
      const closePrice = toPositiveFiniteOrNull(executionResult?.avgFillPrice ?? executionIntent?.referencePrice ?? features?.currentPrice);
      const pnl = qty !== null && entryPrice !== null && closePrice !== null ? (closePrice - entryPrice) * qty : null;
      const returnPct = entryPrice !== null && closePrice !== null && entryPrice > 0 ? (closePrice - entryPrice) / entryPrice : null;
      return `${prefix} ${colorize('CLOSE LONG', pnl !== null && pnl < 0 ? 'red' : 'green', this.colors)} qty=${formatQty(qty)} @ ${formatMoney(closePrice)} | delta=${formatSignedMoney(pnl, this.colors)} (${formatSignedPct(returnPct, this.colors)}) | entry=${formatMoney(entryPrice)} | status=${status}`;
    }

    return null;
  }

  #resolvePortfolioDeltas(equity, atMs) {
    if (equity === null) {
      return {
        portfolioDelta: null,
        sessionDelta: null,
      };
    }

    const sessionDate = formatSessionDate(atMs, this.timezone);
    if (
      this.sessionState.sessionDate !== sessionDate ||
      this.sessionState.baselineEquity === null ||
      this.sessionState.previousEquity === null
    ) {
      const stored = this.runtimeSessionStateStore?.getConsoleState?.(atMs) ?? null;
      this.sessionState.sessionDate = sessionDate;
      this.sessionState.baselineEquity = toFiniteOrNull(stored?.baselineEquity) ?? equity;
      this.sessionState.previousEquity = toFiniteOrNull(stored?.previousEquity) ?? this.sessionState.baselineEquity;
      const deltas = {
        portfolioDelta: equity - this.sessionState.previousEquity,
        sessionDelta: equity - this.sessionState.baselineEquity,
      };
      this.sessionState.previousEquity = equity;
      this.#persistConsoleState(atMs);
      return deltas;
    }

    const portfolioDelta = equity - this.sessionState.previousEquity;
    const sessionDelta = equity - this.sessionState.baselineEquity;
    this.sessionState.previousEquity = equity;
    this.#persistConsoleState(atMs);
    return {
      portfolioDelta,
      sessionDelta,
    };
  }

  #persistConsoleState(atMs) {
    if (!this.runtimeSessionStateStore?.updateConsoleState) return;
    this.runtimeSessionStateStore.updateConsoleState(atMs, {
      baselineEquity: this.sessionState.baselineEquity,
      previousEquity: this.sessionState.previousEquity,
    });
  }

  #formatDeskPosition({ features, executionIntent, executionResult }) {
    const status = String(executionResult?.status ?? 'noop');
    const isAccepted = executionResult?.accepted === true && isAcceptedExecutionStatus(status);
    const action = String(executionIntent?.action ?? '');

    if (isAccepted && action === 'close_long') {
      return colorize('FLAT', 'dim', this.colors);
    }

    if (isAccepted && action === 'open_long') {
      const qty = executionIntent?.qty ?? null;
      const entryPrice = executionResult?.avgFillPrice ?? executionIntent?.referencePrice ?? features?.currentPrice ?? null;
      return `${colorize('LONG', 'green', this.colors)} qty=${formatQty(qty)} @ ${formatMoney(entryPrice)}`;
    }

    const position = features?.position ?? null;
    if (!position) return colorize('FLAT', 'dim', this.colors);

    const qty = position?.qty ?? null;
    const entryPrice = toPositiveFiniteOrNull(position?.entryPrice);
    const currentPrice = toPositiveFiniteOrNull(position?.currentPrice ?? features?.currentPrice);
    const unrealizedPnl = toFiniteOrNull(position?.unrealizedPnl)
      ?? (qty !== null && entryPrice !== null && currentPrice !== null ? (currentPrice - entryPrice) * qty : null);
    return `${colorize('LONG', 'green', this.colors)} qty=${formatQty(qty)} @ ${formatMoney(entryPrice)} | UPNL ${formatSignedMoney(unrealizedPnl, this.colors)}`;
  }
}
