# Image CLI

The published Docker image is an application appliance. Its executable contract is:

```dockerfile
ENTRYPOINT ["notarium"]
CMD ["start"]
```

A bare `docker run … docouno/notarium` therefore starts the foreground server. Arguments replace only the default command, so one-off operations read naturally: `docker run … IMAGE restore`. Docker does not apply an image entrypoint to `docker exec`; the image consequently installs `backup`, `restore`, `admin`, `version`, and `healthcheck` as multicall links to the same `notarium` CLI.

## Commands

| Command | Purpose | Intended invocation |
|---|---|---|
| `start` | Run the HTTP/MCP server as PID 1 | Default image command |
| `backup` | Stream a verified online ZIP | `docker exec notarium backup` + the safe publication snippet in the runbook |
| `backup verify` | Validate a ZIP without changing data | `docker exec -i notarium backup verify < file` |
| `restore` | Install a ZIP into an empty data root | One-off stopped/fresh-volume container |
| `admin` | Out-of-band account recovery | `docker exec -it notarium admin …` |
| `healthcheck` | Probe the local `/api/health` endpoint | Docker `HEALTHCHECK` |
| `version` | Print version, commit, build time and source revision (`--json` for scripts) | Support and compatibility checks |
| `help` / `--help` | Describe the CLI or one command | Any container |

`start` always stays in the foreground and `exec`s the Node host, so normal container signals reach the server directly. Stop and restart remain the orchestrator's job (`docker stop`, Compose, Kubernetes); they are deliberately not CLI commands. Schema migrations happen as part of startup. Development-only operations such as seeds are source-checkout tooling and do not ship as production commands.

## Stream and exit contract

- `backup` reserves stdout for ZIP bytes; diagnostics and its completion summary go to stderr.
- `backup verify`, `restore`, and non-interactive admin commands emit their result to stdout.
- Errors go to stderr and return non-zero. Unknown commands, options, duplicate options, and missing option values fail instead of being ignored.
- `--input FILE` / `--output FILE` exist for mounted-file workflows; stdin/stdout are the canonical Docker transport.
- Every command supports `--help`; `notarium --version` is equivalent to `notarium version`.
- `version --json` prints the build identity as one object (`version`, `commit`, `builtAt`, `source`) — the machine contract a release verifies itself against and an operator can assert in a deploy check. Values a build does not honestly have are `null`, never invented ([release canon](release.md#identity)).

The backup/verify/restore spool and extraction root defaults to `/tmp`. Set
`NOTARIUM_BACKUP_TMPDIR` to a writable mounted scratch filesystem when the image
has a read-only root or the data set is large. A streamed backup self-verifies
before publication and may temporarily need the archive plus two data-sized
stages; standalone verify needs one expanded stage. Compressed input and expanded
payload are bounded to 64 GiB and one million ZIP entries by default; trusted
larger installations can raise `NOTARIUM_BACKUP_MAX_BYTES`,
`NOTARIUM_BACKUP_MAX_ENTRIES`, and `NOTARIUM_BACKUP_MAX_METADATA_BYTES`; the
last value defaults to a separate 32 MiB manifest/ZIP-metadata memory bound.

The operational runbooks are [Backup and restore](backup.md) and [Access recovery](auth.md#access-recovery-admin-cli).

## The npm CLI is a different surface <a id="npm-cli"></a>

A second executable answers to the name `notarium`: the npm package (`packages/cli`, `npx notarium`), which runs on a developer machine rather than inside the appliance. It operates nothing — today it prints how to run the workspace and its own version — while this CLI operates a running server; the roles are what keep them apart, not the command names, and `help` and `version` deliberately exist in both with the same meaning.

What they share is the argument contract above: an unknown command fails instead of being ignored, a trailing argument no command asked for fails too, `--help` and `--version` alias their commands, and errors go to stderr with a non-zero exit.
