import { z } from "zod";
import { buildIncidentContext } from "@/lib/ai/context";
import { answerQuestion } from "@/lib/ai/assistant";
import { enforceRateLimit, errorResponse, HttpError, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { createProvider, serverEnv } from "@/lib/server/env";
import { LIMITS } from "@/lib/server/ratelimit";
import { findIncident } from "@/lib/sim/engine";

export const maxDuration = 30;

const Body = z.object({
  session: z.string().min(10).max(512),
  log: SimLogSchema,
  incidentId: z.string().regex(/^INC-\d{3}$/).nullable(),
  question: z.string().trim().min(2).max(500),
  aiEnabled: z.boolean(),
});

/** Q&A over the CURRENT simulated telemetry. Answers are labelled by source. */
export async function POST(req: Request) {
  try {
    enforceRateLimit(req, "assistant", LIMITS.assistant);
    const body = await readJson(req, Body);
    const { state } = replayVerified(body.session, body.log);
    const inc = body.incidentId ? findIncident(state, body.incidentId) : null;
    if (body.incidentId && !inc) throw new HttpError(404, "unknown_incident", "Incident not found");
    const env = serverEnv();
    const answer = await answerQuestion({
      context: buildIncidentContext(state, inc?.id ?? null),
      question: body.question,
      latestSummary: inc?.investigations.at(-1)?.diagnosis.summary ?? null,
      provider: createProvider(env),
      aiEnabled: body.aiEnabled,
      timeoutMs: env.aiTimeoutMs,
    });
    return json({ simulated: true, atSimSecond: state.tick, ...answer });
  } catch (e) {
    return errorResponse(e, "assistant");
  }
}
