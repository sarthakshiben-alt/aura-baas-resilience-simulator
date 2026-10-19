/**
 * Best-effort fixed-window rate limiter (per server instance). On Vercel each
 * instance has its own memory, so limits are approximate; swap for a shared
 * store (e.g. Upstash Redis) for strict production limits. Documented in README.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip")) ?? "local";
  return ip.trim().slice(0, 64);
}

export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterS: number } {
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterS: 0 };
  }
  if (b.count >= max) return { ok: false, retryAfterS: Math.ceil((b.resetAt - now) / 1000) };
  b.count += 1;
  return { ok: true, retryAfterS: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}

export const LIMITS = {
  investigate: { max: 12, windowMs: 60_000 },
  assistant: { max: 20, windowMs: 60_000 },
  decision: { max: 60, windowMs: 60_000 },
  comparison: { max: 4, windowMs: 60_000 },
  benchmark: { max: 2, windowMs: 60_000 },
  session: { max: 30, windowMs: 60_000 },
} as const;
