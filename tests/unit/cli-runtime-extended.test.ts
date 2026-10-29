import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = path.join(process.cwd(), "src/shared/services/cliRuntime.ts");

const originalSpawn = childProcess.spawn;
const originalExecFileSync = childProcess.execFileSync;
const originalEnv = { ...process.env };

/**
 * Fixture-owned env keys that MUST be absent unless a case sets them. Computed
 * once at load: any of these present in a case's env is that case's doing, so
 * teardown deletes them even if the generic sweep above misses one. Covers the
 * PATH-lookup inputs (CLI_EXTRA_PATHS, per-tool BIN overrides, npm prefix,
 * config-home masks) — a leak here silently redirects the NEXT case's binary
 * resolution at a real system install instead of its fixture.
 */
const OWNED_ENV_KEYS = [
  "CLI_EXTRA_PATHS",
  "CLI_QODER_BIN",
  "CLI_CONTINUE_BIN",
  "CLI_CLAUDE_BIN",
  "CLI_CLINE_BIN",
  "CLI_DROID_BIN",
  "CLI_CONFIG_HOME",
  "CLI_MODE",
  "SHELL",
  "npm_config_prefix",
] as const;
const OWNED_ABSENT_AT_LOAD = (OWNED_ENV_KEYS as readonly string[]).filter(
  (key) => !(key in originalEnv)
);

const tempDirs = new Set<string>();

