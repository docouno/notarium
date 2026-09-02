# Notarium — single self-contained image.
#
# One Fastify process serves both the built React SPA (packages/web/dist) and
# the REST API, running the knowledge engine in-process. Same build path
# as `npm run build` locally, so container and host behave identically.
#
# Configuration is injected at runtime via env vars — no secrets and no .env are
# baked in. NONE of them is required: all data (meta-DB, engine indexes, job
# artifacts, spaces) lives under one root, /data, created writable below.

# ---- build stage: install everything and bundle the SPA --------------------
# Debian slim, NOT alpine: the vector channel pulls onnxruntime-node and
# sqlite-vec, whose prebuilt native binaries are glibc-only (no musl build) — on
# alpine they can't load and vector search silently degrades to FTS. slim ships
# libstdc++/libm, the only shared libs onnxruntime's CPU runtime needs.
#
# PINNED BY DIGEST: a published artifact must name the exact base it was
# built on, or "the image built from tag v0.1.0" means a different thing every
# time `node:24-slim` moves. The digest is the multi-arch INDEX, so it stays
# correct if a second platform is added. Bumping it is a deliberate commit — see
# docs/release.md#base-image; `docker buildx imagetools inspect node:24-slim`
# prints the current one.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder
WORKDIR /app

# Image-native operator interface. The same command exists in the builder-backed
# dev container and in the slim runtime image; it selects TS sources in dev and
# bundled dist entries in production.
COPY docker/notarium-cli /usr/local/bin/notarium
RUN chmod 0755 /usr/local/bin/notarium \
  && for command in backup restore admin version healthcheck; do \
    ln -s notarium "/usr/local/bin/$command"; \
  done

