import { ENTITY_PROFILES, effectiveLimit } from "./config";
import { latest, latestGateway, pushEvent } from "./engine";
import { q } from "./math";
import type { ActionAuditEntry, EntityId, Incident, PartnerId, PostActionCheck, Recommendation, SimState } from "./types";
import { isPartnerId, PARTNER_IDS } from "./types";

/**
 * Predefined, simulated operations. The LLM can only reference these IDs;
 * anything else is rejected by the policy engine. Nothing here touches real
 * infrastructure.
 */
export interface ActionDefinition {
  id: string;
  label: string;
  description: string;
  target: "partner" | "none";
  executionDelaySeconds: number;
  evaluationHorizonSeconds: number;
  /** Whether the action changes system state (counts toward intervention metrics). */
  intervention: boolean;
  expectedBenefit: string;
  risk: string;
  reversibility: string;
}

export const ACTIONS: Record<string, ActionDefinition> = {
  cap_partner_concurrency: {
    id: "cap_partner_concurrency",
    label: "Apply predefined per-partner concurrency cap",
    description: "Tighten the target partner's gateway concurrency limit to the predefined cap (40 in-flight requests).",
    target: "partner",
    executionDelaySeconds: 5,
    evaluationHorizonSeconds: 60,
    intervention: true,
    expectedBenefit: "Bounds the shared gateway slots the partner can hold, protecting other partners and retail.",
    risk: "Excess partner requests are rejected (simulated HTTP 503). Does not fix the partner's downstream.",
    reversibility: "Reversible via 'Release temporary partner controls' once the partner is healthy.",
  },
  maintain_circuit_breaker: {
    id: "maintain_circuit_breaker",
    label: "Maintain existing circuit breaker",
    description: "Keep the configured circuit breaker under automatic control; no manual override. No state change.",
    target: "partner",
    executionDelaySeconds: 0,
    evaluationHorizonSeconds: 60,
    intervention: false,
    expectedBenefit: "Breaker continues shedding load from the failing partner and probes for recovery per its rules.",
    risk: "Partner customers keep receiving fast-fail responses while the breaker is open.",
    reversibility: "No change is made.",
  },
  apply_rate_limit: {
    id: "apply_rate_limit",
    label: "Apply simulated rate limit",
    description: "Limit the target partner to 1.5× its baseline request rate (150 rps).",
    target: "partner",
    executionDelaySeconds: 5,
    evaluationHorizonSeconds: 60,
    intervention: true,
    expectedBenefit: "Keeps a traffic surge within the partner's simulated backend capacity.",
    risk: "Requests above the limit receive simulated HTTP 429. Client retry behaviour is not modelled.",
    reversibility: "Reversible via 'Release temporary partner controls'.",
  },
  escalate_to_partner: {
    id: "escalate_to_partner",
    label: "Escalate to partner engineering",
    description: "Send the evidence pack to the partner's on-call team. Remediation timing is a scenario-defined modelling assumption.",
    target: "partner",
    executionDelaySeconds: 0,
    evaluationHorizonSeconds: 180,
    intervention: true,
    expectedBenefit: "If the fault is in the partner's downstream, the partner can remediate it (modelled as 60 s after notification).",
    risk: "No effect if the cause is not partner-side. Consumes partner goodwill if mis-targeted.",
    reversibility: "Communication only; no gateway change.",
  },
  escalate_to_operator: {
    id: "escalate_to_operator",
    label: "Escalate to human operator",
    description: "Page the Aura on-call engineer for manual investigation. Simulated; no state change.",
    target: "none",
    executionDelaySeconds: 0,
    evaluationHorizonSeconds: 60,
    intervention: false,
    expectedBenefit: "A human investigates evidence the gateway telemetry cannot provide.",
    risk: "Manual investigation time is not modelled in this simulator.",
    reversibility: "No change is made.",
  },
  scale_gateway_capacity: {
    id: "scale_gateway_capacity",
    label: "Bounded gateway scale-out",
    description: "Add 85 shared gateway slots (bounded at 510 total). Takes 60 simulated seconds to provision and has an illustrative cost.",
    target: "none",
    executionDelaySeconds: 60,
    evaluationHorizonSeconds: 60,
    intervention: true,
    expectedBenefit: "Relieves genuine shared-capacity saturation.",
    risk: "Adds simulated cost. Does not reduce a partner's downstream latency.",
    reversibility: "Capacity remains until the scenario is reset.",
  },
  reserve_retail_capacity: {
    id: "reserve_retail_capacity",
    label: "Enable / raise retail capacity reservation",
    description: "Enable the retail banking slot reservation, or raise it by 40 slots (bounded at 220).",
    target: "none",
    executionDelaySeconds: 5,
    evaluationHorizonSeconds: 60,
    intervention: true,
    expectedBenefit: "Guarantees retail banking a share of gateway slots regardless of partner load.",
    risk: "Fewer slots remain for partners during pressure.",
    reversibility: "Reversible by configuration.",
  },
  release_temporary_controls: {
    id: "release_temporary_controls",
    label: "Release temporary partner controls",
    description: "Remove incident-time concurrency caps and rate limits from a partner that has been healthy for 30 s.",
    target: "partner",
    executionDelaySeconds: 5,
    evaluationHorizonSeconds: 60,
    intervention: true,
    expectedBenefit: "Restores full partner capacity after recovery.",
    risk: "If recovery was not genuine, the partner could re-consume shared slots.",
    reversibility: "Caps can be re-applied.",
  },
  no_action: {
    id: "no_action",
    label: "Take no action (insufficient evidence)",
    description: "Record that the available evidence does not justify an intervention.",
    target: "none",
    executionDelaySeconds: 0,
    evaluationHorizonSeconds: 60,
    intervention: false,
    expectedBenefit: "Avoids an unjustified change.",
    risk: "If an issue is real, it continues until further evidence emerges.",
    reversibility: "No change is made.",
  },
};

