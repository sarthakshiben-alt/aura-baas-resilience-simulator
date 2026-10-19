/**
 * Core types for the Aura BaaS resilience simulator.
 *
 * ALL VALUES PRODUCED BY THIS MODULE ARE SYNTHETIC. No real banking system is
 * connected. Units are fixed and documented in docs/DATA_DICTIONARY.md:
 *   - latency: milliseconds (ms)
 *   - throughput: requests per second (rps)
 *   - rates / utilisation: fractions in [0, 1]
 *   - time: simulation ticks, 1 tick = 1 simulated second
 */

export const PARTNER_IDS = [
  "partner-a",
  "partner-b",
  "partner-c",
  "partner-d",
  "partner-e",
] as const;
export type PartnerId = (typeof PARTNER_IDS)[number];
export type EntityId = PartnerId | "retail";
export const ENTITY_IDS: readonly EntityId[] = [...PARTNER_IDS, "retail"];

export function isPartnerId(value: unknown): value is PartnerId {
  return typeof value === "string" && (PARTNER_IDS as readonly string[]).includes(value);
}
export function isEntityId(value: unknown): value is EntityId {
  return value === "retail" || isPartnerId(value);
}

/** Partner health as seen from the Aura gateway. See monitoring.ts for the exact rules. */
export type HealthStatus = "healthy" | "degraded" | "protected" | "recovering" | "unavailable";
/** Retail banking health relative to its simulated service target. */
export type RetailHealth = "healthy" | "at_risk" | "breach";
export type BreakerState = "closed" | "open" | "half_open";
export type GatewayProtectionStatus = "nominal" | "protecting" | "pressure" | "saturated";
export type Severity = "low" | "medium" | "high" | "critical";

export type CauseCategory =
  | "partner_downstream_latency"
  | "partner_downstream_errors"
  | "partner_traffic_surge"
  | "shared_gateway_saturation"
  | "retail_demand_pressure"
  | "insufficient_evidence"
  | "no_incident";

export const CAUSE_CATEGORIES: readonly CauseCategory[] = [
  "partner_downstream_latency",
  "partner_downstream_errors",
  "partner_traffic_surge",
  "shared_gateway_saturation",
  "retail_demand_pressure",
  "insufficient_evidence",
  "no_incident",
];

export interface EntityProfile {
  id: EntityId;
  name: string;
  shortName: string;
  segment: string;
}

export interface BaselineConfig {
  partnerRps: number;
  partnerP95Ms: number;
  partnerErrorRate: number;
  /** Requests per second the partner's own backend can absorb before latency rises. */
  partnerBackendCapacityRps: number;
  retailRps: number;
  retailP95Ms: number;
  retailErrorRate: number;
  retailTargetP95Ms: number;
  gatewayOverheadMs: number;
  /** Lognormal shape parameter used for all latency distributions. */
  latencySigma: number;
}

export interface BreakerConfig {
  windowSeconds: number;
  failureRateThreshold: number;
  slowCallThresholdMs: number;
  minRequests: number;
  openSeconds: number;
  halfOpenSeconds: number;
  halfOpenProbeFraction: number;
}

export interface MonitoringConfig {
  detectionWindowSeconds: number;
  verificationWindowSeconds: number;
  degradedP95Ms: number;
  degradedErrorRate: number;
  unavailableSuccessRate: number;
  retailAtRiskFraction: number;
  retailAtRiskErrorRate: number;
  gatewayPressureUtilisation: number;
  controlRejectionThreshold: number;
  downtimeSuccessRate: number;
}

export interface ActionTuning {
  predefinedConcurrencyCap: number;
  rateLimitBaselineMultiple: number;
  scaleStepSlots: number;
  maxCapacitySlots: number;
  /** Illustrative cost of one additional gateway slot for one hour (USD). */
  costPerSlotHourUsd: number;
  retailReservationStepSlots: number;
  maxRetailReservationSlots: number;
}

export interface SimConfig {
  baseline: BaselineConfig;
  breaker: BreakerConfig;
  monitoring: MonitoringConfig;
  actions: ActionTuning;
  /** Total shared gateway worker slots before any autoscaling. */
  gatewayCapacitySlots: number;
  maxTicks: number;
}

/** Gateway protections. These are deterministic and never depend on AI availability. */
export interface Controls {
  isolationEnabled: boolean;
  perPartnerLimit: number;
  timeoutMs: number;
  breakerEnabled: boolean;
  retailReservationEnabled: boolean;
  retailReservationSlots: number;
  extraCapacitySlots: number;
  caps: Partial<Record<PartnerId, number>>;
  rateLimits: Partial<Record<PartnerId, number>>;
}

