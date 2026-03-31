import { createRuntime } from '../src/app/createRuntime.mjs';
import { StrategyInstance } from '../src/core/strategy/StrategyInstance.mjs';

const symbol = String(process.argv[2] ?? 'AAPL').toUpperCase();

const summarizeIndicators = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot?.timeframes ?? {}).map(([timeframe, indicatorSnapshot]) => [
      timeframe,
      {
        lastClose: indicatorSnapshot?.values?.lastClose ?? null,
        rsi14: indicatorSnapshot?.values?.rsi14 ?? null,
        atrPct14: indicatorSnapshot?.values?.atrPct14 ?? null,
        priceVsSma20: indicatorSnapshot?.values?.priceVsSma20 ?? null,
        emaGap12_26: indicatorSnapshot?.values?.emaGap12_26 ?? null,
      },
    ]),
  );

const main = async () => {
  const runtime = await createRuntime();
  const runtimeSummary = runtime.describe();
  const strategy = new StrategyInstance({
    symbol,
    runtimeMode: runtimeSummary.runtimeMode,
    configStore: runtime.configStore,
    featureSnapshotService: runtime.featureSnapshotService,
    decisionEngine: runtime.decisionEngine,
    executionEngine: runtime.executionEngine,
    consoleLogger: runtime.consoleTradingLogger,
  });

  const result = await strategy.runOnce(Date.now());

  console.log(
    JSON.stringify(
      {
        runtime: runtimeSummary,
        symbol,
        currentPrice: result.features.currentPrice,
        marketState: result.features.marketState,
        portfolioState: result.features.portfolioState,
        decision: result.decision,
        executionIntent: result.executionIntent,
        executionResult: result.executionResult,
        timeframes: summarizeIndicators(result.features),
        relatedSymbols: result.features.relatedSymbols.map((entry) => ({
          symbol: entry.symbol,
          timeframes: summarizeIndicators({ timeframes: entry.timeframes }),
        })),
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error('[RUN] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
