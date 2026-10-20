import { Ban, Bot, CircleCheck, CircleDashed, Cpu, OctagonX, RotateCw, ShieldAlert, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ApprovalStatus, BreakerState, DiagnosisSource, GatewayProtectionStatus, HealthStatus, RetailHealth, Severity, ValidationStatus } from "@/lib/sim/types";
import { cn } from "@/lib/utils";

type Tone = "good" | "warning" | "serious" | "critical" | "info" | "neutral";
const TONE: Record<Tone, string> = {
  good: "border-good/40 bg-good/10 text-good-text",
  warning: "border-warning/50 bg-warning/15 text-warning-text",
  serious: "border-serious/50 bg-serious/15 text-serious-text",
  critical: "border-critical/40 bg-critical/10 text-critical-text",
  info: "border-info/40 bg-info/10 text-info-text",
  neutral: "border-border bg-surface-2 text-text-2",
};

export function Chip({ tone, icon: Icon, children, title, className }: { tone: Tone; icon?: LucideIcon; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", TONE[tone], className)}>
      {Icon ? <Icon aria-hidden className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}

export const HEALTH_META: Record<HealthStatus, { tone: Tone; icon: LucideIcon; label: string; help: string }> = {
  healthy: { tone: "good", icon: CircleCheck, label: "Healthy", help: "Within healthy thresholds (P95 ≤ 400 ms, errors ≤ 2%, no active control rejections)." },
  degraded: { tone: "warning", icon: TriangleAlert, label: "Degraded", help: "Latency or errors above thresholds and not contained by a gateway control." },
  protected: { tone: "serious", icon: ShieldAlert, label: "Protected", help: "Partner impaired, but a gateway control (breaker, concurrency cap or rate limit) is actively containing it to shield shared infrastructure." },
  recovering: { tone: "info", icon: RotateCw, label: "Recovering", help: "Back within thresholds; recovery not yet verified (30 s sustained healthy window)." },
  unavailable: { tone: "critical", icon: OctagonX, label: "Unavailable", help: "Fewer than 50% of requests succeed and no control is containing the failure." },
};

export function HealthBadge({ status }: { status: HealthStatus }) {
  const m = HEALTH_META[status];
  return (
    <Chip tone={m.tone} icon={m.icon} title={m.help}>
      {m.label}
    </Chip>
  );
}

export function RetailBadge({ health }: { health: RetailHealth }) {
  if (health === "healthy") return <Chip tone="good" icon={CircleCheck} title="Retail P95 ≤ 85% of its 300 ms simulated target">Within target</Chip>;
  if (health === "at_risk") return <Chip tone="warning" icon={TriangleAlert} title="Retail P95 > 85% of target (near-breach)">At risk</Chip>;
  return <Chip tone="critical" icon={OctagonX} title="Retail P95 above its 300 ms simulated target">Target breached</Chip>;
}

export function BreakerBadge({ state, enabled = true }: { state: BreakerState; enabled?: boolean }) {
  if (!enabled) return <Chip tone="neutral" icon={Ban}>Disabled</Chip>;
  if (state === "closed") return <Chip tone="neutral" icon={CircleCheck}>Closed</Chip>;
  if (state === "half_open") return <Chip tone="info" icon={CircleDashed}>Half-open</Chip>;
  return <Chip tone="serious" icon={ShieldAlert}>Open</Chip>;
}

export function ProtectionBadge({ status }: { status: GatewayProtectionStatus }) {
  const map: Record<GatewayProtectionStatus, [Tone, LucideIcon, string]> = {
    nominal: ["good", ShieldCheck, "Nominal"],
    protecting: ["info", ShieldCheck, "Protecting"],
    pressure: ["warning", TriangleAlert, "Under pressure"],
    saturated: ["critical", OctagonX, "Saturated"],
  };
  const [tone, icon, label] = map[status];
  return (
    <Chip tone={tone} icon={icon}>
      {label}
    </Chip>
  );
}

export function SourceBadge({ source, status, routing }: { source: DiagnosisSource; status?: string; routing?: "skipped" | "invoked" }) {
  if (routing === "skipped") return <Chip tone="good" icon={Cpu} title="Smart routing: the rulebook classified this incident, so no AI call was made">Rulebook — AI not needed</Chip>;
  if (status === "failed") return <Chip tone="critical" icon={OctagonX}>Investigation failed</Chip>;
  if (source === "llm") return <Chip tone="info" icon={Bot} title="Structured output from the configured LLM, validated against the schema">Real LLM response</Chip>;
  if (source === "rule_based_fallback") return <Chip tone="warning" icon={Cpu} title="The LLM was unavailable or failed; this is the deterministic rule-based assessment">Rule-based fallback</Chip>;
  return <Chip tone="neutral" icon={Cpu} title="AI assistance OFF: conventional rule-based investigator and runbook">Rule-based (conventional)</Chip>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const tone: Record<Severity, Tone> = { low: "neutral", medium: "warning", high: "serious", critical: "critical" };
  return <Chip tone={tone[severity]}>{severity.toUpperCase()}</Chip>;
}

export function PolicyBadge({ status }: { status: ValidationStatus }) {
  if (status === "valid") return <Chip tone="good" icon={ShieldCheck}>Policy: valid</Chip>;
  if (status === "valid_with_warnings") return <Chip tone="warning" icon={TriangleAlert}>Policy: valid (warnings)</Chip>;
  return <Chip tone="critical" icon={Ban}>Policy: rejected</Chip>;
}

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  const tone: Record<ApprovalStatus, Tone> = {
    pending: "info",
    approved: "good",
    rejected: "neutral",
    cancelled: "neutral",
    superseded: "neutral",
    expired: "neutral",
    not_approvable: "critical",
  };
  return <Chip tone={tone[status]}>{status.replace("_", " ")}</Chip>;
}

export function SimTag({ children = "Simulated" }: { children?: React.ReactNode }) {
  return <span className="rounded border border-warning/50 bg-warning/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warning-text">{children}</span>;
}
