import { describe, expect, it } from "vitest";
import { ruleBasedDiagnosis } from "@/lib/ai/rules";
import type { InvestigationOutcome } from "@/lib/ai/service";
import { investigateIncident } from "@/lib/ai/service";
import { runPairedComparison, type Investigator } from "@/lib/comparison/paired";
import { runBenchmark } from "@/lib/comparison/benchmark";
import { diff, incidentMetrics, ratio } from "@/lib/comparison/metrics";
import { computeBusinessValue } from "@/lib/comparison/business";
import { GOLDEN_SCENARIOS, getGolden } from "@/lib/golden/dataset";
import { createInitialState } from "@/lib/sim/engine";
import { PROTECTED_CONTROLS } from "@/lib/sim/config";

/** AI ON = rule-based diagnosis but labelled as an LLM with a fixed simulated latency (TEST DOUBLE ONLY). */
function fakeLlm(latencyMs: number, override?: (id: string) => InvestigationOutcome["diagnosis"] | undefined): Investigator {
  return async (ctx, mode, fault) => {
    if (mode === "ai_off" || fault) return investigateIncident({ context: ctx, mode, provider: null, timeoutMs: 50, maxRetries: 0, fault });
    const d = override?.(ctx.incident?.id ?? "") ?? ruleBasedDiagnosis(ctx);
    return { mode: "ai_on", workflow: "ai_assisted", assumedTriageSeconds: 0, source: "llm", status: "succeeded", provider: "mock", model: "mock", latencyMs, llmLatencyMs: latencyMs, startedAtWallMs: 0, completedAtWallMs: latencyMs, firstResponseMs: null, attempts: 1, errorCategory: null, llmError: null, usage: { promptTokens: 1000, completionTokens: 300, totalTokens: 1300 }, fallbackUsed: false, faultInjected: null, validationNotes: [], diagnosis: d };
  };
}
const fallbackOnly: Investigator = (ctx, mode, fault) => investigateIncident({ context: ctx, mode, provider: null, timeoutMs: 50, maxRetries: 0, fault });
const cfg = { goldenId: "GS-01", seed: 101, operatorDelaySeconds: 20, maxSeconds: 600, latencyTimeScale: 1, reinvestigateEverySeconds: 60, maxInvestigations: 3, manualTriageSeconds: 0 };

