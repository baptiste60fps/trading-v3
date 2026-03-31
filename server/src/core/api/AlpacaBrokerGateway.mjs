import { BrokerGateway } from './BrokerGateway.mjs';
import { assertDecisionAction, assertSymbolId } from '../types/validators.mjs';

const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const formatQty = (value) => Number(value).toFixed(6);
const formatMoneyPrice = (value) => (value >= 1 ? Number(value).toFixed(2) : Number(value).toFixed(4));

const buildSimpleStopLoss = (referencePrice, stopLossPct) => {
  const safeReferencePrice = toPositiveFiniteOrNull(referencePrice);
  const safeStopLossPct = toPositiveFiniteOrNull(stopLossPct);
  if (safeReferencePrice === null || safeStopLossPct === null) return null;

  const maxStopPrice = safeReferencePrice - 0.01;
  if (maxStopPrice <= 0) {
    throw new Error(`Unable to build stop loss from reference price ${safeReferencePrice}`);
  }

  const rawStopPrice = safeReferencePrice * (1 - safeStopLossPct);
  const stopPrice = Math.min(rawStopPrice, maxStopPrice);
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error(`Invalid stop loss price computed from reference price ${safeReferencePrice}`);
  }

  return {
    stop_price: formatMoneyPrice(stopPrice),
  };
};

const classifyOrderError = (message = '', statusCode = null) => {
  const text = String(message).toLowerCase();
  if (statusCode === 401 || text.includes('unauthorized')) return 'auth';
  if (statusCode === 403 || text.includes('forbidden')) return 'permission';
  if (text.includes('buying power') || text.includes('insufficient')) return 'funding';
  if (text.includes('asset') || text.includes('tradable')) return 'asset';
  if (text.includes('time_in_force') || text.includes('invalid')) return 'validation';
  return 'unknown';
};

const normalizeExecutionError = (error) => ({
  code: error?.code ?? null,
  category: classifyOrderError(error?.message, error?.statusCode ?? null),
  message: error?.message ?? 'Unknown broker error',
});

const normalizePosition = (position) => ({
  symbol: String(position?.symbol ?? '').toUpperCase(),
  side: 'long',
  qty: Number(position?.qty ?? 0),
  entryPrice: Number(position?.avg_entry_price ?? 0),
  openedAtMs: Date.now(),
  stopPrice: null,
  unrealizedPnl: Number.isFinite(Number(position?.unrealized_pl)) ? Number(position.unrealized_pl) : null,
  currentPrice: Number.isFinite(Number(position?.current_price)) ? Number(position.current_price) : null,
  marketValue: Number.isFinite(Number(position?.market_value)) ? Number(position.market_value) : null,
});

export class AlpacaBrokerGateway extends BrokerGateway {
  constructor({ client, paper = true } = {}) {
    super({ providerName: 'alpaca-broker' });
    this.client = client;
    this.paper = paper !== false;
  }

  async getAccountState() {
    const account = await this.client.requestBroker('/account');
    return {
      cash: Number(account?.cash ?? 0),
      equity: Number(account?.equity ?? 0),
      buyingPower: Number.isFinite(Number(account?.buying_power)) ? Number(account.buying_power) : null,
    };
  }

  async getOpenPosition(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    try {
      const position = await this.client.requestBroker(`/positions/${encodeURIComponent(safeSymbol)}`);
      return normalizePosition(position);
    } catch (error) {
      if (error?.statusCode === 404) return null;
      throw error;
    }
  }

  async getOpenPositions() {
    const positions = await this.client.requestBroker('/positions');
    return Array.isArray(positions) ? positions.map((position) => normalizePosition(position)) : [];
  }

  async submit(intent) {
    const action = assertDecisionAction(intent?.action);
    const symbol = assertSymbolId(String(intent?.symbol ?? '').toUpperCase());
    if (action !== 'open_long') {
      throw new Error(`AlpacaBrokerGateway.submit() only supports open_long, received ${action}`);
    }

    const requestedStopLossPct = toPositiveFiniteOrNull(intent?.stopLossPct);
    const stopLoss = requestedStopLossPct === null ? null : buildSimpleStopLoss(intent?.referencePrice, requestedStopLossPct);
    if (requestedStopLossPct !== null && stopLoss === null) {
      throw new Error('ExecutionIntent for open_long with stop loss requires referencePrice');
    }
    const body = {
      symbol,
      side: 'buy',
      type: 'market',
      time_in_force: stopLoss ? 'gtc' : 'day',
    };

    if (stopLoss) {
      const qty = toPositiveFiniteOrNull(intent?.qty);
      if (qty === null) throw new Error('ExecutionIntent for open_long with stop loss requires qty');
      body.qty = formatQty(qty);
      body.order_class = 'oto';
      body.stop_loss = stopLoss;
    } else if (Number.isFinite(Number(intent?.qty)) && Number(intent.qty) > 0) {
      body.qty = formatQty(intent.qty);
    } else if (Number.isFinite(Number(intent?.notional)) && Number(intent.notional) > 0) {
      body.notional = Number(intent.notional).toFixed(2);
    } else {
      throw new Error('ExecutionIntent for open_long requires qty or notional');
    }

    try {
      const response = await this.client.requestBroker('/orders', {
        method: 'POST',
        body,
      });
      return {
        accepted: true,
        brokerOrderId: response?.id ?? null,
        filledQty: Number.isFinite(Number(response?.filled_qty)) ? Number(response.filled_qty) : null,
        avgFillPrice: Number.isFinite(Number(response?.filled_avg_price)) ? Number(response.filled_avg_price) : null,
        status: response?.status ?? 'accepted',
        error: null,
      };
    } catch (error) {
      return {
        accepted: false,
        brokerOrderId: null,
        filledQty: null,
        avgFillPrice: null,
        status: 'rejected',
        error: normalizeExecutionError(error),
      };
    }
  }

  async close(symbol) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    try {
      const response = await this.client.requestBroker(`/positions/${encodeURIComponent(safeSymbol)}`, {
        method: 'DELETE',
      });
      return {
        accepted: true,
        brokerOrderId: response?.id ?? null,
        filledQty: Number.isFinite(Number(response?.filled_qty)) ? Number(response.filled_qty) : null,
        avgFillPrice: Number.isFinite(Number(response?.filled_avg_price)) ? Number(response.filled_avg_price) : null,
        status: response?.status ?? 'closed',
        error: null,
      };
    } catch (error) {
      return {
        accepted: false,
        brokerOrderId: null,
        filledQty: null,
        avgFillPrice: null,
        status: 'rejected',
        error: normalizeExecutionError(error),
      };
    }
  }
}
