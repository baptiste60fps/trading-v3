import { normalizeEpochMs } from './time.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeClosedDates = (closedDates = []) => new Set(
  (Array.isArray(closedDates) ? closedDates : [])
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => DATE_PATTERN.test(entry)),
);

export class MarketCalendar {
  constructor({
    timezone = 'America/New_York',
    sessionMode = 'regular',
    openMinutes = 9 * 60 + 30,
    closeMinutes = 16 * 60,
    preCloseMinutes = 10,
    noTradeOpenMinutes = 10,
    closedDates = [],
  } = {}) {
    this.timezone = timezone;
    this.sessionMode = sessionMode;
    this.openMinutes = openMinutes;
    this.closeMinutes = closeMinutes;
    this.preCloseMinutes = preCloseMinutes;
    this.noTradeOpenMinutes = noTradeOpenMinutes;
    this.closedDates = normalizeClosedDates(closedDates);
  }

  getMarketState(atMs, context = null) {
    const date = new Date(normalizeEpochMs(atMs, 'atMs'));
    const assetClass = typeof context === 'string'
      ? String(context).trim().toLowerCase()
      : String(context?.assetClass ?? '').trim().toLowerCase();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);

    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = map.weekday;
    const localDate = `${map.year}-${map.month}-${map.day}`;
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (assetClass === 'crypto') {
      return {
        timezone: this.timezone,
        sessionMode: 'continuous',
        isOpen: true,
        isPreClose: false,
        isNoTradeOpen: false,
        minutesFromOpen: null,
        minutesToClose: null,
        sessionLabel: 'continuous_open',
      };
    }

    const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
    const isConfiguredClosedDate = isWeekday && this.closedDates.has(localDate);
    if (isConfiguredClosedDate) {
      return {
        timezone: this.timezone,
        sessionMode: this.sessionMode,
        isOpen: false,
        isPreClose: false,
        isNoTradeOpen: false,
        minutesFromOpen: null,
        minutesToClose: null,
        sessionLabel: 'market_closed',
        closedReason: 'configured_closed_date',
        localDate,
      };
    }

    const minutes = hour * 60 + minute;

    const isOpen = isWeekday && minutes >= this.openMinutes && minutes < this.closeMinutes;
    const minutesFromOpen = isWeekday ? minutes - this.openMinutes : null;
    const minutesToClose = isWeekday ? this.closeMinutes - minutes : null;
    const isPreClose = isOpen && minutesToClose !== null && minutesToClose <= this.preCloseMinutes;
    const isNoTradeOpen = isOpen && minutesFromOpen !== null && minutesFromOpen >= 0 && minutesFromOpen < this.noTradeOpenMinutes;

    let sessionLabel = 'closed';
    if (isOpen && isPreClose) sessionLabel = 'preclose';
    else if (isOpen && isNoTradeOpen) sessionLabel = 'open_cooldown';
    else if (isOpen) sessionLabel = 'regular_open';
    else if (isWeekday && minutes < this.openMinutes) sessionLabel = 'before_open';
    else if (isWeekday && minutes >= this.closeMinutes) sessionLabel = 'after_close';

    return {
      timezone: this.timezone,
      sessionMode: this.sessionMode,
      isOpen,
      isPreClose,
      isNoTradeOpen,
      minutesFromOpen,
      minutesToClose,
      sessionLabel,
    };
  }
}
