"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import { useMemo, useState } from "react";
import { Check, Play, Square, Upload } from "lucide-react";
import { useSim } from "@/client/provider";
import { Button, Card, CardHeader, Empty, Label, Select, Switch } from "@/components/ui/primitives";
import { TimeSeriesChart } from "@/components/charts";
import { SimTag } from "@/components/status";
import { ENTITY_PROFILES, ALLOWED_TIMEOUTS_MS } from "@/lib/sim/config";
import { SCENARIOS, UI_SCENARIO_IDS, type ScenarioDefinition } from "@/lib/sim/scenarios";
import { perturbationFinished } from "@/lib/sim/engine";
import { runWhatIf } from "@/lib/sim/whatif";
import { GOLDEN_SCENARIOS } from "@/lib/golden/dataset";
import { FEATURED_GOLDEN } from "@/lib/golden/featured";
import { PARTNER_IDS, type PartnerId } from "@/lib/sim/types";
import { fmtPct, fmtSimTime } from "@/lib/utils";

const UI_EMOJI: Record<string, string> = { partner_slowdown: "🐢", retail_risk: "🚦", mystery: "🎲" };
const UI_TAGLINE: Record<string, string> = {
  partner_slowdown: "The textbook case. The rulebook handles it instantly.",
  retail_risk: "Several things at once — but each one is in the rulebook.",
  mystery: "Different every time. No rule fits — this is where AI earns its keep (or doesn't).",
};

