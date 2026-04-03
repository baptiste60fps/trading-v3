import path from 'path';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';
import { createRunner } from './helpers/testRunner.mjs';
import { createRuntime } from '../src/app/createRuntime.mjs';
import { DECISION_ACTIONS } from '../src/core/types/domain.mjs';

const __filename = fileURLToPath(import.meta.url);

export const runLiveArchitectureTests = async () => {
  const runner = createRunner({ title: 'architecture' });

  runner.test('Full runtime evaluates AAPL with Alpaca and handles local LLM degradation safely', async () => {
    const runtime = await createRuntime();
    const strategy = runtime.createStrategyInstance('AAPL');
    const result = await strategy.runOnce(Date.now());
    const fallbackReason = (result.decision.reasoning ?? []).find((entry) => entry.startsWith('decision_engine_fallback:'));

    assert.equal(runtime.describe().alpacaReady, true);
    assert.equal(runtime.describe().llmEnabled, true);
    assert.ok(Number.isFinite(result.features.currentPrice) && result.features.currentPrice > 0);
    assert.ok(DECISION_ACTIONS.includes(result.decision.action));
    assert.ok(['noop', 'dry_run', 'accepted', 'filled', 'closed'].includes(result.executionResult.status));

    if (fallbackReason !== undefined) {
      assert.equal(result.decision.action, 'skip');
      assert.equal(result.executionResult.status, 'noop');
      assert.ok(fallbackReason.startsWith('decision_engine_fallback:'));
      return;
    }

    assert.equal(fallbackReason, undefined);
  });

  return await runner.run();
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runLiveArchitectureTests().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
