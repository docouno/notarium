# Backup and restore

Notarium's canonical Docker backup is an image-native command that writes a
logical ZIP to stdout while the service remains online. It needs only Docker and
the running container—no repository checkout, Makefile, host-side Node, or helper
image. Reads remain available and writes are only queued for two short
consistency checkpoints; there is no `docker stop` or copied live database file.

```bash
backup="notarium-$(date -u +%Y%m%dT%H%M%SZ).zip"
partial="${backup}.partial.$$"
set -eu
umask 077
committed=0
cleanup() { test "$committed" -eq 1 || rm -f "$partial"; }
trap cleanup EXIT
docker compose exec -T notarium backup > "$partial"
sync -f "$partial"
sync -f "$(dirname "$backup")"
committed=1
ln "$partial" "$backup"
if sync -f "$(dirname "$backup")"; then
  if rm "$partial"; then
    sync -f "$(dirname "$backup")" ||
      echo "backup warning: final is durable; partial cleanup fsync failed" >&2
  else
    echo "backup warning: final is durable; retaining recovery partial $partial" >&2
  fi
else
  echo "backup warning: final is visible; retaining durable recovery partial $partial" >&2
fi
trap - EXIT
```

`set -e` prevents publication when Docker or backup fails. The per-process
partial prevents concurrent writers sharing a temp, and the final hard link is
an atomic no-clobber publication: two jobs targeting one name cannot overwrite
each other. The partial's file and directory are synced before that commit point.
Post-commit sync/cleanup failures are warnings, not false failures with a visible
final; the recovery hard link is retained when final durability is uncertain.
Once publication is armed, even an ambiguous nonzero exit from `ln` retains the
durable partial: the child may have created the link before it was interrupted.
Keep partial and final on the same filesystem.

The published image has `ENTRYPOINT ["notarium"]` and starts with `start` by
default. It also installs short multicall commands such as `backup` and `admin`
for `docker exec`. `backup` is a second operator-only process in the existing
container: stdout is exclusively the ZIP; progress and summary go to stderr.

A mode-0600 Unix socket inside the container lets that process request two short
application checkpoints. Each checkpoint queues HTTP mutations, durable jobs
and MCP calls (nominally read-only tools can persist cursors/audit); ordinary
HTTP reads remain available. It waits for active work, reconciles external note
edits, drains identity/history write-behind, then releases the gate. SQLite's online backup
API folds `meta.db` and committed WAL pages into one standalone database while
Markdown and durable job files are staged. A stage is accepted only when hashes,
mtimes, exact directories and SQLite `data_version` remain stable through the
final checkpoint/sample. Overlapping writes force a retry. Sustained churn exits
non-zero without publishing an archive.

A checkpoint has a five-second server-side deadline. If a long import/export or
flush cannot drain in that window, the backup fails and queued writes are
released immediately; the service is not held behind the operator process.

The ZIP contains credentials and session state from `meta.db`; store it as
sensitive data. The `umask` above makes new archives owner-readable only. It
contains:

- `data/meta.db`: accounts, sessions, memberships, stable identities, history
  and job state;
- `data/spaces/`: workspace truth, including Markdown, agent-memory, project markers, and complete
  binary role/skill packages;
- `data/jobs/`: completed artifacts and durable import uploads;
- `manifest.json`: format version, timestamp, exact directories, file sizes,
  mtimes and SHA-256 checksums.

Only Notarium-owned incomplete files are omitted: dot-named atomic note temps,
exact `.<role>.install-<uuid>` role-package staging directories at a Personal/Space library root or
an exact `_projects/<encoded-project-id>/` library root,
`jobs/imports/<space>/<job>.import.part`, and in-progress export artifact parts.
Ordinary user files or directories ending in `.part` are legitimate and remain
in the backup. `data/engine/` is derived and omitted; it rebuilds after restore.

This image-native backup covers the canonical one-root layout under `SPACES_ROOT`,
including its default `.notarium/skills` mounts. An embedded host that configures
a physical mount outside that root owns that adapter's backup/restore capability;
the online archive cannot discover arbitrary external storage from filesystem paths.

Do not replace this with `cp /data/meta.db`: WAL mode means committed rows may
still be in `meta.db-wal`, and independently copied files are not a point-in-time
snapshot.

## Verify

Verification is non-mutating and belongs in every backup job:

```bash
docker compose exec -T notarium backup verify < notarium-20260722.zip
# bare Docker:
docker exec -i notarium backup verify < notarium-20260722.zip
```

Success prints one JSON summary and exits zero. Verification rejects
unsafe/duplicate paths, unexpected or unmanifested payloads, an inexact directory
set, size/hash mismatches, malformed mtime metadata, resource-limit violations,
and failed SQLite `integrity_check`. It does not read or change live `DATA_DIR`.

