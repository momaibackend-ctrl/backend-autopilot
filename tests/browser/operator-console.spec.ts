import { expect, test } from "@playwright/test";
test("operator understands LIVE-1 lifecycle and runs validation without a terminal", async ({
  page,
  request,
}) => {
  const control = await request.get("/api/control/v1/console/overview");
  expect(control.status(), await control.text()).toBe(200);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading",{name:"Superadmin MCP"})).toBeVisible();
  await expect(page.getByText("Console content is loaded through the semantic screen configuration layer.")).toBeVisible();
  await expect(
    page.getByText("Backend Autopilot Live Sandbox").first(),
  ).toBeVisible();
  await expect(
    page.locator(".metric").filter({
      has: page.locator("span").filter({ hasText: /^Ready$/ }),
    }),
  ).toContainText("1");
  await page.getByText("Backend Autopilot Live Sandbox").first().click();
  await expect(
    page.getByRole("heading", { name: "Backend Autopilot Live Sandbox" }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: /LIVE-1 Live Notes/ }).click();
  await expect(page.getByText("READY", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Database Changes" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "GitHub CI" })).toBeVisible();
  await expect(page.getByText("32264809746").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Independent Review" }),
  ).toBeVisible();
  await expect(
    page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: "Independent Review" }),
    }).locator(".json"),
  ).toContainText('"result": "PASS"');
  await expect(page.getByText(/globalThis\.compromised/).first()).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { compromised?: boolean })
          .compromised,
    ),
  ).toBeUndefined();
  await page.goto("/validation");
  await page.locator("select").nth(2).selectOption("SMOKE");
  await page.getByRole("button", { name: "Run validation" }).click();
  const latestResult = page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Latest result" }),
  });
  await expect(latestResult.locator("p")).toContainText("проверок пройдены", {
    timeout: 30_000,
  });
  await expect(latestResult.getByText("PASS", { exact: true })).toBeVisible();
});
