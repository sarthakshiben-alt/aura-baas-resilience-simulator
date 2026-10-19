import { DATA_DICTIONARY } from "@/lib/docs/data-dictionary";
import { DEFAULT_CONFIG, PROTECTED_CONTROLS } from "@/lib/sim/config";
import { RULE_THRESHOLDS } from "@/lib/ai/rules";
import { ACTIONS } from "@/lib/sim/actions";
import { HEALTH_META } from "@/components/status";
import { CASE_COST_PER_DOWNTIME_MINUTE_USD } from "@/lib/comparison/business";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="rounded-lg border border-border bg-surface p-5">
      <h2 className="mb-2 text-base font-semibold text-text">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-text-2">{children}</div>
    </section>
  );
}

const B = DEFAULT_CONFIG.baseline;
const M = DEFAULT_CONFIG.monitoring;
const BR = DEFAULT_CONFIG.breaker;

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text">Methodology & assumptions</h1>
        <p className="text-sm text-text-2">Everything on this site is synthetic. These are engineering assumptions for a case study, not real Aura telemetry or verified SLAs.</p>
      </div>

      <Section id="assumptions" title="Baseline assumptions (configurable)">
        <table className="tabular w-full text-xs">
          <tbody>
            {[
              ["Partner P95 latency", `${B.partnerP95Ms} ms`],
              ["Partner error rate", `${B.partnerErrorRate * 100}%`],
              ["Partner request rate", `${B.partnerRps} rps (backend capacity ${B.partnerBackendCapacityRps} rps)`],
              ["Per-partner concurrency limit", `${PROTECTED_CONTROLS.perPartnerLimit}`],
              ["Shared gateway capacity", `${DEFAULT_CONFIG.gatewayCapacitySlots} worker slots (≈45% utilised at baseline)`],
              ["Retail banking", `${B.retailRps} rps, P95 ${B.retailP95Ms} ms, target ${B.retailTargetP95Ms} ms P95, ${PROTECTED_CONTROLS.retailReservationSlots} reserved slots`],
              ["Gateway timeout", `${PROTECTED_CONTROLS.timeoutMs} ms (uncontrolled posture: 30 s)`],
              ["Latency distribution", `Lognormal, σ = ${B.latencySigma}; gateway overhead ${B.gatewayOverheadMs} ms`],
              ["Random variation", "±2% rate, ±3% latency from a seeded integer hash — replay-stable and reproducible"],
            ].map(([k, v]) => (
              <tr key={k} className="border-t border-border first:border-0"><td className="py-1.5 pr-4 text-muted">{k}</td><td className="py-1.5 text-text">{v}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="model" title="Request model">
        <p>Every simulated second, for each partner and retail: offered rps → rate limit → circuit breaker → downstream latency (lognormal, P95 scaled by the scenario; rises when rps exceeds backend capacity) → timeout. Slot demand follows Little&apos;s law: <code>in-flight = admitted rps × mean service time</code>. Per-partner limits cap each partner&apos;s slots. Partners share {DEFAULT_CONFIG.gatewayCapacitySlots - PROTECTED_CONTROLS.retailReservationSlots} slots; retail has {PROTECTED_CONTROLS.retailReservationSlots} reserved and may borrow idle partner slots. Above 70% utilisation, a queue delay is added (smoothed). Above 100%, excess requests are rejected.</p>
        <p>Queued requests add latency (and timeouts) but do not hold a worker slot. Without that distinction the model has an unbounded positive-feedback loop, which we observed and removed during development.</p>
      </Section>

      <Section id="states" title="Health states">
        <ul className="space-y-1">
          {Object.entries(HEALTH_META).map(([k, v]) => (
            <li key={k}><b className="text-text">{v.label}</b> — {v.help}</li>
          ))}
        </ul>
        <p>A degraded partner does not imply an unhealthy platform. <b>Protected</b> means the partner&apos;s own customers are affected, but a gateway control is shielding shared infrastructure. Partner recovery, gateway protection, retail health and incident resolution are tracked separately; an open breaker is never counted as recovery.</p>
      </Section>

      <Section id="breaker" title="Circuit-breaker transitions">
        <ul className="list-disc pl-5">
          <li><b>Closed → Open</b>: over the last {BR.windowSeconds} s, at least {BR.minRequests} served calls and ≥ {BR.failureRateThreshold * 100}% were failed (timeout or partner error) or slow (&gt; {BR.slowCallThresholdMs} ms).</li>
          <li><b>Open → Half-open</b>: after {BR.openSeconds} s; all calls fast-fail while open.</li>
          <li><b>Half-open → Closed / Open</b>: {BR.halfOpenProbeFraction * 100}% of traffic probes for {BR.halfOpenSeconds} s. If the probe failure/slow rate is below the threshold, the breaker closes; otherwise it re-opens.</li>
        </ul>
      </Section>

      <Section id="detection" title="Detection, severity and verification">
        <p>An incident opens when an entity is impaired for {M.detectionWindowSeconds} consecutive seconds. Impaired means degraded/protected/unavailable, or retail at risk or in breach. Its start time is the triggering scenario&apos;s start, which gives a measurable time to detection. Recovery is <b>verified</b> when every affected entity has met healthy thresholds for {M.verificationWindowSeconds} consecutive seconds with breakers closed.</p>
        <p>Severity: <b>critical</b> = retail breach or demand ≥ capacity; <b>high</b> = retail at risk, ≥2 partners impaired or any unavailable; <b>medium</b> = an affected service impaired; <b>low</b> otherwise.</p>
      </Section>

      <Section id="rules" title="Rule-based investigator (AI OFF and fallback)">
        <ul className="list-disc pl-5">
          <li><b>R1 downstream latency</b>: peak P95 ≥ {RULE_THRESHOLDS.latencyRatio}× baseline while peak rate ≤ {RULE_THRESHOLDS.rateNotElevated}× baseline.</li>
          <li><b>R2 traffic surge</b>: peak rate ≥ {RULE_THRESHOLDS.surgeRatio}× baseline.</li>
          <li><b>R3 downstream errors</b>: partner-returned errors ≥ {RULE_THRESHOLDS.upstreamErrorPct}% with latency &lt; {RULE_THRESHOLDS.latencyRatio}×.</li>
          <li><b>R4 concurrency pressure</b>: peak in-flight ≥ {RULE_THRESHOLDS.concurrencyPressure * 100}% of limit. <b>R5</b>: breaker open/half-open is reported as blocked calls. <b>R6</b>: retail breach/at-risk warning.</li>
          <li><b>R7 saturation</b>: utilisation ≥ 85% with broad demand (≥ {RULE_THRESHOLDS.broadDemandMinPartners} partners or retail ≥ {RULE_THRESHOLDS.broadDemandRatio}×).</li>
          <li>If no rule matches, or evidence is ambiguous: <b>root cause unconfirmed</b> → escalate to a human operator.</li>
        </ul>
        <p>Rule-based output is always labelled “Rule-based (conventional)” or “Rule-based fallback”. It is never presented as an LLM result.</p>
      </Section>

      <Section id="ai" title="AI investigation design">
        <p>The LLM receives a compact context built from the actual simulated telemetry: current values, 60-second peaks, ratios to baseline, a P95 trend, gateway state, recent events, prior investigations/actions, and the list of available action IDs. Scenario names, triggers and ground-truth causes are excluded.</p>
        <p>The system prompt requires: evidence only from the context; observed facts kept separate from inferences and unknowns; disclosed uncertainty; no invented data; only listed action IDs; no claims of execution; no loosening of protections; human approval for every change. Output must be JSON, which is validated against a zod schema (bounded lengths). Malformed output triggers the fallback.</p>
        <p>Reliability: configurable total time budget (default 8 s), bounded retries (default 2) with exponential backoff and jitter for retryable errors only (429, 5xx, network), an error taxonomy, a per-instance concurrency cap, and best-effort per-IP rate limits. The simulation never waits on AI.</p>
      </Section>

      <Section id="policy" title="Policy validation (deterministic, runs on proposal and again at approval)">
        <ul className="list-disc pl-5">
          <li>Unknown action IDs are rejected. Only {Object.keys(ACTIONS).length} predefined simulated actions exist; none disables a protection.</li>
          <li>Targets must be partners implicated in the incident. Retail is a protected service and cannot be capped or rate-limited.</li>
          <li>Concurrency cap: must tighten the limit, and requires concurrency-pressure evidence in the last 60 s.</li>
          <li>Rate limit: requires traffic ≥ 1.3× baseline in the last 60 s (otherwise it would discard legitimate requests).</li>
          <li>Scale-out is bounded (max 510 slots) and carries cost and latency warnings. Escalation cannot be repeated while remediation is in progress. Releasing controls requires 30 s of verified health.</li>
          <li>Approvals must reference a pending recommendation from the latest investigation of an open incident (stale recommendations are refused). Decisions are idempotent.</li>
        </ul>
      </Section>

      <Section id="fairness" title="Fair AI ON vs AI OFF comparison">
        <p><b>Approach A — paired runs:</b> identical seed, scenario, initial conditions and deterministic protections. Measured investigation wall-clock latency is converted to simulated seconds (1:1 by default, minimum one tick for both modes). A <b>simulated operator</b> approves every policy-valid recommendation after the same fixed delay in both modes, and re-investigates every 60 s while unresolved (max 3). This removes human variance; it is labelled and is not a claim about real engineers.</p>
        <p><b>Approach B — benchmark:</b> both investigators score the same context per golden scenario against expected causes and permitted, unnecessary and forbidden actions. Grounding is a numeric-match heuristic.</p>
        <p><b>Interactive runs:</b> your own incidents record real human decision time separately from AI latency.</p>
        <p>Metrics: time to detection/diagnosis/recommendation/recovery = event timestamp − incident start (simulated seconds). AI latency is measured wall-clock. Retail impact = simulated seconds in breach/at risk. Unnecessary intervention = an executed intervention whose scenario-specific post-action check failed. Protection-oriented actions are judged on protection metrics, not on whether the partner&apos;s own downstream recovered. Zero denominators show N/A.</p>
      </Section>

      <Section id="value" title="Business value">
        <p><code>Estimated gross impact avoided = simulated downtime minutes avoided × assumed impact per downtime minute</code>. The case-provided assumption is ${CASE_COST_PER_DOWNTIME_MINUTE_USD.toLocaleString("en-US")}/min for one fintech partner. It is editable and not verified. Net value is shown only when token usage and a price are available. Benefit is attributed separately to gateway controls (measured against an uncontrolled counterfactual), diagnosis speed, recommendation speed, approval time (held constant) and action effectiveness (uncertain). Reduced investigation time is not equated with reduced downtime.</p>
        <p>Known modelling assumption: escalating to a partner leads to remediation 60 simulated seconds later, but only when the scenario defines the fault as partner-side and remediable. This is a disclosed scenario parameter, not an empirical result.</p>
      </Section>

      <Section id="dictionary" title="Data dictionary (synthetic telemetry)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="text-left text-muted"><tr><th className="py-1.5 pr-3 font-medium">Field</th><th className="py-1.5 pr-3 font-medium">Unit</th><th className="py-1.5 font-medium">Description</th></tr></thead>
            <tbody>
              {DATA_DICTIONARY.map((d) => (
                <tr key={d.field} className="border-t border-border align-top"><td className="py-1.5 pr-3 font-mono text-text">{d.field}</td><td className="py-1.5 pr-3">{d.unit}</td><td className="py-1.5">{d.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="limitations" title="Limitations">
        <ul className="list-disc pl-5">
          <li>Simplified fluid model at 1-second resolution, not a request-level discrete-event simulation. No retries, idempotency keys or transaction semantics are modelled: rejected or timed-out requests are simulated counts only.</li>
          <li>Browser and server run the same deterministic engine. Floating-point differences between JavaScript engines are reduced by quantisation, but are not mathematically excluded; the server&apos;s replay is authoritative.</li>
          <li>Rate limits are per server instance (best effort on serverless).</li>
          <li>Paired runs are single samples with no statistical significance. Benchmark scoring is scenario-specific and illustrative.</li>
        </ul>
      </Section>
    </div>
  );
}
