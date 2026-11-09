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
- `.github/workflows/fork-ci.yml`: runs `tests/unit/fork-deploy-*.test.ts` + `py_compile` + helper `--help` surface on PRs to `mine` touching `fork/deploy/**` (hosted runner only). Standalone workflow — not in the `ci`/`quality` admission policy.

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
