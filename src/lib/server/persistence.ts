import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EntityId, Incident, SimState } from "../sim/types";
import { ENTITY_IDS } from "../sim/types";
import { serverEnv } from "./env";
import { log } from "./logger";

/**
 * Persistence of incident records, investigations, recommendations, audit logs,
 * key telemetry snapshots and comparison runs. All rows are scoped by a
 * server-issued session id (never a browser-supplied identifier). Writes are
 * idempotent upserts and best-effort: failures are logged and never affect
 * the simulation.
 */

export type Row = Record<string, unknown> & { id: string };

export interface IncidentBundle {
  incidents: Row[];
  telemetry_snapshots: Row[];
  investigations: Row[];
  recommendations: Row[];
  action_audit_logs: Row[];
}

export interface Repository {
  kind: "supabase" | "memory";
  upsertBundle(bundle: IncidentBundle): Promise<void>;
  insertComparisonRuns(rows: Row[]): Promise<void>;
  getComparison(sessionId: string, pairId: string): Promise<Row[]>;
  getIncident(sessionId: string, incidentRef: string): Promise<{ incident: Row; investigations: Row[]; recommendations: Row[]; audit: Row[]; telemetry: Row[] } | null>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const k = (sid: string, ref: string) => `${sid}:${ref}`;

/** Snapshot ticks: detection, investigation requests, action executions, recovery. */
function keyTicks(inc: Incident): number[] {
  const ticks = new Set<number>([inc.detectedAt]);
  for (const iv of inc.investigations) ticks.add(iv.requestedAt);
  for (const r of inc.recommendations) if (r.executedAt !== null) ticks.add(r.executedAt);
  if (inc.recoveredAt !== null) ticks.add(inc.recoveredAt);
  return [...ticks].slice(0, 20);
}

export function buildBundle(sessionId: string, state: SimState): IncidentBundle {
  const b: IncidentBundle = { incidents: [], telemetry_snapshots: [], investigations: [], recommendations: [], action_audit_logs: [] };
  for (const inc of state.incidents.slice(-20)) {
    const incId = k(sessionId, inc.id);
    b.incidents.push({
      id: incId,
      session_id: sessionId,
      incident_ref: inc.id,
      scenario_id: inc.scenarioIds[0] ?? null,
      partner_id: inc.primaryEntityId,
      affected_entity_ids: inc.affectedEntityIds,
      severity: inc.peakSeverity,
      status: inc.status,
      started_at_sim_s: inc.startedAt,
      detected_at_sim_s: inc.detectedAt,
      diagnosed_at_sim_s: inc.diagnosedAt,
      recommendation_at_sim_s: inc.recommendationAt,
      recovered_at_sim_s: inc.recoveredAt,
      investigation_mode: inc.investigationMode,
      recovery_verified: inc.recoveryVerified,
      retail_breach_seconds: inc.retailBreachSeconds,
    });
    const gw = state.history.gateway;
    for (const t of keyTicks(inc)) {
      const g = gw.find((x) => x.t === t);
      if (!g) continue;
      for (const id of ENTITY_IDS) {
        const s = state.history.entities[id as EntityId].find((x) => x.t === t);
        if (!s) continue;
        b.telemetry_snapshots.push({
          id: `${incId}:${id}:${t}`,
          session_id: sessionId,
          incident_id: incId,
          t_sim_s: t,
          partner_id: id,
          request_rate: s.offeredRps,
          p50_latency_ms: s.p50Ms,
          p95_latency_ms: s.p95Ms,
          p99_latency_ms: s.p99Ms,
          error_rate: s.errorRate,
          in_flight_requests: s.inFlight,
          concurrency_limit: s.concurrencyLimit,
          resource_utilisation: g.utilisation,
          circuit_breaker_state: s.breaker,
          retail_p95_latency_ms: g.retailP95Ms,
          retail_health: g.retailHealth,
          health_status: s.status,
        });
      }
    }
    for (const iv of inc.investigations) {
      b.investigations.push({
        id: k(sessionId, iv.id),
        session_id: sessionId,
        incident_id: incId,
        provider: iv.provider,
        model: iv.model,
        source: iv.source,
        mode: iv.mode,
        workflow: iv.workflow ?? (iv.mode === "ai_on" ? "ai_assisted" : "automated_rules"),
        assumed_triage_seconds: iv.assumedTriageSeconds ?? 0,
        status: iv.status,
        started_at: iso(iv.startedAtWallMs),
        completed_at: iso(iv.completedAtWallMs),
        latency_ms: Math.round(iv.latencyMs),
        llm_latency_ms: iv.llmLatencyMs,
        requested_at_sim_s: iv.requestedAt,
        applied_at_sim_s: iv.appliedAt,
        attempts: iv.attempts,
        total_tokens: iv.usage?.totalTokens ?? null,
        diagnosis_json: iv.diagnosis,
        error_category: iv.errorCategory,
        fallback_used: iv.fallbackUsed,
        fault_injected: iv.faultInjected,
      });
    }
    for (const r of inc.recommendations) {
      b.recommendations.push({
        id: k(sessionId, r.id),
        session_id: sessionId,
        incident_id: incId,
        investigation_id: k(sessionId, r.investigationId),
        action_id: r.actionId,
        target_entity_id: r.targetEntityId,
        rationale: r.rationale,
        source: r.source,
        validation_status: r.validation.status,
        validation_json: r.validation,
        approval_status: r.approval,
        decided_by: r.decidedBy,
        approved_at: r.approval === "approved" || r.executedAt !== null ? iso(r.decidedAtWallMs) : null,
        rejected_at: r.approval === "rejected" ? iso(r.decidedAtWallMs) : null,
        decided_at_sim_s: r.decidedAt,
        executed_at_sim_s: r.executedAt,
        execution_outcome: r.executionOutcome,
      });
    }
    for (const a of inc.audit) {
      b.action_audit_logs.push({
        id: k(sessionId, a.id),
        session_id: sessionId,
        incident_id: incId,
        recommendation_id: k(sessionId, a.recommendationId),
        action_id: a.actionId,
        target_entity_id: a.targetEntityId,
        actor_type: a.actorType,
        outcome: a.outcome,
        before_state: a.beforeState,
        after_state: a.afterState,
        t_sim_s: a.t,
        timestamp: iso(a.wallMs),
        note: a.note,
      });
    }
  }
  return b;
}

// ---------------------------------------------------------------- memory adapter

export class MemoryRepository implements Repository {
  kind = "memory" as const;
  tables = new Map<string, Map<string, Row>>();
  private t(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }
  async upsertBundle(bundle: IncidentBundle) {
    for (const [name, rows] of Object.entries(bundle)) for (const r of rows as Row[]) this.t(name).set(r.id, r);
  }
  async insertComparisonRuns(rows: Row[]) {
    for (const r of rows) this.t("comparison_runs").set(r.id, r);
  }
  async getComparison(sessionId: string, pairId: string) {
    return [...this.t("comparison_runs").values()].filter((r) => r.session_id === sessionId && (r.pair_id === pairId || r.id === pairId));
  }
  async getIncident(sessionId: string, ref: string) {
    const incident = this.t("incidents").get(k(sessionId, ref));
    if (!incident || incident.session_id !== sessionId) return null;
    const by = (name: string) => [...this.t(name).values()].filter((r) => r.incident_id === incident.id && r.session_id === sessionId);
    return { incident, investigations: by("investigations"), recommendations: by("recommendations"), audit: by("action_audit_logs"), telemetry: by("telemetry_snapshots") };
  }
}

// ---------------------------------------------------------------- supabase adapter

export class SupabaseRepository implements Repository {
  kind = "supabase" as const;
  constructor(private db: SupabaseClient) {}

