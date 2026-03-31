import assert from 'assert/strict';
import { IndicatorEngine } from '../../src/core/indicators/IndicatorEngine.mjs';

const approx = (value, expected, epsilon = 1e-6) => {
  assert.ok(Math.abs(value - expected) <= epsilon, `Expected ${value} to be within ${epsilon} of ${expected}`);
};

const makeBars = () => {
  const startMs = Date.parse('2026-03-25T13:30:00.000Z');
  const closes = [
    100, 101, 102, 103, 104,
    105, 106, 107, 108, 109,
    110, 111, 112, 113, 114,
    115, 116, 117, 118, 119,
    120, 121, 122, 123, 124,
    125, 126, 127, 128, 129,
    130, 131, 132, 133, 134,
    135, 136, 137, 138, 139,
    140, 141, 142, 143, 144,
    145, 146, 147, 148, 149,
    150, 151, 152, 153, 154,
  ];

  return closes.map((close, index) => ({
    symbol: 'AAPL',
    timeframe: '1m',
    startMs: startMs + index * 60_000,
    endMs: startMs + (index + 1) * 60_000,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index,
    tradeCount: 5 + index,
    source: 'test',
  }));
};

export const register = async ({ test }) => {
  test('IndicatorEngine computes a stable snapshot from bars', async () => {
    const engine = new IndicatorEngine();
    const bars = makeBars();
    const snapshot = engine.compute({
      symbol: 'AAPL',
      timeframe: '1m',
      bars,
      atMs: bars[bars.length - 1].endMs,
    });

    assert.equal(snapshot.symbol, 'AAPL');
    assert.equal(snapshot.timeframe, '1m');
    assert.equal(snapshot.values.barCount, 55);
    assert.equal(snapshot.values.lastClose, 154);
    approx(snapshot.values.sma20, 144.5);
    approx(snapshot.values.sma50, 129.5);
    assert.ok(snapshot.values.ema12 > snapshot.values.ema26);
    assert.ok(snapshot.values.rsi14 > 90);
    assert.ok(snapshot.values.atr14 > 0);
    assert.ok(snapshot.values.priceVsSma20 > 0);
  });
};
