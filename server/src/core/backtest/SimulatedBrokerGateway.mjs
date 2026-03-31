import { BrokerGateway } from '../api/BrokerGateway.mjs';
import { normalizeEpochMs } from '../market/time.mjs';
import { assertSymbolId, isFiniteNumber } from '../types/validators.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

const toFinite = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizePct = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export class SimulatedBrokerGateway extends BrokerGateway {
  constructor({
    initialCash = 100_000,
    slippageBps = 0,
    feePerOrder = 0,
    feePerShare = 0,
  } = {}) {
    super({ providerName: 'simulated-broker' });
    this.initialCash = Math.max(0, toFinite(initialCash, 100_000));
    this.slippageBps = Math.max(0, toFinite(slippageBps, 0));
    this.feePerOrder = Math.max(0, toFinite(feePerOrder, 0));
    this.feePerShare = Math.max(0, toFinite(feePerShare, 0));
    this.cash = this.initialCash;
    this.nowMs = Date.now();
    this.positions = new Map();
    this.markPrices = new Map();
    this.closedTrades = [];
    this.orderSequence = 0;
    this.totalFees = 0;
    this.totalSlippageCost = 0;
  }

  setMarketState({ atMs = Date.now(), symbol = null, price = null, prices = null } = {}) {
    this.nowMs = normalizeEpochMs(atMs, 'atMs');

    if (symbol && isFiniteNumber(Number(price))) {
      this.markPrices.set(assertSymbolId(String(symbol).toUpperCase()), Number(price));
    }

    if (prices && typeof prices === 'object') {
      for (const [entrySymbol, entryPrice] of Object.entries(prices)) {
        if (!Number.isFinite(Number(entryPrice))) continue;
        this.markPrices.set(assertSymbolId(String(entrySymbol).toUpperCase()), Number(entryPrice));
      }
    }
  }

  async getAccountState() {
    const positions = await this.getOpenPositions();
    const grossMarketValue = positions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0);
    return {
      cash: this.cash,
      equity: this.cash + grossMarketValue,
      buyingPower: this.cash,
    };
  }

  async getOpenPosition(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const position = this.positions.get(safeSymbol);
    return position ? this.#snapshotPosition(position) : null;
  }

  async getOpenPositions() {
    return Array.from(this.positions.values()).map((position) => this.#snapshotPosition(position));
  }

  async submit(intent) {
    const symbol = assertSymbolId(String(intent?.symbol ?? '').toUpperCase());
    if (intent?.action !== 'open_long') {
      throw new Error(`SimulatedBrokerGateway.submit() only supports open_long, received ${intent?.action}`);
    }

    if (this.positions.has(symbol)) {
      return this.#rejected('validation', 'position_already_open');
    }

    const fillPrice = this.#resolvePrice(symbol, intent?.referencePrice ?? intent?.metadata?.referencePrice);
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      return this.#rejected('pricing', 'missing_fill_price');
    }

    const slippedPrice = this.#applyEntrySlippage(fillPrice);
    const qty = this.#resolveQty(intent, slippedPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      return this.#rejected('validation', 'invalid_quantity');
    }

    const requestedNotional = Number.isFinite(Number(intent?.notional)) && Number(intent.notional) > 0 ? Number(intent.notional) : qty * slippedPrice;
    const fee = this.#computeFee(qty);
    if (requestedNotional + fee > this.cash + 1e-9) {
      return this.#rejected('funding', 'insufficient_cash');
    }

    const slippageCost = Math.max(0, slippedPrice - fillPrice) * qty;
    this.cash -= requestedNotional + fee;
    this.orderSequence += 1;
    this.totalFees += fee;
    this.totalSlippageCost += slippageCost;
    this.positions.set(symbol, {
      symbol,
      side: 'long',
      qty,
      entryPrice: slippedPrice,
      currentPrice: fillPrice,
      marketValue: qty * fillPrice,
      unrealizedPnl: 0,
      openedAtMs: normalizeEpochMs(intent?.requestedAtMs ?? this.nowMs, 'requestedAtMs'),
      stopLossPct: normalizePct(intent?.metadata?.stopLossPct),
      takeProfitPct: normalizePct(intent?.metadata?.takeProfitPct),
      entryFee: fee,
      entrySlippageCost: slippageCost,
      entryReasoning: Array.isArray(intent?.metadata?.reasoning) ? intent.metadata.reasoning.slice() : [],
      entrySignalContext: intent?.metadata?.signalContext ?? null,
    });

    return {
      accepted: true,
      brokerOrderId: `sim-open-${this.orderSequence}`,
      filledQty: qty,
      avgFillPrice: slippedPrice,
      status: 'filled',
      error: null,
    };
  }

  async close(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const position = this.positions.get(safeSymbol);
    if (!position) {
      return this.#rejected('validation', 'position_not_found');
    }

    const fillPrice = this.#resolvePrice(safeSymbol, position.currentPrice ?? position.entryPrice);
    const slippedPrice = this.#applyExitSlippage(fillPrice);
    const notional = position.qty * slippedPrice;
    const fee = this.#computeFee(position.qty);
    const slippageCost = Math.max(0, fillPrice - slippedPrice) * position.qty;
    const pnl = (slippedPrice - position.entryPrice) * position.qty - position.entryFee - fee;

    this.cash += notional - fee;
    this.positions.delete(safeSymbol);
    this.orderSequence += 1;
    this.totalFees += fee;
    this.totalSlippageCost += slippageCost;
    this.closedTrades.push({
      symbol: safeSymbol,
      side: 'long',
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice: slippedPrice,
      openedAtMs: position.openedAtMs,
      closedAtMs: this.nowMs,
      pnl,
      returnPct: position.entryPrice > 0 ? (slippedPrice - position.entryPrice) / position.entryPrice : null,
      holdingMs: Math.max(0, this.nowMs - position.openedAtMs),
      stopLossPct: position.stopLossPct ?? null,
      takeProfitPct: position.takeProfitPct ?? null,
      entryFee: position.entryFee ?? 0,
      exitFee: fee,
      totalFees: (position.entryFee ?? 0) + fee,
      entrySlippageCost: position.entrySlippageCost ?? 0,
      exitSlippageCost: slippageCost,
      totalSlippageCost: (position.entrySlippageCost ?? 0) + slippageCost,
      entryReasoning: position.entryReasoning ?? [],
      entrySignalContext: position.entrySignalContext ?? null,
    });

    return {
      accepted: true,
      brokerOrderId: `sim-close-${this.orderSequence}`,
      filledQty: position.qty,
      avgFillPrice: slippedPrice,
      status: 'filled',
      error: null,
    };
  }

  getClosedTrades() {
    return this.closedTrades.map(clone);
  }

  getCostSummary() {
    return {
      slippageBps: this.slippageBps,
      feePerOrder: this.feePerOrder,
      feePerShare: this.feePerShare,
      totalFees: this.totalFees,
      totalSlippageCost: this.totalSlippageCost,
    };
  }

  #snapshotPosition(position) {
    const currentPrice = this.#resolvePrice(position.symbol, position.currentPrice ?? position.entryPrice);
    const marketValue = position.qty * currentPrice;
    const unrealizedPnl = (currentPrice - position.entryPrice) * position.qty;

    return {
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      entryPrice: position.entryPrice,
      openedAtMs: position.openedAtMs,
      currentPrice,
      marketValue,
      unrealizedPnl,
      stopLossPct: position.stopLossPct ?? null,
      takeProfitPct: position.takeProfitPct ?? null,
    };
  }

  #resolveQty(intent, fillPrice) {
    if (Number.isFinite(Number(intent?.qty)) && Number(intent.qty) > 0) return Number(intent.qty);
    if (Number.isFinite(Number(intent?.notional)) && Number(intent.notional) > 0) return Number(intent.notional) / fillPrice;
    return 0;
  }

  #computeFee(qty) {
    return this.feePerOrder + this.feePerShare * qty;
  }

  #applyEntrySlippage(price) {
    return price * (1 + this.slippageBps / 10_000);
  }

  #applyExitSlippage(price) {
    return price * (1 - this.slippageBps / 10_000);
  }

  #resolvePrice(symbol, fallbackPrice = null) {
    const markPrice = this.markPrices.get(symbol);
    if (Number.isFinite(markPrice) && markPrice > 0) return markPrice;
    const fallback = Number(fallbackPrice);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : NaN;
  }

  #rejected(category, message) {
    return {
      accepted: false,
      brokerOrderId: null,
      filledQty: null,
      avgFillPrice: null,
      status: 'rejected',
      error: {
        category,
        code: null,
        message,
      },
    };
  }
}
