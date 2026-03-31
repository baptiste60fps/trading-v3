import path from 'path';
import { fileURLToPath } from 'url';
import { createRunner } from './helpers/testRunner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const unitFiles = [
  './unit/config.test.mjs',
  './unit/load-local-env.test.mjs',
  './unit/market-time.test.mjs',
  './unit/market-calendar.test.mjs',
  './unit/file-cache-store.test.mjs',
  './unit/bars-repository.test.mjs',
  './unit/create-runtime.test.mjs',
  './unit/indicator-engine.test.mjs',
  './unit/feature-snapshot-service.test.mjs',
  './unit/portfolio-service.test.mjs',
  './unit/alpaca-broker-gateway.test.mjs',
  './unit/console-trading-logger.test.mjs',
  './unit/execution-engine.test.mjs',
  './unit/persistent-runtime-orchestrator.test.mjs',
  './unit/decision-engine.test.mjs',
  './unit/strategy-instance.test.mjs',
  './unit/backtest-engine.test.mjs',
  './unit/rss-feed-service.test.mjs',
  './unit/daily-market-report-service.test.mjs',
];

export const runUnitTests = async () => {
  const runner = createRunner({ title: 'unit' });
  for (const relativeFile of unitFiles) {
    await runner.loadFile(path.resolve(__dirname, relativeFile));
  }
  return await runner.run();
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runUnitTests().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
