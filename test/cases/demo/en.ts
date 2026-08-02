import type { DemoBundle } from './types'

// EN bundle for the demo world (#256) — the screenshots that go on the landing
// page, the README and the docs site. Read this as PRODUCT COPY, not fixture
// filler: every line is on a public surface, so it follows the product's tone
// rules: engineering, concrete, numbers over adjectives, no hype lexicon.
//
// The legend: a self-hosting developer's knowledge base about the machine and the
// services they actually run — the primary audience for this product.
// A reader on r/selfhosted or Show HN should recognise their own notes, which is
// why nothing here is about Notarium itself: a demo of us documenting us proves
// nothing about what the reader would keep here.
//
// EN is authored as the ORIGINAL, not as a translation of another language (a
// deliberate asymmetry: `LOCALES[0] = 'en'` is the translation pivot, and a hero
// screenshot full of calque reads worse than no screenshot).
//
// PARAGRAPHS ARE ONE LINE EACH — no hand-wrapping at 80 columns. The editor frame
// photographs the raw markdown, and CodeMirror soft-wraps: hard wraps land as
// ragged half-lines mid-sentence in the one frame that shows the source.

const homeServer = `# Home server

The whole stack runs on one machine — a refurbished mini-PC with 32 GB of RAM under the stairs. Everything is a container, everything sits behind one reverse proxy, and the only thing I back up is a single volume tree plus the Postgres dumps.

## How traffic moves

\`\`\`mermaid
flowchart LR
  net[Internet] --> caddy[Caddy]
  caddy --> app[Notarium]
  caddy --> paperless[Paperless]
  app --> pg[(Postgres)]
  paperless --> pg
  pg --> dump[Nightly dump]
  dump --> off[Offsite bucket]
\`\`\`

> [!note] The rule that keeps this small
> If a service can't survive \`docker compose down && docker compose up -d\` without me remembering something, it isn't finished. That rule is why there is no manual step anywhere in [[Restore from backup]].

## What runs here

| Service | Port | State lives in | Notes |
|---|---|---|---|
| Caddy | 80/443 | \`caddy_data\` | Automatic certs, the only thing exposed |
| Postgres 16 | 5432 | \`pgdata\` | Shared by three services, see [[Postgres over SQLite]] |
| Notarium | 3000 | \`/data\` | These notes |
| Paperless | 8000 | \`paperless\` | Scans, OCR |
| Uptime Kuma | 3001 | \`kuma\` | Pings the four above, alerts my phone |

## The proxy config, in full

There isn't much of it, which is the point:

\`\`\`caddyfile
notes.example.org {
  reverse_proxy notarium:3000
}

scans.example.org {
  reverse_proxy paperless:8000
}
\`\`\`

## Still open

- [x] Move Postgres off the SD card — done, see [[Storage and backups]]
- [x] Alert when a backup doesn't land, not just when a service is down
- [ ] Decide whether the offsite copy is worth encrypting client-side
- [ ] Write down the DNS setup before I forget it again

Related: [[One container per service]] · [[No Kubernetes]] · [[Disk pressure]]
`

// v0 — before the proxy config and the open-questions list were written down. The
// note grew into its final form; the case replays that as a real edit rather than
// a re-save of an identical body (which the live journal would simply dedupe).
const homeServerV0 = homeServer.slice(0, homeServer.indexOf('## The proxy config'))

const storageAndBackups = `# Storage and backups

Two disks: a 1 TB NVMe for anything hot, a 4 TB spinning disk for scans, media and the local backup copy. The NVMe is the one that would hurt to lose, so it is the one with three copies.

## The 3-2-1 as it actually stands

1. **Live** — \`/srv\` on the NVMe.
2. **Local** — nightly \`restic\` snapshot to the 4 TB disk, kept 30 days.
3. **Offsite** — the same snapshot pushed to object storage, kept 90 days.

\`\`\`bash
restic backup /srv \\
  --exclude-file /etc/restic/excludes \\
  --tag nightly

restic forget --keep-daily 30 --keep-weekly 12 --prune
\`\`\`

> [!warning] A backup you haven't restored is a hypothesis
> I learned this the expensive way: the nightly job had been exiting 0 with an empty snapshot for eleven days. The write-up is [[Backups were silently empty for eleven days]], and the check it produced is now step 1 of [[Restore from backup]].

## Postgres is dumped, not snapshotted

A file-level snapshot of a running Postgres is a coin flip. So: \`pg_dump\` per database, and the dump directory is what \`restic\` picks up.

See also: [[Home server]] · [[Upgrade Postgres]]
`

const storageAndBackupsV0 = storageAndBackups.slice(
  0,
  storageAndBackups.indexOf('## Postgres is dumped'),
)

