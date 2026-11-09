#!/usr/bin/env python3
"""Fork artifact packager (Phase 1.1/1.2). Parametrised copy of the scratch
pack-3854b.py (which supersedes pack-3854.py): stage is a COPY of
.build/next/standalone — never the tracked tree, never dist/.

Usage:
  pack.py stage --src <repo> --commit <sha> --build-id <id> --release <name>
      [--stage-dir DIR] [--node PATH] [--ledger-top N]
  pack.py pack  --stage-dir DIR --src <repo> --release <name> --out-dir DIR
      [--seal] [--size-budget-bytes N]
  pack.py list  --stage-dir DIR   # JSON array of staged relative paths (tests)
  pack.py smoke --artifact <artifact.json> --out-dir DIR [--node PATH] [--port N]
      --ledger-top N

Rules (mirroring pack-3854b.py):
- stage: copy .build/next/standalone, prune .env* + secrets + DBs +
  .build/next/{trace,trace-build,cache,.cache} + *.nft.json/*.tsbuildinfo,
  drop docs/i18n (Phase 1.2: English docs ship, translations fall back),
  old-release parity, no external/broken symlinks.
- stage: the 4 transformer paths must exist in STAGE (Phase 1.2 gate).
- stage: better-sqlite3 load check resolves INSIDE the stage.
- pack: gzip -1 atomic (.part + rename), safe relative paths only,
  fail-closed SIZE_BUDGET_BYTES ceiling (default 700 MB).
- smoke: full wrapper on a private port + temp DATA_DIR, health 200, ledger top.
- No secrets: nothing is read from or written to .env here; the release runner
  allowlists secret NAMES and ships values via EnvironmentFile 0600.
"""
import argparse
import gzip
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_NODE = "/home/zuxler/.local/node-v24.15.0/bin/node"

TRANSFORMER_PATHS = [
    "node_modules/onnxruntime-web",
    "node_modules/onnxruntime-node/bin",
    "node_modules/@huggingface/transformers/dist",
    "node_modules/@atjsh/llmlingua-2/dist",
]

# Compressed-tarball ceiling. Old artifact a18d735d = 543 MB with docs/i18n
# aboard; minus docs/i18n plus code growth the combined tree must stay well
# under this. pack() refuses to write the tarball past it (fail-closed).
SIZE_BUDGET_BYTES = 700 * 1024 * 1024

# Required entrypoints/asserts inside the standalone tree (mirrors
# pack-3854b.py `required`). server.js + server-ws.mjs at the standalone root,
# runner at dev/run-standalone.mjs, nested build manifest + BUILD_ID.
REQUIRED_PATHS = [
    "server.js", "server-ws.mjs", "dev/run-standalone.mjs",
    "build/runtime-env.mjs", "build/bootstrap-env.mjs",
    "responses-ws-proxy.mjs", "peer-stamp.mjs", "systemd-notify.mjs",
    "http-method-guard.cjs", "head-response-guard.cjs",
    "h2c-upgrade-guard.cjs", "httpClientAbortGuard.mjs",
    "main-server-timeouts.mjs", "tls-options.mjs", "webdav-handler.mjs",
    ".build/next/BUILD_ID", ".build/next/required-server-files.json",
    ".build/next/routes-manifest.json", "package.json",
    "BUILD_OMNIROUTE_BASE_PATH",
]

# Tracked-tree subdirs that never ship. Kept for --help/docs honesty: the
# standalone stager never walks the tracked tree, so these are belt-and-braces
# if a future caller re-adds a tracked-tree pass.
EXTRA_SKIP_DIRS = {"dist", "tests"}

# Private/secret names pruned at stage ROOT (mirrors pack-3854b.py prohibited
# level-1 set): .env* + credentials + keys + DBs. .git is not copied at all.
PROHIBITED_ROOT_NAMES = {
    ".env", ".codegraph", ".trail", ".git", ".cache", "cache",
    "server.env", "credentials.json", "secrets.json", "token.json",
    "tokens.json", "id_rsa", "id_ed25519",
}

# Build-output prunes inside .build/next (mirrors pack-3854b.py level-2/3):
# trace dirs, caches, nft manifests, tsbuildinfo droppings.
TRACE_PRUNE_NAMES = {"trace", "trace-build", "cache", ".cache"}
TRACE_PRUNE_SUFFIXES = (".nft.json", ".tsbuildinfo")


