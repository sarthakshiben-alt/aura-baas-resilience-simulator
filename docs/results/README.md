# Live results

## Three-way paired runs on the deployed app (2026-10-19, Groq `qwen/qwen3.8-27b`, 10 min assumed manual triage)

Artifact: [`paired-2026-10-19-live-groq-qwen3.8-27b.json`](paired-2026-10-19-live-groq-qwen3.8-27b.json). Same seed, scenario and protections in every arm; simulated operator with a 20 s decision delay.

| Scenario | Manual runbook | Automated rules (no AI) | AI-assisted | AI source |
|---|---|---|---|---|
| GS-01 diagnosis / recovery | 608 s / 728 s | 8 s / 167 s | 10 s / 167 s | real LLM (2.2 s) |
| GS-18 diagnosis / recovery | 608 s / 729 s | 8 s / 129 s | 10 s / 130 s | real LLM (1.3 s) |
| GS-09 diagnosis / recovery | 619 s / not resolvable | 19 s / not resolvable | 19 s / not resolvable | fallback (rate-limited) |

- The AI-vs-manual gap equals the triage **assumption** (sensitivity: 0 min → 0 s, 10 min → +561 s on GS-01). An automated rule engine captures it without AI.
- GS-18 is solved by automated rules here because, diagnosing seconds after detection, the traffic ramp (1.35×) has not yet happened; in the benchmark (context captured 20 s after detection) the rules fail it. Diagnosis timing changes the available evidence.
- GS-09 is ambiguous by design: no arm can resolve it from gateway telemetry, which is the correct outcome.

---

# Golden-dataset benchmark

**Illustrative benchmark on a synthetic golden dataset. Not a statistical study.**

## Run: 2026-10-19 · Groq · `qwen/qwen3.8-27b`

- Artifact: [`benchmark-2026-10-19-groq-qwen3.8-27b.json`](benchmark-2026-10-19-groq-qwen3.8-27b.json)
- Reproduce: `scripts/benchmark-live.ts` (identical scenarios and prompt; waits out free-tier rate limits — 16 waits over 32 calls)
- **Pre-registration:** every golden scenario, including GS-18, was committed (last change `7a8d59b`, 08:45 UTC) **before** the first live LLM call (09:04 UTC). Scenarios were not changed after seeing results.

| Metric | Rules (AI OFF) | qwen3.8-27b (AI ON) |
|---|---|---|
| Correct diagnosis | 94% | 83% |
| Appropriate recommendations | 100% | 97% |
| Policy rejections | 0 | 1 |
| Evidence grounding (numeric heuristic) | 100% | 100% |
| Real LLM responses | — | 14 / 18 |
| Fallback rate | — | 22% (2 injected, 2 genuine timeouts) |
| Latency p50 / max | ~1 ms | 3.2 s / 30.0 s |

| Scenario | Title | Rules | AI | AI source | AI ms | Note |
|---|---|---|---|---|---|---|
| GS-01 | Partner slowdown with successful isolation | ✓ | ✓ | LLM | 3232 |  |
| GS-02 | Partner slowdown without sufficient isolation | ✓ | ✗ | LLM | 3040 | Read breaker fast-fails as partner errors |
| GS-03 | Traffic spike | ✓ | ✓ | LLM | 2777 |  |
| GS-04 | Shared gateway saturation | ✓ | ✓ | LLM | 2875 |  |
| GS-05 | Retail banking latency breach | ✓ | ✓ | LLM | 14207 |  |
| GS-06 | Circuit breaker opening on downstream errors | ✓ | ✓ | LLM | 2766 |  |
| GS-07 | Circuit breaker half-open recovery | ✓ | ✓ | LLM | 2749 |  |
| GS-08 | Recovery after a downstream slowdown | ✓ | ✓ | LLM | 11391 |  |
| GS-09 | Insufficient evidence for root-cause identification | ✓ | ✗ | LLM | 6250 | Overconfident: claimed a cause where evidence is insufficient |
| GS-10 | AI provider timeout | ✓ | ✓ | fallback (timeout) | 30027 | Injected timeout (by design) |
| GS-11 | AI provider returns malformed structured output | ✓ | ✓ | fallback (malformed_output) | — | Injected malformed output (by design) |
| GS-12 | AI recommendation rejected by policy validation | ✓ | ✓ | fallback (timeout) | 30001 | Genuine provider timeout (30 s) |
| GS-13 | High request rate with normal latency | ✓ | ✓ | LLM | 2487 |  |
| GS-14 | High latency with low traffic | ✓ | ✓ | LLM | 20375 |  |
| GS-15 | Multiple simultaneous incidents | ✓ | ✗ | LLM | 10821 | Same fast-fail misreading; proposed a rate limit on Partner B — **blocked by policy** |
| GS-16 | Recovery action that does not improve partner latency | ✓ | ✓ | LLM | 29707 |  |
| GS-17 | Weak or incorrect AI recommendation | ✓ | ✓ | fallback (timeout) | 30002 | Genuine provider timeout (30 s) |
| GS-18 | Downstream slowdown masked by moderate traffic growth (known rule gap) | ✗ | ✓ | LLM | 2521 | **Won**: inferred downstream latency from disproportionate latency vs. load (rules said insufficient evidence) |

## Interpretation

1. **Rules beat the LLM overall (94% vs 83%)** — but the golden set was written alongside the rules, so 94% is an optimistic ceiling for the rules.
2. **The LLM won exactly where it was supposed to:** GS-18, the pre-registered rule gap.
3. **The LLM's failures are the dangerous kind:** overconfidence on ambiguous evidence (GS-09) and misreading protective fast-fails as partner errors (GS-02, GS-15). Both would mislead a human under pressure.
4. **The policy engine did its job:** the one unsafe recommendation was blocked; nothing executed without approval.
5. **Operational reality:** Groq free tier allows roughly one investigation per minute at this prompt size; p50 3.2 s, worst cases hit the 30 s budget.

**Product conclusion:** deterministic controls carry the resilience; AI is a second-opinion investigator for cases rules can't classify, never an authority. Candidate improvements (each needs a new, pre-registered evaluation run): clarify in the context that `rejectedByControlsPct` is protection, not partner failure; require the model to justify confidence above 0.5 on multi-partner anomalies.

## Mystery incident (GS-19), live paired runs — 2026-10-19

Local server, Groq `qwen/qwen3.8-27b`, 10 min assumed manual triage, operator delay 20 s. Seeds 119, 4242, 777 (all three rolled Partner C as the failing partner; 400 random rolls spread evenly over all five partners). SLA = seconds the affected partner was outside healthy thresholds.

| Seed | Manual runbook | Automated rules (rules stumped → human paged at 0:36, finds it at 10:36) | AI-assisted | AI top cause |
|---|---|---|---|---|
| 119 | 1295 s | 695 s | 97 s | partner_traffic_surge ✗ (but escalated the right partner) |
| 4242 | 1295 s | 695 s | 98 s | partner_downstream_latency ✓ |
| 777 | 1294 s | 694 s | 96 s | partner_traffic_surge ✗ (but escalated the right partner) |

Same session also ran GS-01 (rules 134 s, AI 134 s — tie) and GS-05 (AI rate-limited → fallback; not a measurement).
