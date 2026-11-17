#!/bin/sh
# A disposable PostgreSQL fixture shared only through a Unix socket.
set -eu
image=postgres:16-bookworm@sha256:a49f7438ba03589f9b1ca062f2da82e899b48ea1dc50d2449fa09a70be83ebca
case ${1:-} in
    prepare) exec docker pull "$image" ;;
    run) shift ;;
    *) echo 'usage: control-db-fixture.sh prepare | run COMMAND [ARG...]' >&2; exit 2 ;;
esac
umask 022
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
mkdir -p .artifacts/control-db-fixture
exec 9>.artifacts/control-db-fixture/lock
flock 9
run=$(mktemp -d .artifacts/control-db-fixture/run.XXXXXXXX)
name=notarium-control-$(basename "$run")-$$
cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    if [ "$result" -ne 0 ]; then
        docker logs "$name" > "$run/postgres.log" 2>&1 || true
    fi
    docker exec -u 0 "$name" sh -c 'chmod 0777 /var/run/postgresql && rm -rf /var/run/postgresql/* /var/run/postgresql/.[!.]*' > /dev/null 2>&1 || true
    docker rm -f "$name" > /dev/null 2>&1 || true
    rm -f .artifacts/control-db-fixture/active.json
    if [ "$result" -eq 0 ]; then
        rm -rf "$run"
    fi
    exit "$result"
}
trap cleanup EXIT HUP INT TERM
mkdir "$run/socket"
chmod 0777 "$run/socket"
docker run --detach --name "$name" --network none \
    --mount "type=bind,src=$root/$run/socket,dst=/var/run/postgresql" \
    --tmpfs /var/lib/postgresql/data:rw \
    --env POSTGRES_HOST_AUTH_METHOD=trust "$image" \
    -c listen_addresses= -c max_connections=100 -c shared_buffers=32MB > "$run/container-id"
attempt=0
until docker exec "$name" pg_isready -q -U postgres; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
        echo 'PostgreSQL fixture did not become ready' >&2
        exit 1
    fi
    sleep 1
done
# Wait for the entrypoint to finish initialization and exec the permanent server.
attempt=0
until docker exec "$name" sh -c 'test "$(cat /proc/1/comm)" = postgres'; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then exit 1; fi
    sleep 1
done
printf '{"socket":"/workspace/%s/socket","run":"%s"}\n' "$run" "$name" > .artifacts/control-db-fixture/active.json
"$@"
