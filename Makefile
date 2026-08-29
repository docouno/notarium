# Notarium — single entry point for everything Docker.
#
# `make` runs the containerised stack; for host work use the npm scripts directly
# (`npm run deps:lean`, `npm run dev`, `npm run build`) — they are not proxied here on
# purpose.
#
#   make            # list targets
#   make dev        # dev stack: Notarium (HMR on :3000)
#   make up         # production image locally
#   make release    # publish a traceable image  ·  make release-rc for a pre-release
#
# Compose layering (last file wins) — see docker/:
#   compose.yml (base, self-sufficient)  →  [compose.dev.yml for `make dev`]
# The stack is a single self-contained service — the engine runs in-process.

SHELL := /bin/bash

# Load .env first so it wins over the defaults below, and `export` it so the
# values reach `docker compose` for ${...} interpolation (compose otherwise looks
# for .env next to the compose files in docker/, not here). Container-side vars
# are still injected per service via `env_file:`. Missing .env is fine (`-`).
-include .env
export

# --- image coordinates (override via env or `make IMAGE_NAME=...`) ----------
# REGISTRY is empty by default, so IMAGE_NAME alone resolves against Docker Hub.
# Set REGISTRY to publish somewhere else (`make release RELEASE_FLAGS="--registry
# ghcr.io"`, or a line in .env for a private one) — it is prepended only when
# non-empty. `release` reads both from the environment (see scripts/releaseImage.mjs).
REGISTRY   ?=
IMAGE_NAME ?= docouno/notarium
IMAGE      ?= $(if $(REGISTRY),$(REGISTRY)/,)$(IMAGE_NAME)
VERSION    ?= $(shell node -p "require('./package.json').version" 2>/dev/null || echo dev)
HOST_UID   ?= $(shell id -u)
HOST_GID   ?= $(shell id -g)
# The two install profiles are `deps:lean` / `deps:full` in package.json, NOT here.
# CI runs them straight from a bare node image, which has no make, and any second
# provider has to reach the same two commands — one definition, or the lean workspace
# list silently forks between this file and a YAML nobody diffs.
#
# Default install is NO-EMBEDDER: every workspace EXCEPT the deps-only carrier
# @notarium/engine-vector, so the ~360MB onnxruntime/transformers subtree is never
# downloaded into this checkout. npm has no
# per-package omit and `--omit=optional` is too blunt (it also strips the platform
# binaries esbuild/rollup/sharp/the eslint resolver need); excluding one whole
# workspace is the clean, deterministic lever. `make deps-vector` and both Docker
# install stages call `deps:full`, which installs the carrier too and hoists the embedder
# to the root node_modules where the engine resolves it. A no-embedder checkout
# degrades to FTS at runtime — pair it with VECTOR_SEARCH=off (the dev overlay
# default). Keep `deps:lean`'s list in sync with the workspaces under packages/
# (minus engine-vector) when a package is added or removed.
#
# That full profile is CPU-only by product contract. onnxruntime-node otherwise runs a
# postinstall download for ~302MB of unused CUDA/TensorRT providers from a NuGet CDN;
# `deps:full` sets the upstream ONNXRUNTIME_NODE_INSTALL=skip switch so installs depend
# on the lockfile's registry artifacts only. Keep every full-install caller on that
# script — a bare `npm ci` silently reintroduces both dead weight and a second host.
#
# vec0 itself (sqlite-vec, 200KB) is an ordinary @notarium/engine dependency and
# ships in BOTH profiles — it costs nothing, and excluding it used to close the
# vec0 gate on every default run, so 47 tests that need no embedder at all (a
# deterministic mock stands in for one) went unexercised until a change reached
# main (#317).

# --- layered compose command ------------------------------------------------
DIR  := docker
BASE := -f $(DIR)/compose.yml

COMPOSE     := docker compose $(BASE)
COMPOSE_DEV := docker compose $(BASE) -f $(DIR)/compose.dev.yml
CHECKOUT_SLUG := $(shell basename "$$(pwd -P)" | tr '[:upper:]' '[:lower:]' | \
  sed 's/[^a-z0-9_-]/-/g; s/^-*//; s/-*$$//' | cut -c1-24)
CHECKOUT_HASH := $(shell pwd -P | cksum | awk '{print $$1}')
CHECKUP_RUN_SUFFIX := $(shell date +%s)-$(shell echo $$$$)
TEST_COMPOSE_PROJECT ?= notarium-test-$(CHECKOUT_SLUG)-$(CHECKOUT_HASH)-$(CHECKUP_RUN_SUFFIX)
COMPOSE_TEST := docker compose -p $(TEST_COMPOSE_PROJECT) -f $(DIR)/compose.test.yml
CHECKUP_IMAGE ?= notarium-checkup:$(TEST_COMPOSE_PROJECT)
CHECKUP_WORKSPACE_VOLUME ?= $(TEST_COMPOSE_PROJECT)-workspace
CHECKUP_RUNNER_CONTAINER ?= $(TEST_COMPOSE_PROJECT)-runner
NODE_TEST_IMAGE ?= node:24-slim
# Keep this tag byte-for-byte aligned with the exact @playwright/test version in
# package.json; Playwright refuses to launch when client and browser image drift.
PLAYWRIGHT_TEST_IMAGE ?= mcr.microsoft.com/playwright:v1.60.0-jammy

.DEFAULT_GOAL := help
.PHONY: help prepare deps deps-vector doctor dev up start down stop restart logs ps sh \
        checkup audit-runtime test-coverage test-pg test-browser import-bench graph-revision-gate bench-session-audit backup restore backup-smoke seed seed-list \
        footage demo-shots demo-preview demo-plates image release release-rc release-smoke save clean

help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- run the stack ----------------------------------------------------------
# Pre-create every `./volumes/<x>` host bind referenced by a compose file, owned
# by the current user — otherwise Docker creates a missing bind source as root
# and the non-root container (the node image's uid 1000) can't write to it.
prepare: migration-check
	@grep -rhoE '\./volumes/[A-Za-z0-9._-]+' docker/compose*.yml 2>/dev/null \
	  | sort -u | sed 's#^\./#$(DIR)/#' | xargs -r mkdir -p

