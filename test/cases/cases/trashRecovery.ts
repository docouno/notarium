import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const deletedNote = (
  builder: WorldBuilder,
  now: Date,
  input: {
    path: string
    title: string
    createdDaysAgo?: number
    deletedDaysAgo?: number
  },
): string =>
  builder.note({
    space: 'main',
    path: input.path,
    title: input.title,
    content: `# ${input.title}\n\nA useful working copy that was deleted by mistake.\n`,
    created: daysBefore(now, input.createdDaysAgo ?? 70, 9),
    deletedAt: daysBefore(now, input.deletedDaysAgo ?? 8, 11),
    principal: 'user:sergey',
  })

/**
 * Product-facing recovery world. Unlike `restore-states`, which is a compact
 * codec/state-algebra proof, this case is deliberately shaped like a real trash:
 * many ordinary recoverable notes, one legacy partial copy, source-only records,
 * a record with no captured copy, an archived space, and a path collision that is
 * only discovered when restore runs. SCALE=5 crosses the 100-note page boundary.
 */
export const trashRecovery: CaseSpec = {
  name: 'trash-recovery',
  description:
    'A realistic mixed recovery queue: exact and partial copies, source-only and record-only rows, an archived space, a path conflict, and select-all-N scale.',
  axes: ['trash', 'history', 'scale'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Recovery workspace' })
    b.space({ slug: 'closed-project', displayName: 'Closed project', archived: true })
    b.user({ username: 'sergey', password: 'seed-pass', displayName: 'Sergey', admin: true })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'closed-project', username: 'sergey', role: 'owner' })

    b.note({
      space: 'main',
      path: 'current/recovery-checklist.md',
      title: 'Recovery checklist',
      content: '# Recovery checklist\n\nReview restored notes before publishing.\n',
      created: daysBefore(now, 12, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'closed-project',
      path: 'handover.md',
      title: 'Project handover',
      content: '# Project handover\n\nThe archived space keeps its complete contents.\n',
      created: daysBefore(now, 90, 9),
      principal: 'user:sergey',
    })

    const ordinaryCount = Math.max(12, Math.round(24 * scale))

    for (let i = 1; i <= ordinaryCount; i++) {
      const n = String(i).padStart(3, '0')
      deletedNote(b, now, {
        path: `recoverable/meeting-note-${n}.md`,
        title: `Meeting note ${n}`,
        createdDaysAgo: 90 + (i % 20),
        deletedDaysAgo: 1 + (i % 14),
      })
    }

    const partial = deletedNote(b, now, {
      path: 'legacy/launch-outline.md',
      title: 'Launch outline from an older Notarium',
      deletedDaysAgo: 4,
    })
    b.revisionState({
      note: partial,
      date: daysBefore(now, 4, 11),
      kind: 'delete',
      state: {
        kind: 'legacy',
        content:
          '# Launch outline\n\nThe note body is available, but older metadata was not captured.\n',
      },
    })

    const protectedSource = deletedNote(b, now, {
      path: 'recovery/protected-automation.md',
      title: 'Automation note with protected identity',
      deletedDaysAgo: 5,
    })
    b.revisionState({
      note: protectedSource,
      date: daysBefore(now, 5, 11),
      kind: 'delete',
      state: {
        kind: 'document',
        source: {
          encoding: 'utf8',
          data: '---\nnotarium-id: &identity "{{noteId}}"\ncopy: *identity\ntitle: Automation note with protected identity\n---\nThe source can be inspected, but its protected identity cannot be rebound safely.\n',
        },
        ownerClaims: [{ key: 'notarium-id', ownership: 'value' }],
      },
    })

    // Source-only: the manifest name is not one a package can carry, so the row has
    // bytes to show and nothing safe to republish.
    const importedSource = deletedNote(b, now, {
      path: 'imports/imported-helper-source.md',
      title: 'Imported helper source',
      deletedDaysAgo: 6,
    })
    b.revisionState({
      note: importedSource,
      date: daysBefore(now, 6, 11),
      kind: 'delete',
      state: {
        kind: 'document',
        role: 'skill-root',
        skillDirectoryName: 'imported-helper',
        source: {
          encoding: 'utf8',
          data: '---\nname: imported--helper\n---\nThe original text is still available for inspection.\n',
        },
      },
    })

    const externalRecord = deletedNote(b, now, {
      path: 'external/notes-removed-before-capture.md',
      title: 'Notes removed before capture',
      deletedDaysAgo: 7,
    })
    b.revisionState({
      note: externalRecord,
      date: daysBefore(now, 7, 11),
      kind: 'delete',
      state: { kind: 'gap' },
    })

    // Eligibility is true in the list, but the live replacement makes publication
    // fail with physical-target-changed. This keeps operational conflicts distinct from
    // intrinsic recovery availability in both the seed and the UX.
    deletedNote(b, now, {
      path: 'shared/weekly-status.md',
      title: 'Earlier weekly status',
      deletedDaysAgo: 9,
    })
    b.note({
      space: 'main',
      path: 'shared/weekly-status.md',
      title: 'Current weekly status',
      content: '# Current weekly status\n\nThis live note now owns the original path.\n',
      created: daysBefore(now, 2, 9),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
