export const RUNTIME_MODES = Object.freeze(['backtest', 'replay', 'paper', 'live']);
export const DECISION_ACTIONS = Object.freeze(['open_long', 'hold', 'close_long', 'skip']);
export const POSITION_SIDES = Object.freeze(['long']);
export const ASSET_CLASSES = Object.freeze(['stock', 'crypto']);
export const SUPPORTED_TIMEFRAMES = Object.freeze([
  '10s',
  '30s',
  '1m',
  '2m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
]);

export const TIMEFRAME_TO_MS = Object.freeze({
  '10s': 10_000,
  '30s': 30_000,
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
});
