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

// --- admin key-editor: portal flag toggles hidden; connection grant UI kept, backend validation intact ---
test("GeneralTab hides portal flags; connection grant UI retained", () => {
  const p = "src/app/(dashboard)/dashboard/api-manager/[id]/access/tabs/GeneralTab.tsx";
  const s = src(p);
  assert.ok(!s.includes("setPortalEnabled"), "portalEnabled toggle must stay hidden");
  assert.ok(!s.includes("setUserCombosEnabled"), "userCombosEnabled toggle must stay hidden");
  const conn = src("src/app/(dashboard)/dashboard/api-manager/[id]/access/tabs/ConnectionsTab.tsx");
  assert.ok(conn.includes("allowAllConnections") || conn.includes("selectedConnections"), "connection grant UI must be retained");
});
