import { requestTime } from "@/lib/server/dynamic";
import { z } from "zod";
import { errorResponse, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { publicAiStatus } from "@/lib/server/env";
import { persistState } from "@/lib/server/persistence";
import { runAfter, stateSummary } from "@/lib/server/summary";
import { DEFAULT_CONFIG, PROTECTED_CONTROLS, ENTITY_PROFILES } from "@/lib/sim/config";
import { SCENARIOS } from "@/lib/sim/scenarios";
import { ACTIONS } from "@/lib/sim/actions";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";

/** Static catalog + baseline configuration (no session required). */
export async function GET() {
  await requestTime();
  return json({
    simulated: true,
    config: DEFAULT_CONFIG,
    baselineControls: PROTECTED_CONTROLS,
    entities: ENTITY_PROFILES,
    scenarios: Object.values(SCENARIOS).map(({ perturbations, rootCause, ...s }) => {
      void perturbations;
      void rootCause;
      return s;
    }),
    actions: ACTIONS,
    golden: GOLDEN_SCENARIOS.map((g) => ({ id: g.id, title: g.title, description: g.description })),
    ai: publicAiStatus(),
  });
}

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema, telemetrySince: z.number().int().min(0).optional() });

/** Authoritative replay of a session log; also persists incident records. */
export async function POST(req: Request) {
  try {
    const body = await readJson(req, Body);
    const { claims, state } = replayVerified(body.session, body.log);
    runAfter(() => persistState(claims.sid, state));
    return json(stateSummary(state, body.telemetrySince));
  } catch (e) {
    return errorResponse(e, "demo/state");
  }
}
