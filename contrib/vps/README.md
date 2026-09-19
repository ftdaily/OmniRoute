# Headless Linux VPS deployment

This bundle runs the published OmniRoute server image on a Linux VPS without
the Electron desktop shell. It keeps the dashboard on loopback by default,
does not publish Redis, persists application data, and adds conservative
resource and log limits.

Use this bundle when the VPS only needs the API and web dashboard. The existing
root-level Compose profiles remain the right choice for local development,
building from source, bundled provider CLIs, or the Playwright/Chromium image.

## Prerequisites

- A supported Linux distribution with Docker Engine and Docker Compose v2.
- **Runtime: at least 2 GiB of RAM for the container.** The host needs more
  headroom if other workloads run beside OmniRoute. This floor comes from
  `OMNIROUTE_MEMORY_LIMIT` in `.env.example`, not from the V8 heap.
- **Source builds: at least 8 GiB of RAM on the building machine.** Compiling the
  Next.js tree is a much larger job than running it — the Dockerfile defaults to
  `OMNIROUTE_BUILD_MEMORY_MB=6144` and expects swap or more RAM on top. Do not
  confuse the two numbers: 2 GiB runs the server, 8 GiB builds it.
- SSH access for the loopback dashboard tunnel.

## Install

Build the headless server image from the exact release checkout. Building it
locally avoids assuming that a matching version tag has already been published
to a container registry:

```bash
git switch --detach release/v3.8.51
test "$(node -p "require('./package.json').version")" = "3.8.51"
docker build --target runner-base \
  --build-arg OMNIROUTE_USE_TURBOPACK=0 \
  --tag omniroute:3.8.51-vps .
```

`--build-arg OMNIROUTE_USE_TURBOPACK=0` selects the webpack builder. Turbopack is
the Dockerfile default, but webpack is the lower-memory path and the one CI
validates; without the override a source build on an 8 GiB host is likely to be
OOM-killed during `next build`.

If a matching image is already published, you can skip the build entirely and
point `.env` at the fork's registry instead:

```bash
OMNIROUTE_IMAGE=ghcr.io/ftdaily/omniroute@sha256:<digest>
```

Prefer an immutable `@sha256:` digest (or a version tag) over `latest`/`next`.

Then initialize the deployment from the repository root:

```bash
cd contrib/vps
cp .env.example .env
chmod 600 .env
```

Generate separate values for every secret, then paste them into `.env`:

```bash
openssl rand -base64 48  # JWT_SECRET
openssl rand -hex 32     # API_KEY_SECRET
openssl rand -base64 48  # OMNIROUTE_WS_BRIDGE_SECRET
openssl rand -base64 24  # INITIAL_PASSWORD
```

Do not reuse these values across installations. Keep `REQUIRE_API_KEY=true`.
Keep `OMNIROUTE_IMAGE` on the locally built version tag, or replace it with an
immutable registry digest; do not use the floating `latest` or `next` tags for
unattended production.

Validate and start the stack:

```bash
docker compose config --quiet
docker compose up -d
docker compose ps
```

The dashboard is intentionally bound to `127.0.0.1`. Reach it through SSH:

```bash
ssh -L 20128:127.0.0.1:20128 user@your-vps
```

Then open `http://127.0.0.1:20128` locally. For a public hostname, put a trusted
reverse proxy on the same host in front of the loopback port and terminate TLS
there. Do not change `OMNIROUTE_BIND_HOST` to `0.0.0.0` merely to make the
dashboard reachable.

## Sizing memory

Two independent numbers control memory, and they are not interchangeable:

| Variable                 | Controls                                                 | `.env.example` default |
| ------------------------ | -------------------------------------------------------- | ---------------------- |
| `OMNIROUTE_MEMORY_MB`    | V8 heap — becomes `NODE_OPTIONS=--max-old-space-size`    | `1024`                 |
| `OMNIROUTE_MEMORY_LIMIT` | Container cgroup cap (`mem_limit`) for the whole process | `2g`                   |

