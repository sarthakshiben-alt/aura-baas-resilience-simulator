import { createInitialState, step } from "../sim/engine";
import type { SimState } from "../sim/types";
import { applyCommand, type Command } from "../sim/workflow";
import type { GoldenScenario, ScriptStep } from "./dataset";

export function scriptToCommands(script: ScriptStep[]): Command[] {
  return script.map((s): Command => {
    if (s.op === "start") return { k: "start", at: s.at, scenarioId: s.scenarioId, target: s.target ?? null };
    if (s.op === "recover") return { k: "start", at: s.at, scenarioId: "recovery", target: s.target };
    return { k: "stop", at: s.at, runId: `RUN-${String(s.runIndex + 1).padStart(3, "0")}` };
  });
}

export function goldenCommands(gs: GoldenScenario): Command[] {
  const cmds: Command[] = [];
  if (gs.initialConditions.controlsPatch) cmds.push({ k: "controls", at: 0, patch: gs.initialConditions.controlsPatch });
  return [...cmds, ...scriptToCommands(gs.trigger.script)].sort((a, b) => a.at - b.at);
}

/** Drives a state forward while applying scripted commands at their ticks. */
export class ScriptedRunner {
  state: SimState;
  private pending: Command[];

  constructor(gs: GoldenScenario | null, opts: { seed?: number; commands?: Command[] } = {}) {
    this.state = createInitialState({ seed: opts.seed ?? gs?.initialConditions.seed ?? 42 });
    this.pending = [...(opts.commands ?? (gs ? goldenCommands(gs) : []))].sort((a, b) => a.at - b.at);
    this.applyDue();
  }

  private applyDue() {
    while (this.pending.length && this.pending[0].at === this.state.tick) {
      applyCommand(this.state, this.pending.shift()!);
    }
  }

  /** Apply a command at the current tick (e.g. a workflow entry). */
  apply(cmd: Command) {
    applyCommand(this.state, { ...cmd, at: this.state.tick } as Command);
  }

  advance(n = 1) {
    for (let i = 0; i < n; i++) {
      step(this.state);
      this.applyDue();
    }
  }

  advanceUntil(pred: (s: SimState) => boolean, maxTicks: number): boolean {
    for (let i = 0; i < maxTicks; i++) {
      if (pred(this.state)) return true;
      this.advance(1);
    }
    return pred(this.state);
  }
}
