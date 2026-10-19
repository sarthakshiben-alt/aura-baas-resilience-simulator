/**
 * Server-only configuration. Never import this module from client components:
 * it reads secrets. tests/unit/security.test.ts checks client bundles for leaks.
 */
import { OpenAICompatibleProvider, type AIProvider } from "../ai/provider";

export type AIProviderKind = "groq" | "openai_compatible" | "ollama" | "none";

export interface ServerEnv {
  aiProvider: AIProviderKind;
  aiModel: string | null;
  aiBaseUrl: string | null;
  aiTimeoutMs: number;
  aiMaxRetries: number;
  aiMaxConcurrency: number;
  aiPricePerMillionTokensUsd: number | null;
  aiConfigured: boolean;
  aiConfigProblem: string | null;
  sessionSecret: string;
  sessionSecretSource: "env" | "insecure_default";
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  persistence: "supabase" | "memory";
  demoMode: boolean;
}

const INSECURE_DEFAULT_SECRET = "aura-demo-insecure-default-secret-change-me";

function int(v: string | undefined, def: number, lo: number, hi: number) {
  const n = v === undefined || v === "" ? def : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
}

export function readServerEnv(e: NodeJS.ProcessEnv = process.env): ServerEnv {
  const raw = (e.AI_PROVIDER ?? "groq").trim().toLowerCase();
  const aiProvider: AIProviderKind = raw === "groq" || raw === "openai_compatible" || raw === "ollama" || raw === "none" ? raw : "none";
  const aiModel = e.AI_MODEL?.trim() || null;
  const key = e.AI_API_KEY?.trim() || null;
  let aiBaseUrl: string | null = null;
  let problem: string | null = null;
  if (aiProvider === "groq") aiBaseUrl = "https://api.groq.com/openai/v1";
  else if (aiProvider === "openai_compatible") aiBaseUrl = e.AI_BASE_URL?.trim() || null;
  else if (aiProvider === "ollama") aiBaseUrl = e.AI_BASE_URL?.trim() || "http://localhost:11434/v1";

  if (aiProvider === "none") problem = "AI_PROVIDER is 'none'";
  else if (!aiModel) problem = "AI_MODEL is not set";
  else if (aiProvider !== "ollama" && !key) problem = "AI_API_KEY is not set";
  else if (!aiBaseUrl) problem = "AI_BASE_URL is not set";
  else if (aiProvider === "ollama" && e.NODE_ENV === "production" && e.ALLOW_LOCAL_AI !== "true") problem = "Local Ollama provider is disabled in production";

  const secret = e.SESSION_SIGNING_SECRET?.trim();
  const price = e.AI_PRICE_PER_MILLION_TOKENS_USD ? Number(e.AI_PRICE_PER_MILLION_TOKENS_USD) : NaN;
  const supabaseUrl = e.NEXT_PUBLIC_SUPABASE_URL?.trim() || e.SUPABASE_URL?.trim() || null;
  const serviceKey = e.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  return {
    aiProvider,
    aiModel,
    aiBaseUrl,
    aiTimeoutMs: int(e.AI_TIMEOUT_MS, 8000, 500, 60000),
    aiMaxRetries: int(e.AI_MAX_RETRIES, 2, 0, 3),
    aiMaxConcurrency: int(e.AI_MAX_CONCURRENCY, 2, 1, 8),
    aiPricePerMillionTokensUsd: Number.isFinite(price) && price >= 0 ? price : null,
    aiConfigured: problem === null,
    aiConfigProblem: problem,
    sessionSecret: secret && secret.length >= 16 ? secret : INSECURE_DEFAULT_SECRET,
    sessionSecretSource: secret && secret.length >= 16 ? "env" : "insecure_default",
    supabaseUrl,
    supabaseServiceRoleKey: serviceKey,
    persistence: supabaseUrl && serviceKey ? "supabase" : "memory",
    demoMode: (e.DEMO_MODE ?? "true") !== "false",
  };
}

let cached: ServerEnv | null = null;
export function serverEnv(): ServerEnv {
  cached ??= readServerEnv();
  return cached;
}
export function resetServerEnvCache() {
  cached = null;
}

export function createProvider(env: ServerEnv = serverEnv(), e: NodeJS.ProcessEnv = process.env): AIProvider | null {
  if (!env.aiConfigured || !env.aiModel || !env.aiBaseUrl) return null;
  return new OpenAICompatibleProvider(env.aiProvider, env.aiModel, env.aiBaseUrl, e.AI_API_KEY?.trim() || null);
}

/** Public, non-secret description of the AI configuration. */
export function publicAiStatus(env: ServerEnv = serverEnv()) {
  return {
    configured: env.aiConfigured,
    provider: env.aiConfigured ? env.aiProvider : null,
    model: env.aiConfigured ? env.aiModel : null,
    timeoutMs: env.aiTimeoutMs,
    maxRetries: env.aiMaxRetries,
    reason: env.aiConfigured ? null : "Live AI is not configured on this deployment; AI-ON investigations use the clearly labelled rule-based fallback.",
  };
}
