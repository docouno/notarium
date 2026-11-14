# Working on Notarium

- Develop on branches based on `v1`; keep the released `main` unchanged.
- Read `README.md`, `docs/development.md` and `docs/architecture.md` before
  structural changes. Keep code, docs and commit messages in English.
- Use pinned Devkit through root Make: `make setup`, `make check`, `make test`,
  `make build`. Setup needs networking; later gates run offline with read-only
  sources. Use `make help` for selectors.
- Keep the Cargo workspace in `apps/api`, with 14 explicit members. Inherit
  workspace dependencies and lints. Preserve `unsafe_code = "deny"`, the DAG
  allowlist, banned-dependency gates, Rust TLS and the Rust-only server image.
  Both runtime binaries use `mimalloc`.
- Apps own their entry points and lifecycles. Shared packages have explicit
  consumers. Keep Electron privileges behind platform adapters.
- Never hand-edit managed `.devkit/` files or metadata hashes. Change dependencies
  through pinned container exec, then `make sync reconcile=1` and `make setup`.
- Run `make contract-sync` after transport declarations change.
  `make package-desktop` builds the sidecar before packaging it outside `app.asar`.
- Keep temporary evidence in ignored `.artifacts/<task>/`. Stop your local stack
  with `make down`. Preserve unrelated changes and other worktrees.
- Validate changed behavior and canonical gates; report the exact tree, results
  and limitations. Scaffolds do not certify future product features. Keep the
  repository usable without external agent frameworks. Do not add local Git hooks
  or vendor-specific agent configuration.
