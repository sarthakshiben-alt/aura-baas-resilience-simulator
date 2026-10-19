import type { SimLog, SignedEntry } from "@/lib/sim/workflow";
import type { PairedRunResult } from "@/lib/comparison/paired";
import type { BenchmarkResult } from "@/lib/comparison/benchmark";
import type { AssistantAnswer } from "@/lib/ai/assistant";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch {
    throw new ApiError(0, "network_error", "Network error — the server could not be reached.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok) {
    const ra = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, data.error?.code ?? "error", data.error?.message ?? `Request failed (${res.status})`, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  return data;
}

export interface PublicAiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  timeoutMs: number;
  maxRetries: number;
  reason: string | null;
}

export const api = {
  catalog: async (): Promise<{ ai: PublicAiStatus }> => {
    const res = await fetch("/api/demo/state", { cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status, "error", "Catalog unavailable");
    return res.json();
  },
  reset: (seed?: number) => post<{ session: string; sessionId: string; log: SimLog }>("/api/demo/reset", seed ? { seed } : {}),
  sync: (session: string, log: SimLog) => post<unknown>("/api/demo/state", { session, log, telemetrySince: log.tick }),
  investigate: (session: string, log: SimLog, incidentId: string, mode: "ai_on" | "ai_off", fault: "timeout" | "malformed" | null, speed: number, triageMinutes: number) =>
    post<{ signed: SignedEntry; latencyTicks: number; triageTicks: number }>(`/api/incidents/${incidentId}/investigate`, { session, log, mode, fault, speed, triageMinutes }),
  decide: (session: string, log: SimLog, incidentId: string, recommendationId: string, decision: "approve" | "reject" | "cancel") =>
    post<{ signed: SignedEntry }>(`/api/incidents/${incidentId}/recommendations/${encodeURIComponent(recommendationId)}/${decision}`, { session, log }),
  ask: (session: string, log: SimLog, incidentId: string | null, question: string, aiEnabled: boolean) =>
    post<AssistantAnswer & { atSimSecond: number }>("/api/assistant", { session, log, incidentId, question, aiEnabled }),
  paired: (session: string, body: Record<string, unknown>) => post<PairedRunResult & { id: string }>("/api/comparisons/run", { session, ...body }),
  benchmark: (session: string) => post<BenchmarkResult & { id: string }>("/api/benchmark/run", { session }),
};
