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

  test('createRuntime disables Ollama cleanly when the startup healthcheck fails', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        runtime: { mode: 'paper' },
      },
      envLocal: `BAPTISTO_LLM_ENABLED=true
BAPTISTO_LLM_PROVIDER=ollama
BAPTISTO_LLM_MODEL=qwen2.5:7b
BAPTISTO_LLM_BASE_URL=http://127.0.0.1:11434
`,
    });

    const runtime = await createRuntime({
      serverRootDir: rootDir,
      env: {},
      ollamaClientFactory() {
        return {
          async checkAvailability() {
            return {
              available: false,
              reason: 'connect ECONNREFUSED 127.0.0.1:11434',
            };
          },
        };
      },
    });

    const summary = runtime.describe();
    assert.equal(summary.llmEnabled, true);
    assert.equal(summary.llmReady, false);
    assert.match(summary.llmHealthMessage, /ECONNREFUSED/);
  });

  test('createRuntime keeps Ollama enabled when the startup healthcheck succeeds', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        runtime: { mode: 'paper' },
      },
      envLocal: `BAPTISTO_LLM_ENABLED=true
BAPTISTO_LLM_PROVIDER=ollama
BAPTISTO_LLM_MODEL=qwen2.5:7b
BAPTISTO_LLM_BASE_URL=http://127.0.0.1:11434
`,
    });

    const runtime = await createRuntime({
      serverRootDir: rootDir,
      env: {},
      ollamaClientFactory() {
        return {
          async checkAvailability() {
            return {
              available: true,
              reason: null,
            };
          },
          async generateDecision() {
            return JSON.stringify({
              action: 'hold',
              confidence: 0.5,
              reasoning: ['ok'],
            });
          },
        };
      },
    });

    const summary = runtime.describe();
    assert.equal(summary.llmEnabled, true);
    assert.equal(summary.llmReady, true);
    assert.equal(summary.llmHealthMessage, null);
  });

  test('createRuntime exposes deterministic entry wiring when enabled in config', async () => {
    const rootDir = makeServerRootFixture({
      runtimeConfig: {
        runtime: { mode: 'paper' },
        execution: {
          deterministicEntry: {
            enabled: true,
            allowedSymbols: ['BTC/USD'],
            allowedAssetClasses: ['crypto'],
          },
        },
      },
    });

    const runtime = await createRuntime({
      serverRootDir: rootDir,
      env: {},
    });

    const summary = runtime.describe();
    assert.equal(summary.deterministicEntryEnabled, true);
    assert.ok(runtime.patternSignalEngine);
    assert.ok(runtime.deterministicEntryPolicy);
  });
};
