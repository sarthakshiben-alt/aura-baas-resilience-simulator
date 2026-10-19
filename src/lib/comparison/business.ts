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
  attribution: "measured" | "assumption" | "uncertain" | "not_applicable";
  note: string;
}

export interface BusinessValue {
  offDowntimeMinutes: number;
  onDowntimeMinutes: number;
  downtimeMinutesAvoided: number;
  grossImpactAvoidedUsd: number;
  aiCostUsd: number | null;
  netValueUsd: number | null;
  /** Of the AI-vs-manual downtime avoided: share explained by automating the runbook (no AI needed). */
  automationDowntimeMinutesAvoided: number;
  /** Of the AI-vs-manual downtime avoided: share only AI delivered (automated rules → AI). */
  aiSpecificDowntimeMinutesAvoided: number;
  aiSpecificGrossImpactAvoidedUsd: number;
  controlsDowntimeMinutesAvoided: number;
  controlsGrossImpactAvoidedUsd: number;
  attribution: AttributionRow[];
  caveats: string[];
}

const mins = (s: number) => s / 60;
const fmtS = (v: number | null) => (v === null ? "N/A" : `${v} s`);

export function computeBusinessValue({ pair, costPerDowntimeMinuteUsd, pricePerMillionTokensUsd }: BusinessValueInput): BusinessValue {
  const off = pair.off.metrics;
  const rules = pair.rules.metrics;
  const on = pair.on.metrics;
  const offDown = mins(off.primaryDowntimeSeconds);
  const onDown = mins(on.primaryDowntimeSeconds);
  const avoided = offDown - onDown;
  const rulesDown = mins(rules.primaryDowntimeSeconds);
  const automationAvoided = offDown - rulesDown;
  const aiSpecificAvoided = rulesDown - onDown;
  const aiCost = on.tokens !== null && pricePerMillionTokensUsd !== null ? (on.tokens / 1_000_000) * pricePerMillionTokensUsd : null;
  const gross = avoided * costPerDowntimeMinuteUsd;
  const cf = pair.controlsCounterfactual;
  const ctrlAvoided = mins(cf.primaryDowntimeSeconds) - mins(pair.protectedBaseline.primaryDowntimeSeconds);
  const d = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
  const sgn = (v: number | null, unit = " s") => (v === null ? "N/A" : `${v > 0 ? "+" : ""}${Math.round(v * 100) / 100}${unit}`);
  const triageMin = Math.round(pair.config.manualTriageSeconds / 60);
  const autoDiag = d(off.timeToDiagnosisS, rules.timeToDiagnosisS);
  const aiDiag = d(rules.timeToDiagnosisS, on.timeToDiagnosisS);
  const autoRecov = d(off.timeToRecoveryS, rules.timeToRecoveryS);
  const aiRecov = d(rules.timeToRecoveryS, on.timeToRecoveryS);
  const attribution: AttributionRow[] = [
    {
      source: "Gateway resilience controls",
      measure: "Retail breach seconds / other-partner impaired seconds avoided vs. protections OFF (no actions in either)",
      value: `${cf.retailBreachSeconds - pair.protectedBaseline.retailBreachSeconds} s / ${cf.otherPartnerImpairedSeconds - pair.protectedBaseline.otherPartnerImpairedSeconds} s`,
      attribution: "measured",
      note: "Deterministic controls act immediately in EVERY arm, so this benefit is not attributable to AI.",
    },
    {
      source: "Automating the runbook (manual → automated rules, no AI)",
      measure: "Diagnosis time / verified recovery / primary downtime change",
      value: `${sgn(autoDiag)} / ${sgn(autoRecov)} / ${sgn(-automationAvoided, " min")}`,
      attribution: "assumption",
      note: `Driven by the ASSUMED ${triageMin} min of manual triage. Any rule engine running on detection captures this — no AI required. See the sensitivity table.`,
    },
    {
      source: "AI over automated rules",
      measure: "Diagnosis time / verified recovery / primary downtime change",
      value: `${sgn(aiDiag)} / ${sgn(aiRecov)} / ${sgn(-aiSpecificAvoided, " min")}`,
      attribution: on.diagnosisSource === "llm" ? "measured" : "not_applicable",
      note: "The marginal value of AI itself. Negative time = AI faster. Measured AI latency counts against AI here; diagnosis quality differences show up in recovery.",
    },
    {
      source: "Operational approval time",
      measure: "Simulated operator delay",
      value: `${pair.config.operatorDelaySeconds} s in every arm`,
      attribution: "not_applicable",
      note: "Held constant by design; real human approval time is measured only in interactive runs.",
    },
    {
      source: "More effective recovery actions",
      measure: "Recovery change (rules → AI) beyond the diagnosis-time change",
      value: aiRecov === null || aiDiag === null ? "N/A" : sgn(aiRecov - aiDiag),
      attribution: aiRecov === null ? "not_applicable" : "uncertain",
      note: `Recovery: manual ${fmtS(off.timeToRecoveryS)}, rules ${fmtS(rules.timeToRecoveryS)}, AI ${fmtS(on.timeToRecoveryS)}. Residual attributed to action choice; attribution is uncertain.`,
    },
  ];
  const caveats = [
    `ILLUSTRATIVE ESTIMATE, not realised savings. Uses the case-provided assumption of $${costPerDowntimeMinuteUsd.toLocaleString("en-US")}/min for one fintech partner (editable).`,
    "Downtime = simulated seconds the primary partner served < 50% of offered requests (including breaker fast-fails).",
    "Single paired run; no statistical significance is claimed.",
    `The manual-triage time (${triageMin} min) is an input assumption. Most of the AI-vs-manual difference typically comes from it, and an automated rule engine captures that share without AI.`,
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
    automationDowntimeMinutesAvoided: automationAvoided,
    aiSpecificDowntimeMinutesAvoided: aiSpecificAvoided,
    aiSpecificGrossImpactAvoidedUsd: aiSpecificAvoided * costPerDowntimeMinuteUsd,
    controlsDowntimeMinutesAvoided: ctrlAvoided,
    controlsGrossImpactAvoidedUsd: ctrlAvoided * costPerDowntimeMinuteUsd,
    attribution,
    caveats,
  };
}
