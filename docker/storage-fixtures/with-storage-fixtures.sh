#!/bin/sh
# Product-owned lifecycle manager for offline PostgreSQL 16 + MinIO CE fixtures.
set -eu

umask 022

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
COMPOSE_FILE="$ROOT/compose.storage-tests.yaml"
PG_IMAGE="postgres:16-bookworm@sha256:a49f7438ba03589f9b1ca062f2da82e899b48ea1dc50d2449fa09a70be83ebca"

CHECKOUT_HASH=$(printf '%s' "$ROOT" | sha256sum | cut -c1-12)
FIXTURES_BASE="$ROOT/.artifacts/storage-tests"
ACTIVE_MANIFEST="$FIXTURES_BASE/current.json"

fail() {
  printf 'storage-fixtures: %s\n' "$*" >&2
  exit 1
}

random_hex() {
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
}

source_tree() (
  # Snapshot tracked and non-ignored source without modifying the developer's index.
  GIT_INDEX_FILE="$FIXTURES_BASE/benchmark.index"
  export GIT_INDEX_FILE
  trap 'rm -f -- "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.lock"' EXIT
  rm -f -- "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.lock"
  git -C "$ROOT" read-tree HEAD
  git -C "$ROOT" add -A -- .
  git -C "$ROOT" write-tree
)

sweep_stale_runs() {
  stale_containers=$(docker ps -aq --filter "label=io.notarium.storage-fixture.checkout=$CHECKOUT_HASH" 2>/dev/null || true)
  if [ -n "$stale_containers" ]; then
    # Clean up crash leftovers belonging strictly to this checkout.
    # shellcheck disable=SC2086
    docker rm -fv $stale_containers >/dev/null 2>&1 || true
  fi
  rm -f -- "$ACTIVE_MANIFEST"
  if [ -d "$FIXTURES_BASE" ]; then
    for entry in "$FIXTURES_BASE"/run-*; do
      [ -e "$entry" ] || continue
      rm -rf -- "$entry" 2>/dev/null || true
    done
  fi
}

recipe_sha256() {
  # Dockerfile-specific ignore rules take precedence over the context-wide file.
  if [ -f "$ROOT/$1.dockerignore" ]; then
    set -- "$@" "$1.dockerignore"
  elif [ -f "$ROOT/.dockerignore" ]; then
    set -- "$@" .dockerignore
  fi
  set -- compose.storage-tests.yaml "$@"
  recipe=
  for input in "$@"; do
    digest=$(sha256sum <"$ROOT/$input") || fail "cannot hash fixture recipe input: $input"
    recipe="$recipe$input
${digest%% *}
"
  done
  digest=$(printf '%s' "$recipe" | sha256sum) || fail "cannot hash fixture recipe"
  printf '%s\n' "${digest%% *}"
}

export_recipe_shas() {
  NOTARIUM_MINIO_RECIPE_SHA256=$(recipe_sha256 docker/storage-fixtures/minio-ce.Dockerfile)
  NOTARIUM_BRIDGE_RECIPE_SHA256=$(recipe_sha256 docker/storage-fixtures/uds-bridge.Dockerfile docker/storage-fixtures/uds_tcp_bridge.rs)
  export NOTARIUM_MINIO_RECIPE_SHA256 NOTARIUM_BRIDGE_RECIPE_SHA256
  MINIO_IMAGE="notarium-storage-fixture-minio-ce:$NOTARIUM_MINIO_RECIPE_SHA256"
  BRIDGE_IMAGE="notarium-storage-fixture-uds-bridge:$NOTARIUM_BRIDGE_RECIPE_SHA256"
}

fixture_image_id() {
  [ -n "$2" ] || return 1
  observed=$(docker image inspect --format '{{.Id}} {{index .Config.Labels "io.notarium.fixture-recipe-sha256"}}' "$1" 2>/dev/null) || return 1
  [ "${observed#* }" = "$2" ] || return 1
  case "${observed%% *}" in
    sha256:*) printf '%s\n' "${observed%% *}" ;;
    *) return 1 ;;
  esac
}

