import assert from 'assert/strict';
import { OllamaDecisionModelClient } from '../../src/core/llm/OllamaDecisionModelClient.mjs';

export const register = async ({ test }) => {
  test('OllamaDecisionModelClient healthcheck succeeds when the configured model is present', async () => {
    const client = new OllamaDecisionModelClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b',
      requestImpl: async ({ url, method }) => {
        assert.equal(url, 'http://127.0.0.1:11434/api/tags');
        assert.equal(method, 'GET');
        return {
          models: [
            { name: 'qwen2.5:7b' },
            { name: 'llama3.1:8b' },
          ],
        };
      },
    });

    const result = await client.checkAvailability();
    assert.equal(result.available, true);
    assert.equal(result.reason, null);
  });

  test('OllamaDecisionModelClient healthcheck reports missing models cleanly', async () => {
    const client = new OllamaDecisionModelClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b',
      requestImpl: async () => ({
        models: [{ name: 'llama3.1:8b' }],
      }),
    });

    const result = await client.checkAvailability();
    assert.equal(result.available, false);
    assert.match(result.reason, /qwen2\.5:7b/);
  });
};