const networking = `# Networking

One public IP, one open port pair (80/443), everything else reachable only over WireGuard. No port forwarding per service — that habit is how you end up with a Redis on the open internet.

## Names

- \`*.example.org\` → the public IP, terminated by Caddy.
- \`*.home.example.org\` → split-horizon DNS: resolves to the LAN address inside WireGuard and nowhere outside it.

## What I got wrong the first time

Running the DNS resolver as a container on the same host it resolves names for. When the host rebooted, nothing came up until DNS did, and DNS wouldn't come up until Docker resolved its own registry name. The resolver now has a static entry and its upstream is an IP, not a hostname.

Related: [[Home server]] · [[No Kubernetes]]
`

const networkingV0 = networking.slice(0, networking.indexOf('## What I got wrong'))

const postgresOverSqlite = `# Postgres over SQLite

**Status:** accepted · **Supersedes:** three separate SQLite files

## Context

Three services needed a database. Each ships with SQLite by default and each supports Postgres. Running three SQLite files is objectively simpler — right up until the first time you want a consistent backup across them.

## Decision

One Postgres 16 container, one database per service, one dump job.

## Why

- A single dump job I can actually verify beats three backup paths I trust less.
- Connection pooling, and \`pg_stat_statements\` when something is slow.
- All three services treat Postgres as a first-class target, not a bolt-on.

## What it costs

An always-on process with a real memory floor (~400 MB here), and one more thing that can be down. Accepted: it is the same machine either way, and [[Upgrade Postgres]] is a runbook rather than folklore.

Related: [[Home server]] · [[Storage and backups]]
`

const oneContainerPerService = `# One container per service

**Status:** accepted · **Applies to:** every service on this host

## Context

The tempting shortcut is one big container with a supervisor inside — fewer things to wire up, one \`docker logs\` to read.

## Decision

One process per container, one container per service, composed by a single \`compose.yml\` kept in git.

## Why

Restarting a service shouldn't restart its neighbours, and \`docker logs\` should answer "what did *this* do", not "what did the machine do". Upgrades become one image tag at a time, which is the difference between a five-minute change and an evening.

## What it costs

More YAML, and the health of the whole now depends on the proxy in front. Both were worth it — see [[Home server]].
`

const noKubernetes = `# No Kubernetes

**Status:** accepted · **Scope:** this host, one operator

## Context

One machine, one operator, roughly a dozen containers. Every guide for a homelab this size eventually suggests k3s.

## Decision

Docker Compose. No orchestrator.

## Why

There is no second node to schedule onto and no team to hand a cluster to. The failure modes I actually hit — a full disk, an expired cert, a bad image tag — are not the ones an orchestrator solves, and each already has a runbook: [[Disk pressure]], [[Restore from backup]], [[Upgrade Postgres]].

## When I'd revisit

A second machine, or someone else on call. Neither is true today.

> [!tip] Reread this before the next rebuild
> The pull toward "real infrastructure" is strongest right after something breaks — which is exactly when the reasoning above is easiest to forget.
`

const RESTORE_HEAD = `# Restore from backup

The drill, top to bottom. Run it against a scratch directory once a quarter: an untested restore is [[Storage and backups]]'s hypothesis, not a backup.

## 1. Check the snapshot is real

\`\`\`bash
restic snapshots --tag nightly --latest 1
restic stats latest
\`\`\`

If the size looks wrong for the data set, stop here — that is the failure mode from [[Backups were silently empty for eleven days]].

## 2. Restore to a scratch path

\`\`\`bash
restic restore latest:/srv --target /tmp/restore-drill
\`\`\`

The \`:/srv\` matters. Without it restic recreates the whole path from the snapshot root and the dumps land in \`/tmp/restore-drill/srv/dumps\` — which is where I lost twenty minutes the first time.

## 3. Bring Postgres back

\`\`\`bash
docker compose stop notarium paperless
psql -U postgres -c 'drop database notarium;'
psql -U postgres -c 'create database notarium;'
pg_restore -U postgres -d notarium /tmp/restore-drill/dumps/notarium.dump
docker compose start notarium paperless
\`\`\`

`

// The runbook's life, one constant per revision — a real document grows a step at
// a time. v0 is how it was written, v1 adds the verification pass, v2 is the
// AGENT's edit: it folds in what the incident taught (see cases/demo.ts).
const restoreFromBackup = `${RESTORE_HEAD}
Related: [[Home server]] · [[Upgrade Postgres]]
`

