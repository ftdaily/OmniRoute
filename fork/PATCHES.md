# Fork patches (ftdaily/OmniRoute vs upstream)

## CI gates removed

- `tests/unit/i18n-vi-completeness.test.ts`: dropped the 3 key-parity/ICU Vietnamese locale cases (upstream translation backlog; fork does not retranslate 51 locales).
- `tests/unit/build/docker-publish-multiarch.test.mjs`: dropped the Docker Hub promote, GHCR manifest/promote, and release-source backfill case groups (fork publishes only ghcr.io/ftdaily/omniroute; no Docker Hub, no Bun flavours, no backfills).
- `tests/unit/docker-publish-shallow-checkout.test.ts`: dropped the "no docker-publish checkout clones the full history" case (fork CI uses deep checkouts for merge work).
- `tests/unit/readme-migration-count-14574.test.ts`: dropped the "every current README mirror states the measured SQL migration count" case (mirrors are byte-identical to upstream pin; counts gate covers root docs).
- `tests/unit/docs/readme-comparison-table-svg.test.ts`: dropped the "counts gate's own readers accept the generated content" case (same mirror-freeze reason as above).
- `.github/workflows/ci.yml`: removed the `i18n-ui-coverage` job (key parity / value drift / new-key / completeness gates over 51 upstream locales), its two `needs` refs and the CI Dashboard row.
- `.github/workflows/ci.yml`: removed both `Upload test results to Trunk` steps (vitest junit + e2e junit); fork has no `TRUNK_TOKEN`.
- `scripts/check/check-docs-sync.mjs` + `ci.yml` Docs Sync + `quality.yml` docs-gates env: `FORK_SKIP_I18N_MIRRORS=1` skips the exact-copy `llm.txt` + CHANGELOG mirror checks (check-docs-sync) and the README-mirrors migration check (check-docs-counts-sync); allowlisted in check-env-doc-sync IGNORE_FROM_CODE (fork does not maintain docs/i18n mirrors — English only, frozen at the upstream pin). Logged, never silent; upstream never sets the env so merges stay clean.
- `src/shared/constants/agentSkills.ts`: omni-mcp description says 117 tools (live fork count via `countUniqueMcpTools`) instead of pin-stale 110; `skills/omni-mcp/SKILL.md` (117) regenerates idempotent (`Generated: 0`). Upstream must set its own number on merge (fork has 7 extra tools).
- `config/quality/admission-policy.json`: dropped the `i18n-ui-coverage` CI job entry (fork Phase A5 removed the job from ci.yml; fork never retranslates 51 upstream locales). `tests/unit/admission-verdict.test.mjs` failure sentinel swapped to still-required `i18n-glossary-zhcn` (same `code-or-i18n` trigger) — no weakening.
- `.github/workflows/ci.yml` docs-sync job: `i18n docs drift` step skipped on ftdaily/OmniRoute (no translation batch on the fork; docs/i18n frozen at upstream pin).
- `.github/workflows/docker-publish.yml`: fork-only Docker Hub guard — `HAS_DOCKERHUB` job env (`secrets.DOCKERHUB_USERNAME != ''`) skips both `Login to Docker Hub` steps and the `Update Docker Hub description` step when absent (fork publishes ghcr.io/ftdaily/omniroute only; upstream secrets don't exist on the fork). GHCR login, builds, manifests, smoke test untouched.
