export class DecisionModelClient {
  async generateJson() {
    throw new Error(`${this.constructor.name}.generateJson() must be implemented`);
  }

  async generateDecision() {
    throw new Error(`${this.constructor.name}.generateDecision() must be implemented`);
  }
}
