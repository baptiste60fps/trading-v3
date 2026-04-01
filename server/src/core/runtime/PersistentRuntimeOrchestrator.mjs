import { assertRuntimeMode, assertSymbolId } from '../types/validators.mjs';

const clampInterval = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1_000 ? Math.floor(numeric) : fallback;
};

const defaultScheduler = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

const toErrorMessage = (error) => error?.message ?? String(error ?? 'unknown_error');
const isRateLimitError = (error) => {
  const category = String(error?.category ?? '').toLowerCase();
  const statusCode = Number(error?.statusCode);
  const message = String(error?.message ?? '').toLowerCase();
  return category === 'rate_limit'
    || statusCode === 429
    || message.includes('too many requests')
    || message.includes('rate limit');
};

export class PersistentRuntimeOrchestrator {
  constructor({
    runtimeMode = 'paper',
    configStore,
    marketCalendar,
    strategyFactory,
    symbols = null,
    loopIntervalMs = 60_000,
    idleIntervalMs = 300_000,
    rateLimitPauseMs = 30_000,
    startupWarmup = true,
    now = () => Date.now(),
    scheduler = defaultScheduler,
    sleep = null,
    logger = console,
    onCycleStarted = null,
    onStrategyEvaluated = null,
    onCycleCompleted = null,
  } = {}) {
    this.runtimeMode = assertRuntimeMode(runtimeMode);
    this.configStore = configStore;
    this.marketCalendar = marketCalendar;
    this.strategyFactory = strategyFactory;
    this.explicitSymbols = symbols;
    this.loopIntervalMs = clampInterval(loopIntervalMs, 60_000);
    this.idleIntervalMs = clampInterval(idleIntervalMs, 300_000);
    this.rateLimitPauseMs = clampInterval(rateLimitPauseMs, 30_000);
    this.startupWarmup = startupWarmup !== false;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.scheduler = scheduler?.setTimeout && scheduler?.clearTimeout ? scheduler : defaultScheduler;
    this.sleep = typeof sleep === 'function'
      ? sleep
      : (delayMs) => new Promise((resolve) => {
        this.scheduler.setTimeout(resolve, delayMs);
      });
    this.logger = logger ?? console;
    this.onCycleStarted = typeof onCycleStarted === 'function' ? onCycleStarted : null;
    this.onStrategyEvaluated = typeof onStrategyEvaluated === 'function' ? onStrategyEvaluated : null;
    this.onCycleCompleted = typeof onCycleCompleted === 'function' ? onCycleCompleted : null;

    this.strategies = new Map();
    this.cycleTimer = null;
    this.currentCyclePromise = null;
    this.started = false;
    this.stopping = false;
    this.stopReason = null;
    this.state = {
      status: 'idle',
      symbols: [],
      startedAtMs: null,
      lastCycleStartedAtMs: null,
      lastCycleCompletedAtMs: null,
      lastCycleDurationMs: null,
      cycleCount: 0,
      lastScheduleDelayMs: null,
      lastCycleReason: null,
      lastResults: [],
      lastError: null,
    };

    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start() {
    if (this.started) return this;

    const symbols = this.#resolveSymbols();
    if (!symbols.length) {
      throw new Error('PersistentRuntimeOrchestrator requires at least one enabled symbol');
    }

    this.started = true;
    this.state.status = 'starting';
    this.state.symbols = symbols.slice();
    this.state.startedAtMs = this.now();
    this.#logInfo(
      `Starting ${this.runtimeMode} orchestrator for ${symbols.join(', ')} | loop=${this.loopIntervalMs}ms | idle=${this.idleIntervalMs}ms | warmup=${this.startupWarmup}`,
    );

    await this.#ensureStrategies();

    if (this.startupWarmup) {
      await this.#warmupAll();
    }

    await this.runCycle({ reason: 'startup' });
    return this;
  }

  async runCycle({ reason = 'manual' } = {}) {
    if (!this.started) {
      throw new Error('PersistentRuntimeOrchestrator.start() must be called before runCycle()');
    }
    if (this.stopping) return null;
    if (this.currentCyclePromise) return await this.currentCyclePromise;

    this.#clearTimer();
    this.currentCyclePromise = this.#runCycleInternal({ reason })
      .catch((error) => {
        this.state.lastError = toErrorMessage(error);
        throw error;
      })
      .finally(() => {
        this.currentCyclePromise = null;

        if (this.stopping) {
          this.state.status = 'stopped';
          this.resolveStopped({
            ...this.getState(),
            stopReason: this.stopReason,
          });
          return;
        }

        this.#scheduleNext();
      });

    return await this.currentCyclePromise;
  }

