"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import { useMemo, useState } from "react";
import { Play, Square, Upload } from "lucide-react";
import { useSim } from "@/client/provider";
import { Button, Card, CardHeader, Empty, Label, Select, Switch } from "@/components/ui/primitives";
import { TimeSeriesChart } from "@/components/charts";
import { SimTag } from "@/components/status";
import { ENTITY_PROFILES, ALLOWED_TIMEOUTS_MS } from "@/lib/sim/config";
import { EXTRA_SCENARIO_IDS, PRIMARY_SCENARIO_IDS, SCENARIOS, type ScenarioDefinition } from "@/lib/sim/scenarios";
import { perturbationFinished } from "@/lib/sim/engine";
import { runWhatIf } from "@/lib/sim/whatif";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";
import { PARTNER_IDS, type PartnerId } from "@/lib/sim/types";
import { fmtPct, fmtSimTime } from "@/lib/utils";

function ScenarioCard({ def }: { def: ScenarioDefinition }) {
  const sim = useSim();
  const [target, setTarget] = useState<PartnerId>((def.defaultTarget ?? "partner-a") as PartnerId);
  return (
    <Card className="flex flex-col p-4" data-testid={`scenario-${def.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Scenario {def.code}</div>
          <h3 className="text-sm font-semibold text-text">{def.label}</h3>
        </div>
      </div>
      <p className="mt-1 text-xs text-text-2">{def.description}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-muted">
        {def.expectedEffects.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap items-end gap-2 pt-3">
        {def.targetable ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor={`t-${def.id}`}>Partner</Label>
            <Select id={`t-${def.id}`} value={target} onChange={(e) => setTarget(e.target.value as PartnerId)} className="h-8 w-full min-w-0 text-xs">
              {PARTNER_IDS.map((p) => (
                <option key={p} value={p}>
                  {ENTITY_PROFILES[p].name} · {ENTITY_PROFILES[p].segment}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <Button size="sm" variant={def.kind === "recovery" ? "success" : "primary"} onClick={() => sim.startScenario(def.id, def.targetable ? target : null)} data-testid={`start-${def.id}`}>
          <Play className="h-3.5 w-3.5" /> {def.kind === "recovery" ? "Recover" : "Trigger"}
        </Button>
      </div>
    </Card>
  );
}

function Protections() {
  const sim = useSim();
  const c = sim.state.controls;
  const allOn = c.isolationEnabled && c.breakerEnabled && c.retailReservationEnabled && c.timeoutMs <= 2000;
  const row = (label: string, help: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <div className="text-sm text-text">{label}</div>
        <div className="text-[11px] text-muted">{help}</div>
      </div>
      {control}
    </div>
  );
  return (
    <Card>
      <CardHeader title="Deterministic gateway protections" subtitle="Operator-controlled. Never changed by AI. Independent of the AI toggle." />
      <div className="divide-y divide-border px-4">
        {row(
          "All protections",
          allOn ? "Default protected posture" : "Uncontrolled / custom posture — shows what happens without isolation",
          <Button
            size="sm"
            variant={allOn ? "danger" : "success"}
            data-testid="toggle-protections"
            onClick={() => sim.setControls(allOn ? { isolationEnabled: false, breakerEnabled: false, retailReservationEnabled: false, timeoutMs: 30000 } : { isolationEnabled: true, breakerEnabled: true, retailReservationEnabled: true, timeoutMs: 2000 })}
          >
            {allOn ? "Disable all" : "Restore defaults"}
          </Button>,
        )}
        {row("Per-partner concurrency limits", `Each partner ≤ ${c.perPartnerLimit} in-flight`, <Switch checked={c.isolationEnabled} onCheckedChange={(v) => sim.setControls({ isolationEnabled: v })} label="Per-partner concurrency limits" />)}
        {row(
          "Per-partner limit",
          "Gateway slots one partner may hold",
          <Select value={c.perPartnerLimit} onChange={(e) => sim.setControls({ perPartnerLimit: Number(e.target.value) })} className="h-8 text-xs" aria-label="Per-partner limit">
            {[50, 100, 200, 300].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>,
        )}
        {row("Circuit breakers", "Open at ≥50% slow/failed calls over 10 s; 30 s open; 10 s half-open probe", <Switch checked={c.breakerEnabled} onCheckedChange={(v) => sim.setControls({ breakerEnabled: v })} label="Circuit breakers" />)}
        {row(
          "Request timeout",
          "Bounds how long a request can hold a slot",
          <Select value={c.timeoutMs} onChange={(e) => sim.setControls({ timeoutMs: Number(e.target.value) })} className="h-8 text-xs" aria-label="Request timeout">
            {ALLOWED_TIMEOUTS_MS.map((v) => (
              <option key={v} value={v}>
                {v / 1000} s
              </option>
            ))}
          </Select>,
        )}
        {row("Retail capacity reservation", `${c.retailReservationSlots} of ${sim.state.config.gatewayCapacitySlots + c.extraCapacitySlots} slots reserved for retail`, <Switch checked={c.retailReservationEnabled} onCheckedChange={(v) => sim.setControls({ retailReservationEnabled: v })} label="Retail capacity reservation" />)}
      </div>
    </Card>
  );
}

function ActiveRuns() {
  const sim = useSim();
  const s = sim.state;
  const runs = s.scenarioRuns.filter((r) => r.perturbations.length);
  return (
    <Card>
      <CardHeader title="Scenario runs" subtitle="Stop ends a scenario safely: perturbations ramp back to baseline." />
      <div className="p-3">
        {runs.length === 0 ? (
          <Empty>No scenarios triggered in this session.</Empty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {runs.map((r) => {
              const finished = r.perturbations.every((p) => perturbationFinished(p, s.tick));
              const ending = r.perturbations.some((p) => p.endAt !== null || (p.plannedEndAt !== null && p.plannedEndAt <= s.tick));
              return (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <div className="font-medium text-text">
                      {r.label} {r.targetEntityId ? `· ${ENTITY_PROFILES[r.targetEntityId].name}` : ""}
                    </div>
                    <div className="text-[11px] text-muted">
                      {r.id} · started {fmtSimTime(r.startedAt)} · {finished ? "finished" : ending ? "ending (ramping down)" : "active"}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" disabled={finished || r.stoppedAt !== null} onClick={() => sim.stopRun(r.id)}>
                    <Square className="h-3 w-3" /> Stop
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function WhatIf() {
  const [scenario, setScenario] = useState("partner_slowdown");
  const def = SCENARIOS[scenario];
  const target = def.targetable ? (def.defaultTarget as PartnerId) : null;
  const res = useMemo(() => runWhatIf(scenario, target), [scenario, target]);
  const S = res.summary;
  return (
    <Card>
      <CardHeader
        title="What do the deterministic controls contribute?"
        subtitle="Same scenario and seed, no human or AI actions: protections ON vs OFF (headless, 180 simulated seconds)."
        right={
          <Select value={scenario} onChange={(e) => setScenario(e.target.value)} className="h-8 text-xs" aria-label="What-if scenario">
            {[...PRIMARY_SCENARIO_IDS, ...EXTRA_SCENARIO_IDS]
              .filter((id) => SCENARIOS[id].kind !== "recovery")
              .map((id) => (
                <option key={id} value={id}>
                  {SCENARIOS[id].code} · {SCENARIOS[id].label}
                </option>
              ))}
          </Select>
        }
      />
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-text-2">Retail banking P95 (ms)</div>
          <TimeSeriesChart height={200} log data={res.rows.map((r) => ({ t: r.t, on: r.retailOn, off: r.retailOff }))} series={[{ key: "on", label: "Protections ON", color: "var(--s1)" }, { key: "off", label: "Protections OFF", color: "var(--s2)", dashed: true }]} unit=" ms" refLines={[{ y: 300, label: "target", tone: "critical" }]} ariaLabel="Retail P95 with and without protections" />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-text-2">Healthy neighbour ({ENTITY_PROFILES[res.observedPartner].name}) P95 (ms)</div>
          <TimeSeriesChart height={200} log data={res.rows.map((r) => ({ t: r.t, on: r.otherOn, off: r.otherOff }))} series={[{ key: "on", label: "Protections ON", color: "var(--s1)" }, { key: "off", label: "Protections OFF", color: "var(--s2)", dashed: true }]} unit=" ms" refLines={[{ y: 400, label: "degraded", tone: "warning" }]} ariaLabel="Neighbour partner P95 with and without protections" />
        </div>
        <table className="tabular text-xs lg:col-span-2">
          <thead className="text-muted">
            <tr>
              <th className="py-1 text-left font-medium">Outcome over 180 s</th>
              <th className="py-1 text-right font-medium">Protections ON</th>
              <th className="py-1 text-right font-medium">Protections OFF</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Retail target breach (s)</td><td className="text-right">{S.on.retailBreachSeconds}</td><td className="text-right">{S.off.retailBreachSeconds}</td></tr>
            <tr><td>Other partners impaired (partner-seconds)</td><td className="text-right">{S.on.otherPartnerImpairedSeconds}</td><td className="text-right">{S.off.otherPartnerImpairedSeconds}</td></tr>
            <tr><td>Peak gateway utilisation</td><td className="text-right">{fmtPct(S.on.peakUtilisation, 0)}</td><td className="text-right">{fmtPct(S.off.peakUtilisation, 0)}</td></tr>
            <tr><td>{target ? `${ENTITY_PROFILES[target].name} mean success rate` : "Partner A mean success rate"}</td><td className="text-right">{fmtPct(S.on.targetSuccessRate, 0)}</td><td className="text-right">{fmtPct(S.off.targetSuccessRate, 0)}</td></tr>
          </tbody>
        </table>
        <p className="text-[11px] text-muted lg:col-span-2">
          Note the trade-off: with protections ON the breaker fast-fails the degraded partner&apos;s requests (lower success for that partner) to keep everyone else healthy. Capacity alone does not fix downstream latency.
        </p>
      </div>
    </Card>
  );
}

function GoldenLoader() {
  const sim = useSim();
  const [id, setId] = useState(GOLDEN_SCENARIOS[0].id);
  const gs = GOLDEN_SCENARIOS.find((g) => g.id === id)!;
  return (
    <Card>
      <CardHeader title="Golden dataset" subtitle="Deterministic synthetic scenarios. Loading one resets the session to its initial conditions and schedules its trigger." />
      <div className="space-y-2 p-4 text-xs">
        <div className="flex gap-2">
          <Select value={id} onChange={(e) => setId(e.target.value)} className="h-8 min-w-0 flex-1 text-xs" aria-label="Golden scenario">
            {GOLDEN_SCENARIOS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} · {g.title}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" onClick={() => void sim.reset({ goldenId: id })} data-testid="load-golden">
            <Upload className="h-3.5 w-3.5" /> Load
          </Button>
        </div>
        <p className="text-text-2">{gs.description}</p>
        <p><span className="text-muted">Initial conditions:</span> {gs.initialConditions.description}</p>
        <p><span className="text-muted">Trigger:</span> {gs.trigger.description}</p>
        <p><span className="text-muted">Expected platform / retail impact:</span> {gs.expectedPlatformImpact} {gs.expectedRetailImpact}</p>
        <p><span className="text-muted">Expected investigation:</span> {gs.expectedAi.description}</p>
        {gs.aiFault ? <p className="text-warning-text">Injects an AI {gs.aiFault} fault on AI-ON investigations (set below).</p> : null}
        {sim.goldenId ? <p className="font-medium text-info-text">Loaded in current session: {sim.goldenId}</p> : null}
      </div>
    </Card>
  );
}

function Workflow() {
  const sim = useSim();
  return (
    <Card>
      <CardHeader title="Investigation workflow" subtitle="How incidents get diagnosed. Gateway protections are never delayed by any of these settings." />
      <div className="space-y-3 p-4 text-xs text-text-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-text">Auto-investigate on detection</div>
            <div className="text-[11px] text-muted">AI ON: AI starts immediately. AI OFF: the on-call engineer is paged and triages manually.</div>
          </div>
          <Switch checked={sim.autoInvestigate} onCheckedChange={(v) => sim.setAutoInvestigate(v)} label="Auto-investigate on detection" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-text">Assumed manual triage (AI OFF)</div>
            <div className="text-[11px] text-muted">Simulated minutes before the runbook diagnosis. An input assumption, not measured data. 0 = runbook automated without AI.</div>
          </div>
          <Select value={sim.manualTriageMinutes} onChange={(e) => sim.setManualTriageMinutes(Number(e.target.value))} className="h-8 text-xs" aria-label="Assumed manual triage minutes">
            {[0, 1, 5, 10, 20, 30].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "0 (automated rules)" : `${m} min`}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Card>
  );
}

function AiFault() {
  const sim = useSim();
  return (
    <Card>
      <CardHeader title="AI provider fault injection" subtitle="Exercises reliability handling. Applies to AI-ON investigations only; results are labelled." />
      <div className="flex items-center gap-2 p-4">
        <Select value={sim.aiFault ?? "none"} onChange={(e) => sim.setAiFault(e.target.value === "none" ? null : (e.target.value as "timeout" | "malformed"))} className="h-8 text-xs" aria-label="AI fault injection" data-testid="ai-fault">
          <option value="none">No fault (use configured provider)</option>
          <option value="timeout">Simulate provider timeout ({"≈"}8 s)</option>
          <option value="malformed">Simulate malformed structured output</option>
        </Select>
      </div>
    </Card>
  );
}

function SimulatorPageInner() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text">Incident simulator <SimTag /></h1>
        <p className="text-sm text-text-2">Scenarios are reproducible from the same initial conditions (fixed seed). Use the clock controls above to pause or fast-forward.</p>
      </div>
      <section aria-label="Scenarios" className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {PRIMARY_SCENARIO_IDS.map((id) => (
          <ScenarioCard key={id} def={SCENARIOS[id]} />
        ))}
      </section>
      <details className="rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Additional scenarios (downstream errors, transient slowdown, ambiguous latency, high-rate, low-traffic)</summary>
        <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-5">
          {EXTRA_SCENARIO_IDS.map((id) => (
            <ScenarioCard key={id} def={SCENARIOS[id]} />
          ))}
        </div>
      </details>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ActiveRuns />
          <WhatIf />
        </div>
        <div className="space-y-4">
          <Protections />
          <Workflow />
          <AiFault />
          <GoldenLoader />
        </div>
      </div>
    </div>
  );
}

export default function SimulatorPage() {
  return (
    <ClientOnly fallback={<PageLoading />}>
      <SimulatorPageInner />
    </ClientOnly>
  );
}
