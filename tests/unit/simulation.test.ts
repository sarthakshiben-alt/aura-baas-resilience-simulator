import { describe, expect, it } from "vitest";
import { createInitialState, latest, latestGateway, step, stepN } from "@/lib/sim/engine";
import { PROTECTED_CONTROLS, UNCONTROLLED_CONTROLS } from "@/lib/sim/config";
import { applyControlsPatch, replay, startScenario, stopScenario, type SimLog } from "@/lib/sim/workflow";
import { PARTNER_IDS, type SimState } from "@/lib/sim/types";

function maxOf(state: SimState, id: Parameters<typeof latest>[1], key: "p95Ms" | "inFlight", from = 0) {
  return Math.max(...state.history.entities[id].filter((s) => s.t >= from).map((s) => (s[key] ?? 0) as number));
}

describe("simulation engine", () => {
  it("1. baseline produces healthy partner and retail states", () => {
    const s = createInitialState({ seed: 1 });
    stepN(s, 120);
    for (const id of [...PARTNER_IDS, "retail" as const]) {
      expect(s.history.entities[id].every((x) => x.status === "healthy")).toBe(true);
    }
    const g = latestGateway(s)!;
    expect(g.retailHealth).toBe("healthy");
    expect(g.utilisation).toBeGreaterThan(0.4);
    expect(g.utilisation).toBeLessThan(0.5);
    expect(s.incidents).toHaveLength(0);
    const a = latest(s, "partner-a")!;
    expect(a.p95Ms!).toBeGreaterThan(165);
    expect(a.p95Ms!).toBeLessThan(195);
    expect(a.errorRate).toBeCloseTo(0.005, 3);
  });

  it("2. triggering a slowdown increases the affected partner's latency", () => {
    const s = createInitialState({ seed: 2 });
    stepN(s, 10);
    const before = latest(s, "partner-a")!.p95Ms!;
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 12);
    expect(latest(s, "partner-a")!.p95Ms!).toBeGreaterThan(before * 3);
    expect(latest(s, "partner-b")!.p95Ms!).toBeLessThan(220);
  });

  it("3. slower responses increase in-flight work under equivalent conditions (Little's law)", () => {
    const fast = createInitialState({ seed: 3, controls: { ...PROTECTED_CONTROLS, isolationEnabled: false, breakerEnabled: false } });
    const slow = createInitialState({ seed: 3, controls: { ...PROTECTED_CONTROLS, isolationEnabled: false, breakerEnabled: false } });
    stepN(fast, 5);
    stepN(slow, 5);
    startScenario(slow, "partner_slowdown", "partner-a");
    stepN(fast, 8);
    stepN(slow, 8);
    const f = latest(fast, "partner-a")!;
    const sl = latest(slow, "partner-a")!;
    expect(sl.offeredRps).toBeCloseTo(f.offeredRps, 0); // same arrival rate
    expect(sl.inFlight).toBeGreaterThan(f.inFlight * 3);
  });

  it("4. per-partner concurrency limits constrain the affected partner", () => {
    const s = createInitialState({ seed: 4, controls: { ...PROTECTED_CONTROLS, breakerEnabled: false } });
    stepN(s, 5);
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 60);
    const peak = maxOf(s, "partner-a", "inFlight");
    expect(peak).toBeLessThanOrEqual(100.0001);
    expect(latest(s, "partner-a")!.rejectedRate).toBeGreaterThan(0.01);
    expect(latest(s, "partner-a")!.status).toBe("protected");
    const off = createInitialState({ seed: 4, controls: { ...UNCONTROLLED_CONTROLS } });
    stepN(off, 5);
    startScenario(off, "partner_slowdown", "partner-a");
    stepN(off, 60);
    expect(maxOf(off, "partner-a", "inFlight")).toBeGreaterThan(150);
  });

  it("5. circuit breaker follows closed → open → half-open → open/closed rules", () => {
    const s = createInitialState({ seed: 5 });
    stepN(s, 5);
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 40);
    const opened = s.timeline.find((e) => e.kind === "breaker_opened" && e.entityId === "partner-a")!;
    expect(opened).toBeDefined();
    // OPEN blocks all traffic for openSeconds
    const during = s.history.entities["partner-a"].filter((x) => x.t > opened.t && x.t <= opened.t + 30);
    expect(during.every((x) => x.breaker === "open" && x.inFlight === 0)).toBe(true);
    stepN(s, 30);
    const half = s.timeline.find((e) => e.kind === "breaker_half_open" && e.entityId === "partner-a")!;
    expect(half.t - opened.t).toBe(30);
    // still slow → re-opens after half-open window
    stepN(s, 15);
    const reopen = s.timeline.filter((e) => e.kind === "breaker_opened" && e.entityId === "partner-a");
    expect(reopen.length).toBe(2);
    expect(reopen[1].t - half.t).toBe(10);
    // recover → next half-open probes succeed → closed
    startScenario(s, "recovery", "partner-a");
    stepN(s, 60);
    expect(s.timeline.some((e) => e.kind === "breaker_closed" && e.entityId === "partner-a")).toBe(true);
    expect(s.runtime["partner-a"].breaker.state).toBe("closed");
  });

  it("6. retail banking protection: reservation keeps retail within target; disabling it breaches", () => {
    const on = createInitialState({ seed: 6, controls: { ...PROTECTED_CONTROLS, perPartnerLimit: 300, breakerEnabled: false } });
    const off = createInitialState({ seed: 6, controls: { ...PROTECTED_CONTROLS, perPartnerLimit: 300, breakerEnabled: false, retailReservationEnabled: false } });
    for (const s of [on, off]) {
      stepN(s, 5);
      startScenario(s, "partner_slowdown", "partner-a");
      stepN(s, 90);
    }
    const breach = (s: SimState) => s.history.gateway.filter((g) => g.retailHealth === "breach").length;
    expect(breach(on)).toBe(0);
    expect(breach(off)).toBeGreaterThan(30);
  });

  it("7. recovery restores metrics and verification resolves the incident", () => {
    const s = createInitialState({ seed: 7 });
    stepN(s, 5);
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 60);
    expect(s.incidents[0].status).not.toBe("resolved");
    startScenario(s, "recovery", "partner-a");
    stepN(s, 150);
    const inc = s.incidents[0];
    expect(inc.status).toBe("resolved");
    expect(inc.recoveryVerified).toBe(true);
    expect(inc.recoveredAt! - inc.recoveryStartedAt!).toBeGreaterThanOrEqual(29);
    const a = latest(s, "partner-a")!;
    expect(a.p95Ms!).toBeLessThan(220);
    expect(a.inFlight).toBeLessThan(15);
    expect(a.status).toBe("healthy");
  });

  it("8. reset (fresh replay) returns a known baseline; identical logs produce identical states", () => {
    const log: SimLog = {
      v: 1,
      seed: 99,
      tick: 120,
      commands: [
        { k: "controls", at: 0, patch: { timeoutMs: 5000 } },
        { k: "start", at: 10, scenarioId: "partner_slowdown", target: "partner-a" },
        { k: "stop", at: 80, runId: "RUN-001" },
      ],
    };
    const a = replay(log);
    const b = replay(log);
    expect(JSON.stringify(a.history)).toBe(JSON.stringify(b.history));
    expect(JSON.stringify(a.incidents)).toBe(JSON.stringify(b.incidents));
    const fresh = replay({ v: 1, seed: 99, tick: 0, commands: [] });
    expect(fresh.incidents).toHaveLength(0);
    expect(fresh.scenarioRuns).toHaveLength(0);
    expect(fresh.controls).toEqual(PROTECTED_CONTROLS);
    const baseline = replay({ v: 1, seed: 99, tick: 30, commands: [] });
    expect(baseline.history.entities["partner-a"].every((x) => x.status === "healthy")).toBe(true);
  });

  it("stop ends a scenario safely with a ramp, and noise is replay-stable", () => {
    const s = createInitialState({ seed: 8 });
    stepN(s, 5);
    const id = startScenario(s, "traffic_spike", "partner-b");
    stepN(s, 30);
    stopScenario(s, id);
    stepN(s, 30);
    expect(latest(s, "partner-b")!.offeredRps).toBeLessThan(110);
    expect(() => stopScenario(s, id)).toThrow();
  });

  it("controls patch validation rejects unsafe values", () => {
    const s = createInitialState();
    expect(() => applyControlsPatch(s, { timeoutMs: 123 })).toThrow();
    expect(() => applyControlsPatch(s, { perPartnerLimit: 100000 })).toThrow();
    expect(() => startScenario(s, "drop_tables")).toThrow();
    expect(() => startScenario(s, "partner_slowdown", "retail")).toThrow();
  });

  it("an open breaker is not treated as recovery", () => {
    const s = createInitialState({ seed: 9 });
    stepN(s, 5);
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 40);
    expect(s.runtime["partner-a"].breaker.state).toBe("open");
    const inc = s.incidents[0];
    expect(inc.platformProtectedAt).not.toBeNull();
    expect(inc.partnerRecoveredAt).toBeNull();
    expect(inc.recoveryVerified).toBe(false);
    expect(latest(s, "partner-a")!.status).toBe("protected");
  });

  it("units are consistent: latency in ms, rates in [0,1]", () => {
    const s = createInitialState();
    startScenario(s, "partner_slowdown", "partner-a");
    stepN(s, 60);
    for (const x of s.history.entities["partner-a"]) {
      for (const k of ["errorRate", "timeoutRate", "rejectedRate", "throttledRate", "successRate"] as const) {
        expect(x[k]).toBeGreaterThanOrEqual(0);
        expect(x[k]).toBeLessThanOrEqual(1.00001);
      }
      if (x.p95Ms !== null) expect(x.p95Ms).toBeLessThanOrEqual(s.controls.timeoutMs);
    }
    step(s);
  });
});
