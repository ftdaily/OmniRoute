/**
 * Fork 2b: the repo-copy healthcheck script stays in sync with the deployed
 * script apart from the intended 2b env/asleep-skip additions.
 * Reads both files; no systemctl/curl execution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_COPY = path.join(process.cwd(), "fork/deploy/omniroute-healthcheck.sh");
const DEPLOYED = path.join(os.homedir(), ".local/bin/omniroute-healthcheck.sh");

function strip2b(src: string): string {
  return src
    .split("\n")
    .map((line) =>
      line
        .replace(/^UNIT=.*$/, "UNIT=<unit>")
        .replace(/^URL=.*$/, "URL=<url>")
        .replace(/^(\s*)exit 0$/, "$1exit-0")
        .replace(/^(\s*)fi$/, "$1fi-x")
    )
    .filter(
      (line) =>
        !line.includes("OMNIROUTE_HEALTHCHECK_") &&
        !line.includes("SOCKET_UNIT") &&
        !line.includes('is-active "$UNIT"') &&
        !line.includes('echo 0 > "$STATE"') &&
        !line.includes("exit-0") &&
        !line.includes("fi-x") &&
        !line.startsWith("# Fork 2b cold start") &&
        !line.startsWith("# (OMNIROUTE_HEALTHCHECK_") &&
        !line.startsWith("# backend sleeps") &&
        !line.startsWith("# A sleeping backend")
    )
    .join("\n");
}

test("healthcheck repo copy matches deployed script apart from 2b additions", () => {
  assert.ok(fs.existsSync(REPO_COPY), "repo copy must exist");
  if (!fs.existsSync(DEPLOYED)) {
    // Deployed path is a local-machine detail; on CI only the repo copy matters.
    assert.ok(
      fs.readFileSync(REPO_COPY, "utf8").includes("OMNIROUTE_HEALTHCHECK_SOCKET"),
      "repo copy must contain the asleep-skip"
    );
    return;
  }
  const repo = strip2b(fs.readFileSync(REPO_COPY, "utf8"));
  const live = strip2b(fs.readFileSync(DEPLOYED, "utf8"));
  assert.equal(repo, live, "repo copy drifted from ~/.local/bin/omniroute-healthcheck.sh");
});
