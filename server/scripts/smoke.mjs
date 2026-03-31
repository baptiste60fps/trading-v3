import { runUnitTests } from '../tests/run-unit.mjs';

runUnitTests().catch((error) => {
  console.error('[SMOKE] Failure');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
