import path from 'path';
import { fileURLToPath } from 'url';
import { createRunner } from './helpers/testRunner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const integrationFiles = [
  './integration/alpaca-http-client.test.mjs',
  './integration/alpaca-market-data-provider.test.mjs',
  './integration/alpaca-broker-gateway.test.mjs',
  './integration/feature-snapshot-service.test.mjs',
  './integration/portfolio-service.test.mjs',
];

export const runIntegrationTests = async () => {
  const runner = createRunner({ title: 'integration' });
  for (const relativeFile of integrationFiles) {
    await runner.loadFile(path.resolve(__dirname, relativeFile));
  }
  return await runner.run();
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runIntegrationTests().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
