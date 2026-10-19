import { randomUUID } from "node:crypto";
import { z } from "zod";
import { enforceRateLimit, errorResponse, HttpError, json, readJson } from "@/lib/server/http";
import { serverEnv } from "@/lib/server/env";
import { serverInvestigator } from "@/lib/server/investigator";
import { LIMITS } from "@/lib/server/ratelimit";
import { verifySession } from "@/lib/server/session";
import { repository, withTimeout } from "@/lib/server/persistence";
import { runBenchmark } from "@/lib/comparison/benchmark";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";
import { log } from "@/lib/server/logger";

export const maxDuration = 120;

const Body = z.object({ session: z.string().min(10).max(512), ids: z.array(z.string().regex(/^GS-\d{2}$/)).max(30).optional() });

/** Approach B — golden-dataset investigation benchmark (ILLUSTRATIVE). */
export async function POST(req: Request) {
  try {
    enforceRateLimit(req, "benchmark", LIMITS.benchmark);
    const body = await readJson(req, Body);
    const claims = verifySession(serverEnv().sessionSecret, body.session);
    if (!claims) throw new HttpError(401, "invalid_session", "Session token is invalid; reset the demo");
    const set = body.ids?.length ? GOLDEN_SCENARIOS.filter((g) => body.ids!.includes(g.id)) : GOLDEN_SCENARIOS;
    const startedAt = new Date().toISOString();
    const result = await runBenchmark(serverInvestigator(), set);
    const id = randomUUID();
    try {
      await withTimeout(
        repository().insertComparisonRuns([
          { id, pair_id: id, session_id: claims.sid, kind: "benchmark", scenario_id: null, mode: "benchmark", seed: 0, started_at: startedAt, completed_at: new Date().toISOString(), metrics_json: { off: result.off, on: result.on }, result_json: { rows: result.rows, notes: result.notes } },
        ]),
        4000,
      );
    } catch (err) {
      log("warn", "benchmark_persist_failed", { message: String((err as Error).message).slice(0, 200) });
    }
    return json({ id, simulated: true, ...result });
  } catch (e) {
    return errorResponse(e, "benchmark/run");
  }
}
