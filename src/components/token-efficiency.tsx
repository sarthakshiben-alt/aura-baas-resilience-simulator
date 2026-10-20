"use client";

import { useSim } from "@/client/provider";
import { Card, CardHeader, Switch } from "@/components/ui/primitives";
import { Chip } from "@/components/status";
import { INVESTIGATION_SYSTEM_PROMPT } from "@/lib/ai/prompt";

/**
 * Recorded live benchmark (Groq qwen/qwen3.8-27b, 2026-10-19, 18 golden scenarios; GS-19 was added later).
 * Routing figures are derived from the same per-scenario results: no extra AI calls. Source: docs/results/.
 */
const RECORDED = { date: "2026-10-19", scenarios: 18, everywhere: { calls: 18, correct: 15 }, rulesOnly: { calls: 0, correct: 17 }, routed: { calls: 2, correct: 17 } };

function useSessionLedger() {
  const sim = useSim();
  let made = 0;
  let avoided = 0;
  let tokens = 0;
  for (const inc of sim.state.incidents)
    for (const iv of inc.investigations) {
      if (iv.mode !== "ai_on") continue;
      if (iv.attempts > 0) made += 1;
      if (iv.aiRouting === "skipped") avoided += 1;
      tokens += iv.usage?.totalTokens ?? 0;
    }
  for (const r of Object.values(sim.pairedByGolden)) {
    made += r.on.metrics.aiCalls;
    avoided += r.on.metrics.aiSkipped;
    tokens += r.on.metrics.tokens ?? 0;
  }
  return { made, avoided, tokens };
}

export function TokenEfficiency() {
  const sim = useSim();
  const ledger = useSessionLedger();
  const live = sim.benchmark.result?.routed && sim.benchmark.result.on.realLlmResponses > 0 ? sim.benchmark.result : null;
  const rows = live
    ? [
        { label: "AI on every incident", calls: live.routed.scenarios, correct: live.on.correctDiagnosisRate },
        { label: "Rulebook only", calls: 0, correct: live.off.correctDiagnosisRate },
        { label: "🧭 Rules first, AI only when stuck", calls: live.routed.aiCalls, correct: live.routed.correctDiagnosisRate, best: true },
      ]
    : [
        { label: "AI on every incident", calls: RECORDED.everywhere.calls, correct: RECORDED.everywhere.correct / RECORDED.scenarios },
        { label: "Rulebook only", calls: RECORDED.rulesOnly.calls, correct: RECORDED.rulesOnly.correct / RECORDED.scenarios },
        { label: "🧭 Rules first, AI only when stuck", calls: RECORDED.routed.calls, correct: RECORDED.routed.correct / RECORDED.scenarios, best: true },
      ];
  const n = live ? live.routed.scenarios : RECORDED.scenarios;
  const cut = Math.round((1 - rows[2].calls / rows[0].calls) * 100);
  const systemTokens = Math.round(INVESTIGATION_SYSTEM_PROMPT.length / 4);
  return (
    <Card data-testid="token-efficiency">
      <CardHeader title="⚡ Token efficiency — pay for AI only where it helps" subtitle="Fewer AI calls, smaller prompts, bounded answers. Built and measured, not just promised." />
      <div className="grid gap-4 p-5 pt-2 lg:grid-cols-3">
        <div className="space-y-3">
          <div className="rounded-2xl border border-border bg-surface-2/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold text-text">🧭 Smart AI routing</div>
              <Switch checked={sim.aiRouting} onCheckedChange={(v) => sim.setAiRouting(v)} label="Smart AI routing" />
            </div>
            <p className="mt-1 text-xs text-text-2">
              {sim.aiRouting ? "ON: " : "OFF: "}the free, instant rulebook goes first. The AI is called only when it says &quot;can&apos;t tell what&apos;s wrong&quot;. Protections never wait for either.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-surface-2/50 p-3 text-xs" data-testid="token-ledger">
            <div className="mb-1 text-sm font-bold text-text">🧾 This session</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="tabular text-lg font-extrabold text-text">{ledger.made}</div>
                <div className="text-[10px] text-muted">AI calls made</div>
              </div>
              <div>
                <div className="tabular text-lg font-extrabold text-good-text">{ledger.avoided}</div>
                <div className="text-[10px] text-muted">AI calls avoided</div>
              </div>
              <div>
                <div className="tabular text-lg font-extrabold text-text">{ledger.tokens.toLocaleString("en-US")}</div>
                <div className="text-[10px] text-muted">tokens used (measured)</div>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-border p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-bold text-text">📊 Does routing hurt accuracy?</div>
            {live ? <Chip tone="info">Live benchmark</Chip> : <Chip tone="neutral">Recorded live benchmark · {RECORDED.date}</Chip>}
          </div>
          <table className="tabular mt-2 w-full" data-testid="routing-table">
            <thead className="text-left text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 font-semibold">Approach ({n} test incidents)</th>
                <th className="py-1 text-right font-semibold">AI calls</th>
                <th className="py-1 text-right font-semibold">Correct</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className={r.best ? "border-t border-border font-bold text-good-text" : "border-t border-border text-text-2"}>
                  <td className="py-1">{r.label}</td>
                  <td className="py-1 text-right">{r.calls}</td>
                  <td className="py-1 text-right">{r.correct === null ? "N/A" : `${Math.round(r.correct * n)}/${n}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-text-2">
            <b>{cut}% fewer AI calls, no accuracy lost.</b> The honest catch: the cases routed to AI are the genuinely ambiguous ones — where AI is most tempted to overclaim (it invented a cause on GS-09, a true &quot;not enough evidence&quot; case). That&apos;s why a human approves every action.
          </p>
        </div>
        <div className="space-y-2 text-xs">
          <div className="rounded-2xl border border-border bg-surface-2/50 p-3">
            <div className="text-sm font-bold text-text">✅ Also built</div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-text-2">
              <li>
                <b>Summaries, not raw logs.</b> The AI reads a compact summary (trends, peaks, ratios, rare events kept). Open any diagnosis to see its token footprint and exactly what the AI sees.
              </li>
              <li>
                <b>Bounded answers.</b> A fixed format: ≤4 causes, ≤10 facts, ≤4 actions, ≤300 characters each — evidence and uncertainty required, essays not allowed.
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border border-dashed border-border-strong p-3" data-testid="proposed-next">
            <div className="text-sm font-bold text-text">🔭 Proposed next — not built</div>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-text-2">
              <li>
                <b>Two-tier models:</b> a small, cheap model triages; the strong model is called only if it&apos;s unsure. Must prove it doesn&apos;t dismiss real incidents.
              </li>
              <li>
                <b>Prompt caching:</b> the fixed instructions (≈{systemTokens.toLocaleString("en-US")} tokens) are identical on every call. Where the provider supports caching, that part gets cheaper and faster — the same number of tokens, not fewer.
              </li>
            </ul>
            <p className="mt-1 text-[10px] text-muted">Fewer calls, fewer tokens and cheaper tokens are three different levers.</p>
          </div>
        </div>
      </div>
    </Card>
  );
}
