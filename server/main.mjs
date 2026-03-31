import { createRuntime } from './src/app/createRuntime.mjs';

const run = async () => {
  const runtime = await createRuntime();
  const summary = runtime.describe();

  console.log('[SERVER] Runtime ready');
  console.log(JSON.stringify(summary, null, 2));
};

run().catch((error) => {
  console.error('[SERVER] Fatal bootstrap error');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
