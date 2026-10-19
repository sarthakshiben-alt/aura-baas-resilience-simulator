import type { PairedRunResult } from "./paired";

/** Case-provided illustrative assumption — NOT verified financial data. Editable in the UI. */
export const CASE_COST_PER_DOWNTIME_MINUTE_USD = 4500;

export interface BusinessValueInput {
  pair: PairedRunResult;
  costPerDowntimeMinuteUsd: number;
  pricePerMillionTokensUsd: number | null;
}

export interface AttributionRow {
  source: string;
  measure: string;
  value: string;
  attribution: "measured" | "uncertain" | "not_applicable";
  note: string;
}

export interface BusinessValue {
  offDowntimeMinutes: number;
  onDowntimeMinutes: number;
  downtimeMinutesAvoided: number;
  grossImpactAvoidedUsd: number;
  aiCostUsd: number | null;
  netValueUsd: number | null;
  controlsDowntimeMinutesAvoided: number;
  controlsGrossImpactAvoidedUsd: number;
  attribution: AttributionRow[];
  caveats: string[];
}

const mins = (s: number) => s / 60;
const fmtS = (v: number | null) => (v === null ? "N/A" : `${v} s`);

export function computeBusinessValue({ pair, costPerDowntimeMinuteUsd, pricePerMillionTokensUsd }: BusinessValueInput): BusinessValue {
  const off = pair.off.metrics;
  const on = pair.on.metrics;
  const offDown = mins(off.primaryDowntimeSeconds);
  const onDown = mins(on.primaryDowntimeSeconds);
  const avoided = offDown - onDown;
  const aiCost = on.tokens !== null && pricePerMillionTokensUsd !== null ? (on.tokens / 1_000_000) * pricePerMillionTokensUsd : null;
  const gross = avoided * costPerDowntimeMinuteUsd;
  const cf = pair.controlsCounterfactual;
  const ctrlAvoided = mins(cf.primaryDowntimeSeconds) - mins(pair.protectedBaseline.primaryDowntimeSeconds);
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  const diagDelta = d(off.timeToDiagnosisS, on.timeToDiagnosisS);
  const recDelta = d(off.timeToRecommendationS, on.timeToRecommendationS);
  const recovDelta = d(off.timeToRecoveryS, on.timeToRecoveryS);
  const attribution: AttributionRow[] = [
    {
      source: "Gateway resilience controls",
      measure: "Retail breach seconds / other-partner impaired seconds avoided vs. protections OFF (no actions in either)",
      value: `${cf.retailBreachSeconds - pair.protectedBaseline.retailBreachSeconds} s / ${cf.otherPartnerImpairedSeconds - pair.protectedBaseline.otherPartnerImpairedSeconds} s`,
      attribution: "measured",
      note: "Deterministic controls; present in BOTH AI modes, so this benefit is not attributable to AI.",
    },
    {
      source: "Faster incident diagnosis",
      measure: "Time to diagnosis, AI ON − AI OFF",
      value: diagDelta === null ? "N/A" : `${diagDelta > 0 ? "+" : ""}${diagDelta} s`,
      attribution: diagDelta === null ? "not_applicable" : "measured",
      note: "Negative = AI faster. Rule-based assessment completes in milliseconds, so AI rarely wins on speed alone.",
    },
    {
      source: "Faster recommendation generation",
      measure: "Time to first policy-valid recommendation, AI ON − AI OFF",
      value: recDelta === null ? "N/A" : `${recDelta > 0 ? "+" : ""}${recDelta} s`,
      attribution: recDelta === null ? "not_applicable" : "measured",
      note: "Includes AI inference latency converted to simulated time.",
    },
    {
      source: "Shorter operational approval time",
      measure: "Simulated operator delay",
      value: `${pair.config.operatorDelaySeconds} s in both modes`,
      attribution: "not_applicable",
      note: "Held constant by design in paired runs; real human approval time is measured only in interactive runs.",
    },
    {
      source: "More effective recovery actions",
      measure: "Time to verified recovery, AI ON − AI OFF, beyond the recommendation-time difference",
      value: recovDelta === null || recDelta === null ? "N/A" : `${recovDelta - recDelta > 0 ? "+" : ""}${recovDelta - recDelta} s`,
      attribution: recovDelta === null ? "not_applicable" : "uncertain",
      note: `Recovery: OFF ${fmtS(off.timeToRecoveryS)}, ON ${fmtS(on.timeToRecoveryS)}. Residual attributed to action choice; attribution is uncertain.`,
    },
  ];
  const caveats = [
    `ILLUSTRATIVE ESTIMATE, not realised savings. Uses the case-provided assumption of $${costPerDowntimeMinuteUsd.toLocaleString("en-US")}/min for one fintech partner (editable).`,
    "Downtime = simulated seconds the primary partner served < 50% of offered requests (including breaker fast-fails).",
    "Single paired run; no statistical significance is claimed.",
  ];
  if (on.diagnosisSource !== "llm") caveats.push("AI ON run used the rule-based fallback; any difference is NOT AI value.");
  if (aiCost === null) caveats.push("AI usage cost unavailable (token usage or pricing not configured); net value not computed.");
  return {
    offDowntimeMinutes: offDown,
    onDowntimeMinutes: onDown,
    downtimeMinutesAvoided: avoided,
    grossImpactAvoidedUsd: gross,
    aiCostUsd: aiCost,
    netValueUsd: aiCost === null ? null : gross - aiCost,
    controlsDowntimeMinutesAvoided: ctrlAvoided,
    controlsGrossImpactAvoidedUsd: ctrlAvoided * costPerDowntimeMinuteUsd,
    attribution,
    caveats,
  };
}
