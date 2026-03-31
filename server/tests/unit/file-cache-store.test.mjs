import assert from 'assert/strict';
import path from 'path';
import { FileCacheStore } from '../../src/core/cache/FileCacheStore.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

export const register = async ({ test }) => {
  test('FileCacheStore stores, expires and deletes entries', async () => {
    const rootDir = path.join(makeTempDir(), 'cache');
    const cache = new FileCacheStore({
      rootDir,
      defaultTtlMs: 50,
    });

    await cache.set('bars', 'AAPL:1m', { value: 1 });
    assert.deepEqual(await cache.get('bars', 'AAPL:1m'), { value: 1 });
    assert.equal(await cache.has('bars', 'AAPL:1m'), true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await cache.get('bars', 'AAPL:1m'), null);
    assert.equal(await cache.has('bars', 'AAPL:1m'), false);

    await cache.set('bars', 'AAPL:5m', { value: 2 }, 10_000);
    assert.deepEqual(await cache.get('bars', 'AAPL:5m'), { value: 2 });
    await cache.delete('bars', 'AAPL:5m');
    assert.equal(await cache.get('bars', 'AAPL:5m'), null);
  });
};
