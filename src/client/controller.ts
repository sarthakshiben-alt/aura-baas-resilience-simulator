import { DEFAULT_SEED, DEFAULT_SPEED } from "@/lib/client-shared";
import { createInitialState, step } from "@/lib/sim/engine";
import type { ControlsPatch, Incident, InvestigationMode, SimState } from "@/lib/sim/types";
import { applyCommand, CommandError, insertCommand, replay, type Command, type SimLog } from "@/lib/sim/workflow";
import { getGolden } from "@/lib/golden/dataset";
import { SCENARIOS } from "@/lib/sim/scenarios";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import { fmtSimTime } from "@/lib/utils";
import { goldenCommands } from "@/lib/golden/harness";
import { incidentMetrics, type RunMetrics } from "@/lib/comparison/metrics";
import type { AssistantAnswer } from "@/lib/ai/assistant";
import type { PairedRunResult } from "@/lib/comparison/paired";
import type { BenchmarkResult } from "@/lib/comparison/benchmark";
import { api, ApiError, type PublicAiStatus } from "./api";

export interface Notice {
  id: number;
  kind: "info" | "success" | "warn" | "error";
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
  workflow: string | null;
  triageSeconds: number;
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
  pendingInvestigations = new Map<string, { requestedAt: number; startedWall: number; mode: InvestigationMode; readyAt: number | null; triageSeconds: number; auto: boolean }>();
  /** ASSUMED minutes for an on-call engineer to triage manually when AI is OFF (0 = automated rules). */
  manualTriageMinutes = 10;
  /** Start the investigation automatically when monitoring opens an incident (models the page / AI auto-triage). */
  autoInvestigate = true;
  private autoStarted = new Set<string>();
  investigationErrors = new Map<string, string>();
  busyRecs = new Set<string>();
  notices: Notice[] = [];
  chats = new Map<string, ChatMessage[]>();
  interactiveRuns: InteractiveRun[] = [];
  /** Guided demo step (null = free exploration). */
  guideStep: number | null = null;
  paired: { loading: boolean; error: string | null; result: (PairedRunResult & { id: string }) | null } = { loading: false, error: null, result: null };
  /** Wall-clock ms until which AI calls are expected to be rate-limited (free-tier provider budget). */
  aiCooldownUntil = 0;
  aiCooldownLeftS() {
    return Math.max(0, Math.ceil((this.aiCooldownUntil - Date.now()) / 1000));
  }
  clearPairedError() {
    if (this.paired.error) {
      this.paired = { ...this.paired, error: null };
      this.emit();
    }
  }
  /** Latest paired result per golden scenario, so switching scenarios doesn't re-run (and re-bill) the AI. */
  pairedByGolden: Record<string, PairedRunResult & { id: string }> = {};
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
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => this.save());
    api
      .catalog()
      .then((c) => {
        this.aiStatus = c.ai;
        this.emit();
      })
      .catch(() => {});
    if (!this.restore()) await this.reset({ announce: false });
    this.ready = true;
    this.start();
    this.emit();
  }

  save() {
    this.lastSave = Date.now();
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ session: this.session, sessionId: this.sessionId, log: { ...this.log, tick: this.state.tick }, speed: this.speed, aiMode: this.aiMode, goldenId: this.goldenId, runs: this.interactiveRuns, triage: this.manualTriageMinutes, autoInvestigate: this.autoInvestigate, autoStarted: [...this.autoStarted] }));
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
      if (typeof s.triage === "number") this.manualTriageMinutes = s.triage;
      if (typeof s.autoInvestigate === "boolean") this.autoInvestigate = s.autoInvestigate;
      if (Array.isArray(s.autoStarted)) this.autoStarted = new Set(s.autoStarted);
      this.rebuild();
      for (const i of this.state.incidents) if (i.status === "resolved") this.resolvedSeen.add(i.id);
      return true;
    } catch {
      return false;
    }
  }

  async reset(opts: { goldenId?: string | null; announce?: boolean } = {}) {
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
    this.autoStarted.clear();
    this.applyDue();
    this.save();
    if (gs) {
      const at = gs.trigger.script[0]?.at ?? 0;
      this.notify("success", `📦 Loaded ${gs.id} — ${gs.title}. Reset to its starting conditions; the incident triggers automatically at ${fmtSimTime(at)} (sim clock).`);
    } else if (opts.announce !== false) {
      this.notify("success", "🧹 Fresh start — all services back to healthy.");
    }
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
    this.save();
    this.emit();
  }
  setGuideStep(step: number | null) {
    this.guideStep = step;
    this.emit();
  }
  setManualTriageMinutes(m: number) {
    this.manualTriageMinutes = Math.max(0, Math.min(30, m));
    this.save();
    this.emit();
  }
  setAutoInvestigate(v: boolean) {
    this.autoInvestigate = v;
    this.save();
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
    if (this.autoInvestigate && this.session) {
      for (const inc of this.state.incidents) {
        if (inc.status === "resolved" || inc.investigations.length || this.autoStarted.has(inc.id) || this.pendingInvestigations.has(inc.id)) continue;
        this.autoStarted.add(inc.id);
        void this.investigate(inc.id, true);
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
      workflow: inc.investigations[0]?.workflow ?? null,
      triageSeconds: inc.investigations[0]?.assumedTriageSeconds ?? 0,
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
    this.save(); // persist command-log changes immediately (survives reloads)
    this.emit();
  }

  snapshotLog(): SimLog {
    const tick = this.state.tick;
    return { v: 1, seed: this.log.seed, tick, commands: this.log.commands.filter((c) => c.at <= tick) };
  }

  startScenario(scenarioId: string, target: string | null) {
    const before = this.state.scenarioRuns.length;
    this.addCommand({ k: "start", at: this.state.tick, scenarioId, target });
    if (this.state.scenarioRuns.length > before) {
      const def = SCENARIOS[scenarioId];
      const who = target && target in ENTITY_PROFILES ? ENTITY_PROFILES[target as keyof typeof ENTITY_PROFILES].name : null;
      this.notify(
        "success",
        def?.kind === "recovery"
          ? `🩹 Recovery triggered${who ? ` for ${who}` : ""}: its downstream returns to normal over ~15 s.`
          : def?.generate
            ? `🎲 Triggered: ${def.label}. Something just went wrong somewhere — head to the Overview and see if you can work out what.`
            : `🚀 Triggered: ${def?.label ?? scenarioId}${who ? ` on ${who}` : ""}. Watch the Overview — monitoring should detect it within seconds.`,
      );
    }
  }
  stopRun(runId: string) {
    const run = this.state.scenarioRuns.find((r) => r.id === runId);
    this.addCommand({ k: "stop", at: this.state.tick, runId });
    if (run?.stoppedAt !== null) this.notify("success", `✋ Stopped: ${run?.label ?? runId}. Metrics ramp back to baseline.`);
  }
  setControls(patch: ControlsPatch) {
    this.addCommand({ k: "controls", at: this.state.tick, patch });
    this.notify("success", "🛡️ Protection settings updated.");
  }
  /** True while a run of this scenario on this target is still perturbing the system. */
  isScenarioActive(scenarioId: string, target: string | null): boolean {
    const t = this.state.tick;
    return this.state.scenarioRuns.some(
      (r) => r.scenarioId === scenarioId && (!!SCENARIOS[scenarioId]?.generate || (r.targetEntityId ?? null) === (target ?? null)) && r.stoppedAt === null && r.perturbations.some((p) => (p.endAt === null || p.endAt > t) && (p.plannedEndAt === null || p.plannedEndAt > t)),
    );
  }

  // ------------------------------------------------------------ server workflow

  private requireSession(): string | null {
    if (!this.session) {
      this.notify("error", "No server session. Reset the scenario to reconnect.");
      return null;
    }
    return this.session;
  }

  async investigate(incidentId: string, auto = false) {
    const session = this.requireSession();
    if (!session || this.pendingInvestigations.has(incidentId)) return;
    const log = this.snapshotLog();
    const mode = this.aiMode;
    // Manual triage applies to the FIRST conventional investigation only (the engineer is engaged afterwards).
    const inc = this.state.incidents.find((i) => i.id === incidentId);
    const triageMinutes = mode === "ai_off" && !inc?.investigations.length ? this.manualTriageMinutes : 0;
    this.pendingInvestigations.set(incidentId, { requestedAt: log.tick, startedWall: Date.now(), mode, readyAt: null, triageSeconds: Math.round(triageMinutes * 60), auto });
    this.investigationErrors.delete(incidentId);
    this.emit();
    try {
      const r = await api.investigate(session, log, incidentId, mode, mode === "ai_on" ? this.aiFault : null, this.speed, triageMinutes);
      if (this.session !== session) return; // reset while in flight
      const pend = this.pendingInvestigations.get(incidentId);
      if (pend) pend.readyAt = r.signed.entry.applyAt;
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
      const result = await api.paired(session, body);
      this.paired = { loading: false, error: null, result };
      // Free-tier provider budget (Groq: ~8k tokens/min, refilled continuously): wait for what this run spent.
      const used = result.on.metrics.tokens ?? 0;
      if (used > 0) this.aiCooldownUntil = Date.now() + Math.min(60, Math.ceil((used / 8000) * 60)) * 1000;
      if (result.on.metrics.errorCategory === "rate_limited") this.aiCooldownUntil = Date.now() + 40_000;
      if (typeof body.goldenId === "string") this.pairedByGolden = { ...this.pairedByGolden, [body.goldenId]: result };
    } catch (e) {
      // Back off before any automatic retry: the server's own retry-after on 429, otherwise 15 s.
      this.aiCooldownUntil = Date.now() + (e instanceof ApiError && e.status === 429 ? (e.retryAfterS ?? 30) : 15) * 1000;
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
