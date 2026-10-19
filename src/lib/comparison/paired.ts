import type { IncidentContext } from "../ai/context";
import { buildIncidentContext } from "../ai/context";
import type { InvestigationOutcome } from "../ai/service";
import { UNCONTROLLED_CONTROLS } from "../sim/config";
import { createInitialState, step } from "../sim/engine";
import { getScenario } from "../sim/scenarios";
import type { InvestigationMode, InvestigationWorkflow, PartnerId } from "../sim/types";
import { applyCommand, checkDecision, type Command, type WorkflowEntry } from "../sim/workflow";
import { getGolden, type GoldenScenario } from "../golden/dataset";
import { goldenCommands, ScriptedRunner } from "../golden/harness";
import { incidentMetrics, type RunMetrics } from "./metrics";

export type Investigator = (ctx: IncidentContext, mode: InvestigationMode, fault: "timeout" | "malformed" | null) => Promise<InvestigationOutcome>;

export interface PairedRunConfig {
  /** Golden scenario id, or a catalog scenario id with optional target. */
  goldenId?: string;
  scenarioId?: string;
  target?: PartnerId | null;
  seed: number;
  /** Simulated operator decision delay, identical for both modes (sim seconds). */
  operatorDelaySeconds: number;
  /** Max sim seconds observed after the trigger. */
  maxSeconds: number;
  /** Sim seconds per real second used to convert measured AI latency into simulated time (1 = real time). */
  latencyTimeScale: number;
  reinvestigateEverySeconds: number;
  maxInvestigations: number;
  /**
   * ASSUMED time (sim seconds) for a conventional on-call engineer to be paged,
   * open dashboards and work the runbook before the first diagnosis. Applies to
   * the manual-runbook arm only. A disclosed assumption, not measured data.
   */
  manualTriageSeconds: number;
}

export type Arm = "manual" | "rules" | "ai";
export const ARM_META: Record<Arm, { mode: InvestigationMode; workflow: InvestigationWorkflow; label: string }> = {
  manual: { mode: "ai_off", workflow: "manual_runbook", label: "Manual runbook (conventional)" },
  rules: { mode: "ai_off", workflow: "automated_rules", label: "Automated rules (no AI)" },
  ai: { mode: "ai_on", workflow: "ai_assisted", label: "AI-assisted" },
};

export interface SensitivityRow {
  triageSeconds: number;
  manualRecoveryS: number | null;
  manualPrimaryDowntimeS: number;
  manualSlaBreachS: number;
  /** manual − AI: positive = AI faster / less downtime. */
  aiRecoveryAdvantageS: number | null;
  aiDowntimeAdvantageS: number;
}

export interface ModeRun {
  arm: Arm;
  mode: InvestigationMode;
  workflow: InvestigationWorkflow;
  triageSeconds: number;
  metrics: RunMetrics;
  diagnosisSummary: string | null;
  topCause: string | null;
  approvedActions: string[];
  rejectedByPolicy: string[];
  investigationTicks: number;
  /** Sim seconds after incident start when automation paged the human on-call (null = never). */
  humanPagedAt: number | null;
  /** Sim seconds after incident start when the simulated human found the cause (null = not needed). */
  humanDiagnosedAt: number | null;
  timeline: { t: number; kind: string; message: string }[];
}

export interface PairedRunResult {
  config: PairedRunConfig;
  label: string;
  /** Manual runbook with assumed triage (the conventional baseline). */
  off: ModeRun;
  /** Automated rule-based runbook, no AI — isolates automation from AI. */
  rules: ModeRun;
  /** AI-assisted. */
  on: ModeRun;
  sensitivity: SensitivityRow[];
  controlsCounterfactual: { retailBreachSeconds: number; otherPartnerImpairedSeconds: number; primaryDowntimeSeconds: number; observationWindowS: number };
  protectedBaseline: { retailBreachSeconds: number; otherPartnerImpairedSeconds: number; primaryDowntimeSeconds: number };
  /** Revealed after the run only. */
  groundTruth: { primaryEntityId: string | null; cause: string | null; factors: string[] | null };
  notes: string[];
}

