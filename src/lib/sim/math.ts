/** Deterministic numeric helpers. No Math.random is used anywhere in the simulator. */

/** Abramowitz & Stegun 7.1.26 approximation of erf (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export const Z95 = 1.6448536;
export const Z99 = 2.3263479;

/** Lognormal with given median and shape sigma. */
export interface LogNormal {
  mu: number;
  sigma: number;
}

export function lognormalFromP95(p95: number, sigma: number): LogNormal {
  const median = Math.max(p95, 0.001) / Math.exp(Z95 * sigma);
  return { mu: Math.log(median), sigma };
}

export function lnQuantile(d: LogNormal, z: number): number {
  return Math.exp(d.mu + z * d.sigma);
}

/** P(X > x) */
export function lnSurvival(d: LogNormal, x: number): number {
  if (x <= 0) return 1;
  return 1 - normCdf((Math.log(x) - d.mu) / d.sigma);
}

/** E[min(X, k)] for lognormal X. */
export function lnTruncatedMean(d: LogNormal, k: number): number {
  if (k <= 0) return 0;
  const mean = Math.exp(d.mu + (d.sigma * d.sigma) / 2);
  const partial = mean * normCdf((Math.log(k) - d.mu - d.sigma * d.sigma) / d.sigma);
  return partial + k * lnSurvival(d, k);
}

/** Integer hash noise in [-1, 1] that depends only on its inputs (replay-stable). */
export function noise(seed: number, tick: number, entity: number, channel: number): number {
  let h = (seed | 0) ^ Math.imul(tick + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) ^ Math.imul(entity + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) ^ Math.imul(channel + 7, 0x27d4eb2f);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Quantise to a fixed number of decimals so client/server replays agree. */
export function q(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Quantile of a mixture of shifted lognormals, by bisection.
 * Each component: weight w, shift c (constant ms), lognormal d, truncated at cap.
 */
export function mixtureQuantile(
  comps: { w: number; c: number; d: LogNormal; cap: number }[],
  p: number,
): number | null {
  const total = comps.reduce((s, c) => s + c.w, 0);
  if (total <= 0) return null;
  const cdf = (x: number) =>
    comps.reduce((s, c) => {
      if (x >= c.cap) return s + c.w;
      return s + c.w * (1 - lnSurvival(c.d, x - c.c));
    }, 0) / total;
  let lo = 0;
  let hi = Math.max(...comps.map((c) => c.cap));
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return hi;
}
