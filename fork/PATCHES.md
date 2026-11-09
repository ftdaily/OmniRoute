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

## Phase 2 RAM tuning (perf, all env-gated, upstream defaults unchanged)

- `src/lib/jobs/tokenHealthCheckJob.ts`: sweep interval via `OMNIROUTE_TOKEN_HEALTH_CHECK_INTERVAL_MS` (default 60 s, clamp >= 10 s). Test: `tests/unit/jobs-token-health-interval.test.ts` (3/3).
- `src/lib/proxySubscription/subscriptionService.ts`: scheduler period via `OMNIROUTE_SUBSCRIPTION_SCHEDULER_INTERVAL_MS` (default 60 s, clamp >= 10 s). Test: `tests/unit/subscription-scheduler-interval.test.ts` (2/2). Timer stays `unref`'d, test guard unchanged.
- `src/lib/warmupScheduler.ts`: tick period via `OMNIROUTE_WARMUP_TICK_INTERVAL_MS` (default 60 s, clamp >= 10 s); cron expr still from `OMNIROUTE_WARMUP_CRON`. Test: `tests/unit/warmup-scheduler-interval.test.ts` (1/1).
- `src/lib/guardrails/videoBridgeDrilldown.ts` + `videoBridgeDrilldownLifecycle.ts`: `import sharp` at module top replaced by `loadSharp()` (cached, string-split specifier + `webpackIgnore`, transformersLocal pattern); call sites `normalizeJpegWithSharp` / `shrinkFrameForVariant` await it. Test: `tests/unit/video-drilldown-lazy-sharp.test.ts` (2/2); existing drilldown suites (route/authz/cancellation/consumer, 29 tests) still green. Behaviour on first drilldown call unchanged — sharp loads then.
- `src/lib/plugins/hooks.ts`: `rateLimitMap` capped (`RATE_LIMIT_MAP_MAX`, default 500, `OMNIROUTE_HOOKS_RATELIMIT_MAP_MAX` override floor 100, oldest-first eviction) + `__rateLimitMapSizeForTesting`. Test: `tests/unit/plugin-hooks-ratelimit-cap.test.ts` (1/1); existing plugin suites (385 tests incl. hooks) green.
- `src/lib/proxyHealth.ts`: `proxyHealthCache` capped (`PROXY_HEALTH_CACHE_MAX`, default 500, `OMNIROUTE_PROXY_HEALTH_CACHE_MAX` override floor 100) via single `cacheProxyHealth()` writer covering all set sites incl. malformed-URL/bad-host early writes + `__proxyHealthCacheSizeForTesting`. Test: `tests/unit/proxy-health-cache-cap.test.ts` (1/1); existing proxy-health suites (6246/refusal-memory/default-port, 13 tests) green.
- Investigated, no change: `src/lib/gamification/notifications.ts` `recentUnlocks` already bounded (per-key cap 50 + 1-min entry TTL + 2-min stale-key eviction each record).
- `fork/deploy/systemd/omniroute-beta-p2-ram.conf` (new, not deployed): Beta drop-in — `APP_LOG_LEVEL=warn`, `NODE_OPTIONS=--max-old-space-size=2048` (IGNORED on units with hardcoded ExecStart flag — proven 4496293888; real activation = user edits ExecStart or adopts the flag-free 2b server unit), 3 timer envs at 300 s.