  async stop(reason = 'manual_stop') {
    if (!this.started) {
      this.stopReason = reason;
      this.state.status = 'stopped';
      this.resolveStopped({
        ...this.getState(),
        stopReason: this.stopReason,
      });
      return this.getState();
    }

    if (!this.stopping) {
      this.stopping = true;
      this.stopReason = reason;
      this.state.status = 'stopping';
      this.#clearTimer();
      this.#logInfo(`Stopping orchestrator (${reason})`);
    }

    if (this.currentCyclePromise) {
      try {
        await this.currentCyclePromise;
      } catch {
        // The orchestrator keeps the last error in state; shutdown must continue.
      }
    } else if (this.state.status !== 'stopped') {
      this.state.status = 'stopped';
      this.resolveStopped({
        ...this.getState(),
        stopReason: this.stopReason,
      });
    }

    return this.getState();
  }

  async waitUntilStopped() {
    return await this.stoppedPromise;
  }

  getState() {
    return {
      runtimeMode: this.runtimeMode,
      ...this.state,
      stopReason: this.stopReason,
      started: this.started,
      stopping: this.stopping,
    };
  }

  #resolveSymbols() {
    const configured = Array.isArray(this.explicitSymbols) && this.explicitSymbols.length
      ? this.explicitSymbols
      : this.configStore?.getRuntimeConfig?.().symbols;

    const source = Array.isArray(configured) && configured.length
      ? configured
      : this.configStore?.getEnabledSymbols?.() ?? [];

