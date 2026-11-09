#!/usr/bin/env python3
"""Fork artifact packager (Phase 1.1/1.2). Parametrised copy of the scratch
pack-3854.py: no hardcoded commit, BUILD_ID, paths, or ledger top.

Usage:
  pack.py stage --src <repo> --commit <sha> --build-id <id> --release <name>
      [--stage-dir DIR] [--node PATH] [--ledger-top N]
  pack.py pack  --stage-dir DIR --src <repo> --release <name> --out-dir DIR
      [--seal]   # --seal writes artifact.json {sealed:true,...}
  pack.py list  --stage-dir DIR   # JSON array of staged relative paths (tests)
  pack.py smoke --artifact <artifact.json> --out-dir DIR [--node PATH] [--port N]

Rules (unchanged from the scratch helper):
- stage: tracked tree minus heavy/dev dirs (now ALSO docs/i18n — English docs
  ship, translations fall back at runtime), plus dist + .build/next +
  migrations + run-standalone + server-ws + node_modules (native prebuild
  asserted, better-sqlite3 load-checked), .env assert-absent.
- stage: the 4 transformer paths must exist in STAGE (pack gate, Phase 1.2):
  node_modules/onnxruntime-web, node_modules/onnxruntime-node/bin,
  node_modules/@huggingface/transformers/dist, node_modules/@atjsh/llmlingua-2/dist.
- pack: gzip -1 atomic (.part + rename), safe relative paths only.
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

EXTRA_COPY = [
    "dist",
    ".build/next",
    "src/lib/db/migrations",
    "scripts/dev/run-standalone.mjs",
    ".build/next/standalone/server-ws.mjs",
]


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout.strip()


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def stage(src, commit, build_id, release, stage_dir, node, ledger_top=None):
    src = Path(src)
    stage = Path(stage_dir)
    assert (src / "dist/server.js").is_file(), "dist not built"
    assert (src / "dist/BUILD_SHA").read_text().strip() == commit, "BUILD_SHA mismatch"
    assert (src / ".build/next/BUILD_ID").read_text().strip() == build_id, "BUILD_ID mismatch"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(mode=0o700, parents=True)
    # Tracked files minus heavy/dev-only dirs — plus docs/i18n (Phase 1.2: root
    # docs/** still ship for /docs; translations fall back to English).
    skip_dirs = {"node_modules", ".git", ".next", ".build", "dist", "coverage",
                 ".turbo", "logs", "electron/dist-electron", ".trail", ".opencode",
                 "docs/i18n"}
    for root, dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        dirs[:] = sorted(d for d in dirs if str(rel / d) not in skip_dirs and d != ".git")
        for f in sorted(files):
            s = Path(root) / f
            d = stage / rel / f
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)
    for extra in EXTRA_COPY:
        s = src / extra
        d = stage / extra
        assert s.exists(), f"missing {extra}"
        if d.exists():
            shutil.rmtree(d) if d.is_dir() else d.unlink()
        d.parent.mkdir(parents=True, exist_ok=True)
        if s.is_dir():
            shutil.copytree(s, d, symlinks=False)
        else:
            shutil.copy2(s, d)
    nm_src, nm_dst = src / "node_modules", stage / "node_modules"
    assert (nm_src / "better-sqlite3/prebuilds/linux-x64.node").is_file(), "no linux-x64 prebuild"
    if nm_dst.exists():
        shutil.rmtree(nm_dst)
    shutil.copytree(nm_src, nm_dst, symlinks=False,
                    ignore=shutil.ignore_patterns(".cache", ".bin/*"))
    run([node, "-e", "const D=require('better-sqlite3');let d=new D(':memory:');"
                      "if(d.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);d.close()"],
        cwd=stage)
    for tp in TRANSFORMER_PATHS:
        assert (stage / tp).exists(), f"transformer path missing: {tp}"
    assert not (stage / ".env").exists(), ".env leaked into stage"
    assert (stage / ".build/next/standalone/server-ws.mjs").is_file()
    assert (stage / "scripts/dev/run-standalone.mjs").is_file()
    assert (stage / ".build/next/BUILD_ID").read_text().strip() == build_id
    print("STAGED", release, "files=", sum(1 for _ in stage.rglob("*") if _.is_file()))


def pack(stage_dir, src, release, out_dir, seal=False):
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
        pack(args.stage_dir, args.src, args.release, args.out_dir, args.seal)
    elif args.cmd == "list":
        list_stage(args.stage_dir)
    elif args.cmd == "smoke":
        smoke(args.artifact, args.out_dir, args.node, args.port, args.ledger_top)


if __name__ == "__main__":
    main()
