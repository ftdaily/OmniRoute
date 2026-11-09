import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    "dist/server.js": "serve",
    "dist/BUILD_SHA": "abc1234\n",
    ".build/next/BUILD_ID": "BUILDID1\n",
    ".build/next/standalone/server-ws.mjs": "ws",
    "scripts/dev/run-standalone.mjs": "run",
    "src/lib/db/migrations/001_a.sql": "create table t(x);",
    "node_modules/better-sqlite3/prebuilds/linux-x64.node": "bin",
    "node_modules/better-sqlite3/package.json": "{\"name\":\"better-sqlite3\"}",
    "node_modules/onnxruntime-web/package.json": "{}",
    "node_modules/onnxruntime-node/bin/x": "b",
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs": "m",
    "node_modules/@atjsh/llmlingua-2/dist/index.js": "l",
  });

const ROOT = new URL("../../", import.meta.url).pathname;

test("fork/deploy/pack.py stages without docs/i18n and keeps the 4 transformer paths", () => {
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

test("fork/deploy runners expose the parametrised CLI and keep the safety guards", () => {
  const specs: Record<string, string[]> = {
    "pack.py": ["stage --src", "--commit", "--build-id", "--release", "--stage-dir", "TRANSFORMER_PATHS",
      "docs/i18n", "unsafe path", "--seal", "--ledger-top"],
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
