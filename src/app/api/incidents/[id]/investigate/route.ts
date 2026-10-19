import { z } from "zod";
import { buildIncidentContext } from "@/lib/ai/context";
import { enforceRateLimit, errorResponse, HttpError, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { serverInvestigator } from "@/lib/server/investigator";
import { LIMITS } from "@/lib/server/ratelimit";
import { newEntryId, signEntry } from "@/lib/server/session";
import { persistState } from "@/lib/server/persistence";
import { runAfter } from "@/lib/server/summary";
import { findIncident } from "@/lib/sim/engine";
import { MAX_INVESTIGATIONS, type WorkflowEntry } from "@/lib/sim/workflow";

export const maxDuration = 30;

const Body = z.object({
  session: z.string().min(10).max(512),
  log: SimLogSchema,
  mode: z.enum(["ai_on", "ai_off"]),
  fault: z.enum(["timeout", "malformed"]).nullable().optional(),
  speed: z.number().min(1).max(60),
});

/**
 * Investigates the incident using telemetry reconstructed by the server from
 * the session log. Returns a signed workflow entry that the client applies at
 * `applyAt` = request tick + measured latency converted to simulated seconds.
 * The simulation keeps running while this request is in flight.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/incidents/[id]/investigate">) {
  try {
    enforceRateLimit(req, "investigate", LIMITS.investigate);
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const { claims, state, log } = replayVerified(body.session, body.log);
    const inc = findIncident(state, id);
    if (!inc) throw new HttpError(404, "unknown_incident", `Incident ${id} not found in this session`);
    if (inc.status === "resolved") throw new HttpError(409, "incident_resolved", `${id} is already resolved`);
    if (inc.investigations.length >= MAX_INVESTIGATIONS) throw new HttpError(429, "too_many_investigations", "Investigation limit reached for this incident");
    const context = buildIncidentContext(state, id);
    const outcome = await serverInvestigator()(context, body.mode, body.mode === "ai_on" ? body.fault ?? null : null);
    const latencyTicks = Math.max(1, Math.ceil((outcome.latencyMs / 1000) * body.speed));
    const entry: WorkflowEntry = {
      kind: "investigation",
      entryId: newEntryId("INV"),
      sessionId: claims.sid,
      incidentId: id,
      requestedAt: log.tick,
      applyAt: log.tick + latencyTicks,
      data: { ...outcome, speed: body.speed },
    };
    runAfter(() => persistState(claims.sid, state));
    return json({ signed: signEntry(serverEnv().sessionSecret, entry), latencyTicks });
  } catch (e) {
    return errorResponse(e, "incidents/investigate");
  }
}
