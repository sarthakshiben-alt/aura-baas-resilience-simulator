"use client";

import { CircleCheck, CircleDashed } from "lucide-react";
import type { Incident, SimState, TimelineEvent } from "@/lib/sim/types";
import { cn, fmtSimTime } from "@/lib/utils";

const KEY_KINDS = new Set(["scenario_triggered", "degradation_detected", "entity_affected", "breaker_opened", "breaker_half_open", "breaker_closed", "investigation_started", "investigation_failed", "diagnosis_returned", "action_proposed", "action_approved", "action_rejected", "action_cancelled", "action_executed", "action_verified", "partner_remediation_started", "partner_remediation_completed", "controls_changed", "recovery_triggered", "recovery_started", "partner_recovered", "recovery_verified", "scenario_stopped"]);

export function incidentEvents(state: SimState, inc: Incident): TimelineEvent[] {
  return state.timeline.filter(
    (e) =>
      e.incidentId === inc.id ||
      (e.incidentId === null && e.t >= inc.startedAt && (inc.recoveredAt === null || e.t <= inc.recoveredAt) && (e.entityId === null ? e.kind !== "breaker_closed" : inc.affectedEntityIds.includes(e.entityId)) && KEY_KINDS.has(e.kind)),
  ).sort((a, b) => a.t - b.t || a.seq - b.seq);
}

/** The eight canonical milestones plus the detailed event log. */
export function IncidentTimeline({ state, inc, compact = false }: { state: SimState; inc: Incident; compact?: boolean }) {
  const evs = incidentEvents(state, inc);
  const first = (k: string) => evs.find((e) => e.kind === k)?.t ?? null;
  const decision = evs.find((e) => e.kind === "action_approved" || e.kind === "action_rejected");
  const milestones: [string, number | null][] = [
    ["Incident triggered", inc.startedAt],
    ["Degradation detected", inc.detectedAt],
    ["Investigation started", first("investigation_started")],
    ["Diagnosis returned", first("diagnosis_returned")],
    ["Action proposed", first("action_proposed")],
    [decision?.kind === "action_rejected" ? "Action rejected" : "Action approved", decision?.t ?? null],
    ["Recovery started", inc.recoveryStartedAt ?? (inc.recoveryVerified ? (inc.recoveredAt ?? 0) - state.config.monitoring.verificationWindowSeconds : null)],
    ["Recovery verified", inc.recoveryVerified ? inc.recoveredAt : null],
  ];
  return (
    <div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8" aria-label="Incident milestones">
        {milestones.map(([label, t]) => (
          <li key={label} className={cn("rounded-xl border px-2 py-1.5", t !== null ? "border-good/40 bg-good/5" : "border-border")}>
            <div className="flex items-center gap-1 text-[11px] font-medium text-text-2">
              {t !== null ? <CircleCheck aria-hidden className="h-3 w-3 text-good-text" /> : <CircleDashed aria-hidden className="h-3 w-3 text-muted" />}
              {label}
            </div>
            <div className="tabular text-xs font-semibold text-text">{t !== null ? `${fmtSimTime(t)} (+${t - inc.startedAt}s)` : "—"}</div>
          </li>
        ))}
      </ol>
      {!compact ? (
        <ol className="mt-3 max-h-72 space-y-1 overflow-y-auto border-l border-border pl-3 text-xs" aria-label="Incident event log">
          {evs.map((e) => (
            <li key={e.seq} className="flex gap-2">
              <span className="tabular w-12 shrink-0 text-muted">{fmtSimTime(e.t)}</span>
              <span className="text-text-2">{e.message}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