describe("AI ON vs AI OFF comparison", () => {
  it("17. both modes run from equivalent initial conditions", async () => {
    const res = await runPairedComparison(cfg, fakeLlm(2500));
    expect(res.off.metrics.timeToDetectionS).toBe(res.on.metrics.timeToDetectionS);
    expect(res.off.metrics.detected && res.on.metrics.detected).toBe(true);
    const offPre = res.off.timeline.filter((e) => e.kind === "degradation_detected");
    const onPre = res.on.timeline.filter((e) => e.kind === "degradation_detected");
    expect(offPre).toEqual(onPre);
  });

  it("18. AI OFF retains every deterministic gateway safeguard", async () => {
    const res = await runPairedComparison(cfg, fallbackOnly);
    expect(res.off.timeline.some((e) => e.kind === "breaker_opened")).toBe(true);
    expect(res.off.metrics.retailBreachSeconds).toBe(0);
    expect(createInitialState().controls).toEqual(PROTECTED_CONTROLS);
    expect(res.off.metrics.diagnosisSource).toBe("rule_based");
  });

  it("19. AI latency is measured separately from recovery time", async () => {
    const res = await runPairedComparison(cfg, fakeLlm(2500));
    expect(res.on.metrics.aiInferenceLatencyMs).toBe(2500);
    expect(res.off.metrics.aiInferenceLatencyMs).toBeNull();
    expect(res.on.metrics.investigationDurationS).toBe(3); // ceil(2.5 s × 1)
    expect(res.off.metrics.investigationDurationS).toBe(1);
    expect(res.on.metrics.timeToDiagnosisS! - res.off.metrics.timeToDiagnosisS!).toBe(2);
    expect(res.on.metrics.recovered).toBe(true);
    // A slower diagnosis can never make recovery faster; breaker cycles may absorb small delays entirely.
    expect(res.on.metrics.timeToRecoveryS!).toBeGreaterThanOrEqual(res.off.metrics.timeToRecoveryS!);
  });

  it("20. handles missing results with N/A rather than invented values", () => {
    expect(diff(null, 5)).toEqual({ a: null, b: 5, abs: null, pct: null });
    expect(diff(0, 5).pct).toBeNull();
    expect(diff(10, 5)).toEqual({ a: 10, b: 5, abs: -5, pct: -0.5 });
    expect(ratio(0, 0)).toBeNull();
    const m = incidentMetrics(createInitialState(), null, 0);
    expect(m.timeToRecoveryS).toBeNull();
    expect(m.aiInferenceLatencyMs).toBeNull();
  });

  it("21. does not fabricate improvements: identical investigators yield zero difference", async () => {
    const res = await runPairedComparison(cfg, fallbackOnly);
    expect(res.on.metrics.diagnosisSource).toBe("rule_based_fallback");
    expect(res.on.metrics.timeToRecoveryS).toBe(res.off.metrics.timeToRecoveryS);
    expect(res.notes.join(" ")).toMatch(/does not measure AI value/);
    const bv = computeBusinessValue({ pair: res, costPerDowntimeMinuteUsd: 4500, pricePerMillionTokensUsd: null });
    expect(bv.downtimeMinutesAvoided).toBe(0);
    expect(bv.grossImpactAvoidedUsd).toBe(0);
    expect(bv.netValueUsd).toBeNull();
    expect(bv.caveats.join(" ")).toMatch(/NOT AI value/);
    // A slower AI is reported as worse, not hidden
    const slow = await runPairedComparison(cfg, fakeLlm(6000));
    const bv2 = computeBusinessValue({ pair: slow, costPerDowntimeMinuteUsd: 4500, pricePerMillionTokensUsd: 0.5 });
    expect(bv2.downtimeMinutesAvoided).toBeLessThanOrEqual(0);
    expect(slow.on.metrics.timeToDiagnosisS!).toBeGreaterThan(slow.off.metrics.timeToDiagnosisS!);
    expect(bv2.aiCostUsd).toBeCloseTo((slow.on.metrics.tokens! / 1e6) * 0.5, 9);
  });

  it("22. retail impact is calculated from actual simulated events", async () => {
    const res = await runPairedComparison({ ...cfg, goldenId: "GS-02", seed: 102 }, fallbackOnly);
    expect(res.off.metrics.retailBreachSeconds).toBeGreaterThan(0);
    // Counterfactual without protections breaches longer than the protected baseline
    expect(res.controlsCounterfactual.retailBreachSeconds).toBeGreaterThanOrEqual(res.protectedBaseline.retailBreachSeconds);
    // Approved cap reduces breach vs. no action in the same scenario
    expect(res.off.approvedActions.some((a) => a.startsWith("cap_partner_concurrency"))).toBe(true);
    expect(res.off.metrics.retailBreachSeconds).toBeLessThan(res.protectedBaseline.retailBreachSeconds);
  });

  it("benchmark scores both investigators on identical contexts and flags fallback honestly", async () => {
    const res = await runBenchmark(fallbackOnly, GOLDEN_SCENARIOS);
    expect(res.rows).toHaveLength(GOLDEN_SCENARIOS.length);
    expect(res.on.realLlmResponses).toBe(0);
    expect(res.on.fallbackRate).toBe(1);
    expect(res.notes.join(" ")).toMatch(/AI value is NOT measured/);
    expect(res.off.correctDiagnosisRate).toBeGreaterThan(0.6);
    const mocked = await runBenchmark(fakeLlm(1200, () => undefined), [getGolden("GS-01")!]);
    expect(mocked.on.realLlmResponses).toBe(1);
    expect(mocked.on.meanLatencyMs).toBe(1200);
  });

  it("benchmark marks a weak/incorrect AI recommendation as incorrect", async () => {
    const gs = getGolden("GS-17")!;
    const res = await runBenchmark(fakeLlm(900, () => gs.mockDiagnosis), [gs]);
    expect(res.rows[0].on.score.causeCorrect).toBe(false);
    expect(res.rows[0].off.score.causeCorrect).toBe(true);
    const g12 = getGolden("GS-12")!;
    const r12 = await runBenchmark(fakeLlm(900, () => g12.mockDiagnosis), [g12]);
    expect(r12.rows[0].on.score.policyRejected).toBe(2);
  });

  it("manual triage is an assumption applied to diagnosis only — protections are never delayed", async () => {
    const res = await runPairedComparison({ ...cfg, manualTriageSeconds: 600, maxSeconds: 2400 }, fakeLlm(2500));
    const breakerAt = (r: typeof res.off) => r.timeline.find((e) => e.kind === "breaker_opened")?.t;
    expect(breakerAt(res.off)).toBeDefined();
    expect(breakerAt(res.off)).toBe(breakerAt(res.rules));
    expect(breakerAt(res.off)).toBe(breakerAt(res.on));
    expect(res.off.metrics.timeToDetectionS).toBe(res.rules.metrics.timeToDetectionS);
    // the manual arm's diagnosis is later by exactly the assumed triage
    expect(res.off.metrics.timeToDiagnosisS! - res.rules.metrics.timeToDiagnosisS!).toBe(600);
    expect(res.off.workflow).toBe("manual_runbook");
    expect(res.rules.workflow).toBe("automated_rules");
    expect(res.on.workflow).toBe("ai_assisted");
    expect(res.notes.join(" ")).toMatch(/ASSUMED 10 min/);
  });

  it("sensitivity table: zero triage equals automated rules; advantage grows with the assumption", async () => {
    const res = await runPairedComparison({ ...cfg, manualTriageSeconds: 600, maxSeconds: 2400 }, fakeLlm(2500));
    expect(res.sensitivity.map((r) => r.triageSeconds)).toEqual([0, 60, 300, 600, 1200]);
    const zero = res.sensitivity[0];
    expect(zero.manualRecoveryS).toBe(res.rules.metrics.timeToRecoveryS);
    const adv = res.sensitivity.map((r) => r.aiRecoveryAdvantageS!);
    for (let i = 1; i < adv.length; i++) expect(adv[i]).toBeGreaterThanOrEqual(adv[i - 1]);
  });

  it("business value splits the AI-vs-manual saving into automation vs AI-specific", async () => {
    const res = await runPairedComparison({ ...cfg, manualTriageSeconds: 600, maxSeconds: 2400 }, fakeLlm(2500));
    const bv = computeBusinessValue({ pair: res, costPerDowntimeMinuteUsd: 4500, pricePerMillionTokensUsd: null });
    expect(bv.automationDowntimeMinutesAvoided + bv.aiSpecificDowntimeMinutesAvoided).toBeCloseTo(bv.downtimeMinutesAvoided, 9);
    // With a rule-equivalent "LLM", AI adds nothing over automated rules: the saving is automation.
    expect(bv.aiSpecificDowntimeMinutesAvoided).toBeLessThanOrEqual(0);
    expect(bv.automationDowntimeMinutesAvoided).toBeGreaterThan(5);
    expect(bv.attribution.find((a) => a.source.startsWith("Automating"))?.attribution).toBe("assumption");
  });
});
