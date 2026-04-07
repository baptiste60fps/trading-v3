import { ASSET_CLASSES, DECISION_ACTIONS, POSITION_SIDES, RUNTIME_MODES, SUPPORTED_TIMEFRAMES, TIMEFRAME_TO_MS } from './domain.mjs';

const SYMBOL_PATTERN = /^[A-Z0-9./_-]{1,32}$/;
const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'BTC'];

export const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const assertRuntimeMode = (value) => {
  assert(RUNTIME_MODES.includes(value), `Unsupported runtime mode: ${value}`);
  return value;
};

export const assertDecisionAction = (value) => {
  assert(DECISION_ACTIONS.includes(value), `Unsupported decision action: ${value}`);
  return value;
};

export const assertAssetClass = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  assert(ASSET_CLASSES.includes(normalized), `Unsupported asset class: ${value}`);
  return normalized;
};

export const assertPositionSide = (value) => {
  assert(POSITION_SIDES.includes(value), `Unsupported position side: ${value}`);
  return value;
};

export const normalizeSymbolId = (value) => {
  const raw = String(value ?? '').trim().toUpperCase();
  const normalized = raw.includes('/')
    ? raw
    : (() => {
        for (const quote of CRYPTO_QUOTE_SUFFIXES) {
          if (!raw.endsWith(quote)) continue;
          const base = raw.slice(0, -quote.length);
          if (base.length < 2) continue;
          return `${base}/${quote}`;
        }
        return raw;
      })();
  assert(normalized && SYMBOL_PATTERN.test(normalized), `Invalid symbol id: ${value}`);
  return normalized;
};

export const assertSymbolId = (value) => {
  return normalizeSymbolId(value);
};

export const assertTimeframe = (value) => {
  assert(SUPPORTED_TIMEFRAMES.includes(value), `Unsupported timeframe: ${value}`);
  return value;
};

export const assertEpochMs = (value, label = 'timestamp') => {
  assert(isFiniteNumber(value) && value > 0, `Invalid ${label}: ${value}`);
  return Math.floor(value);
};

export const assertBar = (bar) => {
  assert(bar && typeof bar === 'object', 'Bar must be an object');
  assertSymbolId(bar.symbol);
  assertTimeframe(bar.timeframe);
  assertEpochMs(bar.startMs, 'bar.startMs');
  assertEpochMs(bar.endMs, 'bar.endMs');
  assert(bar.endMs >= bar.startMs, 'bar.endMs must be >= bar.startMs');
  ['open', 'high', 'low', 'close'].forEach((field) => {
    assert(isFiniteNumber(bar[field]), `Invalid bar.${field}`);
  });
  assert(bar.high >= bar.low, 'bar.high must be >= bar.low');
  return bar;
};

export const timeframeToMs = (timeframe) => TIMEFRAME_TO_MS[assertTimeframe(timeframe)];
