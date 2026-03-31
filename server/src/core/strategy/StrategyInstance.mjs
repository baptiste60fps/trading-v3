export class StrategyInstance {
  constructor({
    symbol,
    runtimeMode = 'paper',
    configStore,
    featureSnapshotService,
    decisionEngine,
    executionEngine,
    consoleLogger = null,
  } = {}) {
    this.symbol = String(symbol ?? '').toUpperCase();
    this.runtimeMode = runtimeMode;
    this.configStore = configStore;
    this.featureSnapshotService = featureSnapshotService;
    this.decisionEngine = decisionEngine;
    this.executionEngine = executionEngine;
    this.consoleLogger = consoleLogger;
    this.warmedUp = false;
    this.lastWarmupMs = null;
    this.lastEvaluationMs = null;
    this.lastSnapshot = null;
    this.lastDecision = null;
    this.lastExecution = null;
    this.lastFallbackExit = null;
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
    const features = await this.featureSnapshotService.build({
      symbol: this.symbol,
      atMs,
      runtimeMode: this.runtimeMode,
    });
    const decision = await this.decisionEngine.decide({
      symbol: this.symbol,
      features,
      strategyConfig,
    });
    const execution = await this.executionEngine.executeDecision({
      symbol: this.symbol,
      decision,
      features,
    });

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
    };
  }
}
