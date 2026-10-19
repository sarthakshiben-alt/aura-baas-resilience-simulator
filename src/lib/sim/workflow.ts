import { ALLOWED_TIMEOUTS_MS, cloneControls, ENTITY_PROFILES } from "./config";
import { createInitialState, findIncident, perturbationFinished, pushEvent, step, type CreateStateOptions } from "./engine";
import { addAudit, executeAction, getAction } from "./actions";
import { validateAction } from "./policy";
import { getScenario } from "./scenarios";
import type { ControlsPatch, EntityId, Incident, InvestigationRecord, Recommendation, SimState } from "./types";
import { isEntityId, isPartnerId } from "./types";

export class CommandError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

export type InvestigationData = Omit<InvestigationRecord, "id" | "incidentId" | "requestedAt" | "appliedAt">;

export type WorkflowEntry =
  | {
      kind: "investigation";
      entryId: string;
      sessionId: string;
      incidentId: string;
      requestedAt: number;
      applyAt: number;
      data: InvestigationData;
    }
  | {
      kind: "decision";
      entryId: string;
      sessionId: string;
      incidentId: string;
      recommendationId: string;
      decision: "approve" | "reject" | "cancel";
      applyAt: number;
      wallMs: number;
      actor: "human" | "simulated_operator";
    };

export interface SignedEntry {
  entry: WorkflowEntry;
  sig: string;
}

export type Command =
  | { k: "start"; at: number; scenarioId: string; target?: string | null }
  | { k: "stop"; at: number; runId: string }
  | { k: "controls"; at: number; patch: ControlsPatch }
  | { k: "entry"; at: number; signed: SignedEntry };

export interface SimLog {
  v: 1;
  seed: number;
  tick: number;
  commands: Command[];
}

export const MAX_ACTIVE_RUNS = 4;
export const MAX_COMMANDS = 400;
export const MAX_INVESTIGATIONS = 30;

// ---------------------------------------------------------------- scenario commands

export function startScenario(state: SimState, scenarioId: string, rawTarget?: string | null) {
  const def = getScenario(scenarioId);
  if (!def) throw new CommandError("unknown_scenario", `Unknown scenario "${String(scenarioId).slice(0, 40)}"`, 422);
  const t = state.tick;
  let target: EntityId | null = null;
  if (def.targetable) {
    const tgt = rawTarget ?? def.defaultTarget;
    if (!isPartnerId(tgt)) throw new CommandError("invalid_target", "Scenario target must be a partner", 422);
    target = tgt;
  }
  state.counters.scenarioRun += 1;
  const runId = `RUN-${String(state.counters.scenarioRun).padStart(3, "0")}`;
  if (def.kind === "recovery") {
    let ended = 0;
    for (const run of state.scenarioRuns) {
      for (const p of run.perturbations) {
        if (p.entity === target && !perturbationFinished(p, t) && (p.endAt === null || p.endAt > t)) {
          p.endAt = t;
          p.endReason = "recovered";
          ended += 1;
        }
      }
    }
    state.scenarioRuns.push({ id: runId, scenarioId, label: def.label, targetEntityId: target, startedAt: t, stoppedAt: t, perturbations: [] });
    pushEvent(state, "recovery_triggered", `Scenario E (Recovery) triggered for ${target ? ENTITY_PROFILES[target].name : "?"}${ended === 0 ? " — no active degradation to recover" : ""}`, {
      entityId: target,
    });
    return runId;
  }
  const active = state.scenarioRuns.filter((r) => r.perturbations.some((p) => !perturbationFinished(p, t)));
  if (active.length >= MAX_ACTIVE_RUNS) throw new CommandError("too_many_runs", `At most ${MAX_ACTIVE_RUNS} scenarios can run at once`, 409);
  state.scenarioRuns.push({
    id: runId,
    scenarioId,
    label: def.label,
    targetEntityId: target,
    startedAt: t,
    stoppedAt: null,
    perturbations: def.perturbations.map((spec) => {
      const entity = spec.entity === "target" ? (target as EntityId) : spec.entity;
      const startAt = t + spec.startOffsetSeconds;
      return {
        entity,
        channel: spec.channel,
        peak: spec.peak,
        startAt,
        rampUpSeconds: spec.rampUpSeconds,
        plannedEndAt: spec.holdSeconds === null ? null : startAt + spec.rampUpSeconds + spec.holdSeconds,
        rampDownSeconds: spec.rampDownSeconds,
        endAt: null,
        endReason: null,
        remediableByPartnerEscalation: spec.remediableByPartnerEscalation,
        remediationSeconds: spec.remediationSeconds,
        remediationAt: null,
      };
    }),
  });
  pushEvent(state, "scenario_triggered", `Scenario ${def.code} (${def.label}) triggered${target ? ` on ${ENTITY_PROFILES[target].name}` : ""} [${runId}]`, {
    entityId: target,
    data: { runId, scenarioId },
  });
  return runId;
}

