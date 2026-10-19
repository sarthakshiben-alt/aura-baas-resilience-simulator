/** Structured JSON logging with secret redaction. Server-side only. */
const REDACT = /key|secret|token|authorization|password|cookie/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, REDACT.test(k) ? "[redacted]" : redact(x, depth + 1)]));
}

export function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(data) as object) });
  if (level === "error") console.error(line);
  else console.log(line);
}
