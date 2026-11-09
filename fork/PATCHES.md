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

## Phase 2b cold start (Beta only, files only — not installed/enabled)

- `fork/deploy/systemd/omniroute-beta.socket`: holds public `:20129`, `Accept=no`, `WantedBy=sockets.target`.
- `fork/deploy/systemd/omniroute-beta-proxy.service`: `/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=15min 127.0.0.1:20139`, `Requires/After` the socket, `Wants/Before` the backend (proxy holds the client socket across backend restarts, so no `BindsTo` on this side).
- `fork/deploy/systemd/omniroute-beta-backend.service`: internal `:20139` (`PORT`+`OMNIROUTE_PORT`, `HOSTNAME=127.0.0.1`, `DATA_DIR=~/.omniroute-beta`), `BindsTo/After` the proxy (proxy exit stops the backend — that is the idle path), flag-free `ExecStart` so P2 `NODE_OPTIONS=--max-old-space-size=2048` governs (proven: CLI flag beats env). P2 tuning (`APP_LOG_LEVEL=warn`, 3 timer envs at 300 s) baked in.
- `fork/deploy/omniroute-healthcheck.sh`: repo copy of `~/.local/bin/omniroute-healthcheck.sh` + opt-in 2b (`OMNIROUTE_HEALTHCHECK_UNIT`/`_URL`/`_SOCKET` envs, defaults = prod behaviour byte-identical). Asleep-skip: socket active + backend inactive → reset fails, exit 0, no probe (probing would wake the proxy). Behaviour without the envs is unchanged.
- Keep-alive: NO new knob — `MAIN_SERVER_KEEPALIVE_TIMEOUT_MS` already env-tunable (default 65 s, run-next.mjs applies it to the page server; finite so idle sockets drain and proxyd can reach 15 min idle). Covered by existing `tests/unit/main-server-keepalive-timeout-7003.test.ts`.
- Rollback (~1 min): `disable --now` the socket/proxy/backend; `enable --now` the plain `omniroute-beta.service` (untouched). Plain unit + deployed healthcheck script untouched in this change set.
- Tests (fork CI runs all three): `tests/unit/fork-cold-start-units.test.ts` (4/4: socket port, proxy idle-exit+wiring, backend port+BindsTo+flag-free+N noticed, P2 drop-in shipped), `tests/unit/healthcheck-repo-copy-sync.test.ts` (1/1: repo copy == deployed apart from 2b), `tests/shell/healthcheck-cold-start-skip.sh` (3/3 with stubbed systemctl: asleep→no probe, awake→probe, no-socket→silent exit 0). `systemd-analyze --user verify` on all three units: exit 0, no warnings.
