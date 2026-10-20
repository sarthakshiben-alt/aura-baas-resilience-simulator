import { investigateIncident } from "../ai/service";
import type { Investigator } from "../comparison/paired";
import { createProvider, serverEnv } from "./env";
import { log } from "./logger";

/** Investigator bound to the server's configured provider (or none). `routing` = smart AI routing (AI ON only). */
export function serverInvestigator(opts: { routing?: boolean } = {}): Investigator {
  const env = serverEnv();
  const provider = createProvider(env);
  return (context, mode, fault) =>
    investigateIncident({
      context,
      mode,
      provider,
      timeoutMs: env.aiTimeoutMs,
      maxRetries: env.aiMaxRetries,
      maxConcurrency: env.aiMaxConcurrency,
      maxOutputTokens: env.aiMaxOutputTokens,
      fault,
      routing: mode === "ai_on" && !!opts.routing,
      log: (event, data) => log("info", event, data),
    });
}
