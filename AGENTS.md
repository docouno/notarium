# Working on Notarium

- Develop on branches based on `v1`; keep the released `main` unchanged.
- Read `README.md`, `docs/development.md` and `docs/architecture.md` before
  structural changes. Keep code, docs and commit messages in English.
- Use pinned Devkit (`0.5.1`) through root Make: `make setup`, `make doctor`,
  `make check`, `make test`, `make build`, `make info` (`make info json=1`),
  and `make update`. Setup needs networking; later gates run offline with
  read-only sources. Use `make help` for selectors and lifecycle targets.
- Keep the Cargo workspace in `apps/api`, with 14 explicit members. Inherit
  workspace dependencies and lints. Preserve `unsafe_code = "deny"`, the DAG
  allowlist, banned-dependency gates, Rust TLS and the Rust-only server image.
  Both runtime binaries use `mimalloc`.
- Apps own their entry points and lifecycles. Shared packages have explicit
  consumers (`workspace:*` in the root `pnpm` workspace). Keep Electron
  privileges behind platform adapters.
- Never hand-edit managed `.devkit/` files or metadata hashes. Change Node
  dependencies with
  `make exec app=<name> write=1 network=bridge command='pnpm add <pkg> --lockfile-only --ignore-scripts'`
  (or `package=<name>`, or `-w` at the workspace root), and Rust dependencies
  with `make exec app=api write=1 network=bridge command='cargo update'`, then
  run `make setup` (and `make sync` after manual manifest or `.npmrc` edits).
- Run `make contract-sync` after transport declarations change.
  `make package-desktop` builds the sidecar before packaging it outside `app.asar`.
- Development stands use checkout-owned sticky loopback ports and
  `DEVKIT_PREVIEW_URL_TEMPLATE`. Stop your local stack with `make down`
  (preserving leases) or `make down cleanup=1` (releasing leases).
- With Worktrunk (`.config/wt.toml`), pass `--yes` in non-interactive sessions
  (or run `wt config approvals add --yes`). Keep temporary evidence in ignored
  `.artifacts/<task>/`. Preserve unrelated changes and other worktrees.
- Validate changed behavior and canonical gates; report the exact tree, results
  and limitations. Scaffolds do not certify future product features. Keep the
  repository usable without external agent frameworks. Do not add local Git hooks
  or vendor-specific agent configuration.