def _is_prohibited(stage: Path, p: Path) -> bool:
    """Mirrors pack-3854b.py `prohibited`: root-level secrets/DBs/keys,
    plus .build/next trace/cache/nft/tsbuildinfo droppings."""
    rel = p.relative_to(stage)
    name = p.name
    if len(rel.parts) == 1:
        low = name.lower()
        return (low in PROHIBITED_ROOT_NAMES or low.startswith(".env.")
                or low.endswith((".db", ".db-wal", ".db-shm", ".sqlite",
                                 ".sqlite3", ".sqlite-wal", ".sqlite-shm",
                                 ".sqlite3-wal", ".sqlite3-shm",
                                 ".pem", ".key", ".tsbuildinfo")))
    if rel.parts[:2] == (".build", "next") and len(rel.parts) == 3:
        low = name.lower()
        return (low in TRACE_PRUNE_NAMES
                or low.endswith(TRACE_PRUNE_SUFFIXES))
    return False

EXTRA_COPY = [
    ".build/next",
    "src/lib/db/migrations",
    "scripts/dev/run-standalone.mjs",
    ".build/next/standalone/server-ws.mjs",
]

STANDALONE_SUBDIR = Path(".build/next/standalone")


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout.strip()


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def stage(src, commit, build_id, release, stage_dir, node, ledger_top=None):
    src = Path(src)
    stage = Path(stage_dir)
    standalone = src / STANDALONE_SUBDIR
    assert standalone.is_dir(), f"standalone not built: {standalone}"
    assert (standalone / "BUILD_SHA").read_text().strip() == commit, "BUILD_SHA mismatch"
    assert (standalone / ".build/next/BUILD_ID").read_text().strip() == build_id, "BUILD_ID mismatch"
    if stage.exists():
        shutil.rmtree(stage)
    # Stage = copy of .build/next/standalone (mirrors pack-3854b.py). The
    # Next standalone bundler already selects the runtime closure
    # (production node_modules subset, no .bin farm, no dev bins, no tests,
    #  no dist/); stage prunes only what the bundler leaves behind.
    # copytree creates the target itself: no mkdir here.
    shutil.copytree(standalone, stage, symlinks=True)
    # Phase 1.2: drop docs/i18n (English docs ship, translations fall back).
    i18n = stage / "docs/i18n"
    if i18n.exists():
        shutil.rmtree(i18n) if i18n.is_dir() and not i18n.is_symlink() else i18n.unlink()
    removed = []
    for base, dirs, files in os.walk(stage, topdown=True):
        for name in list(dirs) + files:
            p = Path(base) / name
            if _is_prohibited(stage, p):
                removed.append(str(p.relative_to(stage)))
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p)
                else:
                    p.unlink()
                if name in dirs:
                    dirs.remove(name)
    for req in REQUIRED_PATHS:
        assert (stage / req).is_file(), f"missing required path: {req}"
    assert any((stage / ".build/next/static").rglob("*.css")), "no compiled CSS"
    for tp in TRANSFORMER_PATHS:
        assert (stage / tp).exists(), f"transformer path missing: {tp}"
    links = []
    for base, dirs, files in os.walk(stage):
        for name in dirs + files:
            p = Path(base) / name
            assert not _is_prohibited(stage, p), f"prohibited survivor: {p}"
            if p.is_symlink():
                assert p.resolve().is_relative_to(stage.resolve()), f"external symlink {p}"
                assert p.exists(), f"broken symlink {p}"
                links.append(str(p.relative_to(stage)))
    assert (stage / ".build/next/BUILD_ID").read_text().strip() == build_id
    run([node, "-e", "const D=require('better-sqlite3');let d=new D(':memory:');"
                      "if(d.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);d.close()"],
        cwd=stage)
    print("STAGED", release, "files=",
          sum(1 for _ in stage.rglob("*") if _.is_file()),
          "removed=" + str(len(removed)), "links=" + str(len(links)))