function commandsFor(cfg: PairedRunConfig): { commands: Command[]; gs: GoldenScenario | null; label: string; triggerAt: number } {
  if (cfg.goldenId) {
    const gs = getGolden(cfg.goldenId);
    if (!gs) throw new Error("unknown golden scenario");
    return { commands: goldenCommands(gs), gs, label: `${gs.id} — ${gs.title}`, triggerAt: gs.trigger.script[0].at };
  }
  const def = getScenario(cfg.scenarioId ?? "");
  if (!def || def.kind === "recovery") throw new Error("unknown scenario");
  return {
    commands: [{ k: "start", at: 10, scenarioId: def.id, target: def.targetable ? cfg.target ?? def.defaultTarget : null }],
    gs: null,
    label: `Scenario ${def.code} — ${def.label}`,
    triggerAt: 10,
  };
}

/** Triage assumptions (sim seconds) evaluated in the sensitivity table. */
export const SENSITIVITY_TRIAGE_SECONDS = [0, 60, 300, 600, 1200] as const;

/** Status is mutated by the runner; a function call avoids stale TS narrowing. */
const isResolved = (i: { status: string }) => i.status === "resolved";

/** Ground truth of what was started (scored and revealed after the run; never shown to investigators). */
function groundTruth(cfg: PairedRunConfig) {
  const { commands, gs, triggerAt } = commandsFor(cfg);
  const runner = new ScriptedRunner(gs, { seed: cfg.seed, commands });
  runner.advance(triggerAt + 1);
  const run = runner.state.scenarioRuns.find((r) => r.perturbations.some((p) => p.remediableByPartnerEscalation)) ?? runner.state.scenarioRuns[0] ?? null;
  const def = run ? getScenario(run.scenarioId) : null;
  return {
    scenarioId: run?.scenarioId ?? null,
    primaryEntityId: run?.targetEntityId ?? null,
    cause: def?.rootCause ?? null,
    /** A paged human can fix it by escalating to the partner. */
    partnerFixable: !!run?.perturbations.some((p) => p.remediableByPartnerEscalation),
    factors: run?.groundTruthFactors ?? null,
  };
}

