/**
 * Fork 2b v2: readiness + release-folder + user-target fixes.
 * The proxy must start only AFTER the backend listens (else first request
 * after wake gets ECONNREFUSED); the backend must run the release bundle
 * with Node 24, never the main checkout; user units must not use
 * multi-user.target or carry [Install] on socket-activated services.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "fork/deploy/systemd");

function read(name: string): string {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

test("backend runs the release bundle, never the main checkout", () => {
  const backend = read("omniroute-beta-backend.service");
  assert.ok(
    !backend.includes("/home/zuxler/OmniRoute"),
    "backend must not touch the main checkout"
  );
  assert.match(
    backend,
    /WorkingDirectory=%h\/\.local\/share\/omniroute\/beta-current/
  );
  assert.match(
    backend,
    /ExecStart=%h\/\.local\/node-v24\.15\.0\/bin\/node dev\/run-standalone\.mjs/
  );
});

test("proxy starts only after the backend is up (no ECONNREFUSED on wake)", () => {
  const proxy = read("omniroute-beta-proxy.service");
  // Requires pulls the backend into the same transaction (systemd orders
  // Requires members before their requirer); no After= (that plus the
  // backend's BindsTo= is a cyclic order — verify fails "cyclic").
  assert.match(proxy, /Requires=omniroute-beta-backend\.service/);
  assert.ok(
    !/^After=.*omniroute-beta-backend\.service$/m.test(proxy),
    "proxy must not After= the backend: ordering cycle with BindsTo"
  );
  assert.ok(
    !/^Before=omniroute-beta-backend\.service$/m.test(proxy),
    "proxy must not start Before the backend"
  );
  const backend = read("omniroute-beta-backend.service");
  assert.match(backend, /ExecStartPost=.*\/api\/health/);
  assert.match(backend, /ExecStartPost=.*20139/);
});

test("socket-activated units carry no boot wiring", () => {
  const proxy = read("omniroute-beta-proxy.service");
  assert.ok(
    !/^\[Install\]/m.test(proxy),
    "socket-activated proxy must not start at boot"
  );
  for (const name of [
    "omniroute-beta-proxy.service",
    "omniroute-beta-backend.service",
  ]) {
    const unit = read(name);
    assert.ok(
      !unit.includes("multi-user.target"),
      `${name}: multi-user.target does not exist for --user units`
    );
  }
});
