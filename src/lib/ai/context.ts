import { ACTIONS } from "../sim/actions";
import { effectiveLimit, ENTITY_PROFILES } from "../sim/config";
import { findIncident, latest, latestGateway, windowOf } from "../sim/engine";
import { q } from "../sim/math";
import type { EntityId, SimState, TimelineKind } from "../sim/types";
import { ENTITY_IDS, isPartnerId } from "../sim/types";

/**
 * Compact, telemetry-only context shared by the LLM and the rule-based
 * investigator. It deliberately EXCLUDES scenario names, scenario triggers and
 * ground-truth causes so investigators must reason from evidence.
 */
export interface EntityContext {
  id: EntityId;
  name: string;
  segment: string;
  status: string;
  breaker: string;
  concurrencyLimit: number | null;
  rateLimitRps: number | null;
  now: {
    requestRateRps: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    errorRatePct: number;
    timeoutRatePct: number;
    upstreamErrorRatePct: number;
    rejectedByControlsPct: number;
    throttledPct: number;
    successRatePct: number;
    inFlight: number;
    gatewayQueueDelayMs: number;
  };
  baseline: { requestRateRps: number; p95Ms: number };
  ratiosToBaseline: { requestRatePeak: number; requestRateNow: number; p95Peak: number | null };
  last60s: {
    peakP95Ms: number | null;
    peakRequestRateRps: number;
    peakInFlight: number;
    maxUpstreamErrorRatePct: number;
    maxTimeoutRatePct: number;
    secondsNotHealthy: number;
  };
  p95TrendMs: (number | null)[];
}

export interface IncidentContext {
  dataNotice: string;
  generatedAtSimSecond: number;
  incident: {
    id: string;
    status: string;
    severity: string;
    primaryEntityId: EntityId;
    affectedEntityIds: EntityId[];
    detectedAtSimSecond: number;
    secondsSinceDetection: number;
    retailBreachSeconds: number;
  } | null;
  thresholds: {
    degradedP95Ms: number;
    degradedErrorRatePct: number;
    retailTargetP95Ms: number;
    retailAtRiskP95Ms: number;
    gatewayPressureUtilisationPct: number;
    breaker: { windowSeconds: number; failureOrSlowRatePct: number; slowCallThresholdMs: number; openSeconds: number; halfOpenSeconds: number };
  };
  gateway: {
    capacitySlots: number;
    utilisationPct: number;
    demandPressurePct: number;
    partnerPoolUtilisationPct: number;
    retailPoolUtilisationPct: number;
    peakUtilisationLast60sPct: number;
    platformP95Ms: number | null;
    platformErrorRatePct: number;
    retailHealth: string;
    controls: { perPartnerIsolation: boolean; perPartnerLimit: number; timeoutMs: number; circuitBreakers: boolean; retailReservationEnabled: boolean; retailReservationSlots: number };
  };
  entities: EntityContext[];
  recentEvents: { simSecond: number; kind: TimelineKind; entityId: EntityId | null; message: string }[];
  priorInvestigations: { id: string; source: string; summary: string; topCause: string }[];
  priorActions: { actionId: string; targetEntityId: EntityId | null; approval: string; executedAtSimSecond: number | null; outcome: string | null; verification: string | null }[];
  availableActions: { id: string; label: string; description: string; requiresPartnerTarget: boolean }[];
}

const HIDDEN_EVENT_KINDS: TimelineKind[] = ["scenario_triggered", "scenario_stopped", "recovery_triggered"];
const pct = (x: number) => q(x * 100, 2);

