import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
export const fmtPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`);
export const fmtNum = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
export const fmtSimTime = (t: number | null | undefined) => {
  if (t === null || t === undefined) return "—";
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
export const fmtSecs = (v: number | null | undefined) => (v === null || v === undefined ? "N/A" : `${v} s`);
