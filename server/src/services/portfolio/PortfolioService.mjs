import { assertSymbolId, isFiniteNumber } from '../../core/types/validators.mjs';

const toFinite = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positionExposure = (position) => {
  if (isFiniteNumber(position?.marketValue)) return Math.abs(position.marketValue);
  if (isFiniteNumber(position?.currentPrice) && isFiniteNumber(position?.qty)) return Math.abs(position.currentPrice * position.qty);
  if (isFiniteNumber(position?.entryPrice) && isFiniteNumber(position?.qty)) return Math.abs(position.entryPrice * position.qty);
  return 0;
};

const normalizeBrokerErrorCategory = (error) => {
  const explicitCategory = String(error?.category ?? '').toLowerCase();
  if (explicitCategory) return explicitCategory;

  const statusCode = Number(error?.statusCode);
  if (statusCode === 401) return 'auth';
  if (statusCode === 403) return 'permission';

  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('unauthorized')) return 'auth';
  if (message.includes('forbidden')) return 'permission';
  if (message.includes('not ready') || message.includes('not configured') || message.includes('missing credentials')) return 'unavailable';
  return 'unknown';
};

const isRecoverableBrokerError = (error) => ['auth', 'permission', 'unavailable'].includes(normalizeBrokerErrorCategory(error));

const makeDegradedSnapshot = (error) => {
  const message = error?.message ?? 'Broker gateway is unavailable';
  const category = normalizeBrokerErrorCategory(error);
  const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : null;

  return {
    cash: 0,
    equity: 0,
    positions: [],
    exposurePct: 0,
    brokerReady: false,
    error: message,
    errorCategory: category,
    errorStatusCode: statusCode,
  };
};

export class PortfolioService {
  constructor({ brokerGateway, configStore = null } = {}) {
    this.brokerGateway = brokerGateway;
    this.configStore = configStore;
  }

  async getSnapshot() {
    try {
      const account = await this.brokerGateway.getAccountState();
      const positions = typeof this.brokerGateway.getOpenPositions === 'function' ? await this.brokerGateway.getOpenPositions() : [];
      const cash = toFinite(account?.cash, 0);
      const equity = toFinite(account?.equity, 0);
      const grossExposure = positions.reduce((sum, position) => sum + positionExposure(position), 0);
      const exposurePct = equity > 0 ? grossExposure / equity : 0;

      return {
        cash,
        equity,
        positions,
        exposurePct,
        brokerReady: true,
      };
    } catch (error) {
      if (isRecoverableBrokerError(error)) {
        return makeDegradedSnapshot(error);
      }

      throw error;
    }
  }

  async canOpenLong(symbol, requestedNotional) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const snapshot = await this.getSnapshot();
    if (snapshot?.brokerReady === false) {
      return {
        allowed: false,
        reason: ['auth', 'permission'].includes(String(snapshot.errorCategory ?? '')) ? 'broker_auth_unavailable' : 'broker_unavailable',
        adjustedNotional: 0,
      };
    }

    const risk = this.configStore?.getSymbolConfig?.(safeSymbol)?.risk ?? {};
    const maxPositionPct = toFinite(risk.maxPositionPct, 0.05);
    const maxPortfolioExposurePct = toFinite(risk.maxPortfolioExposurePct, 0.5);
    const requested = Math.max(0, toFinite(requestedNotional, 0));

    if (requested <= 0) {
      return {
        allowed: false,
        reason: 'invalid_notional',
        adjustedNotional: 0,
      };
    }

    const symbolExposure = snapshot.positions
      .filter((position) => String(position?.symbol ?? '').toUpperCase() === safeSymbol)
      .reduce((sum, position) => sum + positionExposure(position), 0);

    const maxByPosition = Math.max(0, snapshot.equity * maxPositionPct - symbolExposure);
    const maxByExposure = Math.max(0, snapshot.equity * maxPortfolioExposurePct - snapshot.exposurePct * snapshot.equity);
    const adjustedNotional = Math.min(requested, snapshot.cash, maxByPosition, maxByExposure);

    if (adjustedNotional <= 0) {
      return {
        allowed: false,
        reason: snapshot.cash <= 0 ? 'insufficient_cash' : 'risk_limits',
        adjustedNotional: 0,
      };
    }

    return {
      allowed: true,
      reason: null,
      adjustedNotional,
    };
  }
}
