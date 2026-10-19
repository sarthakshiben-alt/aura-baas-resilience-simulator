import type { Diagnosis } from "./schema";
import type { EntityContext, IncidentContext } from "./context";
import type { CauseCategory, EntityId, Severity } from "../sim/types";

/**
 * Deterministic, rule-based incident assessment (the "conventional workflow"
 * runbook, and the fallback when AI is unavailable). Thresholds are explicit
 * and documented in docs/METHODOLOGY.md. Output is ALWAYS labelled
 * rule-based by the caller — never as an LLM result.
 */
export const RULE_THRESHOLDS = {
  /** R1: peak P95 at least this multiple of baseline counts as a sharp latency increase */
  latencyRatio: 3,
  /** R1: request rate not elevated if peak ≤ this multiple of baseline */
  rateNotElevated: 1.25,
  /** R2: peak request rate at least this multiple of baseline is a surge */
  surgeRatio: 1.5,
  /** R3: upstream (partner-returned) error rate */
  upstreamErrorPct: 10,
  /** R4: in-flight / limit ratio for concurrency pressure */
  concurrencyPressure: 0.9,
  /** R7: broad demand — partners or retail above this multiple */
  broadDemandRatio: 1.3,
  broadDemandMinPartners: 3,
} as const;

interface PartnerSignals {
  e: EntityContext;
  latency: boolean;
  surge: boolean;
  upstreamErrors: boolean;
  concurrencyPressure: boolean;
  breakerActive: boolean;
  impaired: boolean;
}

const fmt = (n: number | null, unit = "") => (n === null ? "n/a" : `${Math.round(n * 10) / 10}${unit}`);

function signals(e: EntityContext): PartnerSignals {
  const T = RULE_THRESHOLDS;
  const ratio = e.ratiosToBaseline.p95Peak ?? 0;
  const latency = ratio >= T.latencyRatio && e.ratiosToBaseline.requestRatePeak <= T.rateNotElevated;
  const surge = e.ratiosToBaseline.requestRatePeak >= T.surgeRatio;
  const upstreamErrors = e.last60s.maxUpstreamErrorRatePct >= T.upstreamErrorPct && ratio < T.latencyRatio;
  const concurrencyPressure = e.concurrencyLimit !== null && e.last60s.peakInFlight >= T.concurrencyPressure * e.concurrencyLimit;
  const breakerActive = e.breaker === "open" || e.breaker === "half_open";
  const impaired = e.status !== "healthy" && e.status !== "recovering";
  return { e, latency, surge, upstreamErrors, concurrencyPressure, breakerActive, impaired };
}

