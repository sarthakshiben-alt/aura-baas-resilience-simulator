import { expect, test } from "@playwright/test";

test.describe("Aura BaaS resilience simulator (production build)", () => {
  test("overview loads without an AI key and shows partners, retail and the simulated label", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.getByText("SIMULATED ENVIRONMENT — NO REAL BANKING SYSTEM CONNECTED").first()).toBeVisible();
    for (const id of ["partner-a", "partner-b", "partner-c", "partner-d", "partner-e", "retail"]) await expect(page.getByTestId(`row-${id}`)).toBeVisible();
    await expect(page.getByTestId("ai-toggle")).toContainText("Live AI not configured");
    const t0 = await page.getByTestId("sim-clock").textContent();
    await page.waitForTimeout(1500);
    expect(await page.getByTestId("sim-clock").textContent()).not.toBe(t0);
    expect(errors).toEqual([]);
  });

  test("guided demo: trigger → protections → investigate (labelled fallback) → approve → verified recovery → paired comparison", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    const guide = page.getByTestId("guided-demo");
    await page.getByTestId("start-guided-demo").click();
    await guide.getByRole("button", { name: /Begin/ }).click();
    await guide.getByRole("button", { name: /Next: trigger/ }).click();
    await page.getByTestId("guide-trigger").click();
    await guide.getByRole("button", { name: /Next: watch/ }).click();
    await expect(page.getByTestId("row-partner-a")).toContainText(/Protected|Degraded/);
    await guide.getByRole("button", { name: /Next: investigate/ }).click();
    await page.waitForURL(/investigation/);
    // AI ON auto-investigates on detection; no click needed.
    await expect(page.getByTestId("diagnosis")).toContainText("Rule-based fallback");
    await expect(page.getByTestId("diagnosis")).not.toContainText("Real LLM response");
    await guide.getByRole("button", { name: /review the recommendation/ }).click();
    await guide.getByRole("button", { name: /Approve the escalation/ }).click();
    await guide.getByRole("button", { name: /verify recovery/ }).click();
    await guide.getByRole("button", { name: /Fast-forward/ }).click();
    await guide.getByRole("button", { name: /what did AI add here/ }).click({ timeout: 120_000 });
    await page.waitForURL(/comparison/);
    // Part 1 verdict: routine incident, the comparison page runs GS-01 by itself.
    await expect(page.getByTestId("sla-table")).toContainText("Automated rules (no AI)", { timeout: 60_000 });
    await expect(page.getByTestId("paired-result")).toContainText("AI ON used fallback");
    await expect(page.getByTestId("sensitivity-table")).toContainText("10 min");
    await guide.getByRole("button", { name: /mystery incident/ }).click();
    // Part 2: the mystery — rulebook stumped, human paged.
    await expect(page.getByTestId("sla-pick-GS-19")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("sla-penalty")).toContainText("human on-call paged", { timeout: 60_000 });
    await guide.getByRole("button", { name: /value for money/ }).click();
    // Part 3: no live AI here → recorded live runs, clearly labelled.
    await expect(page.getByTestId("guide-value")).toContainText("recorded 2026-10-19");
    await expect(page.getByTestId("ai-value-summary")).toContainText("Recorded live run");
    await guide.getByRole("button", { name: /Finish/ }).click();
    await expect(guide).toContainText("AI for the unknown");
    expect(errors).toEqual([]);
  });

  test("AI OFF keeps protections; a rejection is recorded in the audit log", async ({ page }) => {
    await page.goto("/simulator");
    await page.getByTestId("reset-scenario").click();
    await page.getByTestId("ai-toggle").getByRole("switch").click();
    await expect(page.getByTestId("ai-toggle")).toContainText("OFF");
    await page.getByTestId("triage-minutes").selectOption("0");
    await page.getByTestId("start-partner_slowdown").click();
    await expect(page.getByText(/Triggered: Partner slowdown/)).toBeVisible();
    await expect(page.getByTestId("start-partner_slowdown")).toBeDisabled();
    await page.goto("/investigation");
    await expect(page.getByTestId("incident-id")).toHaveText("INC-001", { timeout: 30_000 });
    // AI OFF with 0 min triage = automated rules, started automatically on detection.
    await expect(page.getByTestId("diagnosis")).toContainText("Rule-based (conventional)");
    await expect(page.getByTestId("diagnosis")).toContainText("Automated rules (no AI)");
    const recs = page.getByTestId("recommendation");
    await expect(recs.first()).toBeVisible();
    await recs.first().getByTestId("reject").click();
    await page.getByText(/^Show audit log/).click();
    await expect(page.getByText("Rejected; no state change")).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("row-partner-b")).toContainText("Healthy");
    await expect(page.getByTestId("row-retail")).toContainText("Within target");
  });

  test("API: health works without credentials and never exposes secrets", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toContain('"configured":false');
    expect(body).not.toMatch(/SERVICE_ROLE|api_key|secret/i);
    const bad = await request.post("/api/demo/state", { data: { session: "x".repeat(20), log: { v: 1, seed: 1, tick: 0, commands: [] } } });
    expect(bad.status()).toBe(401);
    expect(await bad.text()).not.toMatch(/at .*\.ts|stack/i);
  });

  test("AI OFF with manual triage shows the assumed delay while protections act immediately", async ({ page }) => {
    await page.goto("/simulator");
    await page.getByTestId("reset-scenario").click();
    await page.getByTestId("ai-toggle").getByRole("switch").click();
    await page.getByTestId("triage-minutes").selectOption("10");
    await page.getByTestId("start-partner_slowdown").click();
    await page.goto("/investigation");
    await expect(page.getByTestId("investigation-pending")).toContainText("assumed 10 min", { timeout: 30_000 });
    await page.goto("/");
    await expect(page.getByTestId("row-partner-a")).toContainText("Protected", { timeout: 30_000 });
  });

  test("three scenarios; the mystery stumps the rulebook, pages a human, and reveals its cause", async ({ page }) => {
    await page.goto("/simulator");
    for (const id of ["partner_slowdown", "retail_risk", "mystery"]) await expect(page.getByTestId(`start-${id}`)).toBeVisible();
    await expect(page.getByTestId("start-traffic_spike")).toHaveCount(0);
    await page.goto("/comparison");
    await page.getByTestId("sla-pick-GS-19").click();
    const card = page.getByTestId("sla-penalty");
    await expect(card.getByTestId("sla-table")).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText("can't tell what's wrong");
    await expect(card).toContainText("human on-call paged");
    // No live AI in this test → AI is labelled as fallback, never credited.
    await expect(card.getByTestId("ai-verdict")).toContainText("couldn't be measured");
    await card.getByText(/Reveal what really happened/).click();
    await expect(card.getByTestId("mystery-reveal")).toContainText("the real problem");
  });
});
