import { DECISION_ACTIONS, POSITION_SIDES, RUNTIME_MODES, SUPPORTED_TIMEFRAMES, TIMEFRAME_TO_MS } from './domain.mjs';

const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,32}$/;

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

export const assertPositionSide = (value) => {
  assert(POSITION_SIDES.includes(value), `Unsupported position side: ${value}`);
  return value;
};

export const assertSymbolId = (value) => {
  assert(typeof value === 'string' && SYMBOL_PATTERN.test(value), `Invalid symbol id: ${value}`);
  return value;
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
