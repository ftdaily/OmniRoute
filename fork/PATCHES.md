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

## Fork deploy tooling (Phase 1, `fork/deploy/`, `fork-ci.yml`)

- `fork/deploy/pack.py`: fork artifact packager (parametrised `stage/pack/list/smoke`; stages tracked files + dist + .build/next + migrations + node_modules, drops `docs/i18n`, asserts the 4 transformer paths, `.env` assert-absent, gzip -1 atomic tarball, health-200 smoke + ledger-top assert). Upstream has no equivalent path; never merge upstream.
- `fork/deploy/local-release.py`: local rollout (`seal/install/beta/cutover` for the user-scoped unit; SQLite backup-API clone, EnvironmentFile 0600, PID-exact stop, auto metadata-rollback; beta/cutover/install require receipts + parent approval). Host identity (unit, ports, paths, heap) via CLI args. Fork-only.
- `fork/deploy/tencent-release.py`: Tencent rollout (`seal/beta/promote`; atomic symlink swap with rollback, disk/mem guards, migration SHA pins via `--migration-230/231`, clone dir via `--clone-dir`). Fork-only; run as root on the host.
- `.github/workflows/fork-ci.yml`: runs `tests/unit/fork-deploy-*.test.ts` + `fork/deploy/test_tencent_release.py` (18 unittest: Ctx binding, stage layout, migrations sha, beta env, .env clone) + `py_compile` + helper `--help` surface on PRs to `mine` touching `fork/deploy/**` (hosted runner only). Standalone workflow — not in the `ci`/`quality` admission policy.

## Phase 2 RAM tuning (perf, all env-gated, upstream defaults unchanged)

- `src/lib/jobs/tokenHealthCheckJob.ts`: sweep interval via `OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS` (default 60 s, clamp >= 10 s). Test: `tests/unit/jobs-token-health-interval.test.ts` (3/3).
- `src/lib/proxySubscription/subscriptionService.ts`: scheduler period via `OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS` (default 60 s, clamp >= 10 s). Test: `tests/unit/subscription-scheduler-interval.test.ts` (2/2). Timer stays `unref`'d, test guard unchanged.
- `src/lib/warmupScheduler.ts`: tick period via `OMNIROUTE_WARMUP_TICK_INTERVAL_MS` (default 60 s, clamp >= 10 s); cron expr still from `OMNIROUTE_WARMUP_CRON`. Test: `tests/unit/warmup-scheduler-interval.test.ts` (1/1).
- `src/lib/guardrails/videoBridgeDrilldown.ts` + `videoBridgeDrilldownLifecycle.ts`: `import sharp` at module top replaced by `loadSharp()` (cached, string-split specifier + `webpackIgnore`, transformersLocal pattern); call sites `normalizeJpegWithSharp` / `shrinkFrameForVariant` await it. Test: `tests/unit/video-drilldown-lazy-sharp.test.ts` (2/2); existing drilldown suites (route/authz/cancellation/consumer, 29 tests) still green. Behaviour on first drilldown call unchanged — sharp loads then.
- `src/lib/plugins/hooks.ts`: `rateLimitMap` capped (`RATE_LIMIT_MAP_MAX`, default 500, `OMNIROUTE_HOOKS_RATELIMIT_MAP_MAX` override floor 100, oldest-first eviction) + `__rateLimitMapSizeForTesting`. Test: `tests/unit/plugin-hooks-ratelimit-cap.test.ts` (1/1); existing plugin suites (385 tests incl. hooks) green.
- `src/lib/proxyHealth.ts`: `proxyHealthCache` capped (`PROXY_HEALTH_CACHE_MAX`, default 500, `OMNIROUTE_PROXY_HEALTH_CACHE_MAX` override floor 100) via single `cacheProxyHealth()` writer covering all set sites incl. malformed-URL/bad-host early writes + `__proxyHealthCacheSizeForTesting`. Test: `tests/unit/proxy-health-cache-cap.test.ts` (1/1); existing proxy-health suites (6246/refusal-memory/default-port, 13 tests) green.
- Investigated, no change: `src/lib/gamification/notifications.ts` `recentUnlocks` already bounded (per-key cap 50 + 1-min entry TTL + 2-min stale-key eviction each record).
- `fork/deploy/systemd/omniroute-beta-p2-ram.conf` (new, not deployed): Beta drop-in — `APP_LOG_LEVEL=warn`, `NODE_OPTIONS=--max-old-space-size=2048` (IGNORED on units with hardcoded ExecStart flag — proven 4496293888; real activation = user edits ExecStart or adopts the flag-free 2b server unit), 3 timer envs at 300 s.

