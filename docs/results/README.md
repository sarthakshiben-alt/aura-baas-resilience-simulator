# Live benchmark results

**Illustrative benchmark on a synthetic golden dataset. Not a statistical study.**

## Run: 2026-10-19 · Groq · `qwen/qwen3.8-27b`

- Artifact: [`benchmark-2026-10-19-groq-qwen3.8-27b.json`](benchmark-2026-10-19-groq-qwen3.8-27b.json)
- Reproduce: `scripts/benchmark-live.ts` (identical scenarios and prompt; waits out free-tier rate limits — 16 waits over 32 calls)
- **Pre-registration:** every golden scenario, including GS-18, was committed (last change `b485313`, 08:45 UTC) **before** the first live LLM call (09:04 UTC). Scenarios were not changed after seeing results.

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