const RESTORE_VERIFY = `${RESTORE_HEAD}
## 4. Verify before declaring victory

- Open the app and load a note that changed in the last day.
- Check the row counts against what the dump reported.
- Confirm the proxy is serving a fresh cert, not a cached one.
`

const restoreFromBackupV1 = `${RESTORE_VERIFY}
Related: [[Home server]] · [[Upgrade Postgres]]
`

const restoreFromBackupV2 = `${RESTORE_VERIFY}
## 5. Assert the dump isn't empty

Added after the eleven-day incident: \`restic stats\` reports a plausible size even when the Postgres dumps inside are zero-length, because the rest of \`/srv\` is what fills it. Assert on the dump itself, not on the snapshot.

\`\`\`bash
test -s /tmp/restore-drill/dumps/notarium.dump || {
  echo 'empty dump — the nightly job is lying'; exit 1;
}
\`\`\`

Related: [[Home server]] · [[Upgrade Postgres]] · [[Backups were silently empty for eleven days]]
`

const upgradePostgres = `# Upgrade Postgres

Major versions don't move in place — the data directory format changes — so the upgrade is dump, swap the image, restore.

\`\`\`bash
pg_dumpall -U postgres > /srv/dumps/pre-upgrade.sql
docker compose stop postgres
# bump the image tag in compose.yml, then:
docker volume rm stack_pgdata
docker compose up -d postgres
psql -U postgres -f /srv/dumps/pre-upgrade.sql
\`\`\`

> [!caution] Do the dump before touching the tag
> \`docker compose up -d\` with a new major and an old volume starts a container that immediately exits, and the log line explaining why scrolls past in the middle of an unrelated stack trace.

Budget an hour. It has never taken an hour, which is why it keeps getting done on a weekday evening.

Related: [[Postgres over SQLite]] · [[Restore from backup]]
`

const diskPressure = `# Disk pressure

Symptom: something writes, gets \`ENOSPC\`, and the service that notices first is rarely the service that filled the disk.

## Find it

\`\`\`bash
df -h
docker system df
du -xh /srv --max-depth=2 | sort -h | tail -20
\`\`\`

## The three usual culprits

1. **Docker logs** — a chatty container with no rotation. Fixed globally in \`daemon.json\` (\`max-size: 10m\`, \`max-file: 3\`), but a container created before that keeps its old setting until it is recreated.
2. **Old images** — \`docker image prune -a\` after an upgrade run.
3. **Restic cache** — \`~/.cache/restic\` grows quietly and is safe to delete.

## Prevention that actually stuck

An Uptime Kuma push check that fails when the root filesystem crosses 85%. Alerting on the trend rather than on the wall is the only reason the last two never became incidents.

Related: [[Home server]] · [[Storage and backups]]
`

const diskPressureV0 = diskPressure.slice(
  0,
  diskPressure.indexOf('## Prevention that actually stuck'),
)

const incident = `# Backups were silently empty for eleven days

**Impact:** no usable Postgres backup for eleven days. Nothing was lost — this was caught by a drill, not by needing the backup.

## What happened

The nightly job runs \`pg_dump -Fc\` per database into \`/srv/dumps\`, then \`restic\` picks the directory up. On day one the Postgres container was recreated with a new tag and the dump user's password was rotated. \`pg_dump\` started failing authentication, wrote a zero-byte file, and exited **0** — the exit code belonged to the shell redirect, not to \`pg_dump\`.

\`restic\` then dutifully backed up that zero-byte file every night. Snapshot sizes barely moved, because the dumps are a rounding error next to the scans.

## How it was found

The quarterly restore drill in [[Restore from backup]]. Step 3 failed with \`pg_restore: error: input file is too short (read 0, expected 5)\`.

## Why it wasn't caught sooner

- The job's success was measured by its exit code, and the exit code was a lie.
- Monitoring watched *whether the backup ran*, never *what it contained*.

## Fixes

- \`set -o pipefail\` in the job, plus an explicit size assertion per dump.
- The drill now asserts on dump size before restoring — step 5 of [[Restore from backup]].
- A push check that fails if the newest dump is under half the size of the previous one.

> [!important] The lesson worth keeping
> A green check that measures the wrong thing is worse than no check: it spends the attention a missing check would have kept.
`

const scratch = `# Weekend list

Loose ends, in the order I'll probably get to them.

- Cert renewal for \`scans.example.org\` — Caddy handles it, but the DNS challenge credentials expire in October.
- Try the new Paperless OCR language pack on last year's scans.
- The upstairs access point drops clients every few days. Suspect the channel, not the hardware.
- Read up on whether client-side encryption is worth it for the offsite copy — see the open question in [[Home server]].
`

