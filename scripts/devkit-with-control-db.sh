#!/bin/sh
# Preserve the pinned runner and add only the API database fixture lifecycle.
set -eu
case "${DEVKIT_TARGET_COMPONENT:-}:${1:-}" in
    apps/api:setup)
        sh scripts/control-db-fixture.sh prepare
        ;;
    apps/api:test)
        exec sh scripts/control-db-fixture.sh run sh .devkit/runtime/devkit.sh "$@"
        ;;
esac
exec sh .devkit/runtime/devkit.sh "$@"
