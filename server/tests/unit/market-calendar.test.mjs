import assert from 'assert/strict';
import { MarketCalendar } from '../../src/core/market/MarketCalendar.mjs';

export const register = async ({ test }) => {
  test('MarketCalendar detects open cooldown and preclose windows', async () => {
    const calendar = new MarketCalendar({
      timezone: 'America/New_York',
      openMinutes: 570,
      closeMinutes: 960,
      preCloseMinutes: 10,
      noTradeOpenMinutes: 10,
    });

    const openCooldown = calendar.getMarketState(Date.parse('2026-03-25T13:35:00.000Z'));
    assert.equal(openCooldown.isOpen, true);
    assert.equal(openCooldown.isNoTradeOpen, true);
    assert.equal(openCooldown.sessionLabel, 'open_cooldown');

    const preClose = calendar.getMarketState(Date.parse('2026-03-25T19:55:00.000Z'));
    assert.equal(preClose.isOpen, true);
    assert.equal(preClose.isPreClose, true);
    assert.equal(preClose.sessionLabel, 'preclose');
  });

  test('MarketCalendar marks weekend as closed', async () => {
    const calendar = new MarketCalendar({
      timezone: 'America/New_York',
    });

    const weekend = calendar.getMarketState(Date.parse('2026-03-28T15:00:00.000Z'));
    assert.equal(weekend.isOpen, false);
    assert.equal(weekend.sessionLabel, 'closed');
  });

  test('MarketCalendar keeps crypto markets open continuously, including weekends', async () => {
    const calendar = new MarketCalendar({
      timezone: 'America/New_York',
      closedDates: ['2026-04-03'],
    });

    const weekendCrypto = calendar.getMarketState(Date.parse('2026-03-28T15:00:00.000Z'), { assetClass: 'crypto' });
    assert.equal(weekendCrypto.isOpen, true);
    assert.equal(weekendCrypto.isPreClose, false);
    assert.equal(weekendCrypto.isNoTradeOpen, false);
    assert.equal(weekendCrypto.sessionLabel, 'continuous_open');

    const holidayCrypto = calendar.getMarketState(Date.parse('2026-04-03T15:00:00.000Z'), { assetClass: 'crypto' });
    assert.equal(holidayCrypto.isOpen, true);
    assert.equal(holidayCrypto.sessionLabel, 'continuous_open');
  });

  test('MarketCalendar marks configured equity market holidays as closed', async () => {
    const calendar = new MarketCalendar({
      timezone: 'America/New_York',
      closedDates: ['2026-04-03'],
    });

    const holiday = calendar.getMarketState(Date.parse('2026-04-03T15:00:00.000Z'));
    assert.equal(holiday.isOpen, false);
    assert.equal(holiday.sessionLabel, 'market_closed');
    assert.equal(holiday.closedReason, 'configured_closed_date');
    assert.equal(holiday.localDate, '2026-04-03');
  });
};