ensure_fixture_image() {
  image=$1 dockerfile=$2 expected=$3 force=$4
  if [ "$force" = 0 ] && fixture_image_id "$image" "$expected" >/dev/null; then
    printf 'storage-fixtures: reusing %s\n' "$image"
    return
  fi
  # Compose's service network dependency would also build MinIO for the bridge.
  docker build -f "$ROOT/$dockerfile" --build-arg "NOTARIUM_FIXTURE_RECIPE_SHA256=$expected" -t "$image" "$ROOT"
  fixture_image_id "$image" "$expected" >/dev/null || fail "built fixture image '$image' did not match its recipe"
}

setup_images() {
  case "$#:${1:-}" in
    0:) force=0 ;;
    1:--force) force=1 ;;
    *) fail "usage: setup-images [--force]" ;;
  esac
  if [ "$skip_api_fixtures" = 1 ]; then
    [ "$force" = 0 ] || fail "NOTARIUM_SKIP_API_FIXTURES=1 cannot be used with --force"
    printf 'storage-fixtures: skipping fixture image setup (NOTARIUM_SKIP_API_FIXTURES=1)\n' >&2
    return
  fi
  export_recipe_shas
  if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
    docker pull "$PG_IMAGE"
  fi
  ensure_fixture_image "$MINIO_IMAGE" docker/storage-fixtures/minio-ce.Dockerfile "$NOTARIUM_MINIO_RECIPE_SHA256" "$force"
  ensure_fixture_image "$BRIDGE_IMAGE" docker/storage-fixtures/uds-bridge.Dockerfile "$NOTARIUM_BRIDGE_RECIPE_SHA256" "$force"
}

skip_api_fixtures=${NOTARIUM_SKIP_API_FIXTURES:-0}
case "$skip_api_fixtures" in
  0|1) ;;
  *) fail "NOTARIUM_SKIP_API_FIXTURES must be 0 or 1" ;;
esac

case "${1:-}" in
  setup-images)
    shift
    setup_images "$@"
    exit 0
    ;;
  fixture-images)
    [ "$#" -eq 1 ] || fail "usage: fixture-images"
    export_recipe_shas
    printf '%s\n' "$MINIO_IMAGE" "$BRIDGE_IMAGE"
    exit 0
    ;;
  test|exec-custom|benchmark) projection_benchmark=0 ;;
  projection-benchmark)
    [ "$#" -eq 1 ] || fail "usage: projection-benchmark"
    projection_benchmark=1
    ;;
  *) exec sh "$ROOT/.devkit/runtime/devkit.sh" "$@" ;;
esac

[ "$skip_api_fixtures" = 0 ] || fail "NOTARIUM_SKIP_API_FIXTURES=1 is permitted only for setup"
export_recipe_shas

docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || \
  fail "missing fixture image '$PG_IMAGE'; run 'make setup app=api' first"
if [ "$projection_benchmark" = 0 ]; then
  # A forced rebuild can retag the same recipe while this run waits for the lock.
  NOTARIUM_MINIO_FIXTURE_IMAGE=$(fixture_image_id "$MINIO_IMAGE" "$NOTARIUM_MINIO_RECIPE_SHA256") || \
    fail "missing or stale fixture image '$MINIO_IMAGE'; run 'make setup app=api' first"
  NOTARIUM_BRIDGE_FIXTURE_IMAGE=$(fixture_image_id "$BRIDGE_IMAGE" "$NOTARIUM_BRIDGE_RECIPE_SHA256") || \
    fail "missing or stale fixture image '$BRIDGE_IMAGE'; run 'make setup app=api' first"
  export NOTARIUM_MINIO_FIXTURE_IMAGE NOTARIUM_BRIDGE_FIXTURE_IMAGE
fi

