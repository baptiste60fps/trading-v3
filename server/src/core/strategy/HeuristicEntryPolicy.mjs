import { SimpleRuleDecisionEngine } from '../backtest/SimpleRuleDecisionEngine.mjs';

const toPositiveFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const buildReasoningList = (value) => Array.isArray(value)
  ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  : [];

const buildSignalContext = ({
  heuristicDecision,
  modelDecision,
  requestedSizePct,
}) => ({
  ...(heuristicDecision?.signalContext ?? {}),
  entryPolicy: 'heuristic_guard_v1',
  heuristicAction: heuristicDecision?.action ?? null,
  heuristicReasoning: buildReasoningList(heuristicDecision?.reasoning).slice(0, 5),
  llmAction: modelDecision?.action ?? null,
  llmConfidence: modelDecision?.confidence ?? null,
  llmReasoning: buildReasoningList(modelDecision?.reasoning).slice(0, 5),
  reviewedRequestedSizePct: requestedSizePct,
});

export class HeuristicEntryPolicy {
  constructor({
    configStore = null,
    enabled = true,
    clampRequestedSize = true,
  } = {}) {
    this.configStore = configStore;
    this.enabled = enabled !== false;
    this.clampRequestedSize = clampRequestedSize !== false;
    this.heuristicEngine = new SimpleRuleDecisionEngine({
      symbolProfiles: this.configStore?.getStrategyProfileMap?.() ?? {},
    });
  }

  async review({
    symbol,
    features,
    strategyConfig = null,
    modelDecision = null,
  } = {}) {
    if (!this.enabled) return modelDecision;
    if (modelDecision?.action !== 'open_long') return modelDecision;
    if (features?.position) return modelDecision;

    const heuristicDecision = await this.heuristicEngine.decide({
      symbol,
      features,
      strategyConfig,
    });
    const heuristicReasoning = buildReasoningList(heuristicDecision?.reasoning);
    const modelReasoning = buildReasoningList(modelDecision?.reasoning);

    if (heuristicDecision?.action !== 'open_long') {
      return {
        ...modelDecision,
        action: 'skip',
        confidence: Math.min(Number(modelDecision?.confidence ?? 0.25), 0.24),
        reasoning: [
          `entry_policy_block:${heuristicReasoning[0] ?? 'heuristic_gate'}`,
          ...modelReasoning.slice(0, 4),
        ],
        requestedSizePct: null,
        stopLossPct: null,
        takeProfitPct: null,
        signalContext: buildSignalContext({
          heuristicDecision,
          modelDecision,
          requestedSizePct: null,
        }),
      };
    }

    const heuristicRequestedSizePct = toPositiveFiniteOrNull(heuristicDecision?.requestedSizePct);
    const modelRequestedSizePct = toPositiveFiniteOrNull(modelDecision?.requestedSizePct);
    const requestedSizePct = this.clampRequestedSize
      ? (modelRequestedSizePct !== null && heuristicRequestedSizePct !== null
          ? Math.min(modelRequestedSizePct, heuristicRequestedSizePct)
          : (modelRequestedSizePct ?? heuristicRequestedSizePct ?? null))
      : (modelRequestedSizePct ?? heuristicRequestedSizePct ?? null);

    return {
      ...modelDecision,
      requestedSizePct,
      stopLossPct: modelDecision?.stopLossPct ?? heuristicDecision?.stopLossPct ?? null,
      takeProfitPct: modelDecision?.takeProfitPct ?? heuristicDecision?.takeProfitPct ?? null,
      signalContext: buildSignalContext({
        heuristicDecision,
        modelDecision,
        requestedSizePct,
      }),
    };
  }
}
