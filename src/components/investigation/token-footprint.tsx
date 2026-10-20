"use client";

import { useMemo } from "react";
import { useSim } from "@/client/provider";
import { buildIncidentContext } from "@/lib/ai/context";
import { buildInvestigationUserMessage, INVESTIGATION_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { ENTITY_IDS, type Incident, type InvestigationRecord } from "@/lib/sim/types";

/** Rough token estimate (≈4 characters per token for English/JSON). Labelled as an estimate wherever shown. */
const est = (text: string) => Math.round(text.length / 4);
/** ASSUMPTION for the "send raw logs" comparison: tokens in one request log line. */
const TOKENS_PER_LOG_LINE = 25;
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000).toLocaleString("en-US")}k` : n.toLocaleString("en-US"));

/**
 * Token-efficiency view for one investigation (ideas 2 & 5): the AI reads a compact,
 * structured summary instead of raw telemetry, and answers into a bounded schema.
 */
export function TokenFootprint({ inc, iv }: { inc: Incident; iv: InvestigationRecord }) {
  const sim = useSim();
  const s = sim.state;
  const sizes = useMemo(() => {
    const ctx = buildIncidentContext(s, inc.id);
    const message = buildInvestigationUserMessage(ctx);
    const g = s.history.gateway;
    const from = Math.max(0, g.length - 60);
    const samples = JSON.stringify({ gateway: g.slice(from), entities: Object.fromEntries(ENTITY_IDS.map((id) => [id, s.history.entities[id].slice(from)])) });
    const requests = ENTITY_IDS.reduce((sum, id) => sum + s.history.entities[id].slice(from).reduce((a, x) => a + (x.offeredRps ?? 0), 0), 0);
    return { message, summary: est(message), system: est(INVESTIGATION_SYSTEM_PROMPT), samples: est(samples), logs: Math.round(requests) * TOKENS_PER_LOG_LINE, requests: Math.round(requests) };
    // Recompute only when the investigation changes, not every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv.id, inc.id]);
  const measuredIn = iv.usage?.promptTokens ?? null;
  const measuredOut = iv.usage?.completionTokens ?? null;
  const skipped = iv.aiRouting === "skipped";
  const called = iv.attempts > 0;

  return (
    <div className="rounded-2xl border border-border bg-surface-2/50 p-3 text-xs" data-testid="token-footprint">
      <div className="mb-2 font-bold text-text">⚡ Token footprint</div>
      {skipped ? (
        <p className="text-good-text">
          <b>0 tokens.</b> Smart routing: the rulebook classified this incident, so the AI wasn&apos;t called. An AI call here would have read ≈{k(sizes.summary + sizes.system)} tokens for no extra insight.
        </p>
      ) : !called ? (
        <p className="text-text-2">AI assistance was off for this investigation — the rulebook ran locally at no token cost.</p>
      ) : (
        <ul className="space-y-1 text-text-2">
          <li>
            📥 <b>Read:</b> {measuredIn !== null ? <><b>{k(measuredIn)}</b> tokens (measured by the provider)</> : <>≈{k(sizes.summary + sizes.system)} tokens (estimated)</>} — a compact summary, not raw telemetry.
          </li>
          <li>
            📤 <b>Wrote:</b> {measuredOut !== null ? <><b>{k(measuredOut)}</b> tokens (measured)</> : "not reported"} — answers must fit a fixed format: ≤4 causes, ≤10 facts, ≤4 actions, ≤300 characters per item.
          </li>
        </ul>
      )}
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-surface p-2">
          <div className="tabular text-sm font-extrabold text-good-text">≈{k(sizes.summary)}</div>
          <div className="text-[10px] text-muted">tokens: the summary the AI gets</div>
        </div>
        <div className="rounded-xl bg-surface p-2">
          <div className="tabular text-sm font-extrabold text-text">≈{k(sizes.samples)}</div>
          <div className="text-[10px] text-muted">tokens: raw per-second metrics, same window</div>
        </div>
        <div className="rounded-xl bg-surface p-2">
          <div className="tabular text-sm font-extrabold text-text">≈{k(sizes.logs)}</div>
          <div className="text-[10px] text-muted">tokens: one log line per request ({k(sizes.requests)} requests)</div>
        </div>
      </div>
      <p className="mt-1.5 text-[10px] text-muted">
        Estimates: characters ÷ 4; raw logs assume ≈{TOKENS_PER_LOG_LINE} tokens per line. Rare signals (errors, breaker trips, control rejections) are kept in the summary, not averaged away. Fixed instructions add ≈{k(sizes.system)} tokens and never change between incidents — the part a provider could cache.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-nav-active">👀 See exactly what the AI sees (current snapshot)</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded-xl bg-surface p-2 text-[10px] leading-snug text-text-2" data-testid="ai-context">{sizes.message}</pre>
      </details>
    </div>
  );
}
