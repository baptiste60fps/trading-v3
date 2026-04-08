import { BrokerGateway } from './BrokerGateway.mjs';
import { assertAssetClass, assertDecisionAction, assertSymbolId, normalizeSymbolId } from '../types/validators.mjs';

const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const formatQty = (value) => Number(value).toFixed(6);
const formatWholeQty = (value) => String(Math.floor(Number(value)));
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

const OPEN_ORDER_STATUSES = new Set(['new', 'accepted', 'pending_new', 'accepted_for_bidding', 'partially_filled', 'held', 'stopped']);

const normalizePosition = (position) => ({
  symbol: normalizeSymbolId(position?.symbol ?? ''),
  side: 'long',
  qty: Number(position?.qty ?? 0),
  entryPrice: Number(position?.avg_entry_price ?? 0),
  openedAtMs: Date.now(),
  stopPrice: null,
  unrealizedPnl: Number.isFinite(Number(position?.unrealized_pl)) ? Number(position.unrealized_pl) : null,
  currentPrice: Number.isFinite(Number(position?.current_price)) ? Number(position.current_price) : null,
  marketValue: Number.isFinite(Number(position?.market_value)) ? Number(position.market_value) : null,
});

const isProtectiveStopOrder = (order, symbol) => {
  const orderSymbol = normalizeSymbolId(order?.symbol ?? '');
  const status = String(order?.status ?? '').toLowerCase();
  const side = String(order?.side ?? '').toLowerCase();
  const positionIntent = String(order?.position_intent ?? '').toLowerCase();
  const type = String(order?.type ?? order?.order_type ?? '').toLowerCase();
  return orderSymbol === symbol
    && OPEN_ORDER_STATUSES.has(status)
    && side === 'sell'
    && (
      positionIntent === 'sell_to_close'
      || type === 'stop'
      || order?.stop_price != null
    );
};

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
    const assetClass = assertAssetClass(intent?.assetClass ?? 'stock');
    if (action !== 'open_long') {
      throw new Error(`AlpacaBrokerGateway.submit() only supports open_long, received ${action}`);
    }

    const requestedStopLossPct = toPositiveFiniteOrNull(intent?.stopLossPct);
    if (assetClass === 'crypto' && requestedStopLossPct !== null) {
      throw new Error('Crypto market orders do not support broker-side simple stop loss in this gateway');
    }
    const stopLoss = requestedStopLossPct === null ? null : buildSimpleStopLoss(intent?.referencePrice, requestedStopLossPct);
    if (requestedStopLossPct !== null && stopLoss === null) {
      throw new Error('ExecutionIntent for open_long with stop loss requires referencePrice');
    }
    const body = {
      symbol,
      side: 'buy',
      type: 'market',
      time_in_force: assetClass === 'crypto' ? 'gtc' : (stopLoss ? 'gtc' : 'day'),
    };

    if (stopLoss) {
      const qty = toPositiveFiniteOrNull(intent?.qty);
      if (qty === null) throw new Error('ExecutionIntent for open_long with stop loss requires qty');
      const wholeQty = Math.floor(qty);
      if (!Number.isFinite(wholeQty) || wholeQty <= 0) {
        throw new Error('ExecutionIntent for broker-side stop loss requires at least one whole share');
      }
      body.qty = formatWholeQty(wholeQty);
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
      await this.#cancelProtectiveOrdersForSymbol(safeSymbol);
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

  async #cancelProtectiveOrdersForSymbol(symbol) {
    const orders = await this.client.requestBroker('/orders', {
      query: {
        status: 'open',
        nested: true,
        symbols: symbol,
      },
    });

    const openOrders = Array.isArray(orders) ? orders : [];
    const protectiveOrders = openOrders.filter((order) => {
      try {
        return isProtectiveStopOrder(order, symbol);
      } catch {
        return false;
      }
    });

    for (const order of protectiveOrders) {
      const orderId = String(order?.id ?? '').trim();
      if (!orderId) continue;
      await this.client.requestBroker(`/orders/${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
      });
    }
  }
}
