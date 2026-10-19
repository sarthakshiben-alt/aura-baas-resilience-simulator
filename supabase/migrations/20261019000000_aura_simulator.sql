-- Aura BaaS Resilience Simulator — schema
-- ALL DATA IN THESE TABLES IS SYNTHETIC / SIMULATED. No real banking data.
--
-- Access model:
--   * Every table has Row Level Security enabled.
--   * anon / authenticated roles get NO privileges and NO policies on session
--     data → deny by default. The browser never talks to these tables.
--   * The Next.js server writes and reads with the service-role key (which
--     bypasses RLS) only after validating a server-issued, HMAC-signed session.
--   * golden_scenarios is public synthetic reference data: read-only for anon.
--
-- Simulated times are stored as *_sim_s integers (simulated seconds since the
-- session baseline, 1 tick = 1 s). Wall-clock times are timestamptz.

create table if not exists public.incidents (
  id                       text primary key,               -- "<session_id>:<incident_ref>"
  session_id               text not null,
  incident_ref             text not null,                  -- e.g. INC-001 (unique per session)
  scenario_id              text,
  partner_id               text not null,                  -- primary affected entity
  affected_entity_ids      text[] not null default '{}',
  severity                 text not null check (severity in ('low','medium','high','critical')),
  status                   text not null check (status in ('open','investigating','mitigating','monitoring','resolved')),
  started_at_sim_s         integer not null check (started_at_sim_s >= 0),
  detected_at_sim_s        integer not null check (detected_at_sim_s >= started_at_sim_s),
  diagnosed_at_sim_s       integer,
  recommendation_at_sim_s  integer,
  recovered_at_sim_s       integer,
  investigation_mode       text check (investigation_mode in ('ai_on','ai_off')),
  recovery_verified        boolean not null default false,
  retail_breach_seconds    integer not null default 0,
  created_at               timestamptz not null default now(),
  unique (session_id, incident_ref)
);
create index if not exists incidents_session_idx on public.incidents (session_id, created_at desc);

create table if not exists public.telemetry_snapshots (
  id                       text primary key,
  session_id               text not null,
  incident_id              text not null references public.incidents(id) on delete cascade,
  t_sim_s                  integer not null,
  partner_id               text not null,                  -- partner id or 'retail'
  request_rate             double precision not null,      -- requests per second
  p50_latency_ms           double precision,
  p95_latency_ms           double precision,
  p99_latency_ms           double precision,
  error_rate               double precision not null check (error_rate between 0 and 1),
  in_flight_requests       double precision not null,
  concurrency_limit        integer,
  resource_utilisation     double precision not null check (resource_utilisation between 0 and 1),
  circuit_breaker_state    text not null check (circuit_breaker_state in ('closed','open','half_open')),
  retail_p95_latency_ms    double precision,
  retail_health            text not null check (retail_health in ('healthy','at_risk','breach')),
  health_status            text not null check (health_status in ('healthy','degraded','protected','recovering','unavailable')),
  created_at               timestamptz not null default now()
);
create index if not exists telemetry_incident_idx on public.telemetry_snapshots (incident_id, t_sim_s);

create table if not exists public.investigations (
  id                       text primary key,
  session_id               text not null,
  incident_id              text not null references public.incidents(id) on delete cascade,
  provider                 text not null,
  model                    text,
  source                   text not null check (source in ('llm','rule_based_fallback','rule_based')),
  mode                     text not null check (mode in ('ai_on','ai_off')),
  status                   text not null check (status in ('succeeded','fallback','failed')),
  started_at               timestamptz not null,
  completed_at             timestamptz not null,
  latency_ms               integer not null check (latency_ms >= 0),
  llm_latency_ms           integer,
  requested_at_sim_s       integer not null,
  applied_at_sim_s         integer not null,
  attempts                 integer not null default 0,
  total_tokens             integer,
  diagnosis_json           jsonb not null,
  error_category           text,
  fallback_used            boolean not null default false,
  fault_injected           text check (fault_injected in ('timeout','malformed')),
  created_at               timestamptz not null default now(),
  -- A fallback can never be stored as an LLM result.
  constraint investigations_source_consistent check (not (source = 'llm' and fallback_used))
);
create index if not exists investigations_incident_idx on public.investigations (incident_id, requested_at_sim_s);

