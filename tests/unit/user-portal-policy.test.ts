/** w52:p4 TDD — scoped user portal policy, real p3 storage, isolated DB. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET ||= "user-portal-policy-unit-secret";

const store = await import("../../src/lib/db/userPortal.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const pol = await import("../../src/lib/userPortalPolicy.ts");

async function makePortalKey(opts: {
  name: string;
  portalEnabled?: boolean;
  userCombosEnabled?: boolean;
  allowedConnections?: string[];
  allowedModels?: string[];
  modelAccessMode?: string;
}) {
  const created = (await apiKeysDb.createApiKey(opts.name, "machine-portal-test")) as {
    id: string;
    key: string;
  };
  const db = (await import("../../src/lib/db/core.ts")).getDbInstance() as any;
  db.prepare(
    `UPDATE api_keys SET portal_enabled = ?, user_combos_enabled = ?, allowed_connections = ?, allowed_models = ?, model_access_mode = ? WHERE id = ?`
  ).run(
    opts.portalEnabled === false ? 0 : 1,
    opts.userCombosEnabled === false ? 0 : 1,
    JSON.stringify(opts.allowedConnections ?? []),
    JSON.stringify(opts.allowedModels ?? ["model-a", "model-b"]),
    opts.modelAccessMode ?? "restricted",
    created.id
  );
  return created as { id: string; key: string };
}

describe("userPortalPolicy", () => {
  test("fresh policy fails closed on empty grant before legacy normalizer", async () => {
    const k = await makePortalKey({ name: "empty-grant", allowedConnections: [] });
    const p = await pol.getEffectiveUserPortalPolicy(k.id);
    assert.equal(p.portalEnabled, false);
    assert.deepEqual(p.allowedConnections, []);
    assert.equal(p.lifecycle, "empty-grant");
    const scope = await pol.getPortalConnectionScopeForKey(k.id);
    assert.equal(scope.denied, true);
    assert.equal(scope.allowedConnections, null);
  });

  test("same-provider 2-connection counter fixture routes only granted", async () => {
    const k = await makePortalKey({
      name: "iskandar",
      allowedConnections: ["conn-amanai-iskandar"],
      allowedModels: ["model-a", "model-b"],
    });
    const scope = await pol.getPortalConnectionScopeForKey(k.id);
    assert.deepEqual(scope.allowedConnections, ["conn-amanai-iskandar"]);
    assert.equal(scope.allowedConnections?.includes("conn-amanai-other"), false);
  });

  test("personal disabled enforced, admin ceiling still gates", async () => {
    const k = await makePortalKey({
      name: "iskandar-prefs",
      allowedConnections: ["conn-amanai-iskandar"],
      allowedModels: ["model-a", "model-b"],
    });
    const prefs = await store.getKeyPreferences(k.id);
    await store.updateKeyPreferences(k.id, ["model-a"], prefs.revision);
    assert.equal(await pol.isUserModelEnabled(k.id, "model-a"), false);
    assert.equal(await pol.isUserModelEnabled(k.id, "model-b"), true);
    const gate = await pol.gateUserModel(k.id, k.key, "model-a");
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "personal-disabled");
    const gateB = await pol.gateUserModel(k.id, k.key, "model-b");
    assert.equal(gateB.allowed, true);
    assert.equal(gateB.rawKey, k.key);
  });

  test("private combo resolves only owner, foreign id rejected", async () => {
    const k = await makePortalKey({
      name: "iskandar-combo",
      allowedConnections: ["conn-amanai-iskandar"],
      allowedModels: ["model-a", "model-b"],
    });
    const own = await store.createUserCombo(k.id, { name: "pri", models: ["model-a"] });
    assert.equal(
      (await pol.resolveUserComboForKey(k.id, `user-combo/${own.id}`))?.name,
      "pri"
    );
    assert.equal(await pol.resolveUserComboForKey(k.id, "user-combo/foreign-id"), null);
    assert.equal(
      await pol.resolveUserComboForKey("other-key", `user-combo/${own.id}`),
      null
    );
    const k2 = await makePortalKey({
      name: "iskandar-combo2",
      allowedConnections: ["conn-amanai-iskandar"],
      allowedModels: ["model-a", "model-b"],
    });
    assert.equal(
      await pol.resolveUserComboForKey(k2.id, `user-combo/${own.id}`),
      null
    );
  });

  test("no-auth / unsupported paths deny portal early", async () => {
    assert.equal(await pol.isUserModelEnabled("", "model-x"), false);
    assert.equal((await pol.getEffectiveUserPortalPolicy("no-such-key")).portalEnabled, false);
  });
});