Checksums detect accidental corruption; they do not authenticate an archive
against an attacker who can replace payload and manifest together. Treat backup
storage as trusted, access-controlled state, or add signing/encryption in the
system transporting the ZIP.

Commands spool and verify under `/tmp` by default. A streamed backup
self-verifies before publication and can temporarily need the archive plus two
data-sized stages; standalone verify needs the archive plus one expanded stage.
Restore spools stdin in scratch and expands into the fresh data root. Set
`NOTARIUM_BACKUP_TMPDIR=/mounted/scratch` for a read-only root or large data set.
Compressed and expanded input is limited to 64 GiB and one million entries by
default. ZIP names, bookkeeping and `manifest.json` have a separate 32 MiB
memory bound. Trusted larger installations may raise
`NOTARIUM_BACKUP_MAX_BYTES`, `NOTARIUM_BACKUP_MAX_ENTRIES`, and
`NOTARIUM_BACKUP_MAX_METADATA_BYTES`. The producer enforces the same bounds
while copying source files, backing up SQLite and writing the ZIP.

## Restore

Restore is an offline disaster operation. It accepts only a fresh, empty data
root; it never merges with or overwrites an instance.

Prepare a fresh Compose volume/bind and update the service configuration to use
it before running:

```bash
set -eu
docker compose stop notarium
# Move the old volume aside; attach/create a fresh empty /data in Compose here.
docker compose run --rm --no-deps -T notarium restore \
  < notarium-20260722.zip
docker compose up -d --force-recreate --no-deps notarium
```

Recreate the application container afterwards: `compose start` would restart the
old container with its old mount configuration. Keep the old volume until the
restored instance has been checked. Restore validates the full archive before
installation. A process interruption during installation leaves an explicit
marker; discard that disposable target and restore into a new empty one rather
than resuming or merging.

The restored meta-DB must carry a migration ledger accepted by the target build
([schema contract](meta-db.md#startup)). A non-empty pre-baseline database fails
closed; restore does not guess its version or stamp it automatically. Upgrade
and verify such an owned instance with its version-specific operator procedure
before moving it across the baseline boundary.

Verify at minimum:

1. Log in with an account from the backup.
2. Open several spaces and confirm stable URLs/IDs.
3. Open a changed note and inspect its History.
4. Check import/export jobs whose uploads or artifacts matter.

## A bare `docker run` container

With a running container named `notarium`, publication is the same:

```bash
backup="notarium-$(date -u +%Y%m%dT%H%M%SZ).zip"
partial="${backup}.partial.$$"
set -eu
umask 077
committed=0
cleanup() { test "$committed" -eq 1 || rm -f "$partial"; }
trap cleanup EXIT
docker exec notarium backup > "$partial"
sync -f "$partial"
sync -f "$(dirname "$backup")"
committed=1
ln "$partial" "$backup"
if sync -f "$(dirname "$backup")"; then
  if rm "$partial"; then
    sync -f "$(dirname "$backup")" ||
      echo "backup warning: final is durable; partial cleanup fsync failed" >&2
  else
    echo "backup warning: final is durable; retaining recovery partial $partial" >&2
  fi
else
  echo "backup warning: final is visible; retaining durable recovery partial $partial" >&2
fi
trap - EXIT
```

Docker cannot replace a mount on an existing container. Restore therefore writes
a new volume using the exact immutable image ID of the running instance, then
recreates the application against it:

```bash
set -eu
image_id="$(docker inspect --format '{{.Image}}' notarium)"
image_ref="$(docker inspect --format '{{.Config.Image}}' notarium)"
docker stop notarium
docker volume create notarium-restored
docker run --rm -i --mount source=notarium-restored,target=/data "$image_id" \
  restore < notarium-backup.zip

docker rename notarium notarium-before-restore
docker run -d --name notarium \
  -p 3000:3000 \
  --mount source=notarium-restored,target=/data \
  "$image_id"
```

`.Config.Image` (`$image_ref`) may only be a mutable tag; retain it for operator
context, but run restore from `.Image`. Repeat the original environment, ports,
network and restart-policy options in the final `docker run`; only `/data`
changes. For a bind mount, create a new empty directory and use
`--mount type=bind,source=/new/path,target=/data` in both commands. Keep
`notarium-before-restore` and old storage as rollback until verification.

In a source checkout, `make backup` is an optional safe publication wrapper.
`make restore BACKUP=…` is deliberately a local helper for the repository's
`docker/volumes/data` bind: it moves the directory aside, restores through the
current dev Compose service (including its source mounts), force-recreates that
same dev topology, and retains the old directory. It refuses a container created
without `compose.dev.yml`; neither Make target is needed on a deployed host.

The built-in command supports only the canonical single-root, file-backed SQLite
layout. If `META_DB_URL` is Postgres or notes/jobs live outside `DATA_DIR`, it
fails closed: use provider-native database and mount snapshots instead of a
partial archive.
