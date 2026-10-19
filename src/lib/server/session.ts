import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { SignedEntry, WorkflowEntry } from "../sim/workflow";

/**
 * Stateless, HMAC-signed sessions. The simulation runs deterministically in the
 * browser; privileged transitions (AI results, approvals, cancellations) are
 * issued by the server as signed entries. On every privileged request the
 * server replays the full log and verifies every entry. See README "Architecture".
 */
export interface SessionClaims {
  v: 1;
  sid: string;
  seed: number;
  iat: number;
}

const b64u = (b: Buffer) => b.toString("base64url");

/** Canonical JSON with sorted keys so signatures survive client round-trips. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

function mac(secret: string, purpose: string, data: string): string {
  return b64u(createHmac("sha256", secret).update(`${purpose}\n${data}`).digest());
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function issueSession(secret: string, seed?: number): { token: string; claims: SessionClaims } {
  const claims: SessionClaims = { v: 1, sid: b64u(randomBytes(12)), seed: seed ?? randomInt(1, 2 ** 31 - 1), iat: Date.now() };
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  return { token: `${payload}.${mac(secret, "session", payload)}`, claims };
}

export function verifySession(secret: string, token: unknown): SessionClaims | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEq(sig, mac(secret, "session", payload))) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (c.v !== 1 || typeof c.sid !== "string" || !Number.isInteger(c.seed)) return null;
    return c;
  } catch {
    return null;
  }
}

export function signEntry(secret: string, entry: WorkflowEntry): SignedEntry {
  return { entry, sig: mac(secret, "entry", canonical(entry)) };
}

export function verifyEntry(secret: string, sessionId: string, signed: SignedEntry): boolean {
  if (!signed || typeof signed.sig !== "string" || !signed.entry) return false;
  if (signed.entry.sessionId !== sessionId) return false;
  return safeEq(signed.sig, mac(secret, "entry", canonical(signed.entry)));
}

export function newEntryId(prefix: string): string {
  return `${prefix}-${b64u(randomBytes(6))}`;
}
