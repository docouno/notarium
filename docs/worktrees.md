# Worktrees with Worktrunk

Notarium uses [Worktrunk](https://worktrunk.dev/) for parallel checkouts. Worktrunk
owns worktree creation, navigation and removal; the repository owns the lifecycle
hooks that make every new checkout ready in the same way.

## Layout and configuration ownership

Keep linked worktrees outside the repository itself:

```text
~/dev/
├── notarium/                 # primary worktree
├── notarium-309-user-roles/  # feat/309-user-roles
└── notarium-317-oauth-fix/   # fix/317-oauth-fix
```

The exact root is derived from the primary checkout, so no absolute team path is
committed. Two configuration layers have deliberately different owners:

| File | Owner | Purpose |
|---|---|---|
| `~/.config/worktrunk/config.toml` | developer | Worktree path plus two per-project hook entrypoints |
| `.config/worktrunk/hooks/*` | repository | Shared lifecycle implementation; committed and reviewed with the code |

The entrypoints in user config deliberately resolve the scripts through
`primary_worktree_path`. An existing branch can predate these files, but its newly
created worktree can still be bootstrapped by the current primary checkout. Review
changes under `.config/worktrunk/` like any other executable build tooling.

## One-time setup

The team baseline is Worktrunk `0.74.0`. Install that exact version rather than
silently moving every workstation when upstream publishes a release:

```bash
# Any host with a current Rust toolchain
cargo install --locked --version 0.74.0 worktrunk

# Linux without Rust: inspect, then run the versioned official installer
worktrunk_installer="$(mktemp)"
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/max-sixty/worktrunk/releases/download/v0.74.0/worktrunk-installer.sh \
  -o "$worktrunk_installer"
less "$worktrunk_installer"
sh "$worktrunk_installer"
rm "$worktrunk_installer"
```

The [0.74.0 release](https://github.com/max-sixty/worktrunk/releases/tag/v0.74.0)
also provides prebuilt Linux, macOS and Windows archives. Revisit the pin as an
explicit repository change after reading newer release notes. Then install the shell
integration and restart the shell:

```bash
wt config shell install
exec "$SHELL" -l
```

Create the user config if it does not exist:

```bash
wt config create
```

Set the path template and Notarium hook entrypoints in
`~/.config/worktrunk/config.toml`:

```toml
worktree-path = "{{ repo_path }}/../{{ repo }}-{{ branch | replace('feat/', '') | replace('fix/', '') | replace('perf/', '') | replace('chore/', '') | sanitize }}"

[projects."<identifier from wt config show>"]
pre-start = "{{ primary_worktree_path }}/.config/worktrunk/hooks/pre-start {{ primary_worktree_path }} {{ worktree_name | sanitize_db }}"
pre-remove = "{{ primary_worktree_path }}/.config/worktrunk/hooks/pre-remove {{ primary_worktree_path }}"
```

This applies the same layout to every normal clone. A developer who wants it only
for Notarium can put `worktree-path` in a project-specific block instead; run
`wt config show` inside Notarium to get the exact project identifier.

Verify the effective files and path template:

```bash
wt --version
wt config show
```

## What creation does

Create a task from the default branch:

```bash
wt switch --create feat/309-search-ranking
```

For a branch that already exists in Git — including one created before these hooks —
omit `--create`:

```bash
wt switch feat/354-abilities-mcp
```

Worktrunk creates only the linked worktree in this case. `--create` correctly refuses
because it means “create a new branch”, not “create a worktree for this branch”.

Use `fix/<task>-<slug>`, `perf/<task>-<slug>` or `chore/<task>-<slug>` when those
describe the change better. The task id is part of the branch and directory name;
do not create two branch types with the same suffix. Worktrunk
creates new branches from the default branch unless `--base` is explicit; for a
stacked change based on the current worktree, use:

```bash
wt switch --create feat/310-search-ui --base=@
```

These are user hooks, so Worktrunk does not ask for project-command approval: the
developer explicitly added the two entrypoints. The committed `pre-start` script then:

1. copies `.env` directly from the primary worktree;
2. creates `.env` from the primary `.env.example` when no source `.env` exists;
3. under a repository-local lock, reserves the first free port in `8801-8815`, while
   respecting existing worktree `.env` reservations and real host listeners;
4. writes a unique `COMPOSE_PROJECT_NAME` and runs `make dev` synchronously.

The hook does not copy `node_modules`, `docker/volumes`, test output or application
data. It also does not copy machine-local agent bootstrap files: agent bootstrap is a
separate concern. npm workspace links contain checkout-specific paths,
and each development stand must own its state. npm's normal user cache still makes
installs incremental.

Step 4 goes through `make dev` → `make deps`, which installs on the host — so a new
worktree bootstraps only under a Node and npm that clear the floor `package.json`
declares, and `.npmrc`'s `engine-strict` makes that a refusal rather than a warning.
Worth knowing before you create one, because the global npm is one per MACHINE while
worktrees are many: bring it up once and every checkout after it is fine. The cure is
`npm i -g npm@<version>`, which needs `sudo` wherever the global prefix is root-owned and
must not have it under nvm. A worktree that trips over this at step 4 already has its
`.env` written and a port reserved, so fix the npm and re-run rather than recreating the
slot.

The copied `.env` can contain credentials or external database URLs. It remains
gitignored, but review it before starting a stand when isolation from shared external
services matters.

## Daily commands

```bash
wt list                              # worktrees, branches and status
wt switch feat/309-search-ranking     # enter an existing worktree
wt switch ^                          # return to the default-branch worktree
wt switch -                          # return to the previous worktree
wt remove feat/309-search-ranking     # remove after the GitLab MR is integrated
```

`wt switch <branch>` creates a linked worktree when the branch exists but has none.
`pre-start` runs once when that linked worktree is created, not on every switch. If
creation made the tree but setup failed, enter it and rerun the user hook manually:

```bash
wt switch <branch>
wt hook pre-start
```

`wt remove` refuses dirty tracked or untracked files. It deletes the branch only when
its contents are already integrated into the default branch; use
`--no-delete-branch` when removing a worktree specifically to keep its branch. Avoid
`--force` and `--force-delete` unless the discarded work has been checked explicitly.
Notarium does not use `wt merge`: integration remains a server-side squash through the
GitLab merge request.

## Runtime and removal

Every linked worktree has its own port, Compose project, `node_modules` and
`docker/volumes`. It can therefore run `make dev` beside another checkout without
container, network, port or bind-mount collisions. Existing stopped worktrees retain
their port reservations in `.env`; removing the worktree releases the reservation.
If all ports from `8801` through `8815` are reserved or listening, creation stops with
an explicit error and leaves the worktree available for diagnosis.

If a detached host watcher or `npm run dev` is still running from the checkout, use
`wt remove --reap <branch>` so Worktrunk terminates its non-interactive process tree as
well. The Compose lifecycle itself is handled by the shared hook below.

The committed `pre-remove` hook runs `make down` when the checkout has local runtime
state. It blocks removal if Docker is unavailable, because a stopped daemon can still
hold `restart: unless-stopped` containers that would become orphaned when it returns.
Start Docker and retry. `wt remove --no-hooks` is an escape hatch only after checking
that no containers from that checkout remain.

Removing a worktree also removes its ignored `.env`, dependencies and local Notarium
data. Back up anything under `docker/volumes/data` that must survive before removal.
The primary worktree and its data are unaffected.

## Troubleshooting

Preview the configured user hooks and their rendered values:

```bash
wt hook show --expanded
wt hook pre-start --dry-run
```

Inspect Worktrunk's effective configuration or command logs:

```bash
wt config show
wt config state logs get
```

Use `git worktree list` only for low-level diagnosis. Do not mix routine
`git worktree add/remove` calls with Worktrunk: they bypass the shared lifecycle.
