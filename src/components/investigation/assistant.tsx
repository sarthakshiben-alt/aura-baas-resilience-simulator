"use client";

import { useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { useSim } from "@/client/provider";
import { SUGGESTED_QUESTIONS } from "@/lib/ai/assistant";
import { Button, Card, CardHeader } from "@/components/ui/primitives";
import { SourceBadge } from "@/components/status";
import { fmtMs, fmtSimTime } from "@/lib/utils";

export function AssistantPanel({ incidentId }: { incidentId: string | null }) {
  const sim = useSim();
  const [q, setQ] = useState("");
  const thread = sim.chats.get(incidentId ?? "platform") ?? [];
  const busy = thread.at(-1)?.pending ?? false;
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    void sim.ask(incidentId, text.trim());
    setQ("");
  };
  return (
    <Card id="assistant" className="scroll-mt-28">
      <CardHeader title="AI incident assistant" subtitle={`Answers use only the current simulated telemetry${incidentId ? ` and ${incidentId} history` : ""}. AI ${sim.aiMode === "ai_on" ? "ON" : "OFF (rule-based answers)"}.`} />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_QUESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy} className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-2 hover:border-border-strong disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <div className="max-h-[420px] space-y-2 overflow-y-auto" aria-live="polite">
          {thread.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto max-w-[85%] rounded-md bg-accent/10 px-3 py-2 text-sm text-text">{m.text}</div>
            ) : (
              <div key={i} className="max-w-[95%] rounded-md border border-border px-3 py-2 text-sm text-text-2">
                {m.pending ? (
                  <span className="flex items-center gap-2 text-xs text-muted"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Thinking…</span>
                ) : (
                  <>
                    {m.answer ? (
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                        <SourceBadge source={m.answer.source} />
                        {m.answer.errorCategory ? <span>LLM unavailable: {m.answer.errorCategory.replace(/_/g, " ")}</span> : null}
                        <span>at sim {fmtSimTime(m.answer.atSimSecond)}</span>
                        <span>{fmtMs(m.answer.latencyMs)}</span>
                      </div>
                    ) : null}
                    <p className="text-text">{m.text}</p>
                    {m.answer?.evidence.length ? (
                      <ul className="mt-1 list-disc pl-4 text-xs">
                        {m.answer.evidence.map((e, j) => <li key={j}>{e}</li>)}
                      </ul>
                    ) : null}
                    {m.answer?.missingInformation.length ? <p className="mt-1 text-xs text-warning-text">Missing: {m.answer.missingInformation.join("; ")}</p> : null}
                  </>
                )}
              </div>
            ),
          )}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(q);
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="Ask about the current incident…" aria-label="Ask the incident assistant" className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-sm text-text" />
          <Button type="submit" variant="primary" disabled={busy || q.trim().length < 2}>
            <Send className="h-3.5 w-3.5" /> Ask
          </Button>
        </form>
      </div>
    </Card>
  );
}