    return source
      .map((entry) => assertSymbolId(String(entry ?? '').trim().toUpperCase()))
      .filter((entry, index, list) => list.indexOf(entry) === index);
  }

  async #ensureStrategies() {
    for (const symbol of this.state.symbols) {
      if (this.strategies.has(symbol)) continue;
      const strategy = await this.strategyFactory(symbol, this.runtimeMode);
      if (!strategy || typeof strategy.runOnce !== 'function') {
        throw new Error(`Strategy factory must return a StrategyInstance-like object for ${symbol}`);
      }
      this.strategies.set(symbol, strategy);
    }
  }

  async #warmupAll() {
    for (const symbol of this.state.symbols) {
      const strategy = this.strategies.get(symbol);
      if (!strategy || typeof strategy.warmup !== 'function') continue;

      try {
        const warmed = await this.#retryOnRateLimit({
          symbol,
          phase: 'warmup',
          operation: async () => {
            await strategy.warmup(this.now());
            return true;
          },
        });
        if (!warmed) break;
        this.#logInfo(`Warmup ready for ${symbol}`);
      } catch (error) {
        this.#logError(`Warmup failed for ${symbol}: ${toErrorMessage(error)}`);
      }

      if (this.stopping) break;
    }
  }

  async #runCycleInternal({ reason }) {
    const cycleStartedAtMs = this.now();
    const cycleNumber = this.state.cycleCount + 1;
    const results = [];
    this.state.status = 'running';
    this.state.lastCycleStartedAtMs = cycleStartedAtMs;
    this.state.lastCycleReason = reason;
    this.state.lastError = null;

    await this.#notifyHook(this.onCycleStarted, {
      cycle: cycleNumber,
      atMs: cycleStartedAtMs,
      reason,
      runtimeMode: this.runtimeMode,
      symbols: this.state.symbols.slice(),
    });

    for (const symbol of this.state.symbols) {
      const strategy = this.strategies.get(symbol);
      try {
        const result = await this.#retryOnRateLimit({
          symbol,
          phase: `cycle #${cycleNumber}`,
          operation: async () => await strategy.runOnce(cycleStartedAtMs),
        });
        if (result === null) break;
        const summary = {
          symbol,
          ok: true,
          decisionAction: result?.decision?.action ?? null,
          executionStatus: result?.executionResult?.status ?? null,
          marketSession: result?.features?.marketState?.sessionLabel ?? null,
          currentPrice: result?.features?.currentPrice ?? null,
          error: null,
        };
        results.push(summary);
        await this.#notifyHook(this.onStrategyEvaluated, {
          cycle: cycleNumber,
          atMs: cycleStartedAtMs,
          reason,
          symbol,
          ok: true,
          result,
          summary,
          error: null,
        });
        this.#logInfo(
          `Cycle #${cycleNumber} ${symbol} -> decision=${summary.decisionAction ?? 'unknown'} exec=${summary.executionStatus ?? 'unknown'} market=${summary.marketSession ?? 'unknown'}`,
        );
      } catch (error) {
        const summary = {
          symbol,
          ok: false,
          decisionAction: null,
          executionStatus: null,
          marketSession: null,
          currentPrice: null,
          error: toErrorMessage(error),
        };
        results.push(summary);
        this.state.lastError = summary.error;
        await this.#notifyHook(this.onStrategyEvaluated, {
          cycle: cycleNumber,
          atMs: cycleStartedAtMs,
          reason,
          symbol,
          ok: false,
          result: null,
          summary,
          error,
        });
        this.#logError(`Cycle #${cycleNumber} ${symbol} failed: ${summary.error}`);
      }

      if (this.stopping) break;
    }

    const cycleCompletedAtMs = this.now();
    this.state.cycleCount += 1;
    this.state.lastCycleCompletedAtMs = cycleCompletedAtMs;
    this.state.lastCycleDurationMs = Math.max(0, cycleCompletedAtMs - cycleStartedAtMs);
    this.state.lastResults = results;
    this.state.status = this.stopping ? 'stopping' : 'idle';

    await this.#notifyHook(this.onCycleCompleted, {
      cycle: this.state.cycleCount,
      startedAtMs: cycleStartedAtMs,
      completedAtMs: cycleCompletedAtMs,
      durationMs: this.state.lastCycleDurationMs,
      reason,
      results,
    });

    this.#logInfo(
      `Cycle #${this.state.cycleCount} complete | ok=${results.filter((entry) => entry.ok).length}/${results.length} | duration=${this.state.lastCycleDurationMs}ms`,
    );

    return {
      cycle: this.state.cycleCount,
      startedAtMs: cycleStartedAtMs,
      completedAtMs: cycleCompletedAtMs,
      durationMs: this.state.lastCycleDurationMs,
      results,
    };
  }

  #scheduleNext() {
    if (!this.started || this.stopping) return;

    const marketState = this.marketCalendar?.getMarketState?.(this.now()) ?? null;
    const nextDelay = marketState?.isOpen ? this.loopIntervalMs : this.idleIntervalMs;
    this.state.lastScheduleDelayMs = nextDelay;

    this.cycleTimer = this.scheduler.setTimeout(() => this.runCycle({ reason: 'scheduled' }).catch((error) => {
        this.#logError(`Scheduled cycle failed: ${toErrorMessage(error)}`);
      }), nextDelay);

    this.#logInfo(
      `Next cycle scheduled in ${nextDelay}ms (${marketState?.sessionLabel ?? 'unknown_session'})`,
    );
  }

  #clearTimer() {
    if (!this.cycleTimer) return;
    this.scheduler.clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
  }

  async #retryOnRateLimit({ symbol, phase, operation }) {
    while (!this.stopping) {
      try {
        return await operation();
      } catch (error) {
        if (!isRateLimitError(error)) throw error;

        const message = toErrorMessage(error);
        this.state.lastError = message;
        this.#logError(
          `${phase} rate-limited for ${symbol}: ${message}. Pausing ${this.rateLimitPauseMs}ms before retry.`,
        );
        await this.sleep(this.rateLimitPauseMs);
      }
    }

    return null;
  }

  #logInfo(message) {
    if (typeof this.logger?.info === 'function') {
      this.logger.info(`[RUNTIME] ${message}`);
      return;
    }
    if (typeof this.logger?.log === 'function') {
      this.logger.log(`[RUNTIME] ${message}`);
    }
  }

  #logError(message) {
    if (typeof this.logger?.error === 'function') {
      this.logger.error(`[RUNTIME] ${message}`);
      return;
    }
    if (typeof this.logger?.log === 'function') {
      this.logger.log(`[RUNTIME] ${message}`);
    }
  }

  async #notifyHook(hook, payload) {
    if (typeof hook !== 'function') return;
    try {
      await hook(payload);
    } catch (error) {
      this.#logError(`Hook failure: ${toErrorMessage(error)}`);
    }
  }
}
