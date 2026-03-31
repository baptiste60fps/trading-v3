const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const toFiniteOrNull = (value) => {
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

export class ConsoleTradingLogger {
  constructor({
    timezone = 'America/New_York',
    enabled = true,
    colors = true,
    writer = console.log,
  } = {}) {
    this.timezone = timezone;
    this.enabled = enabled !== false;
    this.colors = colors !== false;
    this.writer = typeof writer === 'function' ? writer : console.log;
    this.sessionState = {
      sessionDate: null,
      baselineEquity: null,
      previousEquity: null,
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

    const portfolioLine = this.#buildPortfolioLine({
      prefix,
      timeMs,
      features,
      decision,
      executionResult,
    });
    if (portfolioLine) this.writer(portfolioLine);

    const deskLine = this.#buildDeskLine({
      prefix,
      features,
      executionIntent,
      executionResult,
    });
    if (deskLine) this.writer(deskLine);

    const executionLine = this.#buildExecutionLine({
      prefix,
      features,
      executionIntent,
      executionResult,
    });
    if (executionLine) this.writer(executionLine);
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
      this.sessionState.sessionDate = sessionDate;
      this.sessionState.baselineEquity = equity;
      this.sessionState.previousEquity = equity;
      return {
        portfolioDelta: 0,
        sessionDelta: 0,
      };
    }

    const portfolioDelta = equity - this.sessionState.previousEquity;
    const sessionDelta = equity - this.sessionState.baselineEquity;
    this.sessionState.previousEquity = equity;
    return {
      portfolioDelta,
      sessionDelta,
    };
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
