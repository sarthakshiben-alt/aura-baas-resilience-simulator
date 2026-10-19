import { after } from "next/server";
import { latest, latestGateway } from "../sim/engine";
import type { EntityId, SimState } from "../sim/types";
import { ENTITY_IDS } from "../sim/types";

/** Compact authoritative view of a replayed state, for API consumers. */
export function stateSummary(state: SimState, telemetrySince?: number) {
  const latestByEntity = Object.fromEntries(ENTITY_IDS.map((id) => [id, latest(state, id)])) as Record<EntityId, ReturnType<typeof latest>>;
  const since = telemetrySince ?? state.tick - 1;
  return {
    simulated: true,
    tick: state.tick,
    controls: state.controls,
    gateway: latestGateway(state),
    entities: latestByEntity,
    incidents: state.incidents,
    scenarioRuns: state.scenarioRuns,
    timeline: state.timeline.slice(-100),
    telemetry: {
      since,
      gateway: state.history.gateway.filter((g) => g.t >= since).slice(-600),
      entities: Object.fromEntries(ENTITY_IDS.map((id) => [id, state.history.entities[id].filter((s) => s.t >= since).slice(-600)])),
    },
  };
}

/** Run work after the response; falls back to fire-and-forget outside a request scope (tests). */
export function runAfter(fn: () => Promise<void>) {
  try {
    after(fn);
  } catch {
    void fn();
  }
}
