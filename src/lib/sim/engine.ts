import { cloneConfig, cloneControls, DEFAULT_CONFIG, effectiveLimit, ENTITY_PROFILES, PROTECTED_CONTROLS } from "./config";
import {
  lnQuantile,
  lnSurvival,
  lnTruncatedMean,
  lognormalFromP95,
  mixtureQuantile,
  noise,
  q,
  Z95,
  Z99,
  type LogNormal,
} from "./math";
import type {
  Controls,
  EntityId,
  EntityRuntime,
  EntitySample,
  GatewayProtectionStatus,
  GatewaySample,
  HealthStatus,
  Incident,
  PartnerId,
  PerturbationRuntime,
  RetailHealth,
  Severity,
  SimConfig,
  SimState,
  TimelineEvent,
  TimelineKind,
} from "./types";
import { ENTITY_IDS, PARTNER_IDS } from "./types";
import { processScheduled } from "./actions";

export interface CreateStateOptions {
  seed?: number;
  config?: SimConfig;
  controls?: Controls;
}

export function createInitialState(opts: CreateStateOptions = {}): SimState {
  const config = cloneConfig(opts.config ?? DEFAULT_CONFIG);
  const runtime = {} as Record<EntityId, EntityRuntime>;
  const entities = {} as Record<EntityId, EntitySample[]>;
  for (const id of ENTITY_IDS) {
    runtime[id] = {
      anomalyStreak: 0,
      healthyStreak: config.monitoring.verificationWindowSeconds,
      lastStatus: "healthy",
      breaker: { state: "closed", window: [], openedAt: null, halfOpenAt: null, probePassed: 0, probeBad: 0 },
    };
    entities[id] = [];
  }
  return {
    version: 1,
    seed: (opts.seed ?? 42) | 0,
    tick: 0,
    config,
    controls: cloneControls(opts.controls ?? PROTECTED_CONTROLS),
    runtime,
    queueDelayMs: { partnerPool: 0, retailPool: 0 },
    scenarioRuns: [],
    incidents: [],
    timeline: [],
    history: { entities, gateway: [] },
    counters: { incident: 0, event: 0, scenarioRun: 0, audit: 0 },
    simulatedCostUsd: 0,
    appliedEntryIds: [],
  };
}

export function pushEvent(
  state: SimState,
  kind: TimelineKind,
  message: string,
  extra: { t?: number; incidentId?: string | null; entityId?: EntityId | null; data?: TimelineEvent["data"] } = {},
): TimelineEvent {
  state.counters.event += 1;
  const ev: TimelineEvent = {
    seq: state.counters.event,
    t: extra.t ?? state.tick,
    kind,
    incidentId: extra.incidentId ?? null,
    entityId: extra.entityId ?? null,
    message,
    ...(extra.data ? { data: extra.data } : {}),
  };
  state.timeline.push(ev);
  return ev;
}

// ---------------------------------------------------------------- perturbations

function interp(a: number, b: number, frac: number, additive: boolean): number {
  if (additive) return a + (b - a) * frac;
  const la = Math.log(Math.max(a, 1e-6));
  const lb = Math.log(Math.max(b, 1e-6));
  return Math.exp(la + (lb - la) * frac);
}

export function perturbationEnd(p: PerturbationRuntime): number {
  return Math.min(p.endAt ?? Infinity, p.plannedEndAt ?? Infinity);
}

export function perturbationValue(p: PerturbationRuntime, t: number): number {
  const additive = p.channel === "errors";
  const neutral = additive ? 0 : 1;
  const ramp = (x: number) => {
    const r = x - p.startAt;
    if (r < 0) return neutral;
    const frac = p.rampUpSeconds > 0 ? Math.min(1, (r + 1) / p.rampUpSeconds) : 1;
    return interp(neutral, p.peak, frac, additive);
  };
  const end = perturbationEnd(p);
  if (t < end) return ramp(t);
  const vEnd = ramp(end - 1);
  const frac = p.rampDownSeconds > 0 ? Math.min(1, (t - end + 1) / p.rampDownSeconds) : 1;
  return interp(vEnd, neutral, frac, additive);
}

export function perturbationFinished(p: PerturbationRuntime, t: number): boolean {
  const end = perturbationEnd(p);
  return Number.isFinite(end) && t >= end + p.rampDownSeconds;
}

