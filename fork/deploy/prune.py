"""Prune selector for release dirs (Phase 1.3).

Given a releases root, the current symlink, a drop-in dir and --soak-hours,
print KEEP/DELETE per dir with a reason. Only deletes with --apply plus an
explicit --confirm-list file. Never selects the live target (readlink -f of
the current symlink) or any dir referenced by a drop-in. Dirs not matching
our release naming are REPORTED as FOREIGN and never deleted.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

# e.g. cf4344a-CJvDF3DomnMxXLvOowleM-3854 ; beta-NNNN-<40hex>
RELEASE_RE = re.compile(r"^[0-9a-f]{7,10}-[A-Za-z0-9_-]+$|^beta-\d+-[0-9a-f]{40}$")


@dataclass
class Decision:
    name: str
    verdict: str  # KEEP | DELETE | FOREIGN
    reason: str


def is_ours(name: str) -> bool:
    return bool(RELEASE_RE.match(name))


def read_dropin_targets(dropin_dir: str) -> set[str]:
    """Dirs referenced by WorkingDirectory= / Environment RELEASE=/BUILD_ID= lines."""
    targets: set[str] = set()
    if not dropin_dir or not os.path.isdir(dropin_dir):
        return targets
    for fn in sorted(os.listdir(dropin_dir)):
        if not fn.endswith(".conf"):
            continue
        try:
            with open(os.path.join(dropin_dir, fn), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("WorkingDirectory="):
                wd = line.split("=", 1)[1].strip()
                base = os.path.basename(wd.rstrip("/"))
                if base:
                    targets.add(base)
            for key in ("RELEASE=", "BUILD_ID="):
                if key in line:
                    val = line.split(key, 1)[1].split()[0].strip().strip('"').strip("'")
                    if len(val) >= 9:
                        targets.add(val)
    return targets


def select(
    releases_root: str,
    current_link: str,
    dropin_dir: str,
    soak_hours: float = 48.0,
    now: float | None = None,
) -> list[Decision]:
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    live = ""
    try:
        live = os.path.basename(os.readlink(current_link).rstrip("/"))
    except OSError:
        real = os.path.realpath(current_link) if os.path.exists(current_link) else ""
        live = os.path.basename(real.rstrip("/")) if real else ""
    dropin_targets = read_dropin_targets(dropin_dir)
    out: list[Decision] = []
    try:
        names = sorted(os.listdir(releases_root))
    except OSError as exc:
        print(f"prune: cannot list {releases_root}: {exc}", file=sys.stderr)
        return out
    for name in names:
        full = os.path.join(releases_root, name)
        if not os.path.isdir(full) or os.path.islink(full):
            continue
        if not is_ours(name):
            out.append(Decision(name, "FOREIGN", "name not ours; never touched"))
            continue
        if name == live:
            out.append(Decision(name, "KEEP", "live: current symlink target"))
            continue
        if name in dropin_targets:
            out.append(Decision(name, "KEEP", "referenced by a drop-in"))
            continue
        try:
            mtime = os.stat(full).st_mtime
        except OSError:
            out.append(Decision(name, "KEEP", "stat failed; safe default"))
            continue
        age_h = (now - mtime) / 3600.0
        if age_h < soak_hours:
            out.append(
                Decision(name, "KEEP", f"within soak window ({age_h:.1f}h < {soak_hours:g}h)")
            )
        else:
            out.append(
                Decision(name, "DELETE", f"post-soak previous ({age_h:.1f}h >= {soak_hours:g}h)")
            )
    return out


def confirm_hash(decisions: list[Decision]) -> str:
    lines = [f"{d.verdict} {d.name} {d.reason}" for d in decisions]
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()[:16]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--releases-root", required=True)
    ap.add_argument("--current-symlink", required=True)
    ap.add_argument("--dropin-dir", default="")
    ap.add_argument("--soak-hours", type=float, default=48.0)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--confirm-list", default="")
    args = ap.parse_args(argv)

    decisions = select(args.releases_root, args.current_symlink, args.dropin_dir, args.soak_hours)
    for d in decisions:
        print(f"{d.verdict} {d.name} ({d.reason})")

    if not args.apply:
        return 0
    if not args.confirm_list:
        print("prune: --apply needs --confirm-list <file>", file=sys.stderr)
        return 2
    try:
        with open(args.confirm_list, encoding="utf-8") as f:
            confirmed = {ln.split()[1] for ln in f if ln.startswith("DELETE ")}
    except OSError as exc:
        print(f"prune: cannot read confirm list: {exc}", file=sys.stderr)
        return 2
    to_delete = [d.name for d in decisions if d.verdict == "DELETE"]
    unconfirmed = [n for n in to_delete if n not in confirmed]
    if unconfirmed:
        print(f"prune: not confirmed: {', '.join(unconfirmed)}", file=sys.stderr)
        return 2
    rc = 0
    for name in to_delete:
        full = os.path.join(args.releases_root, name)
        try:
            import shutil

            shutil.rmtree(full)
            print(f"deleted {name}")
        except OSError as exc:
            print(f"prune: failed to delete {name}: {exc}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
