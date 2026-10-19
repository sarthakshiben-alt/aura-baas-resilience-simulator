"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import { useEffect, useState } from "react";
import { FlaskConical, LoaderCircle, Play } from "lucide-react";
import { useSim } from "@/client/provider";
import { Button, Card, CardHeader, Empty, Label, Select } from "@/components/ui/primitives";
import { LabeledBarChart } from "@/components/charts";
import { Chip, SimTag, SourceBadge } from "@/components/status";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";
import { SCENARIOS } from "@/lib/sim/scenarios";
import { diff, ratio, type RunMetrics } from "@/lib/comparison/metrics";
import type { SensitivityRow } from "@/lib/comparison/paired";
import { CASE_COST_PER_DOWNTIME_MINUTE_USD, computeBusinessValue } from "@/lib/comparison/business";
import type { BenchmarkAggregate } from "@/lib/comparison/benchmark";
import type { DiagnosisSource } from "@/lib/sim/types";
import { cn, fmtMs, fmtNum, fmtPct } from "@/lib/utils";

type Fmt = (v: number | null) => string;
const secs: Fmt = (v) => (v === null ? "N/A" : `${v} s`);
const ms: Fmt = (v) => (v === null ? "N/A" : fmtMs(v));
const num: Fmt = (v) => (v === null ? "N/A" : fmtNum(v, Number.isInteger(v) ? 0 : 2));
const pct: Fmt = (v) => (v === null ? "N/A" : fmtPct(v, 0));
const usd = (v: number | null) => (v === null ? "N/A" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

function DiffCell({ a, b, f, lowerIsBetter = true }: { a: number | null; b: number | null; f: Fmt; lowerIsBetter?: boolean }) {
  const d = diff(a, b);
  if (d.abs === null) return <td className="px-3 py-1.5 text-right text-muted">N/A</td>;
  const better = d.abs === 0 ? null : lowerIsBetter ? d.abs < 0 : d.abs > 0;
  return (
    <td className={cn("px-3 py-1.5 text-right", better === null ? "text-muted" : better ? "text-good-text" : "text-critical-text")}>
      {d.abs > 0 ? "+" : d.abs < 0 ? "−" : "±"}
      {f(Math.abs(d.abs))}
      {d.pct !== null && d.abs !== 0 && Math.abs(d.pct) <= 10 && Math.abs(d.a ?? 0) >= 1 ? <span className="text-muted"> ({d.pct > 0 ? "+" : ""}{(d.pct * 100).toFixed(0)}%)</span> : null}
    </td>
  );
}

function MetricsTable({ off, rules, on }: { off: RunMetrics; rules: RunMetrics; on: RunMetrics }) {
  const rate = (m: RunMetrics) => ratio(m.validRecommendations, m.recommendations);
  const unn = (m: RunMetrics) => ratio(m.unnecessaryInterventions, m.interventionsExecuted);
  const rows: [string, (m: RunMetrics) => number | null, Fmt, boolean?][] = [
    ["Time to detection (sim)", (m) => m.timeToDetectionS, secs],
    ["Time to diagnosis (sim)", (m) => m.timeToDiagnosisS, secs],
    ["Investigation request → diagnosis (sim)", (m) => m.investigationDurationS, secs],
    ["Time to recommendation (sim)", (m) => m.timeToRecommendationS, secs],
    ["Time to first decision (sim)", (m) => m.timeToFirstDecisionS, secs],
    ["Time to verified recovery (sim)", (m) => m.timeToRecoveryS, secs],
    ["AI inference latency (wall-clock, mean)", (m) => m.aiInferenceLatencyMs, ms],
    ["Retail target breach (sim s)", (m) => m.retailBreachSeconds, secs],
    ["Partner impact (partner-seconds)", (m) => m.partnerImpactSeconds, secs],
    ["Primary partner downtime (sim s)", (m) => m.primaryDowntimeSeconds, secs],
    ["Investigations run", (m) => m.investigations, num],
    ["Valid recommendation rate", rate, pct, false],
    ["Policy rejections", (m) => m.policyRejections, num],
    ["Unnecessary intervention rate", unn, pct],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full min-w-[860px] text-xs" data-testid="paired-table">
        <thead className="text-left text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Metric</th>
            <th className="px-3 py-2 text-right font-medium">Manual runbook</th>
            <th className="px-3 py-2 text-right font-medium">Automated rules (no AI)</th>
            <th className="px-3 py-2 text-right font-medium">AI-assisted</th>
            <th className="px-3 py-2 text-right font-medium">AI vs manual</th>
            <th className="px-3 py-2 text-right font-medium">AI vs automated rules</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get, f, lower]) => (
            <tr key={label} className="border-t border-border">
              <td className="px-3 py-1.5 text-text-2">{label}</td>
              <td className="px-3 py-1.5 text-right text-text">{f(get(off))}</td>
              <td className="px-3 py-1.5 text-right text-text">{f(get(rules))}</td>
              <td className="px-3 py-1.5 text-right text-text">{f(get(on))}</td>
              <DiffCell a={get(off)} b={get(on)} f={f} lowerIsBetter={lower ?? true} />
              <DiffCell a={get(rules)} b={get(on)} f={f} lowerIsBetter={lower ?? true} />
            </tr>
          ))}
          <tr className="border-t border-border">
            <td className="px-3 py-1.5 text-text-2">Diagnosis source</td>
            {[off, rules, on].map((m, i) => (
              <td key={i} className="px-3 py-1.5 text-right">{m.diagnosisSource ? <SourceBadge source={m.diagnosisSource as DiagnosisSource} /> : "N/A"}</td>
            ))}
            <td colSpan={2} className="px-3 py-1.5 text-right text-muted">{on.errorCategory ? `AI error: ${on.errorCategory}` : ""}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Sensitivity({ rows, chosen }: { rows: SensitivityRow[]; chosen: number }) {
  const breakEven = rows.find((r) => (r.aiRecoveryAdvantageS ?? -1) > 0);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs font-semibold text-text">How much of the AI advantage is the triage assumption?</div>
      <p className="mt-0.5 text-[11px] text-muted">Same scenario; only the assumed manual-triage time changes. AI-assisted result is fixed. Positive = AI recovered sooner / less downtime than the manual runbook.</p>
      <table className="tabular mt-2 w-full text-xs" data-testid="sensitivity-table">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1 font-medium">Assumed manual triage</th>
            <th className="py-1 text-right font-medium">Manual recovery</th>
            <th className="py-1 text-right font-medium">AI recovery advantage</th>
            <th className="py-1 text-right font-medium">AI downtime advantage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.triageSeconds} className={cn("border-t border-border", r.triageSeconds === chosen && "bg-info/5 font-semibold")}>
              <td className="py-1">{r.triageSeconds / 60} min{r.triageSeconds === 0 ? " (= automated rules)" : ""}{r.triageSeconds === chosen ? " ← selected" : ""}</td>
              <td className="py-1 text-right">{secs(r.manualRecoveryS)}</td>
              <td className={cn("py-1 text-right", (r.aiRecoveryAdvantageS ?? 0) > 0 ? "text-good-text" : (r.aiRecoveryAdvantageS ?? 0) < 0 ? "text-critical-text" : "")}>{r.aiRecoveryAdvantageS === null ? "N/A" : `${r.aiRecoveryAdvantageS > 0 ? "+" : ""}${r.aiRecoveryAdvantageS} s`}</td>
              <td className={cn("py-1 text-right", r.aiDowntimeAdvantageS > 0 ? "text-good-text" : r.aiDowntimeAdvantageS < 0 ? "text-critical-text" : "")}>{`${r.aiDowntimeAdvantageS > 0 ? "+" : ""}${r.aiDowntimeAdvantageS} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-text-2">
        {breakEven ? `AI only beats the manual runbook once manual triage is assumed to take ≥ ${breakEven.triageSeconds / 60} min — and an automated rule engine (0 min row) achieves that speed without AI.` : "AI does not beat the manual runbook at any assumed triage time in this scenario."}
      </p>
    </div>
  );
}

function Paired() {
  const sim = useSim();
  const [scenario, setScenario] = useState("GS-01");
  const [delay, setDelay] = useState(20);
  const [scale, setScale] = useState(1);
  const [triage, setTriage] = useState(sim.manualTriageMinutes);
  const r = sim.paired.result;
  const run = () => {
    const body: Record<string, unknown> = scenario.startsWith("GS-") ? { goldenId: scenario } : { scenarioId: scenario };
    void sim.runPaired({ ...body, operatorDelaySeconds: delay, latencyTimeScale: scale, manualTriageMinutes: triage });
  };
  return (
    <Card>
      <CardHeader title="A · Paired simulation runs" subtitle="Same scenario, seed, initial conditions and deterministic protections. Only the investigation path differs. Simulated results." right={<SimTag>Simulated results</SimTag>} />
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pair-scn">Scenario</Label>
          <Select id="pair-scn" value={scenario} onChange={(e) => setScenario(e.target.value)} className="text-xs">
            <optgroup label="Golden dataset">
              {GOLDEN_SCENARIOS.map((g) => (
                <option key={g.id} value={g.id}>{g.id} · {g.title}</option>
              ))}
            </optgroup>
            <optgroup label="Simulator scenarios">
              {["partner_slowdown", "traffic_spike", "resource_saturation", "retail_risk"].map((id) => (
                <option key={id} value={id}>{SCENARIOS[id].code} · {SCENARIOS[id].label}</option>
              ))}
            </optgroup>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pair-delay">Simulated operator decision delay</Label>
          <Select id="pair-delay" value={delay} onChange={(e) => setDelay(Number(e.target.value))} className="text-xs">
            {[0, 10, 20, 60, 120].map((v) => <option key={v} value={v}>{v} s (both modes)</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pair-scale">AI latency → sim time</Label>
          <Select id="pair-scale" value={scale} onChange={(e) => setScale(Number(e.target.value))} className="text-xs">
            {[1, 5, 10, 30].map((v) => <option key={v} value={v}>{v === 1 ? "1× (real time)" : `${v}× (stress)`}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pair-triage">Assumed manual triage (conventional arm)</Label>
          <Select id="pair-triage" value={triage} onChange={(e) => setTriage(Number(e.target.value))} className="text-xs">
            {[0, 1, 5, 10, 20, 30].map((v) => <option key={v} value={v}>{v} min{v === 10 ? " (default)" : ""}</option>)}
          </Select>
        </div>
        <Button variant="primary" onClick={run} disabled={sim.paired.loading} data-testid="run-paired">
          {sim.paired.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run manual vs rules vs AI
        </Button>
        {sim.paired.error ? <span className="text-xs text-critical-text">{sim.paired.error}</span> : null}
      </div>
      {!r ? (
        <div className="p-4"><Empty>Run a paired comparison to see side-by-side results. With live AI unconfigured, the AI ON run uses the labelled rule-based fallback — and the results will say so.</Empty></div>
      ) : (
        <div className="space-y-4 p-4" data-testid="paired-result">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <b className="text-text">{r.label}</b> <Chip tone="neutral">seed {r.config.seed}</Chip>
            {r.on.metrics.diagnosisSource !== "llm" ? <Chip tone="warning">AI ON used fallback — AI value not measured</Chip> : <Chip tone="info">AI ON: real LLM responses</Chip>}
          </div>
          <MetricsTable off={r.off.metrics} rules={r.rules.metrics} on={r.on.metrics} />
          <Sensitivity rows={r.sensitivity} chosen={r.config.manualTriageSeconds} />
          <div className="grid gap-3 text-xs md:grid-cols-3">
            {(["off", "rules", "on"] as const).map((m) => (
              <div key={m} className="rounded-md border border-border p-3">
                <div className="font-semibold text-text">{m === "off" ? "Manual runbook" : m === "rules" ? "Automated rules" : "AI-assisted"} — top cause: {r[m].topCause?.replace(/_/g, " ") ?? "N/A"}</div>
                <div className="mt-1 text-text-2">{r[m].diagnosisSummary ?? "No diagnosis"}</div>
                <div className="mt-1 text-muted">Approved by simulated operator: {r[m].approvedActions.join(", ") || "none"}{r[m].rejectedByPolicy.length ? ` · not approvable: ${r[m].rejectedByPolicy.join(", ")}` : ""}</div>
              </div>
            ))}
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted">
            {r.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}

function BusinessValue({ cost }: { cost: number }) {
  const sim = useSim();
  const [price, setPrice] = useState<string>("");
  const r = sim.paired.result;
  if (!r) return null;
  const bv = computeBusinessValue({ pair: r, costPerDowntimeMinuteUsd: cost, pricePerMillionTokensUsd: price === "" ? null : Number(price) });
  return (
    <Card>
      <CardHeader title="Business impact (illustrative estimate)" subtitle="Derived from the paired run above. Not realised savings." right={<SimTag>Illustrative</SimTag>} />
      <div className="grid gap-4 p-4 lg:grid-cols-3">
        <div className="space-y-3 text-xs">
          <p className="text-muted">Using ${cost.toLocaleString("en-US")} per partner downtime minute (set in the SLA section above).</p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="price">AI price per million tokens (USD, optional)</Label>
            <input id="price" type="number" min={0} step={0.01} value={price} placeholder="not set → AI cost N/A" onChange={(e) => setPrice(e.target.value)} className="h-9 rounded-md border border-border bg-surface px-2 text-sm" />
          </div>
          <table className="tabular w-full">
            <tbody>
              <tr><td className="py-1 text-muted">Partner downtime manual / AI</td><td className="py-1 text-right">{fmtNum(bv.offDowntimeMinutes, 2)} / {fmtNum(bv.onDowntimeMinutes, 2)} min</td></tr>
              <tr><td className="py-1 text-muted">Downtime avoided, AI vs manual runbook</td><td className="py-1 text-right font-semibold">{fmtNum(bv.downtimeMinutesAvoided, 2)} min</td></tr>
              <tr><td className="py-1 pl-3 text-muted">… from automating the runbook (no AI)</td><td className="py-1 text-right">{fmtNum(bv.automationDowntimeMinutesAvoided, 2)} min</td></tr>
              <tr><td className="py-1 pl-3 text-muted">… only AI delivered (AI vs automated rules)</td><td className="py-1 text-right font-semibold">{fmtNum(bv.aiSpecificDowntimeMinutesAvoided, 2)} min</td></tr>
              <tr><td className="py-1 text-muted">Gross impact avoided, AI vs manual</td><td className="py-1 text-right font-semibold">{usd(bv.grossImpactAvoidedUsd)}</td></tr>
              <tr><td className="py-1 text-muted">Gross impact attributable to AI itself</td><td className="py-1 text-right font-semibold" data-testid="ai-specific-usd">{usd(bv.aiSpecificGrossImpactAvoidedUsd)}</td></tr>
              <tr><td className="py-1 text-muted">AI usage cost</td><td className="py-1 text-right">{usd(bv.aiCostUsd)}</td></tr>
              <tr><td className="py-1 text-muted">Net value</td><td className="py-1 text-right">{usd(bv.netValueUsd)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="lg:col-span-2">
          <div className="mb-1 text-xs font-semibold text-text">Where does any benefit come from?</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="text-left text-muted"><tr><th className="py-1 pr-2 font-medium">Source</th><th className="py-1 pr-2 font-medium">Measured</th><th className="py-1 pr-2 font-medium">Attribution</th><th className="py-1 font-medium">Note</th></tr></thead>
              <tbody>
                {bv.attribution.map((a) => (
                  <tr key={a.source} className="border-t border-border align-top">
                    <td className="py-1.5 pr-2 font-medium text-text">{a.source}<div className="font-normal text-muted">{a.measure}</div></td>
                    <td className="tabular py-1.5 pr-2">{a.value}</td>
                    <td className="py-1.5 pr-2"><Chip tone={a.attribution === "measured" ? "info" : a.attribution === "uncertain" || a.attribution === "assumption" ? "warning" : "neutral"}>{a.attribution.replace("_", " ")}</Chip></td>
                    <td className="py-1.5 text-text-2">{a.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-muted">
            {bv.caveats.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      </div>
    </Card>
  );
}

const usd0 = (v: number) => `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
const min1 = (s: number) => `${(Math.round((s / 60) * 10) / 10).toLocaleString("en-US")} min`;

function SlaPenalty({ cost, setCost }: { cost: number; setCost: (v: number) => void }) {
  const sim = useSim();
  const r = sim.paired.result;
  return (
    <Card data-testid="sla-penalty">
      <CardHeader title="What does downtime cost? (SLA penalty)" subtitle="Same incident, handled three ways. Every minute a partner is down costs the bank money." right={<SimTag>Illustrative</SimTag>} />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <div className="flex flex-col gap-1">
            <Label htmlFor="sla-cost">SLA penalty per minute of partner downtime (USD)</Label>
            <input id="sla-cost" type="number" min={0} step={100} value={cost} onChange={(e) => setCost(Math.max(0, Number(e.target.value) || 0))} className="h-9 w-40 rounded-md border border-border bg-surface px-2 text-sm" />
          </div>
          <p className="max-w-xl text-muted">Default ${CASE_COST_PER_DOWNTIME_MINUTE_USD.toLocaleString("en-US")}/min is the case-study average — an assumption, not verified data.</p>
        </div>
        {!r ? (
          <Empty>{sim.paired.loading ? "Running the same incident three ways (manual, automated rules, AI)… this takes a few seconds." : sim.paired.error ? `Comparison failed: ${sim.paired.error}` : "Waiting for the comparison to run…"}</Empty>
        ) : (
          <SlaBody cost={cost} />
        )}
      </div>
    </Card>
  );
}

function SlaBody({ cost }: { cost: number }) {
  const r = useSim().paired.result!;
  const arms = [
    { key: "off", label: `Manual runbook (${Math.round(r.config.manualTriageSeconds / 60)} min triage)`, color: "var(--s7)", down: r.off.metrics.primaryDowntimeSeconds },
    { key: "rules", label: "Automated rules (no AI)", color: "var(--s3)", down: r.rules.metrics.primaryDowntimeSeconds },
    { key: "on", label: "AI-assisted", color: "var(--s1)", down: r.on.metrics.primaryDowntimeSeconds },
  ];
  const pen = (sec: number) => (sec / 60) * cost;
  const manual = arms[0].down;
  const autoSaved = manual - arms[1].down;
  const aiExtra = arms[1].down - arms[2].down;
  const cf = r.controlsCounterfactual;
  const pb = r.protectedBaseline;
  const fallback = r.on.metrics.diagnosisSource !== "llm";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-2">
        Incident: <b className="text-text">{r.label}</b>
        {fallback ? <Chip tone="warning">AI used the rule-based fallback in this run</Chip> : <Chip tone="info">Real AI responses</Chip>}
      </div>
      <LabeledBarChart height={150} ariaLabel="SLA penalty per workflow" format={(v) => usd0(v)} data={arms.map((a) => ({ label: a.label, value: Math.round(pen(a.down)), color: a.color }))} />
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[560px] text-sm" data-testid="sla-table">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1.5 font-medium">How the incident was handled</th>
              <th className="py-1.5 text-right font-medium">Partner downtime</th>
              <th className="py-1.5 text-right font-medium">SLA penalty</th>
              <th className="py-1.5 text-right font-medium">Time saved vs manual</th>
              <th className="py-1.5 text-right font-medium">Money saved vs manual</th>
            </tr>
          </thead>
          <tbody>
            {arms.map((a) => (
              <tr key={a.key} className="border-t border-border">
                <td className="py-1.5 text-text">
                  <span aria-hidden className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
                  {a.label}
                </td>
                <td className="py-1.5 text-right">{min1(a.down)}</td>
                <td className="py-1.5 text-right font-semibold text-text">{usd0(pen(a.down))}</td>
                <td className="py-1.5 text-right">{a.key === "off" ? "—" : min1(manual - a.down)}</td>
                <td className={cn("py-1.5 text-right font-semibold", a.key !== "off" && manual - a.down > 0 ? "text-good-text" : "")}>{a.key === "off" ? "—" : usd0(pen(manual - a.down))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-1.5 text-sm text-text-2">
        <li>
          <b className="text-text">Deterministic automation</b> (rules that start the moment the problem is detected) saves <b className="text-good-text">{min1(autoSaved)} · {usd0(pen(autoSaved))}</b> compared with waiting for a human to triage.
        </li>
        <li>
          <b className="text-text">AI on top of those rules</b> {aiExtra > 0 ? <>saves a further <b className="text-good-text">{min1(aiExtra)} · {usd0(pen(aiExtra))}</b>.</> : aiExtra < 0 ? <>costs an extra <b className="text-critical-text">{min1(-aiExtra)} · {usd0(pen(-aiExtra))}</b>.</> : <>saves <b className="text-text">nothing extra</b> in this incident — the rules were already as fast.</>}
        </li>
        <li className="text-xs text-muted">
          Not counted above: the gateway protections (on in all three) also kept retail banking within its target for {Math.max(0, cf.retailBreachSeconds - pb.retailBreachSeconds)} s more and kept the other partners healthy for {Math.max(0, cf.otherPartnerImpairedSeconds - pb.otherPartnerImpairedSeconds)} partner-seconds more than with no protections.
        </li>
      </ul>
      <p className="text-[11px] text-muted">
        Honest reading: most of the saving comes from automating the response, not from AI. The manual figure depends on the assumed triage time — change it in the top bar (AI OFF) or under &quot;Detailed results&quot; below.
      </p>
    </>
  );
}

function AggRow({ label, off, on, f, better = "lower" }: { label: string; off: number | null; on: number | null; f: Fmt; better?: "lower" | "higher" | "none" }) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-1.5 text-text-2">{label}</td>
      <td className="px-3 py-1.5 text-right">{f(off)}</td>
      <td className="px-3 py-1.5 text-right">{f(on)}</td>
      {better === "none" ? <td className="px-3 py-1.5" /> : <DiffCell a={off} b={on} f={f} lowerIsBetter={better === "lower"} />}
    </tr>
  );
}

function Benchmark() {
  const sim = useSim();
  const b = sim.benchmark.result;
  const A = (k: keyof BenchmarkAggregate, f: Fmt, label: string, better: "lower" | "higher" | "none" = "higher") => <AggRow label={label} off={b!.off[k] as number | null} on={b!.on[k] as number | null} f={f} better={better} />;
  return (
    <Card>
      <CardHeader
        title="B · Investigation benchmark (golden dataset)"
        subtitle="Both investigators receive identical telemetry context for each golden scenario and are scored against scenario-specific expected findings."
        right={
          <Button variant="primary" size="sm" disabled={sim.benchmark.loading} onClick={() => void sim.runBenchmark()} data-testid="run-benchmark">
            {sim.benchmark.loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Run benchmark
          </Button>
        }
      />
      <div className="p-4">
        {sim.benchmark.error ? <p className="mb-2 text-xs text-critical-text">{sim.benchmark.error}</p> : null}
        {!b ? (
          <Empty>{sim.benchmark.loading ? "Running every golden scenario through both investigators (AI calls are sequential to respect provider limits; injected timeout scenarios wait for the real timeout)…" : "Run the benchmark to compare diagnosis quality, evidence grounding, policy rejections, latency and fallback rate."}</Empty>
        ) : (
          <div className="space-y-4" data-testid="benchmark-result">
            <div className="flex flex-wrap gap-2"><SimTag>Illustrative benchmark</SimTag>{b.on.realLlmResponses === 0 ? <Chip tone="warning">No real LLM responses — AI value not measured</Chip> : <Chip tone="info">{b.on.realLlmResponses} real LLM responses</Chip>}</div>
            <table className="tabular w-full text-xs">
              <thead className="text-left text-muted"><tr><th className="px-3 py-2 font-medium">Aggregate</th><th className="px-3 py-2 text-right font-medium">AI OFF (rules)</th><th className="px-3 py-2 text-right font-medium">AI ON</th><th className="px-3 py-2 text-right font-medium">Difference</th></tr></thead>
              <tbody>
                {A("correctDiagnosisRate", pct, "Correct diagnosis rate")}
                {A("appropriateRecommendationRate", pct, "Appropriate recommendation rate")}
                {A("validRecommendationRate", pct, "Policy-valid recommendation rate")}
                {A("policyRejections", num, "Policy rejections", "lower")}
                {A("unnecessaryRecommendationRate", pct, "Unnecessary recommendation rate", "lower")}
                {A("groundingRatio", pct, "Evidence grounding (numeric heuristic)")}
                {A("fallbackRate", pct, "Fallback rate", "none")}
                {A("meanLatencyMs", ms, "Mean investigation latency", "lower")}
                {A("p50LatencyMs", ms, "Median latency", "lower")}
                {A("maxLatencyMs", ms, "Max latency", "lower")}
              </tbody>
            </table>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead className="text-left text-muted"><tr><th className="px-2 py-1.5 font-medium">Scenario</th><th className="px-2 py-1.5 font-medium">AI OFF cause</th><th className="px-2 py-1.5 font-medium">AI ON cause</th><th className="px-2 py-1.5 font-medium">AI ON source</th><th className="px-2 py-1.5 text-right font-medium">AI latency</th><th className="px-2 py-1.5 font-medium">AI ON actions</th></tr></thead>
                <tbody>
                  {b.rows.map((row) => (
                    <tr key={row.id} className="border-t border-border align-top">
                      <td className="px-2 py-1.5"><b>{row.id}</b> <span className="text-text-2">{row.title}</span></td>
                      <td className={cn("px-2 py-1.5", row.off.score.diagnosisCorrect ? "text-good-text" : "text-critical-text")}>{row.off.score.diagnosisCorrect ? "✓" : "✗"} {row.off.topCategory.replace(/_/g, " ")}</td>
                      <td className={cn("px-2 py-1.5", row.on.score.diagnosisCorrect ? "text-good-text" : "text-critical-text")}>{row.on.score.diagnosisCorrect ? "✓" : "✗"} {row.on.topCategory.replace(/_/g, " ")}</td>
                      <td className="px-2 py-1.5"><SourceBadge source={row.on.source as DiagnosisSource} />{row.on.errorCategory ? <div className="text-[10px] text-muted">{row.on.errorCategory}{row.aiFault ? " (injected)" : ""}</div> : null}</td>
                      <td className="tabular px-2 py-1.5 text-right">{fmtMs(row.on.llmLatencyMs)}</td>
                      <td className="px-2 py-1.5 text-text-2">{row.on.actions.join(", ") || "—"}{row.on.score.policyRejected ? <span className="text-critical-text"> · {row.on.score.policyRejected} rejected</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function Interactive() {
  const sim = useSim();
  const runs = [...sim.interactiveRuns].reverse();
  return (
    <Card>
      <CardHeader title="C · Your interactive runs" subtitle="Resolved incidents from your own sessions, including real human decision time (wall-clock). Run the same scenario with AI ON and OFF to pair them." />
      <div className="overflow-x-auto p-4">
        {!runs.length ? (
          <Empty>No resolved incidents yet. Tip: load a golden scenario in the simulator, investigate with AI ON, approve, let it recover — then repeat with AI OFF.</Empty>
        ) : (
          <table className="tabular w-full min-w-[820px] text-xs">
            <thead className="text-left text-muted"><tr><th className="px-2 py-1.5 font-medium">Scenario</th><th className="px-2 py-1.5 font-medium">Workflow</th><th className="px-2 py-1.5 font-medium">Source</th><th className="px-2 py-1.5 text-right font-medium">Detect</th><th className="px-2 py-1.5 text-right font-medium">Diagnose</th><th className="px-2 py-1.5 text-right font-medium">Recover</th><th className="px-2 py-1.5 text-right font-medium">AI latency</th><th className="px-2 py-1.5 text-right font-medium">Human decision</th><th className="px-2 py-1.5 text-right font-medium">Retail breach</th><th className="px-2 py-1.5 text-right font-medium">Speed</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="px-2 py-1.5">{r.scenarioLabel}<div className="text-[10px] text-muted">{r.incidentId}</div></td>
                  <td className="px-2 py-1.5">{r.mode === "none" ? "not investigated" : r.workflow === "manual_runbook" ? `Manual runbook (${Math.round((r.triageSeconds ?? 0) / 60)} min assumed)` : r.workflow === "automated_rules" || r.mode === "ai_off" ? "Automated rules" : "AI-assisted"}</td>
                  <td className="px-2 py-1.5">{r.diagnosisSource ? <SourceBadge source={r.diagnosisSource as DiagnosisSource} /> : "—"}</td>
                  <td className="px-2 py-1.5 text-right">{secs(r.metrics.timeToDetectionS)}</td>
                  <td className="px-2 py-1.5 text-right">{secs(r.metrics.timeToDiagnosisS)}</td>
                  <td className="px-2 py-1.5 text-right">{secs(r.metrics.timeToRecoveryS)}</td>
                  <td className="px-2 py-1.5 text-right">{ms(r.metrics.aiInferenceLatencyMs)}</td>
                  <td className="px-2 py-1.5 text-right">{ms(r.metrics.humanDecisionWallMs)}</td>
                  <td className="px-2 py-1.5 text-right">{secs(r.metrics.retailBreachSeconds)}</td>
                  <td className="px-2 py-1.5 text-right">{r.speed}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-muted">Interactive simulated times depend on the speed setting (real latency × speed); compare runs at the same speed.</p>
      </div>
    </Card>
  );
}

function ComparisonPageInner() {
  const sim = useSim();
  const [cost, setCost] = useState(CASE_COST_PER_DOWNTIME_MINUTE_USD);
  const { ready, paired, manualTriageMinutes } = sim;
  useEffect(() => {
    if (ready && !paired.result && !paired.loading && !paired.error) void sim.runPaired({ goldenId: "GS-01", operatorDelaySeconds: 20, latencyTimeScale: 1, manualTriageMinutes });
  }, [sim, ready, paired.result, paired.loading, paired.error, manualTriageMinutes]);
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h1 className="text-lg font-semibold text-text">Does AI actually help? <SimTag /></h1>
          <p className="mt-1 text-sm text-text-2">
            The same incident is handled three ways: a <b>human following a runbook</b>, <b>automated rules</b> (no AI), and <b>AI-assisted</b>. The gateway protections work the same in all three, so the difference is only in how fast the problem gets diagnosed and fixed.
          </p>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
          Live AI: {sim.aiStatus?.configured ? <b className="text-info-text">{sim.aiStatus.provider} / {sim.aiStatus.model}</b> : <b className="text-warning-text">not configured (AI ON → labelled fallback)</b>}
        </div>
      </div>
      <SlaPenalty cost={cost} setCost={setCost} />
      <details className="rounded-lg border border-border bg-surface" data-testid="comparison-details">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Detailed results — change the scenario, every metric, sensitivity to the triage assumption, business attribution</summary>
        <div className="space-y-4 p-3">
          <Paired />
          <BusinessValue cost={cost} />
        </div>
      </details>
      <details className="rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Diagnosis accuracy benchmark (all 18 test scenarios)</summary>
        <div className="p-3">
          <Benchmark />
        </div>
      </details>
      <details className="rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Your own runs</summary>
        <div className="p-3">
          <Interactive />
        </div>
      </details>
    </div>
  );
}

export default function ComparisonPage() {
  return (
    <ClientOnly fallback={<PageLoading />}>
      <ComparisonPageInner />
    </ClientOnly>
  );
}
