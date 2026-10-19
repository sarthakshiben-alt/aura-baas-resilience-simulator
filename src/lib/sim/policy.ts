import { effectiveLimit, ENTITY_PROFILES } from "./config";
import { windowOf } from "./engine";
import { getAction } from "./actions";
import type { EntityId, Incident, PolicyResult, SimState } from "./types";
import { isEntityId, isPartnerId } from "./types";

export const POLICY_LOOKBACK_SECONDS = 60;

/**
 * Deterministic policy validation. Rules are documented in docs/METHODOLOGY.md.
 * This runs on proposal AND again at approval time, so a recommendation that
 * was valid when proposed can still be refused if conditions changed.
 */
export function validateAction(
  state: SimState,
  incident: Incident | null,
  actionId: string,
  rawTarget: string | null | undefined,
): PolicyResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const reject = (r: string): PolicyResult => ({ status: "rejected", reasons: [...reasons, r], warnings });

  const def = getAction(actionId);
  if (!def) return reject(`Unknown action identifier "${String(actionId).slice(0, 64)}". Only predefined simulated actions can be executed.`);
  if (!incident) return reject("No incident is associated with this recommendation.");
  if (incident.status === "resolved") return reject(`Incident ${incident.id} is already resolved; actions cannot modify a closed incident.`);

  let target: EntityId | null = null;
  if (def.target === "partner") {
    if (!rawTarget || !isEntityId(rawTarget)) return reject(`Action "${def.label}" requires a partner target.`);
    if (rawTarget === "retail") return reject("Retail banking is a protected service; partner controls cannot be applied to it.");
    if (!isPartnerId(rawTarget)) return reject("Invalid target.");
    target = rawTarget;
    if (!incident.affectedEntityIds.includes(target)) {
      return reject(`${ENTITY_PROFILES[target].name} is not implicated in ${incident.id}; the policy only allows actions on affected services.`);
    }
  }

  const from = state.tick - POLICY_LOOKBACK_SECONDS;
  const c = state.controls;
  const m = state.config.monitoring;
  const gw = windowOf(state.history.gateway, from);
  const peakPartnerPool = Math.max(0, ...gw.map((g) => g.partnerPoolUtilisation));
  const peakUtil = Math.max(0, ...gw.map((g) => g.utilisation));
  const peakPressure = Math.max(0, ...gw.map((g) => g.pressure));

  switch (actionId) {
    case "cap_partner_concurrency": {
      const p = target as Exclude<EntityId, "retail">;
      const current = effectiveLimit(c, p);
      const cap = state.config.actions.predefinedConcurrencyCap;
      if (current !== null && cap >= current) return reject(`Cap ${cap} would not tighten the current limit (${current}).`);
      const hist = windowOf(state.history.entities[p], from);
      const peakInFlight = Math.max(0, ...hist.map((s) => s.inFlight));
      const ref = current ?? state.controls.perPartnerLimit;
      if (peakInFlight < 0.5 * ref && peakPartnerPool < m.gatewayPressureUtilisation) {
        return reject(
          `No concurrency-pressure evidence in the last ${POLICY_LOOKBACK_SECONDS}s (peak in-flight ${peakInFlight.toFixed(0)} vs limit ${ref}; partner pool peak ${(peakPartnerPool * 100).toFixed(0)}%). A cap would reject legitimate traffic.`,
        );
      }
      warnings.push("Rejected partner requests are simulated HTTP 503s; no transaction outcome is modelled.");
      break;
    }
    case "apply_rate_limit": {
      const p = target as Exclude<EntityId, "retail">;
      const hist = windowOf(state.history.entities[p], from);
      const peakRps = Math.max(0, ...hist.map((s) => s.offeredRps));
      const base = state.config.baseline.partnerRps;
      if (peakRps < 1.3 * base) {
        return reject(
          `Request rate has not exceeded 1.3× baseline in the last ${POLICY_LOOKBACK_SECONDS}s (peak ${peakRps.toFixed(0)} rps vs baseline ${base}). Rate limiting would discard legitimate requests.`,
        );
      }
      if (c.rateLimits[p] !== undefined) return reject("A rate limit is already active for this partner.");
      warnings.push("Throttled requests receive simulated HTTP 429; retry semantics are not modelled.");
      break;
    }
    case "maintain_circuit_breaker": {
      const p = target as Exclude<EntityId, "retail">;
      if (!c.breakerEnabled) return reject("Circuit breakers are disabled in the current configuration; there is no breaker to maintain.");
      if (state.runtime[p].breaker.state === "closed") warnings.push("Breaker is currently closed; this records a decision only.");
      break;
    }
    case "escalate_to_partner":
      break;
    case "scale_gateway_capacity": {
      const capNow = state.config.gatewayCapacitySlots + c.extraCapacitySlots;
      if (capNow >= state.config.actions.maxCapacitySlots) return reject(`Gateway already at the bounded maximum of ${state.config.actions.maxCapacitySlots} slots.`);
      warnings.push("Adds illustrative cost. Extra capacity does not reduce a partner's downstream latency.");
      if (peakUtil < m.gatewayPressureUtilisation && peakPressure < 1) {
        warnings.push(`Shared utilisation peaked at ${(peakUtil * 100).toFixed(0)}% in the last ${POLICY_LOOKBACK_SECONDS}s; capacity may not be the bottleneck.`);
      }
      break;
    }
    case "reserve_retail_capacity": {
      if (c.retailReservationEnabled && c.retailReservationSlots >= state.config.actions.maxRetailReservationSlots) {
        return reject("Retail reservation is already at its bounded maximum.");
      }
      break;
    }
    case "release_temporary_controls": {
      const p = target as Exclude<EntityId, "retail">;
      if (c.caps[p] === undefined && c.rateLimits[p] === undefined) return reject("No temporary controls are active for this partner.");
      if (state.runtime[p].healthyStreak < m.verificationWindowSeconds) {
        return reject(`Partner must be healthy for ${m.verificationWindowSeconds}s before controls are released (currently ${state.runtime[p].healthyStreak}s).`);
      }
      break;
    }
    case "escalate_to_operator":
    case "no_action":
      break;
  }

  return { status: warnings.length ? "valid_with_warnings" : "valid", reasons: reasons.length ? reasons : ["Predefined action; preconditions satisfied."], warnings };
}
