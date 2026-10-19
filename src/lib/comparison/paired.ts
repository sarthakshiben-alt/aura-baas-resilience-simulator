import type { IncidentContext } from "../ai/context";
import { buildIncidentContext } from "../ai/context";
import type { InvestigationOutcome } from "../ai/service";
import { UNCONTROLLED_CONTROLS } from "../sim/config";
import { createInitialState, step } from "../sim/engine";
import { getScenario } from "../sim/scenarios";
import type { InvestigationMode, PartnerId } from "../sim/types";
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
}

export interface ModeRun {
  mode: InvestigationMode;
  metrics: RunMetrics;
  diagnosisSummary: string | null;
  topCause: string | null;
  approvedActions: string[];
  rejectedByPolicy: string[];
  investigationTicks: number;
  timeline: { t: number; kind: string; message: string }[];
}

export interface PairedRunResult {
  config: PairedRunConfig;
  label: string;
  off: ModeRun;
  on: ModeRun;
  controlsCounterfactual: { retailBreachSeconds: number; otherPartnerImpairedSeconds: number; primaryDowntimeSeconds: number; observationWindowS: number };
  protectedBaseline: { retailBreachSeconds: number; otherPartnerImpairedSeconds: number; primaryDowntimeSeconds: number };
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

/** Status is mutated by the runner; a function call avoids stale TS narrowing. */
const isResolved = (i: { status: string }) => i.status === "resolved";

async function runMode(cfg: PairedRunConfig, mode: InvestigationMode, investigate: Investigator): Promise<ModeRun> {
  const { commands, gs, triggerAt } = commandsFor(cfg);
  const runner = new ScriptedRunner(gs, { seed: cfg.seed, commands });
  const endAt = triggerAt + cfg.maxSeconds;
  runner.advanceUntil((s) => s.incidents.length > 0 || s.tick >= endAt, endAt + 1);
  const s = runner.state;
  const inc = s.incidents[0] ?? null;
  const approved: string[] = [];
  const rejected: string[] = [];
  let ticks = 0;
  if (inc) {
    // Identical operator cadence in both modes: investigate, wait the measured
    // latency, decide after a fixed delay, then re-investigate every
    // `reinvestigateEverySeconds` while unresolved (max `maxInvestigations`).
    for (let round = 1; round <= cfg.maxInvestigations; round++) {
      const requestedAt = runner.state.tick;
      const ctx = buildIncidentContext(runner.state, inc.id);
      const outcome = await investigate(ctx, mode, mode === "ai_on" ? gs?.aiFault ?? null : null);
      // Measured wall-clock latency → simulated seconds (minimum one tick for both modes).
      const lt = Math.max(1, Math.ceil((outcome.latencyMs / 1000) * cfg.latencyTimeScale));
      ticks += lt;
      runner.advance(lt);
      if (isResolved(inc)) break;
      const entry: WorkflowEntry = {
        kind: "investigation",
        entryId: `PAIR-${mode}-INV${round}`,
        sessionId: "paired-run",
        incidentId: inc.id,
        requestedAt,
        applyAt: runner.state.tick,
        data: { ...outcome, speed: cfg.latencyTimeScale },
      };
      runner.apply({ k: "entry", at: runner.state.tick, signed: { entry, sig: "local" } });
      runner.advance(cfg.operatorDelaySeconds);
      if (isResolved(inc)) break;
      // SIMULATED OPERATOR (labelled): approves every policy-valid pending recommendation; identical in both modes.
      let n = 0;
      for (const rec of [...inc.recommendations]) {
        if (rec.investigationId !== entry.entryId) continue;
        const chk = checkDecision(runner.state, inc.id, rec.id, "approve");
        if (rec.validation.status === "rejected" || !chk.ok) {
          rejected.push(rec.actionId);
          continue;
        }
        n += 1;
        const d: WorkflowEntry = {
          kind: "decision",
          entryId: `PAIR-${mode}-R${round}-DEC${n}`,
          sessionId: "paired-run",
          incidentId: inc.id,
          recommendationId: rec.id,
          decision: "approve",
          applyAt: runner.state.tick,
          wallMs: Date.now(),
          actor: "simulated_operator",
        };
        applyCommand(runner.state, { k: "entry", at: runner.state.tick, signed: { entry: d, sig: "local" } });
        approved.push(rec.actionId + (rec.targetEntityId ? `→${rec.targetEntityId}` : ""));
      }
      const until = Math.min(endAt, runner.state.tick + cfg.reinvestigateEverySeconds);
      runner.advanceUntil((st) => st.incidents[0].status === "resolved" || st.tick >= until, until + 1);
      if (isResolved(inc) || runner.state.tick >= endAt) break;
    }
    runner.advanceUntil((st) => st.incidents[0].status === "resolved" || st.tick >= endAt, endAt + 1);
  }
  const fin = runner.state;
  const incident = fin.incidents[0] ?? null;
  return {
    mode,
    metrics: incidentMetrics(fin, incident, triggerAt),
    diagnosisSummary: incident?.investigations[0]?.diagnosis.summary ?? null,
    topCause: incident?.investigations[0]?.diagnosis.likelyCauses[0]?.category ?? null,
    approvedActions: approved,
    rejectedByPolicy: rejected,
    investigationTicks: ticks,
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
  const off = await runMode(cfg, "ai_off", investigate);
  const on = await runMode(cfg, "ai_on", investigate);
  const observe = Math.max(off.metrics.observationWindowS, on.metrics.observationWindowS, 60);
  const notes = [
    "SIMULATED RESULTS. Both runs use the same seed, scenario, initial conditions and deterministic gateway protections.",
    `Simulated operator: approves every policy-valid recommendation after ${cfg.operatorDelaySeconds} sim seconds in BOTH modes. This is not real human behaviour.`,
    `Measured investigation wall-clock latency is converted to simulated seconds at ${cfg.latencyTimeScale} sim-s per real second (minimum 1 tick).`,
    `If unresolved, the incident is re-investigated every ${cfg.reinvestigateEverySeconds} sim seconds (max ${cfg.maxInvestigations} investigations), identically in both modes.`,
  ];
  if (on.metrics.diagnosisSource !== "llm") notes.push(`AI ON run did not receive a real LLM response (${on.metrics.errorCategory ?? "unknown"}); it used the rule-based fallback, so this pair does not measure AI value.`);
  return {
    config: cfg,
    label,
    off,
    on,
    controlsCounterfactual: counterfactual(cfg, true, observe),
    protectedBaseline: (() => {
      const c = counterfactual(cfg, false, observe);
      return { retailBreachSeconds: c.retailBreachSeconds, otherPartnerImpairedSeconds: c.otherPartnerImpairedSeconds, primaryDowntimeSeconds: c.primaryDowntimeSeconds };
    })(),
    notes,
  };
}
