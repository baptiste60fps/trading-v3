import path from 'path';
import { fileURLToPath } from 'url';
import { runUnitTests } from './run-unit.mjs';
import { runIntegrationTests } from './run-integration.mjs';
import { runLiveArchitectureTests } from './run-live-architecture.mjs';

const __filename = fileURLToPath(import.meta.url);

export const runArchitectureTests = async () => {
  await runUnitTests();
  await runIntegrationTests();
  await runLiveArchitectureTests();
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runArchitectureTests().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
