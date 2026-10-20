import { buildIncidentContext } from "../ai/context";
import { scoreDiagnosis, type DiagnosisScore } from "../ai/evaluate";
import type { InvestigationOutcome } from "../ai/service";
import { GOLDEN_SCENARIOS, type GoldenScenario } from "../golden/dataset";
import { ScriptedRunner } from "../golden/harness";
import { validateAction } from "../sim/policy";
import type { PolicyResult, SimState } from "../sim/types";
import type { Investigator } from "./paired";
import { ratio } from "./metrics";

export interface BenchmarkSide {
  source: string;
  status: string;
  latencyMs: number;
  llmLatencyMs: number | null;
  errorCategory: string | null;
  fallbackUsed: boolean;
  topCategory: string;
  primaryEntityId: string | null;
  actions: string[];
  score: DiagnosisScore;
}

export interface BenchmarkRow {
  id: string;
  title: string;
  contextTick: number;
  incidentId: string | null;
  aiFault: string | null;
  off: BenchmarkSide;
  on: BenchmarkSide;
}

export interface BenchmarkAggregate {
  scenarios: number;
  correctDiagnosisRate: number | null;
  validRecommendationRate: number | null;
  appropriateRecommendationRate: number | null;
  policyRejections: number;
  unnecessaryRecommendationRate: number | null;
  groundingRatio: number | null;
  fallbackRate: number | null;
  meanLatencyMs: number | null;
  p50LatencyMs: number | null;
  maxLatencyMs: number | null;
  realLlmResponses: number;
}

export interface BenchmarkResult {
  rows: BenchmarkRow[];
  off: BenchmarkAggregate;
  on: BenchmarkAggregate;
  /**
   * Smart routing, derived from the two columns: use the rulebook's answer unless it said
   * "insufficient evidence", in which case use the AI's. aiCalls = scenarios that would call the AI.
   */
  routed: { scenarios: number; aiCalls: number; correctDiagnosisRate: number | null };
  notes: string[];
}

function policyFor(state: SimState, incidentId: string | null, outcome: InvestigationOutcome): PolicyResult[] {
  const inc = incidentId ? state.incidents.find((i) => i.id === incidentId) ?? null : null;
  return outcome.diagnosis.recommendedActions.map((a) => {
    if (!inc) {
      return a.actionId === "no_action"
        ? { status: "valid", reasons: ["No incident; recording no action is permitted."], warnings: [] }
        : { status: "rejected", reasons: ["No incident is open; interventions are not permitted."], warnings: [] };
    }
    return validateAction(state, inc, a.actionId, a.targetEntityId);
  });
}

export function benchmarkState(gs: GoldenScenario): { state: SimState; incidentId: string | null } {
  const r = new ScriptedRunner(gs);
  const trig = gs.trigger.script[0].at;
  r.advanceUntil((s) => s.incidents.length > 0 || s.tick >= gs.benchmark.noIncidentTick, gs.benchmark.noIncidentTick + 1);
  const inc = r.state.incidents[0] ?? null;
  if (inc) r.advance(gs.benchmark.afterDetectionSeconds);
  else r.advance(Math.max(0, gs.benchmark.noIncidentTick - r.state.tick));
  void trig;
  return { state: r.state, incidentId: inc?.id ?? null };
}

function side(state: SimState, incidentId: string | null, gs: GoldenScenario, o: InvestigationOutcome, ctx: ReturnType<typeof buildIncidentContext>): BenchmarkSide {
  const policy = policyFor(state, incidentId, o);
  return {
    source: o.source,
    status: o.status,
    latencyMs: o.latencyMs,
    llmLatencyMs: o.llmLatencyMs,
    errorCategory: o.errorCategory,
    fallbackUsed: o.fallbackUsed,
    topCategory: o.diagnosis.likelyCauses[0]?.category ?? "insufficient_evidence",
    primaryEntityId: o.diagnosis.primaryEntityId,
    actions: o.diagnosis.recommendedActions.map((a) => a.actionId + (a.targetEntityId ? `→${a.targetEntityId}` : "")),
    score: scoreDiagnosis(o.diagnosis, gs, ctx, policy),
  };
}

