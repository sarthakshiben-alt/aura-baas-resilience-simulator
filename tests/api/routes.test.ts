import { beforeEach, describe, expect, it } from "vitest";
import { POST as reset } from "@/app/api/demo/reset/route";
import { POST as stateRoute, GET as catalog } from "@/app/api/demo/state/route";
import { POST as start } from "@/app/api/demo/scenarios/start/route";
import { POST as stop } from "@/app/api/demo/scenarios/stop/route";
import { POST as tick } from "@/app/api/demo/tick/route";
import { POST as controls } from "@/app/api/demo/controls/route";
import { POST as investigate } from "@/app/api/incidents/[id]/investigate/route";
import { POST as approve } from "@/app/api/incidents/[id]/recommendations/[recommendationId]/approve/route";
import { POST as reject } from "@/app/api/incidents/[id]/recommendations/[recommendationId]/reject/route";
import { POST as cancel } from "@/app/api/incidents/[id]/recommendations/[recommendationId]/cancel/route";
import { GET as getIncident, POST as postIncident } from "@/app/api/incidents/[id]/route";
import { GET as getTimeline } from "@/app/api/incidents/[id]/timeline/route";
import { POST as assistant } from "@/app/api/assistant/route";
import { POST as runComparison } from "@/app/api/comparisons/run/route";
import { GET as getComparison } from "@/app/api/comparisons/[id]/route";
import { GET as health } from "@/app/api/health/route";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { MemoryRepository, setRepositoryForTests } from "@/lib/server/persistence";
import { insertCommand, type Command, type SignedEntry, type SimLog } from "@/lib/sim/workflow";
import { signEntry } from "@/lib/server/session";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) }) as never;
async function call(handler: (req: Request, ctx: never) => Promise<Response>, body: unknown, p: unknown = {}, headers?: Record<string, string>) {
  const res = await handler(post(body, headers), params(p));
  return { status: res.status, body: (await res.json()) as Json };
}

async function sessionWithIncident() {
  const r = await call(reset as never, {});
  let log: SimLog = r.body.log;
  const session: string = r.body.session;
  log = (await call(tick as never, { session, log, ticks: 5 })).body.log;
  log = (await call(start as never, { session, log, scenarioId: "partner_slowdown", target: "partner-a" })).body.log;
  log = (await call(tick as never, { session, log, ticks: 25 })).body.log;
  return { session, log };
}

async function applyEntry(session: string, log: SimLog, signed: SignedEntry): Promise<SimLog> {
  const need = signed.entry.applyAt - log.tick;
  let l = log;
  if (need > 0) l = (await call(tick as never, { session, log: l, ticks: need })).body.log;
  return { ...l, commands: insertCommand(l.commands, { k: "entry", at: signed.entry.applyAt, signed } as Command) };
}

