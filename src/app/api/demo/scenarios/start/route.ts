import { z } from "zod";
import { errorResponse, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { stateSummary } from "@/lib/server/summary";
import { applyCommand, type Command } from "@/lib/sim/workflow";

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema, scenarioId: z.string().min(1).max(40), target: z.string().max(20).nullable().optional() });

export async function POST(req: Request) {
  try {
    const body = await readJson(req, Body);
    const { state, log } = replayVerified(body.session, body.log);
    const command: Command = { k: "start", at: log.tick, scenarioId: body.scenarioId, target: body.target ?? null };
    applyCommand(state, command);
    return json({ command, log: { ...log, commands: [...log.commands, command] }, state: stateSummary(state) });
  } catch (e) {
    return errorResponse(e, "demo/scenarios/start");
  }
}