const readingList = `# Reading list

Things worth finishing, not a bookmark dump.

| Source | Why it's here | Status |
|---|---|---|
| *Designing Data-Intensive Applications*, ch. 5–7 | Replication, for the day there is a second machine | Reading |
| Postgres docs on \`pg_basebackup\` | The alternative to dump/restore in [[Upgrade Postgres]] | Queued |
| Restic design document | Wanted to know why snapshots are cheap before trusting them | Done |
| Caddy JSON config reference | The Caddyfile is sugar; the JSON is the real thing | Queued |
`

export const EN: DemoBundle = {
  locale: 'en',
  spaceName: 'Engineering',
  displayName: 'Sam',
  searchQuery: 'backup',
  notes: [
    {
      key: 'home-server',
      path: 'architecture/home-server.md',
      title: 'Home server',
      body: homeServerV0,
      tags: ['infra', 'overview'],
    },
    {
      key: 'storage',
      path: 'architecture/storage-and-backups.md',
      title: 'Storage and backups',
      body: storageAndBackupsV0,
      tags: ['infra', 'backup'],
    },
    {
      key: 'networking',
      path: 'architecture/networking.md',
      title: 'Networking',
      body: networkingV0,
      tags: ['infra', 'network'],
    },
    {
      key: 'adr-postgres',
      path: 'decisions/postgres-over-sqlite.md',
      title: 'Postgres over SQLite',
      body: postgresOverSqlite,
      tags: ['decision'],
    },
    {
      key: 'adr-containers',
      path: 'decisions/one-container-per-service.md',
      title: 'One container per service',
      body: oneContainerPerService,
      tags: ['decision'],
    },
    {
      key: 'adr-k8s',
      path: 'decisions/no-kubernetes.md',
      title: 'No Kubernetes',
      body: noKubernetes,
      tags: ['decision'],
    },
    {
      key: 'runbook-restore',
      path: 'runbooks/restore-from-backup.md',
      title: 'Restore from backup',
      body: restoreFromBackup,
      tags: ['runbook', 'backup'],
    },
    {
      key: 'runbook-postgres',
      path: 'runbooks/upgrade-postgres.md',
      title: 'Upgrade Postgres',
      body: upgradePostgres,
      tags: ['runbook'],
    },
    {
      key: 'runbook-disk',
      path: 'runbooks/disk-pressure.md',
      title: 'Disk pressure',
      body: diskPressureV0,
      tags: ['runbook'],
    },
    {
      key: 'incident-backup',
      path: 'incidents/backups-empty.md',
      title: 'Backups were silently empty for eleven days',
      body: incident,
      tags: ['incident', 'backup'],
    },
    {
      key: 'scratch',
      path: 'notes/weekend-list.md',
      title: 'Weekend list',
      body: scratch,
      tags: ['todo'],
    },
    {
      key: 'reading',
      path: 'notes/reading-list.md',
      title: 'Reading list',
      body: readingList,
      tags: ['reading'],
    },
  ],
  // EVERY authored edit must change the text. A re-save of an identical body is not
  // a revision the product would keep — the live journal dedupes it (revisionJournal
  // refuses a no-op write) — so seeding one makes the fake's heatmap count changes a
  // real stand never records, and prints a counter-less "Edited" row in the feed.
  // The case declares exactly as many edit dates per note as there are versions here.
  //
  // The runbook keeps two (v1 human, v2 agent) so its chain fills the history frame.
  edits: [
    { key: 'home-server', step: 0, body: homeServer },
    { key: 'storage', step: 0, body: storageAndBackups },
    { key: 'networking', step: 0, body: networking },
    { key: 'runbook-disk', step: 0, body: diskPressure },
    { key: 'runbook-restore', step: 0, body: restoreFromBackupV1 },
    { key: 'runbook-restore', step: 1, body: restoreFromBackupV2 },
  ],
  relatedLabel: 'Related',
  filler: [
    {
      folder: 'hardware',
      anchor: 'Home server',
      titles: [
        'Power draw at idle',
        'UPS runtime measurements',
        'Fan curve after the case swap',
        'Noise measurements',
        'Spare parts drawer',
        'Case fan replacement',
        'Disk temperature log',
      ],
    },
    {
      folder: 'services',
      anchor: 'Networking',
      titles: [
        'Paperless tagging rules',
        'Grafana sketch',
        'Media layout',
        'Printer setup',
        'Scanning workflow',
        'Uptime Kuma checks',
        'Feed reader migration',
      ],
    },
    {
      folder: 'notes',
      anchor: 'Disk pressure',
      titles: [
        'Cron jobs on this box',
        'SSH hardening checklist',
        'Weekly maintenance pass',
        'Things to try next',
      ],
    },
  ],
}
