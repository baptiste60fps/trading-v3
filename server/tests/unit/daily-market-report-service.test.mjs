import assert from 'assert/strict';
import os from 'os';
import path from 'path';
import { DailyMarketReportService } from '../../src/services/reports/DailyMarketReportService.mjs';

const makeConfigStore = () => ({
  getRuntimeConfig() {
    return { mode: 'paper' };
  },
  getMarketConfig() {
    return { timezone: 'America/New_York' };
  },
  getReportsConfig() {
    return {
      daily: {
        outputSubdir: 'daily-tests',
        watchlistSymbols: ['AAPL', 'META'],
        maxNewsItemsPerFeed: 3,
        includeLlmAnalysis: true,
      },
    };
  },
  getNewsConfig() {
    return {
      enabled: true,
      maxItemsPerFeed: 3,
    };
  },
  getExecutionConfig() {
    return { dryRun: true };
  },
  getEnabledSymbols() {
    return ['AAPL', 'META'];
  },
  getSymbolConfig(symbol) {
    return {
      strategyProfile: symbol === 'META' ? 'single_stock_quality' : 'single_stock_quality',
    };
  },
  getStrategyProfile(symbol) {
    return this.getSymbolConfig(symbol).strategyProfile;
  },
  getStorageConfig() {
    return {
      reportsDir: path.resolve(os.tmpdir(), 'baptisto-trading-v3-tests'),
    };
  },
});

const makeFeatureSnapshot = (symbol) => ({
  symbol,
  currentPrice: symbol === 'AAPL' ? 210 : 640,
  marketState: {
    isOpen: false,
    sessionLabel: 'before_open',
  },
  position: null,
  riskState: {
    canOpen: true,
    flags: [],
  },
  timeframes: {
    '5m': { values: { lastClose: 1, rsi14: 50, atrPct14: 0.01, priceVsSma20: -0.002, emaGap12_26: 0.001, barCount: 120 } },
    '1h': { values: { lastClose: 1, rsi14: 55, atrPct14: 0.02, priceVsSma20: 0.004, emaGap12_26: 0.003, barCount: 120 } },
    '4h': { values: { lastClose: 1, rsi14: 58, atrPct14: 0.03, priceVsSma20: 0.006, emaGap12_26: 0.004, barCount: 120 } },
    '1d': { values: { lastClose: 1, rsi14: 60, atrPct14: 0.04, priceVsSma20: 0.01, emaGap12_26: 0.005, barCount: 120 } },
  },
  relatedSymbols: [
    {
      symbol: 'SPY',
      timeframes: {
        '1h': { values: { emaGap12_26: 0.002, rsi14: 53 } },
        '4h': { values: { emaGap12_26: 0.003, rsi14: 56 } },
      },
    },
  ],
});

export const register = async ({ test }) => {
  test('DailyMarketReportService builds a structured daily report from watchlist, news and LLM output', async () => {
    const service = new DailyMarketReportService({
      configStore: makeConfigStore(),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: false,
            sessionLabel: 'before_open',
          };
        },
      },
      portfolioService: {
        async getSnapshot() {
          return {
            cash: 100_000,
            equity: 100_500,
            exposurePct: 0.1,
            positions: [],
          };
        },
      },
      featureSnapshotService: {
        async build({ symbol }) {
          return makeFeatureSnapshot(symbol);
        },
      },
      rssFeedService: {
        async fetchAll() {
          return [
            {
              feedId: 'sec_press',
              name: 'SEC Press',
              url: 'https://example.com/rss.xml',
              status: 'ok',
              source: 'network',
              fetchedAtMs: Date.now(),
              itemCount: 1,
              items: [
                {
                  title: 'SEC headlines',
                  link: 'https://example.com/sec',
                  publishedAt: '2026-03-30T12:00:00.000Z',
                  summary: 'Context',
                },
              ],
            },
          ];
        },
      },
      modelClient: {
        async generateJson() {
          return JSON.stringify({
            marketTone: 'risk_on',
            summary: 'Setup quality is improving into the open.',
            keyRisks: ['earnings volatility'],
            keyCatalysts: ['macro headlines'],
            watchlist: [
              { symbol: 'AAPL', bias: 'watch_long', confidence: 0.72, note: 'Clean 1h momentum.' },
              { symbol: 'META', bias: 'stand_aside', confidence: 0.52, note: 'Wait for cleaner pullback.' },
            ],
            preOpenChecklist: [
              { item: 'Alpaca paper connectivity', status: 'ready', note: 'Connected.' },
            ],
          });
        },
      },
      llmConfig: {
        enabled: true,
        provider: 'ollama',
        model: 'qwen2.5:7b',
      },
    });

    const report = await service.generate({
      atMs: Date.parse('2026-03-30T12:00:00.000Z'),
      targetSessionDate: '2026-03-31',
      writeReport: false,
    });

    assert.equal(report.reportDate, '2026-03-31');
    assert.equal(report.watchlist.length, 2);
    assert.equal(report.news.feedCount, 1);
    assert.equal(report.llm.status, 'ready');
    assert.equal(report.llm.analysis.marketTone, 'risk_on');
    assert.equal(report.llm.analysis.watchlist[0].symbol, 'AAPL');
    assert.equal(report.llm.analysis.watchlist[0].bias, 'watch_long');
    assert.equal(report.reportPath, null);
  });

  test('DailyMarketReportService falls back to heuristic JSON when the model fails', async () => {
    const service = new DailyMarketReportService({
      configStore: makeConfigStore(),
      marketCalendar: {
        getMarketState() {
          return {
            isOpen: false,
            sessionLabel: 'before_open',
          };
        },
      },
      portfolioService: {
        async getSnapshot() {
          return {
            cash: 95_000,
            equity: 100_000,
            exposurePct: 0.2,
            positions: [],
          };
        },
      },
      featureSnapshotService: {
        async build({ symbol }) {
          return makeFeatureSnapshot(symbol);
        },
      },
      rssFeedService: {
        async fetchAll() {
          return [];
        },
      },
      modelClient: {
        async generateJson() {
          throw new Error('ollama unavailable');
        },
      },
      llmConfig: {
        enabled: true,
        provider: 'ollama',
        model: 'qwen2.5:7b',
      },
    });

    const report = await service.generate({
      atMs: Date.parse('2026-03-30T12:00:00.000Z'),
      targetSessionDate: '2026-03-31',
      writeReport: false,
    });

    assert.equal(report.llm.status, 'fallback');
    assert.equal(report.llm.analysis.watchlist.length, 2);
    assert.ok(['risk_on', 'mixed', 'risk_off'].includes(report.llm.analysis.marketTone));
    assert.ok(report.llm.analysis.preOpenChecklist.length >= 1);
  });
};