export const ACTION_IDS = Object.keys(ACTIONS);

export function getAction(id: string): ActionDefinition | null {
  return Object.prototype.hasOwnProperty.call(ACTIONS, id) ? ACTIONS[id] : null;
}

function nextAuditId(state: SimState) {
  state.counters.audit += 1;
  return `AUD-${String(state.counters.audit).padStart(4, "0")}`;
}

export function addAudit(state: SimState, inc: Incident, entry: Omit<ActionAuditEntry, "id" | "incidentId">): ActionAuditEntry {
  const full: ActionAuditEntry = { id: nextAuditId(state), incidentId: inc.id, ...entry };
  inc.audit.push(full);
  return full;
}

function controlsSnapshot(state: SimState, target: EntityId | null): Record<string, unknown> {
  const c = state.controls;
  const snap: Record<string, unknown> = {
    capacitySlots: state.config.gatewayCapacitySlots + c.extraCapacitySlots,
    retailReservationEnabled: c.retailReservationEnabled,
    retailReservationSlots: c.retailReservationSlots,
    isolationEnabled: c.isolationEnabled,
    breakerEnabled: c.breakerEnabled,
  };
  if (target && isPartnerId(target)) {
    snap.targetConcurrencyLimit = effectiveLimit(c, target);
    snap.targetRateLimitRps = c.rateLimits[target] ?? null;
    snap.targetBreaker = state.runtime[target].breaker.state;
    const s = latest(state, target);
    snap.targetP95Ms = s?.p95Ms ?? null;
    snap.targetInFlight = s?.inFlight ?? null;
  }
  const g = latestGateway(state);
  snap.gatewayUtilisation = g?.utilisation ?? null;
  snap.retailP95Ms = g?.retailP95Ms ?? null;
  return snap;
}

function verificationMetrics(state: SimState, target: EntityId | null): Record<string, number | null> {
  const g = latestGateway(state);
  const others = PARTNER_IDS.filter((p) => p !== target).map((p) => latest(state, p)?.p95Ms ?? 0);
  const t = target ? latest(state, target) : null;
  return {
    targetP95Ms: t?.p95Ms ?? null,
    targetErrorRate: t ? t.errorRate - t.rejectedRate - t.throttledRate : null,
    targetHealthyStreak: target ? state.runtime[target].healthyStreak : null,
    othersMaxP95Ms: others.length ? Math.max(...others) : null,
    retailP95Ms: g?.retailP95Ms ?? null,
    utilisation: g?.utilisation ?? null,
    pressure: g?.pressure ?? null,
    partnerPoolUtilisation: g?.partnerPoolUtilisation ?? null,
  };
}

