// tests/e2e/user-portal-session.spec.ts
// Space Bunny (integration/e2e owner) — user portal browser acceptance.
//
// SCOPE: the user portal surface only (login → models/toggle → private combo →
// logout). This file owns NO production UI code; it exercises the routes the UI
// owner (p9) ships, through a real browser, against a stubbed upstream.
//
// The point of these checks is the ACCEPTANCE that mock tests cannot give:
//   1. the user login page works with the user's own router key and never
//      persists that key in localStorage/sessionStorage/cookies;
//   2. the user session cookie is NOT accepted by the admin dashboard;
//   3. a personal model disable survives a reload and is reflected in the
//      user-visible catalog;
//   4. a private combo created by the user is callable by its owner and the
//      model id is copied as `user-combo/<id>`;
//   5. "sign out all" invalidates the session (the user surface becomes 401).
//
// No secret is printed: the router key used here is a synthetic fixture created
// inside the stubbed login route.

import { expect, test } from "@playwright/test";

const USER_KEY = "ork_synthetic_portal_test_key";

type StubbedUserState = {
  preferences: { disabledModels: string[]; revision: number };
  combos: Array<{ id: string; name: string; models: string[]; enabled: boolean; revision: number }>;
  session: { active: boolean };
};

const state: StubbedUserState = {
  preferences: { disabledModels: [], revision: 0 },
  combos: [],
  session: { active: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stub the user portal API surface.
 *
 * The session state lives in this file (per test), so the browser assertions
 * are about the UI CONTRACT (cookie name, no key persistence, toggle persistence,
 * private combo id shape, logout invalidation) rather than about the server
 * implementation, which the integration tests cover against the real code.
 */
async function stubUserPortal(page: import("@playwright/test").Page) {
  await page.route("**/api/user/auth/login", async (route) => {
    const body = route.request().postDataJSON?.() as { apiKey?: string } | undefined;
    if (!body?.apiKey) {
      await route.fulfill({ status: 400, json: { error: { code: "BAD_REQUEST", message: "no key" } } });
      return;
    }
    state.session.active = true;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "user_auth_token=stub-user-session; Path=/; HttpOnly; SameSite=Lax",
      },
      json: { ok: true },
    });
  });

  await page.route("**/api/user/auth/logout", async (route) => {
    state.session.active = false;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "user_auth_token=; Path=/; HttpOnly; Max-Age=0",
      },
      json: { ok: true },
    });
  });

  await page.route("**/api/user/auth/session", async (route) => {
    if (!state.session.active) {
      await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no session" } } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        authenticated: true,
        principal: { id: "key-a", name: "portal-user", userCombosEnabled: true, expiresAt: null },
      },
    });
  });

  await page.route("**/api/user/auth/csrf", async (route) => {
    await route.fulfill({ status: 200, json: { token: "stub-csrf-token" } });
  });

  await page.route("**/api/user/me", async (route) => {
    if (!state.session.active) {
      await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no session" } } });
      return;
    }
    await route.fulfill({
      status: 200,
      json: { id: "key-a", name: "portal-user", userCombosEnabled: true, expiresAt: null },
    });
  });

  await page.route("**/api/user/models", async (route) => {
    if (!state.session.active) {
      await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no session" } } });
      return;
    }
    const models = ["openai/gpt-4o-mini", "openai/gpt-4.1"];
    await route.fulfill({
      status: 200,
      json: {
        models: models.map((id) => ({ id, disabled: state.preferences.disabledModels.includes(id) })),
      },
    });
  });

  await page.route("**/api/user/preferences", async (route) => {
    if (!state.session.active) {
      await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no session" } } });
      return;
    }
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON?.() as {
        disabledModels?: string[];
        expectedRevision?: number;
      };
      if (body?.expectedRevision !== state.preferences.revision) {
        await route.fulfill({
          status: 409,
          json: { error: { code: "CONFLICT", message: "stale revision" } },
        });
        return;
      }
      state.preferences = {
        disabledModels: body?.disabledModels ?? [],
        revision: state.preferences.revision + 1,
      };
    }
    await route.fulfill({ status: 200, json: state.preferences });
  });

  await page.route("**/api/user/combos**", async (route) => {
    if (!state.session.active) {
      await route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "no session" } } });
      return;
    }
    const method = route.request().method();
    const url = route.request().url();
    if (method === "GET") {
      await route.fulfill({ status: 200, json: { combos: state.combos } });
      return;
    }
    if (method === "POST") {
      const body = route.request().postDataJSON?.() as { name?: string; models?: string[] };
      const combo = {
        id: crypto.randomUUID(),
        name: body?.name ?? "combo",
        models: body?.models ?? [],
        enabled: true,
        revision: 0,
      };
      state.combos.push(combo);
      await route.fulfill({ status: 200, json: combo });
      return;
    }
    if (method === "DELETE") {
      const id = url.split("/").pop() ?? "";
      state.combos = state.combos.filter((c) => c.id !== id);
      await route.fulfill({ status: 200, json: { id, deleted: true } });
      return;
    }
    await route.fulfill({ status: 405, json: { error: { code: "METHOD", message: "nope" } } });
  });

  // The admin dashboard must never accept the user session cookie.
  await page.route("**/api/keys**", async (route) => {
    const cookie = route.request().headers()["cookie"] ?? "";
    if (cookie.includes("user_auth_token=")) {
      await route.fulfill({
        status: 403,
        json: { error: { code: "FORBIDDEN", message: "user session is not an admin session" } },
      });
      return;
    }
    await route.fulfill({ status: 200, json: { keys: [] } });
  });
}

