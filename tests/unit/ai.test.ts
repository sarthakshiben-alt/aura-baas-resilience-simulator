import { describe, expect, it } from "vitest";
import { buildIncidentContext } from "@/lib/ai/context";
import { investigateIncident } from "@/lib/ai/service";
import { AIProviderError, MockProvider } from "@/lib/ai/provider";
import { parseDiagnosisText, validateDiagnosis, type Diagnosis } from "@/lib/ai/schema";
import { ruleBasedDiagnosis } from "@/lib/ai/rules";
import { createProvider, readServerEnv } from "@/lib/server/env";
import { getGolden } from "@/lib/golden/dataset";
import { benchmarkState } from "@/lib/comparison/benchmark";
import { ScriptedRunner } from "@/lib/golden/harness";
import { createInitialState, step, stepN } from "@/lib/sim/engine";
import { validateAction } from "@/lib/sim/policy";
import { applyCommand, checkDecision, startScenario, type WorkflowEntry } from "@/lib/sim/workflow";

function ctxFor(id: string) {
  const { state, incidentId } = benchmarkState(getGolden(id)!);
  return { state, incidentId, ctx: buildIncidentContext(state, incidentId) };
}

const VALID: Diagnosis = {
  summary: "Partner A downstream latency is elevated; breaker open.",
  severity: "medium",
  primaryEntityId: "partner-a",
  likelyCauses: [{ cause: "Partner A downstream latency", category: "partner_downstream_latency", confidence: 0.7, evidence: ["Partner A peak P95 2000 ms"], limitations: ["Internals not visible"] }],
  observedFacts: ["Partner A breaker open"],
  inferences: ["Contained"],
  unknowns: ["Which dependency"],
  recommendedActions: [{ actionId: "escalate_to_partner", targetEntityId: "partner-a", rationale: "Partner must remediate" }],
  nextSteps: ["Approve escalation"],
  reasoningSummary: "Latency rose without traffic change.",
  requiresHumanApproval: true,
};
const ok = (d: unknown) => new MockProvider("mock-model", () => ({ text: JSON.stringify(d), headersMs: 5, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }));
const base = { timeoutMs: 500, maxRetries: 2, sleep: async () => {}, random: () => 0.5 };

