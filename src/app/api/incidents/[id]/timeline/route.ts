import { requestTime } from "@/lib/server/dynamic";
import { z } from "zod";
import { errorResponse, HttpError, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { verifySession } from "@/lib/server/session";
import { repository } from "@/lib/server/persistence";
import { findIncident } from "@/lib/sim/engine";
import { SESSION_HEADER } from "@/lib/client-shared";

/** Timeline reconstructed from persisted records (incident timestamps, investigations, audit log). */
export async function GET(req: Request, ctx: RouteContext<"/api/incidents/[id]/timeline">) {
  try {
    await requestTime();
    const claims = verifySession(serverEnv().sessionSecret, req.headers.get(SESSION_HEADER));
    if (!claims) throw new HttpError(401, "invalid_session", `Provide a valid ${SESSION_HEADER} header`);
    const { id } = await ctx.params;
    if (!/^INC-\d{3}$/.test(id)) throw new HttpError(422, "validation_error", "Invalid incident id");
    const rec = await repository().getIncident(claims.sid, id);
    if (!rec) throw new HttpError(404, "not_found", "Incident not found for this session");
    const i = rec.incident;
    const events: { tSimS: number | null; kind: string; detail: string }[] = [
      { tSimS: i.started_at_sim_s as number, kind: "incident_triggered", detail: String(i.scenario_id ?? "") },
      { tSimS: i.detected_at_sim_s as number, kind: "degradation_detected", detail: String(i.partner_id) },
      ...rec.investigations.flatMap((v) => [
        { tSimS: v.requested_at_sim_s as number, kind: "investigation_started", detail: String(v.mode) },
        { tSimS: v.applied_at_sim_s as number, kind: "diagnosis_returned", detail: `${v.source} (${v.latency_ms} ms)` },
      ]),
      ...rec.audit.map((a) => ({ tSimS: a.t_sim_s as number, kind: `action_${a.outcome}`, detail: `${a.action_id} by ${a.actor_type}` })),
      ...(i.recovered_at_sim_s !== null ? [{ tSimS: i.recovered_at_sim_s as number, kind: "recovery_verified", detail: "" }] : []),
    ];
    events.sort((a, b) => (a.tSimS ?? 0) - (b.tSimS ?? 0));
    return json({ simulated: true, source: "persisted", events });
  } catch (e) {
    return errorResponse(e, "incidents/timeline/get");
  }
}

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema });

/** Full timeline from deterministic replay. */
export async function POST(req: Request, ctx: RouteContext<"/api/incidents/[id]/timeline">) {
  try {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const { state } = replayVerified(body.session, body.log);
    const inc = findIncident(state, id);
    if (!inc) throw new HttpError(404, "unknown_incident", `Incident ${id} not found`);
    const events = state.timeline.filter((e) => e.incidentId === id || (e.incidentId === null && inc.affectedEntityIds.includes(e.entityId as never) && e.t >= inc.startedAt));
    return json({ simulated: true, source: "replay", events });
  } catch (e) {
    return errorResponse(e, "incidents/timeline/post");
  }
}
