"use client";

import { ClientOnly, PageLoading } from "@/client/client-only";
import Link from "next/link";
import { Activity, FlaskConical, Sparkles } from "lucide-react";
import { useSim } from "@/client/provider";
import { Button, Card, CardHeader, Empty, Kpi } from "@/components/ui/primitives";
import { PartnerTable } from "@/components/dashboard/partner-table";
import { IncidentTimeline } from "@/components/dashboard/timeline";
import { TimeSeriesChart, focusRows, focusSeries } from "@/components/charts";
import { ProtectionBadge, RetailBadge, SeverityBadge, SimTag } from "@/components/status";
import { fmtMs, fmtPct } from "@/lib/utils";

function OverviewPageInner() {
  const sim = useSim();
  const s = sim.state;
  const g = s.history.gateway.at(-1) ?? null;
  const open = s.incidents.filter((i) => i.status !== "resolved");
  const shown = open.at(-1) ?? s.incidents.at(-1) ?? null;
  const healthy = g ? 5 - g.degradedPartners : 5;
  const series = focusSeries(s);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-lg font-semibold text-text">Aura Bank gateway — is everything OK?</h1>
            <p className="mt-1 text-sm text-text-2">
              Five fintech partners and Aura&apos;s own retail banking share one gateway. When one partner gets slow, the gateway&apos;s automatic protections stop it from dragging everyone else down. <SimTag>Simulated data</SimTag>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="primary" onClick={() => sim.setGuideStep(0)}>
              <Sparkles className="h-4 w-4" /> Start Guided Demo
            </Button>
            <Button asChild variant="secondary">
              <Link href="/simulator">
                <FlaskConical className="h-4 w-4" /> Trigger an incident
              </Link>
            </Button>
          </div>
        </div>
      </Card>

      <section aria-label="Platform status" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Partners healthy" value={`${healthy} / 5`} sub={healthy === 5 ? "all good" : `${5 - healthy} need attention`} />
        <Kpi label="Retail banking" value={fmtMs(g?.retailP95Ms)} sub="response time · target ≤ 300 ms" status={g ? <RetailBadge health={g.retailHealth} /> : null} />
        <Kpi label="Gateway load" value={fmtPct(g?.utilisation, 0)} sub="of shared capacity in use" status={g ? <ProtectionBadge status={g.protectionStatus} /> : null} />
        <Kpi label="Open incidents" value={open.length} sub={open.length && shown ? <SeverityBadge severity={shown.severity} /> : "none"} />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="How fast is each service responding?" subtitle="95% of requests finish faster than this. Lower is better. Last 3 simulated minutes." />
          <div className="p-3">
            <TimeSeriesChart
              data={focusRows(s, "p95Ms")}
              series={series}
              unit=" ms"
              yLabel="milliseconds"
              refLines={[{ y: 400, label: "slow above 400 ms", tone: "warning" }]}
              ariaLabel="Response time of the most affected partner, other partners and retail banking"
            />
            <p className="mt-2 text-xs text-muted">A gap in the line means the circuit breaker has paused traffic to that partner — that&apos;s the protection working, not a recovery.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="What share of requests succeed?" subtitle="Higher is better. 100% = every request answered." />
          <div className="p-3">
            <TimeSeriesChart data={focusRows(s, "successRate")} series={series} unit="%" yLabel="% succeeded" domain={[0, 100]} ariaLabel="Request success rate of the most affected partner, other partners and retail banking" />
            <p className="mt-2 text-xs text-muted">If only the affected partner drops while the others stay near 100%, the problem has been contained.</p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Services right now" subtitle="Protected = having problems, but contained by the gateway." />
        <PartnerTable />
      </Card>

      <Card>
        <CardHeader
          title={shown ? `Incident progress — ${shown.id}` : "Incident progress"}
          subtitle={shown ? `Status: ${shown.status} · simulated time (mm:ss)` : undefined}
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
        <div className="p-4">{shown ? <IncidentTimeline state={s} inc={shown} compact /> : <Empty>No incidents yet. Trigger one from the Incident simulator or start the guided demo.</Empty>}</div>
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
