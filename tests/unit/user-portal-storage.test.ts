/**
 * RED tests for p3 user-portal storage module (src/lib/db/userPortal.ts).
 * Contract: exports from frozen contract.md — getPortalKeyState, preferences,
 * user-combo CRUD (all owner-keyed, no global mutation, no secrets).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET ||= "test-only-secret-user-portal-0123456789abcdef";

describe("userPortal storage (p3 owned)", () => {
  it("getPortalKeyState returns fresh parsed state, no secrets", async () => {
    const m = await import("@/lib/db/userPortal");
    assert.equal(typeof m.getPortalKeyState, "function");
  });

  it("preferences CRUD with revision conflict", async () => {
    const m = await import("@/lib/db/userPortal");
    for (const fn of ["getKeyPreferences", "updateKeyPreferences"] as const) {
      assert.equal(typeof m[fn], "function", fn);
    }
  });

  it("user combo CRUD is owner-keyed with revision guards", async () => {
    const m = await import("@/lib/db/userPortal");
    for (const fn of [
      "listUserCombos",
      "getUserCombo",
      "createUserCombo",
      "updateUserCombo",
      "deleteUserCombo",
    ] as const) {
      assert.equal(typeof m[fn], "function", fn);
    }
  });

  it("exposes isPrivateComboId + revision-bump lifecycle helper", async () => {
    const m = await import("@/lib/db/userPortal");
    assert.equal(typeof m.isPrivateComboId, "function");
    assert.equal(typeof m.bumpPortalSessionRevision, "function");
    assert.equal(m.isPrivateComboId("user-combo/abc"), true);
    assert.equal(m.isPrivateComboId("auto/claude"), false);
  });

  it("preferences honoured: update then CONFLICT on stale revision", async () => {
    const m = await import("@/lib/db/userPortal");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    const key = await createApiKey("RED portal key", "test-machine-portal");
    const p0 = await m.getKeyPreferences(key.id);
    assert.deepEqual(p0, { disabledModels: [], revision: 0 });
    const p1 = await m.updateKeyPreferences(key.id, ["auto/glm"], 0);
    assert.equal(p1.revision, 1);
    await assert.rejects(() => m.updateKeyPreferences(key.id, [], 0), /CONFLICT|revision/i);
    await m.updateKeyPreferences(key.id, [], p1.revision);
    const p2 = await m.getKeyPreferences(key.id);
    assert.deepEqual(p2.disabledModels, []);
  });

  it("user combos: create/get/list/update/delete, owner-scoped, revision-guarded", async () => {
    const m = await import("@/lib/db/userPortal");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    const a = await createApiKey("RED portal key A", "test-machine-pa");
    const b = await createApiKey("RED portal key B", "test-machine-pb");
    const c = await m.createUserCombo(a.id, { name: "mine", models: ["auto/glm"] });
    assert.equal(c.keyId, a.id);
    assert.equal(c.revision, 0);
    assert.equal(await m.getUserCombo(b.id, c.id), null, "other key must not see combo");
    const listed = await m.listUserCombos(a.id);
    assert.equal(listed.length, 1);
    await assert.rejects(() => m.updateUserCombo(a.id, c.id, { models: ["auto/glm"], expectedRevision: 999 }), /CONFLICT|revision/i);
    const u1 = await m.updateUserCombo(a.id, c.id, { name: "mine2", expectedRevision: 0 });
    assert.equal(u1.name, "mine2");
    assert.equal(u1.revision, 1);
    await assert.rejects(() => m.createUserCombo(a.id, { name: "x".repeat(81), models: [] }), /name/i);
    await assert.rejects(() => m.createUserCombo(a.id, { name: "ok", models: new Array(33).fill("m") }), /32|models/i);
    await m.deleteUserCombo(a.id, c.id, 1);
    assert.deepEqual(await m.listUserCombos(a.id), []);
  });

  it("revisions must be strict non-negative integers (no strings/NaN/floats/negatives)", async () => {
    const m = await import("@/lib/db/userPortal");
    const { createApiKey } = await import("@/lib/db/apiKeys");
    const key = await createApiKey("RED portal key strict", "test-machine-strict");
    for (const bad of ["0", NaN, 1.5, -1, null, undefined]) {
      await assert.rejects(
        () => (m.updateKeyPreferences as (id: string, prefs: unknown, rev: unknown) => Promise<unknown>)(key.id, [], bad),
        /non-negative integer|CONFLICT/i,
        `must reject ${String(bad)}`
      );
    }
  });

  it("expiry semantics: absent=>null, invalid=>1970 sentinel (expired), usable denies it", async () => {
    const m = await import("@/lib/db/userPortal");
    assert.equal(m.parseKeyExpiryFailClosed(null), null);
    assert.equal(m.parseKeyExpiryFailClosed(""), null);
    assert.equal(m.parseKeyExpiryFailClosed("not-a-date"), m.EXPIRED_SENTINEL_ISO);
    assert.equal(m.parseKeyExpiryFailClosed(NaN), m.EXPIRED_SENTINEL_ISO);
    assert.equal(m.parseKeyExpiryFailClosed(Infinity), m.EXPIRED_SENTINEL_ISO);
    assert.ok(Date.parse(m.EXPIRED_SENTINEL_ISO) <= Date.now(), "sentinel is in the past");
  });

  it("isUserModelEnabled: personal-only gate for p4's inference hook (fail-open add-only)", async () => {
    const m = await import("@/lib/db/userPortal");
    const apiKeys = await import("@/lib/db/apiKeys");
    const key = await apiKeys.createApiKey("RED portal gate", "test-machine-gate");
    assert.equal(await m.isUserModelEnabled(key.id, "auto/glm"), true);
    await m.updateKeyPreferences(key.id, ["auto/glm"], 0);
    assert.equal(await m.isUserModelEnabled(key.id, "auto/glm"), false);
    assert.equal(await m.isUserModelEnabled(key.id, "other/model"), true);
    assert.equal(await m.isUserModelEnabled("missing-key-id", "auto/glm"), true);
  });

  it("lifecycle RED: regen/revoke/portal-flag writes bump portal_session_revision + clear caches", async () => {
    const m = await import("@/lib/db/userPortal");
    const apiKeys = await import("@/lib/db/apiKeys");
    const key = await apiKeys.createApiKey("RED portal lifecycle", "test-machine-lc");
    const s0 = await m.getPortalKeyState(key.id);
    assert.equal(s0?.portalSessionRevision, 0);
    const r0 = await apiKeys.regenerateApiKey(key.id);
    assert.ok(r0, "regen must succeed");
    const s1 = await m.getPortalKeyState(key.id);
    assert.equal(s1?.portalSessionRevision, 1, "regen must bump portal_session_revision");
  });
});
