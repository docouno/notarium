# Temporary pulldown-cmark patch

This directory contains the library sources of [pulldown-cmark 0.13.6](https://crates.io/crates/pulldown-cmark/0.13.6), under the original [MIT license](LICENSE), with one local performance fix. The application workspace pins this version and applies a Cargo path patch. This is an external dependency, excluded from the 14 workspace members.

Upstream archive SHA-256:
`3db2be46835f013dd3f4fa7f5f7402c537787b54ebb6fe2b94bbdd7e2669bb7b`.
The published VCS metadata identifies commit `014b61d38d235f382935bb676bab872b7680afa2`, path `pulldown-cmark`, in the [upstream repository](https://github.com/pulldown-cmark/pulldown-cmark).

## Source change

[tail-cleanup.patch](tail-cleanup.patch) changes only `src/parse.rs` and `src/tree.rs`. [UPSTREAM_FILES.sha256](UPSTREAM_FILES.sha256) records the pristine source files. Applying the patch to those files reproduces the vendored sources.

The parser used to walk an entire unmatched container tail on every lazy paragraph line, even when every list's `LAST_LINE_EMPTY` flag was already clear. A private scalar upper bound now records where flags may still need clearing. Push conservatively invalidates the bound; pop, removal and reset maintain it. A scan clears only the relevant tail and records flags retained in the matched prefix. This preserves list tightness, event payloads and byte offsets without adding a nesting or input-size limit. It removes this repeated cleanup; it does not promise linear parsing of every CommonMark input.

## Packaging and validation

The library sources and license are retained. The local manifest retains the upstream library's runtime dependencies and features (`getopts`, `html`, `simd`, and implicit `serde`). It omits the CLI target, examples, external test targets and development dependencies. The build script and its authoring-only `gen-tests` feature are omitted; published parser sources need no generation. This package is not published independently.

The ordinary `make check`, `make test` and `make build` use this dependency. The syntax integration tests exercise lazy continuation offsets and tight/loose lists. Before adoption, the source patch passed the published specification, HTML and error suites (1,197 tests) and 20,632 paired event/range/HTML comparisons against the pristine release. Those comparisons cover CommonMark, product options and additional upstream option sets; they are not a proof for every possible document. The full upstream package test command, including its separate serde suite and doctests, was not run.

When changing or removing the patch, repeat semantic comparisons and geometric scaling on deep quotes, mixed quote/list tails, nested blank lists and ordinary documents. Timing alone must not replace semantic and source-range checks. Keep upstream and patched oracle dependencies distinct; a workspace-wide patch must not silently replace both sides of a comparison.

## Removal

Return to an upstream release once it includes an equivalent fix and passes the semantic and scaling checks. Update the pinned workspace dependency, remove the Cargo patch, exclusion and this directory, then run the documented Devkit synchronization/setup flow and all canonical gates. Do not silently let a newer registry version bypass the local patch. Any new writer of `LAST_LINE_EMPTY` or mutation of the spine must maintain the bound until removal.