mkdir -p -- "$FIXTURES_BASE"
# The manifest and stale-run sweep belong to one checkout. Keep ownership
# through teardown so a waiting test cannot erase the active fixture.
exec 9>"$FIXTURES_BASE/lifecycle.lock"
flock -x 9
if [ "$1" = "benchmark" ]; then
  tier=
  case "$*" in
    benchmark) report=d3-benchmarks ;;
    'benchmark --tier high'|'benchmark --tier medium')
      [ "$#" -eq 3 ] && [ "$2" = "--tier" ] || fail "expected --tier high or --tier medium"
      tier=$3
      report="d3-benchmarks-$tier"
      ;;
    'benchmark --interactions') report=storage-interactions ;;
    'benchmark --smoke') report=d3-benchmarks-smoke ;;
    'benchmark --paired-only') report=d3-paired ;;
    'benchmark --paired-only --smoke') report=d3-paired-smoke ;;
    *) fail "usage: benchmark [--paired-only] [--smoke] | benchmark --interactions | benchmark --tier high|medium" ;;
  esac
  commit=$(git -C "$ROOT" rev-parse HEAD)
  head_tree=$(git -C "$ROOT" rev-parse 'HEAD^{tree}')
  tree=$(source_tree)
  sh "$ROOT/.devkit/runtime/devkit.sh" cli exec --component apps/api --network none -- \
    cargo build --offline --locked --release -p fitness-gates --features storage-bench --example d3_benchmarks
elif [ "$projection_benchmark" = 1 ]; then
  commit=$(git -C "$ROOT" rev-parse HEAD)
  head_tree=$(git -C "$ROOT" rev-parse 'HEAD^{tree}')
  tree=$(source_tree)
  sh "$ROOT/.devkit/runtime/devkit.sh" cli exec --component apps/api --network none -- \
    cargo build --offline --locked --release -p fitness-gates --features storage-bench --example projection_benchmarks
fi
sweep_stale_runs

RUN_ID="run-$$-$(date +%s)"
RUN_DIR="$FIXTURES_BASE/$RUN_ID"
COMPOSE_PROJECT="notarium-st-${CHECKOUT_HASH}-$$"
projection_artifacts=".artifacts/5-projections-graph"
projection_work="$projection_artifacts/$RUN_ID"

UID_VAL=$(id -u)
GID_VAL=$(id -g)
PG_USER="notarium_test"
PG_PASSWORD=$(random_hex)
PG_DB="notarium_test"
S3_ACCESS_KEY="notarium$(printf '%s' "$CHECKOUT_HASH" | cut -c1-8)"
S3_SECRET_KEY=$(random_hex)

mkdir -p -- \
  "$RUN_DIR/pgdata/db" \
  "$RUN_DIR/pgsock" \
  "$RUN_DIR/s3data/d1" \
  "$RUN_DIR/s3data/d2" \
  "$RUN_DIR/s3data/d3" \
  "$RUN_DIR/s3data/d4" \
  "$RUN_DIR/s3sock"

cat >"$RUN_DIR/passwd" <<EOF
root:x:0:0:root:/root:/bin/sh
postgres:x:${UID_VAL}:${GID_VAL}:postgres:/tmp:/bin/sh
EOF
chmod 0644 "$RUN_DIR/passwd"

export NOTARIUM_FIXTURE_UID="$UID_VAL"
export NOTARIUM_FIXTURE_GID="$GID_VAL"
export NOTARIUM_FIXTURE_CHECKOUT_HASH="$CHECKOUT_HASH"
export NOTARIUM_FIXTURE_RUN_ID="$RUN_ID"
export NOTARIUM_FIXTURE_RUN_DIR="$RUN_DIR"
export NOTARIUM_FIXTURE_PG_USER="$PG_USER"
export NOTARIUM_FIXTURE_PG_PASSWORD="$PG_PASSWORD"
export NOTARIUM_FIXTURE_PG_DB="$PG_DB"
export NOTARIUM_FIXTURE_S3_ACCESS_KEY="$S3_ACCESS_KEY"
export NOTARIUM_FIXTURE_S3_SECRET_KEY="$S3_SECRET_KEY"