# Dev runs the builder stage with `npm run dev` (concurrently + tsx + Vite).
# `concurrently -k` shells out to `ps` when one child exits; node:slim does not
# ship it, so install the tiny process-tool package once in the dev/build image.
# `perl-base` owns `/usr/bin/perl`, on which the engine's atomic directory
# no-replace depends (docs/note-model.md#create-collisions). It is Essential in
# Debian and therefore already present — declared anyway, because a capability
# the code advertises must not rest on what a base image happens to carry today.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps perl-base \
  && rm -rf /var/lib/apt/lists/*

# Install deps against the lockfile first for better layer caching. npm
# workspaces: the lockfile covers every package, so each workspace manifest must
# be present before `npm ci`.
COPY package.json package-lock.json .npmrc ./
COPY packages/cli/package.json packages/cli/
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/desktop/package.json packages/desktop/
COPY packages/engine/package.json packages/engine/
COPY packages/engine-memory/package.json packages/engine-memory/
# @notarium/engine-vector is the deps-only carrier for the embedder
# (@huggingface/transformers + CPU-only onnxruntime, ~360MB). The engine loads it DYNAMICALLY
# and declares no static dep on it — this carrier owns the declaration. vec0 itself
# (sqlite-vec) is NOT here: it is an ordinary @notarium/engine dependency and arrives
# with that workspace either way. The image ships the FULL profile through the
# canonical `deps:full` script so an operator can flip `-e VECTOR_SEARCH=on` without
# rebuilding; npm hoists the embedder to the root node_modules where the engine
# resolves it at runtime. That script also disables onnxruntime-node's unused
# CUDA/TensorRT postinstall download; a bare `npm ci` would add ~302MB and a NuGet CDN
# dependency to this gate. The carrier manifest MUST be present before the install or
# its deps never arrive. (The lightweight host profile instead runs `make deps`, which
# excludes this one workspace — see the Makefile.)
COPY packages/engine-vector/package.json packages/engine-vector/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# The canonical dependency scripts run postdeps:lean/full after npm ci. This producer
# must therefore join the manifest-only cache prefix; copying it only with the later
# source tree makes a clean image build fail after the expensive install completes.
COPY scripts/checkup/depsFreshness.mjs scripts/checkup/
# The pinned base ships an npm below the floor package.json declares, and .npmrc — kept
# in the COPY above for exactly this reason — makes that a refusal rather than a warning
# (engine-strict), so `npm run deps:full` below cannot run until the declared npm is
# installed. The line is therefore self-verifying: drop it and the next layer fails with
# EBADENGINE. The number is derived from `packageManager`, never repeated. The block is
# byte-identical to the one in `.gitlab-ci.yml` and the `make` runners, and carries its
# own `set -eu` and no `&&` so that it aborts the same way in all three — a chain is only
# fail-closed while it is the last command of its script, which is a property of the
# caller, not of the block. Twice a copy landed somewhere it was not.
RUN set -eu; \
  pinned_npm="$(node -p "(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$/.exec(require('./package.json').packageManager)||[,''])[1]")"; \
  [ -n "$pinned_npm" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
  npm i -g "npm@$pinned_npm"; \
  npm cache clean --force; \
  npm -v

RUN npm run deps:full

# Bundle the SPA (vite → packages/web/dist) and the server (tsup →
# packages/server/dist, workspace TS inlined).
COPY . .
# Build identity for /api/about and `notarium version`: the commit,
# the build time and the URL of the exact revision this build came from, passed in
# so tsup/vite inline them (the slim image has no git). All optional — a plain
# `docker build` leaves them empty and the app reports null rather than guessing
# (P5). A RELEASE fills all three and cannot proceed without them; it is the one
# entrypoint that knows a real published revision:
#   npm run release:image           (docs/release.md)
ARG GIT_SHA=""
ARG BUILD_TIME=""
ARG SOURCE_URL=""
# The ARTIFACT's version, which is not always the manifests' version: a
# pre-release publishes `X.Y.Z-rc.<sha>` off the same sources, and an image that
# reported the bare `X.Y.Z` would claim to be the release it only precedes. Empty
# ⇒ the manifests' version, which is right for a plain build and for a real release.
ARG VERSION=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV SOURCE_URL=$SOURCE_URL
ENV VERSION=$VERSION
RUN npm run build

# ---- test stage: the full stack, but with production-like privileges -------
# The builder runs as root only because npm installs and emits build artifacts
# into /app. Tests must not: permission guards are part of the contract. GNU
# make is a test dependency (the backup publication suite exercises the real
# Makefile). Chown only the workdir and Vitest's cache slot; source and the rest
# of node_modules stay read-only to the node user.
FROM builder AS test
RUN apt-get update \
  && apt-get install -y --no-install-recommends make \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/node_modules/.vite \
  && chown node:node /app /app/node_modules/.vite
USER node
ENV HOME=/tmp

# ---- runtime stage: prod deps + server + built SPA only --------------------
# slim (glibc), matching builder — the runtime image runs onnxruntime/vec0. Same
# pinned digest as the builder above; keep the two in lockstep when bumping.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The published image's half of the same declaration (see the builder layer):
# `/usr/bin/perl` is what makes atomic directory no-replace — folder moves, role
# package publication — a capability this deployment actually has rather than
# one it merely advertises. Before `USER node`, while root can still apt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends perl-base \
  && rm -rf /var/lib/apt/lists/*

COPY docker/notarium-cli /usr/local/bin/notarium
RUN chmod 0755 /usr/local/bin/notarium \
  && for command in backup restore admin version healthcheck; do \
    ln -s notarium "/usr/local/bin/$command"; \
  done

# Only production dependencies (fastify & co from @notarium/server; zod from
# @notarium/contract). The frontend libs live in @notarium/web as
# devDependencies — bundled by the build stage, skipped here. The workspace
# manifests must be present for npm ci, and @notarium/web's one also anchors
# the SPA lookup (the server resolves packages/web/dist through it).
COPY package.json package-lock.json .npmrc ./
COPY packages/cli/package.json packages/cli/
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/desktop/package.json packages/desktop/
COPY packages/engine/package.json packages/engine/
COPY packages/engine-memory/package.json packages/engine-memory/
# @notarium/engine-vector carries the embedder (@huggingface/transformers + its
# onnxruntime backend) as its regular `dependencies`, so `--omit=dev` still installs
# them (only dev deps are dropped) — but only if this workspace's manifest is present
# before the canonical `deps:full` install. npm hoists the CPU-only embedder to the root
# node_modules where the bundled server loads it at runtime when VECTOR_SEARCH=on. vec0
# (sqlite-vec) rides
# @notarium/engine's own dependencies and needs no carrier.
COPY packages/engine-vector/package.json packages/engine-vector/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# The same declared npm as the builder stage, for the same reason. The cache purge shares
# this RUN because union layers do not give bytes back: as one layer the pin costs
# +3.4 MB compressed against +13.1 MB split in two, and this is the published stage.
RUN set -eu; \
  pinned_npm="$(node -p "(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$/.exec(require('./package.json').packageManager)||[,''])[1]")"; \
  [ -n "$pinned_npm" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
  npm i -g "npm@$pinned_npm"; \
  npm cache clean --force; \
  npm -v

# `deps:full` owns the canonical install flags and its post-hook. Pass omit as npm
# config so the hook can identify this intentionally dev-less runtime install. The
# bind mount makes the hook available for this RUN without publishing tooling source
# in the runtime filesystem or an image layer.
RUN --mount=type=bind,source=scripts/checkup/depsFreshness.mjs,target=/app/scripts/checkup/depsFreshness.mjs,ro \
  NOTARIUM_DEPS_INSTALL_KIND=runtime npm run deps:full --omit=dev && npm cache clean --force

# The bundled server + the built SPA. No .env — config comes from the environment.
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist ./packages/web/dist

# The browser-facing third-party and font notices already ride inside the SPA
# dist. Keep the first-party license and runtime notices in the image root too,
# so every image recipient gets the complete corpus without running the app.
COPY LICENSE NOTICE COMMERCIAL-LICENSE.md THIRD_PARTY_NOTICES.md ./

# Vector/hybrid search ships OFF in the published image, opt-in with
# `-e VECTOR_SEARCH=on`. A homelab pull must not silently commit ~600MB of RAM
# (the bge-m3 model) and background CPU on first boot; cloud turns it on
# deliberately. This overrides ONLY the published image — the code default stays
# `?? 'on'`, so a bare `npm run server` keeps vector on. The containerized dev stand
# (`make dev`, the `builder` stage) instead pins `VECTOR_SEARCH=off` via
# compose.dev.yml, matching the default no-vector install. See README →
# Configuration for tiers.
ENV VECTOR_SEARCH=off

# Default backend port; override with `-e PORT=...` at runtime.
ENV PORT=3000
EXPOSE 3000

# The single data root: meta-DB, engine indexes, job artifacts + import
# staging, and spaces — all derived from it in code, none of them a required env.
#
# Created and CHOWNed here, before USER node, so the default works out of the box:
# the process runs as uid 1000 while WORKDIR /app stays root-owned, so the old
# cwd-relative `.data/*` defaults resolved under /app and died with
# `EACCES: mkdir '/app/.data'` — on the FIRST export, long after a green boot.
# VOLUME keeps a no-mount `docker run` durable (an anonymous volume inherits this
# dir's ownership) instead of stranding data in the container layer; a bind or a
# named volume at /data overrides it as usual.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Provenance in the image metadata: `docker inspect` on a pulled image
# answers "which source is this?" without running it. The registry page links to
# the repository through `image.source`, and `image.revision` pins the exact
# commit inside it, so a published digest maps back to one revision and no other.
# Empty on a plain local `docker build` — a label that lies is worse than none.
# canon: docs/release.md#identity
ARG VERSION=""
ARG GIT_REVISION=""
ARG BUILD_TIME=""
ARG SOURCE_REPO=""
LABEL org.opencontainers.image.title="Notarium" \
  org.opencontainers.image.description="Self-hosted, AI-agent-native knowledge base over plain Markdown." \
  org.opencontainers.image.url="https://notarium.ai" \
  org.opencontainers.image.documentation="https://notarium.ai/en/docs/" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.vendor="Notarium" \
  org.opencontainers.image.source="$SOURCE_REPO" \
  org.opencontainers.image.revision="$GIT_REVISION" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.created="$BUILD_TIME" \
  org.opencontainers.image.base.name="docker.io/library/node:24-slim" \
  org.opencontainers.image.base.digest="sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"

# Run as the unprivileged user that the node image ships with.
USER node

# The image is an appliance with one public CLI contract. A bare `docker run`
# executes `notarium start`; arguments replace CMD but keep the entrypoint, so
# one-off recovery is simply `docker run ... IMAGE restore < backup.zip`.
ENTRYPOINT ["/usr/local/bin/notarium"]

# Liveness probe goes through the same CLI instead of embedding an unrelated
# node snippet in image metadata.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["healthcheck"]

CMD ["start"]
