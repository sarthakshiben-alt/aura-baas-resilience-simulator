import { z } from "zod";
import { errorResponse, enforceRateLimit, HttpError, json, readJson, replayVerified, SimLogSchema } from "./http";
import { serverEnv } from "./env";
import { LIMITS } from "./ratelimit";
import { signEntry } from "./session";
import { persistState } from "./persistence";
import { runAfter, stateSummary } from "./summary";
import { applyCommand, checkDecision, type WorkflowEntry } from "../sim/workflow";

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema });

/**
 * Human decision on a recommendation. The server replays the session, checks
 * that the recommendation belongs to this incident, is from the latest
 * investigation, is still pending, and re-runs policy validation. Duplicate
 * submissions are idempotent: the entry id is deterministic per
 * (recommendation, decision) and replay ignores repeats.
 */
export function decisionHandler(decision: "approve" | "reject" | "cancel") {
  return async (req: Request, ctx: { params: Promise<{ id: string; recommendationId: string }> }) => {
    try {
      enforceRateLimit(req, "decision", LIMITS.decision);
      const { id, recommendationId } = await ctx.params;
      const body = await readJson(req, Body);
      const { claims, state, log } = replayVerified(body.session, body.log);
      const prior = log.commands.find(
        (c) => c.k === "entry" && c.signed.entry.kind === "decision" && c.signed.entry.recommendationId === recommendationId && c.signed.entry.decision === decision,
      );
      if (prior) throw new HttpError(409, "duplicate_decision", `This recommendation was already ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled"}; the operation was not executed twice`);
      const check = checkDecision(state, id, recommendationId, decision);
      if (!check.ok) throw new HttpError(check.status, check.code, check.message);
      const entry: WorkflowEntry = {
        kind: "decision",
        entryId: `DEC-${recommendationId}-${decision}`,
        sessionId: claims.sid,
        incidentId: id,
        recommendationId,
        decision,
        applyAt: log.tick,
        wallMs: Date.now(),
        actor: "human",
      };
      const signed = signEntry(serverEnv().sessionSecret, entry);
      applyCommand(state, { k: "entry", at: log.tick, signed });
      runAfter(() => persistState(claims.sid, state));
      const inc = state.incidents.find((i) => i.id === id)!;
      return json({ signed, recommendation: inc.recommendations.find((r) => r.id === recommendationId), state: stateSummary(state) });
    } catch (e) {
      return errorResponse(e, `recommendations/${decision}`);
    }
  };
}