  private async upsert(table: string, rows: Row[]) {
    if (!rows.length) return;
    const { error } = await this.db.from(table).upsert(rows, { onConflict: "id" });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  async upsertBundle(b: IncidentBundle) {
    // FK order: incidents → investigations → recommendations → audit; telemetry after incidents.
    await this.upsert("incidents", b.incidents);
    await this.upsert("investigations", b.investigations);
    await this.upsert("recommendations", b.recommendations);
    await Promise.all([this.upsert("action_audit_logs", b.action_audit_logs), this.upsert("telemetry_snapshots", b.telemetry_snapshots)]);
  }
  async insertComparisonRuns(rows: Row[]) {
    await this.upsert("comparison_runs", rows);
  }
  async getComparison(sessionId: string, pairId: string) {
    const { data, error } = await this.db.from("comparison_runs").select("*").eq("session_id", sessionId).or(`pair_id.eq.${pairId},id.eq.${pairId}`).limit(10);
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }
  async getIncident(sessionId: string, ref: string) {
    const id = k(sessionId, ref);
    const { data: incident, error } = await this.db.from("incidents").select("*").eq("id", id).eq("session_id", sessionId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!incident) return null;
    const q = async (table: string) => {
      const { data, error: e } = await this.db.from(table).select("*").eq("incident_id", id).eq("session_id", sessionId).limit(500);
      if (e) throw new Error(e.message);
      return (data ?? []) as Row[];
    };
    const [investigations, recommendations, audit, telemetry] = await Promise.all([q("investigations"), q("recommendations"), q("action_audit_logs"), q("telemetry_snapshots")]);
    return { incident: incident as Row, investigations, recommendations, audit, telemetry };
  }
}

let repo: Repository | null = null;
export function repository(): Repository {
  if (repo) return repo;
  const env = serverEnv();
  if (env.persistence === "supabase" && env.supabaseUrl && env.supabaseServiceRoleKey) {
    repo = new SupabaseRepository(createClient(env.supabaseUrl, env.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }));
  } else {
    repo = new MemoryRepository();
  }
  return repo;
}
export function setRepositoryForTests(r: Repository | null) {
  repo = r;
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("persistence timeout")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort persistence of the whole (bounded) session state. */
export async function persistState(sessionId: string, state: SimState): Promise<void> {
  try {
    await withTimeout(repository().upsertBundle(buildBundle(sessionId, state)), 4000);
  } catch (err) {
    log("warn", "persistence_failed", { message: String((err as Error).message).slice(0, 200) });
  }
}
