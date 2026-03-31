import fs from 'fs';
import path from 'path';
import { createRuntime } from '../src/app/createRuntime.mjs';
import { BacktestEngine } from '../src/core/backtest/BacktestEngine.mjs';
import { SimpleRuleDecisionEngine } from '../src/core/backtest/SimpleRuleDecisionEngine.mjs';
import { normalizeEpochMs } from '../src/core/market/time.mjs';

const SUMMARY_DIR = path.resolve(process.cwd(), 'storage/reports/backtests/batches');

const parseArgs = (argv) => {
  const args = {
    days: 30,
    start: null,
    end: null,
    stepTimeframe: '30m',
    initialCash: 100_000,
    slippageBps: 3,
    feePerOrder: 0.5,
    feePerShare: 0,
    symbols: null,
    limit: null,
    writeReports: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--days':
        args.days = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--start':
        args.start = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--end':
        args.end = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--step':
        args.stepTimeframe = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--cash':
        args.initialCash = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--slippage-bps':
        args.slippageBps = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--fee-order':
        args.feePerOrder = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--fee-share':
        args.feePerShare = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--symbols':
        args.symbols = String(value)
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean);
        if (inlineValue === undefined) index += 1;
        break;
      case '--limit':
        args.limit = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--write-reports':
        args.writeReports = true;
        break;
      default:
        if (flag.startsWith('--')) throw new Error(`Unsupported flag ${flag}`);
    }
  }

  return args;
};

const resolveWindow = (options) => {
  const endMs = options.end ? normalizeEpochMs(options.end, 'end') : Date.now();
  const startMs = options.start
    ? normalizeEpochMs(options.start, 'start')
    : endMs - Math.max(1, options.days) * 24 * 60 * 60 * 1000;

  if (endMs <= startMs) {
    throw new Error(`Batch backtest end must be after start, received ${startMs} -> ${endMs}`);
  }

  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
};

const writeSummary = (payload) => {
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });
  const reportPath = path.resolve(SUMMARY_DIR, `batch-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  return reportPath;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const window = resolveWindow(options);
  const configuredSymbols = runtime.configStore.getEnabledSymbols();
  const selectedSymbols = Array.isArray(options.symbols) && options.symbols.length ? options.symbols : configuredSymbols;
  const symbols = Number.isFinite(options.limit) && options.limit > 0 ? selectedSymbols.slice(0, options.limit) : selectedSymbols.slice();

  const backtestEngine = new BacktestEngine({
    configStore: runtime.configStore,
    marketCalendar: runtime.marketCalendar,
    sourceMarketDataProvider: runtime.marketDataProvider,
    indicatorEngine: runtime.indicatorEngine,
  });
  const decisionEngine = new SimpleRuleDecisionEngine({
    symbolProfiles: runtime.configStore.getStrategyProfileMap(),
  });

  const rows = [];
  for (const symbol of symbols) {
    const report = await backtestEngine.run({
      symbol,
      startMs: window.startMs,
      endMs: window.endMs,
      stepTimeframe: options.stepTimeframe,
      initialCash: options.initialCash,
      decisionEngine,
      brokerOptions: {
        slippageBps: options.slippageBps,
        feePerOrder: options.feePerOrder,
        feePerShare: options.feePerShare,
      },
      writeReport: options.writeReports,
    });

    rows.push({
      symbol,
      strategyProfile: runtime.configStore.getStrategyProfile(symbol),
      relatedSymbols: runtime.configStore.getRelatedSymbols(symbol),
      netPnl: report.metrics.netPnl,
      grossPnlBeforeCosts: report.metrics.grossPnlBeforeCosts,
      tradeCount: report.metrics.tradeCount,
      wins: report.metrics.wins,
      losses: report.metrics.losses,
      winRate: report.metrics.winRate,
      maxDrawdownPct: report.metrics.maxDrawdownPct,
      costDrag: report.metrics.costDrag,
      finalEquity: report.metrics.finalEquity,
      reportPath: report.reportPath,
    });
  }

  rows.sort((left, right) => right.netPnl - left.netPnl);
  const totals = {
    symbolCount: rows.length,
    profitableSymbols: rows.filter((entry) => entry.netPnl > 0).length,
    losingSymbols: rows.filter((entry) => entry.netPnl < 0).length,
    flatSymbols: rows.filter((entry) => entry.netPnl === 0).length,
    aggregateNetPnl: rows.reduce((sum, entry) => sum + entry.netPnl, 0),
    aggregateGrossPnlBeforeCosts: rows.reduce((sum, entry) => sum + entry.grossPnlBeforeCosts, 0),
    aggregateCostDrag: rows.reduce((sum, entry) => sum + entry.costDrag, 0),
    aggregateTrades: rows.reduce((sum, entry) => sum + entry.tradeCount, 0),
  };

  const payload = {
    type: 'backtest_batch',
    generatedAtMs: Date.now(),
    runtime: runtime.describe(),
    window: {
      startMs: window.startMs,
      endMs: window.endMs,
      startIso: window.startIso,
      endIso: window.endIso,
      stepTimeframe: options.stepTimeframe,
    },
    costModel: {
      slippageBps: options.slippageBps,
      feePerOrder: options.feePerOrder,
      feePerShare: options.feePerShare,
    },
    symbols,
    totals,
    rows,
    summaryReportPath: null,
  };

  payload.summaryReportPath = writeSummary(payload);
  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error('[BACKTEST BATCH] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
