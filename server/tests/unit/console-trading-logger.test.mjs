import assert from 'assert/strict';
import { ConsoleTradingLogger } from '../../src/core/telemetry/ConsoleTradingLogger.mjs';
import { RuntimeSessionStateStore } from '../../src/core/runtime/RuntimeSessionStateStore.mjs';
import { makeTempDir } from '../helpers/fixtures.mjs';

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

  test('ConsoleTradingLogger logs blocking llm errors in red once and resolves them when cleared', async () => {
    const lines = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: true,
      writer: (line) => lines.push(line),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 2, 14, 0, 0),
      features: {
        currentPrice: 201,
        portfolioState: {
          equity: 100000,
          cash: 100000,
          brokerReady: true,
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
      },
      decision: {
        action: 'skip',
        reasoning: ["decision_engine_fallback:model 'qwen2.5:7b' not found"],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 2, 14, 1, 0),
      features: {
        currentPrice: 202,
        portfolioState: {
          equity: 100010,
          cash: 100010,
          brokerReady: true,
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
      },
      decision: {
        action: 'skip',
        reasoning: ["decision_engine_fallback:model 'qwen2.5:7b' not found"],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 2, 14, 2, 0),
      features: {
        currentPrice: 203,
        portfolioState: {
          equity: 100020,
          cash: 100020,
          brokerReady: true,
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
      },
      decision: {
        action: 'hold',
        reasoning: ['llm_ok'],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    assert.equal(lines.filter((line) => line.includes('TRADING BLOCKER')).length, 2);
    assert.match(lines[0], /TRADING BLOCKER/);
    assert.match(lines[0], /\x1b\[31mLLM/);
    assert.match(lines[0], /model 'qwen2\.5:7b' not found/);
    assert.ok(lines.some((line) => /TRADING BLOCKER RESOLVED/.test(line)));
  });

  test('ConsoleTradingLogger downgrades Ollama timeouts to degraded alerts and resolves them when cleared', async () => {
    const lines = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: true,
      writer: (line) => lines.push(line),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 14, 0, 0),
      features: {
        currentPrice: 201,
        portfolioState: {
          equity: 100000,
          cash: 100000,
          brokerReady: true,
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
      },
      decision: {
        action: 'skip',
        reasoning: ['decision_engine_fallback:Ollama request timed out'],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 14, 1, 0),
      features: {
        currentPrice: 202,
        portfolioState: {
          equity: 100010,
          cash: 100010,
          brokerReady: true,
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
      },
      decision: {
        action: 'hold',
        reasoning: ['llm_ok'],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    assert.ok(lines.some((line) => /TRADING DEGRADED/.test(line)));
    assert.ok(lines.some((line) => /\x1b\[33mLLM/.test(line)));
    assert.ok(lines.some((line) => /Ollama request timed out/.test(line)));
    assert.ok(lines.some((line) => /TRADING DEGRADED RESOLVED/.test(line)));
    assert.equal(lines.some((line) => /TRADING BLOCKER LLM \| .*Ollama request timed out/.test(line)), false);
  });

  test('ConsoleTradingLogger logs blocking broker auth errors in red', async () => {
    const lines = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: true,
      writer: (line) => lines.push(line),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 2, 14, 0, 0),
      features: {
        portfolioState: {
          equity: 0,
          cash: 0,
          brokerReady: false,
          errorCategory: 'auth',
          error: 'Unauthorized Alpaca credentials',
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular',
        },
        timeframes: {
          '1m': {
            lastClose: null,
          },
        },
      },
      decision: {
        action: 'skip',
        reasoning: [],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'broker_auth_unavailable',
        },
      },
    });

    assert.match(lines[0], /TRADING BLOCKER/);
    assert.match(lines[0], /BROKER AUTH/);
    assert.match(lines[0], /Unauthorized Alpaca credentials/);
  });

  test('ConsoleTradingLogger renders a console preview frame with summary, symbols and positions', async () => {
    const frames = [];
    const logger = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: false,
      preview: true,
      isTty: true,
      writer: () => {
        throw new Error('line writer should not be used in preview mode');
      },
      previewWriter: (frame) => frames.push(frame),
    });

    logger.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 13, 35, 0),
      features: {
        symbol: 'AAPL',
        currentPrice: 250,
        portfolioState: {
          equity: 100250,
          cash: 95000,
          exposurePct: 0.052,
          positions: [
            {
              symbol: 'AAPL',
              qty: 5,
              entryPrice: 248,
              currentPrice: 250,
              unrealizedPnl: 10,
            },
          ],
        },
        marketState: {
          isOpen: true,
          sessionLabel: 'regular_open',
        },
        position: {
          symbol: 'AAPL',
          qty: 5,
          entryPrice: 248,
          unrealizedPnl: 10,
        },
      },
      decision: {
        action: 'hold',
        confidence: 0.64,
        reasoning: ['monitor_position'],
      },
      executionResult: {
        status: 'noop',
        accepted: false,
        error: {
          message: 'noop_action',
        },
      },
    });

    assert.equal(frames.length, 1);
    assert.match(frames[0], /Baptisto Trading V3/);
    assert.match(frames[0], /Equity 100250\.00\$/);
    assert.match(frames[0], /Open Positions 1/);
    assert.match(frames[0], /Symbols/);
    assert.match(frames[0], /AAPL/);
    assert.match(frames[0], /regular_open/);
    assert.match(frames[0], /Positions/);
    assert.match(frames[0], /Recent Events/);
  });

  test('ConsoleTradingLogger restores session deltas across restart from the runtime session store', async () => {
    const rootDir = makeTempDir();
    const runsDir = `${rootDir}/runs`;
    const sharedStoreA = new RuntimeSessionStateStore({
      runsDir,
      timezone: 'America/New_York',
    });
    const firstLines = [];
    const loggerA = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: false,
      writer: (line) => firstLines.push(line),
      runtimeSessionStateStore: sharedStoreA,
    });

    loggerA.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 13, 30, 0),
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

    loggerA.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 13, 31, 0),
      features: {
        portfolioState: {
          equity: 100100,
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

    const secondLines = [];
    const loggerB = new ConsoleTradingLogger({
      timezone: 'America/New_York',
      colors: false,
      writer: (line) => secondLines.push(line),
      runtimeSessionStateStore: new RuntimeSessionStateStore({
        runsDir,
        timezone: 'America/New_York',
      }),
    });

    loggerB.logEvaluation({
      symbol: 'AAPL',
      atMs: Date.UTC(2026, 3, 8, 13, 32, 0),
      features: {
        portfolioState: {
          equity: 100150,
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

    assert.match(secondLines[0], /Portfolio Delta \+50\.00\$/);
    assert.match(secondLines[0], /Session Delta \+150\.00\$/);
  });
};
