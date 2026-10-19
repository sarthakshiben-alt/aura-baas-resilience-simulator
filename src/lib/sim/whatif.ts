import { PROTECTED_CONTROLS, UNCONTROLLED_CONTROLS } from "./config";
import { createInitialState, stepN } from "./engine";
import { startScenario } from "./workflow";
import type { EntityId, SimState } from "./types";
import { PARTNER_IDS } from "./types";

export interface WhatIfResult {
  rows: { t: number; retailOn: number | null; retailOff: number | null; otherOn: number | null; otherOff: number | null; targetInFlightOn: number; targetInFlightOff: number }[];
  observedPartner: EntityId;
  summary: Record<"on" | "off", { retailBreachSeconds: number; otherPartnerImpairedSeconds: number; peakUtilisation: number; targetSuccessRate: number }>;
}

/**
 * Same scenario, same seed, no human actions: deterministic protections ON vs
 * OFF. Illustrates what the gateway controls alone contribute.
 */
export function runWhatIf(scenarioId: string, target: EntityId | null, seed = 7, seconds = 180): WhatIfResult {
  const run = (controls: typeof PROTECTED_CONTROLS): SimState => {
    const s = createInitialState({ seed, controls });
    stepN(s, 10);
    startScenario(s, scenarioId, target);
    stepN(s, seconds);
    return s;
  };
  const on = run(PROTECTED_CONTROLS);
  const off = run(UNCONTROLLED_CONTROLS);
  const observed: EntityId = PARTNER_IDS.find((p) => p !== target) ?? "partner-b";
  const ti: EntityId = target ?? "partner-a";
  const rows = on.history.gateway.map((g, i) => ({
    t: g.t,
    retailOn: g.retailP95Ms,
    retailOff: off.history.gateway[i]?.retailP95Ms ?? null,
    otherOn: on.history.entities[observed][i]?.p95Ms ?? null,
    otherOff: off.history.entities[observed][i]?.p95Ms ?? null,
    targetInFlightOn: on.history.entities[ti][i]?.inFlight ?? 0,
    targetInFlightOff: off.history.entities[ti][i]?.inFlight ?? 0,
  }));
  const summarize = (s: SimState) => ({
    retailBreachSeconds: s.history.gateway.filter((g) => g.retailHealth === "breach").length,
    otherPartnerImpairedSeconds: PARTNER_IDS.filter((p) => p !== target).reduce((sum, p) => sum + s.history.entities[p].filter((x) => x.status !== "healthy" && x.status !== "recovering").length, 0),
    peakUtilisation: Math.max(...s.history.gateway.map((g) => g.utilisation)),
    targetSuccessRate: s.history.entities[ti].slice(10).reduce((a, x) => a + x.successRate, 0) / Math.max(1, s.history.entities[ti].length - 10),
  });
  return { rows, observedPartner: observed, summary: { on: summarize(on), off: summarize(off) } };
}
