-- Records HOW each investigation was performed, so manual-runbook, automated-rules
-- and AI-assisted results are never conflated. Additive, non-destructive.
alter table public.investigations
  add column if not exists workflow text not null default 'automated_rules'
    check (workflow in ('manual_runbook','automated_rules','ai_assisted')),
  add column if not exists assumed_triage_seconds integer not null default 0
    check (assumed_triage_seconds >= 0);

-- An assumed manual triage time only exists for the manual-runbook workflow.
alter table public.investigations
  drop constraint if exists investigations_triage_only_manual;
alter table public.investigations
  add constraint investigations_triage_only_manual
    check (assumed_triage_seconds = 0 or workflow = 'manual_runbook');

alter table public.comparison_runs
  add column if not exists workflow text
    check (workflow is null or workflow in ('manual_runbook','automated_rules','ai_assisted'));
