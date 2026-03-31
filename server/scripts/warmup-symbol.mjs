import { createRuntime } from '../src/app/createRuntime.mjs';
import { IndicatorEngine } from '../src/core/indicators/IndicatorEngine.mjs';
import { FeatureSnapshotService } from '../src/services/features/FeatureSnapshotService.mjs';

const symbol = String(process.argv[2] ?? 'AAPL').toUpperCase();

const main = async () => {
  const runtime = await createRuntime();
  const featureSnapshotService = new FeatureSnapshotService({
    configStore: runtime.configStore,
    barsRepository: runtime.barsRepository,
    indicatorEngine: new IndicatorEngine(),
    marketCalendar: runtime.marketCalendar,
  });

  const snapshot = await featureSnapshotService.build({
    symbol,
    atMs: Date.now(),
    runtimeMode: runtime.describe().runtimeMode,
  });

  console.log(
    JSON.stringify(
      {
        symbol: snapshot.symbol,
        currentPrice: snapshot.currentPrice,
        marketState: snapshot.marketState,
        shortBars: snapshot.shortBars.length,
        timeframes: Object.fromEntries(
          Object.entries(snapshot.timeframes).map(([timeframe, indicatorSnapshot]) => [
            timeframe,
            indicatorSnapshot.values,
          ]),
        ),
        relatedSymbols: snapshot.relatedSymbols.map((entry) => ({
          symbol: entry.symbol,
          timeframes: Object.keys(entry.timeframes),
        })),
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error('[WARMUP] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
