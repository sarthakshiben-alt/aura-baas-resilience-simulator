import { z } from "zod";
import { ALLOWED_TIMEOUTS_MS } from "../sim/config";
import type { SimState } from "../sim/types";
import { CommandError, replay, type SignedEntry, type SimLog } from "../sim/workflow";
import { log } from "./logger";
import { clientKey, rateLimit } from "./ratelimit";
import { verifyEntry, verifySession, type SessionClaims } from "./session";
import { serverEnv } from "./env";

export const MAX_BODY_BYTES = 512 * 1024;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Maps known errors to safe responses; never exposes stack traces. */
export function errorResponse(err: unknown, route: string) {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
  if (err instanceof CommandError) return json({ error: { code: err.code, message: err.message } }, err.status);
  log("error", "unhandled_route_error", { route, name: (err as Error)?.name, message: String((err as Error)?.message ?? "").slice(0, 200) });
  return json({ error: { code: "internal_error", message: "An internal error occurred. The simulation state is unaffected." } }, 500);
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new HttpError(422, "validation_error", `Invalid request: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim());
  }
  return res.data;
}

export function enforceRateLimit(req: Request, route: string, limit: { max: number; windowMs: number }) {
  const r = rateLimit(`${route}:${clientKey(req)}`, limit.max, limit.windowMs);
  if (!r.ok) throw new HttpError(429, "rate_limited", `Too many requests; retry in ${r.retryAfterS}s`, { "retry-after": String(r.retryAfterS) });
}

// ---------------------------------------------------------------- schemas

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_\-:.]+$/);

const WorkflowEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("investigation"),
    entryId: id,
    sessionId: id,
    incidentId: id,
    requestedAt: z.number().int().min(0),
    applyAt: z.number().int().min(0),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("decision"),
    entryId: id,
    sessionId: id,
    incidentId: id,
    recommendationId: id,
    decision: z.enum(["approve", "reject", "cancel"]),
    applyAt: z.number().int().min(0),
    wallMs: z.number(),
    actor: z.enum(["human", "simulated_operator"]),
  }),
]);

export const SignedEntrySchema = z.object({ entry: WorkflowEntrySchema, sig: z.string().min(10).max(128) });

export const ControlsPatchSchema = z
  .object({
    isolationEnabled: z.boolean().optional(),
    breakerEnabled: z.boolean().optional(),
    retailReservationEnabled: z.boolean().optional(),
    timeoutMs: z.number().int().refine((v) => (ALLOWED_TIMEOUTS_MS as readonly number[]).includes(v), "unsupported timeout").optional(),
    perPartnerLimit: z.number().int().min(10).max(400).optional(),
    retailReservationSlots: z.number().int().min(0).max(220).optional(),
  })
  .strict();

export const CommandSchema = z.discriminatedUnion("k", [
  z.object({ k: z.literal("start"), at: z.number().int().min(0), scenarioId: z.string().min(1).max(40), target: z.string().max(20).nullable().optional() }),
  z.object({ k: z.literal("stop"), at: z.number().int().min(0), runId: id }),
  z.object({ k: z.literal("controls"), at: z.number().int().min(0), patch: ControlsPatchSchema }),
  z.object({ k: z.literal("entry"), at: z.number().int().min(0), signed: SignedEntrySchema }),
]);

export const SimLogSchema = z.object({
  v: z.literal(1),
  seed: z.number().int(),
  tick: z.number().int().min(0).max(7200),
  commands: z.array(CommandSchema).max(400),
});

export const SessionRequestSchema = z.object({ session: z.string().min(10).max(512), log: SimLogSchema });

export interface VerifiedSession {
  claims: SessionClaims;
  state: SimState;
  log: SimLog;
}

/** Verify session + every signed entry, then replay deterministically. */
export function replayVerified(session: string, logIn: z.infer<typeof SimLogSchema>): VerifiedSession {
  const secret = serverEnv().sessionSecret;
  const claims = verifySession(secret, session);
  if (!claims) throw new HttpError(401, "invalid_session", "Session token is invalid or expired; reset the demo");
  if (logIn.seed !== claims.seed) throw new HttpError(403, "seed_mismatch", "Log seed does not match the session");
  const simLog = logIn as SimLog;
  const state = replay(simLog, { verifyEntry: (s: SignedEntry) => verifyEntry(secret, claims.sid, s) });
  return { claims, state, log: simLog };
}