export function stopScenario(state: SimState, runId: string) {
  const run = state.scenarioRuns.find((r) => r.id === runId);
  if (!run) throw new CommandError("unknown_run", `Unknown scenario run ${String(runId).slice(0, 20)}`, 404);
  if (run.stoppedAt !== null) throw new CommandError("already_stopped", `${runId} is already stopped`, 409);
  const t = state.tick;
  for (const p of run.perturbations) {
    if (p.endAt === null || p.endAt > t) {
      if (p.plannedEndAt !== null && p.plannedEndAt <= t) continue;
      p.endAt = t;
      p.endReason = "stopped";
    }
  }
  run.stoppedAt = t;
  pushEvent(state, "scenario_stopped", `${run.label} [${runId}] stopped safely; perturbations ramp back to baseline`, { entityId: run.targetEntityId });
}

export function applyControlsPatch(state: SimState, patch: ControlsPatch) {
  const c = cloneControls(state.controls);
  const changes: string[] = [];
  if (patch.isolationEnabled !== undefined) {
    c.isolationEnabled = !!patch.isolationEnabled;
    changes.push(`per-partner isolation ${c.isolationEnabled ? "ON" : "OFF"}`);
  }
  if (patch.breakerEnabled !== undefined) {
    c.breakerEnabled = !!patch.breakerEnabled;
    changes.push(`circuit breakers ${c.breakerEnabled ? "ON" : "OFF"}`);
  }
  if (patch.retailReservationEnabled !== undefined) {
    c.retailReservationEnabled = !!patch.retailReservationEnabled;
    changes.push(`retail reservation ${c.retailReservationEnabled ? "ON" : "OFF"}`);
  }
  if (patch.timeoutMs !== undefined) {
    if (!(ALLOWED_TIMEOUTS_MS as readonly number[]).includes(patch.timeoutMs)) throw new CommandError("invalid_controls", "Timeout must be one of the allowed values", 422);
    c.timeoutMs = patch.timeoutMs;
    changes.push(`timeout ${c.timeoutMs} ms`);
  }
  if (patch.perPartnerLimit !== undefined) {
    if (!Number.isInteger(patch.perPartnerLimit) || patch.perPartnerLimit < 10 || patch.perPartnerLimit > 400)
      throw new CommandError("invalid_controls", "Per-partner limit must be an integer 10–400", 422);
    c.perPartnerLimit = patch.perPartnerLimit;
    changes.push(`per-partner limit ${c.perPartnerLimit}`);
  }
  if (patch.retailReservationSlots !== undefined) {
    if (!Number.isInteger(patch.retailReservationSlots) || patch.retailReservationSlots < 0 || patch.retailReservationSlots > state.config.actions.maxRetailReservationSlots)
      throw new CommandError("invalid_controls", "Retail reservation slots out of range", 422);
    c.retailReservationSlots = patch.retailReservationSlots;
    changes.push(`retail reservation ${c.retailReservationSlots} slots`);
  }
  state.controls = c;
  if (changes.length) pushEvent(state, "controls_changed", `Gateway controls changed by operator: ${changes.join(", ")}`);
}