export function executeAction(state: SimState, inc: Incident, rec: Recommendation, actor: ActionAuditEntry["actorType"]): void {
  const t = state.tick;
  const def = getAction(rec.actionId);
  const target = rec.targetEntityId;
  const before = controlsSnapshot(state, target);
  const beforeMetrics = verificationMetrics(state, target);
  let outcome = "";
  const cfg = state.config.actions;
  const c = state.controls;
  const partner: PartnerId | null = target && isPartnerId(target) ? target : null;

  switch (rec.actionId) {
    case "cap_partner_concurrency":
      if (partner) {
        c.caps[partner] = cfg.predefinedConcurrencyCap;
        outcome = `${ENTITY_PROFILES[partner].name} concurrency limit set to ${effectiveLimit(c, partner)}`;
      }
      break;
    case "apply_rate_limit":
      if (partner) {
        c.rateLimits[partner] = q(state.config.baseline.partnerRps * cfg.rateLimitBaselineMultiple, 2);
        outcome = `${ENTITY_PROFILES[partner].name} rate limited to ${c.rateLimits[partner]} rps`;
      }
      break;
    case "scale_gateway_capacity": {
      const max = cfg.maxCapacitySlots - state.config.gatewayCapacitySlots;
      c.extraCapacitySlots = Math.min(max, c.extraCapacitySlots + cfg.scaleStepSlots);
      outcome = `Gateway capacity now ${state.config.gatewayCapacitySlots + c.extraCapacitySlots} slots`;
      break;
    }
    case "reserve_retail_capacity":
      if (!c.retailReservationEnabled) {
        c.retailReservationEnabled = true;
        outcome = `Retail reservation enabled (${c.retailReservationSlots} slots)`;
      } else {
        c.retailReservationSlots = Math.min(cfg.maxRetailReservationSlots, c.retailReservationSlots + cfg.retailReservationStepSlots);
        outcome = `Retail reservation raised to ${c.retailReservationSlots} slots`;
      }
      break;
    case "release_temporary_controls":
      if (partner) {
        delete c.caps[partner];
        delete c.rateLimits[partner];
        outcome = `Temporary controls released for ${ENTITY_PROFILES[partner].name}`;
      }
      break;
    case "escalate_to_partner": {
      let started = 0;
      for (const run of state.scenarioRuns) {
        for (const p of run.perturbations) {
          if (p.entity === partner && p.remediableByPartnerEscalation && p.endAt === null && p.remediationAt === null) {
            p.remediationAt = t + p.remediationSeconds;
            started += 1;
          }
        }
      }
      if (started > 0 && partner) {
        outcome = `Partner engineering notified; remediation modelled to complete in ${state.scenarioRuns.flatMap((r) => r.perturbations).find((p) => p.entity === partner && p.remediationAt !== null)?.remediationSeconds ?? 60}s`;
        pushEvent(state, "partner_remediation_started", `${ENTITY_PROFILES[partner].name} engineering acknowledged escalation (simulated)`, { incidentId: inc.id, entityId: partner });
      } else {
        outcome = "Partner notified; no partner-side remediation is modelled for this condition";
      }
      break;
    }
    case "maintain_circuit_breaker":
      outcome = partner ? `Circuit breaker remains under automatic control (currently ${state.runtime[partner].breaker.state.replace("_", "-")}); no state change` : "No state change";
      break;
    case "escalate_to_operator":
      outcome = "Simulated page sent to Aura on-call; no state change";
      break;
    case "no_action":
      outcome = "No action taken; recorded as insufficient evidence";
      break;
    default:
      outcome = "Unknown action; not executed";
  }

  rec.executedAt = t;
  rec.executionOutcome = outcome;
  inc.firstActionExecutedAt ??= t;
  const after = controlsSnapshot(state, target);
  addAudit(state, inc, {
    recommendationId: rec.id,
    actionId: rec.actionId,
    targetEntityId: target,
    actorType: actor,
    outcome: "executed",
    t,
    wallMs: null,
    beforeState: before,
    afterState: after,
    note: `Simulated action: ${outcome}`,
  });
  pushEvent(state, "action_executed", `Simulated action executed: ${def?.label ?? rec.actionId}${partner ? ` → ${ENTITY_PROFILES[partner].name}` : ""}. ${outcome}`, {
    incidentId: inc.id,
    entityId: target,
  });
  const check: PostActionCheck = {
    recommendationId: rec.id,
    actionId: rec.actionId,
    executedAt: t,
    evaluateAt: t + (def?.evaluationHorizonSeconds ?? 60),
    before: beforeMetrics,
    after: null,
    effective: null,
    intervention: def?.intervention ?? false,
    note: "Pending post-action verification",
  };
  inc.postActionChecks.push(check);
}

function improved(before: number | null, after: number | null, frac = 0.1): boolean {
  if (before === null || after === null) return false;
  return after <= before * (1 - frac);
}

