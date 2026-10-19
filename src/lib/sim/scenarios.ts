import type { CauseCategory, EntityId, PartnerId, PerturbationSpec } from "./types";
import { PARTNER_IDS } from "./types";

/**
 * Scenario catalog. A scenario is a set of perturbations to the SIMULATED
 * downstream systems or demand. The ground-truth `rootCause` is used only for
 * scoring and is never included in the context sent to any investigator.
 */
export interface ScenarioDefinition {
  id: string;
  code: string;
  label: string;
  description: string;
  expectedEffects: string[];
  targetable: boolean;
  defaultTarget: PartnerId | null;
  rootCause: CauseCategory;
  perturbations: PerturbationSpec[];
  /** Scenario E is special: it ends perturbations on the target instead of adding any. */
  kind: "perturbation" | "recovery";
  /**
   * Randomised scenarios build their perturbations (and pick their target) from
   * a replay-stable random stream at start time. Ground truth stays server/sim-side
   * and is never placed in an investigator's context.
   */
  generate?: (rand: () => number) => GeneratedScenario;
}

export interface GeneratedScenario {
  target: PartnerId;
  perturbations: PerturbationSpec[];
  /** Plain-language description of what was rolled, revealed only after a run. */
  factors: string[];
}

/** Replay-stable PRNG (mulberry32) seeded from integers. */
export function seededRandom(...parts: number[]): () => number {
  let h = 0x9e3779b9;
  for (const p of parts) h = Math.imul(h ^ (p | 0), 0x85ebca6b) ^ (h >>> 13);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
const NAME: Record<PartnerId, string> = { "partner-a": "Partner A", "partner-b": "Partner B", "partner-c": "Partner C", "partner-d": "Partner D", "partner-e": "Partner E" };

/**
 * The murky one. One partner's downstream degrades on several channels at once,
 * each signal deliberately just under a runbook threshold (latency < 3×,
 * partner errors < 10%, traffic between the 1.25× "stable" and 1.5× "surge"
 * lines), plus unrelated red herrings elsewhere. Built on purpose to sit outside
 * the rulebook — the realistic "never seen this before" incident.
 */
export function generateMystery(rand: () => number): GeneratedScenario {
  const shuffled: PartnerId[] = [...PARTNER_IDS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const [target, herringA, herringB] = shuffled;
  const lat = between(rand, 1.9, 2.3);
  const err = between(rand, 0.04, 0.065);
  const dem = between(rand, 1.28, 1.42);
  const perturbations: PerturbationSpec[] = [
    sustained({ entity: target, channel: "latency", peak: lat, rampUpSeconds: 40, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    sustained({ entity: target, channel: "errors", peak: err, rampUpSeconds: 30, startOffsetSeconds: 5, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    sustained({ entity: target, channel: "demand", peak: dem, rampUpSeconds: 30 }),
  ];
  const factors = [
    `${NAME[target]}'s downstream got ≈${lat}× slower and started failing ≈${Math.round(err * 100)}% of calls — the real problem.`,
    `${NAME[target]}'s traffic also rose ≈${dem}× — enough to look like "maybe it's just load", too little to cause this.`,
  ];
  const herrings = [
    () => {
      const d = between(rand, 1.3, 1.45);
      perturbations.push(sustained({ entity: herringA, channel: "demand", peak: d, rampUpSeconds: 20, holdSeconds: 120, rampDownSeconds: 20 }));
      factors.push(`Red herring: ${NAME[herringA]}'s traffic jumped ≈${d}× but it stayed perfectly healthy.`);
    },
    () => {
      const d = between(rand, 1.1, 1.2);
      perturbations.push(sustained({ entity: "retail", channel: "demand", peak: d, rampUpSeconds: 30, holdSeconds: 150, rampDownSeconds: 30 }));
      factors.push(`Red herring: retail banking got ≈${d}× busier (payday?) and coped fine.`);
    },
    () => {
      const l = between(rand, 1.4, 1.7);
      perturbations.push(sustained({ entity: herringB, channel: "latency", peak: l, startOffsetSeconds: 15, rampUpSeconds: 10, holdSeconds: 40, rampDownSeconds: 10 }));
      factors.push(`Red herring: ${NAME[herringB]} had a brief ≈${l}× latency wobble that fixed itself.`);
    },
  ];
  const skip = Math.floor(rand() * herrings.length);
  herrings.forEach((h, i) => i !== skip && h());
  return { target, perturbations, factors };
}


const sustained = (p: Partial<PerturbationSpec> & Pick<PerturbationSpec, "entity" | "channel" | "peak">): PerturbationSpec => ({
  startOffsetSeconds: 0,
  rampUpSeconds: 20,
  holdSeconds: null,
  rampDownSeconds: 15,
  remediableByPartnerEscalation: false,
  remediationSeconds: 60,
  ...p,
});

export const SCENARIOS: Record<string, ScenarioDefinition> = {
  partner_slowdown: {
    id: "partner_slowdown",
    code: "A",
    label: "Partner slowdown",
    description:
      "The selected partner's simulated downstream response time rises sharply (≈45× baseline P95). Request volume is unchanged. The slowdown persists until the partner remediates it, it is stopped, or Recovery is triggered.",
    expectedEffects: [
      "Partner latency rises; requests stay in flight longer",
      "Partner concurrency rises toward its per-partner limit",
      "Timeouts and the circuit breaker activate if enabled",
      "Healthy partners and retail stay protected when isolation is effective",
    ],
    targetable: true,
    defaultTarget: "partner-a",
    rootCause: "partner_downstream_latency",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "target", channel: "latency", peak: 45, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    ],
  },
  traffic_spike: {
    id: "traffic_spike",
    code: "B",
    label: "Traffic spike",
    description:
      "Request volume to the selected partner rises to ≈3.5× baseline for 150 simulated seconds, exceeding its simulated backend capacity.",
    expectedEffects: [
      "Partner request throughput rises",
      "Concurrency rises; rate and concurrency controls may activate",
      "The simulator records whether other partners are affected",
    ],
    targetable: true,
    defaultTarget: "partner-b",
    rootCause: "partner_traffic_surge",
    kind: "perturbation",
    perturbations: [sustained({ entity: "target", channel: "demand", peak: 3.5, rampUpSeconds: 15, holdSeconds: 150, rampDownSeconds: 20 })],
  },
  resource_saturation: {
    id: "resource_saturation",
    code: "C",
    label: "Resource saturation",
    description:
      "Demand rises across every partner (≈1.9×) and retail (≈2×) for 180 simulated seconds, pushing shared gateway utilisation toward its configured limit.",
    expectedEffects: [
      "Shared gateway utilisation increases",
      "Latency may rise through queueing",
      "Controls activate according to configured rules",
      "Dashboard shows whether retail stays within its target",
    ],
    targetable: false,
    defaultTarget: null,
    rootCause: "shared_gateway_saturation",
    kind: "perturbation",
    perturbations: [
      ...PARTNER_IDS.map((id) => sustained({ entity: id, channel: "demand", peak: 1.9, rampUpSeconds: 30, holdSeconds: 180, rampDownSeconds: 30 })),
      sustained({ entity: "retail", channel: "demand", peak: 2.0, rampUpSeconds: 30, holdSeconds: 180, rampDownSeconds: 30 }),
    ],
  },
  retail_risk: {
    id: "retail_risk",
    code: "D",
    label: "Rush hour (retail at risk)",
    description:
      "Stress test: partner demand doubles, Partner C's downstream slows ≈10×, and retail demand rises ≈1.35×. Shared resource pressure from partners threatens retail banking's simulated P95 target.",
    expectedEffects: [
      "Retail banking health indicator changes",
      "A breach or near-breach of the retail target is identified",
      "Retail reservation and isolation determine whether the target holds",
    ],
    targetable: false,
    defaultTarget: null,
    rootCause: "shared_gateway_saturation",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "retail", channel: "demand", peak: 1.35, rampUpSeconds: 30, holdSeconds: 180, rampDownSeconds: 30 }),
      ...PARTNER_IDS.map((id) => sustained({ entity: id, channel: "demand", peak: 2.0, rampUpSeconds: 30, holdSeconds: 180, rampDownSeconds: 30 })),
      sustained({ entity: "partner-c", channel: "latency", peak: 10, rampUpSeconds: 30, holdSeconds: 180, rampDownSeconds: 30 }),
    ],
  },
  recovery: {
    id: "recovery",
    code: "E",
    label: "Recovery",
    description:
      "Returns the selected partner's simulated downstream response time and demand to baseline (15-second ramp). Breaker recovery then follows its configured rules.",
    expectedEffects: [
      "In-flight requests decrease",
      "Latency returns toward baseline",
      "Circuit breaker moves open → half-open → closed per its rules",
      "Recovery is verified after a sustained healthy window",
    ],
    targetable: true,
    defaultTarget: "partner-a",
    rootCause: "no_incident",
    kind: "recovery",
    perturbations: [],
  },
  downstream_errors: {
    id: "downstream_errors",
    code: "X1",
    label: "Downstream error burst",
    description: "The selected partner's simulated downstream returns errors for ≈60% of calls. Latency is unchanged.",
    expectedEffects: ["Partner error rate rises", "Circuit breaker opens on failure rate", "Other services unaffected"],
    targetable: true,
    defaultTarget: "partner-c",
    rootCause: "partner_downstream_errors",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "target", channel: "errors", peak: 0.6, rampUpSeconds: 5, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    ],
  },
  transient_slowdown: {
    id: "transient_slowdown",
    code: "X2",
    label: "Transient slowdown",
    description: "The selected partner slows sharply for 45 simulated seconds and then recovers on its own.",
    expectedEffects: ["Breaker opens", "Breaker half-open probes succeed after recovery", "Incident resolves without intervention"],
    targetable: true,
    defaultTarget: "partner-d",
    rootCause: "partner_downstream_latency",
    kind: "perturbation",
    perturbations: [sustained({ entity: "target", channel: "latency", peak: 40, rampUpSeconds: 10, holdSeconds: 45, rampDownSeconds: 10 })],
  },
  ambiguous_latency: {
    id: "ambiguous_latency",
    code: "X3",
    label: "Ambiguous multi-partner latency",
    description:
      "Two partners (B and D) show moderate simultaneous latency increases with unchanged demand and normal gateway utilisation. Telemetry does not reveal a shared cause.",
    expectedEffects: ["Two partners degrade", "No resource pressure", "Root cause cannot be established from gateway telemetry"],
    targetable: false,
    defaultTarget: null,
    rootCause: "insufficient_evidence",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "partner-b", channel: "latency", peak: 2.8, rampUpSeconds: 20 }),
      sustained({ entity: "partner-d", channel: "latency", peak: 2.6, rampUpSeconds: 25 }),
    ],
  },
  high_rate_normal_latency: {
    id: "high_rate_normal_latency",
    code: "X4",
    label: "High request rate, normal latency",
    description: "The selected partner's demand rises to ≈1.8× baseline, within its simulated backend capacity.",
    expectedEffects: ["Throughput rises", "Latency stays normal", "No incident expected"],
    targetable: true,
    defaultTarget: "partner-e",
    rootCause: "no_incident",
    kind: "perturbation",
    perturbations: [sustained({ entity: "target", channel: "demand", peak: 1.8, rampUpSeconds: 20, holdSeconds: 120 })],
  },
  low_traffic_high_latency: {
    id: "low_traffic_high_latency",
    code: "X5",
    label: "High latency, low traffic",
    description: "The selected partner's demand falls to ≈20% of baseline while its downstream latency rises ≈12×.",
    expectedEffects: ["Partner degraded", "No shared resource pressure", "Caps or scaling are unnecessary"],
    targetable: true,
    defaultTarget: "partner-d",
    rootCause: "partner_downstream_latency",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "target", channel: "demand", peak: 0.2, rampUpSeconds: 10 }),
      sustained({ entity: "target", channel: "latency", peak: 12, rampUpSeconds: 20, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    ],
  },
  mystery: {
    id: "mystery",
    code: "M",
    label: "Mystery incident",
    description:
      "Randomised every time. Something is wrong with one partner — but every signal sits just under a runbook threshold, and there are red herrings elsewhere. No rulebook entry fits.",
    expectedEffects: ["One partner degrades (which one is random)", "Several weak signals at once, plus unrelated noise", "The rulebook can't name a cause — someone has to reason about it"],
    targetable: false,
    defaultTarget: null,
    rootCause: "partner_downstream_latency",
    kind: "perturbation",
    perturbations: [],
    generate: generateMystery,
  },
  masked_slowdown: {
    id: "masked_slowdown",
    code: "X6",
    label: "Slowdown masked by moderate traffic growth",
    description:
      "The selected partner's demand rises modestly (≈1.35×, within backend capacity) while its downstream latency rises ≈30×. The latency increase is far out of proportion to the load.",
    expectedEffects: ["Partner latency rises sharply", "Traffic rises only moderately", "Simple threshold rules may not classify it"],
    targetable: true,
    defaultTarget: "partner-c",
    rootCause: "partner_downstream_latency",
    kind: "perturbation",
    perturbations: [
      sustained({ entity: "target", channel: "demand", peak: 1.35, rampUpSeconds: 15 }),
      sustained({ entity: "target", channel: "latency", peak: 30, rampUpSeconds: 20, remediableByPartnerEscalation: true, remediationSeconds: 60 }),
    ],
  },
};

/** The three scenarios offered in the UI: routine, rush hour, and the murky one. */
export const UI_SCENARIO_IDS = ["partner_slowdown", "retail_risk", "mystery"] as const;

/** The five scenarios the brief requires (A–E), in display order. */
export const PRIMARY_SCENARIO_IDS = ["partner_slowdown", "traffic_spike", "resource_saturation", "retail_risk", "recovery"] as const;
export const EXTRA_SCENARIO_IDS = [
  "downstream_errors",
  "transient_slowdown",
  "ambiguous_latency",
  "high_rate_normal_latency",
  "low_traffic_high_latency",
  "masked_slowdown",
  "mystery",
] as const;

export function getScenario(id: string): ScenarioDefinition | null {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, id) ? SCENARIOS[id] : null;
}

export function resolveEntity(spec: PerturbationSpec, target: EntityId | null): EntityId | null {
  if (spec.entity === "target") return target;
  return spec.entity;
}
