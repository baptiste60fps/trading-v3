import { DECISION_ACTIONS } from '../types/domain.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const parseJsonLike = (value) => {
  if (typeof value === 'string') return JSON.parse(value);
  if (value && typeof value === 'object') return value;
  throw new Error('Decision payload must be an object or a JSON string');
};

const normalizeReasoning = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
};

const normalizeOptionalPct = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0, 1);
};

export const normalizeDecisionResponse = (raw) => {
  const parsed = parseJsonLike(raw);
  const action = String(parsed?.action ?? '').trim();
  if (!DECISION_ACTIONS.includes(action)) {
    throw new Error(`Invalid decision action: ${action}`);
  }

  const confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) {
    throw new Error('Decision confidence must be a finite number');
  }

  return {
    action,
    confidence: clamp(confidence, 0, 1),
    reasoning: normalizeReasoning(parsed?.reasoning),
    requestedSizePct: normalizeOptionalPct(parsed?.requestedSizePct),
    stopLossPct: normalizeOptionalPct(parsed?.stopLossPct),
    takeProfitPct: normalizeOptionalPct(parsed?.takeProfitPct),
  };
};

export const buildDecisionJsonShape = () => ({
  action: 'open_long | hold | close_long | skip',
  confidence: 'number between 0 and 1',
  reasoning: ['short reason strings'],
  requestedSizePct: 'optional number between 0 and 1',
  stopLossPct: 'optional number between 0 and 1',
  takeProfitPct: 'optional number between 0 and 1',
});