# Refuse to start a stand whose state is still in the legacy split-volume layout. The
# CONTAINER cannot catch this: the upgrade's whole effect is that ./volumes/notarium-state
# and ./volumes/spaces are no longer mounted, so from inside they simply do not exist.
# Only the host sees both layouts — which is why the guard lives here, next to the
# `git pull` that swaps compose out from under a running stand.
.PHONY: migration-check
migration-check:
	@if [ -e "$(DIR)/volumes/notarium-state/meta.db" ] && [ ! -e "$(DIR)/volumes/data/meta.db" ]; then \
	  echo ""; \
	  echo "  This stand still stores its state the legacy way, and the stack now mounts"; \
	  echo "  ONE root ($(DIR)/volumes/data). Starting as-is would ignore your existing"; \
	  echo "  notes, ids, history and accounts, and serve a first-run setup screen on an"; \
	  echo "  empty database. Stop the stand FIRST, then move the state that is NOT"; \
	  echo "  regenerable:"; \
	  echo ""; \
	  echo "    make down"; \
	  echo "    mkdir -p $(DIR)/volumes/data/spaces"; \
	  echo "    mv $(DIR)/volumes/notarium-state/meta.db* $(DIR)/volumes/data/"; \
	  echo "    [ -d $(DIR)/volumes/spaces ] && mv $(DIR)/volumes/spaces/* $(DIR)/volumes/data/spaces/"; \
	  echo "    [ -d $(DIR)/volumes/notarium-state/jobs ] && mkdir -p $(DIR)/volumes/data/jobs \\"; \
	  echo "      && mv $(DIR)/volumes/notarium-state/jobs/* $(DIR)/volumes/data/jobs/"; \
	  echo "    make up"; \
	  echo ""; \
	  echo "  \`make down\` first is not politeness: this check runs BEFORE compose, so the"; \
	  echo "  old stand is still live. \`mv\` keeps the inode, so its open handle would go on"; \
	  echo "  writing into the moved meta.db, and the emptied spaces bind reads to the"; \
	  echo "  watcher as a mass delete — tombstones and delete-revisions over the very"; \
	  echo "  notes and history this check exists to save."; \
	  echo "  jobs/ moves too: jobs/imports holds the ONLY copy of an upload while its"; \
	  echo "  import is unfinished, and meta.db carries that job's row across. Only"; \
	  echo "  engine/ is derived — leave it, it reindexes."; \
	  echo "  See README → \"Migrating from the old layout\"."; \
	  echo ""; \
	  exit 2; \
	fi

# The freshness probe checks workspace LINKS, not the lockfile — a full `npm ci` on
# every `make dev` would cost a minute for nothing. The price is that a dependency
# added to a manifest is invisible to it, so a checkout that installed before the
# change keeps a tree without the new package and this target cheerfully reports ok.
# `sqlite-vec` is therefore probed by name (#317): it arrived as a new @notarium/engine
# dependency, and a checkout that silently lacks it closes the vec0 gate and skips 47
# suites under a message that blames the platform. Probe the package the gate actually
# loads, not the manifest — a hoisted tree is what the gate sees.
deps: ## Install npm dependencies for this checkout (embedder excluded) when missing or stale
	@if node -e 'const fs = require("fs"); const path = require("path"); const root = process.cwd(); const packages = ["contract", "core", "desktop", "engine", "engine-memory", "server", "web"]; const bin = path.join(root, "node_modules", ".bin", "tsc"); if (!fs.existsSync(bin)) process.exit(1); for (const pkg of packages) { const link = path.join(root, "node_modules", "@notarium", pkg); const expected = path.join(root, "packages", pkg); if (!fs.existsSync(link) || fs.realpathSync(link) !== expected) process.exit(1); } const cli = path.join(root, "node_modules", "notarium"); if (!fs.existsSync(cli) || fs.realpathSync(cli) !== path.join(root, "packages", "cli")) process.exit(1); if (!fs.existsSync(path.join(root, "node_modules", "sqlite-vec", "package.json"))) process.exit(1);' 2>/dev/null; then \
	  echo "deps: node_modules ok"; \
	else \
	  npm run deps:lean; \
	fi

deps-vector: ## Install deps INCLUDING the optional CPU embedder (~360MB) — for embedding work and the license corpus
	npm run deps:full

doctor: deps prepare ## Validate host deps, dev compose, and container runtime assumptions
	node scripts/doctor.mjs host
	$(COMPOSE_DEV) config --quiet
	$(COMPOSE_DEV) build notarium
	$(COMPOSE_DEV) run --rm --no-deps --entrypoint sh notarium -lc 'node scripts/doctor.mjs container'

dev: deps prepare ## Dev stack with live reload (http://localhost:3000)
	$(COMPOSE_DEV) up -d --build

up: prepare ## Build & start the production image (http://localhost:3000)
	$(COMPOSE) up -d --build

start: up ## Alias for `up`

down: ## Stop and remove the stack (covers dev + prod containers)
	$(COMPOSE_DEV) down --remove-orphans

stop: ## Stop containers without removing them
	$(COMPOSE_DEV) stop

restart: down up ## Recreate the production stack

logs: ## Follow logs (all services)
	$(COMPOSE_DEV) logs -f --tail=100

ps: ## Show stack status
	$(COMPOSE_DEV) ps

sh: ## Open a shell inside the notarium container
	$(COMPOSE_DEV) exec notarium /bin/sh

