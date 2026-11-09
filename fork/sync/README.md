# fork/sync — upstream merge playbook

## Pipeline (1–9)
1. Dispatch `Upstream sync check` (workflow_dispatch; inputs upstream_repo+upstream_ref; `.github/workflows/upstream-sync-check.yml`).
2. Read step summary: conflict list + count, known vs NEW.
3. `git worktree add` merge worktree; `git config rerere.enabled true`.
4. `git merge` upstream ref; run `fork/sync/merge-recipes.sh`.
5. docs/i18n → theirs (`--theirs`) — see below; README/AGENTS/llm.txt → theirs, rerun generators.
6. `package.json`: keep fork fields, take upstream deps, `npm install --package-lock-only`.
7. messages json: key union (sorted); migrations: next free NNN, never reuse.
8. Resolve MANUAL leftovers by hand; `git add` + commit merge.
9. Fork PR to `mine` → CI green → Beta 20129 → Stable.

## docs/i18n — take upstream, never edit by hand
- Fork does not maintain mirrors: English only, frozen at pin.
- Conflict → `--theirs`; CI guards with `FORK_SKIP_I18N_MIRRORS=1` (`ci.yml:524-528`, `quality.yml:113`, `check-docs-counts-sync.mjs:47-50`, test `:99-109`, `merge-recipes.sh:35-38`).

## After merge — generators + checks
- Rerun: `npm run gen:provider-reference`, `docs:readme-hero`, `docs:readme-diagrams`, `gen:icon-map`, `prebuild:docs` (checker is `check:docs-counts`, NOT `docs-count`).
- Skills: `node --import tsx/esm scripts/skills/generate-agent-skills.mjs --apply` (check `check:agent-skills-sync`).
- New env knobs → BOTH `.env.example` + `docs/reference/ENVIRONMENT.md` (`check:env-doc-sync`).
- CHANGELOG is upstream-only; gate `check:changelog-integrity` (anti-eat vs base). PRs use `changelog.d/` fragments, NOT direct CHANGELOG edits.
- Check `fork/PATCHES.md` after each merge (CI gates removed section) and keep current — on this base it covers CI-gate removals only (no union rule in `.gitattributes`; `merge-recipes` doesn't mention PATCHES) — partial list; do not claim union-merge or full coverage.

## Fork policy guards — do not weaken
- Invalid/unknown bearer → 401 even with `REQUIRE_API_KEY=false` (`internal-test-mark-trust.test.ts:107`; `src/shared/utils/apiKeyPolicy.ts:1288`).
- Shared helpers must NOT import `next/server` so MCP bundle imports standalone (`tests/unit/build/mcp-bundle-startup.test.ts`; `src/app/api/v1/_helpers/apiKeyScope.ts` stays Next-free, A15).

## Review + flakes
- Review with three-dot `git diff A...B` (`docs/ops/CONTRIBUTION_GOLDEN_PATH.md:286`); never two-dot when base moved. CI classifies with two-dot.
- Flakes (2026-11-09; no repo doc for keytar/60k): actionlint download (`quality.yml` pinned v1.7.12 / `ci.yml` latest), keytar on fresh `npm ci`, 60k-row batch UI test timeout → rerun failed jobs once before debugging.