cleanup() {
  rm -f -- "$ACTIVE_MANIFEST"
  docker compose --progress plain -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" down -v --remove-orphans </dev/null >/dev/null 2>&1 || true
  rm -rf -- "$RUN_DIR" 2>/dev/null || true
  if [ "$projection_benchmark" = 1 ]; then
    rm -rf -- "$ROOT/$projection_work" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$projection_benchmark" = 1 ]; then
  docker compose --progress plain -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" up -d --pull never --no-build postgres </dev/null
else
  docker compose --progress plain -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" up -d --pull never --no-build </dev/null
fi

# Wait for PostgreSQL 16 UDS readiness (bounded 30s).
pg_ready=0
attempt=0
while [ "$attempt" -lt 150 ]; do
  if [ -S "$RUN_DIR/pgsock/.s.PGSQL.5432" ] && \
     docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" exec -T postgres \
       pg_isready -q -h /var/run/postgresql -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.2
done
[ "$pg_ready" = 1 ] || {
  docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" logs >&2 || true
  fail "PostgreSQL 16 UDS fixture failed readiness within 30s"
}

# Give the startup refusal test a separate cluster and socket in the pinned PG
# container. Its temporary data directory disappears with the fixture.
pg_fsync_off_port=null
if [ "$1" != "benchmark" ] && [ "$projection_benchmark" = 0 ]; then
  pg_fsync_off_port=5433
  docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" exec -T postgres \
    sh -eu -s -- "$pg_fsync_off_port" <<'PG_FIXTURE'
data=$(mktemp -d /tmp/notarium-fsync-off.XXXXXX)
printf '%s\n' "$POSTGRES_PASSWORD" | initdb -D "$data" --no-sync --username="$POSTGRES_USER" \
  --auth=scram-sha-256 --pwfile=/dev/stdin >/dev/null
pg_ctl -D "$data" -l "$data/server.log" -t 30 -w \
  -o "-c listen_addresses= -p $1 -k /var/run/postgresql -c synchronous_commit=on -c fsync=off -c shared_buffers=1MB -c max_connections=8 -c max_wal_senders=0 -c autovacuum=off" start
PG_FIXTURE
fi

# Wait for MinIO Community Edition + UDS bridge readiness (bounded 30s).
if [ "$projection_benchmark" = 0 ]; then
  s3_ready=0
  attempt=0
  while [ "$attempt" -lt 150 ]; do
    if [ -S "$RUN_DIR/s3sock/s3.sock" ] && \
       docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" exec -T s3-bridge \
         /usr/local/bin/uds-tcp-bridge probe-http /s3sock/s3.sock /minio/health/live >/dev/null 2>&1; then
      s3_ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  [ "$s3_ready" = 1 ] || {
    docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" logs >&2 || true
    fail "MinIO CE UDS fixture failed readiness within 30s"
  }
fi

TMP_MANIFEST="$RUN_DIR/current.json.tmp"
cat >"$TMP_MANIFEST" <<EOF
{
  "run_id": "${RUN_ID}",
  "checkout_hash": "${CHECKOUT_HASH}",
  "pg_socket_dir_container": "/workspace/.artifacts/storage-tests/${RUN_ID}/pgsock",
  "pg_socket_dir_host": "${RUN_DIR}/pgsock",
  "pg_port": 5432,
  "pg_fsync_off_port": ${pg_fsync_off_port},
  "pg_user": "${PG_USER}",
  "pg_password": "${PG_PASSWORD}",
  "pg_database": "${PG_DB}",
  "s3_socket_container": "/workspace/.artifacts/storage-tests/${RUN_ID}/s3sock/s3.sock",
  "s3_socket_host": "${RUN_DIR}/s3sock/s3.sock",
  "s3_endpoint": "http://127.0.0.1:9000",
  "s3_region": "us-east-1",
  "s3_access_key": "${S3_ACCESS_KEY}",
  "s3_secret_key": "${S3_SECRET_KEY}",
  "minio_source_commit": "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a",
  "minio_release_tag": "RELEASE.2025-10-15T17-29-55Z"
}
EOF
chmod 0644 "$TMP_MANIFEST"
mv -f "$TMP_MANIFEST" "$ACTIVE_MANIFEST"

if [ "$projection_benchmark" = 1 ]; then
  mkdir -p "$ROOT/$projection_work"
  caller_cpu=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || printf unknown)
  caller_memory=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf unknown)
  sh "$ROOT/.devkit/runtime/devkit.sh" cli exec --component apps/api --write --network none -- \
    ./target/release/examples/projection_benchmarks --git-base "$commit" --head-tree "$head_tree" \
    --git-tree "$tree" --caller-cgroup-cpu "$caller_cpu" --caller-cgroup-memory "$caller_memory" \
    --work-root "/workspace/$projection_work" --output "/workspace/$projection_work/report.json"
  [ "$tree" = "$(source_tree)" ] || fail "benchmark source changed during measurement"
  [ "$commit" = "$(git -C "$ROOT" rev-parse HEAD)" ] || fail "benchmark HEAD changed during measurement"
  [ -s "$ROOT/$projection_work/report.json" ] || fail "projection benchmark produced no report"
  mv -f "$ROOT/$projection_work/report.json" "$ROOT/$projection_artifacts/metrics.json"
  printf '%s\n' "$ROOT/$projection_artifacts/metrics.json"
  sh "$ROOT/.devkit/runtime/devkit.sh" cli exec --component apps/api --network none -- \
    env NOTARIUM_REQUIRE_PROJECTION_SAMPLES=1 NOTARIUM_PROJECTION_GIT_COMMIT="$commit" \
    NOTARIUM_PROJECTION_HEAD_TREE="$head_tree" NOTARIUM_PROJECTION_SOURCE_TREE="$tree" \
    cargo test --offline --locked --release -p fitness-gates --features storage-bench \
    --test projection_samples -- --nocapture