# --- complete build + unit coverage -----------------------------------------
# Coverage needs the full dependency profile: a default host checkout omits the
# embedder carrier, so the license corpus cannot read the native manifests it
# validates. The test image is glibc + every workspace dependency, proves the
# production build on its way through the builder stage, then drops to the
# unprivileged node user. It leaves the live dev stand's bind-mounted node_modules
# untouched. Makefile, README.md and all of scripts/ bar the SPA size gate are test
# inputs excluded from the production image context (the backup suite drives the real
# Makefile, the release and seed tests import scripts/*.mjs, the preview suite reads the
# README's banner copy), so mount only those read-only — the bind over /app/scripts
# covers that one gate script the image does carry. The CI job hands the same three over
# with `docker cp` because under dind the daemon cannot see this checkout — keep the two
# lists in step.
test-coverage: ## Build and run full coverage (including native vector tests) in Docker
	@set -eu; \
	  cleanup() { \
	    docker rm -f $(CHECKUP_RUNNER_CONTAINER) >/dev/null 2>&1 || true; \
	    docker image rm $(CHECKUP_IMAGE) >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  docker build --target test -t $(CHECKUP_IMAGE) -f docker/Dockerfile .; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=bind,src=$(CURDIR)/Makefile,dst=/app/Makefile,readonly" \
	    --mount "type=bind,src=$(CURDIR)/scripts,dst=/app/scripts,readonly" \
	    --mount "type=bind,src=$(CURDIR)/README.md,dst=/app/README.md,readonly" \
	    --entrypoint npm "$(CHECKUP_IMAGE)" run test:coverage

# --- live database contracts -----------------------------------------------
# Keep the database off the host network: Vitest runs in the test container on
# the same private Compose network. The project suffix isolates this ephemeral
# topology from the checkout's already-running dev stand.
#
# All four containerised runners below install with the DECLARED npm: no base image in
# this repository carries an npm that clears the floor package.json declares, and .npmrc
# makes `npm ci` refuse it outright (engine-strict). So the pin is what lets these targets
# install at all, and npm itself reports its absence — there is no separate check. The
# block is the one from `.gitlab-ci.yml` and `docker/Dockerfile` verbatim: its own
# `set -eu`, nothing chained with `&&`, so its exit status is the install's wherever it
# is pasted rather than only while it happens to be last.
test-pg: ## Run meta-DB contracts/migrations against ephemeral live Postgres
	@set -eu; \
	  cleanup() { \
	    docker rm -f $(CHECKUP_RUNNER_CONTAINER) >/dev/null 2>&1 || true; \
	    $(COMPOSE_TEST) down --volumes --remove-orphans >/dev/null 2>&1 || true; \
	    docker volume rm -f $(CHECKUP_WORKSPACE_VOLUME) >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  docker volume create $(CHECKUP_WORKSPACE_VOLUME) >/dev/null; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=bind,src=$(CURDIR),dst=/source,readonly" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "tar -C /source --exclude='./.git' --exclude='./.env' --exclude='./.data' \
	      --exclude='./node_modules' --exclude='./packages/*/node_modules' \
	      --exclude='./packages/*/dist' --exclude='./docker/volumes' \
	      --exclude='./coverage' --exclude='./test-results' --exclude='./playwright-report' \
	      -cf - . | tar -C /app -xf -"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "set -eu; \
	     pinned_npm=\"\$$(node -p \"(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$$/.exec(require('./package.json').packageManager)||[,''])[1]\")\"; \
	     [ -n \"\$$pinned_npm\" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
	     npm i -g \"npm@\$$pinned_npm\"; \
	     npm -v; \
	     npm run deps:lean"; \
	  $(COMPOSE_TEST) up -d --wait postgres; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --network "$(TEST_COMPOSE_PROJECT)_default" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp \
	    -e TEST_PG_URL=postgres://notarium:notarium@postgres:5432/notarium_test \
	    --entrypoint npm "$(NODE_TEST_IMAGE)" run test:pg

# --- import scale bench -----------------------------------------------------
# The #302 scale artifact: 10 000 Markdown members through the production
# composition (real server, real HTTP route, real durable job) into a data root
# inside the container. Containerised for the same reason test-pg is — the numbers
# are only comparable across runs if the Node, the dependency profile and the
# filesystem underneath them are the same, and a bench that writes 10 000 notes has
# no business doing it in the checkout. Correctness fails the run; timings are
# printed, never asserted. NOTES trims the corpus for a quicker shape.
NOTES ?= 10000
SOURCE ?= archive
import-bench: ## Run the Markdown-tree import scale bench in Docker: make import-bench [SOURCE=folder] [NOTES=10000]
	@set -eu; \
	  cleanup() { \
	    docker rm -f $(CHECKUP_RUNNER_CONTAINER) >/dev/null 2>&1 || true; \
	    docker volume rm -f $(CHECKUP_WORKSPACE_VOLUME) >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  docker volume create $(CHECKUP_WORKSPACE_VOLUME) >/dev/null; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=bind,src=$(CURDIR),dst=/source,readonly" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "tar -C /source --exclude='./.git' --exclude='./.env' --exclude='./.data' \
	      --exclude='./node_modules' --exclude='./packages/*/node_modules' \
	      --exclude='./packages/*/dist' --exclude='./docker/volumes' \
	      --exclude='./coverage' --exclude='./test-results' --exclude='./playwright-report' \
	      -cf - . | tar -C /app -xf -"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "set -eu; \
	     pinned_npm=\"\$$(node -p \"(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$$/.exec(require('./package.json').packageManager)||[,''])[1]\")\"; \
	     [ -n \"\$$pinned_npm\" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
	     npm i -g \"npm@\$$pinned_npm\"; \
	     npm -v; \
	     npm run deps:lean"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp -e NOTES=$(NOTES) -e SOURCE=$(SOURCE) \
	    --entrypoint npm "$(NODE_TEST_IMAGE)" run bench:import-markdown-tree

# --- graph revision production gate ----------------------------------------
# One command owns the #410 disposable contour: traceable runtime image, neutral
# 1357-note/20.3-MiB seed, vector+graph-enabled server, isolated GC memory report
# and the concurrent one-note mutation probe. Nothing is published.
GRAPH_REVISION_COMMIT ?= $(if $(CI_COMMIT_SHA),$(CI_COMMIT_SHA),$(shell if test -z "$$(git status --porcelain --untracked-files=normal 2>/dev/null)"; then git rev-parse HEAD 2>/dev/null; else echo unknown; fi))
GRAPH_REVISION_BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
GRAPH_REVISION_OUTPUT_DIR ?= $(CURDIR)/test-results/graph-revision
GRAPH_REVISION_RUNTIME_IMAGE ?= notarium-graph-revision-runtime:$(TEST_COMPOSE_PROJECT)
GRAPH_REVISION_RUNNER_IMAGE ?= notarium-graph-revision-runner:$(TEST_COMPOSE_PROJECT)
GRAPH_REVISION_CONTAINER ?= $(TEST_COMPOSE_PROJECT)-graph-revision
GRAPH_REVISION_SEED_CONTAINER ?= $(TEST_COMPOSE_PROJECT)-graph-seed
GRAPH_REVISION_RUNNER_CONTAINER ?= $(TEST_COMPOSE_PROJECT)-graph-runner
GRAPH_REVISION_VOLUME ?= $(TEST_COMPOSE_PROJECT)-graph-data
GRAPH_REVISION_NETWORK ?= $(TEST_COMPOSE_PROJECT)-graph-net

graph-revision-gate: ## Run the #410 production-shaped graph revision + memory gates
	@set -euo pipefail; \
	  cleanup() { \
	    docker rm -f "$(GRAPH_REVISION_CONTAINER)" "$(GRAPH_REVISION_SEED_CONTAINER)" "$(GRAPH_REVISION_RUNNER_CONTAINER)" >/dev/null 2>&1 || true; \
	    docker volume rm -f "$(GRAPH_REVISION_VOLUME)" >/dev/null 2>&1 || true; \
	    docker network rm "$(GRAPH_REVISION_NETWORK)" >/dev/null 2>&1 || true; \
	    docker image rm -f "$(GRAPH_REVISION_RUNTIME_IMAGE)" "$(GRAPH_REVISION_RUNNER_IMAGE)" >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  test "$(GRAPH_REVISION_COMMIT)" != unknown || { echo 'graph revision gate requires a clean commit or explicit frozen tree identity' >&2; exit 2; }; \
	  mkdir -p "$(GRAPH_REVISION_OUTPUT_DIR)"; \
	  docker build --target runtime -t "$(GRAPH_REVISION_RUNTIME_IMAGE)" \
	    --build-arg GIT_SHA="$(GRAPH_REVISION_COMMIT)" \
	    --build-arg GIT_REVISION="$(GRAPH_REVISION_COMMIT)" \
	    --build-arg BUILD_TIME="$(GRAPH_REVISION_BUILD_TIME)" \
	    -f docker/Dockerfile .; \
	  docker build --target builder -t "$(GRAPH_REVISION_RUNNER_IMAGE)" \
	    --build-arg GIT_SHA="$(GRAPH_REVISION_COMMIT)" \
	    --build-arg BUILD_TIME="$(GRAPH_REVISION_BUILD_TIME)" \
	    -f docker/Dockerfile .; \
	  docker volume create "$(GRAPH_REVISION_VOLUME)" >/dev/null; \
	  docker network create "$(GRAPH_REVISION_NETWORK)" >/dev/null; \
	  tar -cf - scripts test | docker run --rm -i --name "$(GRAPH_REVISION_SEED_CONTAINER)" \
	    --mount "type=volume,src=$(GRAPH_REVISION_VOLUME),dst=/data" \
	    --workdir /app -e DATA_DIR=/data -e CASE=graph-revision \
	    -e SEED_USER=admin -e SEED_PASSWORD=admin \
	    --entrypoint sh "$(GRAPH_REVISION_RUNNER_IMAGE)" -c 'tar -C /app -xf -; npm run seed'; \
	  tar -cf - scripts test | docker run --rm -i --name "$(GRAPH_REVISION_SEED_CONTAINER)" \
	    --mount "type=volume,src=$(GRAPH_REVISION_VOLUME),dst=/data" \
	    --workdir /app -e GRAPH_REVISION_NOTES_DIR=/data/spaces/graph-revision \
	    -e GRAPH_REVISION_CORPUS_OUTPUT=/data/graph-revision-corpus.json \
	    --entrypoint sh "$(GRAPH_REVISION_RUNNER_IMAGE)" -c 'tar -C /app -xf -; npm run bench:graph-revision-corpus'; \
	  docker run --rm \
	    --mount "type=volume,src=$(GRAPH_REVISION_VOLUME),dst=/data" \
	    --entrypoint chown "$(GRAPH_REVISION_RUNNER_IMAGE)" -R node:node /data; \
	  docker create --name "$(GRAPH_REVISION_RUNNER_CONTAINER)" \
	    --workdir /app -e GRAPH_REVISION_MEMORY_OUTPUT=/tmp/graph-revision-memory.json \
	    --entrypoint npm "$(GRAPH_REVISION_RUNNER_IMAGE)" run bench:graph-revision-memory >/dev/null; \
	  docker cp ./scripts/. "$(GRAPH_REVISION_RUNNER_CONTAINER):/app/scripts"; \
	  docker start --attach "$(GRAPH_REVISION_RUNNER_CONTAINER)"; \
	  docker cp "$(GRAPH_REVISION_RUNNER_CONTAINER):/tmp/graph-revision-memory.json" \
	    "$(GRAPH_REVISION_OUTPUT_DIR)/memory.json"; \
	  docker rm -f "$(GRAPH_REVISION_RUNNER_CONTAINER)" >/dev/null; \
	  docker run -d --name "$(GRAPH_REVISION_CONTAINER)" \
	    --network "$(GRAPH_REVISION_NETWORK)" --network-alias notarium \
	    --mount "type=volume,src=$(GRAPH_REVISION_VOLUME),dst=/data" \
	    --mount "type=tmpfs,dst=/app/node_modules/@huggingface/transformers/.cache,tmpfs-mode=1777" \
	    -e AUTH_MODE=password -e VECTOR_SEARCH=on -e GRAPH_BOOST=on \
	    -e GRAPH_ADJACENCY_OBSERVATION_FILE=/data/graph-revision-adjacency.json \
	    -e GRAPH_ADJACENCY_OBSERVATION_SPACE=graph-revision \
	    -e GRAPH_ADJACENCY_OBSERVATION_SOURCE=source/graph-revision-source.md \
	    -e GRAPH_ADJACENCY_OBSERVATION_TARGET=target/adjacency-target.md \
	    -e WIKILINK_PARSE_CACHE=on -e EMBED_MODEL=Xenova/multilingual-e5-small \
	    -e EMBED_DIMENSIONS=384 -e 'EMBED_QUERY_PREFIX=query: ' -e 'EMBED_PASSAGE_PREFIX=passage: ' \
	    -e EMBED_WORKERS=2 -e EMBED_THREADS=1 -e EMBED_CPU_MEM_ARENA=off \
	    "$(GRAPH_REVISION_RUNTIME_IMAGE)" >/dev/null; \
	  healthy=0; \
	  for attempt in $$(seq 1 120); do \
	    state="$$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$(GRAPH_REVISION_CONTAINER)")"; \
	    if [ "$$state" = healthy ]; then healthy=1; break; fi; \
	    if [ "$$state" = unhealthy ]; then docker logs "$(GRAPH_REVISION_CONTAINER)"; exit 1; fi; \
	    sleep 5; \
	  done; \
	  if [ "$$healthy" != 1 ]; then docker logs "$(GRAPH_REVISION_CONTAINER)"; echo 'graph revision server did not become healthy' >&2; exit 1; fi; \
	  image="$$(docker inspect --format '{{.Image}}' "$(GRAPH_REVISION_CONTAINER)")"; \
	  revision="$$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(GRAPH_REVISION_CONTAINER)")"; \
	  test "$$revision" = "$(GRAPH_REVISION_COMMIT)" || { echo "graph revision OCI revision mismatch: $$revision" >&2; exit 1; }; \
	  docker create --name "$(GRAPH_REVISION_RUNNER_CONTAINER)" \
	    --network "$(GRAPH_REVISION_NETWORK)" \
	    --mount "type=volume,src=$(GRAPH_REVISION_VOLUME),dst=/benchmark-data,readonly" \
	    --workdir /app -e BASE_URL=http://notarium:3000 \
	    -e BENCH_COMMIT="$(GRAPH_REVISION_COMMIT)" -e BENCH_IMAGE="$$image" \
	    -e BENCH_IMAGE_REVISION="$$revision" -e BENCH_CONTAINER="$(GRAPH_REVISION_CONTAINER)" \
	    -e GRAPH_REVISION_CORPUS_REPORT=/benchmark-data/graph-revision-corpus.json \
	    -e GRAPH_REVISION_ADJACENCY_REPORT=/benchmark-data/graph-revision-adjacency.json \
	    -e GRAPH_REVISION_OUTPUT=/tmp/graph-revision-runtime.json \
	    --entrypoint npm "$(GRAPH_REVISION_RUNNER_IMAGE)" run bench:graph-revision >/dev/null; \
	  docker cp ./scripts/. "$(GRAPH_REVISION_RUNNER_CONTAINER):/app/scripts"; \
	  if ! docker start --attach "$(GRAPH_REVISION_RUNNER_CONTAINER)"; then \
	    docker logs "$(GRAPH_REVISION_CONTAINER)"; \
	    exit 1; \
	  fi; \
	  docker cp "$(GRAPH_REVISION_RUNNER_CONTAINER):/tmp/graph-revision-runtime.json" \
	    "$(GRAPH_REVISION_OUTPUT_DIR)/runtime.json"; \
	  docker rm -f "$(GRAPH_REVISION_RUNNER_CONTAINER)" >/dev/null

# --- session activity read-model benchmark ----------------------------------
BENCH_PHASE ?= pre
BENCH_SIZES ?= 10000,100000,500000
BENCH_OUTPUT_DIR ?= $(CURDIR)/test-results/session-audit-bench
BENCH_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)

bench-session-audit: ## Benchmark the session activity read-model on SQLite and Postgres
	@set -eu; \
	  cleanup() { \
	    docker rm -f $(CHECKUP_RUNNER_CONTAINER) >/dev/null 2>&1 || true; \
	    $(COMPOSE_TEST) down --volumes --remove-orphans >/dev/null 2>&1 || true; \
	    docker volume rm -f $(CHECKUP_WORKSPACE_VOLUME) >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  mkdir -p "$(BENCH_OUTPUT_DIR)"; \
	  docker volume create $(CHECKUP_WORKSPACE_VOLUME) >/dev/null; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=bind,src=$(CURDIR),dst=/source,readonly" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "tar -C /source --exclude='./.git' --exclude='./.env' --exclude='./.data' \
	      --exclude='./node_modules' --exclude='./packages/*/node_modules' \
	      --exclude='./packages/*/dist' --exclude='./docker/volumes' \
	      --exclude='./coverage' --exclude='./test-results' --exclude='./playwright-report' \
	      -cf - . | tar -C /app -xf -"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "set -eu; \
	     pinned_npm=\"\$$(node -p \"(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$$/.exec(require('./package.json').packageManager)||[,''])[1]\")\"; \
	     [ -n \"\$$pinned_npm\" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
	     npm i -g \"npm@\$$pinned_npm\"; \
	     npm -v; \
	     npm run deps:lean"; \
	  $(COMPOSE_TEST) up -d --wait postgres; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --user $(HOST_UID):$(HOST_GID) \
	    --network "$(TEST_COMPOSE_PROJECT)_default" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --mount "type=bind,src=$(BENCH_OUTPUT_DIR),dst=/output" \
	    --workdir /app -e HOME=/tmp -e NODE_ENV=test \
	    -e TEST_PG_URL=postgres://notarium:notarium@postgres:5432/notarium_test \
	    -e BENCH_PHASE="$(BENCH_PHASE)" -e BENCH_SIZES="$(BENCH_SIZES)" \
	    -e BENCH_COMMIT="$(BENCH_COMMIT)" \
	    -e BENCH_OUTPUT="/output/$(BENCH_PHASE).json" \
	    -e BENCH_BASELINE="/output/pre.json" \
	    -e BENCH_NODE_IMAGE="$(NODE_TEST_IMAGE)" -e BENCH_PG_IMAGE=postgres:16-alpine \
	    --entrypoint npx "$(NODE_TEST_IMAGE)" tsx scripts/benchSessionAudit.ts

# The pinned Playwright container owns browsers/fonts/system libraries. A clean
# source snapshot (including external baselines, excluding host deps/state) is
# copied from a read-only bind into one invocation-scoped writable volume; the
# original checkout never receives build or report output.
test-browser: ## Run container-native e2e and installed visual baselines
	@set -eu; \
	  cleanup() { \
	    docker rm -f $(CHECKUP_RUNNER_CONTAINER) >/dev/null 2>&1 || true; \
	    docker volume rm -f $(CHECKUP_WORKSPACE_VOLUME) >/dev/null 2>&1 || true; \
	  }; \
	  trap cleanup EXIT INT TERM; \
	  cleanup; \
	  docker volume create $(CHECKUP_WORKSPACE_VOLUME) >/dev/null; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=bind,src=$(CURDIR),dst=/source,readonly" \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --entrypoint sh "$(NODE_TEST_IMAGE)" -c \
	    "tar -C /source --exclude='./.git' --exclude='./.env' --exclude='./.data' \
	      --exclude='./node_modules' --exclude='./packages/*/node_modules' \
	      --exclude='./packages/*/dist' --exclude='./docker/volumes' \
	      --exclude='./coverage' --exclude='./test-results' --exclude='./playwright-report' \
	      -cf - . | tar -C /app -xf -"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp --entrypoint sh "$(PLAYWRIGHT_TEST_IMAGE)" -c \
	    "set -eu; \
	     pinned_npm=\"\$$(node -p \"(/^npm@([0-9]+[.][0-9]+[.][0-9]+([-][0-9A-Za-z.-]+)?)([+].*)?$$/.exec(require('./package.json').packageManager)||[,''])[1]\")\"; \
	     [ -n \"\$$pinned_npm\" ] || { echo 'package.json packageManager must be npm@<x.y.z>' >&2; exit 1; }; \
	     npm i -g \"npm@\$$pinned_npm\"; \
	     npm -v; \
	     npm run deps:lean"; \
	  docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) --ipc=host \
	    --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	    --workdir /app -e HOME=/tmp -e CI=1 \
	    -e PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/playwright-report \
	    --entrypoint npm "$(PLAYWRIGHT_TEST_IMAGE)" run e2e -- --output=/tmp/test-results; \
	  if test -n "$$(find test/visual/visual.spec.ts-snapshots -maxdepth 1 \
	      -type f -name '*.png' -print -quit 2>/dev/null)"; then \
	    docker run --rm --name $(CHECKUP_RUNNER_CONTAINER) --ipc=host \
	      --mount "type=volume,src=$(CHECKUP_WORKSPACE_VOLUME),dst=/app" \
	      --workdir /app -e HOME=/tmp -e CI=1 \
	      -e PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/playwright-report \
	      --entrypoint npx "$(PLAYWRIGHT_TEST_IMAGE)" \
	      playwright test test/visual --output=/tmp/test-results; \
	  else \
	    echo "visual: skipped — external baselines are not present in this checkout"; \
	  fi

# Fast checks fail before the expensive isolated integration layers. The
# containerized coverage target already proves the production build and runs the
# complete Vitest suite, so do not duplicate either on the host.
# Browser tests share the canonical Playwright container but not a long-lived
# server; each runner owns its webServer and the trap removes its disposable
# source/dependency volume.
checkup: deps ## Run every portable gate; visual too when its external baselines are present
	npm run format:check
	npm run canon:check
	npm run meta-migrations:check
	npm run audit:runtime
	npm run lint
	npm run typecheck
	$(MAKE) --no-print-directory test-coverage
	$(MAKE) --no-print-directory test-pg
	$(MAKE) --no-print-directory backup-smoke
	$(MAKE) --no-print-directory test-browser

audit-runtime: ## Audit the full production dependency graph against exact reviewed exceptions
	npm run audit:runtime

# --- backup / disaster restore --------------------------------------
# Optional checkout wrappers over the image-native `backup` / `restore` commands
# interface. The product contract lives in the container, not in this Makefile.
BACKUP ?= backups/notarium-$(shell date -u +%Y%m%dT%H%M%SZ).zip
RESTORE_DATA_ROOT ?= $(DIR)/volumes/data

backup: ## Create a verified ONLINE backup: make backup [BACKUP=backups/name.zip]
	@set -eu; \
	  target="$(abspath $(BACKUP))"; \
	  test ! -e "$$target" || { echo "backup target already exists: $$target"; exit 2; }; \
	  mkdir -p "$$(dirname "$$target")"; \
	  umask 077; \
	  partial="$$target.partial-$$$$"; \
	  committed=0; \
	  cleanup() { test "$$committed" -eq 1 || rm -f "$$partial"; }; \
	  trap cleanup EXIT; \
	  $(COMPOSE_DEV) exec -T notarium backup > "$$partial"; \
	  sync -f "$$partial"; \
	  sync -f "$$(dirname "$$target")"; \
	  committed=1; \
	  ln "$$partial" "$$target"; \
	  if sync -f "$$(dirname "$$target")"; then \
	    if rm "$$partial"; then \
	      sync -f "$$(dirname "$$target")" || echo "backup warning: final is durable; partial cleanup fsync failed" >&2; \
	    else \
	      echo "backup warning: final is durable; retaining recovery partial $$partial" >&2; \
	    fi; \
	  else \
	    echo "backup warning: final is visible; retaining durable recovery partial $$partial" >&2; \
	  fi; \
	  trap - EXIT; \
	  echo "backup: $$target"

restore: ## DEV checkout only: restore BACKUP into a fresh bind root, retaining rollback
	@set -eu; \
	  archive="$(abspath $(BACKUP))"; \
	  test -f "$$archive" || { echo "usage: make restore BACKUP=backups/name.zip"; exit 2; }; \
	  container="$$( $(COMPOSE_DEV) ps -aq notarium )"; \
	  test -n "$$container" || { echo "restore needs an existing DEV checkout container; run 'make dev' first"; exit 2; }; \
	  config_files="$$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$$container")"; \
	  case ",$$config_files," in *",$(abspath $(DIR)/compose.dev.yml),"*) ;; \
	    *) echo "make restore is DEV-only and refuses a production Compose topology" >&2; exit 2 ;; \
	  esac; \
	  running="$$( $(COMPOSE_DEV) ps -q notarium )"; \
	  root="$(abspath $(RESTORE_DATA_ROOT))"; \
	  test -d "$$root" || { echo "restore data root does not exist: $$root"; exit 2; }; \
	  rollback="$$root.before-restore-$$(date -u +%Y%m%dT%H%M%SZ)-$$$$"; \
	  failed="$$root.failed-restore-$$(date -u +%Y%m%dT%H%M%SZ)-$$$$"; \
	  committed=0; \
	  rollback_on_error() { \
	    status=$$?; \
	    trap - EXIT INT TERM; \
	    if [ "$$committed" = 0 ] && [ -e "$$rollback" ]; then \
	      test ! -e "$$root" || mv "$$root" "$$failed"; \
	      mv "$$rollback" "$$root"; \
	      echo "restore failed; original data reinstated; failed target retained at $$failed" >&2; \
	    fi; \
	    if [ "$$committed" = 0 ]; then \
	      test -z "$$running" || $(COMPOSE_DEV) up -d --force-recreate --no-deps notarium >/dev/null || true; \
	    fi; \
	    exit "$$status"; \
	  }; \
	  trap rollback_on_error EXIT; \
	  trap 'exit 130' INT; \
	  trap 'exit 143' TERM; \
	  echo "restore: stopping Notarium (backup itself remains online)…"; \
	  $(COMPOSE_DEV) stop notarium >/dev/null; \
	  mv "$$root" "$$rollback"; \
	  mkdir -p "$$root"; \
	  $(COMPOSE_DEV) run --rm --no-deps -T notarium restore < "$$archive"; \
	  test -z "$$running" || $(COMPOSE_DEV) up -d --force-recreate --no-deps notarium; \
	  committed=1; \
	  trap - EXIT INT TERM; \
	  echo "restore: verified; rollback data retained at $$rollback"

# How many times the driver runs against the SAME pair of images. One is the gate;
# a higher count is the acceptance sweep for a flake that only shows up across runs.
BACKUP_SMOKE_RUNS ?= 1

# A tag no other checkout and no other run can be holding; why the drill tags at all is
# in docs/dev-environment.md. `CHECKOUT_SLUG` reduces to empty for a worktree named
# entirely outside `[a-z0-9_-]`, and an empty component is an invalid reference, so fall
# back to the path hash.
BACKUP_SMOKE_TAG := notarium-backup-smoke:$(or $(CHECKOUT_SLUG),wt$(CHECKOUT_HASH))-$(CHECKUP_RUN_SUFFIX)

# The ONE orchestration owner for this drill, local and CI alike — the YAML adapter
# calls this target instead of restating the builds.
#
# No signal forwarding and no process wrapper: a foreground SIGINT/SIGTERM reaches the
# driver directly, and the driver's own cleanup contract stays the single owner of the
# containers, volumes and archive it created. The signal traps re-raise rather than
# return, or the recipe would resume into the next build after a cancel.
backup-smoke: ## Destructive backup→fresh-volume restore smoke in isolated Docker
	@set -eu; \
	  case "$(BACKUP_SMOKE_RUNS)" in \
	    ''|*[!0-9]*) echo "backup-smoke: BACKUP_SMOKE_RUNS must be a positive integer, got '$(BACKUP_SMOKE_RUNS)'"; exit 2;; \
	  esac; \
	  test "$(BACKUP_SMOKE_RUNS)" -ge 1 || { echo "backup-smoke: BACKUP_SMOKE_RUNS must be >= 1, got '$(BACKUP_SMOKE_RUNS)'"; exit 2; }; \
	  tmp="$$(mktemp -d "$${TMPDIR:-/tmp}/notarium-backup-smoke-make-XXXXXX")"; \
	  cleanup() { \
	    for image in "$(BACKUP_SMOKE_TAG)-runtime" "$(BACKUP_SMOKE_TAG)-fixture"; do \
	      docker image inspect "$$image" >/dev/null 2>&1 || continue; \
	      docker image rm "$$image" >/dev/null 2>&1 \
	        || echo "backup-smoke: could not drop $$image; it is still on this daemon" >&2; \
	    done; \
	    rm -rf "$$tmp"; \
	  }; \
	  trap cleanup EXIT; \
	  trap 'trap - EXIT INT; cleanup; kill -INT $$$$' INT; \
	  trap 'trap - EXIT TERM; cleanup; kill -TERM $$$$' TERM; \
	  mkdir -p "$$tmp/driver"; \
	  docker build --load -t "$(BACKUP_SMOKE_TAG)-runtime" --target runtime --iidfile "$$tmp/runtime.iid" -f docker/Dockerfile .; \
	  docker build --load -t "$(BACKUP_SMOKE_TAG)-fixture" --target builder --iidfile "$$tmp/fixture.iid" -f docker/Dockerfile .; \
	  test -s "$$tmp/runtime.iid" || { echo "backup-smoke: runtime build wrote no image id"; exit 2; }; \
	  test -s "$$tmp/fixture.iid" || { echo "backup-smoke: fixture build wrote no image id"; exit 2; }; \
	  runtime_image="$$(cat "$$tmp/runtime.iid")"; \
	  fixture_image="$$(cat "$$tmp/fixture.iid")"; \
	  run=1; \
	  while [ "$$run" -le "$(BACKUP_SMOKE_RUNS)" ]; do \
	    echo "backup-smoke: run $$run/$(BACKUP_SMOKE_RUNS) on $$runtime_image + $$fixture_image"; \
	    BACKUP_SMOKE_IMAGE="$$runtime_image" \
	      BACKUP_SMOKE_FIXTURE_IMAGE="$$fixture_image" \
	      TMPDIR="$$tmp/driver" node test/backup/smoke.mjs; \
	    leftover="$$(find "$$tmp/driver" -maxdepth 1 -name 'notarium-backup-smoke-*' -print -quit)"; \
	    test -z "$$leftover" || { echo "backup-smoke: driver left $$leftover"; exit 2; }; \
	    run=$$((run + 1)); \
	  done

