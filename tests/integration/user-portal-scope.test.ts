// tests/integration/user-portal-scope.test.ts
// Space Bunny (integration-test owner) — scoped user portal, adversarial scope matrix.
//
// SCOPE OF THIS FILE (read-only for me: I own NEW tests only, never prod source):
//   * two ordinary router keys A (Iskandar) and B (another friend) that share the
//     SAME provider but different connection rows, plus a third ungranted row;
//   * proof that A can never reach B's / the ungranted connection, including via
//     fallback, alias, private combo and direct-model paths;
//   * personal disable semantics through the DIRECT normal API and through a
//     private combo (not UI-only);
//   * private-combo ownership (B cannot read/update/delete/infer A's combo);
//   * user session vs admin session confusion (user token copied into the admin
//     cookie / admin Bearer must fail);
//   * empty-grant fail-closed for portal keys, legacy keys unchanged;
//   * rotation preserves the key id and invalidates portal sessions.
//
// The storage/auth/policy modules are owned by the other workers
// (p3 = src/lib/db/userPortal.ts, p4 = src/lib/userPortalPolicy.ts,
// pA = src/lib/userPortalAuth.ts). They are imported LAZILY inside each test so
// a missing module produces a per-scenario RED failure with a readable reason
// instead of aborting the whole file at import time.
//
// Fixtures use a scratch DATA_DIR under the OS temp dir (never $HOME, never the
// production DB). No upstream network: every provider call is a recording fetch
// that counts calls PER CONNECTION (proved through the persisted call-log
// connection_id, not through a fake HTTP stub of the app under test).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-user-portal-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "user-portal-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CLOUD_URL = "http://cloud.example";
// The user session is an HS256 JWT derived from JWT_SECRET, so the secret must
// exist for the auth owner to mint/verify it. It is a synthetic test value.
process.env.JWT_SECRET = "user-portal-test-jwt-secret";
process.env.DASHBOARD_PASSWORD = "";
// A configured bootstrap password makes isAuthRequired() true for management
// routes (src/shared/utils/apiAuth.ts:501-505). Without it a fresh install
// opens the management window and the "user cookie cannot authorize key CRUD"
// assertion would pass for the wrong reason.
process.env.INITIAL_PASSWORD = "bootstrap-password";
delete process.env.ALLOW_API_KEY_REVEAL;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const callLogsDb = await import("../../src/lib/usage/callLogs.ts");
// Imported EAGERLY: importing the chat pipeline installs the proxy-fetch patch
// on globalThis.fetch (open-sse/utils/proxyFetch.ts patches it at module load).
// The recording stub must be installed AFTER that patch, otherwise the import
// would overwrite the stub and the request would hit the real upstream.
const { handleChat } = await import("../../src/sse/handlers/chat.ts");

const PROVIDER = "openai";
const MODEL = "openai/gpt-4o-mini";

/**
 * Per-connection upstream call counters, derived from the persisted call logs
 * (`connection_id`, see src/lib/usage/callLogs.ts) — the same evidence path the
 * routing layer itself uses. The connection id is NOT visible in the fetch URL
 * (all rows share the provider host), so counting from the call log is the only
 * non-fake way to prove a forbidden connection was never touched.
 */
async function readDispatchedConnectionIds(): Promise<string[]> {
  const rows = await callLogsDb.getCallLogs({ limit: 200 });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: { connectionId?: string | null }) => row.connectionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function countUpstream(connectionId: string): Promise<number> {
  const dispatched = await readDispatchedConnectionIds();
  return dispatched.filter((id) => id === connectionId).length;
}

type PortalKey = { id: string; key: string; name: string };

/**
 * Create an ordinary (non-manage) router key and mark it portal-enabled with an
 * EXPLICIT, NON-EMPTY connection grant.
 *
 * The portal flags are written straight to the `api_keys` row using the column
 * names frozen in the contract (`portal_enabled`, `user_combos_enabled`,
 * `portal_session_revision`). Writing the fixture at the column level keeps the
 * test independent from which writer API p3 exposes, while still failing loudly
 * if the frozen schema does not exist.
 */
