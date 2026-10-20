"use client";

import { LoaderCircle, RotateCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useSim } from "@/client/provider";
import type { Incident, InvestigationRecord } from "@/lib/sim/types";
import { Button, Card, CardHeader, Empty } from "@/components/ui/primitives";
import { Chip, SourceBadge } from "@/components/status";
import { fmtMs, fmtSimTime } from "@/lib/utils";
import { TokenFootprint } from "./token-footprint";

function List({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  if (!items.length) return null;
  return (
    <div>
      <div className={`text-[11px] font-semibold uppercase tracking-wide ${tone ?? "text-muted"}`}>{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-text-2">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

export const WORKFLOW_LABEL: Record<string, string> = {
  manual_runbook: "Manual runbook (conventional)",
  automated_rules: "Automated rules (no AI)",
  ai_assisted: "AI-assisted",
};

export function InvestigationMeta({ iv }: { iv: InvestigationRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      <SourceBadge source={iv.source} status={iv.status} routing={iv.aiRouting} />
      {iv.workflow ? <span className="font-medium text-text-2">{WORKFLOW_LABEL[iv.workflow]}</span> : null}
      {iv.assumedTriageSeconds ? <span title="Disclosed assumption, not measured">assumed manual triage: {Math.round(iv.assumedTriageSeconds / 60)} min (simulated)</span> : null}
      <span>{iv.mode === "ai_on" ? "AI assistance ON" : "AI assistance OFF"}</span>
      <span>provider: {iv.provider}{iv.model ? ` / ${iv.model}` : ""}</span>
      <span title="Wall-clock time measured by the server">investigation wall time: {fmtMs(iv.latencyMs)}</span>
      {iv.llmLatencyMs !== null ? <span title="Wall-clock time spent in LLM attempts">LLM time: {fmtMs(iv.llmLatencyMs)}</span> : null}
      <span title="Simulated seconds between request and diagnosis">sim time: {iv.appliedAt - iv.requestedAt}s at {iv.speed}×</span>
      {iv.attempts ? <span>attempts: {iv.attempts}</span> : null}
      {iv.usage?.totalTokens ? <span>tokens: {iv.usage.totalTokens}</span> : null}
    </div>
  );
}

export function DiagnosisPanel({ inc }: { inc: Incident }) {
  const sim = useSim();
  const pending = sim.pendingInvestigations.get(inc.id);
  const err = sim.investigationErrors.get(inc.id);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [pending]);
  const iv = inc.investigations.at(-1) ?? null;
  const resolved = inc.status === "resolved";
  const mode = sim.aiMode;
  return (
    <Card>
      <CardHeader
        title="AI investigation"
        subtitle="Investigators receive a compact context built from the actual simulated telemetry — never the scenario name."
        right={
          <Button size="sm" variant="primary" disabled={!!pending || resolved} onClick={() => void sim.investigate(inc.id)} data-testid="run-investigation">
            {iv ? <RotateCw className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
            {iv ? "Re-investigate" : "Run investigation"} ({mode === "ai_on" ? "AI ON" : "AI OFF"})
          </Button>
        }
      />
      <div className="space-y-3 p-4">
        {pending ? (
          <div className="flex items-center gap-2 rounded-xl border border-info/40 bg-info/5 px-3 py-2 text-xs text-info-text" data-testid="investigation-pending">
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
            {pending.triageSeconds > 0 ? (
              <span>
                {pending.auto ? "Incident detected → on-call engineer paged. " : ""}Manual triage in progress: an <b>assumed {Math.round(pending.triageSeconds / 60)} min</b> (simulated) to open dashboards and work the runbook
                {pending.readyAt !== null ? <> — runbook diagnosis due at {fmtSimTime(pending.readyAt)} (in {Math.max(0, pending.readyAt - sim.state.tick)} sim s)</> : null}. Gateway protections are already acting on their own. Tip: fast-forward with the speed control.
              </span>
            ) : (
              <span>
                {pending.auto ? "Incident detected → investigation started automatically. " : ""}Investigation in progress ({pending.mode === "ai_on" ? "AI ON" : "automated rules"}) — {((Math.max(now, pending.startedWall) - pending.startedWall) / 1000).toFixed(1)} s elapsed. The simulation and gateway protections continue independently.
              </span>
            )}
          </div>
        ) : null}
        {err ? (
          <div className="rounded-xl border border-critical/40 bg-critical/5 px-3 py-2 text-xs text-critical-text">
            Request failed: {err}{" "}
            <Button size="sm" variant="secondary" onClick={() => void sim.investigate(inc.id)}>
              Retry
            </Button>
          </div>
        ) : null}
        {!iv && !pending ? <Empty>No investigation yet. AI is not in the transaction path: the incident is already being contained by deterministic controls.</Empty> : null}
        {iv ? (
          <div className="space-y-3" data-testid="diagnosis">
            <InvestigationMeta iv={iv} />
            <TokenFootprint inc={inc} iv={iv} />
            {iv.errorCategory ? (
              <div className="rounded-xl border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning-text">
                LLM attempt failed — <b>{iv.errorCategory.replace(/_/g, " ")}</b>
                {iv.faultInjected ? " (injected fault)" : ""}: {iv.llmError}. The diagnosis below is the deterministic <b>rule-based fallback</b>, not an AI response.{" "}
                {sim.aiMode === "ai_on" && !resolved ? (
                  <button className="underline" onClick={() => void sim.investigate(inc.id)}>
                    Retry AI investigation
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="text-sm font-medium text-text">{iv.diagnosis.summary}</p>
            <div className="grid gap-3 md:grid-cols-3">
              <List title="Observed facts (from telemetry)" items={iv.diagnosis.observedFacts} />
              <List title="Inferences" items={iv.diagnosis.inferences} />
              <List title="Unknown / missing information" items={iv.diagnosis.unknowns} tone="text-warning-text" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Likely causes & alternative explanations</div>
              <div className="mt-1 space-y-2">
                {iv.diagnosis.likelyCauses.map((c, i) => (
                  <div key={i} className="rounded-xl border border-border p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-text">{c.cause}</span>
                      <Chip tone="neutral">{c.category.replace(/_/g, " ")}</Chip>
                      <span className="text-[11px] text-muted">confidence {(c.confidence * 100).toFixed(0)}%</span>
                      <div className="h-1.5 w-20 rounded bg-surface-2" aria-hidden>
                        <div className="h-1.5 rounded bg-accent" style={{ width: `${c.confidence * 100}%` }} />
                      </div>
                    </div>
                    <div className="mt-1.5 grid gap-2 md:grid-cols-2">
                      <List title="Supporting evidence" items={c.evidence} />
                      <List title="Limitations" items={c.limitations} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <List title="Recommended next steps" items={iv.diagnosis.nextSteps} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Reasoning summary</div>
                <p className="mt-1 text-xs text-text-2">{iv.diagnosis.reasoningSummary}</p>
              </div>
            </div>
            {iv.validationNotes.length ? <List title="Output validation notes" items={iv.validationNotes} tone="text-warning-text" /> : null}
            {inc.investigations.length > 1 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">Earlier investigations ({inc.investigations.length - 1})</summary>
                <ul className="mt-1 space-y-1">
                  {inc.investigations.slice(0, -1).map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-2">
                      <span className="tabular text-muted">{fmtSimTime(o.appliedAt)}</span> <SourceBadge source={o.source} status={o.status} routing={o.aiRouting} /> {o.diagnosis.summary.slice(0, 140)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
