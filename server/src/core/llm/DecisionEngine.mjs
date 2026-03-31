import { normalizeDecisionResponse, buildDecisionJsonShape } from './DecisionSchema.mjs';

const DECISION_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);

const compactIndicatorValues = (values) => ({
  lastClose: values?.lastClose ?? null,
  rsi14: values?.rsi14 ?? null,
  atrPct14: values?.atrPct14 ?? null,
  priceVsSma20: values?.priceVsSma20 ?? null,
  emaGap12_26: values?.emaGap12_26 ?? null,
  return20: values?.return20 ?? null,
  return50: values?.return50 ?? null,
  barCount: values?.barCount ?? 0,
});

const compactFeatureSnapshot = (features) => ({
  symbol: features?.symbol ?? null,
  atMs: features?.atMs ?? null,
  currentPrice: features?.currentPrice ?? null,
  marketState: features?.marketState ?? null,
  portfolioState: features?.portfolioState
    ? {
        cash: features.portfolioState.cash ?? null,
        equity: features.portfolioState.equity ?? null,
        exposurePct: features.portfolioState.exposurePct ?? null,
        positionCount: Array.isArray(features.portfolioState.positions) ? features.portfolioState.positions.length : 0,
      }
    : null,
  position: features?.position
    ? {
        symbol: features.position.symbol ?? null,
        qty: features.position.qty ?? null,
        entryPrice: features.position.entryPrice ?? null,
        currentPrice: features.position.currentPrice ?? null,
        unrealizedPnl: features.position.unrealizedPnl ?? null,
      }
    : null,
  riskState: features?.riskState
    ? {
        canOpen: features.riskState.canOpen ?? null,
        canClose: features.riskState.canClose ?? null,
        flags: Array.isArray(features.riskState.flags) ? features.riskState.flags.slice(0, 5) : [],
      }
    : null,
  timeframes: Object.fromEntries(
    Object.entries(features?.timeframes ?? {})
      .filter(([timeframe]) => DECISION_TIMEFRAMES.has(timeframe))
      .map(([timeframe, snapshot]) => [timeframe, compactIndicatorValues(snapshot?.values ?? {})]),
  ),
  relatedSymbols: (features?.relatedSymbols ?? []).map((entry) => ({
    symbol: entry.symbol,
    relation: entry.relation,
    timeframes: Object.fromEntries(
      Object.entries(entry.timeframes ?? {})
        .filter(([timeframe]) => ['1h', '4h', '1d'].includes(timeframe))
        .map(([timeframe, snapshot]) => [timeframe, compactIndicatorValues(snapshot?.values ?? {})]),
    ),
  })),
});

export class DecisionEngine {
  constructor({ modelClient, llmConfig = {} } = {}) {
    this.modelClient = modelClient;
    this.llmConfig = llmConfig;
  }

  async decide({ symbol, features, strategyConfig = {} } = {}) {
    const compact = compactFeatureSnapshot(features);
    const systemPrompt = this.#buildSystemPrompt();
    const userPrompt = this.#buildUserPrompt({
      symbol,
      strategyConfig,
      compact,
    });

    try {
      const raw = await this.modelClient.generateDecision({
        model: this.llmConfig.model,
        systemPrompt,
        userPrompt,
      });

      return normalizeDecisionResponse(raw);
    } catch (error) {
      return {
        action: 'skip',
        confidence: 0,
        reasoning: [`decision_engine_fallback:${error?.message ?? 'unknown_error'}`],
        requestedSizePct: null,
        stopLossPct: null,
        takeProfitPct: null,
      };
    }
  }

  #buildSystemPrompt() {
    return [
      'You are a trading decision engine.',
      'You can only produce long-only decisions.',
      'Allowed actions: open_long, hold, close_long, skip.',
      'Never suggest short selling.',
      'Return strict JSON only, no markdown, no prose outside JSON.',
      `Expected JSON shape: ${JSON.stringify(buildDecisionJsonShape())}`,
    ].join('\n');
  }

  #buildUserPrompt({ symbol, strategyConfig, compact }) {
    return [
      `Symbol: ${symbol}`,
      'Strategy config:',
      JSON.stringify(strategyConfig ?? {}, null, 2),
      'Feature snapshot:',
      JSON.stringify(compact, null, 2),
      'Choose one action and provide a confidence between 0 and 1.',
    ].join('\n\n');
  }
}
