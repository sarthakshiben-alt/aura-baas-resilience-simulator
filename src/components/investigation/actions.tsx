"use client";

import { Ban, Check, LoaderCircle, X } from "lucide-react";
import { useSim } from "@/client/provider";
import { getAction } from "@/lib/sim/actions";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import type { Incident } from "@/lib/sim/types";
import { Button, Card, CardHeader, Empty } from "@/components/ui/primitives";
import { ApprovalBadge, Chip, PolicyBadge, SourceBadge } from "@/components/status";
import { fmtSimTime } from "@/lib/utils";

export function ActionApproval({ inc }: { inc: Incident }) {
  const sim = useSim();
  const latestInv = inc.investigations.at(-1);
  const recs = inc.recommendations.filter((r) => r.investigationId === latestInv?.id || r.approval === "approved" || r.executedAt !== null);
  const evidence = latestInv?.diagnosis.likelyCauses[0]?.evidence ?? [];
  return (
    <Card>
      <CardHeader title="Action approval" subtitle="Predefined simulated operations only. The policy engine validates each one independently; nothing executes without human approval." />
      <div className="space-y-3 p-4">
        {!recs.length ? <Empty>No recommendations yet. Run an investigation to receive proposed actions.</Empty> : null}
        {recs.map((r) => {
          const def = getAction(r.actionId);
          const busy = sim.busyRecs.has(r.id);
          const check = inc.postActionChecks.find((c) => c.recommendationId === r.id);
          const countdown = r.scheduledExecutionAt !== null && r.executedAt === null ? r.scheduledExecutionAt - sim.state.tick : null;
          return (
            <div key={r.id} className="rounded-md border border-border p-3" data-testid="recommendation" data-action={r.actionId}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text">{def?.label ?? `Unknown action "${r.actionId}"`}</span>
                {r.targetEntityId ? <Chip tone="neutral">{ENTITY_PROFILES[r.targetEntityId].name}</Chip> : null}
                <Chip tone="warning">Simulated action</Chip>
                <SourceBadge source={r.source} />
                <PolicyBadge status={r.validation.status} />
                <ApprovalBadge status={r.approval} />
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs md:grid-cols-2">
                <div><dt className="text-muted">Reason</dt><dd className="text-text-2">{r.rationale}</dd></div>
                <div><dt className="text-muted">Supporting evidence</dt><dd className="text-text-2">{evidence.slice(0, 2).join(" · ") || "—"}</dd></div>
                <div><dt className="text-muted">Expected benefit</dt><dd className="text-text-2">{def?.expectedBenefit ?? "—"}</dd></div>
                <div><dt className="text-muted">Potential risk</dt><dd className="text-text-2">{def?.risk ?? "Unknown action: cannot be executed."}</dd></div>
                <div><dt className="text-muted">Reversibility</dt><dd className="text-text-2">{def?.reversibility ?? "—"}</dd></div>
                <div>
                  <dt className="text-muted">Policy validation</dt>
                  <dd className={r.validation.status === "rejected" ? "text-critical-text" : "text-text-2"}>
                    {r.validation.reasons.join(" ")} {r.validation.warnings.length ? <span className="text-warning-text">Warnings: {r.validation.warnings.join(" ")}</span> : null}
                  </dd>
                </div>
              </dl>
              {r.executedAt !== null ? (
                <div className="mt-2 rounded bg-surface-2 px-2 py-1.5 text-xs text-text-2">
                  Executed at {fmtSimTime(r.executedAt)} — {r.executionOutcome}
                  {check ? <div className="mt-0.5">Post-action verification: {check.after ? `${check.effective === null ? "n/a" : check.effective ? "effective" : "not effective"} — ${check.note}` : `pending (at ${fmtSimTime(check.evaluateAt)})`}</div> : null}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {r.approval === "pending" ? (
                  <>
                    <Button size="sm" variant="success" disabled={busy} onClick={() => void sim.decide(inc.id, r.id, "approve")} data-testid="approve">
                      {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void sim.decide(inc.id, r.id, "reject")} data-testid="reject">
                      <X className="h-3.5 w-3.5" /> Reject
                    </Button>
                  </>
                ) : null}
                {countdown !== null && r.approval === "approved" ? (
                  <>
                    <span className="self-center text-xs text-info-text">Executes in {countdown}s (simulated rollout)</span>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void sim.decide(inc.id, r.id, "cancel")}>
                      <Ban className="h-3.5 w-3.5" /> Cancel pending action
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