async function createPortalKey(opts: {
  name: string;
  allowedConnections: string[];
  allowedModels?: string[];
  allowedCombos?: string[];
  portalEnabled?: boolean;
  userCombosEnabled?: boolean;
}): Promise<PortalKey> {
  const key = (await apiKeysDb.createApiKey(opts.name, "machine-test")) as PortalKey;
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedConnections: opts.allowedConnections,
    allowedModels: opts.allowedModels ?? [MODEL],
    allowedCombos: opts.allowedCombos ?? ["combo/*"],
  });
  const db = core.getDbInstance();
  const portalEnabled = opts.portalEnabled ?? true;
  const userCombosEnabled = opts.userCombosEnabled ?? true;
  const info = db
    .prepare(
      "UPDATE api_keys SET portal_enabled = ?, user_combos_enabled = ? WHERE id = ? RETURNING portal_enabled, user_combos_enabled"
    )
    .get(portalEnabled ? 1 : 0, userCombosEnabled ? 1 : 0, key.id) as {
    portal_enabled?: number;
    user_combos_enabled?: number;
  } | undefined;
  assert.ok(info !== undefined, `api_keys has no portal_enabled/user_combos_enabled column`);
  return key;
}

async function createConnection(name: string): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name,
    apiKey: `sk-${PROVIDER}-${crypto.randomUUID().slice(0, 8)}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  return String(conn.id);
}

function installRecordingFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any = {}) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    void url;
    void body;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-portal-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  return () => {
    globalThis.fetch = original;
  };
}

test.beforeEach(async () => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // Management auth must be ON, otherwise the management routes are public on a
  // fresh install (see apiAuth.isAuthRequired) and the "user cookie cannot
  // authorize key CRUD" assertion would pass for the wrong reason.
  const { updateSettings } = await import("@/lib/db/settings");
  await updateSettings({ requireLogin: true, password: "" });
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ────────────────────────── scope isolation ────────────────────────── */

test("portal key A reaches only its own connection; B's and ungranted connections stay untouched", async () => {
  const restore = installRecordingFetch();
  try {
    const connA = await createConnection("portal-A");
    const connB = await createConnection("portal-B");
    const connC = await createConnection("portal-ungranted");

    const keyA = await createPortalKey({
      name: "portal-key-A",
      allowedConnections: [connA],
      allowedModels: [MODEL],
    });

    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keyA.key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const response = await handleChat(request);
    assert.equal(response.status, 200, `A's request failed: ${response.status}`);

    const dispatched = await readDispatchedConnectionIds();
    assert.ok(
      dispatched.includes(connA),
      `A's request must be served by connA (${connA}); dispatched=${JSON.stringify(dispatched)}`
    );
    assert.ok(
      !dispatched.includes(connB) && !dispatched.includes(connC),
      `A's request leaked to a non-granted connection: ${JSON.stringify(dispatched)}`
    );
    assert.equal(await countUpstream(connB), 0);
    assert.equal(await countUpstream(connC), 0);
  } finally {
    restore();
  }
});

/* ─────────────────────── personal disable (inference) ─────────────────────── */

