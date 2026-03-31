export class BrokerGateway {
  constructor({ providerName = 'unknown-broker' } = {}) {
    this.providerName = providerName;
  }

  async getAccountState() {
    throw new Error(`${this.constructor.name}.getAccountState() must be implemented`);
  }

  async getOpenPosition() {
    throw new Error(`${this.constructor.name}.getOpenPosition() must be implemented`);
  }

  async getOpenPositions() {
    throw new Error(`${this.constructor.name}.getOpenPositions() must be implemented`);
  }

  async submit() {
    throw new Error(`${this.constructor.name}.submit() must be implemented`);
  }

  async close() {
    throw new Error(`${this.constructor.name}.close() must be implemented`);
  }
}