function aggregatePerturbations(state: SimState, entity: EntityId, t: number) {
  let demand = 1;
  let latency = 1;
  let errors = 0;
  for (const run of state.scenarioRuns) {
    for (const p of run.perturbations) {
      if (p.entity !== entity) continue;
      const v = perturbationValue(p, t);
      if (p.channel === "demand") demand *= v;
      else if (p.channel === "latency") latency *= v;
      else errors += v;
    }
  }
  return { demand, latency, errors };
}

// ---------------------------------------------------------------- telemetry

export function queueDelayTarget(u: number): number {
  if (u <= 0.7) return 0;
  if (u <= 1) return 400 * ((u - 0.7) / 0.3) ** 2;
  return Math.min(6000, 400 + 1600 * (u - 1));
}

interface Working {
  id: EntityId;
  isRetail: boolean;
  offered: number;
  admitted: number;
  throttled: number;
  passed: number;
  cbRejected: number;
  d: LogNormal;
  c: number;
  timeoutFrac: number;
  slowFrac: number;
  dsErr: number;
  demandInFlight: number;
  allowed: number;
  limit: number | null;
}

function computeTick(state: SimState) {
  const { config, controls } = state;
  const B = config.baseline;
  const t = state.tick;
  const T = controls.timeoutMs;
  const work: Working[] = [];

  ENTITY_IDS.forEach((id, i) => {
    const isRetail = id === "retail";
    const pert = aggregatePerturbations(state, id, t);
    const baseRps = isRetail ? B.retailRps : B.partnerRps;
    const baseP95 = isRetail ? B.retailP95Ms : B.partnerP95Ms;
    const baseErr = isRetail ? B.retailErrorRate : B.partnerErrorRate;
    const offered = q(baseRps * pert.demand * (1 + 0.02 * noise(state.seed, t, i, 0)), 2);
    const rl = isRetail ? undefined : controls.rateLimits[id as PartnerId];
    const admitted = rl !== undefined ? Math.min(offered, rl) : offered;
    const throttled = offered - admitted;
    const br = state.runtime[id].breaker;
    const breakerActive = !isRetail && controls.breakerEnabled;
    const passFrac = !breakerActive || br.state === "closed" ? 1 : br.state === "open" ? 0 : config.breaker.halfOpenProbeFraction;
    const passed = admitted * passFrac;
    const cbRejected = admitted - passed;
    const overload = isRetail ? 0 : Math.max(0, passed / B.partnerBackendCapacityRps - 1);
    const dsP95 = q(
      Math.max(1, baseP95 - B.gatewayOverheadMs) * pert.latency * (1 + 2 * overload) * (1 + 0.03 * noise(state.seed, t, i, 1)),
      2,
    );
    const dsErr = Math.min(1, Math.max(0, baseErr + pert.errors + 0.3 * overload));
    const d = lognormalFromP95(dsP95, B.latencySigma);
    const queue = isRetail ? state.queueDelayMs.retailPool : state.queueDelayMs.partnerPool;
    const c = B.gatewayOverheadMs + queue;
    const kEff = T - c;
    const timeoutFrac = kEff > 0 ? lnSurvival(d, kEff) : 1;
    const slowK = config.breaker.slowCallThresholdMs - c;
    const slowFrac = slowK > 0 ? lnSurvival(d, slowK) : 1;
    // Worker slots are held during service only; queue wait adds latency (and
    // timeouts) but does not occupy a slot. This keeps the model stable.
    const slotHoldMs = B.gatewayOverheadMs + (kEff > 0 ? lnTruncatedMean(d, kEff) : 0);
    const demandInFlight = q((passed * slotHoldMs) / 1000, 3);
    const limit = isRetail ? null : effectiveLimit(controls, id as PartnerId);
    const allowed = limit === null ? demandInFlight : Math.min(demandInFlight, limit);
    work.push({ id, isRetail, offered, admitted, throttled, passed, cbRejected, d, c, timeoutFrac, slowFrac, dsErr, demandInFlight, allowed, limit });
  });

  // Shared gateway pool allocation.
  const capacity = config.gatewayCapacitySlots + controls.extraCapacitySlots;
  const partners = work.filter((w) => !w.isRetail);
  const retail = work.find((w) => w.isRetail)!;
  const partnerDemand = partners.reduce((s, w) => s + w.allowed, 0);
  let pScale: number;
  let rScale: number;
  let partnerUtilDemand: number;
  let retailUtilDemand: number;
  let partnerPoolUtil: number;
  let retailPoolUtil: number;
  if (controls.retailReservationEnabled) {
    const R = Math.min(controls.retailReservationSlots, capacity);
    const partnerPool = Math.max(1, capacity - R);
    pScale = partnerDemand > partnerPool ? partnerPool / partnerDemand : 1;
    const partnerAlloc = partnerDemand * pScale;
    const retailCap = Math.max(1, R + Math.max(0, partnerPool - partnerAlloc));
    rScale = retail.allowed > retailCap ? retailCap / retail.allowed : 1;
    partnerUtilDemand = partnerDemand / partnerPool;
    retailUtilDemand = retail.allowed / retailCap;
    partnerPoolUtil = partnerAlloc / partnerPool;
    retailPoolUtil = (retail.allowed * rScale) / retailCap;
  } else {
    const total = partnerDemand + retail.allowed;
    const s = total > capacity ? capacity / total : 1;
    pScale = s;
    rScale = s;
    partnerUtilDemand = total / capacity;
    retailUtilDemand = total / capacity;
    partnerPoolUtil = Math.min(1, total / capacity);
    retailPoolUtil = partnerPoolUtil;
  }

  const prevQueue = { ...state.queueDelayMs };
  state.queueDelayMs = {
    partnerPool: q(prevQueue.partnerPool + 0.5 * (queueDelayTarget(partnerUtilDemand) - prevQueue.partnerPool), 2),
    retailPool: q(prevQueue.retailPool + 0.5 * (queueDelayTarget(retailUtilDemand) - prevQueue.retailPool), 2),
  };

  const samples = {} as Record<EntityId, EntitySample>;
  const breakerStats = {} as Record<EntityId, { served: number; bad: number }>;
  const protectionRejectFrac = {} as Record<EntityId, number>;
  const mixture: { w: number; c: number; d: LogNormal; cap: number }[] = [];
  let allocated = 0;
  let totalOffered = 0;
  let totalFailures = 0;

  for (const w of work) {
    const scale = w.isRetail ? rScale : pScale;
    const inFlight = w.allowed * scale;
    allocated += inFlight;
    const limitFrac = w.demandInFlight > 0 ? w.allowed / w.demandInFlight : 1;
    const slotted = w.passed * limitFrac * scale;
    const limitRejected = w.passed * (1 - limitFrac);
    const poolRejected = w.passed * limitFrac * (1 - scale);
    const timeouts = slotted * w.timeoutFrac;
    const upstreamErrors = slotted * (1 - w.timeoutFrac) * w.dsErr;
    const successful = slotted * (1 - w.timeoutFrac) * (1 - w.dsErr);
    const failures = w.admitted - successful;
    const off = w.offered > 0 ? w.offered : 1;
    totalOffered += w.offered;
    totalFailures += failures;
    const lat = (z: number) => (slotted < 0.01 ? null : q(Math.min(T, w.c + lnQuantile(w.d, z)), 1));
    const slowOrTimeout = Math.max(w.slowFrac, w.timeoutFrac);
    breakerStats[w.id] = { served: slotted, bad: slotted * Math.min(1, slowOrTimeout + w.dsErr * (1 - slowOrTimeout)) };
    protectionRejectFrac[w.id] = (w.cbRejected + limitRejected + w.throttled) / off;
    if (slotted > 0.01) mixture.push({ w: slotted, c: w.c, d: w.d, cap: T });
    samples[w.id] = {
      t,
      id: w.id,
      offeredRps: q(w.offered, 2),
      servedRps: q(successful, 2),
      throttledRps: q(w.throttled, 2),
      rejectedRps: q(w.cbRejected + limitRejected + poolRejected, 2),
      p50Ms: lat(0),
      p95Ms: lat(Z95),
      p99Ms: lat(Z99),
      errorRate: q(failures / off, 5),
      timeoutRate: q(timeouts / off, 5),
      upstreamErrorRate: q(upstreamErrors / off, 5),
      rejectedRate: q((w.cbRejected + limitRejected + poolRejected) / off, 5),
      throttledRate: q(w.throttled / off, 5),
      successRate: q(successful / off, 5),
      inFlight: q(inFlight, 2),
      concurrencyLimit: w.limit,
      breaker: state.runtime[w.id].breaker.state,
      status: "healthy",
      queueDelayMs: q(w.c - config.baseline.gatewayOverheadMs, 1),
    };
  }

  const platformP95 = mixtureQuantile(mixture, 0.95);
  const utilisation = allocated / capacity;
  const pressure = (partnerDemand + retail.allowed) / capacity;
  return {
    samples,
    breakerStats,
    protectionRejectFrac,
    gateway: {
      capacity,
      allocated,
      utilisation,
      pressure,
      partnerPoolUtil,
      retailPoolUtil,
      totalOffered,
      platformP95: platformP95 === null ? null : q(platformP95, 1),
      platformErrorRate: totalOffered > 0 ? totalFailures / totalOffered : 0,
    },
  };
}

