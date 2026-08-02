import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The durable job layer (#105) seen from the stand: a space with real content to
// archive, plus the job history a user accumulates by exporting it. Seed this to
// check Settings → Export by hand without first clicking an export and waiting —
// `useExportJob`'s reconnect adopts the seeded state on mount.
//
// Why this case exists at all (#101): export/import is the surface that shipped
// silently broken — the artifact path was a forgotten env var, so a green boot
// answered `202 Accepted` and the job died on `EACCES: mkdir '/app/.data'`. Nothing
// seeded that path, so nothing exercised it until a human clicked export in prod. A
// seeded stand now writes a real archive under `<DATA_DIR>/jobs` at seed time: if the
// data root is wrong, `make seed` says so, not a user a week later.
//
// Real-applier only (see JobDecl / docs/seeds.md): the fake back-end has no job
// layer, so e2e/visual don't render these rows. The applier fabricates nothing — it
// enqueues, claims and runs the PRODUCTION export handler, so the archive is a real
// ZIP of the notes below and its size is measured.
const body = (title: string, lead: string): string =>
  `# ${title}\n\n${lead}\n\n- Enough content that the archive has real bytes to weigh.\n- And a second line, so a stripped-frontmatter export still has a body.\n`

export const jobs: CaseSpec = {
  name: 'jobs',
  description:
    'Durable export jobs (#105) over a real space: a ready-to-download archive, one whose TTL lapsed, a failure and a cancellation — the terminal Export-tab states, plus a real artifact written under <DATA_DIR>/jobs (#101).',
  axes: ['jobs', 'structure', 'activity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.project({ space: 'main', path: 'Handbook', slug: 'handbook', displayName: 'Handbook' })

    // Content worth exporting: a couple of folders so a folder-scoped export (the
    // `folder` param below) has something to narrow to, and a frontmatter-bearing
    // note so `frontmatter: 'strip'` is exercised rather than merely configured.
    b.note({
      space: 'main',
      path: 'Handbook/onboarding.md',
      title: 'Onboarding',
      content: body('Onboarding', 'How a new teammate gets a laptop, an account and a mentor.'),
      tags: ['handbook', 'process'],
      created: daysBefore(now, 40, 10),
    })
    b.note({
      space: 'main',
      path: 'Handbook/release-checklist.md',
      title: 'Release checklist',
      content: body('Release checklist', 'What has to be true before a tag goes out.'),
      tags: ['handbook'],
      created: daysBefore(now, 26, 14),
    })
    b.note({
      space: 'main',
      path: 'notes/retro-2026-06.md',
      title: 'Retro — June',
      content: body('Retro — June', 'What went well, what did not, and what we changed.'),
      tags: ['retro'],
      created: daysBefore(now, 12, 11),
    })
    b.note({
      space: 'main',
      path: 'notes/scratch.md',
      title: 'Scratch',
      content: body('Scratch', 'A short note, so the export has a small entry too.'),
      created: daysBefore(now, 5, 16),
    })

    // The state the Export tab adopts on mount: finished, artifact alive → "Archive
    // ready — N bytes" with a working Download. Downloading it is the end-to-end
    // proof that the artifact store resolved to a writable root.
    b.job({ space: 'main', status: 'succeeded', daysAgo: 0.2, params: { scope: 'user' } })
    // Same success, but the TTL lapsed and the GC cleared the pointer — the row is
    // history with a dead artifact. This is what "I'll download it tomorrow" actually
    // turns into, and the tab must NOT offer it as ready.
    b.job({
      space: 'main',
      status: 'succeeded',
      daysAgo: 9,
      params: { scope: 'all', frontmatter: 'strip' },
      artifactTtlDays: null,
    })
    // A folder-scoped export that failed — the retry path's starting state.
    b.job({
      space: 'main',
      status: 'failed',
      daysAgo: 3,
      params: { scope: 'user', folder: 'Handbook' },
      error: 'export_unavailable',
    })
    // A user who hit Cancel mid-archive.
    b.job({ space: 'main', status: 'canceled', daysAgo: 6, params: { scope: 'user' } })
    // A real retrying import: production staging bytes plus a live pending row. Its
    // deliberately distant retry keeps the backup-critical state stable on a manual
    // QA stand, and row-aware maintenance must retain the upload for that retry.
    b.durableImport({
      space: 'main',
      jobId: 'seed-backup-probe',
      content: '{"format":"notarium-export","version":1,"notes":[]}\n',
      filename: 'seed-backup-probe.json',
      retryAt: '9999-12-31T00:00:00.000Z',
      error: 'seeded_transient_import_failure',
    })

    return b.build()
  },
}
