import { requestTime } from "@/lib/server/dynamic";
import { errorResponse, HttpError, json } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { verifySession } from "@/lib/server/session";
import { repository } from "@/lib/server/persistence";
import { SESSION_HEADER } from "@/lib/client-shared";

/** Persisted paired comparison (both modes), scoped to the caller's session. */
export async function GET(req: Request, ctx: RouteContext<"/api/comparisons/[id]">) {
  try {
    await requestTime();
    const claims = verifySession(serverEnv().sessionSecret, req.headers.get(SESSION_HEADER));
    if (!claims) throw new HttpError(401, "invalid_session", `Provide a valid ${SESSION_HEADER} header`);
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(422, "validation_error", "Invalid comparison id");
    const rows = await repository().getComparison(claims.sid, id);
    if (!rows.length) throw new HttpError(404, "not_found", "Comparison not found for this session");
    return json({ simulated: true, id, runs: rows });
  } catch (e) {
    return errorResponse(e, "comparisons/get");
  }
}
