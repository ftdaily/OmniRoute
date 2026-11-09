#!/bin/bash
# merge-recipes.sh — auto-resolve known upstream-merge conflicts; MANUAL for the rest.
# Run in a merge worktree after `git merge` stops on conflicts. Only touches
# conflicted paths; refuses to run outside a merge (MERGE_HEAD missing → exit 1).
set -u

if [ ! -f .git/MERGE_HEAD ] && ! git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "merge-recipes: no MERGE_HEAD — run this during a merge after 'git merge' stops." >&2
  exit 1
fi

# Deep key union for messages json: theirs wins on scalar clash (upstream is the
# release source of truth), objects merge recursively, key order sorted upstream-style.
json_union() {
  node -e '
const fs = require("node:fs");
const ours = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const theirs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const union = (a, b) => {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) out[k] = union(a[k], b[k]);
    return out;
  }
  return b === undefined ? a : b;
};
fs.writeFileSync(process.argv[1], JSON.stringify(union(ours, theirs), null, 2) + "\n");
' "$1" "$2"
}

MANUAL=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    docs/i18n/*)
      git checkout --theirs -- "$path" && git add -- "$path"
      echo "theirs: $path"
      ;;
    README.md|AGENTS.md|llm.txt)
      git checkout --theirs -- "$path" && git add -- "$path"
      echo "theirs (+rerun docs generators): $path"
      ;;
    src/i18n/messages/*.json)
      ours=$(mktemp); theirs=$(mktemp)
      git show ":2:$path" > "$ours"; git show ":3:$path" > "$theirs"
      json_union "$ours" "$theirs" && cp "$ours" "$path" || {
        echo "manual (json parse failed): $path" >&2; MANUAL="$MANUAL $path"; rm -f "$ours" "$theirs"; continue
      }
      node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$path" \
        && git add -- "$path" && echo "union: $path" \
        || { echo "manual (json invalid after union): $path" >&2; MANUAL="$MANUAL $path"; }
      rm -f "$ours" "$theirs"
      ;;
    package.json)
      echo "manual (keep fork fields, take upstream deps, then npm install --package-lock-only): $path"
      MANUAL="$MANUAL $path"
      ;;
    src/lib/db/migrations/*.sql)
      echo "manual (renumber: next free NNN above both sides, never reuse): $path"
      MANUAL="$MANUAL $path"
      ;;
    *)
      echo "manual: $path"
      MANUAL="$MANUAL $path"
      ;;
  esac
done < <(git diff --name-only --diff-filter=U || true)

if [ -n "$MANUAL" ]; then
  echo "MANUAL paths remain:$MANUAL"
fi
