import "dotenv/config";

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";

type AuthUser = { id: string };
type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user: { id: string; email?: string };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertSandbox(projectRef: string, supabaseUrl: string): void {
  if (process.env["AUTOPILOT_CONFIRM_DEDICATED_SANDBOX"] !== "true") {
    throw new Error("Dedicated sandbox confirmation is required");
  }
  if (new URL(supabaseUrl).hostname !== `${projectRef}.supabase.co`) {
    throw new Error("Supabase URL does not match the explicitly selected project ref");
  }
}

function setOperatorAllowlist(
  projectRef: string,
  managementToken: string,
  emails: string,
): void {
  execFileSync(
    "supabase",
    [
      "secrets",
      "set",
      `AUTOPILOT_OPERATOR_EMAILS=${emails}`,
      "--project-ref",
      projectRef,
    ],
    {
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: managementToken },
      stdio: "pipe",
    },
  );
}

async function authRequest<T>(
  url: string,
  serviceRoleKey: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const projectRef = required("AUTOPILOT_SUPABASE_SANDBOX_PROJECT_REF");
  const supabaseUrl = required("AUTOPILOT_CONTROL_SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = required("AUTOPILOT_CONTROL_SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = required("AUTOPILOT_CONTROL_SUPABASE_PUBLISHABLE_KEY");
  const managementToken = required("AUTOPILOT_LIVE_SANDBOX_SUPABASE_ACCESS_TOKEN");
  const permanentOperators = required("AUTOPILOT_PAGES_E2E_OPERATOR_EMAILS");
  const pagesUrl = required("AUTOPILOT_PAGES_E2E_URL").replace(/\/$/, "");
  assertSandbox(projectRef, supabaseUrl);

  const suffix = randomBytes(12).toString("hex");
  const email = `autopilot-pages-e2e-${suffix}@example.invalid`;
  const password = `${randomBytes(24).toString("base64url")}A1!`;
  let userId: string | undefined;
  let allowlistChanged = false;
  let failure: unknown;
  const cleanupErrors: string[] = [];

  try {
    setOperatorAllowlist(
      projectRef,
      managementToken,
      `${permanentOperators},${email}`,
    );
    allowlistChanged = true;

    const user = await authRequest<AuthUser>(
      supabaseUrl,
      serviceRoleKey,
      "/auth/v1/admin/users",
      {
        method: "POST",
        body: JSON.stringify({ email, password, email_confirm: true }),
      },
    );
    userId = user.id;

    const sessionResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      },
    );
    if (!sessionResponse.ok) {
      throw new Error(`Supabase sign-in failed (${sessionResponse.status})`);
    }
    const session = (await sessionResponse.json()) as AuthSession;
    const storageKey = `sb-${projectRef}-auth-token`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.addInitScript(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        { key: storageKey, value: session },
      );
      await page.goto(`${pagesUrl}/dashboard/`, { waitUntil: "networkidle" });
      const expectedText=process.env["AUTOPILOT_PAGES_E2E_EXPECT_TEXT"];
      if(!expectedText)await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({timeout:30_000});
      await expect(
        page.getByText("Backend Autopilot Live Sandbox").first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Production actions disabled")).toBeVisible();
      if(expectedText)await expect(page.getByText(expectedText,{exact:true})).toBeVisible({timeout:30_000});
      console.log(
        JSON.stringify({
          ok: true,
          url: page.url(),
          checks: [
            "Supabase Auth session accepted",
            "Edge control API returned the live project",
            "GitHub Pages console rendered the dashboard",
            "production actions remain disabled",
            ...(expectedText?["semantic screen configuration rendered"]:[]),
          ],
        }),
      );
    } finally {
      await browser.close();
    }
  } catch (error) {
    failure = error;
  } finally {
    if (userId) {
      try {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${userId}`,
          {
            method: "DELETE",
            headers: {
              apikey: serviceRoleKey,
              authorization: `Bearer ${serviceRoleKey}`,
            },
          },
        );
        if (!response.ok) cleanupErrors.push("temporary Auth user deletion failed");
      } catch {
        cleanupErrors.push("temporary Auth user deletion failed");
      }
    }
    if (allowlistChanged) {
      try {
        setOperatorAllowlist(projectRef, managementToken, permanentOperators);
      } catch {
        cleanupErrors.push("operator allowlist restoration failed");
      }
    }
  }
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  if (failure) throw failure;
}

await main();
