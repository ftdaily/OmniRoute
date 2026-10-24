/**
 * RED-first contract test for p9-owned user-portal UI.
 * Source-static per tests/unit/ui conventions (no browser needed).
 * Covers: /user/login + /user pages, own CSRF helper, userPortal i18n
 * namespace, admin key-editor portal flags gated on explicit grants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../../"
);
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf-8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

// --- /user/login page ---
test("src/app/user/login/page.tsx exists outside (dashboard) layout", () => {
  assert.ok(exists("src/app/user/login/page.tsx"), "login page missing");
  const s = src("src/app/user/login/page.tsx");
  assert.ok(
    s.includes('outside (dashboard) layout'),
    "login page must document standalone placement"
  );
  assert.ok(
    s.includes('type="password"') || s.includes("type='password'"),
    "raw key input must be password field"
  );
  assert.ok(
    s.includes("localStorage") === false && s.includes("sessionStorage") === false,
    "never persist raw key in browser storage"
  );
  assert.ok(s.includes("/api/user/auth/login"), "login must POST frozen contract route");
  assert.ok(s.includes("window.location.origin"), "BaseURL from served host, not hardcoded localhost");
  assert.ok(s.includes("localhost:") === false, "no hardcoded localhost");
});

// --- /user page ---
test("src/app/user/page.tsx exists with models + combos + logout-all", () => {
  assert.ok(exists("src/app/user/page.tsx"), "user page missing");
  const s = src("src/app/user/page.tsx");
  assert.ok(s.includes("/api/user/models"), "must fetch effective model catalog");
  assert.ok(s.includes("/api/user/preferences"), "must PATCH disabledModels+expectedRevision");
  assert.ok(s.includes("/api/user/combos"), "must CRUD private combos");
  assert.ok(s.includes("user-combo/"), "private combo wire id copy required");
  assert.ok(s.includes("/api/user/auth/logout"), "logout-all button required");
});

// --- /user layout i18n scope ---
test("src/app/user/layout.tsx re-scopes userPortal via SectionI18nProvider", () => {
  assert.ok(exists("src/app/user/layout.tsx"), "user layout missing");
  const s = src("src/app/user/layout.tsx");
  assert.ok(s.includes("SectionI18nProvider"), "must use existing provider");
  assert.ok(s.includes("userPortal"), "must include userPortal namespace");
  assert.ok(!s.includes("(dashboard)"), "must stay outside admin layout");
});

// --- user combos edit/delete/enable ---
test("src/app/user/page.tsx manages own combos via id routes + revisions", () => {
  const s = src("src/app/user/page.tsx");
  assert.ok(s.includes("encodeURIComponent("), "id routes must encode id");
  assert.ok(s.includes('"PATCH"') || s.includes("'PATCH'") || s.includes("method: \"PATCH\""), "PATCH expectedRevision required");
  assert.ok(s.includes('"DELETE"') || s.includes("method: \"DELETE\""), "DELETE with revision required");
  assert.ok(s.includes("comboWireId"), "wire id must not double-prefix");
  assert.ok(s.includes("window.confirm"), "delete confirmation required");
  assert.ok(s.includes("comboDeleteConfirm") && s.includes("comboUpdateFailed"), "EN labels required");
});

// --- own CSRF helper ---
test("src/lib/userPortalCsrf.ts fetches own token, no hardcoded host", () => {
  assert.ok(exists("src/lib/userPortalCsrf.ts"), "CSRF helper missing");
  const s = src("src/lib/userPortalCsrf.ts");
  assert.ok(s.includes("/api/user/auth/csrf"), "must fetch own CSRF endpoint");
  assert.ok(s.includes("x-omniroute-user-csrf"), "must send contract header");
  assert.ok(s.includes("window.location.origin"), "BaseURL from served host");
  assert.ok(s.includes("localhost:") === false, "no hardcoded localhost");
});

// --- i18n namespace ---
test("en.json root gains userPortal namespace only", () => {
  const en = JSON.parse(src("src/i18n/messages/en.json"));
  assert.ok(en.userPortal && typeof en.userPortal === "object", "userPortal namespace missing");
  assert.ok(
    typeof en.userPortal.loginTitle === "string" &&
      en.userPortal.loginTitle.length > 0,
    "readable EN labels, no raw translation keys"
  );
});

// --- admin key-editor portal flags ---
test("GeneralTab gates portalEnabled on explicit nonempty connection grant", () => {
  const p = "src/app/(dashboard)/dashboard/api-manager/[id]/access/tabs/GeneralTab.tsx";
  const s = src(p);
  assert.ok(s.includes("portalEnabled"), "portalEnabled flag UI missing");
  assert.ok(s.includes("userCombosEnabled"), "userCombosEnabled flag UI missing");
  assert.ok(
    s.includes("selectedConnections") || s.includes("allowAllConnections"),
    "enable must depend on existing connection grant selection"
  );
});