export function ruleBasedDiagnosis(ctx: IncidentContext): Diagnosis {
  const T = RULE_THRESHOLDS;
  const partners = ctx.entities.filter((e) => e.id !== "retail").map(signals);
  const retail = ctx.entities.find((e) => e.id === "retail")!;
  const gw = ctx.gateway;
  const facts: string[] = [];
  const inferences: string[] = [];
  const unknowns: string[] = ["Internal state of partner downstream systems is not visible to Aura gateway telemetry."];
  const actions: Diagnosis["recommendedActions"] = [];
  const add = (actionId: string, targetEntityId: EntityId | null, rationale: string) => {
    if (actions.length < 4 && !actions.some((a) => a.actionId === actionId && a.targetEntityId === targetEntityId)) actions.push({ actionId, targetEntityId, rationale });
  };

  // Observed facts (direct telemetry)
  for (const p of partners.filter((x) => x.impaired || x.latency || x.surge || x.upstreamErrors)) {
    const e = p.e;
    facts.push(
      `${e.name}: status ${e.status}, peak P95 ${fmt(e.last60s.peakP95Ms, " ms")} (${fmt(e.ratiosToBaseline.p95Peak, "×")} baseline ${e.baseline.p95Ms} ms), peak rate ${fmt(e.last60s.peakRequestRateRps, " rps")} (${fmt(e.ratiosToBaseline.requestRatePeak, "×")} baseline), breaker ${e.breaker}.`,
    );
    if (p.concurrencyPressure) facts.push(`${e.name}: peak in-flight ${fmt(e.last60s.peakInFlight)} vs concurrency limit ${e.concurrencyLimit}.`);
    if (e.last60s.maxUpstreamErrorRatePct > 2) facts.push(`${e.name}: partner-returned error rate peaked at ${fmt(e.last60s.maxUpstreamErrorRatePct, "%")}.`);
    if (p.breakerActive) facts.push(`${e.name}: circuit breaker is ${e.breaker}; calls are blocked or restricted by the configured protection.`);
  }
  facts.push(`Gateway utilisation ${fmt(gw.utilisationPct, "%")} (peak ${fmt(gw.peakUtilisationLast60sPct, "%")} in last 60 s); retail P95 ${fmt(retail.now.p95Ms, " ms")} vs ${ctx.thresholds.retailTargetP95Ms} ms target (${gw.retailHealth.replace("_", " ")}).`);

  const latencyP = partners.filter((p) => p.latency);
  const surgeP = partners.filter((p) => p.surge);
  const errorP = partners.filter((p) => p.upstreamErrors);
  const broadDemand =
    partners.filter((p) => p.e.ratiosToBaseline.requestRatePeak >= T.broadDemandRatio).length >= T.broadDemandMinPartners ||
    retail.ratiosToBaseline.requestRatePeak >= T.broadDemandRatio;
  const saturation = gw.peakUtilisationLast60sPct >= ctx.thresholds.gatewayPressureUtilisationPct && broadDemand;
  const retailImpaired = gw.retailHealth !== "healthy" || retail.last60s.secondsNotHealthy > 0 || (ctx.incident?.retailBreachSeconds ?? 0) > 0;
  const focus = ctx.incident?.primaryEntityId ?? null;

  let category: CauseCategory;
  let primary: EntityId | null = null;
  let cause: string;
  let confidence = 0.7;
  const evidence: string[] = [];
  const limitations: string[] = [];

  const pick = <X extends { e: EntityContext }>(list: X[]) => list.find((p) => p.e.id === focus) ?? list[0];

  if (!ctx.incident && !partners.some((p) => p.impaired) && gw.retailHealth === "healthy") {
    category = "no_incident";
    cause = "No incident: all services are within healthy thresholds.";
    confidence = 0.9;
    evidence.push(`No service is outside healthy thresholds; gateway utilisation ${fmt(gw.utilisationPct, "%")}.`);
    add("no_action", null, "No anomaly is present in the telemetry.");
  } else if (saturation) {
    category = "shared_gateway_saturation";
    primary = focus;
    cause = "Shared gateway capacity is under pressure from broad demand growth.";
    evidence.push(`Peak gateway utilisation ${fmt(gw.peakUtilisationLast60sPct, "%")} ≥ ${ctx.thresholds.gatewayPressureUtilisationPct}% threshold.`);
    evidence.push(`Retail request rate ${fmt(retail.ratiosToBaseline.requestRatePeak, "×")} baseline; ${partners.filter((p) => p.e.ratiosToBaseline.requestRatePeak >= T.broadDemandRatio).length} partners ≥ ${T.broadDemandRatio}× baseline.`);
    limitations.push("Rules cannot separate organic demand growth from retry amplification.");
    if (latencyP.length) inferences.push(`${latencyP.map((p) => p.e.name).join(", ")} also show(s) disproportionate latency that may add pressure.`);
    if (retailImpaired && !gw.controls.retailReservationEnabled) add("reserve_retail_capacity", null, "Retail is impaired and has no reserved capacity.");
    add("scale_gateway_capacity", null, "Runbook: relieve genuine shared-capacity saturation with bounded scale-out.");
    if (retailImpaired && gw.controls.retailReservationEnabled) add("reserve_retail_capacity", null, "Retail is near/over target; raise its reservation.");
    for (const p of latencyP) if (p.breakerActive) add("maintain_circuit_breaker", p.e.id, "Breaker is shedding load from a slow partner.");
    add("escalate_to_operator", null, "Confirm demand source with a human operator.");
  } else if (latencyP.length === 1 || (latencyP.length > 1 && latencyP.some((p) => p.e.id === focus))) {
    const p = pick(latencyP);
    category = "partner_downstream_latency";
    primary = p.e.id;
    cause = `Possible downstream latency degradation at ${p.e.name} (not confirmed — partner internals are not observable).`;
    evidence.push(`${p.e.name} peak P95 ${fmt(p.e.last60s.peakP95Ms, " ms")} = ${fmt(p.e.ratiosToBaseline.p95Peak, "×")} baseline while request rate peaked at only ${fmt(p.e.ratiosToBaseline.requestRatePeak, "×")} baseline (R1).`);
    if (p.breakerActive) evidence.push(`${p.e.name} breaker is ${p.e.breaker}: slow/failed calls exceeded ${ctx.thresholds.breaker.failureOrSlowRatePct}% (R5).`);
    if (p.concurrencyPressure) evidence.push(`${p.e.name} in-flight peaked at ${fmt(p.e.last60s.peakInFlight)} of limit ${p.e.concurrencyLimit} (R4).`);
    limitations.push("Which downstream dependency is slow cannot be identified from gateway telemetry.");
    const othersImpaired = partners.some((x) => x.e.id !== p.e.id && x.impaired) || retailImpaired;
    if (latencyP.length > 1) inferences.push(`Other partners with elevated latency: ${latencyP.filter((x) => x !== p).map((x) => x.e.name).join(", ")}.`);
    if (othersImpaired) inferences.push("Shared-pool contention is likely spilling over to other services.");
    else inferences.push("Gateway protections appear to be containing the impact: other partners and retail are healthy.");
    if (p.breakerActive) add("maintain_circuit_breaker", p.e.id, "Breaker is shedding load from the slow partner and will probe for recovery.");
    if (p.e.last60s.peakInFlight >= 0.5 * (p.e.concurrencyLimit ?? Infinity) && (othersImpaired || gw.partnerPoolUtilisationPct >= ctx.thresholds.gatewayPressureUtilisationPct))
      add("cap_partner_concurrency", p.e.id, "Partner holds a large share of shared slots while other services are impaired.");
    if (retailImpaired && !gw.controls.retailReservationEnabled) add("reserve_retail_capacity", null, "Retail is impaired and has no reserved capacity.");
    add("escalate_to_partner", p.e.id, "Only the partner can remediate its downstream; share the latency evidence.");
  } else if (surgeP.length >= 1 && !broadDemand) {
    const p = pick(surgeP);
    category = "partner_traffic_surge";
    primary = p.e.id;
    cause = `Traffic surge from ${p.e.name}.`;
    evidence.push(`${p.e.name} request rate peaked at ${fmt(p.e.last60s.peakRequestRateRps, " rps")} = ${fmt(p.e.ratiosToBaseline.requestRatePeak, "×")} baseline (R2).`);
    if ((p.e.ratiosToBaseline.p95Peak ?? 0) > 1.5) inferences.push(`Latency (${fmt(p.e.ratiosToBaseline.p95Peak, "×")} baseline) and partner errors are plausibly load-induced.`);
    limitations.push("Rules cannot tell whether the surge is legitimate customer demand or client retries.");
    if (p.e.rateLimitRps === null) add("apply_rate_limit", p.e.id, "Keep partner traffic within simulated backend capacity.");
    if (p.concurrencyPressure) add("cap_partner_concurrency", p.e.id, "In-flight is at the concurrency limit.");
    add("escalate_to_operator", null, "Confirm with the partner whether the surge is expected.");
  } else if (errorP.length >= 1) {
    const p = pick(errorP);
    category = "partner_downstream_errors";
    primary = p.e.id;
    cause = `${p.e.name} downstream is returning errors.`;
    evidence.push(`${p.e.name} partner-returned error rate peaked at ${fmt(p.e.last60s.maxUpstreamErrorRatePct, "%")} with latency ${fmt(p.e.ratiosToBaseline.p95Peak, "×")} baseline (R3).`);
    if (p.breakerActive) evidence.push(`${p.e.name} breaker is ${p.e.breaker} (R5).`);
    limitations.push("Error semantics inside the partner system are not visible.");
    if (p.breakerActive) add("maintain_circuit_breaker", p.e.id, "Breaker is shedding failing calls.");
    add("escalate_to_partner", p.e.id, "Partner must remediate the failing downstream.");
  } else if (retailImpaired && retail.ratiosToBaseline.requestRatePeak >= T.broadDemandRatio) {
    category = "retail_demand_pressure";
    primary = "retail";
    cause = "Retail demand growth is pressing on retail capacity.";
    evidence.push(`Retail request rate peaked at ${fmt(retail.ratiosToBaseline.requestRatePeak, "×")} baseline; retail P95 ${fmt(retail.last60s.peakP95Ms, " ms")} vs ${ctx.thresholds.retailTargetP95Ms} ms target (R6).`);
    limitations.push("Retail downstream internals are not modelled in detail.");
    add("reserve_retail_capacity", null, "Protect retail with additional reserved slots.");
    add("scale_gateway_capacity", null, "Bounded scale-out if pressure persists.");
  } else {
    category = "insufficient_evidence";
    primary = null;
    confidence = 0.3;
    const impaired = partners.filter((p) => p.impaired).map((p) => p.e.name);
    cause = "Root cause unconfirmed: the telemetry does not match any single rule.";
    evidence.push(
      impaired.length ? `Impaired services: ${impaired.join(", ")}; none meets the sharp-latency (≥${T.latencyRatio}× baseline with stable traffic), surge (≥${T.surgeRatio}×) or upstream-error (≥${T.upstreamErrorPct}%) rules.` : "Anomaly does not match a defined rule.",
    );
    if (latencyP.length > 1) evidence.push(`Several partners (${latencyP.map((p) => p.e.name).join(", ")}) show latency increases at once.`);
    limitations.push("A shared dependency outside the gateway could explain simultaneous degradation but is not observable.");
    unknowns.push("Whether affected partners share a common downstream dependency.");
    add("escalate_to_operator", null, "Evidence is insufficient for an automated recommendation; a human must investigate.");
  }

  if (retailImpaired) inferences.push(`Retail banking is ${gw.retailHealth.replace("_", " ")} (P95 ${fmt(retail.now.p95Ms, " ms")} vs ${ctx.thresholds.retailTargetP95Ms} ms target).`);
  else inferences.push("Retail banking is within its simulated service target.");

  const sev: Severity = (ctx.incident?.severity as Severity) ?? (category === "no_incident" ? "low" : "medium");
  const summary =
    category === "no_incident"
      ? "No incident detected in the current simulated telemetry."
      : `${cause} ${retailImpaired ? "Retail banking is impacted." : "Retail banking is within target."}`;

  return {
    summary: summary.slice(0, 600),
    severity: sev,
    primaryEntityId: primary,
    likelyCauses: [{ cause: cause.slice(0, 300), category, confidence, evidence: evidence.slice(0, 6).map((x) => x.slice(0, 300)), limitations: limitations.slice(0, 4) }],
    observedFacts: facts.slice(0, 10).map((x) => x.slice(0, 300)),
    inferences: inferences.slice(0, 6),
    unknowns: unknowns.slice(0, 6),
    recommendedActions: actions,
    nextSteps: category === "insufficient_evidence" ? ["Collect partner-side traces", "Check for a shared dependency across affected partners"] : ["Review and approve or reject the proposed actions", "Monitor recovery verification"],
    reasoningSummary: `Rule-based runbook (thresholds: latency ≥${T.latencyRatio}× with rate ≤${T.rateNotElevated}×, surge ≥${T.surgeRatio}×, upstream errors ≥${T.upstreamErrorPct}%, saturation ≥${ctx.thresholds.gatewayPressureUtilisationPct}% with broad demand). Category: ${category}.`,
    requiresHumanApproval: true,
  };
}
