import assert from 'assert/strict';
import path from 'path';
import { RuntimeSessionStateStore } from '../../src/core/runtime/RuntimeSessionStateStore.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

export const register = async ({ test }) => {
  test('RuntimeSessionStateStore persists symbol and console state across instances for the same session', async () => {
    const rootDir = makeTempDir();
    const runsDir = path.resolve(rootDir, 'runs');
    const atMs = Date.UTC(2026, 3, 8, 13, 35, 0);

    const storeA = new RuntimeSessionStateStore({
      runsDir,
      timezone: 'America/New_York',
      now: () => atMs,
    });
    storeA.updateConsoleState(atMs, {
      baselineEquity: 100000,
      previousEquity: 100120,
    });
    storeA.updateSymbolState('AAPL', atMs, {
      lastOpenRejectionMs: atMs - 60_000,
      lastOpenRejectionCategory: 'validation',
      lastOpenRejectionMessage: 'fractional orders must be DAY orders',
    });

    const storeB = new RuntimeSessionStateStore({
      runsDir,
      timezone: 'America/New_York',
      now: () => atMs,
    });

    const consoleState = storeB.getConsoleState(atMs);
    const symbolState = storeB.getSymbolState('AAPL', atMs);

    assert.equal(consoleState.baselineEquity, 100000);
    assert.equal(consoleState.previousEquity, 100120);
    assert.equal(symbolState.lastOpenRejectionCategory, 'validation');
    assert.equal(symbolState.lastOpenRejectionMessage, 'fractional orders must be DAY orders');
  });

  test('RuntimeSessionStateStore resets naturally on a new session date', async () => {
    const rootDir = makeTempDir();
    const runsDir = path.resolve(rootDir, 'runs');
    const firstAtMs = Date.UTC(2026, 3, 8, 20, 0, 0);
    const secondAtMs = Date.UTC(2026, 3, 9, 13, 35, 0);

    const store = new RuntimeSessionStateStore({
      runsDir,
      timezone: 'America/New_York',
      now: () => firstAtMs,
    });
    store.updateConsoleState(firstAtMs, {
      baselineEquity: 100000,
      previousEquity: 100120,
    });
    store.updateSymbolState('AAPL', firstAtMs, {
      lastOpenRejectionMs: firstAtMs - 60_000,
      lastOpenRejectionCategory: 'validation',
    });

    const nextStore = new RuntimeSessionStateStore({
      runsDir,
      timezone: 'America/New_York',
      now: () => secondAtMs,
    });

    assert.equal(nextStore.getConsoleState(secondAtMs).baselineEquity, null);
    assert.deepEqual(nextStore.getSymbolState('AAPL', secondAtMs), {});
  });
};
