export class StrategyInstance {
  constructor({
    symbol,
    runtimeMode = 'paper',
    configStore,
    featureSnapshotService,
    decisionEngine,
    executionEngine,
    entryPolicy = null,
    runtimeSessionStateStore = null,
    consoleLogger = null,
  } = {}) {
    this.symbol = String(symbol ?? '').toUpperCase();
    this.runtimeMode = runtimeMode;
    this.configStore = configStore;
    this.featureSnapshotService = featureSnapshotService;
    this.decisionEngine = decisionEngine;
    this.executionEngine = executionEngine;
    this.entryPolicy = entryPolicy;
    this.runtimeSessionStateStore = runtimeSessionStateStore;
    this.consoleLogger = consoleLogger;
    this.warmedUp = false;
    this.lastWarmupMs = null;
    this.lastEvaluationMs = null;
    this.lastSnapshot = null;
    this.lastDecision = null;
    this.lastExecution = null;
    this.lastFallbackExit = null;
    this.lastOpenRejectionMs = null;
    this.lastOpenRejectionCategory = null;
    this.lastOpenRejectionMessage = null;
    this.cryptoPeakUnrealizedPnlPct = null;
    this.cryptoPeakObservedAtMs = null;
  }

  async warmup(atMs = Date.now()) {
    const snapshot = await this.featureSnapshotService.build({
      symbol: this.symbol,
      atMs,
      runtimeMode: this.runtimeMode,
    });

    this.warmedUp = true;
    this.lastWarmupMs = atMs;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async evaluate(atMs = Date.now()) {
    if (!this.warmedUp) {
      await this.warmup(atMs);
    }

    const strategyConfig = this.configStore?.getSymbolConfig?.(this.symbol) ?? {};
    this.#restoreSessionState(atMs);
    const features = await this.featureSnapshotService.build({
      symbol: this.symbol,
      atMs,
      runtimeMode: this.runtimeMode,
    });
    this.#updateCryptoProfitTracking(features, atMs);
    const forcedCryptoExitDecision = this.#resolveForcedCryptoProfitExitDecision(features);
    let decision = this.#shouldForcePreCloseExit(features)
      ? this.#buildPreCloseExitDecision(features)
      : forcedCryptoExitDecision
        ? forcedCryptoExitDecision
      : (!features?.position && this.#shouldBypassOpeningDecision(features)
          ? this.#buildMarketGateDecision(features)
          : await this.decisionEngine.decide({
              symbol: this.symbol,
              features,
              strategyConfig,
            }));
    if (!features?.position && this.entryPolicy?.review) {
      decision = await this.entryPolicy.review({
        symbol: this.symbol,
        features,
        strategyConfig,
        modelDecision: decision,
      });
    }
    decision = this.#applyOpenRejectionCooldown(decision, features, atMs);
    const execution = await this.executionEngine.executeDecision({
      symbol: this.symbol,
      decision,
      features,
    });
    this.#recordOpenRejection(decision, execution.executionResult, atMs);
    this.#persistSessionState(atMs);

    this.lastEvaluationMs = atMs;
    this.lastSnapshot = features;
    this.lastDecision = decision;
    this.lastExecution = execution;
    this.lastFallbackExit = null;

    if (this.consoleLogger?.logEvaluation) {
      try {
        this.consoleLogger.logEvaluation({
          symbol: this.symbol,
          atMs,
          features,
          decision,
          executionIntent: execution.executionIntent,
          executionResult: execution.executionResult,
        });
      } catch (error) {
        // Logging must never interrupt trading execution.
      }
    }

    return {
      features,
      decision,
      fallbackExit: null,
      executionIntent: execution.executionIntent,
      executionResult: execution.executionResult,
    };
  }

  async runOnce(atMs = Date.now()) {
    return await this.evaluate(atMs);
  }

  getState() {
    return {
      symbol: this.symbol,
      runtimeMode: this.runtimeMode,
      warmedUp: this.warmedUp,
      lastWarmupMs: this.lastWarmupMs,
      lastEvaluationMs: this.lastEvaluationMs,
      lastDecision: this.lastDecision,
      lastExecution: this.lastExecution,
      lastFallbackExit: this.lastFallbackExit,
      lastOpenRejectionMs: this.lastOpenRejectionMs,
      lastOpenRejectionCategory: this.lastOpenRejectionCategory,
      lastOpenRejectionMessage: this.lastOpenRejectionMessage,
      cryptoPeakUnrealizedPnlPct: this.cryptoPeakUnrealizedPnlPct,
      cryptoPeakObservedAtMs: this.cryptoPeakObservedAtMs,
    };
  }

  #shouldBypassOpeningDecision(features) {
    const marketState = features?.marketState ?? {};
    return marketState.isOpen !== true || marketState.isPreClose === true || marketState.isNoTradeOpen === true;
  }

