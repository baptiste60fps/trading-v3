import { BrokerGateway } from './BrokerGateway.mjs';

export class UnavailableBrokerGateway extends BrokerGateway {
  constructor(message = 'Broker gateway is not configured') {
    super({ providerName: 'unavailable-broker' });
    this.message = message;
  }

  async getAccountState() {
    throw new Error(this.message);
  }

  async getOpenPosition() {
    throw new Error(this.message);
  }

  async getOpenPositions() {
    throw new Error(this.message);
  }

  async submit() {
    throw new Error(this.message);
  }

  async close() {
    throw new Error(this.message);
  }
}