export type ControlsPatch = Partial<
  Pick<
    Controls,
    | "isolationEnabled"
    | "breakerEnabled"
    | "retailReservationEnabled"
    | "timeoutMs"
    | "perPartnerLimit"
    | "retailReservationSlots"
  >
>;

/** One entity's telemetry for one simulated second. */
export interface EntitySample {
  t: number;
  id: EntityId;
  offeredRps: number;
  servedRps: number;
  throttledRps: number;
  rejectedRps: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  errorRate: number;
  timeoutRate: number;
  upstreamErrorRate: number;
  rejectedRate: number;
  throttledRate: number;
  successRate: number;
  inFlight: number;
  concurrencyLimit: number | null;
  breaker: BreakerState;
  status: HealthStatus;
  queueDelayMs: number;
}

export interface GatewaySample {
  t: number;
  capacitySlots: number;
  allocatedSlots: number;
  utilisation: number;
  pressure: number;
  partnerPoolUtilisation: number;
  retailPoolUtilisation: number;
  totalRps: number;
  platformP95Ms: number | null;
  platformErrorRate: number;
  retailP95Ms: number | null;
  retailHealth: RetailHealth;
  openBreakers: number;
  protectionStatus: GatewayProtectionStatus;
  degradedPartners: number;
  activeIncidents: number;
  simulatedCostUsd: number;
}

export type PerturbationChannel = "latency" | "demand" | "errors";

export interface PerturbationSpec {
  entity: EntityId | "target";
  channel: PerturbationChannel;
  /** Multiplier for latency/demand (1 = baseline); additive fraction for errors. */
  peak: number;
  startOffsetSeconds: number;
  rampUpSeconds: number;
  /** null = sustained until stopped, recovered or remediated. */
  holdSeconds: number | null;
  rampDownSeconds: number;
  /** Whether escalating to the partner leads to modelled remediation. */
  remediableByPartnerEscalation: boolean;
  remediationSeconds: number;
}

export interface PerturbationRuntime {
  entity: EntityId;
  channel: PerturbationChannel;
  peak: number;
  startAt: number;
  rampUpSeconds: number;
  plannedEndAt: number | null;
  rampDownSeconds: number;
  endAt: number | null;
  endReason: "planned" | "stopped" | "recovered" | "remediated" | null;
  remediableByPartnerEscalation: boolean;
  remediationSeconds: number;
  remediationAt: number | null;
}

export interface ScenarioRun {
  id: string;
  scenarioId: string;
  label: string;
  targetEntityId: EntityId | null;
  startedAt: number;
  stoppedAt: number | null;
  perturbations: PerturbationRuntime[];
}

export type TimelineKind =
  | "scenario_triggered"
  | "scenario_stopped"
  | "recovery_triggered"
  | "degradation_detected"
  | "entity_affected"
  | "breaker_opened"
  | "breaker_half_open"
  | "breaker_closed"
  | "investigation_started"
  | "investigation_failed"
  | "diagnosis_returned"
  | "action_proposed"
  | "action_approved"
  | "action_rejected"
  | "action_cancelled"
  | "action_executed"
  | "action_blocked"
  | "action_verified"
  | "partner_remediation_started"
  | "partner_remediation_completed"
  | "controls_changed"
  | "recovery_started"
  | "partner_recovered"
  | "recovery_verified";

export interface TimelineEvent {
  seq: number;
  t: number;
  kind: TimelineKind;
  incidentId: string | null;
  entityId: EntityId | null;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}

export type InvestigationMode = "ai_on" | "ai_off";
export type DiagnosisSource = "llm" | "rule_based_fallback" | "rule_based";
/**
 * How the investigation was carried out:
 * - manual_runbook:   conventional on-call engineer applies the runbook after an ASSUMED triage time
 * - automated_rules:  rule-based runbook runs automatically on request/detection (no AI)
 * - ai_assisted:      configured LLM investigates (with labelled fallback)
 */
export type InvestigationWorkflow = "manual_runbook" | "automated_rules" | "ai_assisted";

export type ValidationStatus = "valid" | "valid_with_warnings" | "rejected";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "superseded"
  | "expired"
  | "not_approvable";

export interface PolicyResult {
  status: ValidationStatus;
  reasons: string[];
  warnings: string[];
}