async function runMode(cfg: PairedRunConfig, arm: Arm, investigate: Investigator, triageOverride?: number): Promise<ModeRun> {
  const { mode, workflow } = ARM_META[arm];
  const triageSeconds = arm === "manual" ? triageOverride ?? cfg.manualTriageSeconds : 0;
  // Same on-call human in every arm: when automation can only say "page a human",
  // they need the ASSUMED triage time to find the real cause.
  const humanSeconds = arm === "manual" ? triageSeconds : cfg.manualTriageSeconds;
  const truth = groundTruth(cfg);
  const { commands, gs, triggerAt } = commandsFor(cfg);
  const runner = new ScriptedRunner(gs, { seed: cfg.seed, commands });
  const endAt = triggerAt + cfg.maxSeconds;
  runner.advanceUntil((s) => s.incidents.length > 0 || s.tick >= endAt, endAt + 1);
  const s = runner.state;
  const inc = s.incidents[0] ?? null;
  const approved: string[] = [];
  const rejected: string[] = [];
  let ticks = 0;
  let pagedAt: number | null = null;
  let humanStepped = false;
  let humanDiagnosedAt: number | null = null;

  const blastRadiusContained = () => {
    const st = runner.state;
    const g = st.history.gateway.at(-1);
    const others = (["partner-a", "partner-b", "partner-c", "partner-d", "partner-e"] as const).filter((p) => p !== inc?.primaryEntityId);
    return (g?.retailHealth ?? "healthy") === "healthy" && others.every((p) => ["healthy", "recovering"].includes(st.history.entities[p].at(-1)?.status ?? "healthy"));
  };
  const remediationStarted = () => runner.state.scenarioRuns.some((r) => r.perturbations.some((p) => p.remediationAt !== null || p.endReason === "remediated"));

  const approveAll = (entryId: string, tag: string) => {
    let n = 0;
    for (const rec of [...inc!.recommendations]) {
      if (rec.investigationId !== entryId) continue;
      const chk = checkDecision(runner.state, inc!.id, rec.id, "approve");
      if (rec.validation.status === "rejected" || !chk.ok) {
        rejected.push(rec.actionId);
        continue;
      }
      n += 1;
      const d: WorkflowEntry = {
        kind: "decision",
        entryId: `PAIR-${arm}-${tag}-DEC${n}`,
        sessionId: "paired-run",
        incidentId: inc!.id,
        recommendationId: rec.id,
        decision: "approve",
        applyAt: runner.state.tick,
        wallMs: Date.now(),
        actor: "simulated_operator",
      };
      applyCommand(runner.state, { k: "entry", at: runner.state.tick, signed: { entry: d, sig: "local" } });
      approved.push(rec.actionId + (rec.targetEntityId ? `→${rec.targetEntityId}` : ""));
    }
  };

  /** SIMULATED on-call human (labelled): after the assumed triage time they find the true cause and escalate it. */
  const humanCheck = () => {
    if (!inc || humanStepped || pagedAt === null || isResolved(inc)) return;
    if (runner.state.tick < pagedAt + humanSeconds) return;
    humanStepped = true;
    if (remediationStarted() || !truth.partnerFixable || !truth.primaryEntityId || truth.primaryEntityId === "retail") return;
    const target = truth.primaryEntityId;
    const entryId = `PAIR-${arm}-HUMAN`;
    const entry: WorkflowEntry = {
      kind: "investigation",
      entryId,
      sessionId: "paired-run",
      incidentId: inc.id,
      requestedAt: pagedAt,
      applyAt: runner.state.tick,
      data: {
        mode: "ai_off",
        source: "rule_based",
        status: "succeeded",
        provider: "human_on_call_simulated",
        model: null,
        latencyMs: 0,
        llmLatencyMs: null,
        startedAtWallMs: Date.now(),
        completedAtWallMs: Date.now(),
        firstResponseMs: null,
        attempts: 0,
        errorCategory: null,
        llmError: null,
        usage: null,
        fallbackUsed: false,
        faultInjected: null,
        validationNotes: [`Simulated on-call engineer: assumed ${Math.round(humanSeconds / 60)} min of manual investigation after being paged.`],
        diagnosis: {
          summary: `On-call engineer (simulated) traced the problem to a downstream degradation at ${target} after manual investigation.`,
          severity: "medium",
          primaryEntityId: target,
          likelyCauses: [{ cause: "Partner downstream degradation found by manual investigation (simulated).", category: truth.cause ?? "partner_downstream_latency", confidence: 0.8, evidence: ["Manual investigation (simulated)"], limitations: ["Modelled human outcome; assumed to be correct"] }],
          observedFacts: [],
          inferences: [],
          unknowns: [],
          recommendedActions: [{ actionId: "escalate_to_partner", targetEntityId: target, rationale: "Human on-call identified the partner downstream as the cause." }],
          nextSteps: ["Monitor recovery verification"],
          reasoningSummary: "Simulated human on-call outcome.",
          requiresHumanApproval: true,
        },
        workflow: "manual_runbook",
        assumedTriageSeconds: humanSeconds,
        speed: cfg.latencyTimeScale,
      },
    };
    runner.apply({ k: "entry", at: runner.state.tick, signed: { entry, sig: "local" } });
    humanDiagnosedAt = runner.state.tick;
    approveAll(entryId, "HUMAN");
  };
  const adv = (n: number) => {
    for (let i = 0; i < n; i++) {
      runner.advance(1);
      humanCheck();
    }
  };
  const advUntil = (pred: () => boolean, limit: number) => {
    while (!pred() && runner.state.tick < limit) adv(1);
  };

  if (inc) {
    // Identical operator cadence in every arm: investigate, wait the measured
    // latency, decide after a fixed delay, then re-investigate every
    // `reinvestigateEverySeconds` while unresolved (max `maxInvestigations`).
    for (let round = 1; round <= cfg.maxInvestigations; round++) {
      const requestedAt = runner.state.tick;
      const ctx = buildIncidentContext(runner.state, inc.id);
      const outcome = await investigate(ctx, mode, mode === "ai_on" ? gs?.aiFault ?? null : null);
      // Measured wall-clock latency → simulated seconds (minimum one tick for every arm),
      // plus the ASSUMED human triage time before the FIRST manual diagnosis only
      // (deterministic gateway protections are never delayed — they act on their own).
      const triage = round === 1 ? triageSeconds : 0;
      const lt = triage + Math.max(1, Math.ceil((outcome.latencyMs / 1000) * cfg.latencyTimeScale));
      ticks += lt;
      adv(lt);
      if (isResolved(inc)) break;
      const entry: WorkflowEntry = {
        kind: "investigation",
        entryId: `PAIR-${arm}-INV${round}`,
        sessionId: "paired-run",
        incidentId: inc.id,
        requestedAt,
        applyAt: runner.state.tick,
        data: { ...outcome, workflow, assumedTriageSeconds: triage, speed: cfg.latencyTimeScale },
      };
      runner.apply({ k: "entry", at: runner.state.tick, signed: { entry, sig: "local" } });
      adv(cfg.operatorDelaySeconds);
      if (isResolved(inc)) break;
      // SIMULATED OPERATOR (labelled): approves every policy-valid pending recommendation; identical in every arm.
      const before = approved.length;
      approveAll(entry.entryId, `R${round}`);
      if (pagedAt === null && approved.slice(before).includes("escalate_to_operator") && !remediationStarted()) pagedAt = runner.state.tick;
      const until = Math.min(endAt, runner.state.tick + cfg.reinvestigateEverySeconds);
      advUntil(() => isResolved(inc), until);
      if (isResolved(inc) || runner.state.tick >= endAt) break;
      // A fix is in flight and nothing else is being hurt: wait for it rather than re-asking (same in every arm).
      // If retail or other partners are still impaired, keep investigating — containment may still be needed.
      if (remediationStarted() && blastRadiusContained()) break;
    }
    advUntil(() => isResolved(inc), endAt);
  }
  const fin = runner.state;
  const incident = fin.incidents[0] ?? null;
  return {
    arm,
    mode,
    workflow,
    triageSeconds,
    metrics: incidentMetrics(fin, incident, triggerAt),
    diagnosisSummary: incident?.investigations[0]?.diagnosis.summary ?? null,
    topCause: incident?.investigations[0]?.diagnosis.likelyCauses[0]?.category ?? null,
    approvedActions: approved,
    rejectedByPolicy: rejected,
    investigationTicks: ticks,
    humanPagedAt: pagedAt === null || !incident ? null : pagedAt - incident.startedAt,
    humanDiagnosedAt: humanDiagnosedAt === null || !incident ? null : humanDiagnosedAt - incident.startedAt,
    timeline: fin.timeline.filter((e) => !incident || e.incidentId === incident.id || e.incidentId === null).slice(-60).map((e) => ({ t: e.t, kind: e.kind, message: e.message })),
  };
}

