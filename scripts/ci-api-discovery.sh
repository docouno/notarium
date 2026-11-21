#!/bin/sh
# Run from apps/api inside the pinned Rust container.
set -eu
export CARGO_TERM_COLOR=never

list_tests() {
  # Use the same workspace selection and libtest arguments as Devkit's check.
  cargo test --workspace --locked --offline -- --list --format=terse --color never "$@"
}

count_tests() {
  awk '/: test$/ { count++ } END { print count+0 }'
}

all_tests=$(list_tests)
ignored_tests=$(list_tests --ignored)
count=$(printf '%s\n' "$all_tests" | count_tests)
ignored_count=$(printf '%s\n' "$ignored_tests" | count_tests)
if [ "$count" -eq 0 ]; then
  echo 'Rust test discovery found no workspace tests' >&2
  exit 1
fi
if [ "$ignored_count" -ne 0 ]; then
  echo 'Rust test discovery found ignored workspace tests' >&2
  printf '%s\n' "$ignored_tests" >&2
  exit 1
fi
printf 'Discovered %s Rust test cases (including compile-only doctests), 0 ignored\n' "$count"