describe("API routes", () => {
  beforeEach(() => {
    resetRateLimits();
    setRepositoryForTests(new MemoryRepository());
  });

  it("health and catalog work without any AI key; catalog hides ground truth", async () => {
    const h = await (await health()).json();
    expect(h.status).toBe("ok");
    expect(h.ai.configured).toBe(false);
    expect(h.simulated).toBe(true);
    const c = await (await catalog()).json();
    expect(c.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(c.scenarios)).not.toMatch(/rootCause|perturbations/);
  });

  it("full flow: investigate → apply signed entry → approve → idempotent duplicate", async () => {
    const { session, log } = await sessionWithIncident();
    const inv = await call(investigate as never, { session, log, mode: "ai_on", speed: 5 }, { id: "INC-001" });
    expect(inv.status).toBe(200);
    const signed: SignedEntry = inv.body.signed;
    expect(signed.entry.kind).toBe("investigation");
    expect((signed.entry as Json).data.source).toBe("rule_based_fallback"); // no key → labelled fallback
    expect((signed.entry as Json).data.errorCategory).toBe("not_configured");
    const log2 = await applyEntry(session, log, signed);
    const st = await call(stateRoute as never, { session, log: log2 });
    const inc = st.body.incidents[0];
    expect(inc.investigations).toHaveLength(1);
    const rec = inc.recommendations.find((r: Json) => r.approval === "pending");
    expect(rec).toBeDefined();
    const ap = await call(approve as never, { session, log: log2 }, { id: "INC-001", recommendationId: rec.id });
    expect(ap.status).toBe(200);
    expect(ap.body.recommendation.approval).toBe("approved");
    const log3 = { ...log2, commands: insertCommand(log2.commands, { k: "entry", at: log2.tick, signed: ap.body.signed }) };
    // 26. duplicate approval does not execute twice
    const dup = await call(approve as never, { session, log: log3 }, { id: "INC-001", recommendationId: rec.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("duplicate_decision");
    const doubled = { ...log3, commands: insertCommand(log3.commands, { k: "entry", at: log2.tick, signed: ap.body.signed }) };
    const st2 = await call(stateRoute as never, { session, log: doubled });
    const audits = st2.body.incidents[0].audit.filter((a: Json) => a.recommendationId === rec.id);
    expect(audits.filter((a: Json) => a.outcome === "approved")).toHaveLength(1);
    expect(audits.filter((a: Json) => a.outcome === "executed").length).toBeLessThanOrEqual(1);
    // Rejecting an already-approved recommendation is refused
    const rj = await call(reject as never, { session, log: log3 }, { id: "INC-001", recommendationId: rec.id });
    expect(rj.status).toBe(409);
  });

  it("24. tampered, forged or invalid requests cannot bypass server-side validation", async () => {
    const { session, log } = await sessionWithIncident();
    const inv = await call(investigate as never, { session, log, mode: "ai_off", speed: 1 }, { id: "INC-001" });
    const signed: SignedEntry = inv.body.signed;
    // tamper the diagnosis after signing
    const tampered = structuredClone(signed) as Json;
    tampered.entry.data.source = "llm";
    const bad = await call(stateRoute as never, { session, log: await applyEntry(session, log, tampered as SignedEntry) });
    expect(bad.status).toBe(403);
    // forged with a different secret
    const forged = signEntry("attacker-secret-attacker-secret", signed.entry);
    expect((await call(stateRoute as never, { session, log: await applyEntry(session, log, forged) })).status).toBe(403);
    // a signed entry from session A is rejected under session B (same seed)
    const other = (await call(reset as never, {})).body.session;
    expect((await call(stateRoute as never, { session: other, log: await applyEntry(session, log, signed) })).status).toBe(403);
    // seed mismatch
    expect((await call(stateRoute as never, { session, log: { ...log, seed: log.seed + 1 } })).status).toBe(403);
    // invalid session token
    expect((await call(stateRoute as never, { session: "x".repeat(20), log })).status).toBe(401);
    // schema violations
    expect((await call(controls as never, { session, log, patch: { breakerEnabled: false, evil: 1 } })).status).toBe(422);
    expect((await call(controls as never, { session, log, patch: { timeoutMs: 7 } })).status).toBe(422);
    expect((await call(start as never, { session, log, scenarioId: "partner_slowdown", target: "retail" })).status).toBe(422);
    expect((await call(start as never, { session, log, scenarioId: "drop_tables" })).status).toBe(422);
    expect((await call(investigate as never, { session, log, mode: "ai_on", speed: 9999 }, { id: "INC-001" })).status).toBe(422);
    expect((await call(stateRoute as never, "{not json")).status).toBe(400);
    expect((await call(stateRoute as never, { session, log: { ...log, tick: 99999 } })).status).toBe(422);
    const big = { session, log, pad: "x".repeat(600 * 1024) };
    expect((await call(stateRoute as never, big)).status).toBe(413);
    // log commands out of order
    const disordered = { ...log, commands: [...log.commands].reverse() };
    expect([200, 422]).toContain((await call(stateRoute as never, { session, log: disordered })).status);
    // unknown incident / recommendation
    expect((await call(investigate as never, { session, log, mode: "ai_on", speed: 1 }, { id: "INC-999" })).status).toBe(404);
    expect((await call(approve as never, { session, log }, { id: "INC-001", recommendationId: "nope" })).status).toBe(404);
  });

  it("stale recommendations cannot be approved after a newer investigation", async () => {
    const { session, log } = await sessionWithIncident();
    const a = (await call(investigate as never, { session, log, mode: "ai_off", speed: 1 }, { id: "INC-001" })).body.signed as SignedEntry;
    const l1 = await applyEntry(session, log, a);
    const st = await call(stateRoute as never, { session, log: l1 });
    const old = st.body.incidents[0].recommendations[0];
    const b = (await call(investigate as never, { session, log: l1, mode: "ai_off", speed: 1 }, { id: "INC-001" })).body.signed as SignedEntry;
    const l2 = await applyEntry(session, l1, b);
    const res = await call(approve as never, { session, log: l2 }, { id: "INC-001", recommendationId: old.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("stale_recommendation");
  });

  it("cancel works only before execution; stop and controls endpoints validate", async () => {
    const { session, log } = await sessionWithIncident();
    const a = (await call(investigate as never, { session, log, mode: "ai_off", speed: 1 }, { id: "INC-001" })).body.signed as SignedEntry;
    const l1 = await applyEntry(session, log, a);
    const st = await call(postIncident as never, { session, log: l1 }, { id: "INC-001" });
    const recs = st.body.incident.recommendations as Json[];
    expect(recs.length).toBeGreaterThan(0);
    const c = await call(cancel as never, { session, log: l1 }, { id: "INC-001", recommendationId: recs[0].id });
    expect(c.status).toBe(409); // not approved yet → nothing to cancel
    const s1 = await call(stop as never, { session, log: l1, runId: "RUN-001" });
    expect(s1.status).toBe(200);
    const s2 = await call(stop as never, { session, log: s1.body.log, runId: "RUN-001" });
    expect(s2.status).toBe(409);
  });

  it("assistant answers suggested questions from telemetry with an honest source label", async () => {
    const { session, log } = await sessionWithIncident();
    const a = await call(assistant as never, { session, log, incidentId: "INC-001", question: "Is retail banking affected?", aiEnabled: true });
    expect(a.status).toBe(200);
    expect(a.body.source).toBe("rule_based_fallback");
    expect(a.body.errorCategory).toBe("not_configured");
    expect(a.body.answer).toMatch(/Retail banking is/);
    const free = await call(assistant as never, { session, log, incidentId: "INC-001", question: "Why is the sky blue?", aiEnabled: false });
    expect(free.body.source).toBe("rule_based");
    expect(free.body.answer).toMatch(/only answer the suggested questions/);
  });

  it("25 (app layer). persisted records are scoped to the server-issued session", async () => {
    const { session, log } = await sessionWithIncident();
    await call(stateRoute as never, { session, log });
    await new Promise((r) => setTimeout(r, 20));
    const ok = await getIncident(new Request("http://t", { headers: { "x-aura-session": session } }), params({ id: "INC-001" }));
    expect(ok.status).toBe(200);
    const anon = await getIncident(new Request("http://t"), params({ id: "INC-001" }));
    expect(anon.status).toBe(401);
    const other = (await call(reset as never, {})).body.session;
    const foreign = await getIncident(new Request("http://t", { headers: { "x-aura-session": other } }), params({ id: "INC-001" }));
    expect(foreign.status).toBe(404);
    const tl = await getTimeline(new Request("http://t", { headers: { "x-aura-session": session } }), params({ id: "INC-001" }));
    expect(((await tl.json()) as Json).events.length).toBeGreaterThan(1);
  });

  it("paired comparison runs end-to-end and is retrievable only by its session", async () => {
    const r = await call(reset as never, {});
    const res = await call(runComparison as never, { session: r.body.session, goldenId: "GS-01" });
    expect(res.status).toBe(200);
    expect(res.body.off.metrics.detected).toBe(true);
    expect(res.body.on.metrics.diagnosisSource).toBe("rule_based_fallback");
    const g = await getComparison(new Request("http://t", { headers: { "x-aura-session": r.body.session } }), params({ id: res.body.id }));
    expect(g.status).toBe(200);
    const other = (await call(reset as never, {})).body.session;
    const g2 = await getComparison(new Request("http://t", { headers: { "x-aura-session": other } }), params({ id: res.body.id }));
    expect(g2.status).toBe(404);
    expect((await call(runComparison as never, { session: r.body.session, goldenId: "GS-01", scenarioId: "x" })).status).toBe(422);
  });

  it("rate limits AI endpoints", async () => {
    const { session, log } = await sessionWithIncident();
    let last = 200;
    for (let i = 0; i < 14; i++) last = (await call(investigate as never, { session, log, mode: "ai_off", speed: 1 }, { id: "INC-001" })).status;
    expect(last).toBe(429);
  });

  it("AI OFF manual triage delays only the runbook result, by the assumed simulated time", async () => {
    const { session, log } = await sessionWithIncident();
    const manual = await call(investigate as never, { session, log, mode: "ai_off", speed: 5, triageMinutes: 10 }, { id: "INC-001" });
    expect(manual.status).toBe(200);
    const e = manual.body.signed.entry as Json;
    expect(e.applyAt - e.requestedAt).toBeGreaterThanOrEqual(600);
    expect(e.data.workflow).toBe("manual_runbook");
    expect(e.data.assumedTriageSeconds).toBe(600);
    const auto = await call(investigate as never, { session, log, mode: "ai_off", speed: 5, triageMinutes: 0 }, { id: "INC-001" });
    expect((auto.body.signed.entry as Json).data.workflow).toBe("automated_rules");
    const ai = await call(investigate as never, { session, log, mode: "ai_on", speed: 5, triageMinutes: 10 }, { id: "INC-001" });
    const ae = ai.body.signed.entry as Json;
    expect(ae.data.workflow).toBe("ai_assisted");
    expect(ae.data.assumedTriageSeconds).toBe(0); // triage never applies to AI
    expect((await call(investigate as never, { session, log, mode: "ai_off", speed: 5, triageMinutes: 999 }, { id: "INC-001" })).status).toBe(422);
  });
});
