import { describe, expect, it } from "vitest";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";
import { ScriptedRunner } from "@/lib/golden/harness";
import { PARTNER_IDS } from "@/lib/sim/types";
import { ACTION_IDS } from "@/lib/sim/actions";
import { CAUSE_CATEGORIES } from "@/lib/sim/types";
import { validateDiagnosis } from "@/lib/ai/schema";

describe("golden dataset", () => {
  it("has at least 12 scenarios with unique ids and complete definitions", () => {
    expect(GOLDEN_SCENARIOS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(GOLDEN_SCENARIOS.map((g) => g.id)).size).toBe(GOLDEN_SCENARIOS.length);
    for (const g of GOLDEN_SCENARIOS) {
      expect(g.trigger.script.length).toBeGreaterThan(0);
      for (const a of [...g.expectedAi.acceptableActions, ...g.expectedAi.unnecessaryActions, ...g.expectedAi.forbiddenActions]) expect(ACTION_IDS).toContain(a);
      for (const c of g.expectedAi.acceptableCauses) expect(CAUSE_CATEGORIES).toContain(c);
      if (g.mockDiagnosis) expect(validateDiagnosis(g.mockDiagnosis).ok).toBe(true);
      expect(g.safetyConstraints.length).toBeGreaterThan(0);
    }
  });

  for (const g of GOLDEN_SCENARIOS) {
    it(`${g.id} ${g.title}: telemetry matches expectations`, () => {
      const r = new ScriptedRunner(g);
      r.advance(240);
      const s = r.state;
      const e = g.expectations;
      if (!e.incidentExpected) {
        expect(s.incidents).toHaveLength(0);
        return;
      }
      expect(s.incidents.length).toBeGreaterThan(0);
      const inc = s.incidents[0];
      if (e.primaryEntityId) expect(inc.primaryEntityId).toBe(e.primaryEntityId);
      expect(inc.detectedAt).toBeGreaterThanOrEqual(inc.startedAt);
      const breachTicks = s.history.gateway.filter((x) => x.retailHealth === "breach").length;
      const riskTicks = s.history.gateway.filter((x) => x.retailHealth !== "healthy").length;
      if (e.retail === "none") expect(riskTicks).toBe(0);
      if (e.retail === "breach") expect(breachTicks).toBeGreaterThan(0);
      if (e.retail === "at_risk_or_breach") expect(riskTicks).toBeGreaterThan(0);
      const others = PARTNER_IDS.filter((p) => p !== inc.primaryEntityId);
      const othersImpaired = others.some((p) => s.history.entities[p].some((x) => x.status === "degraded" || x.status === "unavailable" || x.status === "protected"));
      expect(othersImpaired).toBe(e.otherPartnersImpaired);
      if (e.breakerOpens) expect(s.timeline.some((x) => x.kind === "breaker_opened" && x.entityId === e.breakerOpens)).toBe(true);
      if (e.resolvesWithoutActionWithin !== null) {
        const trig = g.trigger.script[0].at;
        expect(inc.status).toBe("resolved");
        expect(inc.recoveredAt! - trig).toBeLessThanOrEqual(e.resolvesWithoutActionWithin);
      }
    });
  }

  it("GS-15 produces two simultaneous incidents", () => {
    const r = new ScriptedRunner(GOLDEN_SCENARIOS.find((g) => g.id === "GS-15")!);
    r.advance(80);
    const open = r.state.incidents.filter((i) => i.status !== "resolved");
    expect(open.length).toBe(2);
    expect(open.map((i) => i.primaryEntityId).sort()).toEqual(["partner-a", "partner-b"]);
  });
});
