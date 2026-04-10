export class LlmDecisionPolicy {
  constructor({ decisionEngine } = {}) {
    this.decisionEngine = decisionEngine;
  }

  async evaluate({
    symbol,
    features,
    strategyConfig = {},
  } = {}) {
    return await this.decisionEngine.decide({
      symbol,
      features,
      strategyConfig,
    });
  }
}