// ---------------------------------------------------------------- breaker

function updateBreaker(state: SimState, id: PartnerId, stats: { served: number; bad: number }) {
  const cfg = state.config.breaker;
  const rt = state.runtime[id];
  const br = rt.breaker;
  const t = state.tick;
  if (!state.controls.breakerEnabled) {
    if (br.state !== "closed") {
      br.state = "closed";
      pushEvent(state, "breaker_closed", `${ENTITY_PROFILES[id].name} circuit breaker disabled by configuration`, { entityId: id });
    }
    br.window = [];
    return;
  }
  if (br.state === "closed") {
    br.window.push({ passed: stats.served, bad: stats.bad });
    if (br.window.length > cfg.windowSeconds) br.window.shift();
    const passed = br.window.reduce((s, w) => s + w.passed, 0);
    const bad = br.window.reduce((s, w) => s + w.bad, 0);
    if (passed >= cfg.minRequests && bad / passed >= cfg.failureRateThreshold) {
      br.state = "open";
      br.openedAt = t;
      br.window = [];
      pushEvent(state, "breaker_opened", `${ENTITY_PROFILES[id].name} circuit breaker OPEN (failed/slow calls ${(100 * bad / passed).toFixed(0)}% ≥ ${(cfg.failureRateThreshold * 100).toFixed(0)}% over ${cfg.windowSeconds}s)`, {
        entityId: id,
        data: { badRate: q(bad / passed, 3) },
      });
    }
  } else if (br.state === "open") {
    if (br.openedAt !== null && t - br.openedAt >= cfg.openSeconds) {
      br.state = "half_open";
      br.halfOpenAt = t;
      br.probePassed = 0;
      br.probeBad = 0;
      pushEvent(state, "breaker_half_open", `${ENTITY_PROFILES[id].name} circuit breaker HALF-OPEN (probing ${(cfg.halfOpenProbeFraction * 100).toFixed(0)}% of traffic)`, { entityId: id });
    }
  } else {
    br.probePassed += stats.served;
    br.probeBad += stats.bad;
    if (br.halfOpenAt !== null && t - br.halfOpenAt >= cfg.halfOpenSeconds) {
      const rate = br.probePassed >= 1 ? br.probeBad / br.probePassed : 1;
      if (rate < cfg.failureRateThreshold) {
        br.state = "closed";
        br.window = [];
        pushEvent(state, "breaker_closed", `${ENTITY_PROFILES[id].name} circuit breaker CLOSED (probe failure/slow rate ${(rate * 100).toFixed(0)}%)`, { entityId: id });
      } else {
        br.state = "open";
        br.openedAt = t;
        pushEvent(state, "breaker_opened", `${ENTITY_PROFILES[id].name} circuit breaker re-OPENED (probe failure/slow rate ${(rate * 100).toFixed(0)}%)`, { entityId: id });
      }
    }
  }
}

