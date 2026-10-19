# Data dictionary (synthetic telemetry)

All telemetry is **synthetic**, produced by the deterministic simulator in `src/lib/sim/`. Units are fixed: latency in milliseconds, throughput in requests/second, rates and utilisation as fractions in [0, 1], time in simulated seconds (1 tick = 1 s). Wall-clock values (AI latency, human decision time) are milliseconds and are never mixed with simulated time without explicit conversion.

Source of truth: `src/lib/docs/data-dictionary.ts` (also rendered at `/methodology#dictionary`).

| Field | Unit | Description |
|---|---|---|
| `t / t_sim_s` | simulated seconds | Simulation clock. 1 tick = 1 simulated second since the session baseline. Fast-forward changes ticks per real second, never the unit. |
| `partner_id / entity` | id | partner-a … partner-e, or retail (Aura retail banking, a protected service). |
| `request_rate / offeredRps` | requests / second | Requests offered to the gateway by the entity's clients (before rate limiting). |
| `servedRps` | requests / second | Requests completed successfully. |
| `throttledRps / throttledRate` | rps / fraction | Requests rejected by a rate limit (simulated HTTP 429). Retry behaviour is not modelled. |
| `rejectedRps / rejectedRate` | rps / fraction | Requests rejected by circuit breaker, concurrency limit or shared-pool saturation (simulated HTTP 503). |
| `p50 / p95 / p99_latency_ms` | milliseconds | Latency percentiles of requests that obtained a gateway slot (queue delay + downstream time), capped at the timeout. Null when no requests were served. |
| `error_rate` | fraction 0–1 | (admitted − successful) / offered: timeouts + partner-returned errors + control rejections. Excludes throttled requests. |
| `timeoutRate` | fraction 0–1 | Share of offered requests that exceeded the gateway timeout. |
| `upstreamErrorRate` | fraction 0–1 | Share of offered requests where the partner downstream returned an error. |
| `successRate` | fraction 0–1 | Successful / offered. Downtime = seconds with successRate < 0.5. |
| `in_flight_requests` | requests (slots) | Gateway worker slots held (Little's law: admitted rps × service time). Queued requests add latency but do not hold a slot. |
| `concurrency_limit` | requests | Effective per-partner limit (default 100; predefined incident cap 40). Null = unlimited. |
| `resource_utilisation` | fraction 0–1 | Allocated slots / total gateway capacity (340 slots, +85 per bounded scale-out, max 510). |
| `pressure` | ratio (can exceed 1) | Requested slots / capacity. >1 means demand exceeds capacity and requests queue or are rejected. |
| `queueDelayMs` | milliseconds | Added wait in the shared pool, rising when utilisation exceeds 70%. |
| `circuit_breaker_state` | closed | open | half_open | Per-partner breaker. See breaker rules. |
| `health_status` | enum | healthy | degraded | protected | recovering | unavailable (definitions on this page). |
| `retail_p95_latency_ms` | milliseconds | Retail banking P95. Simulated service target: 300 ms. |
| `retail_health` | healthy | at_risk | breach | breach: P95 > 300 ms; at_risk: P95 > 255 ms (85%) or errors > 1%. |
| `latencyMs (investigation)` | milliseconds (wall clock) | Measured server time for the whole investigation; llmLatencyMs covers LLM attempts only. Never mixed into simulated durations without explicit conversion. |

## Golden dataset files

| Path | Contents |
|---|---|
| `src/lib/golden/dataset.ts` | 18 scenario definitions: initial conditions, trigger script, expected telemetry, controls, platform and retail impact, resolution criteria, expected investigation behaviour, safety constraints, expected test outcome |
| `data/golden/dataset.json` | JSON export of the above |
| `data/golden/telemetry/GS-XX.csv` | 240 simulated seconds × 6 entities of per-second telemetry (columns as above) |
| `supabase/seed.sql` | `golden_scenarios` reference rows |

Regenerate deterministically with `npm run golden:export`.
