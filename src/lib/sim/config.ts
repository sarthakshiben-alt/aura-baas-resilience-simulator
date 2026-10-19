import type { Controls, EntityId, EntityProfile, PartnerId, SimConfig } from "./types";

/**
 * Synthetic engineering assumptions. These are NOT real Aura telemetry or
 * verified service-level agreements. Every value is configurable.
 */
export const DEFAULT_CONFIG: SimConfig = {
  baseline: {
    partnerRps: 100,
    partnerP95Ms: 180,
    partnerErrorRate: 0.005,
    partnerBackendCapacityRps: 200,
    retailRps: 1200,
    retailP95Ms: 150,
    retailErrorRate: 0.001,
    retailTargetP95Ms: 300,
    gatewayOverheadMs: 8,
    latencySigma: 0.4,
  },
  breaker: {
    windowSeconds: 10,
    failureRateThreshold: 0.5,
    slowCallThresholdMs: 1000,
    minRequests: 50,
    openSeconds: 30,
    halfOpenSeconds: 10,
    halfOpenProbeFraction: 0.1,
  },
  monitoring: {
    detectionWindowSeconds: 3,
    verificationWindowSeconds: 30,
    degradedP95Ms: 400,
    degradedErrorRate: 0.02,
    unavailableSuccessRate: 0.5,
    retailAtRiskFraction: 0.85,
    retailAtRiskErrorRate: 0.01,
    gatewayPressureUtilisation: 0.85,
    controlRejectionThreshold: 0.01,
    downtimeSuccessRate: 0.5,
  },
  actions: {
    predefinedConcurrencyCap: 40,
    rateLimitBaselineMultiple: 1.5,
    scaleStepSlots: 85,
    maxCapacitySlots: 510,
    costPerSlotHourUsd: 0.05,
    retailReservationStepSlots: 40,
    maxRetailReservationSlots: 220,
  },
  gatewayCapacitySlots: 340,
  maxTicks: 7200,
};

/** Protections enabled: the default posture of the Aura gateway. */
export const PROTECTED_CONTROLS: Controls = {
  isolationEnabled: true,
  perPartnerLimit: 100,
  timeoutMs: 2000,
  breakerEnabled: true,
  retailReservationEnabled: true,
  retailReservationSlots: 140,
  extraCapacitySlots: 0,
  caps: {},
  rateLimits: {},
};

/** "Uncontrolled" posture used only to show what happens without protections. */
export const UNCONTROLLED_CONTROLS: Controls = {
  ...PROTECTED_CONTROLS,
  isolationEnabled: false,
  breakerEnabled: false,
  retailReservationEnabled: false,
  timeoutMs: 30000,
};

export const ALLOWED_TIMEOUTS_MS = [1000, 2000, 5000, 10000, 30000] as const;

export const ENTITY_PROFILES: Record<EntityId, EntityProfile> = {
  "partner-a": { id: "partner-a", name: "Partner A", shortName: "A", segment: "Wealth Management" },
  "partner-b": { id: "partner-b", name: "Partner B", shortName: "B", segment: "Payments" },
  "partner-c": { id: "partner-c", name: "Partner C", shortName: "C", segment: "Digital Lending" },
  "partner-d": { id: "partner-d", name: "Partner D", shortName: "D", segment: "Personal Finance" },
  "partner-e": { id: "partner-e", name: "Partner E", shortName: "E", segment: "Investment Platform" },
  retail: { id: "retail", name: "Retail Banking", shortName: "Retail", segment: "Aura retail customers (protected)" },
};

export function entityLabel(id: EntityId | null | undefined): string {
  if (!id) return "Platform";
  const p = ENTITY_PROFILES[id];
  return id === "retail" ? p.name : `${p.name} (${p.segment})`;
}

export function cloneControls(c: Controls): Controls {
  return { ...c, caps: { ...c.caps }, rateLimits: { ...c.rateLimits } };
}

export function cloneConfig(c: SimConfig): SimConfig {
  return {
    ...c,
    baseline: { ...c.baseline },
    breaker: { ...c.breaker },
    monitoring: { ...c.monitoring },
    actions: { ...c.actions },
  };
}

export function effectiveLimit(controls: Controls, partner: PartnerId): number | null {
  const cap = controls.caps[partner];
  const base = controls.isolationEnabled ? controls.perPartnerLimit : null;
  if (cap !== undefined) return base === null ? cap : Math.min(cap, base);
  return base;
}