async function importFresh(label) {
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}-${Math.random()}`);
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  // Owned-key belt-and-braces: Object.assign() restores values but can never
  // delete keys, so explicitly drop fixture-owned keys that were absent at
  // load — a leaked CLI_EXTRA_PATHS (or sibling override) would otherwise
  // survive into the next case and shadow its fixture (the suspicious-size
  // case resolving a real system binary instead of the empty fixture).
  for (const key of OWNED_ABSENT_AT_LOAD) delete process.env[key];
  Object.assign(process.env, originalEnv);
}

function createTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function writeScript(dir, name, content, executable = true) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, executable ? 0o755 : 0o644);
  }
  return filePath;
}

test.afterEach(() => {
  childProcess.spawn = originalSpawn;
  childProcess.execFileSync = originalExecFileSync;
  syncBuiltinESMExports();
  restoreEnv();

  for (const dir of tempDirs) {
    fs.rmSync(dir as any, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tempDirs.clear();
});

test("CLI config helpers enforce safe config homes and expose per-tool config paths", async () => {
  const cliRuntime = await importFresh("config-helpers");
  const homeDir = os.homedir();
  const safeOverride = path.join(homeDir, "tmp-cli-config-home");

  process.env.CLI_ALLOW_CONFIG_WRITES = "off";
  assert.equal(cliRuntime.isCliConfigWriteAllowed(), false);
  assert.match(cliRuntime.ensureCliConfigWriteAllowed(), /CLI_ALLOW_CONFIG_WRITES=false/);

  process.env.CLI_CONFIG_HOME = safeOverride;
  assert.equal(cliRuntime.getCliConfigHome(), safeOverride);

  process.env.CLI_CONFIG_HOME = "relative/path";
  assert.equal(cliRuntime.getCliConfigHome(), homeDir);

  process.env.CLI_CONFIG_HOME = "/tmp/outside-home";
  assert.equal(cliRuntime.getCliConfigHome(), homeDir);

  process.env.CLI_CONFIG_HOME = safeOverride;
  assert.deepEqual(cliRuntime.getCliConfigPaths("codex"), {
    config: path.join(safeOverride, ".codex", "config.toml"),
    auth: path.join(safeOverride, ".codex", "auth.json"),
  });
  assert.equal(
    cliRuntime.getCliPrimaryConfigPath("codex"),
    path.join(safeOverride, ".codex", "config.toml")
  );
  assert.equal(cliRuntime.getCliConfigPaths("unknown"), null);

  process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config-test");
  // #3330: OpenCode uses XDG (`~/.config` / $XDG_CONFIG_HOME) on every platform,
  // including Windows — no %APPDATA% special-case.
  const expectedOpencodeRoot = process.env.XDG_CONFIG_HOME;
  assert.deepEqual(cliRuntime.getCliConfigPaths("opencode"), {
    config: path.join(expectedOpencodeRoot, "opencode", "opencode.json"),
  });
});

test("Devin config resolver does not prepend the home directory twice", async () => {
  if (process.platform === "win32") return;
  delete process.env.CLI_CONFIG_HOME;
  const cliRuntime = await importFresh("devin-config-path");

  assert.deepEqual(cliRuntime.getCliConfigPaths("devin"), {
    config: path.join(os.homedir(), ".config", "devin", "config.json"),
  });
});

test("getCliRuntimeStatus rejects unsafe env overrides and reports validated runtime mode", async () => {
  process.env.CLI_MODE = "container";
  process.env.CLI_CLAUDE_BIN = "relative/claude";

  const cliRuntime = await importFresh("unsafe-env-command");
  const status = await cliRuntime.getCliRuntimeStatus("claude");

  assert.equal(status.installed, false);
  assert.equal(status.runnable, false);
  assert.equal(status.reason, "unsafe_path");
  assert.equal(status.runtimeMode, "container");
  assert.equal(status.requiresBinary, true);
});

test("getCliRuntimeStatus reports not_executable for absolute env override files without execute permission", async () => {
  const tempDir = createTempDir("omniroute-cli-notexec-");
  const scriptName = process.platform === "win32" ? "codex.cmd" : "codex";
  const scriptPath = writeScript(
    tempDir,
    scriptName,
    process.platform === "win32"
      ? "@echo off\r\necho codex 1.0.0\r\nREM padding padding padding\r\n"
      : "#!/bin/sh\necho codex 1.0.0\n# padding padding padding\n",
    false
  );

  process.env.CLI_CODEX_BIN = scriptPath;
  const cliRuntime = await importFresh("not-executable");
  const status = await cliRuntime.getCliRuntimeStatus("codex");

  assert.equal(status.installed, true);
  if (process.platform === "win32") {
    assert.equal(status.runnable, true);
    assert.equal(status.reason, null);
  } else {
    assert.equal(status.runnable, false);
    assert.equal(status.reason, "not_executable");
  }
  assert.equal(status.commandPath, scriptPath);
});

test("getCliRuntimeStatus reports healthcheck_failed when a binary exists but does not answer version probes", async () => {
  const tempDir = createTempDir("omniroute-cli-healthcheck-");
  const scriptName = process.platform === "win32" ? "qodercli.cmd" : "qodercli";
  const scriptPath = writeScript(
    tempDir,
    scriptName,
    process.platform === "win32"
      ? "@echo off\r\nexit /b 1\r\nREM padding padding padding\r\n"
      : "#!/bin/sh\nexit 1\n# padding padding padding\n"
  );

  process.env.CLI_QODER_BIN = scriptPath;
  process.env.CLI_MODE = "invalid-mode";
  const cliRuntime = await importFresh("healthcheck-failed");
  const status = await cliRuntime.getCliRuntimeStatus("qoder");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, false);
  assert.equal(status.reason, "healthcheck_failed");
  assert.equal(status.runtimeMode, "auto");
});

test("getCliRuntimeStatus healthchecks Windows .exe paths with spaces without shell", async () => {
  if (process.platform !== "win32") return;

  const tempDir = path.join(createTempDir("omniroute-cli-space-"), "dir with space");
  const scriptPath = writeScript(
    tempDir,
    "claude.exe",
    "fake executable content padding padding padding"
  );
  const spawnCalls = [];

  process.env.CLI_CLAUDE_BIN = scriptPath;
  childProcess.spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", "2.1.157 (Claude Code)\n");
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("windows-exe-space-no-shell");
  const status = await cliRuntime.getCliRuntimeStatus("claude");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, true);
  assert.equal(status.reason, null);
  assert.equal(status.commandPath, scriptPath);
  assert.equal(spawnCalls[0].command, scriptPath);
  assert.deepEqual(spawnCalls[0].args, ["--version"]);
  assert.equal(spawnCalls[0].options.shell, undefined);
});

test("getCliRuntimeStatus still healthchecks Windows .cmd wrappers through shell", async () => {
  if (process.platform !== "win32") return;

  const tempDir = createTempDir("omniroute-cli-cmd-shell-");
  const scriptPath = writeScript(
    tempDir,
    "codex.cmd",
    "@echo off\r\necho codex 1.2.3\r\nREM padding padding padding\r\n"
  );
  const spawnCalls = [];

  process.env.CLI_CODEX_BIN = scriptPath;
  childProcess.spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", "codex 1.2.3\n");
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("windows-cmd-shell");
  const status = await cliRuntime.getCliRuntimeStatus("codex");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, true);
  assert.equal(status.reason, null);
  // The command is passed to spawn unquoted — Node quotes it for cmd.exe when
  // shell:true. We must NOT manually interpolate quotes (hard rule #13).
  assert.equal(spawnCalls[0].command, scriptPath);
  assert.deepEqual(spawnCalls[0].args, ["--version"]);
  assert.equal(spawnCalls[0].options.shell, true);
});

test("shouldUseShellForCommand never uses the shell on non-Windows platforms", async () => {
  if (process.platform === "win32") return;
  const cliRuntime = await importFresh("should-use-shell-posix");
  for (const cmd of ["/usr/bin/claude", "/opt/My App/claude.exe", "tool.cmd", "x.bat"]) {
    assert.equal(
      cliRuntime.shouldUseShellForCommand(cmd),
      false,
      `expected no shell on POSIX for: ${cmd}`
    );
  }
});

test("getCliRuntimeStatus discovers binaries from CLI_EXTRA_PATHS during PATH lookup", async () => {
  const tempDir = createTempDir("omniroute-cli-extra-path-");
  const scriptName = process.platform === "win32" ? "qodercli.cmd" : "qodercli";
  writeScript(
    tempDir,
    scriptName,
    process.platform === "win32"
      ? "@echo off\r\necho qodercli 1.2.3\r\nREM padding padding padding\r\n"
      : "#!/bin/sh\necho qodercli 1.2.3\n# padding padding padding\n"
  );

  process.env.CLI_EXTRA_PATHS = tempDir;
  process.env.PATH = process.platform === "win32" ? process.env.PATH || "" : "/bin:/usr/bin";

  const cliRuntime = await importFresh("extra-paths");
  const status = await cliRuntime.getCliRuntimeStatus("qoder");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, true);
  assert.equal(status.reason, null);
  assert.equal(
    path.basename(String(status.commandPath)).toLowerCase(),
    process.platform === "win32" ? "qodercli.cmd" : "qodercli"
  );
});

test("getCliRuntimeStatus resolves known binaries from npm global prefix discovered via npm config", async () => {
  const prefixDir = createTempDir("omniroute-cli-prefix-");
  const scriptName = process.platform === "win32" ? "qodercli.cmd" : "qodercli";
  const scriptPath = writeScript(
    path.join(prefixDir, process.platform === "win32" ? "" : "bin"),
    scriptName,
    process.platform === "win32"
      ? "@echo off\r\necho qodercli 1.2.3\r\nREM padding padding padding\r\n"
      : "#!/bin/sh\necho qodercli 1.2.3\n# padding padding padding\n"
  );

  delete process.env.npm_config_prefix;
  process.env.PATH = process.platform === "win32" ? process.env.PATH || "" : "/bin:/usr/bin";
  childProcess.execFileSync = (command, args) => {
    assert.equal(command, "npm");
    assert.deepEqual(args, ["config", "get", "prefix"]);
    return `${prefixDir}\n`;
  };
  syncBuiltinESMExports();

  // #12565 moved npm-prefix detection (and its process-lifetime success cache) into
  // cliRuntimeNpmPrefix.ts. importFresh() only re-evaluates cliRuntime.ts; that module
  // is shared, so an earlier case's cached prefix would bypass this case's mock.
  const npmPrefixModule = await import("../../src/shared/services/cliRuntimeNpmPrefix.ts");
  npmPrefixModule.__resetNpmGlobalPrefixCacheForTests();
  const cliRuntime = await importFresh("npm-prefix-known-path");
  const status = await cliRuntime.getCliRuntimeStatus("qoder");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, true);
  assert.equal(status.reason, null);
  assert.equal(status.commandPath, scriptPath);
});

test("getCliRuntimeStatus ignores suspicious known-path binaries and symlink escapes", async () => {
  // Mask the operator's real HOME: known-path candidates include
  // ~/.local/bin/<tool>, and a real install there would shadow the empty
  // suspicious fixture below (installed:true) making this machine-dependent.
  // Point HOME at a fresh empty dir; npm_config_prefix still injects the
  // fixture candidate. Restored in afterEach via restoreEnv.
  const emptyHome = createTempDir("omniroute-cli-no-home-");
  process.env.HOME = emptyHome;
  const prefixDir = createTempDir("omniroute-cli-suspicious-");
  const binDir = path.join(prefixDir, process.platform === "win32" ? "" : "bin");
  const scriptName = process.platform === "win32" ? "qodercli.exe" : "qodercli";
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, scriptName), "");

  process.env.npm_config_prefix = prefixDir;
  process.env.PATH = process.platform === "win32" ? process.env.PATH || "" : "/bin:/usr/bin";
  // Neutralize login-shell PATH enrichment for this case: getLookupEnv merges
  // the cached `$SHELL -ilc` PATH (which on a dev machine contains the real
  // ~/.local/bin install) into the lookup env, so the real qodercli would
  // shadow the empty suspicious fixture via PATH. An invalid SHELL fails the
  // allowlist regex so getLoginShellPath returns null — pure fixture, and the
  // shared cache is per-process (already populated or not, the null comes from
  // the regex gate before any spawn). Restored by the owned-keys teardown.
  process.env.SHELL = "invalid shell for tests";

  // Same shared-cache reset as the npm-prefix case above: cliRuntimeNpmPrefix.ts
  // is NOT re-evaluated by importFresh(), so without this the previous case's
  // cached healthy prefix would shadow this case's npm_config_prefix fixture.
  // Same for the login-shell PATH cache (loginShellPath.ts singleton): reset it
  // while SHELL is masked so the re-computed value is null, not the real login
  // PATH (which contains the operator's genuine ~/.local/bin install).
  const npmPrefixModule = await import("../../src/shared/services/cliRuntimeNpmPrefix.ts");
  npmPrefixModule.__resetNpmGlobalPrefixCacheForTests();
  const loginShellModule = await import("../../src/shared/services/loginShellPath.ts");
  loginShellModule.__resetLoginShellPathCacheForTests();
  const cliRuntime = await importFresh("suspicious-size");
  const suspiciousStatus = await cliRuntime.getCliRuntimeStatus("qoder");

  assert.equal(suspiciousStatus.installed, false);
  assert.equal(suspiciousStatus.reason, "suspicious_size");

  if (process.platform !== "win32") {
    const escapePrefix = createTempDir("omniroute-cli-escape-");
    const escapeBinDir = path.join(escapePrefix, "bin");
    const outsideDir = createTempDir("omniroute-cli-outside-");
    const outsideTarget = writeScript(
      outsideDir,
      "qodercli",
      "#!/bin/sh\necho qodercli 9.9.9\n# padding padding padding\n"
    );

    fs.mkdirSync(escapeBinDir, { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(escapeBinDir, "qodercli"));
    process.env.npm_config_prefix = escapePrefix;

    // #7753: every candidate checkKnownPath() ever receives is constructed by
    // getKnownToolPaths() from a trusted root (here: npm_config_prefix/bin) — so a
    // symlink placed exactly at that generated candidate path (the version-manager
    // shim pattern used by nvm-windows/nvm/asdf/pyenv: trusted shim location,
    // private per-version store target) is legitimate and must now be ACCEPTED even
    // though its resolved target lives outside every EXPECTED_PARENT_PATHS entry.
    // A genuinely unsafe symlink (one whose ORIGINAL location is also untrusted, not
    // reachable through this known-path candidate generator) is covered separately
    // by tests/unit/cliRuntime-symlink-escape-7753.test.ts via the exported
    // checkKnownPath().
    const escapedRuntime = await importFresh("symlink-escape");
    const escapedStatus = await escapedRuntime.getCliRuntimeStatus("qoder");

    assert.equal(escapedStatus.installed, true);
    assert.equal(escapedStatus.reason, null);
  }
});

test("getCliRuntimeStatus tolerates spawn errors during healthcheck and marks the tool as not runnable", async () => {
  const tempDir = createTempDir("omniroute-cli-spawn-error-");
  const scriptName = process.platform === "win32" ? "cline.cmd" : "cline";
  const scriptPath = writeScript(
    tempDir,
    scriptName,
    process.platform === "win32"
      ? "@echo off\r\necho cline\r\nREM padding padding padding\r\n"
      : "#!/bin/sh\necho cline\n# padding padding padding\n"
  );

  process.env.CLI_CLINE_BIN = scriptPath;
  childProcess.spawn = () => {
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => child.emit("error", new Error("spawn blocked")));
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("spawn-error");
  const status = await cliRuntime.getCliRuntimeStatus("cline");

  assert.equal(status.installed, true);
  assert.equal(status.runnable, false);
  assert.equal(status.reason, "healthcheck_failed");
});
