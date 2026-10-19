import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("23. client code does not expose privileged keys", () => {
  const files = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
  const clientFiles = files.filter((f) => /^["']use client["']/.test(readFileSync(f, "utf8").trimStart()) || f.includes(`${path.sep}client${path.sep}`));

  it("no client module imports server-only code or reads process.env", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const f of clientFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/@\/lib\/server\/|lib\/server\//);
      expect(src, f).not.toMatch(/process\.env/);
    }
  });

  it("secrets are only read in the server env module, never via NEXT_PUBLIC_ variables", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/AI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|SESSION_SIGNING_SECRET/.test(src)) expect(f).toMatch(/lib[\\/]server[\\/]env\.ts$/);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_(AI|SUPABASE_SERVICE|SESSION)/);
    }
  });

  it("production browser assets contain no sentinel secrets (after `npm run test:security`)", () => {
    const marker = path.join(root, ".next", "SECURITY_SENTINEL_BUILD");
    if (!existsSync(marker)) return; // only meaningful after a sentinel build
    const sentinels = readFileSync(marker, "utf8").trim().split("\n");
    const assets = walk(path.join(root, ".next", "static"));
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      const content = readFileSync(a, "utf8");
      for (const s of sentinels) expect(content.includes(s), `${s} leaked into ${a}`).toBe(false);
    }
    expect(assets.some((a) => a.endsWith(".map"))).toBe(false);
  });
});