export interface Recommendation {
  id: string;
  incidentId: string;
  investigationId: string;
  actionId: string;
  targetEntityId: EntityId | null;
  rationale: string;
  source: DiagnosisSource;
  createdAt: number;
  validation: PolicyResult;
  approval: ApprovalStatus;
  decidedAt: number | null;
  decidedAtWallMs: number | null;
  decidedBy: "human" | "simulated_operator" | null;
  scheduledExecutionAt: number | null;
  executedAt: number | null;
  executionOutcome: string | null;
}

export interface ActionAuditEntry {
  id: string;
  incidentId: string;
  recommendationId: string;
  actionId: string;
  targetEntityId: EntityId | null;
  actorType: "human" | "simulated_operator" | "system";
  outcome: "approved" | "rejected" | "cancelled" | "executed" | "blocked" | "verified";
  t: number;
  wallMs: number | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  note: string;
}

export interface PostActionCheck {
  recommendationId: string;
  actionId: string;
  executedAt: number;
  evaluateAt: number;
  before: Record<string, number | null>;
  after: Record<string, number | null> | null;
  effective: boolean | null;
  intervention: boolean;
  note: string;
}

export interface InvestigationRecord {
  id: string;
  incidentId: string;
  mode: InvestigationMode;
  workflow: InvestigationWorkflow;
  /** Simulated seconds of ASSUMED human triage before the runbook result (manual_runbook only; else 0). */
  assumedTriageSeconds: number;
  source: DiagnosisSource;
  status: "succeeded" | "fallback" | "failed";
  requestedAt: number;
  appliedAt: number;
  provider: string;
  model: string | null;
  /** Total wall-clock investigation time (LLM attempts + any fallback), ms. */
  latencyMs: number;
  /** Wall-clock time spent in LLM attempts only, ms (null if no LLM was called). */
  llmLatencyMs: number | null;
  startedAtWallMs: number;
  completedAtWallMs: number;
  firstResponseMs: number | null;
  attempts: number;
  errorCategory: string | null;
  llmError: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  fallbackUsed: boolean;
  faultInjected: string | null;
  validationNotes: string[];
  diagnosis: import("../ai/schema").Diagnosis;
  speed: number;
}

export type IncidentStatus = "open" | "investigating" | "mitigating" | "monitoring" | "resolved";

export interface Incident {
  id: string;
  scenarioRunIds: string[];
  scenarioIds: string[];
  primaryEntityId: EntityId;
  affectedEntityIds: EntityId[];
  status: IncidentStatus;
  severity: Severity;
  peakSeverity: Severity;
  startedAt: number;
  detectedAt: number;
  investigationRequestedAt: number | null;
  diagnosedAt: number | null;
  recommendationAt: number | null;
  firstDecisionAt: number | null;
  firstDecisionWallMs: number | null;
  firstActionExecutedAt: number | null;
  platformProtectedAt: number | null;
  recoveryStartedAt: number | null;
  partnerRecoveredAt: number | null;
  recoveredAt: number | null;
  recoveryVerified: boolean;
  investigationMode: InvestigationMode | null;
  retailBreachSeconds: number;
  retailAtRiskSeconds: number;
  peakRetailP95Ms: number;
  partnerImpactSeconds: Partial<Record<EntityId, number>>;
  partnerDowntimeSeconds: Partial<Record<EntityId, number>>;
  investigations: InvestigationRecord[];
  recommendations: Recommendation[];
  audit: ActionAuditEntry[];
  postActionChecks: PostActionCheck[];
}

export interface BreakerRuntime {
  state: BreakerState;
  window: { passed: number; bad: number }[];
  openedAt: number | null;
  halfOpenAt: number | null;
  probePassed: number;
  probeBad: number;
}

export interface EntityRuntime {
  anomalyStreak: number;
  healthyStreak: number;
  breaker: BreakerRuntime;
  lastStatus: HealthStatus;
}

export interface SimState {
  version: 1;
  seed: number;
  tick: number;
  config: SimConfig;
  controls: Controls;
  runtime: Record<EntityId, EntityRuntime>;
  queueDelayMs: { partnerPool: number; retailPool: number };
  scenarioRuns: ScenarioRun[];
  incidents: Incident[];
  timeline: TimelineEvent[];
  history: { entities: Record<EntityId, EntitySample[]>; gateway: GatewaySample[] };
  counters: { incident: number; event: number; scenarioRun: number; audit: number };
  simulatedCostUsd: number;
  appliedEntryIds: string[];
}
