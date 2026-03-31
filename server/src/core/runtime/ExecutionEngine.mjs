const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toFinite = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export class ExecutionEngine {
  constructor({
    brokerGateway,
    portfolioService,
    configStore = null,
    dryRun = true,
  } = {}) {
    this.brokerGateway = brokerGateway;
    this.portfolioService = portfolioService;
    this.configStore = configStore;
    this.dryRun = dryRun !== false;
  }

  async createExecutionIntent({ symbol, decision, features }) {
    const safeSymbol = String(symbol ?? '').toUpperCase();
    const action = decision?.action ?? 'skip';

    if (action === 'skip' || action === 'hold') {
      return {
        executionIntent: null,
        reason: 'noop_action',
      };
    }

    if (action === 'close_long') {
      return {
        executionIntent: {
          symbol: safeSymbol,
          action: 'close_long',
          side: 'long',
          referencePrice: features?.currentPrice ?? null,
          requestedAtMs: features?.atMs ?? Date.now(),
          metadata: {
            confidence: decision?.confidence ?? 0,
            reasoning: decision?.reasoning ?? [],
            referencePrice: features?.currentPrice ?? null,
            signalContext: decision?.signalContext ?? null,
          },
        },
        reason: null,
      };
    }

    if (action !== 'open_long') {
      return {
        executionIntent: null,
        reason: 'unsupported_action',
      };
    }

    if (!features?.marketState?.isOpen || features?.marketState?.isPreClose || features?.marketState?.isNoTradeOpen) {
      return {
        executionIntent: null,
        reason: 'market_gate',
      };
    }

    if (features?.position) {
      return {
        executionIntent: null,
        reason: 'position_already_open',
      };
    }

    if (features?.riskState?.canOpen === false) {
      return {
        executionIntent: null,
        reason: 'risk_gate',
      };
    }

    const symbolConfig = this.configStore?.getSymbolConfig?.(safeSymbol) ?? {};
    const risk = symbolConfig.risk ?? {};
    const maxPositionPct = toFinite(risk.maxPositionPct, 0.05);
    const requestedSizePct = decision?.requestedSizePct === null || decision?.requestedSizePct === undefined ? maxPositionPct : decision.requestedSizePct;
    const targetSizePct = clamp(toFinite(requestedSizePct, maxPositionPct), 0, maxPositionPct);
    const equity = toFinite(features?.portfolioState?.equity, 0);
    const requestedNotional = equity * targetSizePct;
    const referencePrice = toPositiveFiniteOrNull(features?.currentPrice);

    const allowance = await this.portfolioService.canOpenLong(safeSymbol, requestedNotional);
    if (!allowance.allowed || !allowance.adjustedNotional || allowance.adjustedNotional <= 0) {
      return {
        executionIntent: null,
        reason: allowance.reason ?? 'portfolio_gate',
      };
    }

    const configuredStopLossPct = symbolConfig?.brokerProtection?.enabled === false
      ? null
      : symbolConfig?.brokerProtection?.simpleStopLossPct ?? null;
    const stopLossPct = toPositiveFiniteOrNull(decision?.stopLossPct ?? configuredStopLossPct);
    if (stopLossPct !== null && referencePrice === null) {
      return {
        executionIntent: null,
        reason: 'missing_reference_price_for_stop_loss',
      };
    }

    const qty = stopLossPct !== null && referencePrice !== null
      ? allowance.adjustedNotional / referencePrice
      : null;

    return {
      executionIntent: {
        symbol: safeSymbol,
        action: 'open_long',
        side: 'long',
        notional: stopLossPct === null ? allowance.adjustedNotional : null,
        qty,
        referencePrice,
        stopLossPct,
        requestedAtMs: features?.atMs ?? Date.now(),
        metadata: {
          confidence: decision?.confidence ?? 0,
          reasoning: decision?.reasoning ?? [],
          referencePrice,
          signalContext: decision?.signalContext ?? null,
          stopLossPct,
          takeProfitPct: decision?.takeProfitPct ?? null,
        },
      },
      reason: null,
    };
  }

  async executeDecision({ symbol, decision, features }) {
    const { executionIntent, reason } = await this.createExecutionIntent({
      symbol,
      decision,
      features,
    });

    if (!executionIntent) {
      return {
        executionIntent: null,
        executionResult: {
          accepted: false,
          brokerOrderId: null,
          filledQty: null,
          avgFillPrice: null,
          status: 'noop',
          error: reason
            ? {
                category: 'noop',
                code: null,
                message: reason,
              }
            : null,
        },
      };
    }

    if (this.dryRun) {
      return {
        executionIntent,
        executionResult: {
          accepted: true,
          brokerOrderId: null,
          filledQty: null,
          avgFillPrice: null,
          status: 'dry_run',
          error: null,
        },
      };
    }

    if (executionIntent.action === 'close_long') {
      return {
        executionIntent,
        executionResult: await this.brokerGateway.close(executionIntent.symbol),
      };
    }

    return {
      executionIntent,
      executionResult: await this.brokerGateway.submit(executionIntent),
    };
  }
}
