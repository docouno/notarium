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

A mode-0600 Unix socket inside the container first acquires a bounded durable
installation-generation freeze, then lets that process request two short
application checkpoints. The freeze blocks replay-key replacement without
holding a database transaction during filesystem I/O; expiry makes a crashed
backup producer recoverable. Each checkpoint queues HTTP mutations, durable jobs
and MCP calls (nominally read-only tools can persist cursors/audit); ordinary
HTTP reads remain available. Two paths are named exceptions to the REQUEST-level
hold, and both still take the gate around their own writes: `/mcp`, whose tool
calls enter it one at a time, and the provider `validate` operation, whose
outbound call can take up to two minutes on a local model and would otherwise
hold the instance read-only for that whole time. The exception is a per-route
list, not a prefix — provider credential and resource mutations stay inside the
barrier. Its price is real: a snapshot may catch a provider call in flight, and
the restored archive reads that call's outcome as unknown. It waits for active work, reconciles external note
edits, drains identity/history write-behind, then releases the gate. SQLite's online backup
API folds `meta.db` and committed WAL pages into one standalone database while
Markdown and durable job files are staged. A stage is accepted only when hashes,
mtimes, exact directories and SQLite `data_version` remain stable through the
final checkpoint/sample. Overlapping writes force a retry. Sustained churn exits
non-zero without publishing an archive.

The immutable stage is accepted only when its SQLite installation row, active
key pointer, and exact key-file hash match the same generation bundle. A
`publishing-active` key transition cannot be captured. The lease is revalidated
around the bounded SQLite/tree cut and released before ZIP compression.

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
- `data/replay-keyring/`: immutable installation replay keys and the active
  generation pointer;
- `manifest.json`: format version, timestamp, exact directories, file sizes,
  mtimes, SHA-256 checksums, and the witnessed installation generation.

`data/secret-keyring/` is deliberately absent. Provider credential ciphertext
is in `meta.db`, but its reversible master keys must be retained separately;
otherwise possession of one ZIP would disclose every live provider credential.
The producer omits the directory and verification/restore reject an archive
whose manifest tries to admit it.

Boot rejects both lexical containment and a static external symlink whose real
target is under a packed root before creating a key. A hard link, bind mount, or
filesystem swap after that check requires host-level control and is outside this
application guarantee; do not place provider keys under a notes/jobs mount by
another name.

Only Notarium-owned incomplete files are omitted: dot-named atomic note temps,
exact `.<package-id>.install-<uuid>` role-package staging directories at a Personal/Space library root or
an exact `_projects/<encoded-project-id>/` library root (one orphaned by a process death is reclaimed
by the next install into that same library root, once it is more than an hour old),
the import contour's own unpublished temps (`jobs/imports/<space>/<job>.import.part`
and the plan sidecar's `<job>.import-plan.part-<run>`), and in-progress export artifact
parts. The published `<job>.import` upload and `<job>.import-plan` sidecar are NOT omitted:
they are what a restored import job re-reads and adopts instead of re-deciding a tree it
may already be part-way through ([import.md](import.md#the-plan-survives-the-run)).
Ordinary user files or directories ending in `.part` are legitimate and remain
in the backup. The supported per-space `.notarium-fs-ops/` recovery namespace is
preserved: an accepted restart-durable restore must travel with the matching
meta-DB operation row. For bulk restore this includes the parent evidence roster,
its strict children, receipts, lifecycle barrier and outbox state; copying only the
published note bytes would lose the decision about whether they may become visible.
Raw actors, idempotency keys and request payloads do not become backup secrets:
persistence keeps only domain-separated HMACs/fingerprints. The recovery namespace
remains private to recovery and is not part of a user space export. `data/engine/` is
derived and omitted; it rebuilds after restore.

This image-native backup covers the canonical one-root layout under `SPACES_ROOT`,
including its ID-backed default `.notarium/skills/<package-id>` mounts. The package directory and
materialized `notarium-id` remain stable when manifest names change, and the backup preserves both.
An embedded host that configures
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
failed SQLite `integrity_check`, and any DB/pointer/key generation mismatch. It
does not read or change live `DATA_DIR`.

Verification cannot test whether provider credentials decrypt: their
`secret-keyring` is intentionally not in the ZIP and is supplied only after
restore.

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
# Place the separately retained secret-keyring into the fresh DATA_DIR now.
docker compose up -d --force-recreate --no-deps notarium
```

Recreate the application container afterwards: `compose start` would restart the
old container with its old mount configuration. Keep the old volume until the
restored instance has been checked. Restore validates the full archive before
installation. A process interruption during installation leaves an explicit
marker; discard that disposable target and restore into a new empty one rather
than resuming or merging.

The restored meta-DB and replay keyring are validated as one finite generation
matrix and installed together before startup. The meta-DB must carry a migration ledger accepted by the target build
([schema contract](meta-db.md#startup)). A non-empty pre-baseline database fails
closed; restore does not guess its version or stamp it automatically. Upgrade
and verify such an owned instance with its version-specific operator procedure
before moving it across the baseline boundary.

The provider credential keyring is a third, separately retained input. The only
supported order is: restore into the fresh empty `DATA_DIR`, place the matching
`secret-keyring`, then start Notarium for the first time. Placing it before
restore makes the target non-empty and restore refuses; starting before placing
it can publish a new pointer. An exact historical keyring snapshot starts
directly. A descendant keyring whose pointer names a newer generation requires
`admin reconcile-credential-keyring --expected-key-id …` before normal startup.

Keep every credential key file needed by the retention window of your archives.
Rotation retires a generation in the DB but does not delete its immutable file:
an older archive may still contain ciphertext under that generation.

If only the Notarium ZIP survives and the credential keyring is completely
lost, notes, spaces, search state and accounts still restore; provider
credentials do not. `admin purge-unreadable-secrets --expected-key-id …` is a
two-step dry-run/`--apply` disaster procedure that removes only the lost
provider-secret state before a new key is minted.
The exact command gates and the limits of this recovery are in
[providers.md](providers.md#backup-restore-and-recovery).

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
partial archive. A future Postgres backup path must bind a provider/admin snapshot
session to the same generation bundle; an ordinary filesystem copy is not one.
