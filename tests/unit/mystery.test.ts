import { describe, expect, it } from "vitest";
import { buildIncidentContext } from "@/lib/ai/context";
import { ruleBasedDiagnosis } from "@/lib/ai/rules";
import { investigateIncident, type InvestigationOutcome } from "@/lib/ai/service";
import { runPairedComparison, type Investigator } from "@/lib/comparison/paired";
import { ScriptedRunner } from "@/lib/golden/harness";
import { generateMystery, seededRandom } from "@/lib/sim/scenarios";
import type { PartnerId } from "@/lib/sim/types";

const start = (seed: number) => new ScriptedRunner(null, { seed, commands: [{ k: "start", at: 10, scenarioId: "mystery", target: null }] });

/** Test double: an "AI" that always escalates to the given partner (or always shrugs). */
function scriptedAi(pick: (truth: PartnerId) => PartnerId | null): Investigator {
  return async (ctx, mode, fault) => {
    if (mode === "ai_off") return investigateIncident({ context: ctx, mode, provider: null, timeoutMs: 50, maxRetries: 0, fault });
    const base = ruleBasedDiagnosis(ctx);
    const target = pick(ctx.incident!.primaryEntityId as PartnerId);
    const diagnosis = target
      ? { ...base, primaryEntityId: target, likelyCauses: [{ ...base.likelyCauses[0], category: "partner_downstream_latency" as const }], recommendedActions: [{ actionId: "escalate_to_partner", targetEntityId: target, rationale: "test" }] }
      : base;
    const o: InvestigationOutcome = { mode: "ai_on", source: "llm", status: "succeeded", provider: "mock", model: "mock", latencyMs: 2000, llmLatencyMs: 2000, startedAtWallMs: 0, completedAtWallMs: 2000, firstResponseMs: null, attempts: 1, errorCategory: null, llmError: null, usage: null, fallbackUsed: false, faultInjected: null, validationNotes: [], diagnosis, workflow: "ai_assisted", assumedTriageSeconds: 0 } as InvestigationOutcome;
    return o;
  };
}
const cfg = { goldenId: "GS-19", seed: 119, operatorDelaySeconds: 20, maxSeconds: 2400, latencyTimeScale: 1, reinvestigateEverySeconds: 60, maxInvestigations: 3, manualTriageSeconds: 600 };

describe("Mystery incident (randomised, outside the rulebook)", () => {
  it("is replay-stable per seed and varies across seeds", () => {
    const a = generateMystery(seededRandom(7, 10, 1));
    const b = generateMystery(seededRandom(7, 10, 1));
    expect(a).toEqual(b);
    const targets = new Set(Array.from({ length: 40 }, (_, i) => generateMystery(seededRandom(i, 10, 1)).target));
    expect(targets.size).toBeGreaterThanOrEqual(4);
  });

  it("the rulebook cannot classify it, at any checkpoint, across many rolls — and monitoring finds the right partner", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = start(seed);
      r.advanceUntil((s) => s.incidents.length > 0, 400);
      const inc = r.state.incidents[0];
      expect(inc, `seed ${seed}`).toBeTruthy();
      expect(inc.primaryEntityId).toBe(r.state.scenarioRuns[0].targetEntityId);
      for (const dt of [1, 20, 60]) {
        r.advance(dt);
        expect(ruleBasedDiagnosis(buildIncidentContext(r.state, inc.id)).likelyCauses[0].category, `seed ${seed}`).toBe("insufficient_evidence");
      }
    }
  });

  it("never leaks the rolled answer into an investigator's context", () => {
    const r = start(119);
    r.advanceUntil((s) => s.incidents.length > 0, 400);
    r.advance(20);
    const ctx = JSON.stringify(buildIncidentContext(r.state, r.state.incidents[0].id));
    expect(ctx).not.toMatch(/mystery|red herring|real problem/i);
    for (const f of r.state.scenarioRuns[0].groundTruthFactors ?? []) expect(ctx).not.toContain(f);
  });

  it("rules-only: a paged human fixes it after the assumed triage time", async () => {
    const res = await runPairedComparison(cfg, scriptedAi(() => null));
    expect(res.rules.topCause).toBe("insufficient_evidence");
    expect(res.rules.humanPagedAt).not.toBeNull();
    expect(res.rules.humanDiagnosedAt! - res.rules.humanPagedAt!).toBe(600);
    expect(res.rules.metrics.recovered).toBe(true);
    // Manual arm: triage, runbook stumped, then the same deeper investigation.
    expect(res.off.metrics.timeToRecoveryS!).toBeGreaterThan(res.rules.metrics.timeToRecoveryS! + 500);
    // An AI that can't crack it either gains nothing.
    expect(res.on.metrics.primarySlaBreachSeconds).toBeGreaterThanOrEqual(res.rules.metrics.primarySlaBreachSeconds);
    expect(res.groundTruth.factors?.length).toBeGreaterThanOrEqual(3);
  });

  it("an AI that names the right partner recovers sooner; a wrong one gets no credit", async () => {
    const right = await runPairedComparison(cfg, scriptedAi((t) => t));
    expect(right.on.humanDiagnosedAt).toBeNull();
    expect(right.on.metrics.primarySlaBreachSeconds).toBeLessThan(right.rules.metrics.primarySlaBreachSeconds - 400);
    const wrong = await runPairedComparison(cfg, scriptedAi((t) => (t === "partner-a" ? "partner-b" : "partner-a")));
    expect(wrong.on.metrics.primarySlaBreachSeconds).toBeGreaterThanOrEqual(wrong.rules.metrics.primarySlaBreachSeconds);
  });
});
