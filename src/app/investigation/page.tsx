"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import { useState } from "react";
import { useSim } from "@/client/provider";
import { Card, CardHeader, Empty, Select } from "@/components/ui/primitives";
import { IncidentTimeline } from "@/components/dashboard/timeline";
import { DiagnosisPanel } from "@/components/investigation/diagnosis";
import { ActionApproval } from "@/components/investigation/actions";
import { AssistantPanel } from "@/components/investigation/assistant";
import { TimeSeriesChart, entityRows, entitySeries } from "@/components/charts";
import { HealthBadge, RetailBadge, SeverityBadge, SimTag } from "@/components/status";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import { latest } from "@/lib/sim/engine";
import { SCENARIOS } from "@/lib/sim/scenarios";
import type { EntityId, Incident } from "@/lib/sim/types";
import { fmtMs, fmtPct, fmtSecs, fmtSimTime } from "@/lib/utils";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-text">{children}</div>
    </div>
  );
}

function Header({ inc }: { inc: Incident }) {
  const sim = useSim();
  const s = sim.state;
  const end = inc.recoveredAt ?? s.tick;
  const g = s.history.gateway.at(-1);
  const scen = inc.scenarioIds.map((id) => SCENARIOS[id]?.label ?? id).join(" + ") || "Unattributed";
  return (
    <Card>
      <CardHeader title={<span data-testid="incident-id">{inc.id}</span>} subtitle={`Status: ${inc.status}${inc.recoveryVerified ? " (recovery verified)" : ""}`} right={<SeverityBadge severity={inc.peakSeverity} />} />
      <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4 xl:grid-cols-8">
        <Field label="Scenario type">
          {scen} <div className="text-[10px] text-muted">ground truth — hidden from investigators</div>
        </Field>
        <Field label="Affected partner">{ENTITY_PROFILES[inc.primaryEntityId].name}</Field>
        <Field label="Also affected">{inc.affectedEntityIds.filter((e) => e !== inc.primaryEntityId).map((e) => ENTITY_PROFILES[e].name).join(", ") || "—"}</Field>
        <Field label="Start (sim)">{fmtSimTime(inc.startedAt)}</Field>
        <Field label={inc.recoveryVerified ? "Duration" : "Current duration"}>{end - inc.startedAt} s</Field>
        <Field label="Current severity"><SeverityBadge severity={inc.severity} /></Field>
        <Field label="Retail impact">{g ? <RetailBadge health={g.retailHealth} /> : "—"}<div className="text-[11px] text-muted">{inc.retailBreachSeconds}s breach · {inc.retailAtRiskSeconds}s at risk</div></Field>
        <Field label="Mode">{inc.investigationMode ? (inc.investigationMode === "ai_on" ? "AI ON" : "AI OFF") : "Not investigated"}</Field>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-muted">Current impact</div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs">
          {inc.affectedEntityIds.map((e) => {
            const x = latest(s, e);
            return (
              <span key={e} className="flex items-center gap-1.5">
                <b className="text-text">{ENTITY_PROFILES[e].name}</b> {x ? <HealthBadge status={x.status} /> : null} P95 {fmtMs(x?.p95Ms)} · errors {fmtPct(x?.errorRate)} · success {fmtPct(x?.successRate, 0)}
              </span>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function Outcome({ inc }: { inc: Incident }) {
  const sum = (o: Partial<Record<EntityId, number>>) => Object.values(o).reduce<number>((a, b) => a + (b ?? 0), 0);
  const rows: [string, React.ReactNode][] = [
    ["Time to detection", fmtSecs(inc.detectedAt - inc.startedAt)],
    ["Time to diagnosis", fmtSecs(inc.diagnosedAt === null ? null : inc.diagnosedAt - inc.startedAt)],
    ["Time to recommendation", fmtSecs(inc.recommendationAt === null ? null : inc.recommendationAt - inc.startedAt)],
    ["Platform protected (others & retail healthy, partner contained)", inc.platformProtectedAt === null ? "Not yet / not applicable" : `${fmtSimTime(inc.platformProtectedAt)} (+${inc.platformProtectedAt - inc.startedAt}s)`],
    ["Partner back within thresholds", inc.partnerRecoveredAt === null ? "Not yet" : `${fmtSimTime(inc.partnerRecoveredAt)} (+${inc.partnerRecoveredAt - inc.startedAt}s)`],
    ["Recovery verified (incident resolved)", inc.recoveryVerified ? `${fmtSimTime(inc.recoveredAt!)} (+${inc.recoveredAt! - inc.startedAt}s)` : "Not yet"],
    ["Partner impact (partner-seconds not healthy)", `${sum(inc.partnerImpactSeconds)} s`],
    ["Partner downtime (success < 50%)", `${sum(inc.partnerDowntimeSeconds)} s`],
    ["Retail breach / at-risk", `${inc.retailBreachSeconds} s / ${inc.retailAtRiskSeconds} s (peak P95 ${fmtMs(inc.peakRetailP95Ms || null)})`],
  ];
  return (
    <Card>
      <CardHeader title="Recovery outcome" subtitle="Partner recovery, gateway protection, retail health and incident resolution are tracked separately. All values simulated." />
      <table className="w-full text-xs">
        <tbody className="tabular">
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-border last:border-0">
              <td className="px-4 py-1.5 text-muted">{k}</td>
              <td className="px-4 py-1.5 text-right text-text">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inc.postActionChecks.length ? (
        <div className="border-t border-border px-4 py-3 text-xs">
          <div className="mb-1 font-medium text-text">Post-action verification</div>
          <ul className="space-y-1 text-text-2">
            {inc.postActionChecks.map((c) => (
              <li key={c.recommendationId}>
                <b>{c.actionId}</b> @ {fmtSimTime(c.executedAt)}: {c.after ? `${c.effective === null ? "no effect expected" : c.effective ? "effective" : "not effective / unnecessary"} — ${c.note}` : `evaluating at ${fmtSimTime(c.evaluateAt)}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Audit({ inc }: { inc: Incident }) {
  return (
    <Card>
      <CardHeader title="Audit log" subtitle="Every decision and simulated action, with actor and before/after controls." />
      {inc.audit.length === 0 ? (
        <div className="p-4"><Empty>No decisions recorded yet.</Empty></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="text-left text-muted"><tr><th className="px-4 py-2 font-medium">Sim time</th><th className="px-4 py-2 font-medium">Action</th><th className="px-4 py-2 font-medium">Outcome</th><th className="px-4 py-2 font-medium">Actor</th><th className="px-4 py-2 font-medium">Note</th></tr></thead>
            <tbody className="tabular">
              {inc.audit.map((a) => (
                <tr key={a.id} className="border-t border-border align-top">
                  <td className="px-4 py-1.5">{fmtSimTime(a.t)}</td>
                  <td className="px-4 py-1.5">{a.actionId}{a.targetEntityId ? ` → ${a.targetEntityId}` : ""}</td>
                  <td className="px-4 py-1.5">{a.outcome}</td>
                  <td className="px-4 py-1.5">{a.actorType.replace("_", " ")}</td>
                  <td className="px-4 py-1.5 text-text-2">
                    {a.note}
                    {a.beforeState && a.afterState ? (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-muted">before / after</summary>
                        <pre className="mt-1 max-w-[520px] overflow-x-auto rounded bg-surface-2 p-2 text-[10px]">{JSON.stringify({ before: a.beforeState, after: a.afterState }, null, 1)}</pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function InvestigationPageInner() {
  const sim = useSim();
  const s = sim.state;
  // Server render has no incidents yet, so reading the query lazily cannot cause a hydration mismatch.
  const [selected, setSelected] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("incident")));
  const inc = s.incidents.find((i) => i.id === selected) ?? s.incidents.filter((i) => i.status !== "resolved").at(-1) ?? s.incidents.at(-1) ?? null;
  const ids = inc ? inc.affectedEntityIds : [];
  const from = inc ? Math.max(0, inc.startedAt - 20) : 0;
  const win = s.tick - from;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text">Incident investigation <SimTag /></h1>
          <p className="text-sm text-text-2">AI (or the runbook) explains what went wrong and suggests a fix → safety rules check it → you approve or reject.</p>
        </div>
        {s.incidents.length > 1 ? (
          <Select value={inc?.id} onChange={(e) => setSelected(e.target.value)} aria-label="Select incident" className="h-8 text-xs">
            {s.incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} · {ENTITY_PROFILES[i.primaryEntityId].name} · {i.status}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {!inc ? (
        <>
          <Empty>No incident has been detected in this session. Trigger a scenario in the Incident simulator, load a golden scenario, or start the guided demo.</Empty>
          <AssistantPanel incidentId={null} />
        </>
      ) : (
        <>
          <Header inc={inc} />
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-4">
              <DiagnosisPanel inc={inc} />
              <AssistantPanel incidentId={inc.id} />
            </div>
            <div className="space-y-4">
              <ActionApproval inc={inc} />
              <Outcome inc={inc} />
            </div>
          </div>
          <Card>
            <CardHeader title="Response time of the affected services" subtitle="Lower is better · from 20 s before the incident started" />
            <div className="p-3">
              <TimeSeriesChart height={200} data={entityRows(s, "p95Ms", win, ids)} series={entitySeries(ids)} unit=" ms" yLabel="milliseconds" refLines={[{ y: 400, label: "slow above 400 ms", tone: "warning" }]} ariaLabel="Affected service response time" />
            </div>
          </Card>
          <Card>
            <CardHeader title="Incident timeline" subtitle="Simulated times (mm:ss)" />
            <div className="p-4"><IncidentTimeline state={s} inc={inc} /></div>
          </Card>
          <details className="rounded-lg border border-border bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">Show audit log (every decision, who made it, what changed)</summary>
            <Audit inc={inc} />
          </details>
        </>
      )}
    </div>
  );
}

export default function InvestigationPage() {
  return (
    <ClientOnly fallback={<PageLoading />}>
      <InvestigationPageInner />
    </ClientOnly>
  );
}
