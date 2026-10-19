import type { Incident, SimState } from "../sim/types";

/**
 * Metrics derived ONLY from recorded simulation events. Simulated-time values
 * are in sim seconds (1 tick = 1 s). Wall-clock values (AI latency, human
 * approval time) are in ms and are never mixed into simulated durations.
 */
export interface RunMetrics {
  incidentId: string | null;
  detected: boolean;
  timeToDetectionS: number | null;
  timeToDiagnosisS: number | null;
  investigationDurationS: number | null;
  timeToRecommendationS: number | null;
  timeToFirstDecisionS: number | null;
  timeToRecoveryS: number | null;
  recovered: boolean;
  observationWindowS: number;
  /** Mean measured LLM wall-clock latency across this run's investigations. */
  aiInferenceLatencyMs: number | null;
  investigations: number;
  investigationWallMs: number | null;
  humanDecisionWallMs: number | null;
  retailBreachSeconds: number;
  retailAtRiskSeconds: number;
  peakRetailP95Ms: number | null;
  partnerImpactSeconds: number;
  partnerDowntimeSeconds: number;
  primaryDowntimeSeconds: number;
  /** Seconds the primary service was outside its healthy thresholds (slow, erroring or blocked) — what an SLA penalises. */
  primarySlaBreachSeconds: number;
  diagnosisSource: string | null;
  fallbackUsed: boolean;
  errorCategory: string | null;
  recommendations: number;
  validRecommendations: number;
  policyRejections: number;
  interventionsExecuted: number;
  unnecessaryInterventions: number;
  tokens: number | null;
}

const rel = (v: number | null, start: number) => (v === null ? null : v - start);

export function incidentMetrics(state: SimState, inc: Incident | null, windowStart: number): RunMetrics {
  if (!inc) {
    return {
      incidentId: null,
      detected: false,
      timeToDetectionS: null,
      timeToDiagnosisS: null,
      investigationDurationS: null,
      timeToRecommendationS: null,
      timeToFirstDecisionS: null,
      timeToRecoveryS: null,
      recovered: false,
      observationWindowS: state.tick - windowStart,
      aiInferenceLatencyMs: null,
      investigations: 0,
      investigationWallMs: null,
      humanDecisionWallMs: null,
      retailBreachSeconds: state.history.gateway.filter((g) => g.t >= windowStart && g.retailHealth === "breach").length,
      retailAtRiskSeconds: state.history.gateway.filter((g) => g.t >= windowStart && g.retailHealth === "at_risk").length,
      peakRetailP95Ms: null,
      partnerImpactSeconds: 0,
      partnerDowntimeSeconds: 0,
      primaryDowntimeSeconds: 0,
      primarySlaBreachSeconds: 0,
      diagnosisSource: null,
      fallbackUsed: false,
      errorCategory: null,
      recommendations: 0,
      validRecommendations: 0,
      policyRejections: 0,
      interventionsExecuted: 0,
      unnecessaryInterventions: 0,
      tokens: null,
    };
  }
  const first = inc.investigations[0] ?? null;
  const recs = inc.recommendations;
  const llm = inc.investigations.map((i) => i.llmLatencyMs).filter((x): x is number => x !== null);
  const tokens = inc.investigations.map((i) => i.usage?.totalTokens ?? null);
  const checks = inc.postActionChecks.filter((c) => c.intervention);
  const sum = (o: Partial<Record<string, number>>) => Object.values(o).reduce<number>((s, v) => s + (v ?? 0), 0);
  return {
    incidentId: inc.id,
    detected: true,
    timeToDetectionS: inc.detectedAt - inc.startedAt,
    timeToDiagnosisS: rel(inc.diagnosedAt, inc.startedAt),
    investigationDurationS: inc.diagnosedAt !== null && inc.investigationRequestedAt !== null ? inc.diagnosedAt - inc.investigationRequestedAt : null,
    timeToRecommendationS: rel(inc.recommendationAt, inc.startedAt),
    timeToFirstDecisionS: rel(inc.firstDecisionAt, inc.startedAt),
    timeToRecoveryS: inc.recoveryVerified ? rel(inc.recoveredAt, inc.startedAt) : null,
    recovered: inc.recoveryVerified,
    observationWindowS: state.tick - inc.startedAt,
    aiInferenceLatencyMs: llm.length ? Math.round(llm.reduce((a, b) => a + b, 0) / llm.length) : null,
    investigations: inc.investigations.length,
    investigationWallMs: first?.latencyMs ?? null,
    humanDecisionWallMs: first && inc.firstDecisionWallMs !== null ? Math.max(0, inc.firstDecisionWallMs - first.completedAtWallMs) : null,
    retailBreachSeconds: inc.retailBreachSeconds,
    retailAtRiskSeconds: inc.retailAtRiskSeconds,
    peakRetailP95Ms: inc.peakRetailP95Ms || null,
    partnerImpactSeconds: sum(inc.partnerImpactSeconds),
    partnerDowntimeSeconds: sum(inc.partnerDowntimeSeconds),
    primaryDowntimeSeconds: inc.partnerDowntimeSeconds[inc.primaryEntityId] ?? 0,
    primarySlaBreachSeconds: inc.partnerImpactSeconds[inc.primaryEntityId] ?? 0,
    diagnosisSource: first?.source ?? null,
    fallbackUsed: inc.investigations.some((i) => i.fallbackUsed),
    errorCategory: first?.errorCategory ?? null,
    recommendations: recs.length,
    validRecommendations: recs.filter((r) => r.validation.status !== "rejected").length,
    policyRejections: recs.filter((r) => r.validation.status === "rejected").length,
    interventionsExecuted: checks.length,
    unnecessaryInterventions: checks.filter((c) => c.effective === false).length,
    tokens: tokens.length && tokens.every((x) => x !== null) ? (tokens as number[]).reduce((a, b) => a + b, 0) : null,
  };
}

export interface Diff {
  a: number | null;
  b: number | null;
  abs: number | null;
  pct: number | null;
}

/** b − a, and (b − a)/a. Null-safe; percentage is null when a is 0 or missing. */
export function diff(a: number | null | undefined, b: number | null | undefined): Diff {
  const A = a ?? null;
  const B = b ?? null;
  if (A === null || B === null) return { a: A, b: B, abs: null, pct: null };
  return { a: A, b: B, abs: B - A, pct: A === 0 ? null : (B - A) / A };
}

export function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}
