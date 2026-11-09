import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../../fork/sync/merge-recipes.sh", import.meta.url).pathname;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** Repo mid-merge with real conflicts at the given paths. */
function initConflictRepo(files: Record<string, [string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-recipes-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  for (const [rel, [ours]] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), ours);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "side");
  for (const [rel, [, theirs]] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), theirs);
  }
  git(dir, "commit", "-qam", "side");
  git(dir, "checkout", "-q", "main");
  for (const [rel, [ours]] of Object.entries(files)) {
    const forked = rel.endsWith(".json")
      ? JSON.stringify({ ...JSON.parse(ours), forkOnly: true }, null, 2) + "\n"
      : ours + "fork\n";
    writeFileSync(join(dir, rel), forked);
  }
  git(dir, "commit", "-qam", "ours");
  try {
    git(dir, "merge", "--no-commit", "side");
  } catch {
    /* conflict expected */
  }
  return dir;
}

test("exits 1 outside a merge (no MERGE_HEAD)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-recipes-"));
  git(dir, "init", "-q");
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = (e as { status?: number }).status ?? -1;
  }
  assert.equal(code, 1, "must refuse to run outside a merge");
});

test("docs/i18n conflict resolves to theirs", () => {
  const dir = initConflictRepo({ "docs/i18n/x/README.md": ["base\n", "upstream\n"] });
  execFileSync("bash", [SCRIPT], { cwd: dir, stdio: "pipe" });
  assert.equal(readFileSync(join(dir, "docs/i18n/x/README.md"), "utf8"), "upstream\n");
});

test("messages json conflict resolves to key union", () => {
  const ours = JSON.stringify({ a: { x: 1 }, oursOnly: true }, null, 2) + "\n";
  const theirs = JSON.stringify({ a: { y: 2 }, theirsOnly: true }, null, 2) + "\n";
  const dir = initConflictRepo({ "src/i18n/messages/en.json": [ours, theirs] });
  execFileSync("bash", [SCRIPT], { cwd: dir, stdio: "pipe" });
  const merged = JSON.parse(readFileSync(join(dir, "src/i18n/messages/en.json"), "utf8"));
  assert.deepEqual(merged, { a: { x: 1, y: 2 }, forkOnly: true, oursOnly: true, theirsOnly: true });
});