## Phase 2b cold start (Beta only, files only — not installed/enabled)

- `fork/deploy/systemd/omniroute-beta.socket`: holds public `:20129`, `Accept=no`, `WantedBy=sockets.target`.
- `fork/deploy/systemd/omniroute-beta-proxy.service`: `/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=15min 127.0.0.1:20139`, `Requires/After` the socket, `Wants/Before` the backend (proxy holds the client socket across backend restarts, so no `BindsTo` on this side).
- `fork/deploy/systemd/omniroute-beta-backend.service`: internal `:20139` (`PORT`+`OMNIROUTE_PORT`, `HOSTNAME=127.0.0.1`, `DATA_DIR=~/.omniroute-beta`), `BindsTo/After` the proxy (proxy exit stops the backend — that is the idle path), flag-free `ExecStart` so P2 `NODE_OPTIONS=--max-old-space-size=2048` governs (proven: CLI flag beats env). P2 tuning (`APP_LOG_LEVEL=warn`, 3 timer envs at 300 s) baked in.
- `fork/deploy/omniroute-healthcheck.sh`: repo copy of `~/.local/bin/omniroute-healthcheck.sh` + opt-in 2b (`OMNIROUTE_HEALTHCHECK_UNIT`/`_URL`/`_SOCKET` envs, defaults = prod behaviour byte-identical). Asleep-skip: socket active + backend inactive → reset fails, exit 0, no probe (probing would wake the proxy). Behaviour without the envs is unchanged.
- Keep-alive: NO new knob — `MAIN_SERVER_KEEPALIVE_TIMEOUT_MS` already env-tunable (default 65 s, run-next.mjs applies it to the page server; finite so idle sockets drain and proxyd can reach 15 min idle). Covered by existing `tests/unit/main-server-keepalive-timeout-7003.test.ts`.
- Rollback (~1 min): `disable --now` the socket/proxy/backend; `enable --now` the plain `omniroute-beta.service` (untouched). Plain unit + deployed healthcheck script untouched in this change set.
- Tests (fork CI runs all three): `tests/unit/fork-cold-start-units.test.ts` (4/4: socket port, proxy idle-exit+wiring, backend port+BindsTo+flag-free+N noticed, P2 drop-in shipped), `tests/unit/healthcheck-repo-copy-sync.test.ts` (1/1: repo copy == deployed apart from 2b), `tests/shell/healthcheck-cold-start-skip.sh` (3/3 with stubbed systemctl: asleep→no probe, awake→probe, no-socket→silent exit 0). `systemd-analyze --user verify` on all three units: exit 0, no warnings.

## Phase 2b v2 fixes (blocker round, 2026-11-09)

- Backend runs the RELEASE bundle, never the main checkout:
  `WorkingDirectory=%h/.local/share/omniroute/beta-current` (symlink parent
  flips at promotion: `ln -sfn releases/<build> beta-current`),
  `ExecStart=%h/.local/node-v24.15.0/bin/node dev/run-standalone.mjs`
  (Node 24 like stable, same `dev/run-standalone.mjs` entrypoint stable uses
  via `zz-candidate-8309a78183.conf` and later; leading empty `ExecStart=`
  clears vendor/drop-in ExecStart first).
