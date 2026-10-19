import type { GoldenScenario } from "../golden/dataset";
import type { IncidentContext } from "./context";
import type { Diagnosis } from "./schema";
import type { PolicyResult } from "../sim/types";

/**
 * Heuristic evidence-grounding check: every number (≥ 10, or with decimals)
 * quoted in evidence/facts must appear in the supplied context within ±2%
 * (or ±1 absolute). This is an ILLUSTRATIVE heuristic, not proof of grounding.
 */
export function contextNumbers(ctx: IncidentContext): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else if (typeof v === "string") for (const m of v.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  };
  walk(ctx);
  return out;
}

export function groundingScore(d: Diagnosis, ctx: IncidentContext): { checked: number; grounded: number; ratio: number | null } {
  const nums = contextNumbers(ctx);
  const texts = [...d.observedFacts, ...d.likelyCauses.flatMap((c) => c.evidence)];
  let checked = 0;
  let grounded = 0;
  for (const text of texts) {
    for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      if (!m[0].includes(".") && Math.abs(n) < 10) continue;
      checked += 1;
      if (nums.some((c) => Math.abs(c - n) <= Math.max(1, Math.abs(c) * 0.02))) grounded += 1;
    }
  }
  return { checked, grounded, ratio: checked === 0 ? null : grounded / checked };
}

export interface DiagnosisScore {
  causeCorrect: boolean;
  primaryCorrect: boolean;
  diagnosisCorrect: boolean;
  topCategory: string;
  grounding: { checked: number; grounded: number; ratio: number | null };
  recommendations: number;
  policyValid: number;
  policyRejected: number;
  appropriate: number;
  unnecessary: number;
  /** Forbidden for this scenario, or not listed as acceptable/unnecessary. */
  inappropriate: number;
  uncertaintyAcknowledged: boolean;
}

export function scoreDiagnosis(d: Diagnosis, gs: GoldenScenario, ctx: IncidentContext, policy: PolicyResult[]): DiagnosisScore {
  const exp = gs.expectedAi;
  const top = d.likelyCauses[0]?.category ?? "insufficient_evidence";
  const causeCorrect = exp.acceptableCauses.includes(top as never);
  const primaryCorrect = exp.primaryEntityId === null ? true : d.primaryEntityId === exp.primaryEntityId;
  const ids = d.recommendedActions.map((a) => a.actionId);
  const uncertainty =
    top === "insufficient_evidence" || (d.likelyCauses[0]?.confidence ?? 1) <= 0.5 || d.unknowns.length > 0;
  return {
    causeCorrect,
    primaryCorrect,
    diagnosisCorrect: causeCorrect && primaryCorrect,
    topCategory: top,
    grounding: groundingScore(d, ctx),
    recommendations: ids.length,
    policyValid: policy.filter((p) => p.status !== "rejected").length,
    policyRejected: policy.filter((p) => p.status === "rejected").length,
    appropriate: ids.filter((i) => exp.acceptableActions.includes(i)).length,
    unnecessary: ids.filter((i) => exp.unnecessaryActions.includes(i)).length,
    inappropriate: ids.filter((i) => exp.forbiddenActions.includes(i) || !exp.acceptableActions.concat(exp.unnecessaryActions).includes(i)).length,
    uncertaintyAcknowledged: exp.mustAcknowledgeUncertainty ? uncertainty : true,
  };
}
