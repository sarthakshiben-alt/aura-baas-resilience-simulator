import { randomUUID } from "node:crypto";
import { z } from "zod";
import { enforceRateLimit, errorResponse, HttpError, json, readJson } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { serverInvestigator } from "@/lib/server/investigator";
import { LIMITS } from "@/lib/server/ratelimit";
import { verifySession } from "@/lib/server/session";
import { repository, withTimeout } from "@/lib/server/persistence";
import { log } from "@/lib/server/logger";
import { runPairedComparison } from "@/lib/comparison/paired";
import { isPartnerId } from "@/lib/sim/types";

export const maxDuration = 60;

const Body = z
  .object({
    session: z.string().min(10).max(512),
    goldenId: z.string().regex(/^GS-\d{2}$/).optional(),
    scenarioId: z.string().min(1).max(40).optional(),
    target: z.string().max(20).nullable().optional(),
    seed: z.number().int().min(1).max(2_147_483_646).optional(),
    operatorDelaySeconds: z.number().int().min(0).max(300).default(20),
    latencyTimeScale: z.number().min(1).max(60).default(1),
    maxSeconds: z.number().int().min(60).max(3600).default(2400),
    manualTriageMinutes: z.number().min(0).max(30).default(10),
    reinvestigateEverySeconds: z.number().int().min(20).max(300).default(60),
    maxInvestigations: z.number().int().min(1).max(3).default(3),
    /** Smart AI routing in the AI-assisted arm. */
    aiRouting: z.boolean().default(false),
  })
  .refine((b) => !!b.goldenId !== !!b.scenarioId, "Provide exactly one of goldenId or scenarioId");

/**
 * Approach A — paired runs (AI OFF then AI ON) from identical initial
 * conditions. Results are SIMULATED and persisted per mode.
 */
export async function POST(req: Request) {
  try {
    enforceRateLimit(req, "comparison", LIMITS.comparison);
    const body = await readJson(req, Body);
    const claims = verifySession(serverEnv().sessionSecret, body.session);
    if (!claims) throw new HttpError(401, "invalid_session", "Session token is invalid; reset the demo");
    if (body.target && !isPartnerId(body.target)) throw new HttpError(422, "validation_error", "Target must be a partner id");
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await runPairedComparison(
        {
          goldenId: body.goldenId,
          scenarioId: body.scenarioId,
          target: (body.target as never) ?? null,
          seed: body.seed ?? claims.seed,
          operatorDelaySeconds: body.operatorDelaySeconds,
          maxSeconds: body.maxSeconds,
          latencyTimeScale: body.latencyTimeScale,
          reinvestigateEverySeconds: body.reinvestigateEverySeconds,
          maxInvestigations: body.maxInvestigations,
          manualTriageSeconds: Math.round(body.manualTriageMinutes * 60),
        },
        serverInvestigator({ routing: body.aiRouting }),
      );
    } catch (err) {
      if ((err as Error).message?.startsWith("unknown")) throw new HttpError(422, "validation_error", "Unknown scenario");
      throw err;
    }
    const pairId = randomUUID();
    const completedAt = new Date().toISOString();
    const rows = (["off", "rules", "on"] as const).map((m) => ({
      id: randomUUID(),
      pair_id: pairId,
      session_id: claims.sid,
      kind: "paired",
      scenario_id: body.goldenId ?? body.scenarioId ?? null,
      mode: m === "on" ? "ai_on" : "ai_off",
      workflow: result[m].workflow,
      seed: result.config.seed,
      started_at: startedAt,
      completed_at: completedAt,
      metrics_json: result[m].metrics,
      result_json: { ...result[m], timeline: undefined, label: result.label, notes: result.notes },
    }));
    try {
      await withTimeout(repository().insertComparisonRuns(rows), 4000);
    } catch (err) {
      log("warn", "comparison_persist_failed", { message: String((err as Error).message).slice(0, 200) });
    }
    return json({ id: pairId, simulated: true, ...result });
  } catch (e) {
    return errorResponse(e, "comparisons/run");
  }
}