describe("AI investigation", () => {
  it("9. a valid model response passes schema validation and is labelled as a real LLM response", async () => {
    const { ctx } = ctxFor("GS-01");
    const out = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: ok(VALID) });
    expect(out.source).toBe("llm");
    expect(out.status).toBe("succeeded");
    expect(out.model).toBe("mock-model");
    expect(out.usage?.totalTokens).toBe(150);
    expect(out.fallbackUsed).toBe(false);
    expect(validateDiagnosis(VALID).ok).toBe(true);
  });

  it("10. malformed model output is handled safely with a labelled fallback", async () => {
    const { ctx } = ctxFor("GS-01");
    for (const text of ["not json", '{"summary": 1}', '{"summary":"x","severity":"high"}']) {
      const p = new MockProvider("m", () => ({ text, headersMs: 1, usage: null }));
      const out = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: p });
      expect(out.source).toBe("rule_based_fallback");
      expect(out.errorCategory).toBe("malformed_output");
      expect(p.calls).toBe(1); // malformed output is not retried
    }
    expect(parseDiagnosisText("```json\n" + JSON.stringify(VALID) + "\n```").ok).toBe(true);
  });

  it("11. provider timeout invokes the fallback within the budget", async () => {
    const { ctx } = ctxFor("GS-01");
    const hang = new MockProvider("m", (req) => new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new AIProviderError("timeout", "timed out", true)))));
    const t0 = Date.now();
    const out = await investigateIncident({ ...base, timeoutMs: 120, context: ctx, mode: "ai_on", provider: hang });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.errorCategory).toBe("timeout");
    expect(out.source).toBe("rule_based_fallback");
    const injected = await investigateIncident({ ...base, timeoutMs: 80, context: ctx, mode: "ai_on", provider: null, fault: "timeout" });
    expect(injected.errorCategory).toBe("timeout");
    expect(injected.faultInjected).toBe("timeout");
    const mal = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: null, fault: "malformed" });
    expect(mal.errorCategory).toBe("malformed_output");
  });

  it("12. missing API credentials do not crash the application", async () => {
    const env = readServerEnv({ AI_PROVIDER: "groq", AI_MODEL: "some-model" } as unknown as NodeJS.ProcessEnv);
    expect(env.aiConfigured).toBe(false);
    expect(env.aiConfigProblem).toMatch(/AI_API_KEY/);
    expect(createProvider(env, {} as unknown as NodeJS.ProcessEnv)).toBeNull();
    const noModel = readServerEnv({ AI_PROVIDER: "groq", AI_API_KEY: "x" } as unknown as NodeJS.ProcessEnv);
    expect(noModel.aiConfigured).toBe(false);
    const { ctx } = ctxFor("GS-01");
    const out = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: null });
    expect(out.errorCategory).toBe("not_configured");
    expect(out.source).toBe("rule_based_fallback");
  });

  it("13. AI failure does not stop the simulation (AI not in the critical path)", async () => {
    const s = createInitialState({ seed: 13 });
    stepN(s, 5);
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 15);
    const ctx = buildIncidentContext(s, s.incidents[0].id);
    const hang = new MockProvider("m", (req) => new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new AIProviderError("timeout", "t", true)))));
    const pending = investigateIncident({ ...base, timeoutMs: 150, context: ctx, mode: "ai_on", provider: hang });
    const before = s.tick;
    for (let i = 0; i < 30; i++) step(s); // simulation keeps running while AI is pending
    expect(s.tick).toBe(before + 30);
    expect(s.timeline.some((e) => e.kind === "breaker_opened")).toBe(true);
    const out = await pending;
    expect(out.source).toBe("rule_based_fallback");
  });

  it("14. the application never reports a fallback as a real LLM response", async () => {
    const r = new ScriptedRunner(getGolden("GS-01")!);
    r.advanceUntil((s) => s.incidents.length > 0, 100);
    const inc = r.state.incidents[0];
    const ctx = buildIncidentContext(r.state, inc.id);
    const out = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: null });
    const entry: WorkflowEntry = { kind: "investigation", entryId: "INV-t14", sessionId: "s", incidentId: inc.id, requestedAt: r.state.tick, applyAt: r.state.tick, data: { ...out, speed: 1 } };
    r.apply({ k: "entry", at: r.state.tick, signed: { entry, sig: "x" } });
    const rec = r.state.incidents[0].investigations[0];
    expect(rec.source).toBe("rule_based_fallback");
    const ev = r.state.timeline.find((e) => e.kind === "diagnosis_returned")!;
    expect(ev.message).toContain("Rule-based fallback");
    expect(ev.message).not.toContain("Real LLM");
    expect(r.state.incidents[0].recommendations.every((x) => x.source === "rule_based_fallback")).toBe(true);
  });

  it("15. recommendations referencing unknown action IDs are rejected and cannot be approved", () => {
    const gs = getGolden("GS-12")!;
    const r = new ScriptedRunner(gs);
    r.advanceUntil((s) => s.incidents.length > 0, 100);
    r.advance(10);
    const inc = r.state.incidents[0];
    const entry: WorkflowEntry = {
      kind: "investigation", entryId: "INV-t15", sessionId: "s", incidentId: inc.id, requestedAt: r.state.tick, applyAt: r.state.tick,
      data: { mode: "ai_on", source: "llm", status: "succeeded", provider: "mock", model: "mock", latencyMs: 10, llmLatencyMs: 10, startedAtWallMs: 0, completedAtWallMs: 10, firstResponseMs: 5, attempts: 1, errorCategory: null, llmError: null, usage: null, fallbackUsed: false, faultInjected: null, validationNotes: [], diagnosis: gs.mockDiagnosis!, speed: 1 },
    };
    r.apply({ k: "entry", at: r.state.tick, signed: { entry, sig: "x" } });
    const recs = r.state.incidents[0].recommendations;
    const unknown = recs.find((x) => x.actionId === "restart_gateway")!;
    expect(unknown.validation.status).toBe("rejected");
    expect(unknown.validation.reasons.join(" ")).toMatch(/Unknown action/);
    expect(unknown.approval).toBe("not_approvable");
    const rl = recs.find((x) => x.actionId === "apply_rate_limit")!;
    expect(rl.validation.status).toBe("rejected");
    for (const x of [unknown, rl]) {
      const c = checkDecision(r.state, inc.id, x.id, "approve");
      expect(c.ok).toBe(false);
    }
  });

  it("16. the policy engine rejects unsafe or invalid actions", () => {
    const r = new ScriptedRunner(getGolden("GS-01")!);
    r.advanceUntil((s) => s.incidents.length > 0, 100);
    r.advance(20);
    const s = r.state;
    const inc = s.incidents[0];
    expect(validateAction(s, inc, "cap_partner_concurrency", "retail").status).toBe("rejected");
    expect(validateAction(s, inc, "cap_partner_concurrency", "partner-c").status).toBe("rejected"); // not implicated
    expect(validateAction(s, inc, "cap_partner_concurrency", null).status).toBe("rejected");
    expect(validateAction(s, inc, "apply_rate_limit", "partner-a").status).toBe("rejected"); // no traffic evidence
    expect(validateAction(s, inc, "release_temporary_controls", "partner-a").status).toBe("rejected");
    expect(validateAction(s, inc, "disable_circuit_breaker", "partner-a").status).toBe("rejected");
    expect(validateAction(s, inc, "escalate_to_partner", "partner-a").status).toBe("valid");
    expect(validateAction(s, null, "escalate_to_partner", "partner-a").status).toBe("rejected");
    // low-traffic slowdown: cap rejected for lack of concurrency pressure
    const low = new ScriptedRunner(getGolden("GS-14")!);
    low.advanceUntil((x) => x.incidents.length > 0, 100);
    low.advance(20);
    expect(validateAction(low.state, low.state.incidents[0], "cap_partner_concurrency", "partner-d").status).toBe("rejected");
  });

  it("retries retryable errors with bounded backoff, but not auth errors", async () => {
    const { ctx } = ctxFor("GS-01");
    const sleeps: number[] = [];
    const flaky = new MockProvider("m", (_req, call) => {
      if (call < 3) throw new AIProviderError("rate_limited", "429", true);
      return { text: JSON.stringify(VALID), headersMs: 1, usage: null };
    });
    const out = await investigateIncident({ ...base, timeoutMs: 5000, sleep: async (ms) => void sleeps.push(ms), context: ctx, mode: "ai_on", provider: flaky });
    expect(out.source).toBe("llm");
    expect(out.attempts).toBe(3);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    const auth = new MockProvider("m", () => {
      throw new AIProviderError("auth_error", "401", false);
    });
    const out2 = await investigateIncident({ ...base, context: ctx, mode: "ai_on", provider: auth });
    expect(auth.calls).toBe(1);
    expect(out2.errorCategory).toBe("auth_error");
    const always = new MockProvider("m", () => {
      throw new AIProviderError("server_error", "503", true);
    });
    await investigateIncident({ ...base, timeoutMs: 5000, context: ctx, mode: "ai_on", provider: always });
    expect(always.calls).toBe(3); // 1 + maxRetries(2), never unbounded
  });

  it("context sent to investigators excludes scenario names and ground truth", () => {
    const { ctx } = ctxFor("GS-01");
    const text = JSON.stringify(ctx);
    expect(text).not.toMatch(/partner_slowdown|Partner slowdown|Scenario A|rootCause|RUN-0/);
    expect(ctx.entities).toHaveLength(6);
  });

  it("rule-based investigator: correct on clear cases, honest on ambiguous ones", () => {
    const top = (id: string) => ruleBasedDiagnosis(ctxFor(id).ctx);
    expect(top("GS-01").likelyCauses[0].category).toBe("partner_downstream_latency");
    expect(top("GS-01").primaryEntityId).toBe("partner-a");
    expect(top("GS-03").likelyCauses[0].category).toBe("partner_traffic_surge");
    expect(top("GS-06").likelyCauses[0].category).toBe("partner_downstream_errors");
    expect(top("GS-09").likelyCauses[0].category).toBe("insufficient_evidence");
    expect(top("GS-13").likelyCauses[0].category).toBe("no_incident");
    expect(top("GS-04").likelyCauses[0].category).toBe("shared_gateway_saturation");
    for (const id of ["GS-01", "GS-02", "GS-05", "GS-14"]) expect(validateDiagnosis(top(id)).ok).toBe(true);
  });

  it("approving a valid recommendation executes once at the scheduled tick", () => {
    const r = new ScriptedRunner(getGolden("GS-01")!);
    r.advanceUntil((s) => s.incidents.length > 0, 100);
    r.advance(15);
    const inc = r.state.incidents[0];
    const d = ruleBasedDiagnosis(buildIncidentContext(r.state, inc.id));
    const entry: WorkflowEntry = { kind: "investigation", entryId: "INV-x", sessionId: "s", incidentId: inc.id, requestedAt: r.state.tick, applyAt: r.state.tick, data: { mode: "ai_off", source: "rule_based", status: "succeeded", provider: "rules", model: null, latencyMs: 1, llmLatencyMs: null, startedAtWallMs: 0, completedAtWallMs: 1, firstResponseMs: null, attempts: 0, errorCategory: null, llmError: null, usage: null, fallbackUsed: false, faultInjected: null, validationNotes: [], diagnosis: d, speed: 1 } };
    r.apply({ k: "entry", at: r.state.tick, signed: { entry, sig: "x" } });
    const esc = inc.recommendations.find((x) => x.actionId === "escalate_to_partner")!;
    const dec: WorkflowEntry = { kind: "decision", entryId: "DEC-1", sessionId: "s", incidentId: inc.id, recommendationId: esc.id, decision: "approve", applyAt: r.state.tick, wallMs: 1, actor: "human" };
    applyCommand(r.state, { k: "entry", at: r.state.tick, signed: { entry: dec, sig: "x" } });
    // duplicate entry is ignored (idempotent)
    applyCommand(r.state, { k: "entry", at: r.state.tick, signed: { entry: dec, sig: "x" } });
    expect(inc.audit.filter((a) => a.outcome === "executed")).toHaveLength(1);
    expect(inc.audit.filter((a) => a.outcome === "approved")).toHaveLength(1);
    r.advance(200);
    expect(inc.status).toBe("resolved");
    expect(inc.postActionChecks[0].effective).toBe(true);
  });
});