// ---------------------------------------------------------------- workflow entries

export function latestInvestigationId(inc: Incident): string | null {
  return inc.investigations.length ? inc.investigations[inc.investigations.length - 1].id : null;
}

export function applyInvestigation(state: SimState, e: Extract<WorkflowEntry, { kind: "investigation" }>) {
  const inc = findIncident(state, e.incidentId);
  if (!inc) throw new CommandError("unknown_incident", `Incident ${e.incidentId} not found`, 404);
  if (e.applyAt < e.requestedAt) throw new CommandError("invalid_entry", "Investigation applied before it was requested", 422);
  if (inc.investigations.length >= MAX_INVESTIGATIONS) throw new CommandError("too_many_investigations", "Investigation limit reached for this incident", 429);
  const t = state.tick;
  const record: InvestigationRecord = { ...e.data, id: e.entryId, incidentId: inc.id, requestedAt: e.requestedAt, appliedAt: t };
  for (const r of inc.recommendations) if (r.approval === "pending" || r.approval === "not_approvable") r.approval = "superseded";
  inc.investigations.push(record);
  inc.investigationRequestedAt ??= e.requestedAt;
  inc.investigationMode ??= e.data.mode;
  inc.diagnosedAt ??= t;
  const label = e.data.source === "llm" ? `Real LLM response (${e.data.provider}/${e.data.model ?? "?"})` : e.data.source === "rule_based_fallback" ? "Rule-based fallback" : "Rule-based (conventional workflow)";
  pushEvent(state, "investigation_started", `Investigation requested (${e.data.mode === "ai_on" ? "AI assistance ON" : "AI assistance OFF"})`, { t: e.requestedAt, incidentId: inc.id });
  if (e.data.errorCategory) {
    pushEvent(state, "investigation_failed", `LLM investigation failed (${e.data.errorCategory}); ${e.data.fallbackUsed ? "rule-based fallback used" : "no diagnosis"}`, { incidentId: inc.id });
  }
  pushEvent(state, "diagnosis_returned", `Diagnosis returned — ${label}: ${e.data.diagnosis.summary.slice(0, 160)}`, {
    incidentId: inc.id,
    data: { source: e.data.source, latencyMs: e.data.latencyMs },
  });
  const seen = new Set<string>();
  e.data.diagnosis.recommendedActions.forEach((a, idx) => {
    const target = a.targetEntityId && isEntityId(a.targetEntityId) ? a.targetEntityId : null;
    const key = `${a.actionId}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    const validation = validateAction(state, inc, a.actionId, a.targetEntityId);
    const rec: Recommendation = {
      id: `${e.entryId}-R${idx + 1}`,
      incidentId: inc.id,
      investigationId: e.entryId,
      actionId: a.actionId,
      targetEntityId: target,
      rationale: a.rationale,
      source: e.data.source,
      createdAt: t,
      validation,
      approval: validation.status === "rejected" ? "not_approvable" : "pending",
      decidedAt: null,
      decidedAtWallMs: null,
      decidedBy: null,
      scheduledExecutionAt: null,
      executedAt: null,
      executionOutcome: null,
    };
    inc.recommendations.push(rec);
    if (validation.status !== "rejected") inc.recommendationAt ??= t;
    pushEvent(
      state,
      "action_proposed",
      `Action proposed: ${getAction(a.actionId)?.label ?? `unknown "${a.actionId.slice(0, 40)}"`}${target ? ` → ${ENTITY_PROFILES[target].name}` : ""} — policy ${validation.status.replace(/_/g, " ")}`,
      { incidentId: inc.id, entityId: target },
    );
  });
}

export type DecisionCheck = { ok: true; inc: Incident; rec: Recommendation } | { ok: false; code: string; message: string; status: number };

export function checkDecision(state: SimState, incidentId: string, recommendationId: string, decision: "approve" | "reject" | "cancel"): DecisionCheck {
  const inc = findIncident(state, incidentId);
  if (!inc) return { ok: false, code: "unknown_incident", message: `Incident ${incidentId} not found`, status: 404 };
  const rec = inc.recommendations.find((r) => r.id === recommendationId);
  if (!rec) return { ok: false, code: "unknown_recommendation", message: "Recommendation does not belong to this incident", status: 404 };
  if (decision === "cancel") {
    if (rec.approval !== "approved" || rec.executedAt !== null) {
      return { ok: false, code: "not_cancellable", message: "Only approved actions that have not yet executed can be cancelled", status: 409 };
    }
    return { ok: true, inc, rec };
  }
  if (inc.status === "resolved") return { ok: false, code: "incident_resolved", message: `${inc.id} is resolved; its recommendations can no longer be decided`, status: 409 };
  if (rec.investigationId !== latestInvestigationId(inc) || rec.approval === "superseded") {
    return { ok: false, code: "stale_recommendation", message: "A newer investigation superseded this recommendation", status: 409 };
  }
  if (rec.approval !== "pending" && !(decision === "reject" && rec.approval === "not_approvable")) {
    return { ok: false, code: "already_decided", message: `Recommendation is already ${rec.approval}`, status: 409 };
  }
  if (decision === "approve") {
    const v = validateAction(state, inc, rec.actionId, rec.targetEntityId);
    if (v.status === "rejected") return { ok: false, code: "policy_rejected", message: `Policy re-validation failed: ${v.reasons[v.reasons.length - 1]}`, status: 422 };
  }
  return { ok: true, inc, rec };
}

export function applyDecision(state: SimState, e: Extract<WorkflowEntry, { kind: "decision" }>) {
  const check = checkDecision(state, e.incidentId, e.recommendationId, e.decision);
  if (!check.ok) throw new CommandError(check.code, check.message, check.status);
  const { inc, rec } = check;
  const t = state.tick;
  const def = getAction(rec.actionId);
  if (e.decision === "approve") {
    rec.validation = validateAction(state, inc, rec.actionId, rec.targetEntityId);
    rec.approval = "approved";
    rec.decidedAt = t;
    rec.decidedAtWallMs = e.wallMs;
    rec.decidedBy = e.actor;
    rec.scheduledExecutionAt = t + (def?.executionDelaySeconds ?? 0);
    inc.firstDecisionAt ??= t;
    inc.firstDecisionWallMs ??= e.wallMs;
    addAudit(state, inc, { recommendationId: rec.id, actionId: rec.actionId, targetEntityId: rec.targetEntityId, actorType: e.actor, outcome: "approved", t, wallMs: e.wallMs, beforeState: null, afterState: null, note: `Approved by ${e.actor === "human" ? "human operator" : "simulated operator (benchmark)"}; executes in ${def?.executionDelaySeconds ?? 0}s` });
    pushEvent(state, "action_approved", `Action approved by ${e.actor === "human" ? "human" : "simulated operator"}: ${def?.label ?? rec.actionId}`, { incidentId: inc.id, entityId: rec.targetEntityId });
    if (rec.scheduledExecutionAt === t) executeAction(state, inc, rec, e.actor);
  } else if (e.decision === "reject") {
    rec.approval = "rejected";
    rec.decidedAt = t;
    rec.decidedAtWallMs = e.wallMs;
    rec.decidedBy = e.actor;
    inc.firstDecisionAt ??= t;
    inc.firstDecisionWallMs ??= e.wallMs;
    addAudit(state, inc, { recommendationId: rec.id, actionId: rec.actionId, targetEntityId: rec.targetEntityId, actorType: e.actor, outcome: "rejected", t, wallMs: e.wallMs, beforeState: null, afterState: null, note: "Rejected; no state change" });
    pushEvent(state, "action_rejected", `Action rejected: ${def?.label ?? rec.actionId}`, { incidentId: inc.id, entityId: rec.targetEntityId });
  } else {
    rec.approval = "cancelled";
    rec.scheduledExecutionAt = null;
    addAudit(state, inc, { recommendationId: rec.id, actionId: rec.actionId, targetEntityId: rec.targetEntityId, actorType: e.actor, outcome: "cancelled", t, wallMs: e.wallMs, beforeState: null, afterState: null, note: "Pending action cancelled before execution" });
    pushEvent(state, "action_cancelled", `Pending action cancelled: ${def?.label ?? rec.actionId}`, { incidentId: inc.id, entityId: rec.targetEntityId });
  }
}

export function applyEntry(state: SimState, entry: WorkflowEntry) {
  if (state.appliedEntryIds.includes(entry.entryId)) return false; // idempotent duplicate
  if (entry.applyAt !== state.tick) throw new CommandError("entry_tick_mismatch", "Workflow entry applied at the wrong tick", 422);
  if (entry.kind === "investigation") applyInvestigation(state, entry);
  else applyDecision(state, entry);
  state.appliedEntryIds.push(entry.entryId);
  return true;
}

// ---------------------------------------------------------------- replay

export interface ReplayOptions extends CreateStateOptions {
  /** Server-side: verify signatures and session binding of every entry. */
  verifyEntry?: (signed: SignedEntry) => boolean;
}

export function applyCommand(state: SimState, cmd: Command, opts: ReplayOptions = {}) {
  switch (cmd.k) {
    case "start":
      startScenario(state, cmd.scenarioId, cmd.target ?? null);
      break;
    case "stop":
      stopScenario(state, cmd.runId);
      break;
    case "controls":
      applyControlsPatch(state, cmd.patch);
      break;
    case "entry":
      if (opts.verifyEntry && !opts.verifyEntry(cmd.signed)) throw new CommandError("invalid_signature", "A workflow entry failed signature verification", 403);
      if (cmd.signed.entry.applyAt !== cmd.at) throw new CommandError("entry_tick_mismatch", "Entry tick does not match command tick", 422);
      applyEntry(state, cmd.signed.entry);
      break;
    default:
      throw new CommandError("unknown_command", "Unknown command", 422);
  }
}

export function validateLogShape(log: SimLog, maxTicks: number) {
  if (log.v !== 1) throw new CommandError("bad_log", "Unsupported log version", 422);
  if (!Number.isInteger(log.tick) || log.tick < 0 || log.tick > maxTicks) throw new CommandError("bad_log", `Tick must be an integer 0–${maxTicks}`, 422);
  if (log.commands.length > MAX_COMMANDS) throw new CommandError("bad_log", "Too many commands", 413);
  let prev = 0;
  for (const c of log.commands) {
    if (!Number.isInteger(c.at) || c.at < prev || c.at > log.tick) throw new CommandError("bad_log", "Commands must be ordered and within the log's tick range", 422);
    prev = c.at;
  }
}

/** Deterministically rebuild state from a command log. */
export function replay(log: SimLog, opts: ReplayOptions = {}): SimState {
  const state = createInitialState({ ...opts, seed: log.seed });
  validateLogShape(log, state.config.maxTicks);
  let ci = 0;
  for (let t = 0; t <= log.tick; t++) {
    while (ci < log.commands.length && log.commands[ci].at === t) {
      applyCommand(state, log.commands[ci], opts);
      ci++;
    }
    if (t < log.tick) step(state);
  }
  return state;
}

/** Insert a command keeping order stable (commands at equal ticks keep insertion order). */
export function insertCommand(commands: Command[], cmd: Command): Command[] {
  const out = commands.slice();
  let i = out.length;
  while (i > 0 && out[i - 1].at > cmd.at) i--;
  out.splice(i, 0, cmd);
  return out;
}
