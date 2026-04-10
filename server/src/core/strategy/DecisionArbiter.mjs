const buildMarketGateDecision = ({ symbol, features }) => ({
  action: 'skip',
  confidence: 0.1,
  reasoning: ['market_gate', features?.marketState?.sessionLabel ?? 'market_closed'],
  requestedSizePct: null,
  stopLossPct: null,
  takeProfitPct: null,
  signalContext: {
    symbol,
    assetClass: features?.assetClass ?? null,
    marketSession: features?.marketState?.sessionLabel ?? null,
  },
});

const decorateDecisionSource = (decision, source) => ({
  ...decision,
  signalContext: {
    ...(decision?.signalContext ?? {}),
    decisionSource: source,
  },
});

export class DecisionArbiter {
  constructor({
    positionExitPolicy = null,
    deterministicEntryPolicy = null,
    llmDecisionPolicy = null,
  } = {}) {
    this.positionExitPolicy = positionExitPolicy;
    this.deterministicEntryPolicy = deterministicEntryPolicy;
    this.llmDecisionPolicy = llmDecisionPolicy;
  }

  async decide(context = {}) {
    const symbol = String(context?.symbol ?? '').trim().toUpperCase();
    const features = context?.features ?? {};
    const hasPosition = Boolean(features?.position);

    if (hasPosition && this.positionExitPolicy?.evaluate) {
      const exitDecision = await this.positionExitPolicy.evaluate(context);
      if (exitDecision) {
        return {
          source: 'exit_policy',
          decision: decorateDecisionSource(exitDecision, 'exit_policy'),
        };
      }
    }

    if (!hasPosition && this.#shouldBypassOpeningDecision(features)) {
      return {
        source: 'market_gate',
        decision: decorateDecisionSource(buildMarketGateDecision({ symbol, features }), 'market_gate'),
      };
    }

    if (!hasPosition && this.deterministicEntryPolicy?.evaluate) {
      const deterministicDecision = await this.deterministicEntryPolicy.evaluate(context);
      if (deterministicDecision) {
        return {
          source: 'deterministic_entry',
          decision: decorateDecisionSource(deterministicDecision, 'deterministic_entry'),
        };
      }
    }

    if (this.llmDecisionPolicy?.evaluate) {
      const llmDecision = await this.llmDecisionPolicy.evaluate(context);
      return {
        source: 'llm',
        decision: decorateDecisionSource(llmDecision, 'llm'),
      };
    }

    return {
      source: 'market_gate',
      decision: decorateDecisionSource(buildMarketGateDecision({ symbol, features }), 'market_gate'),
    };
  }

  #shouldBypassOpeningDecision(features) {
    const marketState = features?.marketState ?? {};
    return marketState.isOpen !== true || marketState.isPreClose === true || marketState.isNoTradeOpen === true;
  }
}
