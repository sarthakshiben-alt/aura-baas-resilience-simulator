import { describe, expect, it } from "vitest";
import { buildIncidentContext } from "@/lib/ai/context";
import { ruleBasedDiagnosis } from "@/lib/ai/rules";
import { MockProvider } from "@/lib/ai/provider";
import { investigateIncident } from "@/lib/ai/service";
import { runBenchmark } from "@/lib/comparison/benchmark";
import { aiArmStatus } from "@/lib/comparison/metrics";
import { runPairedComparison, type Investigator } from "@/lib/comparison/paired";
import { GOLDEN_SCENARIOS, getGolden } from "@/lib/golden/dataset";
import { ScriptedRunner } from "@/lib/golden/harness";

function contextFor(id: string) {
  const r = new ScriptedRunner(getGolden(id)!);
  r.advanceUntil((s) => s.incidents.length > 0, 400);
  r.advance(20);
  return buildIncidentContext(r.state, r.state.incidents[0].id);
}

/** Answers with the rule-based diagnosis as JSON, counting how often it is asked. */
const mockLlm = () =>
  new MockProvider("mock-model", () => {
    return { text: JSON.stringify(ruleBasedDiagnosis(contextFor("GS-01"))), headersMs: 5, usage: { promptTokens: 3000, completionTokens: 500, totalTokens: 3500 } };
  });

describe("Smart AI routing (token efficiency)", () => {
  it("does not call the AI when the rulebook classifies the incident", async () => {
    const provider = mockLlm();
    const out = await investigateIncident({ context: contextFor("GS-01"), mode: "ai_on", provider, timeoutMs: 1000, maxRetries: 0, routing: true });
    expect(provider.calls).toBe(0);
    expect(out.aiRouting).toBe("skipped");
    expect(out.attempts).toBe(0);
    expect(out.usage).toBeNull();
    expect(out.source).toBe("rule_based");
    expect(out.validationNotes.join(" ")).toMatch(/AI was not called/);
  });

  it("calls the AI when the rulebook is stuck (mystery incident)", async () => {
    const provider = mockLlm();
    const ctx = contextFor("GS-19");
    expect(ruleBasedDiagnosis(ctx).likelyCauses[0].category).toBe("insufficient_evidence");
    const out = await investigateIncident({ context: ctx, mode: "ai_on", provider, timeoutMs: 1000, maxRetries: 0, routing: true });
    expect(provider.calls).toBe(1);
    expect(out.aiRouting).toBe("invoked");
    expect(out.source).toBe("llm");
  });

  it("without routing, AI ON always calls the AI (unchanged behaviour)", async () => {
    const provider = mockLlm();
    const out = await investigateIncident({ context: contextFor("GS-01"), mode: "ai_on", provider, timeoutMs: 1000, maxRetries: 0 });
    expect(provider.calls).toBe(1);
    expect(out.aiRouting).toBeUndefined();
  });

  it("paired run: routine incident spends 0 AI tokens and ties the rulebook", async () => {
    const provider = mockLlm();
    const inv: Investigator = (context, mode, fault) => investigateIncident({ context, mode, provider: mode === "ai_on" ? provider : null, timeoutMs: 1000, maxRetries: 0, fault, routing: mode === "ai_on" });
    const res = await runPairedComparison({ goldenId: "GS-01", seed: 101, operatorDelaySeconds: 20, maxSeconds: 900, latencyTimeScale: 1, reinvestigateEverySeconds: 60, maxInvestigations: 3, manualTriageSeconds: 600 }, inv);
    expect(provider.calls).toBe(0);
    expect(aiArmStatus(res.on.metrics)).toBe("skipped");
    expect(res.on.metrics.aiCalls).toBe(0);
    expect(res.on.metrics.tokens).toBe(0);
    expect(res.on.metrics.primarySlaBreachSeconds).toBe(res.rules.metrics.primarySlaBreachSeconds);
  });

  it("benchmark derives the routed result without extra AI calls", async () => {
    const fallbackOnly: Investigator = (ctx, mode, fault) => investigateIncident({ context: ctx, mode, provider: null, timeoutMs: 50, maxRetries: 0, fault });
    const res = await runBenchmark(fallbackOnly, GOLDEN_SCENARIOS);
    const stuck = res.rows.filter((r) => r.off.topCategory === "insufficient_evidence").length;
    expect(res.routed.aiCalls).toBe(stuck);
    expect(res.routed.aiCalls).toBeLessThan(res.rows.length / 3);
    expect(res.routed.scenarios).toBe(res.rows.length);
  });
});
