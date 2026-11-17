# Control backup participant

`ControlBackup::new` composes an existing `ControlStore`, validated `Keyring`,
`DataRoot` and explicit `BackupConfig`. It implements the core
`BackupParticipantPort` for trusted Backup/Restore maintenance authority. It does
not start HTTP, archive packaging, upload, a canonical snapshot or a restore
cutover. The composition owner must coordinate both stores and stop old authority
registrations before serving restored state.

## Snapshot protocol

1. `prepare` admits one active control backup per `ControlBackup` instance. It opens files and
   dedicated connections, executes the PostgreSQL witness query in autocommit to warm its plan, attempts a best-effort SQLite WAL
   truncating checkpoint and validates key canaries before pausing writes. An owner lock
   serializes artifact recovery across processes. PostgreSQL starts its read-only
   repeatable-read transaction here. Its first data query runs in `open_cut`,
   so preparation does not acquire the source snapshot.
2. `acquire_hold` returns validated metadata. Control has no CAS blob hold; raw
   key material does not cross into the backup worker.
3. `pause_writes` blocks new admitted control writers and drains existing writers.
   SQLite takes the exclusive stable file fence; PostgreSQL takes an exclusive
   session advisory lock on a separate connection.
4. `open_cut` pins a real database snapshot by reading storage epoch and keyring
   metadata. It checks installation, schema version and the complete prepared
   keyring witness. SQLite first drains its native writer lock with a prepared
   write connection, covering driver cleanup after an async runtime disappears.
5. `resume` releases the writer pause while retaining the source snapshot.
   PostgreSQL confirms the advisory unlock and releases local writer admission.
   The source transaction and the unlocked private socket remain owned until cleanup; SQLite retains its read transaction on the same native connection.
   Later commits cannot change the cut.
6. `spool` produces a complete local artifact, checks it, fsyncs it and computes a
   streaming BLAKE3 digest before releasing the source. `close` waits for actual
   local resource cleanup. Packaging and upload do not retain a database snapshot.

The coordinator obtains control then canonical write gates in a fixed order and
keeps both paused until both snapshots are pinned. A control-only snapshot does
not establish consistency of the two-store pair.

A dedicated owner thread holds all native handles. Its own Tokio runtime drives
PostgreSQL I/O independently of the caller's runtime. Dropping an active phase or
in-flight operation signals cancellation independently of the bounded command
queue. Stale completed phase handles cannot cancel their successor. An unread
spool reply remains participant-owned: receipt acceptance and abort race through
one atomic ownership transition.

A background task on the owner runtime monitors event-driven cancellation,
deadlines and retention even while the caller is idle, tracking PostgreSQL spool
bytes in memory without per-row filesystem metadata syscalls. PostgreSQL graceful
unlock/close and rollback cleanup each have a
five-second grace; timed-out handles remain owned by the private pool until its
close-on-drop work has closed their local sockets. SQLx's pinned close-on-drop
grace is five seconds. A timeout returns an error, not a graceful rollback ACK.
Finite server statement and idle timeouts provide an additional process/connection
loss fallback. A lost network cannot provide proof of immediate remote cleanup.
Native filesystem calls retain their owner through completion; the library does
not promise to interrupt an arbitrarily stalled kernel filesystem operation.

## Budgets and witnesses

Default operator ceilings are five minutes overall, 10 GiB of spool bytes,
256 MiB of pinned SQLite WAL, and five minutes of PostgreSQL snapshot age.
`BackupConfig`, the call budget and coordinator budget clamp these ceilings;
the coordinator may lower them again at spool time. The deadline includes
preparation, drain, pin and spool. SQLite observes the WAL file size on disk
(treating an absent WAL file as zero bytes);
PostgreSQL measures snapshot age from immediately before its real pin read.
Backend metric mismatches fail closed. Exceeding retention aborts the backup
and releases its cut; it does not throttle interactive writers.

The witness contains installation ID, schema version, and key ID, generation,
active/readable state and canary digest. Control leaves `histories` empty:
acknowledgement cursors cannot substitute for authoritative canonical histories.
The canonical participant supplies restored history and per-Space ceilings.
Raw key files, their pointer file and plaintext credentials are excluded from
database artifacts. Encrypted database values and canaries are included; recovery
requires separately retained key files.

## Artifacts and stream format

Artifacts live under `<DataRoot>/staging/artifacts/control/`. Participant directories
are private, files are created exclusively with owner-only permissions, and
regular-file reads and metadata have explicit bounds. The stable owner lock is
never unlinked. A durable `.pending` marker authorizes cleanup of only that
artifact's incomplete files. Recovery preserves unrelated files and completed
artifacts; an existing durable `.ready` marker wins over a leftover pending marker.
Identifier collisions fail without taking ownership of existing files.

`BackupSpool` identifies the artifact by typed ID, kind, byte count, witness and
complete-file digest. `open_artifact` resolves only this owned namespace, verifies
the complete digest and returns a file positioned at the start. Callers cannot
supply arbitrary paths. The packaging consumer owns accepted artifacts and their
eventual retention/deletion policy.

`SqliteSnapshotV1` is a standalone SQLite database produced with the safe native
backup API in bounded page steps. Destination close and integrity checking occur
before its source cut is released. No database-wide RAM serialization is used.

`PostgresSpoolV1` is a versioned length-delimited JSON frame stream: header/witness,
each target table in schema order, typed rows in primary-key order, per-table
counts, and a final counts/digest frame. Table reads contain at most 200 records
and 8 MiB of encoded target records. Frames are capped at 8 MiB plus 128 bytes of
framing overhead before allocation. PostgreSQL text columns and primary keys declare `COLLATE "C"` in schema DDL so
portable byte-ordered keyset predicates use B-tree index order directly.

`SpoolReader` checks version, closed DTOs, typed target validation, table/key order,
counts, truncation, final digest and absence of trailing bytes. Any error poisons
the reader. The target importer still enforces SQL constraints and cross-row
references in its transaction; stream parsing alone does not publish a ready epoch.

## Restore cursors

`restore_cursors` rejects duplicate Space IDs, then changes owner and episode
acknowledgements in one admitted control transaction. For each supplied Space,
the new acknowledgement is `MIN(old, restored ceiling)` and the history incarnation
is replaced. It does not create missing cursors or modify unmentioned Spaces.
Repeating the same restore input is idempotent. The caller must supply authoritative
canonical ceilings and perform the surrounding offline cutover.

## Verification

The canonical `make test` executes the backup suites against SQLite and the
isolated PostgreSQL 16 fixture. For an isolated run after `make setup`:

```sh
sh scripts/control-db-fixture.sh run \
  sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
  cargo test --locked --offline -p notarium-control --lib backup:: -- --test-threads=1 --nocapture
```

Latency tests use ten warmup cuts, then 1,000 SQLite or 100 PostgreSQL cuts under
concurrent writes. They report prepare, drain, pause and spool separately, with
p50/p95/p99/max and raw samples in `apps/api/target/backup-latency-*.json`.
Pause includes writer drain through actual resume; reporting excludes neither
slow commits nor outliers. PostgreSQL uses an isolated local Unix socket, not a
production network profile. The paired release benchmark uses both control and canonical participants. It
reports the inclusive coordination interval and the interval from the first
acknowledged safe point through both resume acknowledgements. The latter has
a p95 target below one millisecond. See [Canonical storage and CAS](storage.md).
