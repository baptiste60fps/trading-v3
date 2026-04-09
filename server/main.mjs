import { createRuntime } from './src/app/createRuntime.mjs';

const parseBooleanFlag = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  const lowered = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  return fallback;
};

const parseArgs = (argv) => {
  const args = {
    symbols: null,
    loopIntervalMs: null,
    idleIntervalMs: null,
    startupWarmup: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    const [flag, inlineValue] = String(entry).split('=');
    const value = inlineValue ?? argv[index + 1];

    switch (flag) {
      case '--symbols':
        args.symbols = String(value ?? '')
          .split(',')
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean);
        if (inlineValue === undefined) index += 1;
        break;
      case '--loop-interval-ms':
        args.loopIntervalMs = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--idle-interval-ms':
        args.idleIntervalMs = Number(value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--startup-warmup':
        args.startupWarmup = parseBooleanFlag(value, true);
        if (inlineValue === undefined) index += 1;
        break;
      case '--no-startup-warmup':
        args.startupWarmup = false;
        break;
      default:
        if (!String(entry).startsWith('--')) continue;
        throw new Error(`Unsupported flag ${flag}`);
    }
  }

  return args;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await createRuntime();
  const summary = runtime.describe();
  const launchSymbols = Array.isArray(args.symbols) && args.symbols.length
    ? args.symbols
    : summary.runtimeSymbols ?? summary.enabledSymbols ?? null;

  console.log('[SERVER] Runtime ready');
  console.log(JSON.stringify({
    ...summary,
    launchSymbols,
  }, null, 2));

  if (!['paper', 'live'].includes(summary.runtimeMode)) {
    console.log(`[SERVER] Runtime mode ${summary.runtimeMode} does not start the persistent orchestrator.`);
    return;
  }

  const orchestrator = runtime.createPersistentRuntimeOrchestrator({
    symbols: args.symbols,
    loopIntervalMs: Number.isFinite(args.loopIntervalMs) ? args.loopIntervalMs : undefined,
    idleIntervalMs: Number.isFinite(args.idleIntervalMs) ? args.idleIntervalMs : undefined,
    startupWarmup: args.startupWarmup,
    logger: console,
  });

  let shutdownRequested = false;
  const shutdown = async (signal) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`[SERVER] Received ${signal}, shutting down persistent orchestrator...`);
    await orchestrator.stop(signal);
    if (runtime.dailyRuntimeReportService?.flushCurrentSessionGitCommit) {
      try {
        const commitResult = await runtime.dailyRuntimeReportService.flushCurrentSessionGitCommit();
        if (commitResult?.committed) {
          console.log(`[SERVER] Daily git commit created: ${commitResult.message}`);
        }
      } catch (error) {
        console.error('[SERVER] Daily git commit failed');
        console.error(error?.stack ?? error);
      }
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await orchestrator.start();
  console.log('[SERVER] Persistent orchestrator started');
  await orchestrator.waitUntilStopped();
  console.log('[SERVER] Persistent orchestrator stopped');
};

run().catch((error) => {
  console.error('[SERVER] Fatal bootstrap error');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
