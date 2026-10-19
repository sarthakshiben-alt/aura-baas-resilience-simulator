import { requestTime } from "@/lib/server/dynamic";
import { json } from "@/lib/server/http";
import { publicAiStatus, serverEnv } from "@/lib/server/env";
import { aiInFlight } from "@/lib/ai/service";

export async function GET() {
  await requestTime();
  const env = serverEnv();
  return json({
    status: "ok",
    simulated: true,
    notice: "SIMULATED ENVIRONMENT — NO REAL BANKING SYSTEM CONNECTED",
    ai: { ...publicAiStatus(env), inFlight: aiInFlight() },
    persistence: env.persistence,
    sessionSigning: env.sessionSecretSource === "env" ? "configured" : "insecure_default",
    time: new Date().toISOString(),
  });
}
