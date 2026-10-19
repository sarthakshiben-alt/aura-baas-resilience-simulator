"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import Link from "next/link";
import { Activity, FlaskConical, Sparkles } from "lucide-react";
import { useSim } from "@/client/provider";
import { Button, Card, CardHeader, Empty, Kpi } from "@/components/ui/primitives";
import { PartnerTable } from "@/components/dashboard/partner-table";
import { IncidentTimeline } from "@/components/dashboard/timeline";
import { TimeSeriesChart, entityRows, entitySeries, gatewayRows } from "@/components/charts";
import { BreakerBadge, ProtectionBadge, RetailBadge, SeverityBadge, SimTag } from "@/components/status";
import { PARTNER_IDS } from "@/lib/sim/types";
import { fmtMs, fmtNum, fmtPct } from "@/lib/utils";

function OverviewPageInner() {
  const sim = useSim();
  const s = sim.state;
  const g = s.history.gateway.at(-1) ?? null;
  const open = s.incidents.filter((i) => i.status !== "resolved");
  const shown = open.at(-1) ?? s.incidents.at(-1) ?? null;
  const openBreakers = PARTNER_IDS.filter((p) => s.runtime[p].breaker.state !== "closed").length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-lg font-semibold text-text">Aura BaaS gateway — resilience overview</h1>
            <p className="mt-1 text-sm text-text-2">
              Five fintech partners and Aura&apos;s retail banking share one API gateway. A slow partner downstream keeps requests in flight and can exhaust shared capacity. This simulator shows
              deterministic protections containing that, and measures whether AI-assisted investigation adds value on top. <SimTag>Synthetic telemetry</SimTag>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="primary" onClick={() => sim.setGuideStep(0)}>
              <Sparkles className="h-4 w-4" /> Start Guided Demo
            </Button>
            <Button asChild variant="secondary">
              <Link href="/simulator">
                <FlaskConical className="h-4 w-4" /> Free exploration
              </Link>
            </Button>
          </div>
        </div>
      </Card>

      <section aria-label="Platform metrics" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Total requests" value={g ? `${fmtNum(g.totalRps)}/s` : "—"} sub="offered, all services" />
        <Kpi label="Platform P95" value={fmtMs(g?.platformP95Ms)} sub="request-weighted mixture" />
        <Kpi label="Platform errors" value={fmtPct(g?.platformErrorRate, 2)} sub="incl. control rejections" />
        <Kpi label="Gateway concurrency" value={fmtPct(g?.utilisation, 0)} sub={g ? `${fmtNum(g.allocatedSlots)} / ${g.capacitySlots} slots` : ""} status={g ? <ProtectionBadge status={g.protectionStatus} /> : null} />
        <Kpi label="Active incidents" value={open.length} sub={shown ? <SeverityBadge severity={shown.severity} /> : "none"} />
        <Kpi label="Degraded partners" value={g ? g.degradedPartners : 0} sub="of 5 not healthy" />
        <Kpi label="Retail banking" value={fmtMs(g?.retailP95Ms)} sub="P95 vs 300 ms target" status={g ? <RetailBadge health={g.retailHealth} /> : null} />
        <Kpi label="Circuit breakers" value={`${openBreakers} open`} sub={s.controls.breakerEnabled ? "of 5, auto-managed" : "disabled"} status={openBreakers ? <BreakerBadge state="open" /> : <BreakerBadge state="closed" enabled={s.controls.breakerEnabled} />} />
      </section>

      <Card>
        <CardHeader title="Fintech partners and retail banking" subtitle="Per-service simulated telemetry, latest simulated second. 'Protected' = impaired but contained by a gateway control." />
        <PartnerTable />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="P95 latency by service" subtitle="Log scale · last 3 simulated minutes" />
          <div className="p-3">
            <TimeSeriesChart data={entityRows(s, "p95Ms")} series={entitySeries()} unit=" ms" log refLines={[{ y: 400, label: "degraded 400 ms", tone: "warning" }, { y: 300, label: "retail target 300 ms", tone: "critical" }]} ariaLabel="P95 latency by service over time" />
          </div>
        </Card>
        <Card>
          <CardHeader title="In-flight requests by partner" subtitle="Gateway worker slots held · per-partner limit shown" />
          <div className="p-3">
            <TimeSeriesChart data={entityRows(s, "inFlight", 180, PARTNER_IDS)} series={entitySeries(PARTNER_IDS)} refLines={[{ y: s.controls.perPartnerLimit, label: `limit ${s.controls.perPartnerLimit}`, tone: "muted" }]} ariaLabel="In-flight requests per partner" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Shared gateway utilisation" subtitle="Allocated slots / capacity (%) and demand pressure (capped at 200%)" />
          <div className="p-3">
            <TimeSeriesChart data={gatewayRows(s)} series={[{ key: "utilisation", label: "Utilisation", color: "var(--s1)" }, { key: "pressure", label: "Demand pressure", color: "var(--s7)", dashed: true }]} unit="%" refLines={[{ y: 85, label: "pressure 85%", tone: "warning" }]} ariaLabel="Gateway utilisation over time" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Retail banking P95 vs service target" subtitle="Protected service · simulated 300 ms P95 target" />
          <div className="p-3">
            <TimeSeriesChart data={gatewayRows(s)} series={[{ key: "retail", label: "Retail P95", color: "var(--s6)" }]} unit=" ms" refLines={[{ y: 300, label: "target 300 ms", tone: "critical" }, { y: 255, label: "at-risk 255 ms", tone: "warning" }]} ariaLabel="Retail banking P95 latency vs target" />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={shown ? `Incident timeline — ${shown.id}` : "Incident timeline"}
          subtitle={shown ? `Status: ${shown.status} · times are simulated (mm:ss)` : undefined}
          right={
            shown ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/investigation?incident=${shown.id}`}>
                  <Activity className="h-3.5 w-3.5" /> Investigate
                </Link>
              </Button>
            ) : null
          }
        />
        <div className="p-4">{shown ? <IncidentTimeline state={s} inc={shown} /> : <Empty>No incidents yet. Trigger a scenario from the Incident simulator or start the guided demo.</Empty>}</div>
      </Card>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <ClientOnly fallback={<PageLoading />}>
      <OverviewPageInner />
    </ClientOnly>
  );
}
