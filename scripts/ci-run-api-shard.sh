#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
exec python3 "$root/scripts/ci-api-shards.py" run "$@"
