import { z } from "zod";
import type { IncidentContext } from "./context";
import { ASSISTANT_SYSTEM_PROMPT, buildAssistantUserMessage } from "./prompt";
import { AIProviderError, type AIProvider } from "./provider";
import { ruleBasedDiagnosis } from "./rules";

export const SUGGESTED_QUESTIONS = [
  "What is happening?",
  "Which partner is causing the greatest resource pressure?",
  "What evidence supports the diagnosis?",
  "Is retail banking affected?",
  "What is the safest next action?",
  "What information is still missing?",
  "Has the proposed action improved recovery?",
] as const;

export const AnswerSchema = z.object({
  answer: z.string().trim().min(1).max(1200),
  evidence: z.array(z.string().max(300)).max(5),
  missingInformation: z.array(z.string().max(300)).max(4),
  confidence: z.number().min(0).max(1),
});

export interface AssistantAnswer {
  source: "llm" | "rule_based" | "rule_based_fallback";
  answer: string;
  evidence: string[];
  missingInformation: string[];
  confidence: number | null;
  provider: string;
  model: string | null;
  latencyMs: number;
  errorCategory: string | null;
}

const f = (n: number | null | undefined, u = "") => (n === null || n === undefined ? "n/a" : `${Math.round(n * 10) / 10}${u}`);

/** Deterministic answers for the suggested questions, computed from the context. */
export function ruleBasedAnswer(ctx: IncidentContext, question: string): Omit<AssistantAnswer, "source" | "provider" | "model" | "latencyMs" | "errorCategory"> {
  const d = ruleBasedDiagnosis(ctx);
  const partners = ctx.entities.filter((e) => e.id !== "retail");
  const retail = ctx.entities.find((e) => e.id === "retail")!;
  const qn = question.trim().toLowerCase();
  const idx = SUGGESTED_QUESTIONS.findIndex((s) => s.toLowerCase() === qn);
  switch (idx) {
    case 0:
      return { answer: d.summary, evidence: d.observedFacts.slice(0, 4), missingInformation: d.unknowns.slice(0, 2), confidence: d.likelyCauses[0].confidence };
    case 1: {
      const top = [...partners].sort((a, b) => b.last60s.peakInFlight - a.last60s.peakInFlight)[0];
      const share = ctx.gateway.capacitySlots ? (100 * top.last60s.peakInFlight) / ctx.gateway.capacitySlots : 0;
      return {
        answer: `${top.name} held the most gateway slots in the last 60 s (peak in-flight ${f(top.last60s.peakInFlight)}, ≈${f(share, "%")} of ${ctx.gateway.capacitySlots} slots; limit ${top.concurrencyLimit ?? "none"}).`,
        evidence: partners.map((p) => `${p.name}: peak in-flight ${f(p.last60s.peakInFlight)}, now ${f(p.now.inFlight)}`).slice(0, 5),
        missingInformation: [],
        confidence: 0.9,
      };
    }
    case 2:
      return { answer: `Top cause (${d.likelyCauses[0].category}): ${d.likelyCauses[0].cause}`, evidence: d.likelyCauses[0].evidence.slice(0, 5), missingInformation: d.likelyCauses[0].limitations.slice(0, 4), confidence: d.likelyCauses[0].confidence };
    case 3:
      return {
        answer: `Retail banking is ${ctx.gateway.retailHealth.replace("_", " ")}: P95 ${f(retail.now.p95Ms, " ms")} against a ${ctx.thresholds.retailTargetP95Ms} ms simulated target${ctx.incident ? `; ${ctx.incident.retailBreachSeconds}s of breach recorded in ${ctx.incident.id}` : ""}.`,
        evidence: [`Retail peak P95 last 60 s: ${f(retail.last60s.peakP95Ms, " ms")}`, `Retail reservation ${ctx.gateway.controls.retailReservationEnabled ? `ON (${ctx.gateway.controls.retailReservationSlots} slots)` : "OFF"}`, `Retail pool utilisation ${f(ctx.gateway.retailPoolUtilisationPct, "%")}`],
        missingInformation: [],
        confidence: 0.95,
      };
    case 4: {
      const a = d.recommendedActions[0];
      return {
        answer: a ? `Runbook suggests "${a.actionId}"${a.targetEntityId ? ` on ${a.targetEntityId}` : ""}: ${a.rationale} It still requires policy validation and your approval.` : "No action is suggested by the runbook.",
        evidence: d.recommendedActions.slice(1).map((x) => `Also proposed: ${x.actionId}${x.targetEntityId ? ` → ${x.targetEntityId}` : ""}`),
        missingInformation: [],
        confidence: d.likelyCauses[0].confidence,
      };
    }
    case 5:
      return { answer: "The following cannot be determined from gateway telemetry:", evidence: [], missingInformation: d.unknowns.slice(0, 4), confidence: null };
    case 6: {
      const acts = ctx.priorActions.filter((a) => a.executedAtSimSecond !== null);
      return {
        answer: acts.length ? acts.map((a) => `${a.actionId}: ${a.verification ?? "verification pending"}`).join(" ") : "No simulated action has executed for this incident yet.",
        evidence: acts.map((a) => `${a.actionId} executed at t=${a.executedAtSimSecond}s — ${a.outcome ?? ""}`).slice(0, 5),
        missingInformation: acts.some((a) => !a.verification) ? ["Post-action verification still pending for some actions"] : [],
        confidence: null,
      };
    }
    default:
      return {
        answer: "The rule-based assistant can only answer the suggested questions. Free-form questions need live AI, which is not available for this answer.",
        evidence: [],
        missingInformation: ["Live LLM response"],
        confidence: null,
      };
  }
}

export async function answerQuestion(opts: {
  context: IncidentContext;
  question: string;
  latestSummary: string | null;
  provider: AIProvider | null;
  aiEnabled: boolean;
  timeoutMs: number;
}): Promise<AssistantAnswer> {
  const t0 = performance.now();
  const rb = (source: AssistantAnswer["source"], errorCategory: string | null): AssistantAnswer => ({
    ...ruleBasedAnswer(opts.context, opts.question),
    source,
    provider: "rules",
    model: null,
    latencyMs: Math.round(performance.now() - t0),
    errorCategory,
  });
  if (!opts.aiEnabled) return rb("rule_based", null);
  if (!opts.provider) return rb("rule_based_fallback", "not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.provider.complete({
      system: ASSISTANT_SYSTEM_PROMPT,
      user: buildAssistantUserMessage(opts.context, opts.question, opts.latestSummary),
      signal: controller.signal,
      maxTokens: 1500,
    });
    const text = res.text.trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = AnswerSchema.safeParse(start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null);
    if (!parsed.success) return rb("rule_based_fallback", "malformed_output");
    return { ...parsed.data, source: "llm", provider: opts.provider.id, model: opts.provider.model, latencyMs: Math.round(performance.now() - t0), errorCategory: null };
  } catch (err) {
    return rb("rule_based_fallback", err instanceof AIProviderError ? err.category : err instanceof SyntaxError ? "malformed_output" : "network_error");
  } finally {
    clearTimeout(timer);
  }
}
