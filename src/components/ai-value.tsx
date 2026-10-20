"use client";

import { useSim } from "@/client/provider";
import { Chip } from "@/components/status";
import type { PairedRunResult } from "@/lib/comparison/paired";
import { aiArmStatus } from "@/lib/comparison/metrics";
import { cn } from "@/lib/utils";

/**
 * Recorded live runs (deployed app, Groq qwen/qwen3.8-27b, 10 min assumed triage).
 * Shown ONLY when no live result exists in this session (e.g. the free AI quota is
 * used up), and always labelled as recorded. Source: docs/results/README.md.
 */
export const RECORDED_RUNS = {
  "GS-01": { date: "2026-10-19", manualS: 695, rulesS: 134, aiS: 134, tokens: null as number | null },
  "GS-19": { date: "2026-10-19", manualS: 1295, rulesS: 695, aiS: 97, tokens: null as number | null },
} as const;

export interface AiValue {
  source: "live" | "recorded" | "none";
  date?: string;
  manualS: number;
  rulesS: number;
  aiS: number;
  /** SLA penalty avoided by AI over the automated rulebook (USD; ≤ 0 means no value). */
  aiExtraUsd: number;
  automationUsd: number;
  tokens: number | null;
  /** Price per 1,000 tokens at which AI stops paying for itself on this incident. */
  breakEvenPer1kTokensUsd: number | null;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const mins = (s: number) => `${(Math.round((s / 60) * 10) / 10).toLocaleString("en-US")} min`;

export function aiValue(live: PairedRunResult | null, id: "GS-01" | "GS-19", costPerMin: number): AiValue {
  const pen = (s: number) => (s / 60) * costPerMin;
  const st = live ? aiArmStatus(live.on.metrics) : "none";
  if (live && (st === "llm" || st === "skipped")) {
    const m = (k: "off" | "rules" | "on") => live[k].metrics.primarySlaBreachSeconds;
    const extra = pen(m("rules") - m("on"));
    const tokens = live.on.metrics.tokens;
    return { source: "live", manualS: m("off"), rulesS: m("rules"), aiS: m("on"), aiExtraUsd: extra, automationUsd: pen(m("off") - m("rules")), tokens, breakEvenPer1kTokensUsd: tokens && extra > 0 ? (extra / tokens) * 1000 : null };
  }
  const rec = RECORDED_RUNS[id];
  const extra = pen(rec.rulesS - rec.aiS);
  return { source: "recorded", date: rec.date, manualS: rec.manualS, rulesS: rec.rulesS, aiS: rec.aiS, aiExtraUsd: extra, automationUsd: pen(rec.manualS - rec.rulesS), tokens: rec.tokens, breakEvenPer1kTokensUsd: null };
}

function Column({ emoji, title, v, verdict, tone }: { emoji: string; title: string; v: AiValue; verdict: React.ReactNode; tone: "neutral" | "good" }) {
  return (
    <div className={cn("rounded-2xl border p-4", tone === "good" ? "border-good/40 bg-[#ebfaf3]" : "border-border bg-surface-2/60")} data-testid={`ai-value-${title.toLowerCase().split(" ")[0]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-extrabold text-text">
          {emoji} {title}
        </div>
        {v.source === "live" ? <Chip tone="info">Live AI, this session</Chip> : <Chip tone="neutral">Recorded live run · {v.date}</Chip>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl bg-surface p-2">
          <div className="text-[11px] font-semibold text-muted">📘 Rules only</div>
          <div className="tabular text-lg font-extrabold text-text">{mins(v.rulesS)}</div>
          <div className="text-[11px] text-muted">outside SLA</div>
        </div>
        <div className="rounded-xl bg-surface p-2">
          <div className="text-[11px] font-semibold text-muted">🤖 Rules + AI</div>
          <div className={cn("tabular text-lg font-extrabold", v.aiExtraUsd > 0 ? "text-good-text" : "text-text")}>{mins(v.aiS)}</div>
          <div className="text-[11px] text-muted">outside SLA</div>
        </div>
      </div>
      <div className="mt-3 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Extra SLA penalty AI avoided</div>
        <div className={cn("tabular text-2xl font-extrabold", v.aiExtraUsd > 0 ? "text-good-text" : "text-text")}>{usd(Math.max(0, v.aiExtraUsd))}</div>
      </div>
      <p className="mt-2 text-xs text-text-2">{verdict}</p>
    </div>
  );
}

/** Routine vs mystery, side by side: where AI pays for itself and where it doesn't. */
export function AiValueSummary({ cost, compact = false }: { cost: number; compact?: boolean }) {
  const sim = useSim();
  const routine = aiValue(sim.pairedByGolden["GS-01"] ?? null, "GS-01", cost);
  const mystery = aiValue(sim.pairedByGolden["GS-19"] ?? null, "GS-19", cost);
  return (
    <div className={cn("grid gap-3", !compact && "md:grid-cols-2")} data-testid="ai-value-summary">
      <Column
        emoji="🐢"
        title="Routine incident"
        v={routine}
        tone="neutral"
        verdict={
          routine.aiExtraUsd > 0 ? (
            <>AI shaved a little off here, but the rulebook already knows this failure.</>
          ) : (
            <>
              The rulebook already knows this failure, so AI adds <b>nothing</b>. Paying for AI here is pure cost. The {usd(routine.automationUsd)} saving vs a human comes from <b>automation</b>, not AI.
            </>
          )
        }
      />
      <Column
        emoji="🎲"
        title="Mystery incident"
        v={mystery}
        tone={mystery.aiExtraUsd > 0 ? "good" : "neutral"}
        verdict={
          mystery.aiExtraUsd > 0 ? (
            <>
              No rule fits, so the rulebook pages a human and waits. AI connects the weak signals and escalates to the right partner straight away.{" "}
              {mystery.breakEvenPer1kTokensUsd !== null && mystery.tokens ? (
                <>
                  It used <b>{mystery.tokens.toLocaleString("en-US")} tokens</b>: AI would have to cost over <b>{usd(mystery.breakEvenPer1kTokensUsd)} per 1,000 tokens</b> before it stopped paying for itself here.
                </>
              ) : (
                <>Typically one or two AI calls (a few thousand tokens) — far less than one minute of SLA penalty.</>
              )}
            </>
          ) : (
            <>AI didn&apos;t beat the rulebook in this run. Honest result: AI value depends on it actually cracking the case.</>
          )
        }
      />
      {!compact ? (
        <p className="text-[11px] text-muted md:col-span-2">
          Value for money = use AI only where the rulebook gives up. At ${cost.toLocaleString("en-US")}/min (an assumption), every minute AI saves on an unclassifiable incident is worth far more than the AI call. The mystery&apos;s gap depends on the assumed {sim.manualTriageMinutes} min a paged human needs; recorded runs are shown when this session has no live AI result (e.g. the free AI quota is used up).
        </p>
      ) : null}
    </div>
  );
}
