import path from 'path';
import { fileURLToPath } from 'url';
import { runUnitTests } from './run-unit.mjs';
import { runIntegrationTests } from './run-integration.mjs';

const __filename = fileURLToPath(import.meta.url);

const main = async () => {
  await runUnitTests();
  await runIntegrationTests();
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
