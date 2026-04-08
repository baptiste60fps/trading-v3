import fs from 'fs';
import path from 'path';

const clone = (value) => JSON.parse(JSON.stringify(value));

const formatSessionDate = (atMs, timezone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));

const makeEmptyState = (sessionDate, timezone, atMs) => ({
  type: 'runtime_session_state',
  sessionDate,
  timezone,
  createdAtMs: atMs,
  updatedAtMs: atMs,
  console: {
    baselineEquity: null,
    previousEquity: null,
  },
  symbols: {},
});

export class RuntimeSessionStateStore {
  constructor({
    runsDir,
    timezone = 'America/New_York',
    now = () => Date.now(),
  } = {}) {
    this.runsDir = runsDir ?? path.resolve(process.cwd(), 'storage/runs');
    this.timezone = timezone;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.currentSessionDate = null;
    this.currentState = null;
  }

  getConsoleState(atMs = this.now()) {
    const state = this.#ensureSession(atMs);
    return clone(state.console ?? {});
  }

  updateConsoleState(atMs = this.now(), patch = null) {
    const state = this.#ensureSession(atMs);
    const previous = state.console ?? {};
    const next = typeof patch === 'function'
      ? patch(clone(previous))
      : { ...previous, ...(patch ?? {}) };
    state.console = next;
    this.#writeCurrentState();
    return clone(next);
  }

  getSymbolState(symbol, atMs = this.now()) {
    const state = this.#ensureSession(atMs);
    const safeSymbol = String(symbol ?? '').toUpperCase();
    return clone(state.symbols?.[safeSymbol] ?? {});
  }

  updateSymbolState(symbol, atMs = this.now(), patch = null) {
    const state = this.#ensureSession(atMs);
    const safeSymbol = String(symbol ?? '').toUpperCase();
    const previous = state.symbols?.[safeSymbol] ?? {};
    const next = typeof patch === 'function'
      ? patch(clone(previous))
      : { ...previous, ...(patch ?? {}) };
    state.symbols[safeSymbol] = next;
    this.#writeCurrentState();
    return clone(next);
  }

  #ensureSession(atMs = this.now()) {
    const safeAtMs = Number.isFinite(Number(atMs)) ? Number(atMs) : this.now();
    const sessionDate = formatSessionDate(safeAtMs, this.timezone);
    if (this.currentSessionDate === sessionDate && this.currentState) {
      return this.currentState;
    }

    fs.mkdirSync(this.runsDir, { recursive: true });
    const filePath = this.#resolveFilePath(sessionDate);
    let state = makeEmptyState(sessionDate, this.timezone, safeAtMs);

    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object' && raw.sessionDate === sessionDate) {
          state = {
            ...state,
            ...raw,
            console: {
              ...state.console,
              ...(raw.console ?? {}),
            },
            symbols: {
              ...(raw.symbols ?? {}),
            },
          };
        }
      } catch {
        state = makeEmptyState(sessionDate, this.timezone, safeAtMs);
      }
    }

    this.currentSessionDate = sessionDate;
    this.currentState = state;
    return this.currentState;
  }

  #resolveFilePath(sessionDate) {
    return path.resolve(this.runsDir, `runtime-session-${sessionDate}.json`);
  }

  #writeCurrentState() {
    if (!this.currentState || !this.currentSessionDate) return null;
    this.currentState.updatedAtMs = this.now();
    const filePath = this.#resolveFilePath(this.currentSessionDate);
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(this.currentState, null, 2)}\n`, 'utf8');
    return filePath;
  }
}