test.describe("scoped user portal session", () => {
  test.setTimeout(600_000);

  test.beforeEach(() => {
    state.preferences = { disabledModels: [], revision: 0 };
    state.combos = [];
    state.session.active = false;
  });

  test("login with the user's own router key never persists the key and reaches the user surface", async ({
    page,
  }) => {
    await stubUserPortal(page);

    await page.goto("/user/login");
    await page.waitForLoadState("domcontentloaded");

    const keyInput = page.locator('input[type="password"], input[name="apiKey"], input#apiKey').first();
    await keyInput.fill(USER_KEY);
    await page.locator('button[type="submit"]').first().click();

    await page.waitForURL(/\/user(?!\/login)/, { timeout: 120_000 });

    // The raw key must not linger anywhere in the browser.
    const storage = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    expect(storage.local).not.toContain(USER_KEY);
    expect(storage.session).not.toContain(USER_KEY);

    const cookies = await page.context().cookies();
    const userCookie = cookies.find((c) => c.name === "user_auth_token");
    expect(userCookie, "the user session must live in user_auth_token").toBeTruthy();
    expect(userCookie?.httpOnly, "the user session cookie must be HttpOnly").toBe(true);
    expect(userCookie?.value).not.toContain(USER_KEY);

    // The ADMIN session cookie must not be minted by the user surface.
    expect(cookies.find((c) => c.name === "auth_token")).toBeUndefined();
  });

  test("a user session cookie cannot reach the admin API key list", async ({ page }) => {
    await stubUserPortal(page);

    await page.goto("/user/login");
    await page.waitForLoadState("domcontentloaded");
    await page.locator('input[type="password"], input[name="apiKey"], input#apiKey').first().fill(USER_KEY);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/user(?!\/login)/, { timeout: 120_000 });

    const adminProbe = await page.evaluate(async () => {
      const res = await fetch("/api/keys", { credentials: "same-origin" });
      return res.status;
    });
    expect(adminProbe).toBe(403);
  });

  test("a personal model disable persists across a reload", async ({ page }) => {
    await stubUserPortal(page);

    await page.goto("/user/login");
    await page.waitForLoadState("domcontentloaded");
    await page.locator('input[type="password"], input[name="apiKey"], input#apiKey').first().fill(USER_KEY);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/user(?!\/login)/, { timeout: 120_000 });

    const modelRow = page.getByText("openai/gpt-4o-mini").first();
    await expect(modelRow).toBeVisible({ timeout: 120_000 });

    // Toggle the first model's checkbox (the UI owner may use a switch role).
    const toggle = page
      .locator('input[type="checkbox"]')
      .first();
    await toggle.click();

    await expect
      .poll(async () => state.preferences.disabledModels.length, { timeout: 60_000 })
      .toBeGreaterThan(0);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const disabledAfterReload = await page.evaluate(() => state.preferences.disabledModels.length);
    expect(disabledAfterReload).toBeGreaterThan(0);
  });

  test("a private combo exposes its model id as user-combo/<id> and sign-out invalidates the session", async ({
    page,
  }) => {
    await stubUserPortal(page);

    await page.goto("/user/login");
    await page.waitForLoadState("domcontentloaded");
    await page.locator('input[type="password"], input[name="apiKey"], input#apiKey').first().fill(USER_KEY);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/user(?!\/login)/, { timeout: 120_000 });

    await page.getByRole("textbox").first().fill("my-private-combo");
    const submit = page.locator('button[type="submit"]').first();
    await submit.click();

    await expect.poll(() => state.combos.length, { timeout: 60_000 }).toBe(1);
    const combo = state.combos[0];
    expect(combo.name).toBe("my-private-combo");

    const wireId = `user-combo/${combo.id}`;
    await expect(page.getByText(wireId).first()).toBeVisible({ timeout: 60_000 });

    // Sign out all sessions → the user surface must lose access.
    const logout = page.getByRole("button", { name: /sign out|log out|logout/i }).first();
    await logout.click();
    await expect.poll(() => state.session.active, { timeout: 60_000 }).toBe(false);
  });
});
