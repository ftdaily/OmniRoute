import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DEPLOY = new URL("../../fork/deploy/", import.meta.url).pathname;

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-deploy-"));
  for (const [rel, contents] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, contents);
  }
  return dir;
}

const SRC = () =>
  fixture({
    ".build/next/BUILD_ID": "BUILDID1\n",
    ".build/next/standalone/BUILD_SHA": "abc1234\n",
    ".build/next/standalone/server.js": "serve",
    ".build/next/standalone/server-ws.mjs": "ws",
    ".build/next/standalone/dev/run-standalone.mjs": "run",
    ".build/next/standalone/build/runtime-env.mjs": "env",
    ".build/next/standalone/build/bootstrap-env.mjs": "env",
    ".build/next/standalone/responses-ws-proxy.mjs": "p",
    ".build/next/standalone/peer-stamp.mjs": "p",
    ".build/next/standalone/systemd-notify.mjs": "p",
    ".build/next/standalone/http-method-guard.cjs": "g",
    ".build/next/standalone/head-response-guard.cjs": "g",
    ".build/next/standalone/h2c-upgrade-guard.cjs": "g",
    ".build/next/standalone/httpClientAbortGuard.mjs": "g",
    ".build/next/standalone/main-server-timeouts.mjs": "g",
    ".build/next/standalone/tls-options.mjs": "g",
    ".build/next/standalone/webdav-handler.mjs": "g",
    ".build/next/standalone/.build/next/required-server-files.json": "{}",
    ".build/next/standalone/.build/next/routes-manifest.json": "{}",
    ".build/next/standalone/.build/next/static/x.css": "css",
    ".build/next/standalone/package.json": "{}",
    ".build/next/standalone/BUILD_OMNIROUTE_BASE_PATH": "/",
    ".build/next/standalone/.build/next/BUILD_ID": "BUILDID1\n",
    ".build/next/standalone/migrations/001_a.sql": "create table t(x);",
    ".build/next/standalone/node_modules/better-sqlite3/prebuilds/linux-x64.node": "bin",
    ".build/next/standalone/node_modules/onnxruntime-web/package.json": "{}",
    ".build/next/standalone/node_modules/onnxruntime-node/bin/x": "b",
    ".build/next/standalone/node_modules/@huggingface/transformers/dist/transformers.node.mjs": "m",
    ".build/next/standalone/node_modules/@atjsh/llmlingua-2/dist/index.js": "l",
    ".build/next/standalone/docs/i18n/vi/x.md": "should be excluded",
  });

const ROOT = new URL("../../", import.meta.url).pathname;