function ScenarioCard({ def, n }: { def: ScenarioDefinition; n: number }) {
  const sim = useSim();
  const [target, setTarget] = useState<PartnerId>((def.defaultTarget ?? "partner-a") as PartnerId);
  const [justClicked, setJustClicked] = useState(false);
  const tgt = def.targetable ? target : null;
  const running = def.kind !== "recovery" && sim.isScenarioActive(def.id, tgt);
  const trigger = () => {
    sim.startScenario(def.id, tgt);
    setJustClicked(true);
    setTimeout(() => setJustClicked(false), 2500);
  };
  return (
    <Card className="flex flex-col p-4" data-testid={`scenario-${def.id}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Scenario {n}</div>
      <h3 className="text-base font-extrabold text-text">
        {UI_EMOJI[def.id]} {def.label}
      </h3>
      <p className="mt-1 text-sm font-semibold text-nav-active">{UI_TAGLINE[def.id]}</p>
      <p className="mt-1 text-xs text-text-2">{def.description}</p>
      <details className="mt-2 text-[11px] text-muted">
        <summary className="cursor-pointer">What to expect</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {def.expectedEffects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </details>
      <div className="mt-auto flex flex-col gap-2 pt-3">
        {def.targetable ? (
          <div className="flex min-w-0 flex-col gap-1">
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
        <Button size="sm" variant={def.kind === "recovery" ? "success" : "primary"} onClick={trigger} disabled={running} data-testid={`start-${def.id}`} className="w-full">
          {running ? (
            <>
              <Check className="h-3.5 w-3.5" /> Running
            </>
          ) : justClicked ? (
            <>
              <Check className="h-3.5 w-3.5" /> Triggered
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> {def.kind === "recovery" ? "Recover" : "Trigger"}
            </>
          )}
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
      <CardHeader title="Gateway protections" subtitle="Automatic safety rules. AI never changes these." />
      <div className="divide-y divide-border px-4">
        {row(
          "All protections",
          allOn ? "ON — the safe default" : "OFF or customised — try a scenario to see what goes wrong without them",
          <Button
            size="sm"
            variant={allOn ? "danger" : "success"}
            data-testid="toggle-protections"
            onClick={() => sim.setControls(allOn ? { isolationEnabled: false, breakerEnabled: false, retailReservationEnabled: false, timeoutMs: 30000 } : { isolationEnabled: true, breakerEnabled: true, retailReservationEnabled: true, timeoutMs: 2000 })}
          >
            {allOn ? "Disable all" : "Restore defaults"}
          </Button>,
        )}
      </div>
      <details className="border-t border-border">
        <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-text-2">Advanced settings</summary>
        <div className="divide-y divide-border px-4">
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
      </details>
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
                      {r.label} {r.groundTruthFactors ? "· 🎲 cause hidden" : r.targetEntityId ? `· ${ENTITY_PROFILES[r.targetEntityId].name}` : ""}
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
        title="Why the protections matter"
        subtitle="The same incident replayed twice for 3 simulated minutes: once with protections ON, once OFF."
        right={
          <Select value={scenario} onChange={(e) => setScenario(e.target.value)} className="h-8 text-xs" aria-label="What-if scenario">
            {UI_SCENARIO_IDS
              .map((id) => (
                <option key={id} value={id}>
                  {UI_EMOJI[id]} {SCENARIOS[id].label}
                </option>
              ))}
          </Select>
        }
      />
      <div className="space-y-3 p-4">
        <div className="text-xs font-medium text-text-2">Retail banking response time (lower is better)</div>
        <TimeSeriesChart height={200} data={res.rows.map((r) => ({ t: r.t, on: r.retailOn, off: r.retailOff }))} series={[{ key: "on", label: "Protections ON", color: "var(--s1)" }, { key: "off", label: "Protections OFF", color: "var(--s2)", dashed: true }]} unit=" ms" yLabel="milliseconds" refLines={[{ y: 300, label: "target 300 ms", tone: "critical" }]} ariaLabel="Retail response time with and without protections" />
        <ul className="space-y-1 text-sm text-text-2">
          <li>
            Retail banking missed its target for <b className="text-text">{S.on.retailBreachSeconds} s</b> with protections, vs <b className="text-text">{S.off.retailBreachSeconds} s</b> without.
          </li>
          <li>
            Healthy partners were dragged down for <b className="text-text">{S.on.otherPartnerImpairedSeconds}</b> partner-seconds with protections, vs <b className="text-text">{S.off.otherPartnerImpairedSeconds}</b> without.
          </li>
          <li className="text-xs text-muted">
            The trade-off: protections deliberately fail the broken partner&apos;s requests fast ({fmtPct(S.on.targetSuccessRate, 0)} succeed vs {fmtPct(S.off.targetSuccessRate, 0)}) so everyone else stays healthy. Peak gateway load {fmtPct(S.on.peakUtilisation, 0)} vs {fmtPct(S.off.peakUtilisation, 0)}.
          </li>
        </ul>
      </div>
    </Card>
  );
}

function GoldenLoader() {
  const sim = useSim();
  const [id, setId] = useState(GOLDEN_SCENARIOS[0].id);
  const [loading, setLoading] = useState(false);
  const gs = GOLDEN_SCENARIOS.find((g) => g.id === id)!;
  const load = async () => {
    setLoading(true);
    try {
      await sim.reset({ goldenId: id });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Test scenarios (golden dataset)" subtitle="Two ready-made incidents. Loading one resets the simulator and kicks it off for you." />
      <div className="space-y-2 p-4 text-xs">
        <div className="flex gap-2">
          <Select value={id} onChange={(e) => setId(e.target.value)} className="h-8 min-w-0 flex-1 text-xs" aria-label="Golden scenario">
            {FEATURED_GOLDEN.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} · {g.short}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" onClick={() => void load()} disabled={loading} data-testid="load-golden">
            <Upload className="h-3.5 w-3.5" /> {loading ? "Loading…" : "Load"}
          </Button>
        </div>
        <p className="text-text-2">{FEATURED_GOLDEN.find((f) => f.id === id)?.blurb}</p>
        <details>
          <summary className="cursor-pointer text-muted">Details</summary>
          <div className="mt-1 space-y-1">
            <p><span className="text-muted">Initial conditions:</span> {gs.initialConditions.description}</p>
            <p><span className="text-muted">Trigger:</span> {gs.trigger.description}</p>
            <p><span className="text-muted">Expected impact:</span> {gs.expectedPlatformImpact} {gs.expectedRetailImpact}</p>
            <p><span className="text-muted">Expected investigation:</span> {gs.expectedAi.description}</p>
          </div>
        </details>
        {gs.aiFault ? <p className="text-warning-text">Injects an AI {gs.aiFault} fault on AI-ON investigations (set below).</p> : null}
        {sim.goldenId ? <p className="font-medium text-good-text">✓ Loaded: {sim.goldenId}</p> : null}
      </div>
    </Card>
  );
}

function Workflow() {
  const sim = useSim();
  return (
    <Card>
      <CardHeader title="Investigation workflow" subtitle="Who works out what went wrong. Protections act instantly regardless." />
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
        <h1 className="text-xl font-extrabold text-text">🧪 Incident simulator <SimTag /></h1>
        <p className="text-sm text-text-2">Pick a scenario, press Trigger, then pop over to the Overview to watch it unfold. Break things freely — it&apos;s all simulated, and the same seed gives the same result every time.</p>
      </div>
      <section aria-label="Scenarios" className="grid gap-3 md:grid-cols-3">
        {UI_SCENARIO_IDS.map((id, i) => (
          <ScenarioCard key={id} def={SCENARIOS[id]} n={i + 1} />
        ))}
      </section>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ActiveRuns />
          <WhatIf />
        </div>
        <div className="space-y-4">
          <Protections />
          <Workflow />
          <GoldenLoader />
          <details className="rounded-2xl border border-border bg-surface shadow-sm">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Advanced: AI fault injection</summary>
            <AiFault />
          </details>
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