# --- seed the local stand --------------------------------------------
# (Re)fill the running stand from a declarative catalog case. The engine holds
# the meta-DB open under WAL, so we stop → WIPE the volumes → seed IN-PROCESS on
# the host (writing the same host-bind DB the server reads, with a backdated
# journal so the heatmap/feed/trash look real, not one "today" spike) → start.
# The seeder targets the host binds directly (docker/volumes), so no container.
#   make seed CASE=feed-scroll [SCALE=1] [SEED=default] [PASSWORD=…]
#   make seed-list      # list the cases
# One root, same as the stack's — the seeder derives meta.db / engine /
# jobs / spaces from it exactly like the server does, so the two cannot drift.
SEED_ENV := DATA_DIR=$(DIR)/volumes/data
# The host port the stand actually binds: PORT make-var, else .env's PORT, else the
# compose default 3000 — so the seed banner's URL matches where the stack listens.
SEED_PORT := $(or $(PORT),$(shell sed -n 's/^PORT=//p' .env 2>/dev/null | head -1),3000)

seed: deps prepare ## (Re)seed the local stand from a catalog case — default login admin/admin: make seed CASE=<name> [SCALE=1] [SEED=default] [PASSWORD=…]
	@test -n "$(CASE)" || { echo "usage: make seed CASE=<name> [SCALE=1] [SEED=default] [PASSWORD=…]   (make seed-list to list cases)"; exit 2; }
	$(COMPOSE_DEV) stop
	@echo "seed: wiping stand data root…"
	@find $(DIR)/volumes/data -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
	CASE=$(CASE) SCALE=$(or $(SCALE),1) SEED=$(or $(SEED),default) PORT=$(SEED_PORT) \
	  $(if $(PASSWORD),SEED_PASSWORD=$(PASSWORD),) $(SEED_ENV) \
	  npx tsx scripts/seed.ts
	$(COMPOSE_DEV) up -d --build
	@echo ""
	@echo "  ┌─ dev stand ready ──────────────────────────────"
	@echo "  │   URL:    http://localhost:$(SEED_PORT)"
	@echo "  │   login:  $(or $(SEED_USER),admin) / $(or $(PASSWORD),$(or $(SEED_PASSWORD),admin))   (override: SEED_USER/SEED_PASSWORD)"
	@echo "  └─────────────────────────────────────────────────"

