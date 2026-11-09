/**
 * Fork 2b: cold-start systemd units parse and wire correctly.
 * The socket holds the public Beta port, the proxy forwards to the internal
 * backend and exits after 15 min idle, the backend only runs when needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "fork/deploy/systemd");

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

test("beta socket holds the public port and wakes the proxy", () => {
  const socket = read("omniroute-beta.socket");
  assert.match(socket, /ListenStream=127\.0\.0\.1:20129/);
  assert.match(socket, /Accept=no/);
  // Default Service= would be omniroute-beta.service (same basename) = the
  // OLD plain beta. Pin the proxy so first connection wakes the cold path.
  assert.match(socket, /^Service=omniroute-beta-proxy\.service$/m);
});

test("beta proxy forwards to the internal backend with idle exit", () => {
  const proxy = read("omniroute-beta-proxy.service");
  assert.match(proxy, /systemd-socket-proxyd/);
  assert.match(proxy, /--exit-idle-time=15min/);
  assert.match(proxy, /127\.0\.0\.1:20139/);
  assert.match(proxy, /Requires=omniroute-beta-backend\.service/);
  assert.ok(
    !/^BindsTo=/m.test(proxy),
    "proxy must not BindsTo the backend: it holds the client socket across backend restarts"
  );
  assert.ok(
    !/^\[Install\]/m.test(proxy),
    "socket-activated proxy must not start at boot"
  );
});

test("beta backend serves the internal port and dies with the proxy", () => {
  const backend = read("omniroute-beta-backend.service");
  assert.match(backend, /Environment=PORT=20139/);
  assert.match(backend, /Environment=OMNIROUTE_PORT=20139/);
  assert.match(backend, /BindsTo=omniroute-beta-proxy\.service/);
  assert.match(backend, /dev\/run-standalone\.mjs/);
  assert.match(backend, /Environment=NODE_OPTIONS=--max-old-space-size=2048/);
  assert.ok(
    !/ExecStart=.*--max-old-space-size/.test(backend),
    "heap cap comes from NODE_OPTIONS env, not a CLI flag (flag would win)"
  );
  assert.match(backend, /Environment=DATA_DIR=\/home\/zuxler\/\.omniroute-beta/);
  // user-manager default TimeoutStartSec=15s kills the 90s readiness gate (COLD-MEASURE)
  assert.match(backend, /^TimeoutStartSec=120$/m);
});

test("p2 ram drop-in still present for the plain beta unit", () => {
  assert.ok(
    fs.existsSync(path.join(DIR, "omniroute-beta-p2-ram.conf")),
    "P2 drop-in must ship alongside the 2b units"
  );
});