function aggregate(sides: BenchmarkSide[], countFallback: boolean): BenchmarkAggregate {
  const recs = sides.reduce((s, x) => s + x.score.recommendations, 0);
  const lat = sides.map((x) => (countFallback ? x.llmLatencyMs : x.latencyMs)).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const g = sides.map((x) => x.score.grounding).filter((x) => x.checked > 0);
  return {
    scenarios: sides.length,
    correctDiagnosisRate: ratio(sides.filter((x) => x.score.diagnosisCorrect).length, sides.length),
    validRecommendationRate: ratio(sides.reduce((s, x) => s + x.score.policyValid, 0), recs),
    appropriateRecommendationRate: ratio(sides.reduce((s, x) => s + x.score.appropriate, 0), recs),
    policyRejections: sides.reduce((s, x) => s + x.score.policyRejected, 0),
    unnecessaryRecommendationRate: ratio(sides.reduce((s, x) => s + x.score.unnecessary, 0), recs),
    groundingRatio: ratio(g.reduce((s, x) => s + x.grounded, 0), g.reduce((s, x) => s + x.checked, 0)),
    fallbackRate: countFallback ? ratio(sides.filter((x) => x.fallbackUsed).length, sides.length) : null,
    meanLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    p50LatencyMs: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
    maxLatencyMs: lat.length ? lat[lat.length - 1] : null,
    realLlmResponses: sides.filter((x) => x.source === "llm").length,
  };
}

/**
 * Approach B — investigation benchmark over the golden dataset. Both
 * investigators receive the identical context for each scenario. AI ON calls
 * run sequentially to respect provider rate limits. Fault scenarios inject
 * faults on the AI side only.
 */
export async function runBenchmark(investigate: Investigator, scenarios: GoldenScenario[] = GOLDEN_SCENARIOS, opts: { onlyFallbackFree?: boolean } = {}): Promise<BenchmarkResult> {
  const rows: BenchmarkRow[] = [];
  for (const gs of scenarios) {
    const { state, incidentId } = benchmarkState(gs);
    const ctx = buildIncidentContext(state, incidentId);
    const off = await investigate(ctx, "ai_off", null);
    const on = await investigate(ctx, "ai_on", gs.aiFault);
    rows.push({ id: gs.id, title: gs.title, contextTick: state.tick, incidentId, aiFault: gs.aiFault, off: side(state, incidentId, gs, off, ctx), on: side(state, incidentId, gs, on, ctx) });
  }
  void opts;
  const notes = [
    "ILLUSTRATIVE BENCHMARK on a synthetic golden dataset; scores use scenario-specific expected findings and permitted actions.",
    "Grounding is a numeric-match heuristic (values quoted in evidence must appear in the supplied context within ±2%).",
    "AI-side latency is the measured wall-clock LLM time; rule-based latency is local compute time.",
    "Fault scenarios (GS-10, GS-11) inject a timeout / malformed output on the AI side only.",
  ];
  const onAgg = aggregate(rows.map((r) => r.on), true);
  if (onAgg.realLlmResponses === 0) notes.push("No real LLM response was obtained: every AI ON result is a labelled rule-based fallback. AI value is NOT measured by this run.");
  const stuck = (r: BenchmarkRow) => r.off.topCategory === "insufficient_evidence";
  const routedCorrect = rows.filter((r) => (stuck(r) ? r.on.score.diagnosisCorrect : r.off.score.diagnosisCorrect)).length;
  const routed = { scenarios: rows.length, aiCalls: rows.filter(stuck).length, correctDiagnosisRate: rows.length ? routedCorrect / rows.length : null };
  return { rows, off: aggregate(rows.map((r) => r.off), false), on: onAgg, routed, notes };
}