seed-list: ## List the available seed cases
	@npx tsx scripts/seed.ts --list

.PHONY: seed-coverage
seed-coverage: ## Print the seed catalog coverage matrix — axis × case, feature × fragment
	@npx tsx scripts/coverage.ts

# --- footage: the published pictures of the product -------------------------
# Two stages over the `demo` seed case, both in the Playwright container for the same
# reason baselines run there — host fonts differ, and these pixels are published.
#
#   1. demo-shots   photograph the app        → test/demo/out/<locale>/ (git-ignored)
#   2. demo-preview compose the artwork       → assets/ (committed)
#
# `make footage` runs both; each stage stands alone, because re-cutting the banner is
# seconds while re-shooting the app is a minute. See docs/demo-screenshots.md.
# Sequenced in the recipe, not as prerequisites: stage two reads what stage one writes,
# and prerequisites of one target are fair game for `make -j` to run at the same time.
footage: ## Re-shoot the app and re-cut the README artwork: make footage [LOCALE=en]
	@$(MAKE) --no-print-directory demo-shots
	@$(MAKE) --no-print-directory demo-preview

demo-shots: deps ## Shoot the demo screenshots from the `demo` seed case: make demo-shots [LOCALE=en]
	@LOCALE=$(or $(LOCALE),en) npm run demo:shots

