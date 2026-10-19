"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EntityId, SimState } from "@/lib/sim/types";
import { ENTITY_IDS } from "@/lib/sim/types";
import { ENTITY_PROFILES } from "@/lib/sim/config";
import { fmtSimTime } from "@/lib/utils";

/** Fixed categorical order: colour follows the entity, never its rank. */
export const ENTITY_COLOR: Record<EntityId, string> = {
  "partner-a": "var(--s1)",
  "partner-b": "var(--s2)",
  "partner-c": "var(--s3)",
  "partner-d": "var(--s4)",
  "partner-e": "var(--s5)",
  retail: "var(--s6)",
};

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

type Row = Record<string, number | null>;

function TooltipBox({ active, payload, label, unit, series }: { active?: boolean; payload?: { dataKey: string; value: number | null }[]; label?: number; unit: string; series: SeriesDef[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-surface px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 text-muted">t = {fmtSimTime(label ?? 0)} (sim)</div>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        const v = p?.value;
        return (
          <div key={s.key} className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: s.color }} />
            <span className="tabular font-semibold text-text">{v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}${unit}`}</span>
            <span className="text-muted">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TimeSeriesChart({
  data,
  series,
  unit = "",
  height = 220,
  log = false,
  refLines = [],
  domain,
  ariaLabel,
  yLabel,
}: {
  data: Row[];
  series: SeriesDef[];
  unit?: string;
  height?: number;
  log?: boolean;
  refLines?: { y: number; label: string; tone?: "critical" | "warning" | "muted" }[];
  domain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  ariaLabel: string;
  yLabel?: string;
}) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
          <XAxis dataKey="t" tickFormatter={(t) => fmtSimTime(t)} stroke="var(--axis)" tick={{ fontSize: 10, fill: "var(--muted)" }} minTickGap={40} />
          <YAxis
            scale={log ? "log" : "auto"}
            domain={domain ?? (log ? [100, "auto"] : [0, "auto"])}
            allowDataOverflow={log}
            stroke="var(--axis)"
            width={48}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v * 100) / 100}`)}
            label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 10, fill: "var(--muted)", textAnchor: "middle" } } : undefined}
          />
          <Tooltip content={<TooltipBox unit={unit} series={series} />} isAnimationActive={false} cursor={{ stroke: "var(--border-strong)" }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }} />
          {refLines.map((r) => (
            <ReferenceLine
              key={r.label}
              y={r.y}
              stroke={r.tone === "critical" ? "var(--critical)" : r.tone === "warning" ? "var(--warning)" : "var(--axis)"}
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
              label={{ value: r.label, position: "insideTopRight", fontSize: 10, fill: "var(--text-2)" }}
            />
          ))}
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "6 3" : undefined} dot={false} isAnimationActive={false} connectNulls={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function GroupedBarChart({ data, series, unit = "", height = 240, ariaLabel }: { data: Record<string, string | number | null>[]; series: SeriesDef[]; unit?: string; height?: number; ariaLabel: string }) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="metric" stroke="var(--axis)" tick={{ fontSize: 10, fill: "var(--muted)" }} interval={0} />
          <YAxis stroke="var(--axis)" width={44} tick={{ fontSize: 10, fill: "var(--muted)" }} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ fill: "var(--surface-2)" }}
            formatter={(v) => (v === null || v === undefined ? "N/A" : `${v}${unit}`)}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Builds chart rows for the last `window` simulated seconds. */
export function entityRows(state: SimState, field: "p95Ms" | "inFlight" | "errorRate" | "offeredRps", window = 180, ids: readonly EntityId[] = ENTITY_IDS, scale = 1): Row[] {
  const g = state.history.gateway;
  const start = Math.max(0, g.length - window);
  const rows: Row[] = [];
  for (let i = start; i < g.length; i++) {
    const row: Row = { t: g[i].t };
    for (const id of ids) {
      const v = state.history.entities[id][i]?.[field] ?? null;
      row[id] = v === null ? null : (v as number) * scale;
    }
    rows.push(row);
  }
  return rows;
}

export function gatewayRows(state: SimState, window = 180): Row[] {
  return state.history.gateway.slice(-window).map((g) => ({ t: g.t, utilisation: g.utilisation * 100, pressure: Math.min(g.pressure, 2) * 100, retail: g.retailP95Ms }));
}

export const entitySeries = (ids: readonly EntityId[] = ENTITY_IDS): SeriesDef[] => ids.map((id) => ({ key: id, label: id === "retail" ? "Retail" : ENTITY_PROFILES[id].name, color: ENTITY_COLOR[id] }));

/**
 * Newcomer-friendly view: three lines instead of six.
 * "Affected" = primary service of the latest open incident (else the slowest partner).
 */
export function focusEntity(state: SimState): EntityId {
  const open = state.incidents.filter((i) => i.status !== "resolved").at(-1) ?? state.incidents.at(-1);
  if (open && open.status !== "resolved" && open.primaryEntityId !== "retail") return open.primaryEntityId;
  let worst: EntityId = "partner-a";
  let max = -1;
  for (const id of ENTITY_IDS) {
    if (id === "retail") continue;
    const v = state.history.entities[id].at(-1)?.p95Ms ?? 0;
    if (v > max) {
      max = v;
      worst = id;
    }
  }
  return worst;
}

export function focusRows(state: SimState, field: "p95Ms" | "successRate", window = 180): Row[] {
  const focus = focusEntity(state);
  const others = ENTITY_IDS.filter((id) => id !== "retail" && id !== focus);
  const g = state.history.gateway;
  const start = Math.max(0, g.length - window);
  const scale = field === "successRate" ? 100 : 1;
  const rows: Row[] = [];
  for (let i = start; i < g.length; i++) {
    const f = state.history.entities[focus][i]?.[field] ?? null;
    const vals = others.map((id) => state.history.entities[id][i]?.[field]).filter((v): v is number => v !== null && v !== undefined);
    const r = state.history.entities.retail[i]?.[field] ?? null;
    rows.push({
      t: g[i].t,
      affected: f === null ? null : Math.round(f * scale * 10) / 10,
      others: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * scale * 10) / 10 : null,
      retail: r === null ? null : Math.round(r * scale * 10) / 10,
    });
  }
  return rows;
}

export function focusSeries(state: SimState): SeriesDef[] {
  const focus = focusEntity(state);
  return [
    { key: "affected", label: `${ENTITY_PROFILES[focus].name} (most affected)`, color: "var(--s2)" },
    { key: "others", label: "Other partners (average)", color: "var(--s1)" },
    { key: "retail", label: "Retail banking", color: "var(--s6)" },
  ];
}

/** Horizontal bar chart with the value printed on each bar — readable without a legend. */
export function LabeledBarChart({ data, height = 180, ariaLabel, format }: { data: { label: string; value: number; color: string }[]; height?: number; ariaLabel: string; format: (v: number) => string }) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 96, bottom: 4, left: 8 }} barCategoryGap={10}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis type="category" dataKey="label" width={190} tick={{ fontSize: 12, fill: "var(--text-2)" }} axisLine={false} tickLine={false} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={30}>
            {data.map((d) => (
              <Cell key={d.label} fill={d.color} />
            ))}
            <LabelList dataKey="value" position="right" formatter={(v: unknown) => format(Number(v))} style={{ fontSize: 12, fontWeight: 600, fill: "var(--text)" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