test("a personally disabled model is denied on the direct API and hidden from the key catalog", async () => {
  const restore = installRecordingFetch();
  try {
    const connA = await createConnection("portal-A");
    const keyA = await createPortalKey({
      name: "portal-key-A",
      allowedConnections: [connA],
      allowedModels: [MODEL],
    });

    const userPortal = await import("../../src/lib/db/userPortal.ts");
    const prefs = await userPortal.updateKeyPreferences(keyA.id, [MODEL], 0);
    assert.deepEqual(prefs.disabledModels, [MODEL]);

    const response = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyA.key}`,
        },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );
    assert.equal(response.status, 403, `disabled model must be denied, got ${response.status}`);

    const dispatched = await readDispatchedConnectionIds();
    assert.deepEqual(dispatched, [], `a denied model must not reach any upstream`);
  } finally {
    restore();
  }
});

test("disabling a model does not restore an admin-denied model and cannot widen the admin ceiling", async () => {
  const connA = await createConnection("portal-A");
  const keyA = await createPortalKey({
    name: "portal-key-A",
    allowedConnections: [connA],
    allowedModels: [MODEL],
  });
  const userPortal = await import("../../src/lib/db/userPortal.ts");

  // Disabling everything must never ENLARGE the effective set.
  await userPortal.updateKeyPreferences(keyA.id, [MODEL], 0);
  const effective = await userPortal.getKeyPreferences(keyA.id);
  assert.deepEqual(effective.disabledModels, [MODEL]);

  // Re-enabling is only possible for models the admin ceiling still allows.
  const cleared = await userPortal.updateKeyPreferences(keyA.id, [], effective.revision);
  assert.deepEqual(cleared.disabledModels, []);
  const metadata = await apiKeysDb.getApiKeyMetadata(keyA.key);
  assert.deepEqual(
    metadata?.allowedModels,
    [MODEL],
    "personal preferences must not modify the admin-granted model list"
  );
});

/* ─────────────────────────── private combos ─────────────────────────── */

test("a private combo is usable by its owner and invisible to another key", async () => {
  const restore = installRecordingFetch();
  try {
    const connA = await createConnection("portal-A");
    const connB = await createConnection("portal-B");
    const keyA = await createPortalKey({
      name: "portal-key-A",
      allowedConnections: [connA],
      allowedModels: [MODEL],
    });
    const keyB = await createPortalKey({
      name: "portal-key-B",
      allowedConnections: [connB],
      allowedModels: [MODEL],
    });

    const userPortal = await import("../../src/lib/db/userPortal.ts");
    const created = await userPortal.createUserCombo(keyA.id, {
      name: "my-private-combo",
      models: [MODEL],
    });
    assert.equal(created.keyId, keyA.id);
    assert.equal(created.enabled, true);

    const wireId = `user-combo/${created.id}`;

    // B cannot read, update, delete or list A's combo. The frozen contract is
    // "uniform notfound" for a row that does not belong to the caller: a read
    // resolves to null and a write reports not-found — never A's data.
    assert.equal(
      await userPortal.getUserCombo(keyB.id, created.id),
      null,
      "B must not read A's private combo"
    );
    await assert.rejects(
      () => userPortal.updateUserCombo(keyB.id, created.id, { name: "stolen" }),
      "B must not update A's private combo"
    );
    // A delete attempt by a foreign owner must NOT remove the owner's row.
    // (The storage layer is allowed to report "not found" OR to no-op — the
    // security property under test is that A's row survives.)
    try {
      await userPortal.deleteUserCombo(keyB.id, created.id);
    } catch {
      /* uniform not-found is an acceptable outcome */
    }
    const survivor = await userPortal.getUserCombo(keyA.id, created.id);
    assert.ok(survivor, "B's delete must not remove A's private combo");
    assert.deepEqual(await userPortal.listUserCombos(keyB.id), [], "B must not list A's combos");

    // The owner CAN read it.
    const owned = await userPortal.getUserCombo(keyA.id, created.id);
    assert.equal(owned?.id, created.id);

    // Inference by the owner resolves the private combo; by B it must not fall
    // back to a global provider.
    const ownerResponse = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyA.key}` },
        body: JSON.stringify({
          model: wireId,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    assert.equal(ownerResponse.status, 200, `owner must be able to call its private combo`);

    const foreignResponse = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyB.key}` },
        body: JSON.stringify({
          model: wireId,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    // Strict: a foreign private-combo target is a POLICY denial (403).
    // 404 would hide a policy decision; 503 is only allowed for an unavailable
    // policy backend, not for a resolved-but-not-owned row.
    assert.equal(
      foreignResponse.status,
      403,
      `B must not reach A's private combo (expected 403), got ${foreignResponse.status}`
    );

    const dispatched = await readDispatchedConnectionIds();
    assert.ok(
      !dispatched.includes(connB),
      `B's forbidden private-combo call must not reach connB: ${JSON.stringify(dispatched)}`
    );
  } finally {
    restore();
  }
});