elif [ "$1" = "benchmark" ]; then
  shift
  mkdir -p "$ROOT/.artifacts/3-storage-cas"
  status=0
  caller_cpu=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || printf unknown)
  caller_memory=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf unknown)
  output="/workspace/.artifacts/storage-tests/$RUN_ID/report.json"
  if [ "$report" = storage-interactions ]; then
    results=".artifacts/storage-interactions/$tree-$RUN_ID"
    mkdir -p "$ROOT/$results"
    output="/workspace/$results/report.json"
    elf_sha=$(sha256sum "$ROOT/apps/api/target/release/examples/d3_benchmarks" | cut -d' ' -f1)
    set -- "$@" --elf-sha256 "$elf_sha" --work-root "/workspace/.artifacts/storage-tests/$RUN_ID"
  fi
  sh "$ROOT/.devkit/runtime/devkit.sh" cli exec --component apps/api --write --network none -- \
    ./target/release/examples/d3_benchmarks "$@" --git-base "$commit" --head-tree "$head_tree" --git-tree "$tree" \
    --caller-cgroup-cpu "$caller_cpu" --caller-cgroup-memory "$caller_memory" \
    --output "$output" || status=$?
  [ "$tree" = "$(source_tree)" ] || fail "benchmark source changed during measurement"
  if [ "$report" = storage-interactions ]; then
    [ -f "$ROOT/$results/report.json" ] || fail "interaction campaign produced no report"
    printf '%s\n' "$ROOT/$results/report.json"
    exit "$status"
  fi
  [ -f "$RUN_DIR/report.json" ] || fail "benchmark did not finish its measurements"
  destination="$ROOT/.artifacts/3-storage-cas/$report-$tree.json"
  if [ -n "$tier" ]; then
    destination="${destination%.json}-$RUN_ID.json"
    mv -n "$RUN_DIR/report.json" "$destination"
    [ ! -f "$RUN_DIR/report.json" ] || fail "tier report already exists: $destination"
  else
    mv "$RUN_DIR/report.json" "$destination"
  fi
  printf '%s\n' "$destination"
  exit "$status"
elif [ "${1:-}" = "exec-custom" ]; then
  shift
  "$@"
else
  sh "$ROOT/scripts/devkit-with-control-db.sh" "$@"
fi