/** Scenario-specific success criteria for each action; documented in docs/METHODOLOGY.md. */
function evaluateCheck(state: SimState, check: PostActionCheck, target: EntityId | null) {
  const after = verificationMetrics(state, target);
  check.after = after;
  const b = check.before;
  const pressureThreshold = state.config.monitoring.gatewayPressureUtilisation;
  switch (check.actionId) {
    case "cap_partner_concurrency": {
      const wasPressure =
        (b.partnerPoolUtilisation ?? 0) >= pressureThreshold ||
        (b.othersMaxP95Ms ?? 0) > state.config.monitoring.degradedP95Ms ||
        (b.retailP95Ms ?? 0) > state.config.baseline.retailTargetP95Ms * state.config.monitoring.retailAtRiskFraction;
      const better = improved(b.othersMaxP95Ms, after.othersMaxP95Ms) || improved(b.retailP95Ms, after.retailP95Ms) || (b.partnerPoolUtilisation ?? 0) - (after.partnerPoolUtilisation ?? 0) >= 0.1;
      check.effective = wasPressure ? better : false;
      check.note = wasPressure
        ? better
          ? "Protection improved: other partners / retail / shared pool recovered after cap"
          : "Cap applied but shared-resource metrics did not improve"
        : "Unnecessary: no shared-resource pressure was present when the cap executed (other partners and retail were already healthy)";
      break;
    }
    case "apply_rate_limit": {
      const better = improved(b.targetP95Ms, after.targetP95Ms) || improved(b.targetErrorRate, after.targetErrorRate, 0.25) || improved(b.partnerPoolUtilisation, after.partnerPoolUtilisation);
      check.effective = better;
      check.note = better ? "Partner latency / backend errors fell after rate limiting" : "Rate limit did not improve partner latency or errors";
      break;
    }
    case "scale_gateway_capacity": {
      const wasSaturated = (b.utilisation ?? 0) >= pressureThreshold || (b.pressure ?? 0) >= 1;
      const better = improved(b.retailP95Ms, after.retailP95Ms) || improved(b.othersMaxP95Ms, after.othersMaxP95Ms) || (b.utilisation ?? 0) - (after.utilisation ?? 0) >= 0.08;
      check.effective = wasSaturated && better;
      check.note = !wasSaturated
        ? `Unnecessary: shared capacity was not the bottleneck (utilisation ${((b.utilisation ?? 0) * 100).toFixed(0)}%). Added capacity cannot reduce downstream partner latency.`
        : better
          ? "Additional capacity relieved shared-pool pressure"
          : "Capacity added but latency did not improve";
      break;
    }
    case "escalate_to_partner": {
      const ok = (after.targetHealthyStreak ?? 0) > 0;
      check.effective = ok;
      check.note = ok ? "Partner recovered after modelled remediation" : "Partner not recovered within the evaluation horizon";
      break;
    }
    case "reserve_retail_capacity": {
      const ok = improved(b.retailP95Ms, after.retailP95Ms) || (after.retailP95Ms ?? Infinity) <= state.config.baseline.retailTargetP95Ms * state.config.monitoring.retailAtRiskFraction;
      check.effective = ok;
      check.note = ok ? "Retail latency improved / within target" : "Retail latency did not improve";
      break;
    }
    case "release_temporary_controls": {
      const ok = (after.targetHealthyStreak ?? 0) > 0;
      check.effective = ok;
      check.note = ok ? "Partner remained healthy after controls released" : "Partner relapsed after release";
      break;
    }
    default:
      check.effective = null;
      check.note = "Non-intervention action; no effect expected";
  }
}

/** Runs at the start of every tick, before telemetry is computed. */
export function processScheduled(state: SimState): void {
  const t = state.tick;
  for (const run of state.scenarioRuns) {
    for (const p of run.perturbations) {
      if (p.remediationAt === t && p.endAt === null) {
        p.endAt = t;
        p.endReason = "remediated";
        const inc = state.incidents.find((i) => i.scenarioRunIds.includes(run.id) && i.status !== "resolved");
        pushEvent(state, "partner_remediation_completed", `${ENTITY_PROFILES[p.entity].name} downstream remediation completed (simulated); metrics ramping back to baseline`, {
          incidentId: inc?.id ?? null,
          entityId: p.entity,
        });
      }
    }
  }
  for (const inc of state.incidents) {
    for (const rec of inc.recommendations) {
      if (rec.approval === "approved" && rec.scheduledExecutionAt === t && rec.executedAt === null) {
        executeAction(state, inc, rec, rec.decidedBy ?? "system");
      }
    }
    for (const check of inc.postActionChecks) {
      if (check.after === null && check.evaluateAt === t) {
        const rec = inc.recommendations.find((r) => r.id === check.recommendationId);
        evaluateCheck(state, check, rec?.targetEntityId ?? null);
        pushEvent(state, "action_verified", `Post-action check (${ACTIONS[check.actionId]?.label ?? check.actionId}): ${check.note}`, {
          incidentId: inc.id,
          entityId: rec?.targetEntityId ?? null,
          data: { effective: check.effective },
        });
      }
    }
  }
}
