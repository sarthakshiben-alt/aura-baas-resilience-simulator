import { requestTime } from "@/lib/server/dynamic";
import { z } from "zod";
import { errorResponse, HttpError, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { verifySession } from "@/lib/server/session";
import { repository } from "@/lib/server/persistence";
import { findIncident } from "@/lib/sim/engine";
import { getAction } from "@/lib/sim/actions";
import { SESSION_HEADER } from "@/lib/client-shared";

export async function GET(req: Request, ctx: RouteContext<"/api/incidents/[id]/recommendations">) {
  try {
    await requestTime();
    const claims = verifySession(serverEnv().sessionSecret, req.headers.get(SESSION_HEADER));
    if (!claims) throw new HttpError(401, "invalid_session", `Provide a valid ${SESSION_HEADER} header`);
    const { id } = await ctx.params;
    if (!/^INC-\d{3}$/.test(id)) throw new HttpError(422, "validation_error", "Invalid incident id");
    const rec = await repository().getIncident(claims.sid, id);
    if (!rec) throw new HttpError(404, "not_found", "Incident not found for this session");
    return json({ simulated: true, source: "persisted", recommendations: rec.recommendations });
  } catch (e) {
    return errorResponse(e, "recommendations/get");
  }
}

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema });

export async function POST(req: Request, ctx: RouteContext<"/api/incidents/[id]/recommendations">) {
  try {
    const { id } = await ctx.params;
    const body = await readJson(req, Body);
    const { state } = replayVerified(body.session, body.log);
    const inc = findIncident(state, id);
    if (!inc) throw new HttpError(404, "unknown_incident", `Incident ${id} not found`);
    return json({
      simulated: true,
      source: "replay",
      recommendations: inc.recommendations.map((r) => ({ ...r, action: getAction(r.actionId) })),
    });
  } catch (e) {
    return errorResponse(e, "recommendations/post");
  }
}
