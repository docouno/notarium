#!/bin/sh
# Preserve the pinned runner and add only the API database fixture lifecycle.
set -eu
skip_api_fixtures=${NOTARIUM_SKIP_API_FIXTURES:-0}
case "$skip_api_fixtures" in
    0|1) ;;
    *) echo 'NOTARIUM_SKIP_API_FIXTURES must be 0 or 1' >&2; exit 1 ;;
esac
case "${DEVKIT_TARGET_COMPONENT:-}:${1:-}" in
    apps/api:setup)
        if [ "$skip_api_fixtures" = 0 ]; then
            sh scripts/control-db-fixture.sh prepare
        else
            echo 'control-db-fixture: skipping fixture image setup (NOTARIUM_SKIP_API_FIXTURES=1)' >&2
        fi
        ;;
    apps/api:test)
        if [ "$skip_api_fixtures" = 1 ]; then
            echo 'NOTARIUM_SKIP_API_FIXTURES=1 is permitted only for setup' >&2
            exit 1
        fi
        exec sh scripts/control-db-fixture.sh run sh .devkit/runtime/devkit.sh "$@"
        ;;
esac
exec sh .devkit/runtime/devkit.sh "$@"