- Readiness race fixed WITHOUT an ordering cycle: proxy
  `Requires=omniroute-beta-backend.service` (pulls backend into the same
  transaction, no `After=`) + backend `BindsTo=` the proxy (proxy idle-exit
  stops the backend = the idle path) + backend `ExecStartPost=` polling
  `http://127.0.0.1:20139/api/health` up to ~90 s, so "started" means
  "serving" and proxyd never forwards into ECONNREFUSED. The literal
  Requires+After/BindsTo+After in both directions fails verify with
  "Transaction order is cyclic" (reproduced); the chosen shape verifies
  clean. `Type=notify` not used: the Next standalone server has no
  sd_notify integration.
- `[Install]` removed from the proxy (socket-activated only; must not start
  at boot); no `multi-user.target` in any user unit (does not exist for
  `--user`; socket keeps `WantedBy=sockets.target`, backend/proxy carry no
  `[Install]`).
- `StopWhenUnneeded=yes` NOT used: systemd 262 `--user verify` rejects it
  as unknown in `[Service]` (verified warning); backend `BindsTo=` the
  proxy achieves the same stop-with-proxy.
## Prod cold start (laptop)

- `fork/deploy/systemd/omniroute-prod.socket`: holds public `:20128`, `Accept=no`, `WantedBy=sockets.target`; first connection wakes `omniroute-prod-proxy.service`.
- `fork/deploy/systemd/omniroute-prod-proxy.service`: `/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=30min 127.0.0.1:20138` (`TimeoutStartSec=120`; `ExecStartPre=` polls `http://127.0.0.1:20138/api/health` ~110 s; `Requires=omniroute-prod.socket` + `Requires=omniroute-repo.service`).
- `fork/deploy/systemd/omniroute-repo-cold-start.conf` (drop-in for `omniroute-repo.service`, copied verbatim from deployed `zzzzzzzz-cold-start.conf`): internal `:20138` (`PORT`+`OMNIROUTE_PORT`, `OMNIROUTE_HOSTNAME=127.0.0.1`, `BindsTo=omniroute-prod-proxy.service`, `TimeoutStartSec=120`, `ExecStartPost=` health poll). `OMNIROUTE_HOSTNAME` not `HOSTNAME`: `scripts/build/runtime-env.mjs` `withRuntimePortEnv()` overwrites `HOSTNAME` from `OMNIROUTE_HOSTNAME` at runtime, so a direct `HOSTNAME=` would be silently clobbered.
- `fork/deploy/systemd/omniroute-healthcheck-cold-start.conf`: `[Service] Environment=OMNIROUTE_HEALTHCHECK_URL=http://127.0.0.1:20138/api/health`.
- Measured cold start: 14.8 s socket-wake → first `200` from `:20128`.
- Rollback: `rm ~/.config/systemd/user/omniroute-repo.service.d/zzzzzzzz-cold-start.conf && systemctl --user disable --now omniroute-prod.socket && systemctl --user enable --now omniroute-repo.service && rm ~/.config/systemd/user/omniroute-healthcheck.service.d/omniroute-healthcheck-cold-start.conf` (plain `omniroute-repo.service` keeps running untouched below).
- Tests: `tests/unit/fork-cold-start-units.test.ts` (4/4 prod: socket `:20128`+`Service=`, proxy idle-exit+`Requires=omniroute-repo.service`, drop-in `PORT`/`OMNIROUTE_PORT`/`OMNIROUTE_HOSTNAME`+no `HOSTNAME`+`BindsTo`, healthcheck drop-in URL). `systemd-analyze --user verify` on socket + proxy: exit 0, no warnings (drop-ins are fragments, not standalone).

## Phase 2 env docs (sync fix)