demo-preview: deps ## Compose the README banner, social card and gallery from the stills
	@LOCALE=$(or $(LOCALE),en) npm run demo:preview

# The docs site sets its own type (per page, in nine languages) over these, so they carry
# no words — which is also why they are re-cut on their own: the README artwork answers to
# the README's copy and has no reason to churn when a plate's geometry changes.
demo-plates: deps ## Re-cut ONLY the OG background plates the docs site builds its cards on
	@LOCALE=$(or $(LOCALE),en) DEMO_SET=plates npm run demo:preview

# --- image: build & publish -------------------------------------------------
# `image` is the LOCAL build (your working tree, no identity, no publication).
# Publishing goes through `release` and nowhere else — see docs/release.md. There
# is deliberately no `push` target: a bare push is how a version tag gets
# overwritten with an unidentified build, which is the whole failure this flow
# exists to prevent.
image: ## Build the production image locally from the working tree (no commit/source link; not publishable)
	docker build -t $(IMAGE):$(VERSION) -f docker/Dockerfile .

release: deps ## Publish a traceable image: build from the release tag, verify identity, push :<version> then :latest
	npm run release:image -- $(RELEASE_FLAGS)

# A pre-release is its own target rather than a flag you have to remember: the two
# differ in what they PROMISE (a release claims the version and moves `latest`; an
# rc claims neither), and that is not a distinction to leave to a typo in an
# argument list. The candidate base is the exact version already prepared in the
# manifests. RELEASE_FLAGS stays for the rare extras (--registry, --force-latest).
release-rc: deps ## Publish :<prepared-version>-rc.<n> — no release tag needed, :latest untouched
	npm run release:image -- --prerelease $(RELEASE_FLAGS)

# The SAME entrypoint against a throwaway local registry, so the parts that only
# exist at publication time (immutability gate, digest, version→latest ordering)
# are exercised before a real release rather than during one.
release-smoke: deps ## Run the full release flow against a disposable local registry
	node test/release/smoke.mjs

# Registry-less delivery: export the built image to a tarball for an offline /
# air-gapped / self-host deploy (no registry, no push) — `docker load` it on the
# target host. Universal: no instance baked in, all config stays in the host's
# compose/.env. Pairs with `make image`.
# NOT a release: this exports whatever `make image` last built — a working-tree
# build with no commit, no source link and empty OCI labels — under the version
# number from package.json. For an artifact anyone else will run, publish a release
# and export that (`docker pull` the digest, then `docker save`).
save: ## Export the LOCAL image to a gzipped tar (registry-less deploy; carries no release identity)
	docker save $(IMAGE):$(VERSION) | gzip > notarium-$(VERSION).tar.gz
	@echo "wrote notarium-$(VERSION).tar.gz ($(IMAGE):$(VERSION))"

clean: ## Stop the stack and remove the local dist/ build
	-$(COMPOSE_DEV) down --remove-orphans
	rm -rf packages/web/dist
