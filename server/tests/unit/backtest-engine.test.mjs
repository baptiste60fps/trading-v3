import assert from 'assert/strict';
import os from 'os';
import path from 'path';
import { BacktestEngine } from '../../src/core/backtest/BacktestEngine.mjs';
import { SimpleRuleDecisionEngine } from '../../src/core/backtest/SimpleRuleDecisionEngine.mjs';
import { IndicatorEngine } from '../../src/core/indicators/IndicatorEngine.mjs';

const makeBars = ({ symbol, timeframe, count, stepMs, startMs, startPrice }) =>
  Array.from({ length: count }, (_, index) => {
    const close = startPrice + index * 0.5;
    return {
      symbol,
      timeframe,
      startMs: startMs + index * stepMs,
      endMs: startMs + (index + 1) * stepMs,
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.4,
      close,
      volume: 1_000 + index,
      tradeCount: 10 + index,
      source: 'test-backtest',
    };
  });

class FakeConfigStore {
  constructor() {
    this.storage = {
      reportsDir: path.resolve(os.tmpdir(), 'baptisto-trading-v3-tests'),
    };
  }

  getSymbolConfig() {
    return {
      timeframes: ['1m', '5m', '15m', '1h', '1d'],
      evaluationTimeframes: ['10s', '1m', '5m'],
      lookbackBars: 20,
      risk: {
        maxPositionPct: 0.5,
        maxPortfolioExposurePct: 1,
      },
    };
  }

  getRelatedSymbols() {
    return ['SPY', 'QQQ'];
  }

  getStorageConfig() {
    return this.storage;
  }

  getMarketConfig() {
    return {
      timezone: 'America/New_York',
    };
  }

  getRuntimeConfig() {
    return {
      mode: 'backtest',
    };
  }

  getExecutionConfig() {
    return {
      dryRun: false,
    };
  }

  getLlmConfig() {
    return {
      enabled: false,
      provider: 'ollama',
      model: 'qwen2.5:7b',
    };
  }

  getReportsConfig() {
    return {
      backtests: {
        enabled: true,
        outputSubdir: 'backtests',
      },
    };
  }

  getStrategyProfile() {
    return 'single_stock';
  }

  getEnabledSymbols() {
    return ['AAPL'];
  }
}

class FakeMarketCalendar {
  getMarketState() {
    return {
      isOpen: true,
      isPreClose: false,
      isNoTradeOpen: false,
      sessionLabel: 'regular_open',
    };
  }
}

class FakeSourceMarketDataProvider {
  constructor() {
    const startMs = Date.parse('2026-03-23T13:30:00.000Z');
    this.dataset = {
      AAPL: {
        '1m': makeBars({ symbol: 'AAPL', timeframe: '1m', count: 300, stepMs: 60_000, startMs, startPrice: 100 }),
        '5m': makeBars({ symbol: 'AAPL', timeframe: '5m', count: 120, stepMs: 300_000, startMs, startPrice: 100 }),
        '15m': makeBars({ symbol: 'AAPL', timeframe: '15m', count: 120, stepMs: 900_000, startMs, startPrice: 100 }),
        '1h': makeBars({ symbol: 'AAPL', timeframe: '1h', count: 80, stepMs: 3_600_000, startMs, startPrice: 100 }),
        '1d': makeBars({ symbol: 'AAPL', timeframe: '1d', count: 40, stepMs: 86_400_000, startMs, startPrice: 100 }),
      },
      SPY: {
        '1m': makeBars({ symbol: 'SPY', timeframe: '1m', count: 300, stepMs: 60_000, startMs, startPrice: 400 }),
        '5m': makeBars({ symbol: 'SPY', timeframe: '5m', count: 120, stepMs: 300_000, startMs, startPrice: 400 }),
        '15m': makeBars({ symbol: 'SPY', timeframe: '15m', count: 120, stepMs: 900_000, startMs, startPrice: 400 }),
        '1h': makeBars({ symbol: 'SPY', timeframe: '1h', count: 80, stepMs: 3_600_000, startMs, startPrice: 400 }),
        '1d': makeBars({ symbol: 'SPY', timeframe: '1d', count: 40, stepMs: 86_400_000, startMs, startPrice: 400 }),
      },
      QQQ: {
        '1m': makeBars({ symbol: 'QQQ', timeframe: '1m', count: 300, stepMs: 60_000, startMs, startPrice: 300 }),
        '5m': makeBars({ symbol: 'QQQ', timeframe: '5m', count: 120, stepMs: 300_000, startMs, startPrice: 300 }),
        '15m': makeBars({ symbol: 'QQQ', timeframe: '15m', count: 120, stepMs: 900_000, startMs, startPrice: 300 }),
        '1h': makeBars({ symbol: 'QQQ', timeframe: '1h', count: 80, stepMs: 3_600_000, startMs, startPrice: 300 }),
        '1d': makeBars({ symbol: 'QQQ', timeframe: '1d', count: 40, stepMs: 86_400_000, startMs, startPrice: 300 }),
      },
    };
  }