- `.env.example` + `docs/reference/ENVIRONMENT.md`: documented the 5 fork P2 vars (CI `check:env-doc-sync` requires code/example/docs in sync): `OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS`, `OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS`, `OMNIROUTE_WARMUP_TICK_INTERVAL_MS`, `OMNIROUTE_PROXY_HEALTH_CACHE_MAX`, `OMNIROUTE_HOOKS_RATELIMIT_MAP_MAX`. Verified: `node scripts/check/check-env-doc-sync.mjs` green (722/1014/1031, none missing); `check:docs-counts` exit 0 (1 pre-existing soft drift: CODEBASE_DOCUMENTATION executor count).
- `.github/workflows/ci.yml` docs-sync job: `i18n docs drift` step skipped on ftdaily/OmniRoute (no translation batch on the fork; docs/i18n frozen at upstream pin).
- `.github/workflows/docker-publish.yml`: fork-only Docker Hub guard — `HAS_DOCKERHUB` job env (`secrets.DOCKERHUB_USERNAME != ''`) skips both `Login to Docker Hub` steps and the `Update Docker Hub description` step when absent (fork publishes ghcr.io/ftdaily/omniroute only; upstream secrets don't exist on the fork). GHCR login, builds, manifests, smoke test untouched.

## M2b merge-integrity on push (replaces unpushed M2 ledger, reset)

- `.github/workflows/quality.yml` (merge-integrity job, CHANGELOG integrity
  step): on `push` set `CHANGELOG_BASE_REF: origin/<pushed-branch>`; on PRs
  empty (script falls back to `GITHUB_BASE_REF` = PR base, unchanged).
  checkout uses `fetch-depth: 0`, so `origin/<branch>` is present — verified.
  Root cause: push runs have no `GITHUB_BASE_REF`, so the script fell back to
  the newest `origin/release/v*` on the fork (stale `release/v3.8.51`,
  pre-release CHANGELOG) and flagged 11 bullets upstream itself rewrote
  (takedown #12440 + #12337). No ledger file needed: push compares
  mine-tip-vs-mine-tip (empty delta, trivially green); PR runs already pass.
  Local proof: `CHANGELOG_BASE_REF=origin/mine node
  scripts/check/check-changelog-integrity.mjs` → `OK — no base bullets lost
  vs origin/mine`, exit 0.
- Supersedes: `b825ecc34f` (5,194-line reconciliation ledger, upstream file
  churn every sync) was reset (`git reset --hard origin/mine`), never pushed.
- `.github/workflows/quality.yml`: actionlint install retries 3x with 10s backoff + `actionlint -version` verification before continuing, hard fail after 3 misses (raw.githubusercontent flakes ~92-byte error page). ci.yml:449 untouched (upstream).
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
- `.github/actions/npm-ci-retry/action.yml`: after a fresh `npm ci`, reinstall optional `keytar` if npm 11 dropped it (check-native-deps fix #1); stops the Build/Lint keytar flake.

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

## CI-COV: coverage push-only on the fork (saves ~40 min per fork PR round)

- `.github/workflows/ci.yml` `test-coverage.if`: `... && (github.event_name != 'pull_request' || github.repository != 'ftdaily/OmniRoute')` — fork PRs skip the ~45 min job; push / dispatch / merge_group and upstream PRs still run it (upstream cost, we never push upstream). Downstream needs no change: `quality-gate` already tolerates skipped coverage (`--allow-missing`, `continue-on-error`), `coverage-pr-comment` degrades (`continue-on-error`, `!= cancelled`), `sonarqube` only ran on `success` anyway, and both `admission-verdict` (skipped non-applicable = PASS) and `ci-summary` (SKIPPED row) handle it.
- `config/quality/admission-policy.json` `test-coverage.when`: `code` → `full-code` (push/dispatch/merge_group + Mergify queue candidate; ordinary fork PRs may skip). Upstream semantics would also move coverage off plain PRs — accepted, we never push upstream.
- `tests/unit/admission-verdict.test.mjs`: sentinel swapped to still-`code` `test-unit`; FULL_LANE now includes `test-coverage`; full-matrix gating test asserts the fork carve-out contract (upstream PR runs coverage, fork PR skips, no `changes` dep).
- `tests/unit/ci-mergify-candidate.test.mjs`: `github.repository` added to the evaluator context (upstream value); ready-PR test asserts upstream-runs / fork-skips split for `test-coverage`.
- actionlint: not installed locally (no binary); `if` addition is a pure `&&` term on existing contexts, YAML parsed OK.

## P2-SHARP: one shared lazy sharp loader, sharp-free startup graph

- New `src/lib/guardrails/sharpLoader.ts`: the ONE `loadSharp()` (string-split
  specifier, cached). `videoBridgeDrilldown.ts` + `videoBridgeDrilldownLifecycle.ts`
  dropped their duplicated private copies; `videoBridgeContactSheet.ts` +
  `videoBridgeHelpers.ts` use it instead of bare `await import("sharp")`.
- Startup-graph breaks (why sharp was resident at idle): `visionBridgeHelpers.ts`
  statically imported `imageNormalize` (sharp factory) — now lazy inside
  `fetchRemoteImageAsDataUri` only. `SELF_LOOP_KEY_ID_HEADER` moved to the leaf
  `visionBridgeKeyScope.ts`; `audioBridgeHelpers.ts` imports it from there
  instead of via `visionBridgeHelpers` (which had dragged imageNormalize+sharp
  into the audio bridge's startup graph: instrumentation -> registry ->
  audioBridge -> helpers -> visionBridgeHelpers -> imageNormalize).
- `tests/unit/fork-sharp-lazy.test.ts`: asserts one dynamic import site in the
  loader, no top-level sharp import and no private loader/dynamic import in the
  9 startup-reachable modules. NOTE: not a Next-preload issue — sharp is absent
  from `serverExternalPackages` and the bundled `import("sharp")` call sites are
  all lazy (`Promise.resolve().then(...)` in image-optimizer/video paths).
- CORRECTION (follow-up): the imageNormalize half of the "startup-graph breaks"
  claim above did NOT land in 450acb427f (`visionBridgeHelpers.ts` stat 0 there;
  its static `import { normalizeDataUri } from imageNormalize` survived, and the
  test scans literal `sharp` imports only, so the package-mediated
  imageNormalize→sharp edge was untested). It exists only as UNCOMMITTED dirt
  in this worktree (lazy `await import(imageNormalize)` at the
  fetchRemoteImageAsDataUri call site + const re-export), NOT reviewed, NOT in
  CI. What 450acb427f PROVABLY did: dedup to one cached loader + const move to
  the leaf KeyScope (no-cycle verified) + the pinning test.
- BUNDLE FORENSICS (built artifact e700c0ba49, read-only): ZERO literal
  `require("sharp")` and ZERO static `from "sharp"` in the whole
  `.build/next/server` tree — no top-level preload anywhere, including
  `instrumentation.js` (its `842482:a=>{a.exports=import("sharp")}` factory has
  exactly 1 ref = its own definition; nothing evaluates it) and `middleware.js`
  (1 `sharp` hit = its own factory def). All 6 consumer chunks
  (25271/39930/52013/56124/58980/68129/89110) reference it only as
  `Promise.resolve().then(require-bind(842482))` inside async fns — the four
  app-level lazy sites (loadSharp ×2 deduped post-commit, contactSheet,
  helpers grayscale) plus upstream open-sse imageNormalize/cursorImages, which
  were ALREADY `import("sharp")` dynamic before the fork touched anything.
  `images.unoptimized: true` is already set, so Next's image-optimizer never
  runs. CONCLUSION: no loader-side fix is available or needed — the bundle
  cannot load sharp at idle. The resident `.node` in the observed Beta maps
  must have come from a request-time call (image/video path on a box that had
  served traffic; both observed processes had), NOT from startup. No config
  change recommended; RSS cost of sharp (~30-60 MB with libvips) is paid only
  on first image/video use, which is the correct laziness boundary. Verify on a
  FRESH boot (maps before first image request), do not chase further.
- 2026-11-09 .github/workflows/docker-publish.yml: build + merge jobs define GHCR_IMAGE_NAME (= IMAGE_NAME). Upstream 535f0724d1/44e201b8ff verify steps read it; fork's GHCR-only env (f04c903529) had dropped it → 'GHCR_IMAGE_NAME: unbound variable' after image push.
