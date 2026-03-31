import { assertBar, assertSymbolId, assertTimeframe, isFiniteNumber } from '../types/validators.mjs';

const lastN = (values, count) => values.slice(Math.max(0, values.length - count));

const average = (values) => {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const standardDeviation = (values) => {
  if (values.length < 2) return null;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
};

const sma = (values, period) => {
  const window = lastN(values, period);
  if (window.length < period) return null;
  return average(window);
};

const ema = (values, period) => {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let acc = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    acc = values[index] * alpha + acc * (1 - alpha);
  }
  return acc;
};

const rsi = (values, period = 14) => {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  for (let index = values.length - period; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

const atr = (bars, period = 14) => {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
    sum += trueRange;
  }
  return sum / period;
};

const pctChange = (values, period) => {
  if (values.length < period + 1) return null;
  const start = values[values.length - period - 1];
  const end = values[values.length - 1];
  if (!isFiniteNumber(start) || Math.abs(start) < 1e-9) return null;
  return (end - start) / start;
};

const rangeHigh = (bars, period) => {
  const window = lastN(bars, period);
  if (window.length < period) return null;
  return Math.max(...window.map((bar) => bar.high));
};

const rangeLow = (bars, period) => {
  const window = lastN(bars, period);
  if (window.length < period) return null;
  return Math.min(...window.map((bar) => bar.low));
};

const pushValue = (target, key, value) => {
  if (isFiniteNumber(value)) target[key] = value;
};

export class IndicatorEngine {
  compute({ symbol, timeframe, bars, atMs } = {}) {
    const safeSymbol = assertSymbolId(String(symbol ?? '').toUpperCase());
    const safeTimeframe = assertTimeframe(timeframe);
    const safeBars = Array.isArray(bars) ? bars.map((bar) => assertBar(bar)).sort((left, right) => left.startMs - right.startMs) : [];

    const closes = safeBars.map((bar) => bar.close).filter((value) => isFiniteNumber(value));
    const values = {
      barCount: safeBars.length,
    };

    if (!safeBars.length || !closes.length) {
      return {
        symbol: safeSymbol,
        timeframe: safeTimeframe,
        atMs,
        values,
      };
    }

    const lastClose = closes[closes.length - 1];
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const rsi14 = rsi(closes, 14);
    const atr14 = atr(safeBars, 14);
    const stdev20 = standardDeviation(lastN(closes, 20));
    const return5 = pctChange(closes, 5);
    const return20 = pctChange(closes, 20);
    const return50 = pctChange(closes, 50);
    const high20 = rangeHigh(safeBars, 20);
    const low20 = rangeLow(safeBars, 20);

    pushValue(values, 'lastClose', lastClose);
    pushValue(values, 'sma20', sma20);
    pushValue(values, 'sma50', sma50);
    pushValue(values, 'ema12', ema12);
    pushValue(values, 'ema26', ema26);
    pushValue(values, 'rsi14', rsi14);
    pushValue(values, 'atr14', atr14);
    pushValue(values, 'stdev20', stdev20);
    pushValue(values, 'return5', return5);
    pushValue(values, 'return20', return20);
    pushValue(values, 'return50', return50);
    pushValue(values, 'high20', high20);
    pushValue(values, 'low20', low20);

    if (isFiniteNumber(sma20) && Math.abs(sma20) > 1e-9) pushValue(values, 'priceVsSma20', (lastClose - sma20) / sma20);
    if (isFiniteNumber(ema12) && isFiniteNumber(ema26) && Math.abs(ema26) > 1e-9) pushValue(values, 'emaGap12_26', (ema12 - ema26) / ema26);
    if (isFiniteNumber(atr14) && Math.abs(lastClose) > 1e-9) pushValue(values, 'atrPct14', atr14 / lastClose);

    return {
      symbol: safeSymbol,
      timeframe: safeTimeframe,
      atMs,
      values,
    };
  }
}
