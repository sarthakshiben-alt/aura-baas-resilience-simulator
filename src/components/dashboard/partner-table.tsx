"use client";

import { useSim } from "@/client/provider";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import { latest } from "@/lib/sim/engine";
import { ENTITY_IDS, type EntityId } from "@/lib/sim/types";
import { BreakerBadge, HealthBadge, RetailBadge } from "@/components/status";
import { ENTITY_COLOR } from "@/components/charts";
import { fmtMs, fmtNum, fmtPct, fmtSimTime } from "@/lib/utils";

/** Partner health table — also the accessible table view for the charts. */
export function PartnerTable() {
  const sim = useSim();
  const s = sim.state;
  const g = s.history.gateway.at(-1);
  const lastIncident = (id: EntityId) => {
    const inc = [...s.incidents].reverse().find((i) => i.affectedEntityIds.includes(id));
    return inc ? `${inc.id} @ ${fmtSimTime(inc.detectedAt)}` : "—";
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-left text-xs" data-testid="partner-table">
        <caption className="sr-only">Simulated health of fintech partners and retail banking</caption>
        <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Service</th>
            <th className="px-3 py-2 font-medium">Health</th>
            <th className="px-3 py-2 text-right font-medium">P95</th>
            <th className="px-3 py-2 text-right font-medium">Error rate</th>
            <th className="px-3 py-2 text-right font-medium">Throughput</th>
            <th className="px-3 py-2 text-right font-medium">In-flight / limit</th>
            <th className="px-3 py-2 font-medium">Breaker</th>
            <th className="px-3 py-2 font-medium">Controls</th>
            <th className="px-3 py-2 font-medium">Last incident</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {ENTITY_IDS.map((id) => {
            const x = latest(s, id);
            const p = ENTITY_PROFILES[id];
            const isRetail = id === "retail";
            const ctl: string[] = [];
            if (!isRetail) {
              if (s.controls.caps[id] !== undefined) ctl.push(`cap ${s.controls.caps[id]}`);
              if (s.controls.rateLimits[id] !== undefined) ctl.push(`rate ≤ ${s.controls.rateLimits[id]} rps`);
            } else if (s.controls.retailReservationEnabled) ctl.push(`reserved ${s.controls.retailReservationSlots} slots`);
            return (
              <tr key={id} className="border-b border-border last:border-0" data-testid={`row-${id}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: ENTITY_COLOR[id] }} />
                    <div>
                      <div className="font-semibold text-text">{p.name}</div>
                      <div className="text-[11px] text-muted">{p.segment}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">{x ? isRetail && g ? <RetailBadge health={g.retailHealth} /> : <HealthBadge status={x.status} /> : "—"}</td>
                <td className="px-3 py-2 text-right font-medium text-text">{x ? fmtMs(x.p95Ms) : "—"}{isRetail ? <div className="text-[10px] text-muted">target 300 ms</div> : null}</td>
                <td className="px-3 py-2 text-right">{x ? fmtPct(x.errorRate, 2) : "—"}</td>
                <td className="px-3 py-2 text-right">{x ? `${fmtNum(x.offeredRps)} rps` : "—"}</td>
                <td className="px-3 py-2 text-right">
                  {x ? fmtNum(x.inFlight, 1) : "—"}
                  <span className="text-muted"> / {isRetail ? "pool" : x?.concurrencyLimit ?? "∞"}</span>
                </td>
                <td className="px-3 py-2">{isRetail ? <span className="text-muted">n/a</span> : x ? <BreakerBadge state={x.breaker} enabled={s.controls.breakerEnabled} /> : "—"}</td>
                <td className="px-3 py-2 text-text-2">{ctl.join(", ") || <span className="text-muted">default</span>}</td>
                <td className="px-3 py-2 text-text-2">{lastIncident(id)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
