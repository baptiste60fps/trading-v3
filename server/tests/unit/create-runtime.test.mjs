import assert from 'assert/strict';
import { createRuntime } from '../../src/app/createRuntime.mjs';
import { makeServerRootFixture } from '../helpers/fixtures.mjs';

export const register = async ({ test }) => {
  test('createRuntime loads .env.local before composing providers', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        runtime: { mode: 'paper' },
      },
      envLocal: `ALPACA_ENABLED=true
ALPACA_PAPER=true
ALPACA_API_KEY=test-key
ALPACA_SECRET_KEY=test-secret
`,
    });

    const runtime = await createRuntime({
      serverRootDir: rootDir,
      env: {},
    });

    const summary = runtime.describe();
    assert.equal(summary.runtimeMode, 'paper');
    assert.equal(summary.alpacaReady, true);
    assert.equal(summary.llmEnabled, false);
    assert.equal(summary.executionDryRun, true);
    assert.ok(summary.envFilePath.endsWith('.env.local'));
  });
};
