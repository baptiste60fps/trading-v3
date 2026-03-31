export class MarketDataProvider {
  constructor({ providerName = 'unknown-market-data' } = {}) {
    this.providerName = providerName;
  }

  async getBars() {
    throw new Error(`${this.constructor.name}.getBars() must be implemented`);
  }

  async getLatestPrice() {
    throw new Error(`${this.constructor.name}.getLatestPrice() must be implemented`);
  }
}
