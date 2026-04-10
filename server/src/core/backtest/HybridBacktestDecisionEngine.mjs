const decorateDecision = (decision, decisionSource, arbitration = null) => ({
  ...decision,
  signalContext: {
    ...(decision?.signalContext ?? {}),
    decisionSource,
  },
  arbitration,
});

export class HybridBacktestDecisionEngine {
  constructor({
    deterministicEntryPolicy = null,
    fallbackDecisionEngine,
    executionConfig = {},
  } = {}) {
    this.deterministicEntryPolicy = deterministicEntryPolicy;
    this.fallbackDecisionEngine = fallbackDecisionEngine;
    this.executionConfig = executionConfig;
  }

  async decide({ symbol, features, strategyConfig = {} } = {}) {
    if (!features?.position && this.deterministicEntryPolicy?.evaluate) {
      const deterministicDecision = await this.deterministicEntryPolicy.evaluate({
        symbol,
        features,
        strategyConfig,
        executionConfig: this.executionConfig,
      });

      if (deterministicDecision) {
        return decorateDecision(deterministicDecision, 'deterministic_entry', {
          source: 'deterministic_entry',
          entryPolicyApplied: false,
          finalAction: deterministicDecision?.action ?? null,
          finalConfidence: deterministicDecision?.confidence ?? null,
        });
      }
    }

    const fallbackDecision = await this.fallbackDecisionEngine.decide({
      symbol,
      features,
      strategyConfig,
    });

    return decorateDecision(
      fallbackDecision,
      fallbackDecision?.signalContext?.decisionSource ?? 'backtest_fallback',
      {
        source: 'backtest_fallback',
        entryPolicyApplied: false,
        finalAction: fallbackDecision?.action ?? null,
        finalConfidence: fallbackDecision?.confidence ?? null,
      },
    );
  }
}
