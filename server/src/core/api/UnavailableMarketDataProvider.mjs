import { MarketDataProvider } from './MarketDataProvider.mjs';

export class UnavailableMarketDataProvider extends MarketDataProvider {
  constructor(message = 'Market data provider is not configured') {
    super({ providerName: 'unavailable-market-data' });
    this.message = message;
  }

  async getBars() {
    throw new Error(this.message);
  }

  async getLatestPrice() {
    throw new Error(this.message);
  }
}
