import { DEFAULT_SEED, DEFAULT_SPEED } from "@/lib/client-shared";
import { createInitialState, step } from "@/lib/sim/engine";
import type { ControlsPatch, Incident, InvestigationMode, SimState } from "@/lib/sim/types";
import { applyCommand, CommandError, insertCommand, replay, type Command, type SimLog } from "@/lib/sim/workflow";
import { getGolden } from "@/lib/golden/dataset";
import { goldenCommands } from "@/lib/golden/harness";
import { incidentMetrics, type RunMetrics } from "@/lib/comparison/metrics";
import type { AssistantAnswer } from "@/lib/ai/assistant";
import type { PairedRunResult } from "@/lib/comparison/paired";
import type { BenchmarkResult } from "@/lib/comparison/benchmark";
import { api, ApiError, type PublicAiStatus } from "./api";

export interface Notice {
  id: number;
  kind: "info" | "warn" | "error";
  text: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  answer?: AssistantAnswer & { atSimSecond: number };
  pending?: boolean;
}

export interface InteractiveRun {
  key: string;
  sessionId: string;
  incidentId: string;
  scenarioLabel: string;
  mode: InvestigationMode | "none";
  speed: number;
  metrics: RunMetrics;
  diagnosisSource: string | null;
  completedAt: number;
}

const STORAGE_KEY = "aura-sim-session-v1";
const MAX_RUNS = 30;

/**
 * Browser-side controller. Runs the SAME deterministic engine as the server,
 * holds the command log, and inserts server-signed workflow entries at their
 * exact ticks (rewinding + replaying when an entry lands in the past).
 */
export class SimController {
  session: string | null = null;
  sessionId: string | null = null;
  log: SimLog = { v: 1, seed: DEFAULT_SEED, tick: 0, commands: [] };
  state: SimState = createInitialState({ seed: DEFAULT_SEED });
  speed = DEFAULT_SPEED;
  running = false;
  ready = false;
  aiMode: InvestigationMode = "ai_on";
  aiFault: "timeout" | "malformed" | null = null;
  aiStatus: PublicAiStatus | null = null;
  goldenId: string | null = null;
  pendingInvestigations = new Map<string, { requestedAt: number; startedWall: number; mode: InvestigationMode }>();
  investigationErrors = new Map<string, string>();
  busyRecs = new Set<string>();
  notices: Notice[] = [];
  chats = new Map<string, ChatMessage[]>();
  interactiveRuns: InteractiveRun[] = [];
  /** Guided demo step (null = free exploration). */
  guideStep: number | null = null;
  paired: { loading: boolean; error: string | null; result: (PairedRunResult & { id: string }) | null } = { loading: false, error: null, result: null };
  benchmark: { loading: boolean; error: string | null; result: (BenchmarkResult & { id: string }) | null } = { loading: false, error: null, result: null };
  version = 0;

  private applied = new WeakSet<Command>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private carry = 0;
  private noticeSeq = 0;
  private lastSave = 0;
  private resolvedSeen = new Set<string>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  emit() {
    this.version += 1;
    for (const l of this.listeners) l();
    if (typeof window !== "undefined" && Date.now() - this.lastSave > 1500) this.save();
  }

  notify(kind: Notice["kind"], text: string) {
    const id = ++this.noticeSeq;
    this.notices = [...this.notices.slice(-3), { id, kind, text }];
    this.emit();
    setTimeout(() => {
      this.notices = this.notices.filter((n) => n.id !== id);
      this.emit();
    }, kind === "error" ? 9000 : 6000);
  }

  // ------------------------------------------------------------ lifecycle

  async init() {
    api
      .catalog()
      .then((c) => {
        this.aiStatus = c.ai;
        this.emit();
      })
      .catch(() => {});
    if (!this.restore()) await this.reset();
    this.ready = true;
    this.start();
    this.emit();
  }

