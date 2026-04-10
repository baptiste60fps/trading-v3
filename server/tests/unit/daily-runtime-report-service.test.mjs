import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { ConfigStore } from '../../src/config/ConfigStore.mjs';
import { DailyRuntimeReportService } from '../../src/services/reports/DailyRuntimeReportService.mjs';
import { makeServerRootFixture } from '../helpers/fixtures.mjs';

const makeConfigStore = async () => {
  const rootDir = makeServerRootFixture({
    runtimeConfig: {
      runtime: {
        mode: 'paper',
      },
      reports: {
        daily: {
          watchlistSymbols: ['AAPL', 'MSFT'],
        },
        runtimeDaily: {
          enabled: true,
          outputSubdir: 'runtime-daily',
        },
      },
      symbols: {
        default: {
          enabled: true,
          strategy: 'llm_long_v1',
          strategyProfile: 'single_stock',
        },
        AAPL: {
          enabled: true,
          strategyProfile: 'single_stock_quality',
        },
        MSFT: {
          enabled: true,
        },
      },
    },
  });

  const configStore = new ConfigStore({
    serverRootDir: rootDir,
    env: {},
  });
  await configStore.load();
  return { rootDir, configStore };
};

const baseBars = [
  { timestamp: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
  { timestamp: 2, open: 100.5, high: 102, low: 100, close: 101, volume: 1200 },
];

const baseTimeframes = {
  '1m': {
    values: {
      lastClose: 101,
      rsi14: 54,
      barCount: 120,
    },
  },
  '1h': {
    values: {
      lastClose: 101,
      rsi14: 57,
      emaGap12_26: 0.01,
      barCount: 48,
    },
  },
};

export const register = async ({ test }) => {
  test('DailyRuntimeReportService writes a daily runtime report with wakeup, bars, entries and exits', async () => {
    const { configStore } = await makeConfigStore();
    const wakeupCalls = [];
    const service = new DailyRuntimeReportService({
      configStore,
      dailyMarketReportService: {
        async generate({ targetSessionDate, symbols }) {
          wakeupCalls.push({ targetSessionDate, symbols });
          return {
            type: 'daily_market_report',
            reportDate: targetSessionDate,
            generatedAtMs: Date.UTC(2026, 3, 1, 12, 0, 0),
            reportPath: `/tmp/daily-report-${targetSessionDate}.json`,
            watchlist: (Array.isArray(symbols) ? symbols : []).map((symbol) => ({ symbol })),
          };
        },
      },
      now: () => Date.UTC(2026, 3, 1, 12, 0, 0),
    });

    const openAtMs = Date.UTC(2026, 3, 1, 13, 30, 0);
    await service.onCycleStarted({
      atMs: openAtMs,
      symbols: ['AAPL'],
      runtimeMode: 'paper',
      reason: 'startup',
    });

    await service.onStrategyEvaluated({
      symbol: 'AAPL',
      atMs: openAtMs,
      cycle: 1,
      reason: 'startup',
      ok: true,
      result: {
        features: {
          symbol: 'AAPL',
          currentPrice: 101,
          marketState: {
            sessionLabel: 'regular_open',
            isOpen: true,
          },
          portfolioState: {
            cash: 9000,
            equity: 10000,
            exposurePct: 0.1,
            positions: [],
          },
          position: null,
          riskState: {
            canOpen: true,
            canClose: true,
            flags: [],
          },
          shortBars: baseBars,
          timeframes: baseTimeframes,
          relatedSymbols: [],
        },
        decision: {
          action: 'open_long',
          reasoning: ['entry_signal'],
        },
        arbitration: {
          source: 'deterministic_entry',
          entryPolicyApplied: false,
          finalAction: 'open_long',
          finalConfidence: 0.91,
        },
        executionIntent: {
          action: 'open_long',
          qty: 10,
          referencePrice: 100,
          stopLossPct: 0.02,
        },
        executionResult: {
          accepted: true,
          status: 'dry_run',
          brokerOrderId: null,
        },
      },
      summary: {
        decisionAction: 'open_long',
        executionStatus: 'dry_run',
        marketSession: 'regular_open',
        currentPrice: 101,
      },
    });

    const closeAtMs = Date.UTC(2026, 3, 1, 14, 0, 0);
    await service.onStrategyEvaluated({
      symbol: 'AAPL',
      atMs: closeAtMs,
      cycle: 2,
      reason: 'scheduled',
      ok: true,
      result: {
        features: {
          symbol: 'AAPL',
          currentPrice: 102,
          marketState: {
            sessionLabel: 'regular_open',
            isOpen: true,
          },
          portfolioState: {
            cash: 10020,
            equity: 10020,
            exposurePct: 0,
            positions: [],
          },
          position: {
            symbol: 'AAPL',
            qty: 10,
            entryPrice: 100,
            currentPrice: 102,
            unrealizedPnl: 20,
            marketValue: 1020,
            openedAtMs: openAtMs,
          },
          riskState: {
            canOpen: true,
            canClose: true,
            flags: [],
          },
          shortBars: baseBars,
          timeframes: baseTimeframes,
          relatedSymbols: [],
        },
        decision: {
          action: 'close_long',
          reasoning: ['take_profit'],
        },
        arbitration: {
          source: 'exit_policy',
          entryPolicyApplied: false,
          finalAction: 'close_long',
          finalConfidence: 0.9,
        },
        executionIntent: {
          action: 'close_long',
          referencePrice: 102,
        },
        executionResult: {
          accepted: true,
          status: 'dry_run',
          brokerOrderId: null,
        },
      },
      summary: {
        decisionAction: 'close_long',
        executionStatus: 'dry_run',
        marketSession: 'regular_open',
        currentPrice: 102,
      },
    });

    const report = service.getCurrentReport();
    assert.equal(report.sessionDate, '2026-04-01');
    assert.equal(wakeupCalls.length, 1);
    assert.equal(report.entries.length, 1);
    assert.equal(report.exits.length, 1);
    assert.equal(report.exits[0].pnl, 20);
    assert.equal(report.entries[0].decisionSource, 'deterministic_entry');
    assert.equal(report.exits[0].decisionSource, 'exit_policy');
    assert.equal(report.cycleSummaries[0].decisionSource, 'deterministic_entry');
    assert.deepEqual(report.cycleSummaries[0].decisionReasoning, ['entry_signal']);
    assert.equal(report.symbols.AAPL.shortBars.length, 2);
    assert.equal(report.symbols.AAPL.strategyProfile, 'single_stock_quality');
    assert.equal(report.symbols.AAPL.arbitration.source, 'exit_policy');
    assert.equal(report.wakeupReport.reportDate, '2026-04-01');
    assert.ok(fs.existsSync(report.reportPath));

    const written = JSON.parse(fs.readFileSync(report.reportPath, 'utf8'));
    assert.equal(written.entries.length, 1);
    assert.equal(written.exits.length, 1);
    assert.equal(written.symbols.AAPL.timeframes['1h'].rsi14, 57);
  });

  test('DailyRuntimeReportService rolls over to a new file on a new session date', async () => {
    const { configStore } = await makeConfigStore();
    const wakeupCalls = [];
    const gitCommitCalls = [];
    const service = new DailyRuntimeReportService({
      configStore,
      dailyMarketReportService: {
        async generate({ targetSessionDate }) {
          wakeupCalls.push(targetSessionDate);
          return {
            type: 'daily_market_report',
            reportDate: targetSessionDate,
            generatedAtMs: Date.UTC(2026, 3, 1, 12, 0, 0),
            reportPath: `/tmp/daily-report-${targetSessionDate}.json`,
          };
        },
      },
      dailyGitCommitService: {
        async commitArtifacts(payload) {
          gitCommitCalls.push(payload);
          return {
            committed: true,
            message: `committed ${payload.sessionDate}`,
          };
        },
      },
    });

    await service.onCycleStarted({
      atMs: Date.UTC(2026, 3, 1, 13, 30, 0),
      symbols: ['AAPL'],
      runtimeMode: 'paper',
    });
    const firstReportPath = service.getCurrentReport().reportPath;

    await service.onCycleStarted({
      atMs: Date.UTC(2026, 3, 2, 13, 30, 0),
      symbols: ['MSFT'],
      runtimeMode: 'paper',
    });
    const secondReport = service.getCurrentReport();

    assert.equal(wakeupCalls.length, 2);
    assert.equal(gitCommitCalls.length, 1);
    assert.equal(gitCommitCalls[0].sessionDate, '2026-04-01');
    assert.ok(gitCommitCalls[0].paths.includes(firstReportPath));
    assert.equal(secondReport.sessionDate, '2026-04-02');
    assert.notEqual(secondReport.reportPath, firstReportPath);
    assert.deepEqual(secondReport.entries, []);
    assert.ok(fs.existsSync(secondReport.reportPath));
    assert.equal(path.basename(secondReport.reportPath), 'runtime-report-2026-04-02.json');
  });

  test('DailyRuntimeReportService can flush the current session git commit on demand', async () => {
    const { configStore } = await makeConfigStore();
    const gitCommitCalls = [];
    const service = new DailyRuntimeReportService({
      configStore,
      dailyGitCommitService: {
        async commitArtifacts(payload) {
          gitCommitCalls.push(payload);
          return {
            committed: true,
            message: `committed ${payload.sessionDate}`,
          };
        },
      },
    });

    await service.onCycleStarted({
      atMs: Date.UTC(2026, 3, 1, 13, 30, 0),
      symbols: ['AAPL'],
      runtimeMode: 'paper',
    });

    const report = service.getCurrentReport();
    const result = await service.flushCurrentSessionGitCommit();

    assert.equal(result.committed, true);
    assert.equal(gitCommitCalls.length, 1);
    assert.equal(gitCommitCalls[0].sessionDate, '2026-04-01');
    assert.ok(gitCommitCalls[0].paths.includes(report.reportPath));
  });

  test('DailyRuntimeReportService records execution rejection details in cycle summaries', async () => {
    const { configStore } = await makeConfigStore();
    const service = new DailyRuntimeReportService({
      configStore,
      now: () => Date.UTC(2026, 3, 1, 12, 0, 0),
    });

    await service.onStrategyEvaluated({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 1, 13, 30, 0),
      cycle: 1,
      reason: 'scheduled',
      ok: true,
      result: {
        features: {
          symbol: 'AAPL',
          currentPrice: 101,
          marketState: {
            sessionLabel: 'regular_open',
            isOpen: true,
          },
          portfolioState: {
            cash: 10_000,
            equity: 10_000,
            exposurePct: 0,
            positions: [],
          },
          position: null,
          riskState: {
            canOpen: true,
            canClose: true,
            flags: [],
          },
          shortBars: baseBars,
          timeframes: baseTimeframes,
          relatedSymbols: [],
        },
        decision: {
          action: 'open_long',
          reasoning: ['llm_open'],
        },
        executionIntent: {
          action: 'open_long',
        },
        executionResult: {
          accepted: false,
          status: 'rejected',
          error: {
            category: 'market',
            message: 'market is closed',
          },
        },
      },
    });

    const report = service.getCurrentReport();
    assert.equal(report.cycleSummaries[0].executionStatus, 'rejected');
    assert.equal(report.cycleSummaries[0].executionErrorCategory, 'market');
    assert.equal(report.cycleSummaries[0].executionErrorMessage, 'market is closed');
    assert.equal(report.cycleSummaries[0].error, 'market is closed');
    assert.deepEqual(report.cycleSummaries[0].decisionReasoning, ['llm_open']);
  });
};
