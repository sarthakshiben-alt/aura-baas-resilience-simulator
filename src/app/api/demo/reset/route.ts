import { z } from "zod";
import { enforceRateLimit, errorResponse, json, readJson } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { issueSession } from "@/lib/server/session";
import { LIMITS } from "@/lib/server/ratelimit";
import { DEFAULT_SEED } from "@/lib/client-shared";

const Body = z.object({ seed: z.number().int().min(1).max(2_147_483_646).optional() }).strict();

/** Issues a fresh signed session at the known baseline (tick 0, default protections). */
export async function POST(req: Request) {
  try {
    enforceRateLimit(req, "reset", LIMITS.session);
    const body = await readJson(req, Body);
    const { token, claims } = issueSession(serverEnv().sessionSecret, body.seed ?? DEFAULT_SEED);
    return json({ session: token, sessionId: claims.sid, log: { v: 1, seed: claims.seed, tick: 0, commands: [] } });
  } catch (e) {
    return errorResponse(e, "demo/reset");
  }
}
