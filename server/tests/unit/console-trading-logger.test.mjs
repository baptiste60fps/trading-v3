import assert from 'assert/strict';
import { ConsoleTradingLogger } from '../../src/core/telemetry/ConsoleTradingLogger.mjs';

export const register = async ({ test }) => {
  test('ConsoleTradingLogger logs portfolio and session deltas with colors', async () => {
    const lines = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: true,
      writer: (line) => lines.push(line),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 2, 31, 13, 30, 0),
      features: {
        portfolioState: {
          equity: 100000,
        },
        marketState: {
          sessionLabel: 'regular_open',
        },
      },
      decision: {
        action: 'hold',
      },
      executionResult: {
        status: 'noop',
      },
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 2, 31, 13, 31, 0),
      features: {
        portfolioState: {
          equity: 100125.5,
        },
        marketState: {
          sessionLabel: 'regular_open',
        },
      },
      decision: {
        action: 'hold',
      },
      executionResult: {
        status: 'noop',
      },
    });

    assert.equal(lines.length, 4);
    assert.match(lines[2], /Portfolio Delta/);
    assert.match(lines[2], /Session Delta/);
    assert.match(lines[2], /\x1b\[32m\+125\.50\$/);
    assert.match(lines[3], /Desk Equity/);
    assert.match(lines[3], /Position/);
    assert.match(lines[3], /FLAT/);
  });

  test('ConsoleTradingLogger logs open and close position lines with colored gain delta', async () => {
    const lines = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: true,
      writer: (line) => lines.push(line),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 2, 31, 13, 30, 0),
      features: {
        currentPrice: 100,
        portfolioState: {
          equity: 100000,
        },
        marketState: {
          sessionLabel: 'regular_open',
        },
      },
      decision: {
        action: 'open_long',
      },
      executionIntent: {
        action: 'open_long',
        qty: 8,
        referencePrice: 100,
        stopLossPct: 0.02,
      },
      executionResult: {
        accepted: true,
        status: 'dry_run',
      },
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 2, 31, 14, 0, 0),
      features: {
        currentPrice: 102,
        portfolioState: {
          equity: 100160,
        },
        marketState: {
          sessionLabel: 'regular_open',
        },
        position: {
          qty: 8,
          entryPrice: 100,
        },
      },
      decision: {
        action: 'close_long',
      },
      executionIntent: {
        action: 'close_long',
        referencePrice: 102,
      },
      executionResult: {
        accepted: true,
        status: 'dry_run',
      },
    });

    assert.equal(lines.length, 6);
    assert.match(lines[1], /Desk Equity/);
    assert.match(lines[1], /LONG\x1b\[0m qty=8\.000000 @ 100\.00\$/);
    assert.match(lines[2], /OPEN LONG/);
    assert.match(lines[2], /stop=98\.00\$/);
    assert.match(lines[4], /Desk Equity/);
    assert.match(lines[4], /FLAT/);
    assert.match(lines[5], /CLOSE LONG/);
    assert.match(lines[5], /\x1b\[32m\+16\.00\$/);
  });
};
