import { z } from "zod";
import { CAUSE_CATEGORIES } from "../sim/types";

const str = (max: number) => z.string().trim().min(1).max(max);

export const CauseCategorySchema = z.enum(CAUSE_CATEGORIES as unknown as [string, ...string[]]);

export const DiagnosisSchema = z.object({
  summary: str(600),
  severity: z.enum(["low", "medium", "high", "critical"]),
  primaryEntityId: z.string().max(32).nullable(),
  likelyCauses: z
    .array(
      z.object({
        cause: str(300),
        category: CauseCategorySchema,
        confidence: z.number().min(0).max(1),
        evidence: z.array(str(300)).max(6),
        limitations: z.array(str(300)).max(4),
      }),
    )
    .min(1)
    .max(4),
  observedFacts: z.array(str(300)).max(10),
  inferences: z.array(str(300)).max(6),
  unknowns: z.array(str(300)).max(6),
  recommendedActions: z
    .array(
      z.object({
        actionId: z.string().trim().min(1).max(64),
        targetEntityId: z.string().max(32).nullable(),
        rationale: str(400),
      }),
    )
    .max(4),
  nextSteps: z.array(str(300)).max(5),
  reasoningSummary: str(800),
  requiresHumanApproval: z.boolean(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

const LIMITS: Record<string, number> = {
  summary: 600,
  cause: 300,
  rationale: 400,
  reasoningSummary: 800,
};

/**
 * Light, documented normalisation before strict validation: truncate
 * over-long strings/arrays, clamp confidence, and coerce numeric strings.
 * It never invents missing fields — missing required data still fails.
 */
export function normaliseDiagnosisCandidate(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const o = { ...(input as Record<string, unknown>) };
  const trunc = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
  const arr = (v: unknown, n: number, each = 300) => (Array.isArray(v) ? v.slice(0, n).map((x) => trunc(x, each)) : v);
  o.summary = trunc(o.summary, LIMITS.summary);
  o.reasoningSummary = trunc(o.reasoningSummary, LIMITS.reasoningSummary);
  if (typeof o.severity === "string") o.severity = o.severity.toLowerCase();
  o.observedFacts = arr(o.observedFacts, 10);
  o.inferences = arr(o.inferences, 6);
  o.unknowns = arr(o.unknowns, 6);
  o.nextSteps = arr(o.nextSteps, 5);
  if (o.primaryEntityId === undefined) o.primaryEntityId = null;
  if (Array.isArray(o.likelyCauses)) {
    o.likelyCauses = o.likelyCauses.slice(0, 4).map((c) => {
      if (!c || typeof c !== "object") return c;
      const cc = { ...(c as Record<string, unknown>) };
      cc.cause = trunc(cc.cause, LIMITS.cause);
      if (typeof cc.confidence === "string") cc.confidence = Number(cc.confidence);
      if (typeof cc.confidence === "number" && Number.isFinite(cc.confidence)) {
        cc.confidence = cc.confidence > 1 && cc.confidence <= 100 ? cc.confidence / 100 : Math.min(1, Math.max(0, cc.confidence));
      }
      cc.evidence = arr(cc.evidence, 6);
      cc.limitations = arr(cc.limitations ?? [], 4);
      return cc;
    });
  }
  if (Array.isArray(o.recommendedActions)) {
    o.recommendedActions = o.recommendedActions.slice(0, 4).map((a) => {
      if (!a || typeof a !== "object") return a;
      const aa = { ...(a as Record<string, unknown>) };
      aa.rationale = trunc(aa.rationale, LIMITS.rationale);
      if (aa.targetEntityId === undefined || aa.targetEntityId === "") aa.targetEntityId = null;
      return aa;
    });
  }
  return o;
}

export type ParseResult = { ok: true; diagnosis: Diagnosis } | { ok: false; error: string };

export function parseDiagnosisText(text: string): ParseResult {
  let raw: unknown;
  const trimmed = text.trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // Some providers wrap JSON in prose or code fences; extract the outermost object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, error: "Response was not JSON" };
    try {
      raw = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return { ok: false, error: "Response contained malformed JSON" };
    }
  }
  return validateDiagnosis(raw);
}

export function validateDiagnosis(raw: unknown): ParseResult {
  const res = DiagnosisSchema.safeParse(normaliseDiagnosisCandidate(raw));
  if (!res.success) {
    const first = res.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `Schema validation failed — ${first.join("; ")}` };
  }
  return { ok: true, diagnosis: res.data };
}