// ---------------------------------------------------------------- monitoring

export function retailHealthOf(state: SimState, s: EntitySample): RetailHealth {
  const target = state.config.baseline.retailTargetP95Ms;
  const p95 = s.p95Ms ?? 0;
  if (p95 > target) return "breach";
  if (p95 > state.config.monitoring.retailAtRiskFraction * target || s.errorRate > state.config.monitoring.retailAtRiskErrorRate) return "at_risk";
  return "healthy";
}

/** True when the entity's telemetry is within healthy thresholds (ignores incident context). */
function meetsHealthy(state: SimState, s: EntitySample, protectionReject: number): boolean {
  const m = state.config.monitoring;
  if (s.id === "retail") return retailHealthOf(state, s) === "healthy";
  if (s.breaker !== "closed" && state.controls.breakerEnabled) return false;
  if (protectionReject > m.controlRejectionThreshold) return false;
  if (s.successRate < m.unavailableSuccessRate) return false;
  if ((s.p95Ms ?? Infinity) > m.degradedP95Ms) return false;
  return s.errorRate <= m.degradedErrorRate;
}

function classify(state: SimState, s: EntitySample, protectionReject: number, inOpenIncident: boolean, healthyStreak: number): HealthStatus {
  const m = state.config.monitoring;
  if (s.id === "retail") {
    if (retailHealthOf(state, s) !== "healthy") return "degraded";
  } else {
    const breakerActive = state.controls.breakerEnabled && s.breaker !== "closed";
    if (breakerActive || protectionReject > m.controlRejectionThreshold) return "protected";
    if (s.successRate < m.unavailableSuccessRate) return "unavailable";
    if ((s.p95Ms ?? Infinity) > m.degradedP95Ms || s.errorRate > m.degradedErrorRate) return "degraded";
  }
  if (inOpenIncident && healthyStreak < m.verificationWindowSeconds) return "recovering";
  return "healthy";
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function isImpaired(status: HealthStatus) {
  return status === "degraded" || status === "protected" || status === "unavailable";
}

function currentSeverity(inc: Incident, samples: Record<EntityId, EntitySample>, retailHealth: RetailHealth, pressure: number): Severity {
  if (retailHealth === "breach" || pressure >= 1) return "critical";
  const impairedPartners = PARTNER_IDS.filter((p) => isImpaired(samples[p].status));
  if (retailHealth === "at_risk" || impairedPartners.length >= 2 || PARTNER_IDS.some((p) => samples[p].status === "unavailable")) return "high";
  if (inc.affectedEntityIds.some((e) => isImpaired(samples[e].status))) return "medium";
  return "low";
}

function runsAffecting(state: SimState, entity: EntityId, t: number) {
  return state.scenarioRuns.filter((r) => r.perturbations.some((p) => p.entity === entity && !perturbationFinished(p, t) && p.startAt <= t));
}

function openIncidents(state: SimState) {
  return state.incidents.filter((i) => i.status !== "resolved");
}

function monitor(state: SimState, samples: Record<EntityId, EntitySample>, protectionRejectFrac: Record<EntityId, number>, gw: { pressure: number }) {
  const t = state.tick;
  const m = state.config.monitoring;
  const open = openIncidents(state);
  const retailSample = samples.retail;
  const retailHealth = retailHealthOf(state, retailSample);

  // 1. classify + streaks
  for (const id of ENTITY_IDS) {
    const rt = state.runtime[id];
    const s = samples[id];
    const healthyNow = meetsHealthy(state, s, protectionRejectFrac[id]);
    rt.healthyStreak = healthyNow ? rt.healthyStreak + 1 : 0;
    const inOpen = open.some((i) => i.affectedEntityIds.includes(id));
    s.status = classify(state, s, protectionRejectFrac[id], inOpen, rt.healthyStreak);
    const anomalous = id === "retail" ? retailHealth !== "healthy" : isImpaired(s.status);
    rt.anomalyStreak = anomalous ? rt.anomalyStreak + 1 : 0;
    rt.lastStatus = s.status;
  }

  // 2. detection
  for (const id of ENTITY_IDS) {
    const rt = state.runtime[id];
    if (rt.anomalyStreak < m.detectionWindowSeconds) continue;
    const current = openIncidents(state);
    if (current.some((i) => i.affectedEntityIds.includes(id))) continue;
    const runs = runsAffecting(state, id, t);
    const run = runs[runs.length - 1] ?? null;
    let target: Incident | undefined = run ? current.find((i) => i.scenarioRunIds.includes(run.id)) : current[current.length - 1];
    if (!target && run === null && current.length > 0) target = current[current.length - 1];
    if (target) {
      target.affectedEntityIds.push(id);
      target.partnerImpactSeconds[id] = (target.partnerImpactSeconds[id] ?? 0) + m.detectionWindowSeconds - 1;
      if (run && !target.scenarioRunIds.includes(run.id)) {
        target.scenarioRunIds.push(run.id);
        target.scenarioIds.push(run.scenarioId);
      }
      target.recoveryStartedAt = null;
      pushEvent(state, "entity_affected", `${ENTITY_PROFILES[id].name} now affected by ${target.id}`, { incidentId: target.id, entityId: id });
      continue;
    }
    state.counters.incident += 1;
    const incId = `INC-${String(state.counters.incident).padStart(3, "0")}`;
    const runAlreadyResolved = run ? state.incidents.some((i) => i.scenarioRunIds.includes(run.id)) : false;
    const startedAt = run && !runAlreadyResolved ? run.startedAt : t - m.detectionWindowSeconds + 1;
    const inc: Incident = {
      id: incId,
      scenarioRunIds: run ? [run.id] : [],
      scenarioIds: run ? [run.scenarioId] : [],
      primaryEntityId: id,
      affectedEntityIds: [id],
      status: "open",
      severity: "medium",
      peakSeverity: "medium",
      startedAt,
      detectedAt: t,
      investigationRequestedAt: null,
      diagnosedAt: null,
      recommendationAt: null,
      firstDecisionAt: null,
      firstDecisionWallMs: null,
      firstActionExecutedAt: null,
      platformProtectedAt: null,
      recoveryStartedAt: null,
      partnerRecoveredAt: null,
      recoveredAt: null,
      recoveryVerified: false,
      investigationMode: null,
      retailBreachSeconds: 0,
      retailAtRiskSeconds: 0,
      peakRetailP95Ms: 0,
      partnerImpactSeconds: { [id]: m.detectionWindowSeconds - 1 },
      partnerDowntimeSeconds: {},
      investigations: [],
      recommendations: [],
      audit: [],
      postActionChecks: [],
    };
    state.incidents.push(inc);
    const s = samples[id];
    pushEvent(
      state,
      "degradation_detected",
      `${incId} opened: ${ENTITY_PROFILES[id].name} ${id === "retail" ? `retail ${retailHealth.replace("_", " ")}` : s.status} for ${m.detectionWindowSeconds}s (P95 ${s.p95Ms ?? "n/a"} ms, errors ${(s.errorRate * 100).toFixed(1)}%)`,
      { incidentId: incId, entityId: id },
    );
  }

  // 3. per-incident accounting
  for (const inc of openIncidents(state)) {
    const sev = currentSeverity(inc, samples, retailHealth, gw.pressure);
    inc.severity = sev;
    inc.peakSeverity = maxSeverity(inc.peakSeverity, sev);
    if (retailHealth === "breach") inc.retailBreachSeconds += 1;
    else if (retailHealth === "at_risk") inc.retailAtRiskSeconds += 1;
    inc.peakRetailP95Ms = Math.max(inc.peakRetailP95Ms, retailSample.p95Ms ?? 0);
    for (const e of inc.affectedEntityIds) {
      const s = samples[e];
      const impaired = e === "retail" ? retailHealth !== "healthy" : isImpaired(s.status);
      if (impaired) inc.partnerImpactSeconds[e] = (inc.partnerImpactSeconds[e] ?? 0) + 1;
      if (e !== "retail" && s.successRate < m.downtimeSuccessRate) inc.partnerDowntimeSeconds[e] = (inc.partnerDowntimeSeconds[e] ?? 0) + 1;
    }
    const primary = inc.primaryEntityId;
    if (
      inc.platformProtectedAt === null &&
      primary !== "retail" &&
      samples[primary].status === "protected" &&
      retailHealth === "healthy" &&
      PARTNER_IDS.filter((p) => p !== primary).every((p) => !isImpaired(samples[p].status) || inc.scenarioIds.length > 1)
    ) {
      inc.platformProtectedAt = t;
    }
    if (inc.partnerRecoveredAt === null && t > inc.detectedAt && state.runtime[primary].healthyStreak > 0) {
      inc.partnerRecoveredAt = t;
      pushEvent(state, "partner_recovered", `${ENTITY_PROFILES[primary].name} back within healthy thresholds (verification pending)`, { incidentId: inc.id, entityId: primary });
    }
    const allHealthyNow = inc.affectedEntityIds.every((e) => state.runtime[e].healthyStreak > 0);
    if (allHealthyNow && inc.recoveryStartedAt === null) {
      inc.recoveryStartedAt = t;
      pushEvent(state, "recovery_started", `${inc.id}: all affected services within healthy thresholds; ${m.verificationWindowSeconds}s verification window started`, { incidentId: inc.id });
    } else if (!allHealthyNow && inc.recoveryStartedAt !== null) {
      inc.recoveryStartedAt = null;
    }
    const verified =
      inc.affectedEntityIds.every((e) => state.runtime[e].healthyStreak >= m.verificationWindowSeconds) &&
      inc.affectedEntityIds.every((e) => e === "retail" || state.runtime[e].breaker.state === "closed");
    if (verified) {
      inc.status = "resolved";
      inc.recoveredAt = t;
      inc.recoveryVerified = true;
      for (const r of inc.recommendations) {
        if (r.approval === "pending") r.approval = "expired";
        if (r.approval === "approved" && r.executedAt === null) {
          r.approval = "expired";
          r.scheduledExecutionAt = null;
        }
      }
      pushEvent(state, "recovery_verified", `${inc.id} resolved: recovery verified after ${m.verificationWindowSeconds}s of healthy simulated telemetry`, { incidentId: inc.id });
      for (const e of inc.affectedEntityIds) {
        const s = samples[e];
        if (s.status === "recovering") s.status = "healthy";
      }
    } else {
      const approved = inc.recommendations.some((r) => r.approval === "approved");
      inc.status = inc.recoveryStartedAt !== null ? "monitoring" : approved ? "mitigating" : inc.investigations.length > 0 ? "investigating" : "open";
    }
  }
}

// ---------------------------------------------------------------- step

export function step(state: SimState): void {
  processScheduled(state);
  const { samples, breakerStats, protectionRejectFrac, gateway } = computeTick(state);
  for (const p of PARTNER_IDS) updateBreaker(state, p, breakerStats[p]);
  monitor(state, samples, protectionRejectFrac, gateway);

  state.simulatedCostUsd += (state.controls.extraCapacitySlots * state.config.actions.costPerSlotHourUsd) / 3600;
  const retailHealth = retailHealthOf(state, samples.retail);
  const openBreakers = PARTNER_IDS.filter((p) => state.runtime[p].breaker.state !== "closed").length;
  const protecting = PARTNER_IDS.some((p) => samples[p].status === "protected");
  let protectionStatus: GatewayProtectionStatus = "nominal";
  if (gateway.pressure >= 1) protectionStatus = "saturated";
  else if (gateway.utilisation >= state.config.monitoring.gatewayPressureUtilisation) protectionStatus = "pressure";
  else if (protecting) protectionStatus = "protecting";

  for (const id of ENTITY_IDS) state.history.entities[id].push(samples[id]);
  const g: GatewaySample = {
    t: state.tick,
    capacitySlots: gateway.capacity,
    allocatedSlots: q(gateway.allocated, 2),
    utilisation: q(gateway.utilisation, 4),
    pressure: q(gateway.pressure, 4),
    partnerPoolUtilisation: q(gateway.partnerPoolUtil, 4),
    retailPoolUtilisation: q(gateway.retailPoolUtil, 4),
    totalRps: q(gateway.totalOffered, 1),
    platformP95Ms: gateway.platformP95,
    platformErrorRate: q(gateway.platformErrorRate, 5),
    retailP95Ms: samples.retail.p95Ms,
    retailHealth,
    openBreakers,
    protectionStatus,
    degradedPartners: PARTNER_IDS.filter((p) => samples[p].status !== "healthy").length,
    activeIncidents: openIncidents(state).length,
    simulatedCostUsd: q(state.simulatedCostUsd, 4),
  };
  state.history.gateway.push(g);
  state.tick += 1;
}

export function stepN(state: SimState, n: number): void {
  for (let i = 0; i < n; i++) step(state);
}

// ---------------------------------------------------------------- read helpers

export function latest(state: SimState, id: EntityId): EntitySample | null {
  const h = state.history.entities[id];
  return h.length ? h[h.length - 1] : null;
}

export function latestGateway(state: SimState): GatewaySample | null {
  const h = state.history.gateway;
  return h.length ? h[h.length - 1] : null;
}

export function windowOf<T extends { t: number }>(arr: T[], fromT: number): T[] {
  // History is append-only and ordered by t, so scan from the end.
  let i = arr.length;
  while (i > 0 && arr[i - 1].t >= fromT) i--;
  return arr.slice(i);
}

export function findIncident(state: SimState, id: string): Incident | null {
  return state.incidents.find((i) => i.id === id) ?? null;
}