create table if not exists public.recommendations (
  id                       text primary key,
  session_id               text not null,
  incident_id              text not null references public.incidents(id) on delete cascade,
  investigation_id         text not null references public.investigations(id) on delete cascade,
  action_id                text not null,
  target_entity_id         text,
  rationale                text not null,
  source                   text not null check (source in ('llm','rule_based_fallback','rule_based')),
  validation_status        text not null check (validation_status in ('valid','valid_with_warnings','rejected')),
  validation_json          jsonb not null,
  approval_status          text not null check (approval_status in ('pending','approved','rejected','cancelled','superseded','expired','not_approvable')),
  decided_by               text check (decided_by in ('human','simulated_operator')),
  approved_at              timestamptz,
  rejected_at              timestamptz,
  decided_at_sim_s         integer,
  executed_at_sim_s        integer,
  execution_outcome        text,
  created_at               timestamptz not null default now(),
  -- Policy-rejected recommendations can never be approved or executed.
  constraint recommendations_rejected_not_approved check (not (validation_status = 'rejected' and (approval_status = 'approved' or executed_at_sim_s is not null)))
);
create index if not exists recommendations_incident_idx on public.recommendations (incident_id);

create table if not exists public.action_audit_logs (
  id                       text primary key,
  session_id               text not null,
  incident_id              text not null references public.incidents(id) on delete cascade,
  recommendation_id        text not null references public.recommendations(id) on delete cascade,
  action_id                text not null,
  target_entity_id         text,
  actor_type               text not null check (actor_type in ('human','simulated_operator','system')),
  outcome                  text not null check (outcome in ('approved','rejected','cancelled','executed','blocked','verified')),
  before_state             jsonb,
  after_state              jsonb,
  t_sim_s                  integer not null,
  "timestamp"              timestamptz,                    -- wall-clock time of a human/operator decision
  note                     text,
  recorded_at              timestamptz not null default now()
);
create index if not exists audit_incident_idx on public.action_audit_logs (incident_id, t_sim_s);

create table if not exists public.comparison_runs (
  id                       uuid primary key,
  pair_id                  uuid not null,                  -- groups the AI OFF and AI ON rows of one paired run
  session_id               text not null,
  kind                     text not null check (kind in ('paired','benchmark')),
  scenario_id              text,
  mode                     text not null check (mode in ('ai_off','ai_on','benchmark')),
  seed                     integer not null,
  started_at               timestamptz not null,
  completed_at             timestamptz not null,
  metrics_json             jsonb not null,
  result_json              jsonb,
  created_at               timestamptz not null default now()
);
create index if not exists comparison_runs_session_idx on public.comparison_runs (session_id, pair_id);

create table if not exists public.golden_scenarios (
  id                       text primary key,               -- GS-01 …
  title                    text not null,
  description              text not null,
  definition               jsonb not null,
  synthetic                boolean not null default true check (synthetic),
  updated_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
alter table public.incidents            enable row level security;
alter table public.telemetry_snapshots  enable row level security;
alter table public.investigations       enable row level security;
alter table public.recommendations      enable row level security;
alter table public.action_audit_logs    enable row level security;
alter table public.comparison_runs      enable row level security;
alter table public.golden_scenarios     enable row level security;

-- Session data: no access for browser roles (no grants, no policies).
revoke all on public.incidents, public.telemetry_snapshots, public.investigations,
  public.recommendations, public.action_audit_logs, public.comparison_runs
  from anon, authenticated;

-- Public synthetic reference data: read-only.
revoke all on public.golden_scenarios from anon, authenticated;
grant select on public.golden_scenarios to anon, authenticated;
drop policy if exists "golden scenarios are public synthetic reference data" on public.golden_scenarios;
create policy "golden scenarios are public synthetic reference data"
  on public.golden_scenarios for select to anon, authenticated using (true);

-- Server writes use the service_role (bypasses RLS) via the Next.js backend only.
grant all on public.incidents, public.telemetry_snapshots, public.investigations,
  public.recommendations, public.action_audit_logs, public.comparison_runs, public.golden_scenarios
  to service_role;
