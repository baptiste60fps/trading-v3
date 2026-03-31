import { DecisionModelClient } from './DecisionModelClient.mjs';

export class UnavailableDecisionModelClient extends DecisionModelClient {
  constructor(message = 'Decision model client is not configured') {
    super();
    this.message = message;
  }

  async generateJson() {
    throw new Error(this.message);
  }

  async generateDecision() {
    throw new Error(this.message);
  }
}
