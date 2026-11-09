# fork/sync — upstream merge playbook

1. Dispatch `Upstream sync check` (inputs: upstream repo + ref).
2. Read the step summary: conflict list + count, known vs NEW.
3. `git worktree add` a merge worktree; `git config rerere.enabled true`.
4. `git merge` the upstream ref; run `fork/sync/merge-recipes.sh`.
5. Docs/i18n → theirs; README/AGENTS/llm.txt → theirs, rerun docs generators.
6. `package.json`: keep fork fields, take upstream deps, `npm install --package-lock-only`.
7. messages json: key union (sorted); migrations: next free NNN, never reuse.
8. Resolve MANUAL leftovers by hand; `git add` + commit the merge.
9. Open fork PR → CI → Beta (20129) → Stable.