def pack(stage_dir, src, release, out_dir, seal=False, size_budget_bytes=SIZE_BUDGET_BYTES):
    src = Path(src)
    stage = Path(stage_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f"{release}.tar.gz"
    part = archive.with_suffix(".tar.gz.part")
    assert stage.is_dir(), "run stage first"
    with open(part, "wb") as raw:
        with gzip.GzipFile(filename=f"{release}.tar", mode="wb", compresslevel=1,
                           fileobj=raw, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tf:
                for p in sorted(stage.rglob("*")):
                    a = p.relative_to(stage)
                    if ".." in a.parts or a.is_absolute():
                        raise RuntimeError("unsafe path " + str(a))
                    tf.add(p, arcname=str(Path(release) / a), recursive=False)
    part.rename(archive)
    size = archive.stat().st_size
    if size > size_budget_bytes:
        archive.unlink()
        raise RuntimeError(
            f"artifact exceeds size budget: {size} > {size_budget_bytes} "
            f"({size // 1024 // 1024}MB > {size_budget_bytes // 1024 // 1024}MB); "
            "prune the stage (node_modules/.bin, dist/, tests/) and repack")
    proc = subprocess.run(["bash", "-c", "ls src/lib/db/migrations/*.sql | sort | sha256sum"],
                          capture_output=True, text=True, cwd=src)
    art = {"archive": str(archive), "sha256": sha(archive), "size": size,
           "release": release, "migrations": proc.stdout.split()[0]}
    if seal:
        art["sealed"] = True
    (out / "artifact.json").write_text(json.dumps(art, indent=2) + "\n")
    print("PACKED", archive.name, size, art["sha256"][:16])


def list_stage(stage_dir):
    stage = Path(stage_dir)
    print(json.dumps(sorted(str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file())))


def health(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def smoke(artifact, out_dir, node, port, ledger_top):
    art = json.loads(Path(artifact).read_text())
    archive = Path(art["archive"])
    assert archive.is_file() and sha(archive) == art["sha256"]
    target = Path(out_dir)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(mode=0o700)
    run(["tar", "-xzf", str(archive), "-C", str(target)])
    root = target / art["release"]
    data = target / "data"
    data.mkdir(mode=0o700)
    env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
           "DATA_DIR": str(data), "PORT": str(port), "HOSTNAME": "127.0.0.1",
           "NODE_ENV": "production", "OMNIROUTE_BUILD_ID": art["build_id"],
           "OMNIROUTE_DISABLE_BACKGROUND_SERVICES": "true",
           "OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS": "false",
           "OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK": "true",
           "OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK": "true",
           "OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK": "true",
           "NODE_OPTIONS": "--max-old-space-size=4096"}
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=3)
        s.close()
        raise RuntimeError("smoke port busy")
    except OSError:
        pass
    proc = subprocess.Popen([node, "--max-old-space-size=4096", "scripts/dev/run-standalone.mjs"],
                            cwd=root, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        for _ in range(90):
            if health(port):
                break
            time.sleep(2)
        else:
            raise RuntimeError("smoke health deadline")
        c = sqlite3.connect(f"file:{data / 'storage.sqlite'}?mode=ro", uri=True)
        try:
            versions = [r[0] for r in c.execute(
                "SELECT version FROM _omniroute_migrations ORDER BY version")]
            assert versions[-1] == str(ledger_top), f"top not {ledger_top}: {versions[-3:]}"
        finally:
            c.close()
        print("SMOKE_OK", art["release"], f"top={ledger_top}")
    finally:
        proc.terminate()
        proc.wait(timeout=30)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fork artifact packager")
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stage")
    st.add_argument("--src", required=True)
    st.add_argument("--commit", required=True)
    st.add_argument("--build-id", required=True)
    st.add_argument("--release", required=True)
    st.add_argument("--stage-dir", required=True)
    st.add_argument("--node", default=DEFAULT_NODE)
    st.add_argument("--ledger-top", default=None)
    pk = sub.add_parser("pack")
    pk.add_argument("--stage-dir", required=True)
    pk.add_argument("--src", required=True)
    pk.add_argument("--release", required=True)
    pk.add_argument("--out-dir", required=True)
    pk.add_argument("--seal", action="store_true")
    pk.add_argument("--size-budget-bytes", type=int, default=SIZE_BUDGET_BYTES,
                    help="fail-closed ceiling for the compressed tarball (default 700 MB)")
    li = sub.add_parser("list")
    li.add_argument("--stage-dir", required=True)
    sm = sub.add_parser("smoke")
    sm.add_argument("--artifact", required=True)
    sm.add_argument("--out-dir", required=True)
    sm.add_argument("--node", default=DEFAULT_NODE)
    sm.add_argument("--port", type=int, default=20194)
    sm.add_argument("--ledger-top", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "stage":
        stage(args.src, args.commit, args.build_id, args.release,
              args.stage_dir, args.node, args.ledger_top)
    elif args.cmd == "pack":
        pack(args.stage_dir, args.src, args.release, args.out_dir, args.seal,
             args.size_budget_bytes)
    elif args.cmd == "list":
        list_stage(args.stage_dir)
    elif args.cmd == "smoke":
        smoke(args.artifact, args.out_dir, args.node, args.port, args.ledger_top)


if __name__ == "__main__":
    main()
