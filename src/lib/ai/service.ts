import type { IncidentContext } from "./context";
import { buildInvestigationUserMessage, INVESTIGATION_SYSTEM_PROMPT } from "./prompt";
import { AIProviderError, FaultInjectingProvider, type AIErrorCategory, type AIProvider } from "./provider";
import { ruleBasedDiagnosis } from "./rules";
import { parseDiagnosisText, type Diagnosis } from "./schema";
import type { InvestigationMode } from "../sim/types";
import { isEntityId } from "../sim/types";
import type { InvestigationData } from "../sim/workflow";

export type InvestigationOutcome = Omit<InvestigationData, "speed">;

export interface InvestigateOptions {
  context: IncidentContext;
  mode: InvestigationMode;
  provider: AIProvider | null;
  /** Total wall-clock budget for all LLM attempts. */
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens?: number;
  fault?: "timeout" | "malformed" | null;
  maxConcurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

// Per-instance concurrency guard for live AI calls.
let inFlight = 0;
export function aiInFlight() {
  return inFlight;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function postValidate(d: Diagnosis): { diagnosis: Diagnosis; notes: string[] } {
  const notes: string[] = [];
  let primary = d.primaryEntityId;
  if (primary !== null && primary !== "platform" && !isEntityId(primary)) {
    notes.push(`Model referenced an unknown entity "${primary.slice(0, 32)}"; primaryEntityId cleared.`);
    primary = null;
  }
  if (!d.requiresHumanApproval) notes.push("Model returned requiresHumanApproval=false; overridden — human approval is always required.");
  return { diagnosis: { ...d, primaryEntityId: primary, requiresHumanApproval: true }, notes };
}

/**
 * Provider-independent incident investigation.
 * - AI OFF → deterministic rule-based investigator (conventional workflow).
 * - AI ON  → configured LLM; on any failure, the failure is recorded and the
 *   rule-based assessment is returned, labelled "rule_based_fallback".
 * The simulation never waits on this function.
 */
export async function investigateIncident(opts: InvestigateOptions): Promise<InvestigationOutcome> {
  const startedAtWallMs = Date.now();
  const t0 = performance.now();
  const log = opts.log ?? (() => {});

  if (opts.mode === "ai_off") {
    const diagnosis = ruleBasedDiagnosis(opts.context);
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    return {
      mode: "ai_off",
      workflow: "automated_rules",
      assumedTriageSeconds: 0,
      source: "rule_based",
      status: "succeeded",
      provider: "rules",
      model: null,
      latencyMs,
      llmLatencyMs: null,
      startedAtWallMs,
      completedAtWallMs: Date.now(),
      firstResponseMs: null,
      attempts: 0,
      errorCategory: null,
      llmError: null,
      usage: null,
      fallbackUsed: false,
      faultInjected: null,
      validationNotes: [],
      diagnosis,
    };
  }

  const provider: AIProvider | null = opts.fault ? new FaultInjectingProvider(opts.provider?.model ?? "none", opts.fault) : opts.provider;
  let attempts = 0;
  let errorCategory: AIErrorCategory | null = null;
  let llmError: string | null = null;
  let headersMs: number | null = null;
  let usage: InvestigationOutcome["usage"] = null;
  let diagnosis: Diagnosis | null = null;
  let notes: string[] = [];
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxConc = opts.maxConcurrency ?? 2;
  let llmStart: number | null = null;

  if (!provider) {
    errorCategory = "not_configured";
    llmError = "Live AI is not configured on this deployment (no provider/model/key).";
  } else if (inFlight >= maxConc) {
    errorCategory = "concurrency_limited";
    llmError = `Too many concurrent AI investigations (limit ${maxConc}).`;
  } else {
    inFlight += 1;
    llmStart = performance.now();
    const deadline = Date.now() + opts.timeoutMs;
    try {
      for (;;) {
        attempts += 1;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AIProviderError("timeout", `No time budget left after ${attempts - 1} attempt(s)`, false);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        try {
          const res = await provider.complete({ system: INVESTIGATION_SYSTEM_PROMPT, user: buildInvestigationUserMessage(opts.context), signal: controller.signal, maxTokens: opts.maxOutputTokens ?? 3000 });
          headersMs ??= res.headersMs;
          usage = res.usage;
          const parsed = parseDiagnosisText(res.text);
          if (!parsed.ok) throw new AIProviderError("malformed_output", parsed.error, false);
          const pv = postValidate(parsed.diagnosis);
          diagnosis = pv.diagnosis;
          notes = pv.notes;
          break;
        } catch (err) {
          const e = err instanceof AIProviderError ? err : new AIProviderError("network_error", "Unexpected provider failure", true);
          const left = deadline - Date.now();
          const backoff = Math.min(4000, 250 * 2 ** (attempts - 1)) * (0.5 + random() * 0.5);
          const wait = Math.max(backoff, e.retryAfterMs ?? 0);
          log("ai_attempt_failed", { attempt: attempts, category: e.category, retryable: e.retryable });
          if (!e.retryable || attempts > opts.maxRetries || wait >= left) throw e;
          await sleep(wait);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      const e = err as AIProviderError;
      errorCategory = e.category ?? "network_error";
      llmError = e.message?.slice(0, 200) ?? "LLM investigation failed";
    } finally {
      inFlight -= 1;
    }
  }

  const llmLatencyMs = llmStart === null ? null : Math.round(performance.now() - llmStart);
  if (diagnosis && provider) {
    return {
      mode: "ai_on",
      workflow: "ai_assisted",
      assumedTriageSeconds: 0,
      source: "llm",
      status: "succeeded",
      provider: provider.id,
      model: provider.model,
      latencyMs: Math.round(performance.now() - t0),
      llmLatencyMs,
      startedAtWallMs,
      completedAtWallMs: Date.now(),
      firstResponseMs: headersMs,
      attempts,
      errorCategory: null,
      llmError: null,
      usage,
      fallbackUsed: false,
      faultInjected: null,
      validationNotes: notes,
      diagnosis,
    };
  }

  // Fallback: deterministic assessment, clearly labelled.
  let fallback: Diagnosis | null = null;
  try {
    fallback = ruleBasedDiagnosis(opts.context);
  } catch {
    fallback = null;
  }
  log("ai_fallback", { category: errorCategory, fault: opts.fault ?? null });
  return {
    mode: "ai_on",
    workflow: "ai_assisted",
    assumedTriageSeconds: 0,
    source: "rule_based_fallback",
    status: fallback ? "fallback" : "failed",
    provider: provider?.id ?? "none",
    model: opts.fault ? null : provider?.model ?? null,
    latencyMs: Math.round(performance.now() - t0),
    llmLatencyMs,
    startedAtWallMs,
    completedAtWallMs: Date.now(),
    firstResponseMs: headersMs,
    attempts,
    errorCategory,
    llmError,
    usage,
    fallbackUsed: !!fallback,
    faultInjected: opts.fault ?? null,
    validationNotes: [],
    diagnosis: fallback ?? {
      summary: "Investigation failed: neither the LLM nor the rule-based assessment produced a diagnosis.",
      severity: "medium",
      primaryEntityId: null,
      likelyCauses: [{ cause: "Unknown", category: "insufficient_evidence", confidence: 0, evidence: [], limitations: ["No diagnosis available"] }],
      observedFacts: [],
      inferences: [],
      unknowns: ["All investigation paths failed"],
      recommendedActions: [{ actionId: "escalate_to_operator", targetEntityId: null, rationale: "Automated investigation failed" }],
      nextSteps: ["Retry the investigation"],
      reasoningSummary: "No diagnosis available.",
      requiresHumanApproval: true,
    },
  };
}
