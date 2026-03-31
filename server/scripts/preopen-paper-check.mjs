import { createRuntime } from '../src/app/createRuntime.mjs';
import { ExecutionEngine } from '../src/core/runtime/ExecutionEngine.mjs';
import { StrategyInstance } from '../src/core/strategy/StrategyInstance.mjs';

const formatDateInTimezone = (atMs, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));

const addDays = (dateString, days) => {
  const [year, month, day] = String(dateString).split('-').map((entry) => Number(entry));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

const parseArgs = (argv) => {
  const args = {
    targetDate: null,
    pilotSymbol: 'AAPL',
    symbols: null,
    writeReport: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const [flag, inlineValue] = entry.split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--target-date':
        args.targetDate = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--pilot-symbol':
        args.pilotSymbol = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--symbols':
        args.symbols = value;
        if (inlineValue === undefined) index += 1;
        break;
      case '--no-write':
        args.writeReport = false;
        break;
      default:
        if (!entry.startsWith('--')) continue;
        throw new Error(`Unsupported flag ${flag}`);
    }
  }

  return args;
};

const parseSymbols = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => String(entry).trim().toUpperCase())
    .filter(Boolean);

const buildCheck = (id, status, note, extra = {}) => ({
  id,
  status,
  note,
  ...extra,
});

const isDecisionFallback = (decision) =>
  Array.isArray(decision?.reasoning) &&
  decision.reasoning.some((entry) => String(entry).startsWith('decision_engine_fallback:'));

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const runtimeSummary = runtime.describe();
  const marketTimezone = runtime.configStore.getMarketConfig().timezone;
  const targetDate = args.targetDate ?? addDays(formatDateInTimezone(Date.now(), marketTimezone), 1);
  const watchlistSymbols = args.symbols ? parseSymbols(args.symbols) : null;

  const dailyReport = await runtime.dailyMarketReportService.generate({
    atMs: Date.now(),
    targetSessionDate: targetDate,
    symbols: watchlistSymbols,
    writeReport: args.writeReport,
  });

  const safeExecutionEngine = new ExecutionEngine({
    brokerGateway: runtime.brokerGateway,
    portfolioService: runtime.portfolioService,
    configStore: runtime.configStore,
    dryRun: true,
  });

  let pilotRun = null;
  let pilotError = null;
  try {
    const strategy = new StrategyInstance({
      symbol: String(args.pilotSymbol ?? 'AAPL').toUpperCase(),
      runtimeMode: runtimeSummary.runtimeMode,
      configStore: runtime.configStore,
      featureSnapshotService: runtime.featureSnapshotService,
      decisionEngine: runtime.decisionEngine,
      executionEngine: safeExecutionEngine,
    });
    const result = await strategy.runOnce(Date.now());
    pilotRun = {
      symbol: strategy.symbol,
      decision: result.decision,
      executionIntent: result.executionIntent,
      executionResult: result.executionResult,
    };
  } catch (error) {
    pilotError = error?.message ?? 'pilot_strategy_failed';
  }

  const checks = [
    buildCheck(
      'alpaca_account',
      dailyReport.account.error ? 'block' : 'ready',
      dailyReport.account.error ?? `Paper account reachable with ${dailyReport.account.positionCount} open position(s).`,
    ),
    buildCheck(
      'rss_feeds',
      dailyReport.news.okFeedCount >= 3 ? 'ready' : dailyReport.news.okFeedCount > 0 ? 'watch' : 'block',
      `${dailyReport.news.okFeedCount}/${dailyReport.news.feedCount} feed(s) fetched successfully.`,
    ),
    buildCheck(
      'ollama_daily_report',
      dailyReport.llm.status === 'ready' ? 'ready' : 'watch',
      dailyReport.llm.error ?? `Structured report generated with ${dailyReport.llm.model}.`,
      {
        provider: dailyReport.llm.provider,
        model: dailyReport.llm.model,
      },
    ),
    buildCheck(
      'execution_mode',
      runtimeSummary.executionDryRun ? 'watch' : 'ready',
      runtimeSummary.executionDryRun
        ? 'Runtime execution is still in dry-run. Disable it explicitly before the March 31, 2026 paper-open test if you want real paper orders.'
        : 'Paper execution can route real paper orders.',
    ),
    buildCheck(
      'pilot_strategy_path',
      pilotError ? 'block' : isDecisionFallback(pilotRun?.decision) ? 'watch' : 'ready',
      pilotError
        ? pilotError
        : isDecisionFallback(pilotRun?.decision)
          ? `Pilot dry-run on ${pilotRun.symbol} completed, but the decision engine fell back: ${pilotRun.decision?.reasoning?.[0] ?? 'unknown'}.`
          : `Pilot dry-run on ${pilotRun.symbol} completed with action ${pilotRun.decision?.action ?? 'unknown'}.`,
    ),
  ];

  const overallStatus = checks.some((entry) => entry.status === 'block')
    ? 'block'
    : checks.some((entry) => entry.status === 'watch')
      ? 'ready_with_attention'
      : 'ready';

  const payload = {
    type: 'preopen_paper_check',
    generatedAtMs: Date.now(),
    targetSessionDate: targetDate,
    targetSession: {
      timezone: marketTimezone,
      marketOpenLocal: '09:30',
      wakeupLocal: '08:45',
    },
    runtime: runtimeSummary,
    overallStatus,
    checks,
    reportPath: dailyReport.reportPath,
    dailyReportSummary: {
      llmStatus: dailyReport.llm.status,
      marketTone: dailyReport.llm.analysis.marketTone,
      summary: dailyReport.llm.analysis.summary,
      watchlistSize: dailyReport.watchlist.length,
    },
    pilotRun,
  };

  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error('[PREOPEN CHECK] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
