"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Bot, Cpu, FlaskConical, Info, LayoutDashboard, MessageSquare, Pause, Play, RefreshCcw, Scale, Search, Sparkles } from "lucide-react";
import { useSim } from "@/client/provider";
import { SPEED_OPTIONS } from "@/lib/client-shared";
import { Button, Select, Switch } from "@/components/ui/primitives";
import { cn, fmtSimTime } from "@/lib/utils";
import { GuidedDemo } from "@/components/guided-demo";
import { ClientOnly } from "@/client/client-only";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/simulator", label: "Incident simulator", icon: FlaskConical },
  { href: "/investigation", label: "Incident investigation", icon: Search },
  { href: "/investigation#assistant", label: "AI assistant", icon: MessageSquare },
  { href: "/comparison", label: "AI comparison", icon: Scale },
  { href: "/methodology", label: "Methodology & assumptions", icon: BookOpen },
  { href: "/about", label: "About this demo", icon: Info },
];

export function SimulatedBanner() {
  return (
    <div role="note" className="bg-sim-banner px-4 py-1 text-center text-[11px] font-bold tracking-[0.12em] text-sim-banner-text">
      SIMULATED ENVIRONMENT — NO REAL BANKING SYSTEM CONNECTED
    </div>
  );
}

function AiToggle() {
  const sim = useSim();
  const on = sim.aiMode === "ai_on";
  const live = sim.aiStatus?.configured;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5" data-testid="ai-toggle">
      <span className="text-[11px] font-bold tracking-wide text-text">AI ASSISTANCE</span>
      <Switch checked={on} onCheckedChange={(v) => sim.setAiMode(v ? "ai_on" : "ai_off")} label="AI assistance on or off" />
      <span className={cn("w-7 text-xs font-bold", on ? "text-info-text" : "text-muted")}>{on ? "ON" : "OFF"}</span>
      <span
        className={cn("hidden items-center gap-1 text-[11px] lg:inline-flex", live ? "text-info-text" : "text-warning-text")}
        title={live ? `Live AI: ${sim.aiStatus?.provider} / ${sim.aiStatus?.model}` : sim.aiStatus?.reason ?? "Checking AI configuration…"}
      >
        {live ? <Bot className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}
        {sim.aiStatus === null ? "checking…" : live ? `${sim.aiStatus.model}` : "Live AI not configured → rule-based fallback"}
      </span>
    </div>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <SimulatedBanner />
      <ClientOnly fallback={<div className="h-12" />}>
        <TopControls />
      </ClientOnly>
    </header>
  );
}

function TopControls() {
  const sim = useSim();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs" aria-live="off">
          <span className="text-muted">Sim clock</span>
          <span className="tabular font-semibold text-text" data-testid="sim-clock">{fmtSimTime(sim.state.tick)}</span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => (sim.running ? sim.pause() : sim.start())} aria-label={sim.running ? "Pause simulation" : "Resume simulation"}>
          {sim.running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {sim.running ? "Pause" : "Run"}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-text-2">
          Speed
          <Select value={sim.speed} onChange={(e) => sim.setSpeed(Number(e.target.value))} className="h-8 text-xs" aria-label="Simulation speed">
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}× {s === 1 ? "(real time)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <AiToggle />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => sim.setGuideStep(0)} data-testid="start-guided-demo">
            <Sparkles className="h-3.5 w-3.5" /> Start Guided Demo
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void sim.reset()} data-testid="reset-scenario">
            <RefreshCcw className="h-3.5 w-3.5" /> Reset Scenario
          </Button>
        </div>
      </div>
    </>
  );
}

function Notices() {
  const sim = useSim();
  if (!sim.notices.length) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(560px,92vw)] -translate-x-1/2 flex-col gap-2" role="status" aria-live="polite">
      {sim.notices.map((n) => (
        <div key={n.id} className={cn("rounded-md border px-3 py-2 text-sm shadow-lg", n.kind === "error" ? "border-critical/40 bg-surface text-critical-text" : n.kind === "warn" ? "border-warning/50 bg-surface text-warning-text" : "border-border bg-surface text-text")}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen self-start w-60 shrink-0 flex-col bg-nav text-nav-text md:flex">
        <div className="px-4 pb-4 pt-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">Aura Bank</div>
          <div className="mt-0.5 text-sm font-semibold text-white">BaaS Resilience Simulator</div>
          <div className="mt-2 inline-block rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">Synthetic data</div>
        </div>
        <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href.split("#")[0]) && !n.href.includes("#");
            return (
              <Link key={n.href} href={n.href} className={cn("flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] hover:bg-white/5", active && "bg-white/10 font-semibold text-white")}>
                <n.icon aria-hidden className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto p-4 text-[11px] leading-relaxed text-white/45">
          Product-management case study prototype. All telemetry, incidents and financial figures are simulated or illustrative.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1.5 md:hidden">
          {NAV.filter((n) => !n.href.includes("#")).map((n) => (
            <Link key={n.href} href={n.href} className={cn("whitespace-nowrap rounded px-2 py-1 text-xs", path === n.href ? "bg-surface-2 font-semibold" : "text-text-2")}>
              {n.label}
            </Link>
          ))}
        </nav>
        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
      <ClientOnly>
        <Notices />
        <GuidedDemo />
      </ClientOnly>
    </div>
  );
}
