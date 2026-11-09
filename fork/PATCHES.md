# Fork patches (ftdaily/OmniRoute vs upstream)

## CI gates removed

- `tests/unit/i18n-vi-completeness.test.ts`: dropped the 3 key-parity/ICU Vietnamese locale cases (upstream translation backlog; fork does not retranslate 51 locales).
- `tests/unit/build/docker-publish-multiarch.test.mjs`: dropped the Docker Hub promote, GHCR manifest/promote, and release-source backfill case groups (fork publishes only ghcr.io/ftdaily/omniroute; no Docker Hub, no Bun flavours, no backfills).
- `tests/unit/docker-publish-shallow-checkout.test.ts`: dropped the "no docker-publish checkout clones the full history" case (fork CI uses deep checkouts for merge work).
- `tests/unit/readme-migration-count-14574.test.ts`: dropped the "every current README mirror states the measured SQL migration count" case (mirrors are byte-identical to upstream pin; counts gate covers root docs).
- `tests/unit/docs/readme-comparison-table-svg.test.ts`: dropped the "counts gate's own readers accept the generated content" case (same mirror-freeze reason as above).
- `.github/workflows/ci.yml`: removed the `i18n-ui-coverage` job (key parity / value drift / new-key / completeness gates over 51 upstream locales), its two `needs` refs and the CI Dashboard row.
- `.github/workflows/ci.yml`: removed both `Upload test results to Trunk` steps (vitest junit + e2e junit); fork has no `TRUNK_TOKEN`.
- `scripts/check/check-docs-sync.mjs` + `ci.yml` Docs Sync env: `FORK_SKIP_I18N_MIRRORS=1` skips the exact-copy `llm.txt` + CHANGELOG mirror checks (check-docs-sync) and the README-mirrors migration check (check-docs-counts-sync); allowlisted in check-env-doc-sync IGNORE_FROM_CODE (fork does not maintain docs/i18n mirrors — English only, frozen at the upstream pin). Logged, never silent; upstream never sets the env so merges stay clean.
- `src/shared/constants/agentSkills.ts`: omni-mcp description says 117 tools (live fork count via `countUniqueMcpTools`) instead of pin-stale 110; `skills/omni-mcp/SKILL.md` (117) regenerates idempotent (`Generated: 0`). Upstream must set its own number on merge (fork has 7 extra tools).

## Fork deploy tooling (Phase 1, `fork/deploy/`, `fork-ci.yml`)

- `fork/deploy/pack.py`: fork artifact packager (parametrised `stage/pack/list/smoke`; stages tracked files + dist + .build/next + migrations + node_modules, drops `docs/i18n`, asserts the 4 transformer paths, `.env` assert-absent, gzip -1 atomic tarball, health-200 smoke + ledger-top assert). Upstream has no equivalent path; never merge upstream.
- `fork/deploy/local-release.py`: local rollout (`seal/install/beta/cutover` for the user-scoped unit; SQLite backup-API clone, EnvironmentFile 0600, PID-exact stop, auto metadata-rollback; beta/cutover/install require receipts + parent approval). Host identity (unit, ports, paths, heap) via CLI args. Fork-only.
- `fork/deploy/tencent-release.py`: Tencent rollout (`seal/beta/promote`; atomic symlink swap with rollback, disk/mem guards, migration SHA pins via `--migration-230/231`, clone dir via `--clone-dir`). Fork-only; run as root on the host.
- `.github/workflows/fork-ci.yml`: runs `tests/unit/fork-deploy-*.test.ts` + `fork/deploy/test_tencent_release.py` (18 unittest: Ctx binding, stage layout, migrations sha, beta env, .env clone) + `py_compile` + helper `--help` surface on PRs to `mine` touching `fork/deploy/**` (hosted runner only). Standalone workflow — not in the `ci`/`quality` admission policy.

## P1-PACKFIX2: fixture-only native-check skip + gate-precision note

- `fork/deploy/pack.py`: `stage()` gains `skip_native_check=False` +
  `--skip-native-check` CLI flag (test-only; default keeps the in-stage
  better-sqlite3 load check ON for real packs). CI fixture stages carry a
  stub prebuild and no native build, so the check failed there (exit 1).
  `TRANSFORMER_PATHS` gains a one-line REVIEW ARTIFACT-2 note: gate is
  dir-level; runtime loads `transformers.node.*` + `ort.node.min.*` inside
  those dirs (verified via package.json main/exports + `ls`).
- `tests/unit/fork-deploy-pack.test.ts`: both `stage` invocations pass
  `--skip-native-check` (only the test uses it).

## P1-FLAT: pack.py emits flat './' entries (no <release>/ prefix)

- `fork/deploy/pack.py` `pack()`: `arcname=str(Path(".") / a)` — matches
  scratch `pack-3854b.py` (`tar -C STAGE .`, flat `./` members). The old
  `Path(release) / a` prefix nested every install one level too deep when
  `local-release.py install()` / `tencent-release.py stage()` extract with
  `tar -xzf -C releases/<release>/` (ended up `releases/X/X/`, entrypoint
  asserts failing).
- `tests/unit/fork-deploy-pack.test.ts`: new "emits flat entries" test —
  packs the fixture stage, lists the real tarball, asserts no entry starts
  with `<release>/` and the 4 transformer paths sit at `./node_modules/...`.
  End-to-end proof: extracted a fixture tarball into `releases/R1/` —
  `server.js` + `node_modules/onnxruntime-web` land directly, no nesting.

## TENCENT-SCRIPT: fold all 5 Tencent workarounds into the runners

- `fork/deploy/tencent-release.py`:
  1. `Ctx` binds `self.policy_format = args.policy_format` (matches
     `local-release.py`; was AttributeError on `seal`).
  2. `stage()` extracts the flat pack (`tar -xzf -C target`), strips a
     single top dir named exactly `<release>` (old nested artifacts),
     rejects anything else nested, then `chown_tree(target, service-user)`
     (was EACCES for `User=omniroute`).
  3. `migrations_listing_sha()` + `verify_migrations()`: artifact
     `migrations` is the pack.py listing sha256 STRING — hash the image
     listing (`src/lib/db/migrations/<sorted names>`, newline-joined) and
     compare; never iterate the string as filenames.
  4. `boot_qualify()` writes `tencent-beta.env` as plain `KEY=value`
     (EnvironmentFile= rejects the `Environment=` unit prefix — once left
     beta on PORT 20128 fighting stable) and asserts `PORT == beta port`.
  5. `stage()` copies `DATA_DIR/.env` (STORAGE_ENCRYPTION_KEY) into the
     clone 0600 pre-chown; value never printed.
- `fork/deploy/local-release.py`: `install()` gains the same
  `verify_migrations()` listing-sha check (was membership-loop over the
  string too); its `beta()` already wrote plain env + copied `.env` —
  untouched except sharing the helper shape.
- `fork/deploy/test_tencent_release.py`: 18 unittest (RED->GREEN: 8
  failures + 2 errors on unfixed scripts) wired into `fork-ci.yml`.
