import { z } from "zod";
import { errorResponse, HttpError, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { stateSummary } from "@/lib/server/summary";
import { stepN } from "@/lib/sim/engine";

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema, ticks: z.number().int().min(1).max(600) });

/** Server-side advance for headless API use. The browser normally steps the same deterministic engine locally. */
export async function POST(req: Request) {
  try {
    const body = await readJson(req, Body);
    const { state, log } = replayVerified(body.session, body.log);
    if (state.tick + body.ticks > state.config.maxTicks) throw new HttpError(422, "max_ticks", `Session is limited to ${state.config.maxTicks} simulated seconds; reset the demo`);
    const since = state.tick;
    stepN(state, body.ticks);
    return json({ log: { ...log, tick: state.tick }, state: stateSummary(state, since) });
  } catch (e) {
    return errorResponse(e, "demo/tick");
  }
}
