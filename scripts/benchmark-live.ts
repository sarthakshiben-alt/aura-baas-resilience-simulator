/**
 * Live golden-dataset benchmark against the configured provider.
 * Same scenarios and prompt as the app; only waits out provider rate limits
 * (free tiers allow ~1 investigation/minute) so every scenario gets a genuine
 * LLM attempt. Writes a dated JSON artifact.
 *
 * Usage:
 *   AI_PROVIDER=groq AI_MODEL=<model> AI_API_KEY=<key> AI_TIMEOUT_MS=30000 \
 *     npx tsx scripts/benchmark-live.ts docs/results/benchmark-<date>-<model>.json
 * (Behind an HTTPS proxy, also set NODE_USE_ENV_PROXY=1.)
 */
import { writeFileSync } from "node:fs";
import { serverInvestigator } from "../src/lib/server/investigator";
import { runBenchmark } from "../src/lib/comparison/benchmark";
import type { Investigator } from "../src/lib/comparison/paired";

const WAIT_MS = 25_000;
const MAX_RETRIES = 6;

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: benchmark-live.ts <output.json>");
  const base = serverInvestigator();
  let calls = 0;
  let waits = 0;
  const paced: Investigator = async (ctx, mode, fault) => {
    if (mode === "ai_off" || fault) return base(ctx, mode, fault);
    for (let i = 0; ; i++) {
      calls++;
      const o = await base(ctx, mode, fault);
      if (o.errorCategory !== "rate_limited" || i >= MAX_RETRIES) return o;
      waits++;
      await new Promise((r) => setTimeout(r, WAIT_MS));
    }
  };
  const r = await runBenchmark(paced);
  writeFileSync(out, JSON.stringify({ model: process.env.AI_MODEL, runAt: new Date().toISOString(), pacing: { calls, waits, waitMs: WAIT_MS }, ...r }, null, 1));
  console.log(`DONE ${process.env.AI_MODEL}: ${r.on.realLlmResponses} real LLM responses, ${calls} calls, ${waits} rate-limit waits`);
}

void main();