  private save() {
    this.lastSave = Date.now();
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ session: this.session, sessionId: this.sessionId, log: { ...this.log, tick: this.state.tick }, speed: this.speed, aiMode: this.aiMode, goldenId: this.goldenId, runs: this.interactiveRuns }));
    } catch {
      /* storage unavailable: per-viewer convenience only */
    }
  }

  private restore(): boolean {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
      if (!s.session || !s.log) return false;
      this.session = s.session;
      this.sessionId = s.sessionId;
      this.log = s.log;
      this.speed = s.speed ?? DEFAULT_SPEED;
      this.aiMode = s.aiMode === "ai_off" ? "ai_off" : "ai_on";
      this.goldenId = s.goldenId ?? null;
      this.interactiveRuns = Array.isArray(s.runs) ? s.runs : [];
      this.rebuild();
      for (const i of this.state.incidents) if (i.status === "resolved") this.resolvedSeen.add(i.id);
      return true;
    } catch {
      return false;
    }
  }

  async reset(opts: { goldenId?: string | null } = {}) {
    const gs = opts.goldenId ? getGolden(opts.goldenId) : null;
    const seed = gs?.initialConditions.seed ?? DEFAULT_SEED;
    try {
      const r = await api.reset(seed);
      this.session = r.session;
      this.sessionId = r.sessionId;
    } catch (e) {
      this.session = null;
      this.notify("error", `Could not start a server session (${(e as Error).message}). The simulator still runs; AI and approvals need the server.`);
    }
    this.goldenId = gs?.id ?? null;
    this.log = { v: 1, seed, tick: 0, commands: gs ? goldenCommands(gs) : [] };
    this.state = createInitialState({ seed });
    this.applied = new WeakSet();
    this.carry = 0;
    this.pendingInvestigations.clear();
    this.investigationErrors.clear();
    this.busyRecs.clear();
    this.chats.clear();
    this.resolvedSeen.clear();
    this.applyDue();
    this.save();
    this.emit();
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => this.loop(), 200);
    this.emit();
  }
  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.emit();
  }
  setSpeed(s: number) {
    this.speed = s;
    this.emit();
  }
  setAiMode(m: InvestigationMode) {
    this.aiMode = m;
    this.emit();
  }
  setGuideStep(step: number | null) {
    this.guideStep = step;
    this.emit();
  }
  setAiFault(f: "timeout" | "malformed" | null) {
    this.aiFault = f;
    this.emit();
  }

  private loop() {
    this.carry += this.speed * 0.2;
    const n = Math.floor(this.carry);
    this.carry -= n;
    if (n > 0) this.advance(n);
  }

  advance(n: number) {
    for (let i = 0; i < n; i++) {
      if (this.state.tick >= this.state.config.maxTicks) {
        this.pause();
        this.notify("warn", "Session limit reached (2 simulated hours). Reset the scenario to continue.");
        break;
      }
      step(this.state);
      this.log.tick = this.state.tick;
      this.applyDue();
    }
    this.afterTicks();
    this.emit();
  }

  private afterTicks() {
    for (const inc of this.state.incidents) {
      if (inc.status === "resolved" && !this.resolvedSeen.has(inc.id)) {
        this.resolvedSeen.add(inc.id);
        this.recordRun(inc);
        if (this.session) api.sync(this.session, this.snapshotLog()).catch(() => {});
      }
    }
    for (const [id, p] of this.pendingInvestigations) {
      const inc = this.state.incidents.find((i) => i.id === id);
      if (inc && inc.investigations.some((iv) => iv.requestedAt === p.requestedAt)) this.pendingInvestigations.delete(id);
    }
  }

  private recordRun(inc: Incident) {
    const labels = inc.scenarioRunIds.map((r) => this.state.scenarioRuns.find((x) => x.id === r)).filter(Boolean).map((r) => `${r!.label}${r!.targetEntityId ? ` (${r!.targetEntityId.replace("partner-", "").toUpperCase()})` : ""}`);
    const run: InteractiveRun = {
      key: `${this.sessionId}:${inc.id}`,
      sessionId: this.sessionId ?? "local",
      incidentId: inc.id,
      scenarioLabel: (this.goldenId ? `${this.goldenId} · ` : "") + (labels.join(" + ") || "Ad-hoc"),
      mode: inc.investigationMode ?? "none",
      speed: this.speed,
      metrics: incidentMetrics(this.state, inc, inc.startedAt),
      diagnosisSource: inc.investigations[0]?.source ?? null,
      completedAt: Date.now(),
    };
    this.interactiveRuns = [...this.interactiveRuns.filter((r) => r.key !== run.key), run].slice(-MAX_RUNS);
  }

  // ------------------------------------------------------------ commands

  /** Apply every not-yet-applied command scheduled for the current tick. */
  private applyDue() {
    for (const cmd of [...this.log.commands]) {
      if (cmd.at > this.state.tick) break;
      if (this.applied.has(cmd)) continue;
      if (cmd.at < this.state.tick) {
        this.applied.add(cmd);
        continue;
      }
      try {
        applyCommand(this.state, cmd);
        this.applied.add(cmd);
      } catch (e) {
        this.log.commands = this.log.commands.filter((c) => c !== cmd);
        this.notify("error", `Command rejected by the simulator: ${(e as Error).message}`);
      }
    }
  }

  /** Rebuild state from the log up to the current tick (deterministic replay). */
  private rebuild() {
    const tick = this.log.tick;
    const applied = this.log.commands.filter((c) => c.at <= tick);
    this.state = replay({ ...this.log, tick, commands: applied });
    this.applied = new WeakSet(applied);
  }

  private addCommand(cmd: Command) {
    const prevCommands = this.log.commands;
    this.log.commands = insertCommand(this.log.commands, cmd);
    if (cmd.at < this.state.tick) {
      try {
        this.rebuild();
      } catch (e) {
        this.log.commands = prevCommands;
        this.rebuild();
        this.notify("error", `Could not apply server entry: ${(e as Error).message}`);
      }
    } else {
      this.applyDue();
    }
    this.afterTicks();
    this.emit();
  }

  snapshotLog(): SimLog {
    const tick = this.state.tick;
    return { v: 1, seed: this.log.seed, tick, commands: this.log.commands.filter((c) => c.at <= tick) };
  }

  startScenario(scenarioId: string, target: string | null) {
    this.addCommand({ k: "start", at: this.state.tick, scenarioId, target });
  }
  stopRun(runId: string) {
    this.addCommand({ k: "stop", at: this.state.tick, runId });
  }
  setControls(patch: ControlsPatch) {
    this.addCommand({ k: "controls", at: this.state.tick, patch });
  }

  // ------------------------------------------------------------ server workflow

  private requireSession(): string | null {
    if (!this.session) {
      this.notify("error", "No server session. Reset the scenario to reconnect.");
      return null;
    }
    return this.session;
  }

  async investigate(incidentId: string) {
    const session = this.requireSession();
    if (!session || this.pendingInvestigations.has(incidentId)) return;
    const log = this.snapshotLog();
    const mode = this.aiMode;
    this.pendingInvestigations.set(incidentId, { requestedAt: log.tick, startedWall: Date.now(), mode });
    this.investigationErrors.delete(incidentId);
    this.emit();
    try {
      const r = await api.investigate(session, log, incidentId, mode, mode === "ai_on" ? this.aiFault : null, this.speed);
      if (this.session !== session) return; // reset while in flight
      this.addCommand({ k: "entry", at: r.signed.entry.applyAt, signed: r.signed });
    } catch (e) {
      if (this.session !== session) return;
      this.pendingInvestigations.delete(incidentId);
      const msg = e instanceof ApiError ? e.message : "Investigation request failed";
      this.investigationErrors.set(incidentId, msg);
      this.notify("error", `Investigation failed: ${msg}. The simulation and gateway protections are unaffected.`);
    }
  }

  async decide(incidentId: string, recommendationId: string, decision: "approve" | "reject" | "cancel") {
    const session = this.requireSession();
    if (!session || this.busyRecs.has(recommendationId)) return;
    this.busyRecs.add(recommendationId);
    this.emit();
    try {
      const r = await api.decide(session, this.snapshotLog(), incidentId, recommendationId, decision);
      if (this.session !== session) return;
      this.addCommand({ k: "entry", at: r.signed.entry.applyAt, signed: r.signed });
    } catch (e) {
      this.notify("error", e instanceof ApiError ? e.message : "Decision failed");
    } finally {
      this.busyRecs.delete(recommendationId);
      this.emit();
    }
  }

  async runPaired(body: Record<string, unknown>) {
    const session = this.requireSession();
    if (!session || this.paired.loading) return;
    this.paired = { ...this.paired, loading: true, error: null };
    this.emit();
    try {
      this.paired = { loading: false, error: null, result: await api.paired(session, body) };
    } catch (e) {
      this.paired = { ...this.paired, loading: false, error: e instanceof ApiError ? e.message : "Comparison failed" };
    }
    this.emit();
  }

  async runBenchmark() {
    const session = this.requireSession();
    if (!session || this.benchmark.loading) return;
    this.benchmark = { ...this.benchmark, loading: true, error: null };
    this.emit();
    try {
      this.benchmark = { loading: false, error: null, result: await api.benchmark(session) };
    } catch (e) {
      this.benchmark = { ...this.benchmark, loading: false, error: e instanceof ApiError ? e.message : "Benchmark failed" };
    }
    this.emit();
  }

  async ask(incidentId: string | null, question: string) {
    const session = this.requireSession();
    if (!session) return;
    const key = incidentId ?? "platform";
    const thread = [...(this.chats.get(key) ?? []), { role: "user" as const, text: question }, { role: "assistant" as const, text: "", pending: true }];
    this.chats.set(key, thread);
    this.emit();
    try {
      const a = await api.ask(session, this.snapshotLog(), incidentId, question, this.aiMode === "ai_on");
      thread[thread.length - 1] = { role: "assistant", text: a.answer, answer: a };
    } catch (e) {
      thread[thread.length - 1] = { role: "assistant", text: e instanceof ApiError ? e.message : "The assistant could not answer." };
    }
    this.chats.set(key, [...thread]);
    this.emit();
  }
}

export function isCommandError(e: unknown): e is CommandError {
  return e instanceof CommandError;
}
