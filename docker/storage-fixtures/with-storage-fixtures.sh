#!/bin/sh
# Product-owned lifecycle manager for offline PostgreSQL 16 + MinIO CE fixtures.
set -eu

umask 022

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
COMPOSE_FILE="$ROOT/compose.storage-tests.yaml"
PG_IMAGE="postgres:16-bookworm@sha256:a49f7438ba03589f9b1ca062f2da82e899b48ea1dc50d2449fa09a70be83ebca"
MINIO_IMAGE="notarium-storage-fixture-minio-ce:9e49d5e7a648"
BRIDGE_IMAGE="notarium-storage-fixture-uds-bridge:local"

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

setup_images() {
  if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
    docker pull "$PG_IMAGE"
  fi
  NOTARIUM_FIXTURE_UID=$(id -u) \
  NOTARIUM_FIXTURE_GID=$(id -g) \
  NOTARIUM_FIXTURE_CHECKOUT_HASH="$CHECKOUT_HASH" \
  NOTARIUM_FIXTURE_RUN_ID="setup" \
  NOTARIUM_FIXTURE_RUN_DIR="/tmp" \
  NOTARIUM_FIXTURE_PG_USER="setup" \
  NOTARIUM_FIXTURE_PG_PASSWORD="setup" \
  NOTARIUM_FIXTURE_PG_DB="setup" \
  NOTARIUM_FIXTURE_S3_ACCESS_KEY="setupaccesskey" \
  NOTARIUM_FIXTURE_S3_SECRET_KEY="setupsecretkey1234" \
    docker compose -f "$COMPOSE_FILE" build minio s3-bridge
}

if [ "${1:-}" = "setup-images" ]; then
  setup_images
  exit 0
fi

if [ "${1:-}" != "test" ] && [ "${1:-}" != "exec-custom" ]; then
  exec sh "$ROOT/.devkit/runtime/devkit.sh" "$@"
fi

# Verify all pinned fixture images exist locally (offline --pull never enforcement).
for required_image in "$PG_IMAGE" "$MINIO_IMAGE" "$BRIDGE_IMAGE"; do
  docker image inspect "$required_image" >/dev/null 2>&1 || \
    fail "missing fixture image '$required_image'; run 'make setup app=api' first"
done

mkdir -p -- "$FIXTURES_BASE"
sweep_stale_runs

RUN_ID="run-$$-$(date +%s)"
RUN_DIR="$FIXTURES_BASE/$RUN_ID"
COMPOSE_PROJECT="notarium-st-${CHECKOUT_HASH}-$$"

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
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose --progress plain -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" up -d --pull never --no-build </dev/null

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

# Wait for MinIO Community Edition + UDS bridge readiness (bounded 30s).
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

TMP_MANIFEST="$RUN_DIR/current.json.tmp"
cat >"$TMP_MANIFEST" <<EOF
{
  "run_id": "${RUN_ID}",
  "checkout_hash": "${CHECKOUT_HASH}",
  "pg_socket_dir_container": "/workspace/.artifacts/storage-tests/${RUN_ID}/pgsock",
  "pg_socket_dir_host": "${RUN_DIR}/pgsock",
  "pg_port": 5432,
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

if [ "${1:-}" = "exec-custom" ]; then
  shift
  "$@"
else
  sh "$ROOT/.devkit/runtime/devkit.sh" "$@"
fi
