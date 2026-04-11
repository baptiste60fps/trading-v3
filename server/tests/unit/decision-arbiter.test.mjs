import assert from 'assert/strict';
import { DecisionArbiter } from '../../src/core/strategy/DecisionArbiter.mjs';

export const register = async ({ test }) => {
  test('DecisionArbiter prioritizes forced exits over the LLM policy', async () => {
    const calls = [];
    const arbiter = new DecisionArbiter({
      positionExitPolicy: {
        async evaluate() {
          calls.push('exit');
          return {
            action: 'close_long',
            confidence: 0.9,
            reasoning: ['forced_exit'],
          };
        },
      },
      llmDecisionPolicy: {
        async evaluate() {
          calls.push('llm');
          return {
            action: 'hold',
            confidence: 0.5,
            reasoning: ['llm_hold'],
          };
        },
      },
    });

    const result = await arbiter.decide({
      symbol: 'AAPL',
      features: {
        symbol: 'AAPL',
        assetClass: 'stock',
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
          sessionLabel: 'regular_open',
        },
        position: {
          symbol: 'AAPL',
          qty: 5,
          entryPrice: 150,
        },
      },
    });

    assert.deepEqual(calls, ['exit']);
    assert.equal(result.source, 'exit_policy');
    assert.equal(result.decision.action, 'close_long');
    assert.equal(result.decision.signalContext.decisionSource, 'exit_policy');
  });

  test('DecisionArbiter applies the market gate before consulting the LLM when no position is open', async () => {
    let llmCalls = 0;
    const arbiter = new DecisionArbiter({
      llmDecisionPolicy: {
        async evaluate() {
          llmCalls += 1;
          return {
            action: 'open_long',
            confidence: 0.8,
            reasoning: ['llm_open'],
          };
        },
      },
    });

    const result = await arbiter.decide({
      symbol: 'AAPL',
      features: {
        symbol: 'AAPL',
        assetClass: 'stock',
        marketState: {
          isOpen: false,
          isPreClose: false,
          isNoTradeOpen: false,
          sessionLabel: 'market_closed',
        },
        position: null,
      },
    });

    assert.equal(llmCalls, 0);
    assert.equal(result.source, 'market_gate');
    assert.equal(result.decision.action, 'skip');
    assert.deepEqual(result.decision.reasoning, ['market_gate', 'market_closed']);
  });

  test('DecisionArbiter prioritizes deterministic entries before the LLM when no position is open', async () => {
    const calls = [];
    const arbiter = new DecisionArbiter({
      deterministicEntryPolicy: {
        async evaluate() {
          calls.push('deterministic');
          return {
            action: 'open_long',
            confidence: 0.9,
            reasoning: ['deterministic_entry:trend_pullback_continuation'],
            requestedSizePct: 0.004,
          };
        },
      },
      llmDecisionPolicy: {
        async evaluate() {
          calls.push('llm');
          return {
            action: 'open_long',
            confidence: 0.7,
            reasoning: ['llm_open'],
          };
        },
      },
    });

    const result = await arbiter.decide({
      symbol: 'BTC/USD',
      features: {
        symbol: 'BTC/USD',
        assetClass: 'crypto',
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
          sessionLabel: 'continuous_open',
        },
        position: null,
      },
    });

    assert.deepEqual(calls, ['deterministic']);
    assert.equal(result.source, 'deterministic_entry');
    assert.equal(result.decision.action, 'open_long');
    assert.equal(result.decision.signalContext.decisionSource, 'deterministic_entry');
  });

  test('DecisionArbiter downgrades an llm open decision to hold when a position is already open', async () => {
    const arbiter = new DecisionArbiter({
      llmDecisionPolicy: {
        async evaluate() {
          return {
            action: 'open_long',
            confidence: 0.74,
            reasoning: ['llm_open'],
            requestedSizePct: 0.01,
          };
        },
      },
    });

    const result = await arbiter.decide({
      symbol: 'BTC/USD',
      features: {
        symbol: 'BTC/USD',
        assetClass: 'crypto',
        marketState: {
          isOpen: true,
          isPreClose: false,
          isNoTradeOpen: false,
          sessionLabel: 'continuous_open',
        },
        position: {
          symbol: 'BTC/USD',
          qty: 0.02,
          entryPrice: 69_000,
        },
      },
    });

    assert.equal(result.source, 'llm');
    assert.equal(result.decision.action, 'hold');
    assert.deepEqual(result.decision.reasoning.slice(0, 2), ['position_guard', 'position_already_open']);
    assert.equal(result.decision.signalContext.guardedOriginalAction, 'open_long');
    assert.equal(result.decision.signalContext.decisionSource, 'llm');
    assert.equal(result.decision.requestedSizePct, null);
  });
};
