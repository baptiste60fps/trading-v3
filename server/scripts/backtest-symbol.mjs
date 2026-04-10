import { createRuntime } from '../src/app/createRuntime.mjs';
import { BacktestEngine } from '../src/core/backtest/BacktestEngine.mjs';
import { HybridBacktestDecisionEngine } from '../src/core/backtest/HybridBacktestDecisionEngine.mjs';
import { SimpleRuleDecisionEngine } from '../src/core/backtest/SimpleRuleDecisionEngine.mjs';

const parseArgs = (argv) => {
  const args = {
    symbol: 'AAPL',
    days: 5,
    startMs: null,
    endMs: null,
    stepTimeframe: '30m',
    initialCash: 100_000,
    decisionMode: 'rule',
    slippageBps: 3,
    feePerOrder: 0.5,
    feePerShare: 0,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      positional.push(entry);
      continue;
    }

    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--start':
        args.startMs = Date.parse(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--end':
        args.endMs = Date.parse(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--days':
        args.days = Number(value);
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
      case '--mode':
        args.decisionMode = value;
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
      default:
        throw new Error(`Unsupported flag ${flag}`);
    }
  }

  if (positional[0]) args.symbol = String(positional[0]).toUpperCase();
  return args;
};

const resolveWindow = (options) => {
  if (Number.isFinite(options.startMs) && Number.isFinite(options.endMs)) {
    return {
      startMs: options.startMs,
      endMs: options.endMs,
    };
  }

  const endMs = Number.isFinite(options.endMs) ? options.endMs : Date.now();
  const startMs = Number.isFinite(options.startMs)
    ? options.startMs
    : endMs - Math.max(1, options.days) * 24 * 60 * 60 * 1000;

  return {
    startMs,
    endMs,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const runtimeSummary = runtime.describe();
  const { startMs, endMs } = resolveWindow(options);
  const ruleDecisionEngine = new SimpleRuleDecisionEngine({
        symbolProfiles: runtime.configStore.getStrategyProfileMap(),
      });
  const decisionEngine = options.decisionMode === 'llm'
    ? runtime.decisionEngine
    : options.decisionMode === 'hybrid'
      ? new HybridBacktestDecisionEngine({
          deterministicEntryPolicy: runtime.deterministicEntryPolicy,
          fallbackDecisionEngine: ruleDecisionEngine,
          executionConfig: runtime.configStore.getExecutionConfig(),
        })
      : ruleDecisionEngine;
  const backtestEngine = new BacktestEngine({
    configStore: runtime.configStore,
    marketCalendar: runtime.marketCalendar,
    sourceMarketDataProvider: runtime.marketDataProvider,
    indicatorEngine: runtime.indicatorEngine,
  });

  const report = await backtestEngine.run({
    symbol: options.symbol,
    startMs,
    endMs,
    stepTimeframe: options.stepTimeframe,
    initialCash: options.initialCash,
    decisionEngine,
    brokerOptions: {
      slippageBps: options.slippageBps,
      feePerOrder: options.feePerOrder,
      feePerShare: options.feePerShare,
    },
  });

  console.log(
    JSON.stringify(
      {
        runtime: runtimeSummary,
        symbol: report.symbol,
        window: report.window,
        decisionEngine: report.decisionEngine,
        costModel: report.costModel,
        metrics: report.metrics,
        finalPortfolioState: report.finalPortfolioState,
        closedTrades: report.closedTrades,
        reportPath: report.reportPath,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error('[BACKTEST] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