Rule: **keep `OMNIROUTE_MEMORY_MB` strictly below `OMNIROUTE_MEMORY_LIMIT`.**
Native buffers, the SQLite cache, and Node's own baseline live outside the V8
heap, so a heap sized at or above the container cap is OOM-killed rather than
garbage-collected. The shipped pair (1024 MB heap inside a 2 GiB cap) leaves
about a gigabyte of non-heap headroom, which is the intended shape.

`compose.yaml` passes both through, so raising the heap means raising the cap in
the same edit:

```dotenv
OMNIROUTE_MEMORY_MB=8192
OMNIROUTE_MEMORY_LIMIT=10g
```

Coding agents (`POST /v1/responses` from Claude Code, Codex, Grok, …) need a
much larger heap than the dashboard. See the root `README.md` table for
per-workload numbers.

## Registry credentials

Pulling a published fork image requires a token that can read GitHub Container
Registry packages:

- Scope: **`read:packages`** only.
- Form: a **fine-grained PAT** limited to this repository (a broad classic PAT
  with repo-wide scopes is unnecessary and should be avoided).
- Lifetime: set an expiry. A long-lived, user-bound PAT is the usual cause of a
  silent deploy failure — when it expires or the user is removed, `docker pull`
  starts failing with no other symptom. The deploy workflow fails loudly if the
  token is unset, but it cannot detect a token that expired after the fact.
- Placement: prefer holding it only on the VPS (in the deploy user's
  `~/.docker/config.json`), or as the `GHCR_TOKEN` repository secret the deploy
  workflow uses to log in. Rotate it on the same schedule as the expiry.

Public images need no credentials at all — this section applies to private
packages.

## Verify

```bash
docker compose ps
curl --fail --silent http://127.0.0.1:20128/healthz
docker compose logs --tail=100 omniroute
```

`/healthz` is a lifecycle probe. Use the authenticated monitoring/API routes
for deeper provider validation after the first login.

## Web-session providers on a VPS

Consumer web-session providers can enforce IP reputation, TLS fingerprint, or
browser-session binding. A cookie copied on a workstation may therefore fail
from a datacenter VPS even when the Linux container is healthy. In particular,
Grok clearance cookies can be tied to the browser IP, User-Agent, and TLS
fingerprint. Prefer official API credentials for unattended workloads. When a
web-session provider is required, use only credentials from an account you own
and follow that provider's guide; do not weaken TLS verification or bypass an
access challenge.

## Backup

Stop writes before copying SQLite data, then archive the named volume:

```bash
docker compose stop omniroute
mkdir -p backups
docker run --rm \
  -v omniroute-vps_omniroute-data:/data:ro \
  -v "$PWD/backups:/backup" \
  docker.io/library/alpine:3.23 \
  tar -C /data -czf /backup/omniroute-data.tar.gz .
docker compose start omniroute
```

Verify the archive before relying on it:

```bash
tar -tzf backups/omniroute-data.tar.gz >/dev/null
```

Store a timestamped copy outside the VPS. The fixed filename above is kept
simple for copy/paste; rename it after each verified backup.

## Update and rollback

Before updating, record the currently running immutable digest and take a
verified backup:

```bash
docker image inspect "$(docker compose images -q omniroute)" \
  --format '{{index .RepoDigests 0}}'
```

Build the new local version tag first, or set `OMNIROUTE_IMAGE` in `.env` to a
new immutable registry digest. Pull only when the selected image is remote,
then recreate the application container:

```bash
# Registry images only: docker compose pull omniroute
docker compose up -d --no-deps omniroute
docker compose ps
curl --fail --silent http://127.0.0.1:20128/healthz
```

To roll back the application image, restore the previous value of
`OMNIROUTE_IMAGE` and repeat the applicable `pull` and `up` commands. Restore the data
archive only when a migration changed the persisted data and image rollback
alone is insufficient. Keep the stack stopped while restoring the volume.

## Remove the stack

```bash
docker compose down
```

This preserves both named volumes. `docker compose down -v` deletes persistent
data and is intentionally not part of the normal uninstall path.
