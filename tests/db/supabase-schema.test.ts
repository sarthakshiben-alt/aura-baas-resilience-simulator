/**
 * Applies the real migration + seed to a local PostgreSQL with Supabase-style
 * roles, then verifies RLS and that the server's row shapes match the schema.
 * Requires TEST_DATABASE_URL (see scripts/pg-test.sh); skipped otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildBundle } from "@/lib/server/persistence";
import { ScriptedRunner } from "@/lib/golden/harness";
import { getGolden } from "@/lib/golden/dataset";
import { buildIncidentContext } from "@/lib/ai/context";
import { ruleBasedDiagnosis } from "@/lib/ai/rules";
import { applyCommand, type WorkflowEntry } from "@/lib/sim/workflow";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const DB = `aura_test_${Date.now()}`;

d("Supabase schema, RLS and row shapes (local PostgreSQL)", () => {
  let admin: pg.Client;
  let db: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${DB}`);
    db = new pg.Client({ connectionString: url!.replace(/\/[^/]*$/, `/${DB}`) });
    await db.connect();
    // Supabase role stubs
    await db.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      grant usage on schema public to anon, authenticated, service_role;`);
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    for (const f of readdirSync(dir).sort()) await db.query(readFileSync(path.join(dir, f), "utf8"));
    await db.query(readFileSync(path.resolve(__dirname, "../../supabase/seed.sql"), "utf8"));
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`drop database if exists ${DB} with (force)`);
    await admin?.end();
  });

  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await db.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.query("reset role");
    }
  }

  function bundle() {
    const r = new ScriptedRunner(getGolden("GS-01")!);
    r.advanceUntil((s) => s.incidents.length > 0, 100);
    r.advance(15);
    const inc = r.state.incidents[0];
    const diag = ruleBasedDiagnosis(buildIncidentContext(r.state, inc.id));
    const e: WorkflowEntry = { kind: "investigation", entryId: "INV-db", sessionId: "sess-1", incidentId: inc.id, requestedAt: r.state.tick, applyAt: r.state.tick, data: { mode: "ai_off", workflow: "automated_rules", assumedTriageSeconds: 0, source: "rule_based", status: "succeeded", provider: "rules", model: null, latencyMs: 1, llmLatencyMs: null, startedAtWallMs: Date.now(), completedAtWallMs: Date.now(), firstResponseMs: null, attempts: 0, errorCategory: null, llmError: null, usage: null, fallbackUsed: false, faultInjected: null, validationNotes: [], diagnosis: diag, speed: 1 } };
    r.apply({ k: "entry", at: r.state.tick, signed: { entry: e, sig: "x" } });
    const rec = inc.recommendations.find((x) => x.actionId === "escalate_to_partner")!;
    const dec: WorkflowEntry = { kind: "decision", entryId: "DEC-db", sessionId: "sess-1", incidentId: inc.id, recommendationId: rec.id, decision: "approve", applyAt: r.state.tick, wallMs: Date.now(), actor: "human" };
    applyCommand(r.state, { k: "entry", at: r.state.tick, signed: { entry: dec, sig: "x" } });
    r.advance(200);
    return buildBundle("sess-1", r.state);
  }

  async function insertRows(table: string, rows: Record<string, unknown>[]) {
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        const v = row[c];
        return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && table !== "incidents" ? JSON.stringify(v) : v;
      });
      await db.query(`insert into public.${table} (${cols.map((c) => `"${c}"`).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) on conflict (id) do nothing`, vals);
    }
  }

  it("server row shapes match the migration (service role can write a full incident bundle)", async () => {
    const b = bundle();
    expect(b.incidents.length).toBe(1);
    expect(b.action_audit_logs.length).toBeGreaterThan(0);
    await as("service_role", async () => {
      await insertRows("incidents", b.incidents);
      await insertRows("investigations", b.investigations);
      await insertRows("recommendations", b.recommendations);
      await insertRows("action_audit_logs", b.action_audit_logs);
      await insertRows("telemetry_snapshots", b.telemetry_snapshots);
    });
    const c = await db.query("select count(*)::int n from public.action_audit_logs");
    expect(c.rows[0].n).toBeGreaterThanOrEqual(2);
    const inc = await db.query("select recovery_verified, status from public.incidents");
    expect(inc.rows[0]).toEqual({ recovery_verified: true, status: "resolved" });
  });

  it("25. anonymous visitors cannot read or modify privileged records", async () => {
    for (const t of ["incidents", "investigations", "recommendations", "action_audit_logs", "telemetry_snapshots", "comparison_runs"]) {
      await expect(as("anon", () => db.query(`select * from public.${t} limit 1`))).rejects.toThrow(/permission denied/);
      await expect(as("authenticated", () => db.query(`select * from public.${t} limit 1`))).rejects.toThrow(/permission denied/);
    }
    await expect(as("anon", () => db.query(`insert into public.incidents (id, session_id, incident_ref, partner_id, severity, status, started_at_sim_s, detected_at_sim_s) values ('x','x','INC-999','partner-a','low','open',0,0)`))).rejects.toThrow(/permission denied/);
    await expect(as("anon", () => db.query(`delete from public.incidents`))).rejects.toThrow(/permission denied/);
    // RLS is enabled on every table (defence in depth even if grants were added by mistake)
    const r = await db.query(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'`);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    // Even with an accidental grant, RLS with no policy returns zero rows
    await db.query("grant select on public.incidents to anon");
    const leaked = await as("anon", () => db.query("select * from public.incidents"));
    expect(leaked.rowCount).toBe(0);
    await db.query("revoke select on public.incidents from anon");
  });

  it("golden scenarios are public, read-only synthetic reference data", async () => {
    const r = await as("anon", () => db.query("select id, synthetic from public.golden_scenarios order by id"));
    expect(r.rowCount).toBeGreaterThanOrEqual(12);
    expect(r.rows.every((x) => x.synthetic)).toBe(true);
    await expect(as("anon", () => db.query("update public.golden_scenarios set title='x'"))).rejects.toThrow(/permission denied/);
  });

  it("constraints prevent a fallback being stored as an LLM result and rejected actions being approved", async () => {
    await expect(
      as("service_role", () =>
        db.query(`insert into public.investigations (id, session_id, incident_id, provider, source, mode, status, started_at, completed_at, latency_ms, requested_at_sim_s, applied_at_sim_s, diagnosis_json, fallback_used)
                  select 'bad', session_id, id, 'x', 'llm', 'ai_on', 'succeeded', now(), now(), 1, 0, 0, '{}'::jsonb, true from public.incidents limit 1`),
      ),
    ).rejects.toThrow(/investigations_source_consistent/);
    await expect(
      as("service_role", () =>
        db.query(`update public.recommendations set validation_status='rejected', approval_status='approved' where id = (select id from public.recommendations limit 1)`),
      ),
    ).rejects.toThrow(/recommendations_rejected_not_approved/);
  });
});
