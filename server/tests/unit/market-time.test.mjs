import assert from 'assert/strict';
import { aggregateBars, getTimeframeMs, normalizeEpochMs, toIsoUtc } from '../../src/core/market/time.mjs';

export const register = async ({ test }) => {
  test('normalizeEpochMs handles ISO strings and unix seconds', async () => {
    const fromIso = normalizeEpochMs('2026-03-25T13:30:00.000Z');
    const fromSeconds = normalizeEpochMs(1_774_445_400);

    assert.equal(fromIso, 1774445400000);
    assert.equal(fromSeconds, 1774445400000);
    assert.equal(toIsoUtc(fromIso), '2026-03-25T13:30:00.000Z');
  });

  test('getTimeframeMs returns canonical timeframe duration', async () => {
    assert.equal(getTimeframeMs('10s'), 10_000);
    assert.equal(getTimeframeMs('1m'), 60_000);
    assert.equal(getTimeframeMs('4h'), 14_400_000);
  });

  test('aggregateBars aggregates compatible bars into a larger timeframe', async () => {
    const startMs = Date.parse('2026-03-25T13:30:00.000Z');
    const bars = [
      { symbol: 'AAPL', timeframe: '1m', startMs, endMs: startMs + 60_000, open: 10, high: 11, low: 9, close: 10.5, volume: 100, tradeCount: 2, source: 'test' },
      { symbol: 'AAPL', timeframe: '1m', startMs: startMs + 60_000, endMs: startMs + 120_000, open: 10.5, high: 12, low: 10, close: 11.5, volume: 110, tradeCount: 3, source: 'test' },
      { symbol: 'AAPL', timeframe: '1m', startMs: startMs + 120_000, endMs: startMs + 180_000, open: 11.5, high: 13, low: 11, close: 12.5, volume: 120, tradeCount: 4, source: 'test' },
      { symbol: 'AAPL', timeframe: '1m', startMs: startMs + 180_000, endMs: startMs + 240_000, open: 12.5, high: 14, low: 12, close: 13.5, volume: 130, tradeCount: 5, source: 'test' },
    ];

    const aggregated = aggregateBars(bars, '2m');
    assert.equal(aggregated.length, 2);
    assert.equal(aggregated[0].open, 10);
    assert.equal(aggregated[0].close, 11.5);
    assert.equal(aggregated[0].high, 12);
    assert.equal(aggregated[1].low, 11);
  });
};
