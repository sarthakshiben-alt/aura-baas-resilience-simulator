"use client";

import { useSim } from "@/client/provider";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import { latest } from "@/lib/sim/engine";
import { ENTITY_IDS } from "@/lib/sim/types";
import { BreakerBadge, HealthBadge, RetailBadge } from "@/components/status";
import { ENTITY_COLOR } from "@/components/charts";
import { fmtMs, fmtNum, fmtPct } from "@/lib/utils";

/** Partner health table — also the accessible table view for the charts. */
export function PartnerTable() {
  const sim = useSim();
  const s = sim.state;
  const g = s.history.gateway.at(-1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs" data-testid="partner-table">
        <caption className="sr-only">Simulated health of fintech partners and retail banking</caption>
        <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Service</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium" title="95% of requests finish faster than this">Response time</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
            <th className="px-3 py-2 text-right font-medium" title="Requests currently waiting on this partner / the most it may hold">Load</th>
            <th className="px-3 py-2 font-medium" title="Closed = traffic flows normally. Open = traffic paused to protect everyone else.">Circuit breaker</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {ENTITY_IDS.map((id) => {
            const x = latest(s, id);
            const p = ENTITY_PROFILES[id];
            const isRetail = id === "retail";
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
                <td className="px-3 py-2 text-right">{x ? fmtPct(x.errorRate, 1) : "—"}</td>
                <td className="px-3 py-2 text-right">
                  {x ? fmtNum(x.inFlight) : "—"}
                  <span className="text-muted"> / {isRetail ? "reserved" : x?.concurrencyLimit ?? "∞"}</span>
                </td>
                <td className="px-3 py-2">{isRetail ? <span className="text-muted">n/a</span> : x ? <BreakerBadge state={x.breaker} enabled={s.controls.breakerEnabled} /> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
