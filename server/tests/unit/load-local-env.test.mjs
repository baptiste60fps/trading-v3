import assert from 'assert/strict';
import { loadLocalEnv } from '../../src/config/loadLocalEnv.mjs';
import { makeServerRootFixture } from '../helpers/fixtures.mjs';

export const register = async ({ test }) => {
  test('loadLocalEnv parses comments, quotes and values', async () => {
    const rootDir = makeServerRootFixture({
      envLocal: `# comment
ALPACA_ENABLED=true
ALPACA_API_KEY="abc123"
ALPACA_SECRET_KEY='secret456'
`,
    });

    const loaded = loadLocalEnv(rootDir);
    assert.equal(loaded.values.ALPACA_ENABLED, 'true');
    assert.equal(loaded.values.ALPACA_API_KEY, 'abc123');
    assert.equal(loaded.values.ALPACA_SECRET_KEY, 'secret456');
  });
};