  #buildMarketGateDecision(features) {
    return {
      action: 'skip',
      confidence: 0.1,
      reasoning: ['market_gate', features?.marketState?.sessionLabel ?? 'market_closed'],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        symbol: this.symbol,
        assetClass: features?.assetClass ?? null,
        marketSession: features?.marketState?.sessionLabel ?? null,
      },
    };
  }

  #shouldForcePreCloseExit(features) {
    const marketState = features?.marketState ?? {};
    const position = features?.position ?? null;
    const assetClass = String(features?.assetClass ?? '').trim().toLowerCase();
    return Boolean(position) && assetClass !== 'crypto' && marketState.isPreClose === true;
  }

  #buildPreCloseExitDecision(features) {
    return {
      action: 'close_long',
      confidence: 0.92,
      reasoning: ['forced_preclose_exit', features?.marketState?.sessionLabel ?? 'preclose_window'],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        symbol: this.symbol,
        assetClass: features?.assetClass ?? null,
        marketSession: features?.marketState?.sessionLabel ?? null,
        forcedPreCloseExit: true,
      },
    };
  }

  #resolveForcedCryptoProfitExitDecision(features) {
    const position = features?.position ?? null;
    const assetClass = String(features?.assetClass ?? '').trim().toLowerCase();
    if (!position || assetClass !== 'crypto') return null;

    const executionConfig = this.configStore?.getExecutionConfig?.() ?? {};
    const profitLock = executionConfig?.cryptoProfitLock ?? {};
    if (profitLock?.enabled === false) return null;

    const entryPrice = Number(position?.entryPrice);
    const currentPrice = Number(features?.currentPrice ?? position?.currentPrice);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return null;

    const unrealizedPnlPct = (currentPrice - entryPrice) / entryPrice;
    const minUnrealizedPnlPct = Number(profitLock?.minUnrealizedPnlPct);
    if (!Number.isFinite(minUnrealizedPnlPct) || unrealizedPnlPct < minUnrealizedPnlPct) return null;

    const fast = features?.timeframes?.['5m']?.values ?? {};
    const medium = features?.timeframes?.['1h']?.values ?? {};

    const isFastOverboughtRollover = this.#matchesCryptoFastOverboughtRollover({
      profitLock,
      fast,
    });
    if (isFastOverboughtRollover) {
      return this.#buildCryptoProfitLockExitDecision(features, {
        unrealizedPnlPct,
        mode: 'fast_overbought_rollover',
      });
    }

    const isMediumTrendFade = this.#matchesCryptoMediumTrendFade({
      profitLock,
      unrealizedPnlPct,
      fast,
      medium,
    });
    if (isMediumTrendFade) {
      return this.#buildCryptoProfitLockExitDecision(features, {
        unrealizedPnlPct,
        mode: 'medium_trend_fade',
      });
    }

    const isPeakGivebackExit = this.#matchesCryptoPeakGivebackExit({
      profitLock,
      unrealizedPnlPct,
      fast,
      medium,
    });
    if (isPeakGivebackExit) {
      return this.#buildCryptoProfitLockExitDecision(features, {
        unrealizedPnlPct,
        mode: 'peak_giveback_lock',
      });
    }

    return null;
  }

  #matchesCryptoFastOverboughtRollover({ profitLock, fast }) {
    const fastRsiFloor = Number(profitLock?.fastRsiFloor);
    const fastEmaGapCeiling = Number(profitLock?.fastEmaGapCeiling);
    const fastPriceVsSmaFloor = Number(profitLock?.fastPriceVsSmaFloor);

    return Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && Number.isFinite(Number(fast?.priceVsSma20))
      && fast.rsi14 >= fastRsiFloor
      && fast.emaGap12_26 <= fastEmaGapCeiling
      && fast.priceVsSma20 >= fastPriceVsSmaFloor;
  }

  #matchesCryptoMediumTrendFade({ profitLock, unrealizedPnlPct, fast, medium }) {
    const mediumWeakMinUnrealizedPnlPct = Number(profitLock?.mediumWeakMinUnrealizedPnlPct);
    if (!Number.isFinite(mediumWeakMinUnrealizedPnlPct) || unrealizedPnlPct < mediumWeakMinUnrealizedPnlPct) {
      return false;
    }

    const mediumRsiCeiling = Number(profitLock?.mediumRsiCeiling);
    const mediumPriceVsSmaCeiling = Number(profitLock?.mediumPriceVsSmaCeiling);
    const mediumEmaGapCeiling = Number(profitLock?.mediumEmaGapCeiling);
    const fastRsiCeiling = Number(profitLock?.fastRsiCeiling);
    const fastEmaGapCeiling = Number(profitLock?.fastEmaGapForMediumWeakExitCeiling);

    return Number.isFinite(Number(medium?.rsi14))
      && Number.isFinite(Number(medium?.priceVsSma20))
      && Number.isFinite(Number(medium?.emaGap12_26))
      && Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && medium.rsi14 <= mediumRsiCeiling
      && medium.priceVsSma20 <= mediumPriceVsSmaCeiling
      && medium.emaGap12_26 <= mediumEmaGapCeiling
      && fast.rsi14 <= fastRsiCeiling
      && fast.emaGap12_26 <= fastEmaGapCeiling;
  }

  #matchesCryptoPeakGivebackExit({ profitLock, unrealizedPnlPct, fast, medium }) {
    const peakUnrealizedPnlPct = Number(this.cryptoPeakUnrealizedPnlPct);
    const peakActivationUnrealizedPnlPct = Number(profitLock?.peakActivationUnrealizedPnlPct);
    const peakGivebackAbsPct = Number(profitLock?.peakGivebackAbsPct);
    const peakRetainRatioMax = Number(profitLock?.peakRetainRatioMax);

    if (!Number.isFinite(peakUnrealizedPnlPct) || !Number.isFinite(peakActivationUnrealizedPnlPct) || peakUnrealizedPnlPct < peakActivationUnrealizedPnlPct) {
      return false;
    }

    const givebackPct = peakUnrealizedPnlPct - unrealizedPnlPct;
    const retainRatio = peakUnrealizedPnlPct > 0 ? (unrealizedPnlPct / peakUnrealizedPnlPct) : 1;
    if (!Number.isFinite(givebackPct) || !Number.isFinite(retainRatio)) return false;
    if (givebackPct < peakGivebackAbsPct || retainRatio > peakRetainRatioMax) return false;

    return this.#matchesCryptoFastWeakness({ profitLock, fast })
      || this.#matchesCryptoMediumWeakness({ profitLock, medium });
  }

  #matchesCryptoFastWeakness({ profitLock, fast }) {
    const fastWeakRsiCeiling = Number(profitLock?.fastWeakRsiCeiling);
    const fastWeakPriceVsSmaCeiling = Number(profitLock?.fastWeakPriceVsSmaCeiling);
    const fastWeakEmaGapCeiling = Number(profitLock?.fastWeakEmaGapCeiling);

    return Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.priceVsSma20))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && fast.rsi14 <= fastWeakRsiCeiling
      && fast.priceVsSma20 <= fastWeakPriceVsSmaCeiling
      && fast.emaGap12_26 <= fastWeakEmaGapCeiling;
  }

  #matchesCryptoMediumWeakness({ profitLock, medium }) {
    const mediumRsiCeiling = Number(profitLock?.mediumRsiCeiling);
    const mediumPriceVsSmaCeiling = Number(profitLock?.mediumPriceVsSmaCeiling);
    const mediumEmaGapCeiling = Number(profitLock?.mediumEmaGapCeiling);

    return Number.isFinite(Number(medium?.rsi14))
      && Number.isFinite(Number(medium?.priceVsSma20))
      && Number.isFinite(Number(medium?.emaGap12_26))
      && medium.rsi14 <= mediumRsiCeiling
      && medium.priceVsSma20 <= mediumPriceVsSmaCeiling
      && medium.emaGap12_26 <= mediumEmaGapCeiling;
  }

  #buildCryptoProfitLockExitDecision(features, { unrealizedPnlPct = null, mode = 'fast_overbought_rollover' } = {}) {
    const position = features?.position ?? null;
    const entryPrice = Number(position?.entryPrice);
    const currentPrice = Number(features?.currentPrice ?? position?.currentPrice);
    const resolvedUnrealizedPnlPct = Number.isFinite(unrealizedPnlPct)
      ? unrealizedPnlPct
      : (Number.isFinite(entryPrice) && Number.isFinite(currentPrice) && entryPrice > 0
      ? (currentPrice - entryPrice) / entryPrice
      : null);
    const fast = features?.timeframes?.['5m']?.values ?? {};
    const medium = features?.timeframes?.['1h']?.values ?? {};

    return {
      action: 'close_long',
      confidence: 0.9,
      reasoning: ['crypto_profit_lock', mode],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        symbol: this.symbol,
        assetClass: features?.assetClass ?? null,
        marketSession: features?.marketState?.sessionLabel ?? null,
        forcedCryptoProfitLockExit: true,
        unrealizedPnlPct: resolvedUnrealizedPnlPct,
        peakUnrealizedPnlPct: Number.isFinite(Number(this.cryptoPeakUnrealizedPnlPct)) ? Number(this.cryptoPeakUnrealizedPnlPct) : null,
        fastRsi14: Number.isFinite(Number(fast?.rsi14)) ? Number(fast.rsi14) : null,
        fastEmaGap12_26: Number.isFinite(Number(fast?.emaGap12_26)) ? Number(fast.emaGap12_26) : null,
        fastPriceVsSma20: Number.isFinite(Number(fast?.priceVsSma20)) ? Number(fast.priceVsSma20) : null,
        mediumRsi14: Number.isFinite(Number(medium?.rsi14)) ? Number(medium.rsi14) : null,
        mediumEmaGap12_26: Number.isFinite(Number(medium?.emaGap12_26)) ? Number(medium.emaGap12_26) : null,
        mediumPriceVsSma20: Number.isFinite(Number(medium?.priceVsSma20)) ? Number(medium.priceVsSma20) : null,
      },
    };
  }

  #applyOpenRejectionCooldown(decision, features, atMs) {
    if (decision?.action !== 'open_long') return decision;
    if (features?.position) return decision;

    const cooldownMs = this.#getOpenRejectionCooldownMs();
    if (!(cooldownMs > 0) || !Number.isFinite(this.lastOpenRejectionMs)) return decision;
    if ((Number(atMs) - this.lastOpenRejectionMs) >= cooldownMs) return decision;

    return {
      ...decision,
      action: 'skip',
      confidence: Math.min(Number(decision?.confidence ?? 0.3), 0.22),
      reasoning: [
        `open_rejection_cooldown:${this.lastOpenRejectionCategory ?? 'broker_reject'}`,
        this.lastOpenRejectionMessage ?? 'recent_broker_reject',
      ],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        ...(decision?.signalContext ?? {}),
        openRejectionCooldownMs: cooldownMs,
        lastOpenRejectionCategory: this.lastOpenRejectionCategory,
        lastOpenRejectionMessage: this.lastOpenRejectionMessage,
        lastOpenRejectionMs: this.lastOpenRejectionMs,
      },
    };
  }

  #recordOpenRejection(decision, executionResult, atMs) {
    if (decision?.action !== 'open_long') return;

    if (executionResult?.accepted === true || ['accepted', 'filled', 'dry_run'].includes(executionResult?.status)) {
      this.lastOpenRejectionMs = null;
      this.lastOpenRejectionCategory = null;
      this.lastOpenRejectionMessage = null;
      return;
    }

    if (executionResult?.status !== 'rejected') return;

    this.lastOpenRejectionMs = Number(atMs);
    this.lastOpenRejectionCategory = executionResult?.error?.category ?? 'unknown';
    this.lastOpenRejectionMessage = executionResult?.error?.message ?? executionResult?.status ?? 'rejected';
  }

  #getOpenRejectionCooldownMs() {
    const executionConfig = this.configStore?.getExecutionConfig?.() ?? {};
    const value = Number(executionConfig?.openRejectionCooldownMs);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  #restoreSessionState(atMs) {
    if (!this.runtimeSessionStateStore?.getSymbolState) return;
    const stored = this.runtimeSessionStateStore.getSymbolState(this.symbol, atMs);
    this.lastOpenRejectionMs = Number.isFinite(Number(stored?.lastOpenRejectionMs)) ? Number(stored.lastOpenRejectionMs) : null;
    this.lastOpenRejectionCategory = stored?.lastOpenRejectionCategory ?? null;
    this.lastOpenRejectionMessage = stored?.lastOpenRejectionMessage ?? null;
    this.cryptoPeakUnrealizedPnlPct = Number.isFinite(Number(stored?.cryptoPeakUnrealizedPnlPct)) ? Number(stored.cryptoPeakUnrealizedPnlPct) : null;
    this.cryptoPeakObservedAtMs = Number.isFinite(Number(stored?.cryptoPeakObservedAtMs)) ? Number(stored.cryptoPeakObservedAtMs) : null;
  }

  #persistSessionState(atMs) {
    if (!this.runtimeSessionStateStore?.updateSymbolState) return;
    this.runtimeSessionStateStore.updateSymbolState(this.symbol, atMs, {
      lastOpenRejectionMs: this.lastOpenRejectionMs,
      lastOpenRejectionCategory: this.lastOpenRejectionCategory,
      lastOpenRejectionMessage: this.lastOpenRejectionMessage,
      cryptoPeakUnrealizedPnlPct: this.cryptoPeakUnrealizedPnlPct,
      cryptoPeakObservedAtMs: this.cryptoPeakObservedAtMs,
    });
  }

  #updateCryptoProfitTracking(features, atMs) {
    const position = features?.position ?? null;
    const assetClass = String(features?.assetClass ?? '').trim().toLowerCase();
    if (!position || assetClass !== 'crypto') {
      this.cryptoPeakUnrealizedPnlPct = null;
      this.cryptoPeakObservedAtMs = null;
      return;
    }

    const entryPrice = Number(position?.entryPrice);
    const currentPrice = Number(features?.currentPrice ?? position?.currentPrice);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return;

    const unrealizedPnlPct = (currentPrice - entryPrice) / entryPrice;
    if (!Number.isFinite(unrealizedPnlPct)) return;

    if (!Number.isFinite(this.cryptoPeakUnrealizedPnlPct) || unrealizedPnlPct > this.cryptoPeakUnrealizedPnlPct) {
      this.cryptoPeakUnrealizedPnlPct = unrealizedPnlPct;
      this.cryptoPeakObservedAtMs = Number(atMs);
    }
  }
}
