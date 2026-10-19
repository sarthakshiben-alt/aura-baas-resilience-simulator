/**
 * Provider abstraction. Every provider takes a system + user prompt and
 * returns raw text; parsing and validation happen in the service so a provider
 * can never bypass schema checks. Server-side only.
 */

export type AIErrorCategory =
  | "not_configured"
  | "timeout"
  | "rate_limited"
  | "auth_error"
  | "model_unavailable"
  | "bad_request"
  | "server_error"
  | "network_error"
  | "malformed_output"
  | "concurrency_limited";

export class AIProviderError extends Error {
  constructor(
    public category: AIErrorCategory,
    message: string,
    public retryable: boolean,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface CompletionRequest {
  system: string;
  user: string;
  signal: AbortSignal;
  maxTokens: number;
}

export interface CompletionResult {
  text: string;
  headersMs: number | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
}

export interface AIProvider {
  id: string;
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export function classifyHttpStatus(status: number, retryAfter: string | null): AIProviderError {
  const ra = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Math.round(Number(retryAfter) * 1000) : null;
  if (status === 429) return new AIProviderError("rate_limited", "Provider rate limit reached", true, ra);
  if (status === 401 || status === 403) return new AIProviderError("auth_error", "Provider rejected the credentials", false);
  if (status === 404) return new AIProviderError("model_unavailable", "Model not found or unavailable", false);
  if (status === 408) return new AIProviderError("timeout", "Provider request timeout", true);
  if (status === 400 || status === 422) return new AIProviderError("bad_request", "Provider rejected the request", false);
  if (status === 503 || status === 502 || status === 500 || status === 504) return new AIProviderError("server_error", `Provider server error (${status})`, true, ra);
  return new AIProviderError("server_error", `Unexpected provider status ${status}`, status >= 500);
}

/** OpenAI-compatible chat-completions client (Groq, OpenRouter, Ollama's /v1, etc.). */
export class OpenAICompatibleProvider implements AIProvider {
  constructor(
    public id: string,
    public model: string,
    private baseUrl: string,
    private apiKey: string | null,
    private jsonMode = true,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: req.signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          max_tokens: req.maxTokens,
          ...(this.jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
    } catch (err) {
      if (req.signal.aborted) throw new AIProviderError("timeout", "Provider request timed out", true);
      throw new AIProviderError("network_error", `Network error contacting provider: ${(err as Error).name}`, true);
    }
    const headersMs = Date.now() - started;
    if (!res.ok) {
      // Drain body without surfacing it (it may echo request content).
      await res.text().catch(() => "");
      throw classifyHttpStatus(res.status, res.headers.get("retry-after"));
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (req.signal.aborted) throw new AIProviderError("timeout", "Provider request timed out", true);
      throw new AIProviderError("malformed_output", "Provider returned a non-JSON envelope", false);
    }
    const b = body as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const text = b.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new AIProviderError("malformed_output", "Provider response had no message content", false);
    return {
      text,
      headersMs,
      usage: b.usage
        ? { promptTokens: b.usage.prompt_tokens ?? null, completionTokens: b.usage.completion_tokens ?? null, totalTokens: b.usage.total_tokens ?? null }
        : null,
    };
  }
}

/**
 * Fault-injecting provider used by the simulator's "simulate AI fault" control
 * and the golden dataset (GS-10/GS-11). No real provider is called; results
 * are always labelled as injected faults.
 */
export class FaultInjectingProvider implements AIProvider {
  id = "fault-injection";
  constructor(
    public model: string,
    private fault: "timeout" | "malformed",
  ) {}

  complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.fault === "malformed") {
      return Promise.resolve({ text: '{"summary": "Partner A is slow", "likelyCauses": "downstream", severity: high', headersMs: 5, usage: null });
    }
    return new Promise((_, reject) => {
      const onAbort = () => reject(new AIProviderError("timeout", "Provider request timed out (injected fault)", false));
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Deterministic test double. Never used outside automated tests. */
export class MockProvider implements AIProvider {
  id = "mock";
  calls = 0;
  constructor(
    public model: string,
    private respond: (req: CompletionRequest, call: number) => Promise<CompletionResult> | CompletionResult,
  ) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return this.respond(req, this.calls);
  }
}
