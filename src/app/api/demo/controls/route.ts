import { z } from "zod";
import { ControlsPatchSchema, errorResponse, json, readJson, replayVerified, SimLogSchema } from "@/lib/server/http";
import { stateSummary } from "@/lib/server/summary";
import { applyCommand, type Command } from "@/lib/sim/workflow";

const Body = z.object({ session: z.string().min(10).max(512), log: SimLogSchema, patch: ControlsPatchSchema });

/** Operator change to deterministic gateway protections (never available to the LLM). */
export async function POST(req: Request) {
  try {
    const body = await readJson(req, Body);
    const { state, log } = replayVerified(body.session, body.log);
    const command: Command = { k: "controls", at: log.tick, patch: body.patch };
    applyCommand(state, command);
    return json({ command, log: { ...log, commands: [...log.commands, command] }, state: stateSummary(state) });
  } catch (e) {
    return errorResponse(e, "demo/controls");
  }
}
