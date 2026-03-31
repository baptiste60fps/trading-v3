import { assertBar, assertEpochMs, assertTimeframe, timeframeToMs } from '../types/validators.mjs';

export const normalizeEpochMs = (value, label = 'timestamp') => {
  if (value instanceof Date) return assertEpochMs(value.getTime(), label);

  if (typeof value === 'number') {
    if (value > 1e14) return assertEpochMs(Math.floor(value / 1e6), label);
    if (value > 1e11) return assertEpochMs(Math.floor(value), label);
    if (value > 1e9) return assertEpochMs(Math.floor(value * 1000), label);
    return assertEpochMs(Math.floor(value * 1000), label);
  }

  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return normalizeEpochMs(asNumber, label);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return assertEpochMs(parsed, label);
  }

  throw new Error(`Unable to normalize ${label}: ${value}`);
};

export const toIsoUtc = (value) => new Date(normalizeEpochMs(value)).toISOString();

export const sortBars = (bars = []) =>
  bars
    .map((bar) => assertBar(bar))
    .slice()
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

export const getTimeframeMs = (timeframe) => timeframeToMs(assertTimeframe(timeframe));

export const aggregateBars = (bars = [], targetTimeframe, { anchorMs = null } = {}) => {
  const sorted = sortBars(bars);
  if (!sorted.length) return [];

  const targetMs = getTimeframeMs(targetTimeframe);
  const sourceMs = getTimeframeMs(sorted[0].timeframe);
  if (targetMs < sourceMs) throw new Error(`Cannot aggregate ${sorted[0].timeframe} bars into finer timeframe ${targetTimeframe}`);
  if (targetMs === sourceMs) return sorted.map((bar) => ({ ...bar, timeframe: targetTimeframe }));
  if (targetMs % sourceMs !== 0) throw new Error(`Timeframe ${targetTimeframe} is not compatible with source timeframe ${sorted[0].timeframe}`);

  const baseAnchorMs = anchorMs === null ? sorted[0].startMs : normalizeEpochMs(anchorMs, 'anchorMs');
  const groups = new Map();

  for (const bar of sorted) {
    const bucketIndex = Math.floor((bar.startMs - baseAnchorMs) / targetMs);
    const bucketStartMs = baseAnchorMs + bucketIndex * targetMs;
    const bucketEndMs = bucketStartMs + targetMs;
    const key = `${bar.symbol}:${bucketStartMs}`;
    const current = groups.get(key);

    if (!current) {
      groups.set(key, {
        symbol: bar.symbol,
        timeframe: targetTimeframe,
        startMs: bucketStartMs,
        endMs: bucketEndMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        tradeCount: bar.tradeCount ?? null,
        source: bar.source,
      });
      continue;
    }

    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume = Number.isFinite(current.volume) || Number.isFinite(bar.volume) ? (current.volume ?? 0) + (bar.volume ?? 0) : null;
    current.tradeCount = Number.isFinite(current.tradeCount) || Number.isFinite(bar.tradeCount) ? (current.tradeCount ?? 0) + (bar.tradeCount ?? 0) : null;
  }

  return Array.from(groups.values()).sort((left, right) => left.startMs - right.startMs);
};