function counterfactual(cfg: PairedRunConfig, uncontrolled: boolean, observe: number) {
  const { commands, triggerAt } = commandsFor(cfg);
  const s = createInitialState({ seed: cfg.seed, controls: uncontrolled ? UNCONTROLLED_CONTROLS : undefined });
  // In the uncontrolled counterfactual the scenario's own control patches are skipped: protections are OFF.
  const cmds = uncontrolled ? commands.filter((c) => c.k !== "controls") : commands;
  let ci = 0;
  for (let t = 0; t < triggerAt + observe; t++) {
    while (ci < cmds.length && cmds[ci].at === t) applyCommand(s, cmds[ci++]);
    step(s);
  }
  const primary = s.incidents[0]?.primaryEntityId ?? null;
  const win = (id: string) => s.history.entities[id as PartnerId].filter((x) => x.t >= triggerAt);
  const others = (["partner-a", "partner-b", "partner-c", "partner-d", "partner-e"] as const).filter((p) => p !== primary);
  return {
    retailBreachSeconds: s.history.gateway.filter((g) => g.t >= triggerAt && g.retailHealth === "breach").length,
    otherPartnerImpairedSeconds: others.reduce((sum, p) => sum + win(p).filter((x) => x.status !== "healthy" && x.status !== "recovering").length, 0),
    primaryDowntimeSeconds: primary && primary !== "retail" ? win(primary).filter((x) => x.successRate < s.config.monitoring.downtimeSuccessRate).length : 0,
    observationWindowS: observe,
  };
}