export function buildIncidentContext(state: SimState, incidentId: string | null): IncidentContext {
  const t = state.tick;
  const from = t - 60;
  const cfg = state.config;
  const inc = incidentId ? findIncident(state, incidentId) : null;
  const g = latestGateway(state);
  const gwWin = windowOf(state.history.gateway, from);

  const entities: EntityContext[] = ENTITY_IDS.map((id) => {
    const s = latest(state, id);
    const win = windowOf(state.history.entities[id], from);
    const isRetail = id === "retail";
    const baseRps = isRetail ? cfg.baseline.retailRps : cfg.baseline.partnerRps;
    const baseP95 = isRetail ? cfg.baseline.retailP95Ms : cfg.baseline.partnerP95Ms;
    const p95s = win.map((x) => x.p95Ms).filter((x): x is number => x !== null);
    const peakP95 = p95s.length ? Math.max(...p95s) : null;
    const peakRps = Math.max(0, ...win.map((x) => x.offeredRps));
    const trend: (number | null)[] = [];
    for (let k = 60; k >= 0; k -= 10) {
      const point = state.history.entities[id].find((x) => x.t === t - 1 - k);
      if (point) trend.push(point.p95Ms);
    }
    return {
      id,
      name: ENTITY_PROFILES[id].name,
      segment: ENTITY_PROFILES[id].segment,
      status: s?.status ?? "unknown",
      breaker: isRetail ? "not_applicable" : s?.breaker ?? "closed",
      concurrencyLimit: isPartnerId(id) ? effectiveLimit(state.controls, id) : null,
      rateLimitRps: isPartnerId(id) ? state.controls.rateLimits[id] ?? null : null,
      now: {
        requestRateRps: s?.offeredRps ?? 0,
        p50Ms: s?.p50Ms ?? null,
        p95Ms: s?.p95Ms ?? null,
        p99Ms: s?.p99Ms ?? null,
        errorRatePct: pct(s?.errorRate ?? 0),
        timeoutRatePct: pct(s?.timeoutRate ?? 0),
        upstreamErrorRatePct: pct(s?.upstreamErrorRate ?? 0),
        rejectedByControlsPct: pct(s?.rejectedRate ?? 0),
        throttledPct: pct(s?.throttledRate ?? 0),
        successRatePct: pct(s?.successRate ?? 0),
        inFlight: s?.inFlight ?? 0,
        gatewayQueueDelayMs: s?.queueDelayMs ?? 0,
      },
      baseline: { requestRateRps: baseRps, p95Ms: baseP95 },
      ratiosToBaseline: {
        requestRatePeak: q(peakRps / baseRps, 2),
        requestRateNow: q((s?.offeredRps ?? 0) / baseRps, 2),
        p95Peak: peakP95 === null ? null : q(peakP95 / baseP95, 1),
      },
      last60s: {
        peakP95Ms: peakP95,
        peakRequestRateRps: q(peakRps, 1),
        peakInFlight: q(Math.max(0, ...win.map((x) => x.inFlight)), 1),
        maxUpstreamErrorRatePct: pct(Math.max(0, ...win.map((x) => x.upstreamErrorRate))),
        maxTimeoutRatePct: pct(Math.max(0, ...win.map((x) => x.timeoutRate))),
        secondsNotHealthy: win.filter((x) => x.status !== "healthy").length,
      },
      p95TrendMs: trend,
    };
  });

  const events = state.timeline
    .filter((e) => !HIDDEN_EVENT_KINDS.includes(e.kind))
    .filter((e) => !inc || e.incidentId === inc.id || e.incidentId === null || inc.affectedEntityIds.includes(e.entityId as EntityId))
    .slice(-25)
    .map((e) => ({ simSecond: e.t, kind: e.kind, entityId: e.entityId, message: e.message.slice(0, 200) }));

  return {
    dataNotice: "SIMULATED telemetry from a synthetic BaaS gateway model. Not real banking data. Latency in ms, rates in percent, 1 sim second = 1 tick.",
    generatedAtSimSecond: t,
    incident: inc
      ? {
          id: inc.id,
          status: inc.status,
          severity: inc.severity,
          primaryEntityId: inc.primaryEntityId,
          affectedEntityIds: inc.affectedEntityIds,
          detectedAtSimSecond: inc.detectedAt,
          secondsSinceDetection: t - inc.detectedAt,
          retailBreachSeconds: inc.retailBreachSeconds,
        }
      : null,
    thresholds: {
      degradedP95Ms: cfg.monitoring.degradedP95Ms,
      degradedErrorRatePct: pct(cfg.monitoring.degradedErrorRate),
      retailTargetP95Ms: cfg.baseline.retailTargetP95Ms,
      retailAtRiskP95Ms: q(cfg.baseline.retailTargetP95Ms * cfg.monitoring.retailAtRiskFraction, 1),
      gatewayPressureUtilisationPct: pct(cfg.monitoring.gatewayPressureUtilisation),
      breaker: {
        windowSeconds: cfg.breaker.windowSeconds,
        failureOrSlowRatePct: pct(cfg.breaker.failureRateThreshold),
        slowCallThresholdMs: cfg.breaker.slowCallThresholdMs,
        openSeconds: cfg.breaker.openSeconds,
        halfOpenSeconds: cfg.breaker.halfOpenSeconds,
      },
    },
    gateway: {
      capacitySlots: g?.capacitySlots ?? cfg.gatewayCapacitySlots,
      utilisationPct: pct(g?.utilisation ?? 0),
      demandPressurePct: pct(g?.pressure ?? 0),
      partnerPoolUtilisationPct: pct(g?.partnerPoolUtilisation ?? 0),
      retailPoolUtilisationPct: pct(g?.retailPoolUtilisation ?? 0),
      peakUtilisationLast60sPct: pct(Math.max(0, ...gwWin.map((x) => x.utilisation))),
      platformP95Ms: g?.platformP95Ms ?? null,
      platformErrorRatePct: pct(g?.platformErrorRate ?? 0),
      retailHealth: g?.retailHealth ?? "healthy",
      controls: {
        perPartnerIsolation: state.controls.isolationEnabled,
        perPartnerLimit: state.controls.perPartnerLimit,
        timeoutMs: state.controls.timeoutMs,
        circuitBreakers: state.controls.breakerEnabled,
        retailReservationEnabled: state.controls.retailReservationEnabled,
        retailReservationSlots: state.controls.retailReservationSlots,
      },
    },
    entities,
    recentEvents: events,
    priorInvestigations: (inc?.investigations ?? []).slice(-3).map((iv) => ({
      id: iv.id,
      source: iv.source,
      summary: iv.diagnosis.summary.slice(0, 200),
      topCause: iv.diagnosis.likelyCauses[0]?.category ?? "unknown",
    })),
    priorActions: (inc?.recommendations ?? [])
      .filter((r) => r.approval !== "superseded")
      .slice(-6)
      .map((r) => ({
        actionId: r.actionId,
        targetEntityId: r.targetEntityId,
        approval: r.approval,
        executedAtSimSecond: r.executedAt,
        outcome: r.executionOutcome,
        verification: inc?.postActionChecks.find((c) => c.recommendationId === r.id)?.note ?? null,
      })),
    availableActions: Object.values(ACTIONS).map((a) => ({ id: a.id, label: a.label, description: a.description, requiresPartnerTarget: a.target === "partner" })),
  };
}