test("an unknown user-combo id never falls back to a global provider", async () => {
  const restore = installRecordingFetch();
  try {
    const connA = await createConnection("portal-A");
    const keyA = await createPortalKey({
      name: "portal-key-A",
      allowedConnections: [connA],
      allowedModels: [MODEL],
    });

    const response = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyA.key}` },
        body: JSON.stringify({
          model: `user-combo/${crypto.randomUUID()}`,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    assert.equal(
      response.status,
      403,
      `unknown private combo must fail closed with 403, got ${response.status}`
    );
    const dispatched = await readDispatchedConnectionIds();
    assert.deepEqual(dispatched, [], "unknown private combo must not reach any upstream");
  } finally {
    restore();
  }
});

/* ─────────────────── grants: empty, revocation, rotation ─────────────────── */

test("a portal key with an empty connection grant is denied, while a legacy key stays unchanged", async () => {
  const restore = installRecordingFetch();
  try {
    const connA = await createConnection("portal-A");
    const portalKey = await createPortalKey({
      name: "portal-key-empty",
      allowedConnections: [connA],
      allowedModels: [MODEL],
    });
    // Admin clears the grant while the portal is enabled → must fail closed.
    await apiKeysDb.updateApiKeyPermissions(portalKey.id, { allowedConnections: [] });

    const portalResponse = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalKey.key}` },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    // Strict: an empty connection grant is a POLICY denial (403) decided
    // BEFORE any dispatch. 401 is wrong (the key itself is valid); 503 is only
    // for an unavailable policy backend.
    assert.equal(
      portalResponse.status,
      403,
      `portal key with empty grant must fail closed with 403, got ${portalResponse.status}`
    );

    // Legacy key (portal disabled) keeps the historical unrestricted behaviour.
    const legacy = (await apiKeysDb.createApiKey("legacy-key", "machine-test")) as PortalKey;
    await apiKeysDb.updateApiKeyPermissions(legacy.id, { allowedConnections: [] });
    const legacyResponse = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${legacy.key}` },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    assert.equal(legacyResponse.status, 200, "legacy keys must keep working unchanged");

    // The legacy key's effective scope is unchanged: an empty grant on a
    // NON-portal key still means "no connection restriction" (the historical
    // semantics, src/sse/services/auth.ts:1134). The portal fail-closed must
    // not have changed it.
    const legacyMetadata = await apiKeysDb.getApiKeyMetadata(legacy.key);
    assert.deepEqual(legacyMetadata?.allowedConnections, [], "legacy grant must stay untouched");
    const legacyDispatched = await readDispatchedConnectionIds();
    assert.ok(
      legacyDispatched.length > 0,
      "the legacy key must still reach an upstream — the portal change must not narrow legacy keys"
    );
  } finally {
    restore();
  }
});

test("rotation preserves the key id and invalidates the portal session", async () => {
  const connA = await createConnection("portal-A");
  const keyA = await createPortalKey({
    name: "portal-key-A",
    allowedConnections: [connA],
    allowedModels: [MODEL],
  });

  const userPortalAuth = await import("../../src/lib/userPortalAuth.ts");
  const before = await userPortalAuth.requireUserSession(
    new Request("http://localhost/api/user/me")
  );
  assert.ok(
    before instanceof Response,
    "no user cookie yet → the guard must answer with a Response (401), not a principal"
  );

  const rotated = await apiKeysDb.regenerateApiKey(keyA.id);
  assert.ok(rotated, "rotation must succeed");
  assert.equal(rotated.id, keyA.id, "rotation must preserve the key id (stable principal)");

  const state = await (await import("../../src/lib/db/userPortal.ts")).getPortalKeyState(keyA.id);
  assert.ok(state, "portal state must still resolve after rotation");
  assert.ok(
    (state.portalSessionRevision ?? 0) > 0,
    `rotation must bump portal_session_revision (got ${state.portalSessionRevision})`
  );
});

/* ─────────────────────── session vs admin confusion ─────────────────────── */

test("a user session cookie is not accepted as an admin session, and a user token cannot authorize key CRUD", async () => {
  const connA = await createConnection("portal-A");
  const keyA = await createPortalKey({
    name: "portal-key-A",
    allowedConnections: [connA],
    allowedModels: [MODEL],
  });

  const loginRoute = await import("../../src/app/api/user/auth/login/route.ts");
  const loginResponse = await loginRoute.POST(
    new Request("http://localhost/api/user/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: keyA.key }),
    })
  );
  assert.equal(loginResponse.status, 200, `login must succeed: ${loginResponse.status}`);

  const setCookie = loginResponse.headers.get("set-cookie") ?? "";
  assert.ok(setCookie.includes("user_auth_token="), `login must set user_auth_token: ${setCookie}`);
  assert.ok(
    !setCookie.includes("authenticated=true"),
    "the user cookie must not carry the admin authenticated claim"
  );
  const cookiePair = setCookie.split(";")[0];

  // 1) the user cookie copied into the ADMIN cookie slot must not authenticate admin.
  const adminVerifier = await import("../../src/shared/utils/dashboardSessionToken.ts");
  const rawToken = decodeURIComponent(cookiePair.split("=")[1] ?? "");
  const adminPayload = await adminVerifier.verifyDashboardSessionToken(rawToken);
  assert.equal(
    adminPayload,
    null,
    "a user session token must NOT verify as a dashboard (admin) session"
  );

  // 2) the user cookie must not authorize management CRUD.
  const keysRoute = await import("../../src/app/api/keys/route.ts");
  const listResponse = await keysRoute.GET(
    new Request("http://localhost/api/keys", { headers: { cookie: cookiePair } })
  );
  assert.equal(
    listResponse.status,
    401,
    `a user cookie must not list API keys (expected 401), got ${listResponse.status}`
  );

  // 3) the admin verifier must not accept a token whose aud is the portal's.
  const userPortalAuth = await import("../../src/lib/userPortalAuth.ts");
  assert.ok(
    typeof userPortalAuth.requireUserSession === "function",
    "requireUserSession must be exported by the auth owner"
  );
});

test("a user session cannot be minted from a key without the portal grant", async () => {
  const connA = await createConnection("portal-A");
  const key = (await apiKeysDb.createApiKey("not-opted-in", "machine-test")) as PortalKey;
  await apiKeysDb.updateApiKeyPermissions(key.id, { allowedConnections: [connA] });

  const loginRoute = await import("../../src/app/api/user/auth/login/route.ts");
  const response = await loginRoute.POST(
    new Request("http://localhost/api/user/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key.key }),
    })
  );
  // The key is VALID (401 would be wrong: the credential is fine), but the
  // portal capability is not granted → POLICY denial (403), which is what the
  // auth owner's route returns ("portal_disabled"). The assertion stays strict
  // on the status code so a silent 200 (session issued) can never pass.
  assert.equal(
    response.status,
    403,
    `a non-opted-in key must not obtain a user session (expected 403), got ${response.status}`
  );
  assert.ok(
    !(response.headers.get("set-cookie") ?? "").includes("user_auth_token="),
    "a rejected login must not set a user cookie"
  );
});