test("fork/deploy/pack.py stages standalone minus docs/i18n and keeps the 4 transformer paths", () => {
  const src = SRC();
  const out = mkdtempSync(join(tmpdir(), "fork-deploy-out-"));
  const release = "abc1234-BUILDID1-test";
  try {
    execFileSync(
      "python3",
      [
        join(DEPLOY, "pack.py"),
        "stage",
        "--src",
        src,
        "--commit",
        "abc1234",
        "--build-id",
        "BUILDID1",
        "--release",
        release,
        "--stage-dir",
        join(out, "stage"),
        "--node",
        process.execPath,
        // Fixture stage carries a stub better-sqlite3 prebuild (no native
        // build in CI): skip only the in-stage load check. Real releases
        // keep it ON (flag defaults off in pack.py).
        "--skip-native-check",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // The fixture's better-sqlite3 is a stub file; resolve the driver's
        // real package from the repo checkout for the load check.
        env: { ...process.env, NODE_PATH: join(ROOT, "node_modules") },
      }
    );
    const list: string[] = JSON.parse(
      execFileSync(
        "python3",
        [join(DEPLOY, "pack.py"), "list", "--stage-dir", join(out, "stage")],
        { encoding: "utf8" }
      )
    );
    assert.ok(!list.some((p) => p === "docs/i18n" || p.startsWith("docs/i18n/")));
    assert.ok(!list.some((p) => p.split("/").includes(".bin")),
      "node_modules/.bin leaked into stage");
    for (const p of [
      "node_modules/onnxruntime-web",
      "node_modules/onnxruntime-node/bin",
      "node_modules/@huggingface/transformers/dist",
      "node_modules/@atjsh/llmlingua-2/dist",
    ]) {
      assert.ok(list.some((q) => q === p || q.startsWith(p + "/")), `missing ${p}`);
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.fail(`pack.py stage/list failed (RED until fork/deploy/pack.py lands): ${e.stderr ?? e.stdout ?? err}`);
  }
});

test("fork/deploy pack.py stages the standalone tree and enforces the 700 MB budget", () => {
  const body = readFileSync(join(DEPLOY, "pack.py"), "utf8");
  // Budget constant the test below drives through a real pack run.
  assert.ok(body.includes("SIZE_BUDGET_BYTES = 700 * 1024 * 1024"), "pack.py missing 700 MB budget const");
  for (const needle of [
    "STANDALONE_SUBDIR", '"docs/i18n"', "REQUIRED_PATHS",
    "SIZE_BUDGET_BYTES", "exceeds size budget", "--size-budget-bytes",
  ]) {
    assert.ok(body.includes(needle), `pack.py missing: ${needle}`);
  }
  // Safe-tar-paths assert must live in pack() too, not only in the runners.
  const packFn = body.slice(body.indexOf("def pack("));
  assert.ok(packFn.includes("unsafe path"), "pack() missing the safe-tar-paths assert");
});

test("fork/deploy pack.py pack rejects an over-budget stage", () => {
  const src = SRC();
  const out = mkdtempSync(join(tmpdir(), "fork-deploy-budget-"));
  const release = "abc1234-BUILDID1-budget";
  const stageDir = join(out, "stage");
  execFileSync(
    "python3",
    [join(DEPLOY, "pack.py"), "stage", "--src", src, "--commit", "abc1234",
     "--build-id", "BUILDID1", "--release", release, "--stage-dir", stageDir,
     "--node", process.execPath, "--skip-native-check"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_PATH: join(ROOT, "node_modules") } }
  );
  // Pad the stage past the budget with an innocuous file, then pack with a
  // tiny budget: pack must refuse instead of writing the tarball.
  writeFileSync(join(stageDir, "budget-padding.bin"), Buffer.alloc(2048, 7));
  let errText = "";
  try {
    execFileSync(
      "python3",
      [join(DEPLOY, "pack.py"), "pack", "--stage-dir", stageDir, "--src", src,
       "--release", release, "--out-dir", join(out, "rollout"),
       "--size-budget-bytes", "1024"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    const e = err as { stderr?: string };
    errText = String(e.stderr ?? err);
  }
  assert.ok(errText.includes("exceeds size budget"), `pack accepted an over-budget stage: ${errText.slice(0, 200)}`);
  assert.ok(!existsSync(join(out, "rollout", `${release}.tar.gz`)), "over-budget tarball was written");
});
test("fork/deploy pack.py emits flat entries (no <release>/ prefix)", () => {
  const src = SRC();
  const out = mkdtempSync(join(tmpdir(), "fork-deploy-flat-"));
  const release = "abc1234-BUILDID1-flat";
  const stageDir = join(out, "stage");
  execFileSync(
    "python3",
    [join(DEPLOY, "pack.py"), "stage", "--src", src, "--commit", "abc1234",
     "--build-id", "BUILDID1", "--release", release, "--stage-dir", stageDir,
     "--node", process.execPath, "--skip-native-check"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_PATH: join(ROOT, "node_modules") } }
  );
  execFileSync(
    "python3",
    [join(DEPLOY, "pack.py"), "pack", "--stage-dir", stageDir, "--src", src,
     "--release", release, "--out-dir", join(out, "rollout")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const tarball = join(out, "rollout", `${release}.tar.gz`);
  assert.ok(existsSync(tarball), "pack wrote no tarball");
  const entries: string = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  const names = entries.split("\n").filter((l) => l.length > 0).map((l) => l.replace(/^\.\//, ""));
  assert.ok(!names.some((n) => n === release || n.startsWith(release + "/")),
    `tarball nests under <release>/ (releases/X/X/ on install): ${names.slice(0, 3).join(", ")}`);
  for (const p of [
    "node_modules/onnxruntime-web",
    "node_modules/onnxruntime-node/bin",
    "node_modules/@huggingface/transformers/dist",
    "node_modules/@atjsh/llmlingua-2/dist",
  ]) {
    assert.ok(names.some((n) => n === p || n.startsWith(p + "/")), `missing flat ${p}`);
  }
});
test("fork/deploy runners expose the parametrised CLI and keep the safety guards", () => {
  const specs: Record<string, string[]> = {
    "pack.py": ["stage --src", "--commit", "--build-id", "--release", "--stage-dir", "TRANSFORMER_PATHS",
      "STANDALONE_SUBDIR", "unsafe path", "--seal", "--ledger-top"],
    "local-release.py": ["--work-dir", "--unit", "--beta-unit", "--releases-root", "--stable-port",
      "--beta-port", "--approval", "--new-tables", "--heap-mb", "refusing to stop foreign unit",
      "backup API (never raw WAL copy)", "EnvironmentFile 0600", "LOCAL_METADATA_ROLLBACK_OK", "--help-policy"],
    "tencent-release.py": ["--work-dir", "--current", "--releases", "--data", "--migr-sub", "--drop",
      "--clone-dir", "--min-free-gb", "--min-avail-mb", "--migration-230", "--migration-231",
      "--ledger-top", "atomic symlink swap", "TENCENT_METADATA_ROLLBACK_OK", "--help-policy"],
  };
  for (const [script, needles] of Object.entries(specs)) {
    const body = readFileSync(join(DEPLOY, script), "utf8");
    assert.ok(body.length > 1000, `${script} looks stubbed`);
    for (const needle of needles) assert.ok(body.includes(needle), `${script} missing: ${needle}`);
  }
  // No hardcoded per-release identity: commit/build/release travel via --commit/--build-id/--release.
  for (const script of ["pack.py", "local-release.py", "tencent-release.py"]) {
    const body = readFileSync(join(DEPLOY, script), "utf8");
    assert.ok(!body.includes("cf4344ad2f") && !body.includes("CJvDF3DomnMxXLvOowleM"),
      `${script} hardcodes the 3854 release`);
  }
  // Host identity stays in CLI args, never in code: no IPs, no bearer tokens.
  for (const script of ["pack.py", "local-release.py", "tencent-release.py"]) {
    const body = readFileSync(join(DEPLOY, script), "utf8");
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(body.replaceAll("127.0.0.1", "")),
      `${script} embeds a host IP`);
    assert.ok(!/ghp_|github_pat_|xox[bpas]-/i.test(body), `${script} embeds a token-shaped secret`);
  }
});