/**
 * Approach A — paired simulation runs. Identical seed, scenario, initial
 * conditions and deterministic controls; only the investigation path differs.
 * The operator is SIMULATED (fixed delay, approves every policy-valid
 * recommendation) and labelled as such in all outputs.
 */
export async function runPairedComparison(cfg: PairedRunConfig, investigate: Investigator): Promise<PairedRunResult> {
  const { label } = commandsFor(cfg);
  const off = await runMode(cfg, "manual", investigate);
  const rules = await runMode(cfg, "rules", investigate);
  const on = await runMode(cfg, "ai", investigate);
  // Sensitivity: how much of any AI advantage is just the triage ASSUMPTION?
  // Re-runs only the cheap manual arm (rule-based, no LLM calls).
  const sensitivity: SensitivityRow[] = [];
  for (const triageSeconds of SENSITIVITY_TRIAGE_SECONDS) {
    const m = triageSeconds === cfg.manualTriageSeconds ? off : await runMode(cfg, "manual", investigate, triageSeconds);
    sensitivity.push({
      triageSeconds,
      manualRecoveryS: m.metrics.timeToRecoveryS,
      manualPrimaryDowntimeS: m.metrics.primaryDowntimeSeconds,
      manualSlaBreachS: m.metrics.primarySlaBreachSeconds,
      aiRecoveryAdvantageS: m.metrics.timeToRecoveryS !== null && on.metrics.timeToRecoveryS !== null ? m.metrics.timeToRecoveryS - on.metrics.timeToRecoveryS : null,
      aiDowntimeAdvantageS: m.metrics.primaryDowntimeSeconds - on.metrics.primaryDowntimeSeconds,
    });
  }
  const observe = Math.max(off.metrics.observationWindowS, rules.metrics.observationWindowS, on.metrics.observationWindowS, 60);
  const notes = [
    "SIMULATED RESULTS. All arms use the same seed, scenario, initial conditions and deterministic gateway protections; protections act immediately in every arm.",
    `Manual runbook arm: an ASSUMED ${Math.round(cfg.manualTriageSeconds / 60)} min of human triage (paging, dashboards, runbook) precedes the first diagnosis. This is an input assumption, not measured data — see the sensitivity table.`,
    "Automated rules arm: the same rule-based runbook runs on detection with no AI. It separates the value of automation from the value of AI.",
    `Simulated operator: approves every policy-valid recommendation after ${cfg.operatorDelaySeconds} sim seconds in EVERY arm. This is not real human behaviour.`,
    `Measured investigation wall-clock latency is converted to simulated seconds at ${cfg.latencyTimeScale} sim-s per real second (minimum 1 tick).`,
    `If unresolved and no fix is in flight, the incident is re-investigated every ${cfg.reinvestigateEverySeconds} sim seconds (max ${cfg.maxInvestigations} investigations), identically in every arm.`,
    `When an arm can only recommend paging a human, a SIMULATED on-call engineer finds the true cause after the assumed ${Math.round(cfg.manualTriageSeconds / 60)} min triage time and escalates it — the same in every arm. This is a modelling assumption.`,
  ];
  if (on.metrics.diagnosisSource !== "llm") notes.push(`AI ON run did not receive a real LLM response (${on.metrics.errorCategory ?? "unknown"}); it used the rule-based fallback, so this pair does not measure AI value.`);
  const gt = groundTruth(cfg);
  return {
    config: cfg,
    label,
    groundTruth: { primaryEntityId: gt.primaryEntityId, cause: gt.cause, factors: gt.factors },
    off,
    rules,
    on,
    sensitivity,
    controlsCounterfactual: counterfactual(cfg, true, observe),
    protectedBaseline: (() => {
      const c = counterfactual(cfg, false, observe);
      return { retailBreachSeconds: c.retailBreachSeconds, otherPartnerImpairedSeconds: c.otherPartnerImpairedSeconds, primaryDowntimeSeconds: c.primaryDowntimeSeconds };
    })(),
    notes,
  };
}
