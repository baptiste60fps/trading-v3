import { DecisionArbiter } from './DecisionArbiter.mjs';
import { PositionExitPolicy } from './PositionExitPolicy.mjs';
import { LlmDecisionPolicy } from './LlmDecisionPolicy.mjs';

export class StrategyInstance {
  constructor({
    symbol,
    runtimeMode = 'paper',
    configStore,
    featureSnapshotService,
    decisionEngine,
    executionEngine,
    entryPolicy = null,
    decisionArbiter = null,
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
    this.decisionArbiter = decisionArbiter ?? new DecisionArbiter({
      positionExitPolicy: new PositionExitPolicy(),
      llmDecisionPolicy: new LlmDecisionPolicy({ decisionEngine }),
    });
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
    const arbitration = await this.decisionArbiter.decide({
      symbol: this.symbol,
      atMs,
      runtimeMode: this.runtimeMode,
      features,
      strategyConfig,
      executionConfig: this.configStore?.getExecutionConfig?.() ?? {},
      symbolState: {
        lastOpenRejectionMs: this.lastOpenRejectionMs,
        lastOpenRejectionCategory: this.lastOpenRejectionCategory,
        lastOpenRejectionMessage: this.lastOpenRejectionMessage,
        cryptoPeakUnrealizedPnlPct: this.cryptoPeakUnrealizedPnlPct,
        cryptoPeakObservedAtMs: this.cryptoPeakObservedAtMs,
      },
    });
    let decision = arbitration?.decision;
    const preEntryPolicyDecision = decision ? JSON.parse(JSON.stringify(decision)) : null;
    const entryPolicyApplied = Boolean(!features?.position && arbitration?.source === 'llm' && this.entryPolicy?.review);
    if (!features?.position && arbitration?.source === 'llm' && this.entryPolicy?.review) {
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
      arbitration: {
        source: arbitration?.source ?? null,
        preEntryPolicyDecision,
        entryPolicyApplied,
        finalAction: decision?.action ?? null,
        finalConfidence: decision?.confidence ?? null,
      },
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
