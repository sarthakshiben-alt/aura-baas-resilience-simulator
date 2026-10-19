# Aura BaaS Resilience Simulator

> **SIMULATED ENVIRONMENT — NO REAL BANKING SYSTEM CONNECTED.** Every partner, metric, incident, recovery result and financial figure in this project is synthetic or illustrative.

A working prototype of an AI-assisted **Banking-as-a-Service resilience platform**, built as a product-management case study. Aura Bank serves five fintech partners and its own retail customers through one shared API gateway. When one partner's downstream slows, requests stay in flight longer and can exhaust shared gateway capacity.

The prototype answers one question honestly:

> **Does AI-assisted incident investigation add measurable value to an otherwise resilient, deterministic banking platform?**

It is not a chatbot or a static dashboard. User actions change a deterministic simulation. The AI (or rule-based fallback) investigates the telemetry the simulation actually generated. A policy engine validates every proposed action, a human approves it, the simulator executes it, and every metric is computed from recorded events.

---

## Contents

1. [What you can do](#what-you-can-do)
2. [Quick start](#quick-start)
3. [Architecture & key decisions](#architecture--key-decisions)
4. [Simulation model](#simulation-model)
5. [AI investigation design](#ai-investigation-design)
6. [Measuring AI value fairly](#measuring-ai-value-fairly)
7. [What the results currently show](#what-the-results-currently-show)
8. [Testing](#testing)
9. [Configuration](#configuration)
10. [Supabase setup](#supabase-setup)
11. [AI provider setup](#ai-provider-setup)
12. [Deploying to Vercel](#deploying-to-vercel)
13. [Troubleshooting](#troubleshooting)
14. [Limitations & status](#limitations--status)

---

## What you can do

| Screen | Purpose |
|---|---|
| **Overview** (`/`) | Five partners + retail, eight platform metrics, live charts, incident timeline, **Start Guided Demo**. |
| **Incident simulator** (`/simulator`) | Scenarios A–E (slowdown, traffic spike, saturation, retail risk, recovery) and 6 more; stop runs safely; toggle protections; inject AI faults; load golden scenarios; "protections ON vs OFF" what-if. |
| **Incident investigation** (`/investigation`) | Incident detail, telemetry, timeline, labelled diagnosis (facts / inferences / unknowns / causes / evidence / limitations), **action approval** (approve / reject / cancel pending), recovery outcome, **AI assistant**, audit log. |
| **AI comparison** (`/comparison`) | **AI ASSISTANCE ON/OFF** paired runs, golden benchmark, business-impact estimate with attribution, your interactive runs. |
| **Methodology** (`/methodology`) | Every assumption, threshold, rule, formula and the data dictionary. |

Screenshots (synthetic data): [investigation](docs/screenshots/investigation.png) · [simulator](docs/screenshots/simulator.png) · [comparison](docs/screenshots/comparison.png).

The **guided demo** (3–5 minutes) walks through one incident: baseline → Partner A slowdown → the deterministic breaker contains it → investigation starts automatically (AI ON) or the on-call engineer is paged and triages for an assumed N minutes (AI OFF) → approve escalation → verified recovery → three-way comparison.

## Quick start

```bash
npm install
cp .env.example .env.local      # optional: works with no keys at all
npm run dev                      # http://localhost:3000
```

Requires Node ≥ 20.9. With no AI key and no Supabase, the app is fully usable. AI-ON investigations return a clearly labelled **rule-based fallback**, and persistence uses an in-memory store.

## Architecture & key decisions

```
 Browser (Next.js client)                         Server (Next.js route handlers, Vercel)
 ┌──────────────────────────────┐                 ┌───────────────────────────────────────────┐
 │ SimController                │  log + session  │ replayVerified(): verify HMAC session +    │
 │  • deterministic engine      │ ──────────────▶ │   every signed entry, replay the log      │
 │    (src/lib/sim) runs ticks  │                 │ investigate → context → LLM | fallback    │
 │  • command log               │ ◀────────────── │ decide      → policy re-validation        │
 │  • inserts signed entries at │  signed entry   │ sign entry (HMAC)                         │
 │    their exact tick (replay) │                 │ persist (Supabase / memory, best-effort)  │
 └──────────────────────────────┘                 └───────────────────────────────────────────┘
```

**Modular monolith.** Next.js App Router, React, TypeScript (strict), Tailwind CSS, shadcn/ui-style primitives, Recharts, zod and Supabase. No separate services, queues or Redis.

**Separation of responsibilities** (enforced in code, not just stated):

| Layer | Module | Can it change the simulator? |
|---|---|---|
| Simulation engine | `src/lib/sim/engine.ts` | Yes: deterministic physics only |
| Gateway protections | `src/lib/sim/config.ts`, engine | Operator controls only; never the LLM |
| Investigation (LLM / rules) | `src/lib/ai/*` | **No.** Returns structured advice |
| Policy engine | `src/lib/sim/policy.ts` | No. Validates |
| Human approval | `/api/incidents/[id]/recommendations/*` | Approves a predefined, validated action |
| Action execution | `src/lib/sim/actions.ts` | Yes: predefined simulated operations only |

**Decision: stateless, server-authoritative sessions via signed command logs.** Vercel functions keep no memory between requests, so a server-held simulation would be unreliable. Instead:

- The engine is **pure and deterministic**: a seeded integer hash replaces `Math.random`, and values are quantised. The browser runs it for smooth real-time updates at any speed.
- Privileged transitions (AI results, approvals, rejections, cancellations) are **issued by the server as HMAC-signed entries**, bound to the session id and an exact simulated tick.
- On every privileged request the server **replays the whole log**, verifies every signature, and re-validates the request against the replayed state. Stale recommendations, duplicates, forged or tampered entries, and cross-session entries are all rejected.
- *Trade-off:* the client controls when time advances, so a modified client could only distort its own demo session. The server bounds simulated time per session and forces an AI result to apply no earlier than its measured latency allows.

**AI is never in the critical path.** Investigation calls run asynchronously while the simulation keeps ticking, and the result is inserted at `request tick + measured latency`. A slow, failing or unconfigured provider cannot stop the simulation, the protections, the fallback or the metrics. This is tested.

## Simulation model

Each simulated second, for each partner and for retail: offered rps → rate limit → circuit breaker → lognormal downstream latency (P95 scaled by the scenario, rising above backend capacity) → timeout. **Little's law** gives the worker slots each entity needs. Per-partner limits cap a partner's slots. Partners share 200 slots, and retail has 140 reserved, plus any idle partner capacity it can borrow. Above 70% utilisation a queue delay is added; above 100%, the excess is rejected. Queued requests add latency but hold no slot. We learned that distinction the hard way: the first version had an unbounded feedback loop.

- **Health states:** Healthy, Degraded, **Protected** (impaired but contained by a control), Recovering (not yet verified), Unavailable. Partner recovery, gateway protection, retail health and incident resolution are tracked separately, and an open breaker never counts as recovery.
- **Circuit breaker:** closed → open at ≥ 50% slow (> 1 s) or failed calls over 10 s; 30 s open; 10 s half-open probe at 10% of traffic.
- **Detection:** 3 s impaired. **Verification:** 30 s of healthy telemetry with breakers closed.

Full details are in `/methodology` and [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md). The **golden dataset** contains 18 deterministic scenarios (`src/lib/golden/dataset.ts`, exported to `data/golden/` and `supabase/seed.sql`). Every scenario defines initial conditions, trigger, expected telemetry, controls, platform and retail impact, resolution criteria, expected investigation behaviour, safety constraints and expected test outcome.

## AI investigation design

- **Context:** compact, telemetry-only (`src/lib/ai/context.ts`): current values, 60 s peaks, ratios to baseline, P95 trend, gateway state, recent events, prior investigations and actions, and the available action IDs. **Scenario names and ground truth are excluded.**
- **Prompt rules** (`src/lib/ai/prompt.ts`): evidence only from the context; observations kept separate from inferences and unknowns; uncertainty disclosed; no invented data; only listed action IDs; never claim execution; never loosen protections; human approval always required. No chain-of-thought is requested or displayed.
- **Validation:** strict zod schema (`src/lib/ai/schema.ts`) with bounded lengths. LLM output is treated as untrusted input, and unknown action IDs are rejected by the policy engine, never executed.
- **Reliability** (`src/lib/ai/service.ts`): a total time budget (`AI_TIMEOUT_MS`, default 8 s), bounded retries with exponential backoff and jitter (429/5xx/network only), error classification (`timeout`, `rate_limited`, `auth_error`, `model_unavailable`, `malformed_output`, …), a concurrency cap, per-IP rate limits, and a deterministic fallback. The fallback is always labelled **"Rule-based fallback"**; with AI OFF, results are labelled **"Rule-based (conventional)"**. A database constraint also prevents a fallback being stored as an LLM result.
- **Measurement:** start, completion, time to response headers, total and LLM-only wall-clock latency, attempts, tokens, provider, model, fallback flag and injected-fault flag.

## Measuring AI value fairly

- **AI OFF never disables safeguards.** Gateway protections act immediately in every mode. AI OFF uses the conventional workflow: an on-call engineer is paged at detection and works the runbook after an **assumed** triage time (default 10 simulated minutes, editable 0–30, shown next to the AI toggle). AI ON auto-investigates on detection. A human approves actions in both.
- **Three arms, not two.** Paired runs compare **manual runbook** · **automated rules (no AI)** · **AI-assisted**. "AI vs manual" mostly measures *automation*; "AI vs automated rules" measures what AI itself adds. A sensitivity table shows how the AI advantage depends on the triage assumption (0, 1, 5, 10, 20 min).
- **Approach A — paired runs** (`src/lib/comparison/paired.ts`): same seed, scenario, initial conditions and protections. Measured AI latency is converted to simulated seconds (1:1 by default, minimum one tick for both modes). A **labelled simulated operator** approves every policy-valid recommendation after the same fixed delay, and re-investigates every 60 s while unresolved, in both modes. An uncontrolled counterfactual isolates what the deterministic controls contribute.
- **Approach B — benchmark** (`src/lib/comparison/benchmark.ts`): both investigators score the identical context for every golden scenario against expected causes and permitted, unnecessary and forbidden actions, plus a numeric evidence-grounding heuristic.
- **Interactive runs:** real human decision time is recorded separately from AI latency.
- **Business value:** `downtime minutes avoided × assumed $/min`. The case's $4,500/min is visible, editable and labelled as an assumption. Benefit is attributed separately to controls, diagnosis speed, recommendation speed, approval time and action effectiveness, and marked *uncertain* where attribution is unclear. Zero denominators show N/A, and no improvement is hard-coded anywhere.

## What the results currently show

**Live benchmark (Groq `qwen/qwen3.8-27b`, 2026-10-19)** — full table in [`docs/results/`](docs/results/README.md):

| | Rules (AI OFF) | LLM (AI ON) |
|---|---|---|
| Correct diagnosis (18 golden scenarios) | 94% | 83% |
| Pre-registered rule gap (GS-18) | ✗ | ✓ |
| Unsafe recommendations blocked by policy | 0 proposed | 1 proposed, 1 blocked |
| Median latency | ~1 ms | 3.2 s |

0. **The triage assumption drives the headline.** Live three-way paired runs on the deployed app (real Groq `qwen/qwen3.8-27b` calls, 10 min assumed manual triage; [`docs/results/`](docs/results/README.md)):

   | Scenario | Manual runbook | Automated rules (no AI) | AI-assisted |
   |---|---|---|---|
   | GS-01 verified recovery | 728 s | 167 s | 167 s |
   | GS-18 verified recovery | 729 s | 129 s | 130 s |

   "AI vs manual" looks like ~$42k avoided at $4,500/min, but **all** of it comes from automating the runbook; AI over automated rules added ±0–1 s. The sensitivity table shows the AI advantage tracks the assumed triage time almost one-for-one.
1. **Deterministic controls deliver most of the protection.** Scenario A over 180 s: retail breach 0 s with protections vs 164 s without; neighbour impairment 0 vs 656 partner-seconds.
2. **AI rarely wins on speed.** Breaker cycles absorb seconds of diagnosis delay; paired runs showed identical recovery for a 2 s slower diagnosis.
3. **AI adds value only where rules are wrong — and fails in risky ways.** It solved the pre-registered rule gap (GS-18) but was overconfident on ambiguous evidence (GS-09) and misread protective fast-fails as partner errors (GS-02, GS-15). The policy engine blocked its one unsafe proposal.
4. **Scenarios were committed before any live LLM call** (git history), so results were not tuned after the fact. Rule accuracy is an optimistic ceiling because the rules and scenarios were authored together.

## Testing

```bash
npm test                 # unit + API tests (Vitest) — 61 tests
npm run test:db          # starts local PostgreSQL 16, applies migration + seed, RLS tests (4)
npm run test:security    # sentinel-secret production build + bundle scan
npm run build && npm run test:e2e   # Playwright against `next start` (4 end-to-end tests)
npm run typecheck && npm run lint
```

Mapping to the brief's required tests:

| # | Requirement | Where |
|---|---|---|
| 1–8 | Baseline, slowdown, Little's law, caps, breaker transitions, retail protection, recovery, reset/determinism | `tests/unit/simulation.test.ts` (+ golden expectations in `tests/unit/golden.test.ts`) |
| 9–16 | Valid schema, malformed output, timeout, missing credentials, AI failure doesn't stop simulation, fallback never labelled LLM, unknown actions rejected, policy rejects unsafe actions | `tests/unit/ai.test.ts` |
| 17–22 | Equivalent initial conditions, AI OFF keeps safeguards, latency vs recovery separated, missing results → N/A, no fabricated improvement, retail impact from events | `tests/unit/comparison.test.ts` |
| 23 | No privileged keys in client code or bundles | `tests/unit/security.test.ts`, `scripts/security-scan.sh` |
| 24 | Invalid / tampered / forged requests rejected | `tests/api/routes.test.ts` |
| 25 | Anonymous visitors cannot access privileged records | `tests/db/supabase-schema.test.ts` (real Postgres + RLS), `tests/api/routes.test.ts` (session scoping) |
| 26 | Duplicate approvals don't execute twice | `tests/api/routes.test.ts`, `tests/unit/ai.test.ts` |

When a local Playwright version doesn't match the installed browsers, set `PW_CHROMIUM_PATH` to a Chromium binary.

## Configuration

See [`.env.example`](.env.example). Summary:

| Variable | Scope | Required | Notes |
|---|---|---|---|
| `SESSION_SIGNING_SECRET` | server | **yes in production** | ≥ 16 chars. Without it an insecure default is used and `/api/health` reports `insecure_default`. |
| `AI_PROVIDER` | server | no | `groq` (default), `openai_compatible`, `ollama` (dev only), `none` |
| `AI_API_KEY`, `AI_MODEL` | server | for live AI | No model id is hard-coded. |
| `AI_BASE_URL` | server | compatible/ollama | |
| `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_CONCURRENCY` | server | no | 8000 / 2 / 2 |
| `AI_PRICE_PER_MILLION_TOKENS_USD` | server | no | Enables AI cost and net value. |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | server | for persistence | Without them, in-memory persistence. |

Secrets are read only in `src/lib/server/env.ts`. No secret uses a `NEXT_PUBLIC_` prefix, and the browser never talks to Supabase.

## Supabase setup

1. Create a Supabase project.
2. Apply the migration: either `supabase db push` with the Supabase CLI linked to the project, or paste `supabase/migrations/20261019000000_aura_simulator.sql` into the SQL editor. Then run `supabase/seed.sql` to load the golden reference data.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only) in Vercel.
4. Check `/api/health`; it should report `"persistence":"supabase"`.

**Access model:** RLS is enabled on every table. `anon`/`authenticated` have no grants or policies on session data. `golden_scenarios` is public read-only reference data. All writes go through the server with the service role, only after a server-issued session has been verified, and every row is scoped by that `session_id`. A browser-supplied identifier is never trusted.

Tables: `incidents`, `telemetry_snapshots`, `investigations`, `recommendations`, `action_audit_logs`, `comparison_runs`, `golden_scenarios`. Simulated times are stored as `*_sim_s` integers and wall-clock times as `timestamptz`.

## AI provider setup

**Groq (preferred for the public demo):**
1. Create a key at console.groq.com.
2. Choose a currently available chat model that supports JSON mode. Check Groq's model list, because availability and free-tier limits change.
3. Set `AI_PROVIDER=groq`, `AI_API_KEY`, `AI_MODEL`.

**Any OpenAI-compatible endpoint:** set `AI_PROVIDER=openai_compatible`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.

**Local Qwen3 8B via Ollama (development only):** run `ollama pull qwen3:8b`, then set `AI_PROVIDER=ollama` and `AI_MODEL=qwen3:8b` in `.env.local`. A deployed app cannot reach your laptop's `localhost`, and the Ollama provider is disabled when `NODE_ENV=production` unless `ALLOW_LOCAL_AI=true`.

Verify with `/api/health` (`ai.configured: true`), then run an investigation with AI ON. The badge must read **"Real LLM response"**. Run the benchmark to measure AI on the golden dataset.

## Deploying to Vercel

1. Push this repository to GitHub and import it in Vercel (framework preset: Next.js; build command `next build`).
2. Set environment variables: `SESSION_SIGNING_SECRET` at minimum, plus the AI and Supabase variables as needed.
3. Deploy, then verify:
   - `/api/health` returns `status: ok`, `sessionSigning: configured`, and the expected `ai` and `persistence` values.
   - The guided demo completes end to end.
4. Function durations: investigation 30 s, paired comparison 60 s, benchmark 120 s (`maxDuration` per route).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Live AI not configured → rule-based fallback" | `AI_MODEL`/`AI_API_KEY` missing; check `/api/health` → `ai.reason`. |
| Investigation shows `rate_limited` / `timeout` | Provider free-tier limits or a slow model. Raise `AI_TIMEOUT_MS`, retry, or switch model. The fallback is labelled. |
| `model_unavailable` | The model id no longer exists at the provider. Pick a current one. |
| "Session token is invalid" after a deploy | `SESSION_SIGNING_SECRET` changed. Click **Reset Scenario**. |
| `persistence: memory` on Vercel | Supabase variables missing. Memory persistence is per-instance and not durable. |
| `npm run test:db` fails | Needs PostgreSQL binaries (`/usr/lib/postgresql/*/bin`). Or point `TEST_DATABASE_URL` at any disposable Postgres. |
| Playwright cannot find a browser | `npx playwright install chromium`, or set `PW_CHROMIUM_PATH`. |

## Limitations & status

- **Live LLM inference verified** against Groq (`qwen/qwen3.8-27b`, 2026-10-19; see `docs/results/`). Free-tier rate limits (~1 investigation/minute) mean concurrent demo users will sometimes see the labelled fallback. `openai/gpt-oss-120b` was also tried: it needs `AI_MAX_OUTPUT_TOKENS` ≥ 3000 (hidden reasoning) and misdiagnosed GS-01/02.
- **Supabase:** migrations, RLS and row shapes are verified against a local PostgreSQL 16 with Supabase-style roles. A hosted Supabase project has not been provisioned.
- **Deployment:** Vercel-ready, but **not deployed yet**. Follow [Deploying to Vercel](#deploying-to-vercel).
- **Model fidelity:** a 1-second fluid model, not a request-level discrete-event simulation. No retries, idempotency keys or transaction semantics are modelled. Rejected or timed-out requests are simulated counts only, and no transaction correctness is claimed.
- **Partner remediation** after escalation (60 s) is a disclosed scenario assumption, not an empirical result.
- **Rate limiting** is per server instance (best effort on serverless). Use a shared store for strict limits.
- **Statistics:** paired runs are single samples, so no statistical significance is claimed, and benchmark scores are illustrative.
- Client and server engines rely on identical IEEE-754 behaviour. Quantisation makes divergence unlikely but not impossible; the server's replay is authoritative.
