import Link from "next/link";

const PIPELINE = [
  ["Simulation engine", "Deterministic TypeScript model of five partners, retail banking and a shared gateway. Runs in the browser and is replayed by the server."],
  ["Gateway protections", "Per-partner concurrency limits, timeouts, circuit breakers, retail reservation and bounded scale-out. Always on unless an operator turns them off; AI cannot change them."],
  ["Investigation", "AI ON: configured LLM with schema-validated output and a labelled fallback. AI OFF: the rule-based investigator and runbook."],
  ["Policy engine", "Validates every proposed action against deterministic rules at proposal time and again at approval time."],
  ["Human approval", "Approve / reject / cancel. Server-signed, idempotent, scoped to the current incident and investigation."],
  ["Measurement", "Paired runs, a golden benchmark and interactive runs. Every number is derived from recorded simulation events."],
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-[1000px] space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text">About this demo</h1>
        <p className="mt-1 text-sm text-text-2">
          A product-management case study prototype for a Technical Program Manager / Digital Product Management role. It asks one question:{" "}
          <b className="text-text">does AI-assisted investigation add measurable value to an otherwise resilient, deterministic banking platform?</b>
        </p>
      </div>
      <div className="rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm text-warning-text">
        <b>Simulated environment.</b> No real bank, partner, API or infrastructure is connected. Partner names, telemetry, incidents, recovery results and financial figures are synthetic or illustrative. Rejected or timed-out requests are simulated counts; no transaction correctness is claimed.
      </div>
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-base font-semibold text-text">How it fits together</h2>
        <ol className="grid gap-3 md:grid-cols-2">
          {PIPELINE.map(([t, d], i) => (
            <li key={t} className="rounded-md border border-border p-3">
              <div className="text-xs font-semibold text-muted">{i + 1}</div>
              <div className="text-sm font-semibold text-text">{t}</div>
              <p className="mt-0.5 text-xs text-text-2">{d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-text-2">
          <b>Separation of responsibilities:</b> the LLM investigates and recommends; the policy engine validates; a human approves; the simulator executes and measures. AI is never in the transaction path — if the AI provider is slow, failing or not configured, the simulation, protections, fallback assessment and metrics keep working.
        </p>
      </section>
      <section className="rounded-lg border border-border bg-surface p-5 text-sm text-text-2">
        <h2 className="mb-2 text-base font-semibold text-text">Architecture</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Next.js (App Router) modular monolith on Vercel. TypeScript strict; zod runtime validation on every API input and on LLM output.</li>
          <li>Stateless, server-authoritative sessions: the browser runs the deterministic engine for responsiveness. AI results and approvals are HMAC-signed by the server and re-verified by full deterministic replay on every privileged request. No server memory is required between requests.</li>
          <li>LLM provider abstraction (OpenAI-compatible: Groq, any compatible endpoint; local Ollama for development only). Model and key come from server-side environment variables.</li>
          <li>Supabase PostgreSQL for incidents, investigations, recommendations, audit logs, telemetry snapshots and comparison runs. RLS is on for all tables; only the server (service role) writes.</li>
        </ul>
      </section>
      <section className="rounded-lg border border-border bg-surface p-5 text-sm text-text-2">
        <h2 className="mb-2 text-base font-semibold text-text">Where to start</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Use <b>Start Guided Demo</b> (top bar) for a 3–5 minute walkthrough of one incident.</li>
          <li><Link className="text-info-text underline" href="/simulator">Incident simulator</Link> — trigger scenarios A–E, toggle protections, load golden scenarios, inject AI faults.</li>
          <li><Link className="text-info-text underline" href="/comparison">AI comparison</Link> — paired runs, golden benchmark, business-value estimate.</li>
          <li><Link className="text-info-text underline" href="/methodology">Methodology</Link> — every assumption, threshold and formula.</li>
        </ul>
      </section>
    </div>
  );
}