  supportsTimeframe(timeframe) {
    return ['1m', '5m', '15m', '1h', '1d'].includes(timeframe);
  }

  async getBars({ symbol, timeframe, startMs, endMs, limit = 10_000 }) {
    const rows = this.dataset?.[symbol]?.[timeframe] ?? [];
    const filtered = rows.filter((bar) => bar.startMs >= startMs && bar.endMs <= endMs);
    return filtered.slice(0, limit);
  }
}

class ScriptedDecisionEngine {
  constructor() {
    this.calls = 0;
  }

  async decide({ features }) {
    this.calls += 1;
    if (!features.position && this.calls === 1) {
      return {
        action: 'open_long',
        confidence: 0.8,
        reasoning: ['first_entry'],
        requestedSizePct: 0.5,
        stopLossPct: 0.02,
        takeProfitPct: 0.04,
      };
    }

    if (features.position && this.calls === 3) {
      return {
        action: 'close_long',
        confidence: 0.75,
        reasoning: ['scripted_exit'],
        requestedSizePct: null,
        stopLossPct: null,
        takeProfitPct: null,
      };
    }

    return {
      action: features.position ? 'hold' : 'skip',
      confidence: 0.5,
      reasoning: ['wait'],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
    };
  }
}

export const register = async ({ test }) => {
  test('BacktestEngine replays data and produces a closed trade report', async () => {
    const engine = new BacktestEngine({
      configStore: new FakeConfigStore(),
      marketCalendar: new FakeMarketCalendar(),
      sourceMarketDataProvider: new FakeSourceMarketDataProvider(),
      indicatorEngine: new IndicatorEngine(),
    });

    const report = await engine.run({
      symbol: 'AAPL',
      startMs: Date.parse('2026-03-23T14:30:00.000Z'),
      endMs: Date.parse('2026-03-23T16:30:00.000Z'),
      stepTimeframe: '5m',
      initialCash: 10_000,
      decisionEngine: new ScriptedDecisionEngine(),
      writeReport: false,
    });

    assert.equal(report.symbol, 'AAPL');
    assert.equal(report.metrics.tradeCount, 1);
    assert.ok(report.metrics.finalEquity > 10_000);
    assert.ok(report.closedTrades[0].pnl > 0);
    assert.equal(report.events[0].signalContext, null);
    assert.ok(report.events.length > 0);
    assert.equal(report.reportPath, null);
  });

  test('BacktestEngine emits a runtime-like report labeled as backtests', async () => {
    const dailyMarketReportService = {
      async generate({ targetSessionDate, symbols }) {
        return {
          type: 'daily_market_report',
          sessionDate: targetSessionDate,
          symbolsTracked: symbols,
          reportPath: `/tmp/daily-report-${targetSessionDate}.json`,
        };
      },
    };
    const engine = new BacktestEngine({
      configStore: new FakeConfigStore(),
      marketCalendar: new FakeMarketCalendar(),
      sourceMarketDataProvider: new FakeSourceMarketDataProvider(),
      indicatorEngine: new IndicatorEngine(),
      dailyMarketReportService,
      now: () => Date.parse('2026-03-23T20:00:00.000Z'),
    });

    const report = await engine.run({
      symbol: 'AAPL',
      startMs: Date.parse('2026-03-23T14:30:00.000Z'),
      endMs: Date.parse('2026-03-23T16:30:00.000Z'),
      stepTimeframe: '5m',
      initialCash: 10_000,
      decisionEngine: new ScriptedDecisionEngine(),
      writeReport: false,
    });

    assert.equal(report.type, 'backtest_daily_report');
    assert.equal(report.reportFamily, 'backtests');
    assert.equal(report.runtime.mode, 'backtest');
    assert.equal(report.market.timezone, 'America/New_York');
    assert.equal(report.wakeupReportPath, '/tmp/daily-report-2026-03-23.json');
    assert.equal(report.entries.length, 1);
    assert.equal(report.exits.length, 1);
    assert.equal(report.cycleSummaries.length, report.events.length);
    assert.ok(report.symbols.AAPL);
    assert.ok(Array.isArray(report.symbols.AAPL.shortBars));
    assert.ok(report.symbols.AAPL.shortBars.length > 0);
    assert.ok(report.symbols.AAPL.timeframes['5m']);
    assert.equal(report.accountLatest.positions.length, 0);
  });

  test('SimpleRuleDecisionEngine opens on aligned trend and closes on stop loss', async () => {
    const engine = new SimpleRuleDecisionEngine();
    const openDecision = await engine.decide({
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.01,
              priceVsSma20: 0.002,
              rsi14: 58,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.02,
              rsi14: 60,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.01, rsi14: 45 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.005, rsi14: 42 } } } },
        ],
      },
    });

    assert.equal(openDecision.action, 'open_long');
    assert.ok(openDecision.requestedSizePct > 0);

    const closeDecision = await engine.decide({
      features: {
        currentPrice: 96,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: {
          symbol: 'AAPL',
          side: 'long',
          qty: 10,
          entryPrice: 100,
          stopLossPct: 0.02,
          takeProfitPct: 0.04,
        },
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.005,
              rsi14: 53,
            },
          },
        },
      },
    });

    assert.equal(closeDecision.action, 'close_long');
    assert.equal(closeDecision.reasoning[0], 'stop_loss_hit');
  });

  test('SimpleRuleDecisionEngine skips weak setups when 1h context is bearish', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.01,
              priceVsSma20: 0.003,
              rsi14: 58,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: -0.006,
              rsi14: 27,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.002, rsi14: 45 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 44 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'medium_context_bearish');
  });

  test('SimpleRuleDecisionEngine skips low-conviction setups when related context is degraded', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: -0.001,
              priceVsSma20: -0.009,
              rsi14: 41,
              atrPct14: 0.012,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.001,
              rsi14: 44,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.007, rsi14: 39 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0065, rsi14: 39 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'related_context_degraded');
    assert.equal(decision.signalContext.degradedRelatedContext, true);
  });

  test('SimpleRuleDecisionEngine skips late entries when medium context is overextended', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.003,
              priceVsSma20: 0.001,
              rsi14: 49,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.008,
              rsi14: 82,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 52 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0015, rsi14: 51 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'medium_context_overextended');
    assert.equal(decision.signalContext.overextendedMediumContext, true);
  });

  test('SimpleRuleDecisionEngine skips opens when medium trend is not confirmed', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'SPY',
      strategyConfig: {
        strategyProfile: 'index_etf',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.002,
              priceVsSma20: 0.001,
              rsi14: 58,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: -0.001,
              rsi14: 55,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.002, rsi14: 52 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 50 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'medium_trend_not_confirmed');
    assert.equal(decision.signalContext.mediumTrendConfirmed, false);
    assert.equal(decision.signalContext.strategyProfile, 'index_etf');
  });

  test('SimpleRuleDecisionEngine allows a strong generic single stock setup under a mildly negative medium gap', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'PYPL',
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.003,
              priceVsSma20: 0.002,
              rsi14: 55,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: -0.0005,
              rsi14: 55,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.002, rsi14: 52 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 50 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.signalContext.strategyProfile, 'single_stock');
    assert.equal(decision.signalContext.mediumTrendConfirmed, true);
  });

  test('SimpleRuleDecisionEngine requires a deeper fast pullback for secondary entries', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.001,
              priceVsSma20: -0.015,
              rsi14: 44,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.004,
              rsi14: 62,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.003, rsi14: 49 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 48 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'pullback_not_deep_enough');
  });

  test('SimpleRuleDecisionEngine skips score 9 entries that chase short-term strength', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'SPY',
      strategyConfig: {
        strategyProfile: 'index_etf',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.003,
              priceVsSma20: 0.002,
              rsi14: 66,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.005,
              rsi14: 58,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.002, rsi14: 52 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 51 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'score9_chasing_strength');
  });

  test('SimpleRuleDecisionEngine classifies NVDA as high beta and requires a fast turn confirmation', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'NVDA',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: -0.0005,
              priceVsSma20: 0.001,
              rsi14: 53,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.005,
              rsi14: 60,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0015, rsi14: 49 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'high_beta_fast_turn_not_confirmed');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
  });

  test('SimpleRuleDecisionEngine skips high beta entries when the medium context is overheated', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'NVDA',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0008,
              priceVsSma20: 0.0015,
              rsi14: 55,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.0085,
              rsi14: 66,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.001, rsi14: 51 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0015, rsi14: 50 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'primary_context_overheated');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
  });

  test('SimpleRuleDecisionEngine skips high beta entries when the medium RSI is too hot', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'NVDA',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.001,
              priceVsSma20: 0.001,
              rsi14: 54,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.006,
              rsi14: 75,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'primary_context_overheated');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
  });

  test('SimpleRuleDecisionEngine classifies AAPL as quality stock and skips overheated primary setups', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'AAPL',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0008,
              priceVsSma20: 0.0008,
              rsi14: 55,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.005,
              rsi14: 75,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'primary_context_overheated');
    assert.equal(decision.signalContext.strategyProfile, 'single_stock_quality');
  });

  test('SimpleRuleDecisionEngine opens a clean quality single stock setup with reduced size', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'AAPL',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0008,
              priceVsSma20: 0.0006,
              rsi14: 54,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.004,
              rsi14: 68,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.signalContext.strategyProfile, 'single_stock_quality');
    assert.ok(decision.requestedSizePct <= 0.04);
  });

  test('SimpleRuleDecisionEngine applies symbol quality overrides to reject weak related confirmation', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'META',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
        strategyRules: {
          minimumRelatedTrend: 0.001,
          minimumRelatedRsi: 48,
        },
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: -0.0003,
              priceVsSma20: 0.0014,
              rsi14: 52,
              atrPct14: 0.0013,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.0026,
              rsi14: 66,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.0004, rsi14: 46 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0003, rsi14: 45.5 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'related_context_too_weak');
    assert.equal(decision.signalContext.strategyProfile, 'single_stock_quality');
  });

  test('SimpleRuleDecisionEngine opens a symbol-specific quality scout entry on a clean pullback', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'META',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
        strategyRules: {
          enableScoutEntries: true,
          scoutMinimumEntryScore: 8,
          scoutMinimumContextScore: 4,
          scoutRequirePrimaryMediumContext: true,
          scoutMinimumMediumRsi: 65,
          scoutMinimumRelatedTrend: 0.003,
          scoutMinimumRelatedRsi: 54,
          scoutMinimumFastRsi: 49,
          scoutMaximumFastRsi: 51,
          scoutMaximumFastPriceVsSma: -0.001,
          scoutRequestedSizeScale: 0.4,
          scoutMaxRequestedSizePct: 0.015,
        },
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0001,
              priceVsSma20: -0.0019,
              rsi14: 49.9,
              atrPct14: 0.0013,
            },
          },
          '1h': {
            values: {
              rsi14: 66.3,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.0036, rsi14: 55 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0035, rsi14: 54.5 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.reasoning[0], 'scout_entry');
    assert.equal(decision.signalContext.scoutEntry, true);
    assert.ok(decision.requestedSizePct <= 0.015);
  });

  test('SimpleRuleDecisionEngine keeps skipping a scout setup when the pullback is not deep enough', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'META',
      strategyConfig: {
        strategyProfile: 'single_stock_quality',
        strategyRules: {
          enableScoutEntries: true,
          scoutMinimumEntryScore: 8,
          scoutMinimumContextScore: 4,
          scoutRequirePrimaryMediumContext: true,
          scoutMinimumMediumRsi: 65,
          scoutMinimumRelatedTrend: 0.003,
          scoutMinimumRelatedRsi: 54,
          scoutMinimumFastRsi: 49,
          scoutMaximumFastRsi: 51,
          scoutMaximumFastPriceVsSma: -0.001,
          scoutRequestedSizeScale: 0.4,
          scoutMaxRequestedSizePct: 0.015,
        },
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0001,
              priceVsSma20: 0.0001,
              rsi14: 49.9,
              atrPct14: 0.0013,
            },
          },
          '1h': {
            values: {
              rsi14: 66.3,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: 0.0036, rsi14: 55 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: 0.0035, rsi14: 54.5 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'low_conviction_context');
  });

  test('SimpleRuleDecisionEngine opens a clean high beta setup with reduced size', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'NVDA',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0009,
              priceVsSma20: 0.001,
              rsi14: 54,
              atrPct14: 0.01,
            },
          },
          '1h': {
            values: {
              emaGap12_26: 0.006,
              rsi14: 63,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '1h': { values: { emaGap12_26: -0.002, rsi14: 50 } } } },
          { timeframes: { '1h': { values: { emaGap12_26: -0.0015, rsi14: 49 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
    assert.ok(decision.requestedSizePct <= 0.035);
  });

  test('SimpleRuleDecisionEngine applies AMD overrides to reject weak fallback context', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'AMD',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
        strategyRules: {
          minimumMediumGapWhenFallback: 0.001,
          minimumFastEmaGap: 0.001,
          minimumFastRsi: 55,
          maximumFastRsi: 58,
          primaryFastRsiCeiling: 58,
          primaryChasePriceVsSmaCeiling: 0.0008,
        },
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0004,
              priceVsSma20: -0.001,
              rsi14: 46,
              atrPct14: 0.0021,
            },
          },
          '4h': {
            values: {
              emaGap12_26: 0.0002,
              rsi14: 51,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '4h': { values: { emaGap12_26: 0.003, rsi14: 60 } } } },
          { timeframes: { '4h': { values: { emaGap12_26: 0.0031, rsi14: 59 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reasoning[0], 'fast_context_too_weak');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
  });

  test('SimpleRuleDecisionEngine keeps a valid AMD fallback setup when symbol overrides still confirm momentum', async () => {
    const engine = new SimpleRuleDecisionEngine();

    const decision = await engine.decide({
      symbol: 'AMD',
      strategyConfig: {
        strategyProfile: 'high_beta_stock',
        strategyRules: {
          minimumMediumGapWhenFallback: 0.001,
          minimumFastEmaGap: 0.001,
          minimumFastRsi: 55,
          maximumFastRsi: 58,
          primaryFastRsiCeiling: 58,
          primaryChasePriceVsSmaCeiling: 0.0008,
          requestedSizeScale: 0.7,
          maxRequestedSizePct: 0.03,
        },
      },
      features: {
        currentPrice: 100,
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
        },
        position: null,
        timeframes: {
          '5m': {
            values: {
              emaGap12_26: 0.0027,
              priceVsSma20: 0.0001,
              rsi14: 57,
              atrPct14: 0.0036,
            },
          },
          '4h': {
            values: {
              emaGap12_26: 0.0017,
              rsi14: 52,
            },
          },
        },
        relatedSymbols: [
          { timeframes: { '4h': { values: { emaGap12_26: 0.0024, rsi14: 60 } } } },
          { timeframes: { '4h': { values: { emaGap12_26: 0.0023, rsi14: 59 } } } },
        ],
      },
    });

    assert.equal(decision.action, 'open_long');
    assert.equal(decision.signalContext.strategyProfile, 'high_beta_stock');
    assert.ok(decision.requestedSizePct <= 0.03);
  });

  test('BacktestEngine accounts for slippage and fees in cost metrics', async () => {
    const engine = new BacktestEngine({
      configStore: new FakeConfigStore(),
      marketCalendar: new FakeMarketCalendar(),
      sourceMarketDataProvider: new FakeSourceMarketDataProvider(),
      indicatorEngine: new IndicatorEngine(),
    });

    const report = await engine.run({
      symbol: 'AAPL',
      startMs: Date.parse('2026-03-23T14:30:00.000Z'),
      endMs: Date.parse('2026-03-23T16:30:00.000Z'),
      stepTimeframe: '5m',
      initialCash: 10_000,
      decisionEngine: new ScriptedDecisionEngine(),
      brokerOptions: {
        slippageBps: 5,
        feePerOrder: 1,
      },
      writeReport: false,
    });

    assert.ok(report.metrics.costDrag > 0);
    assert.ok(report.metrics.totalFees > 0);
    assert.ok(report.metrics.totalSlippageCost > 0);
    assert.ok(report.closedTrades[0].totalFees > 0);
    assert.ok(report.closedTrades[0].totalSlippageCost > 0);
  });
};
