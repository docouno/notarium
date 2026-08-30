import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The field axis at the scale the snapshot's memory is measured on: every note
 *  carries a full dozen author keys, so the projection's cost is the corpus's cost.
 *  TWO measurements are paired with it, and both are named here because a corpus with
 *  one advertised consumer gets resized for that one: `make bench-fields-snapshot`
 *  reports what the projection costs the snapshot in heap, and
 *  `FIELDS_BACKFILL_CASE=fields-scale npx vitest run test/integration/fieldsBackfill.test.ts`
 *  prices the ladder's one-off re-derivation over the same corpus.
 *
 *  The `description` below names the same two, and repeating them there is the point
 *  rather than an oversight: that string — not this block — is what
 *  `npx tsx scripts/seed.ts --list` prints to an operator, and it went on advertising a
 *  THIRD consumer, a blob-build budget, for two rounds after this block was corrected.
 *  No such consumer exists: that budget is gated in `packages/core/src/libs/fields/
 *  blob.test.ts`, on an input the gate builds itself and never reads from here. */
export const fieldsScale: CaseSpec = {
  name: 'fields-scale',
  description:
    "10000 notes, each with twelve author keys (ten scalars and two lists) — the synthetic corpus the fields column's snapshot memory is measured on, and the one the ladder's one-off re-derivation is priced on.",
  axes: ['fields', 'scale'],
  build: ({ scale, now }) => {
    const b = new WorldBuilder(now)
    const corpusSize = Math.max(1, Math.round(10_000 * scale))

    b.space({ slug: 'fields-scale', displayName: 'Field axis at scale', personalFor: 'sergey' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'fields-scale',
    })

    for (let i = 1; i <= corpusSize; i++) {
      const serial = String(i).padStart(5, '0')

      b.note({
        space: 'fields-scale',
        path: `corpus/${serial.slice(0, 2)}/note-${serial}.md`,
        title: `Scale note ${serial}`,
        content: `# Scale note ${serial}\n\nOne of a corpus sized to measure the field projection.`,
        frontmatter: [
          `status: ${['backlog', 'doing', 'done'][i % 3]}`,
          `priority: ${i % 5}`,
          `sprint: ${2000 + (i % 40)}`,
          `client: client-${i % 120}`,
          `owner: owner-${i % 30}`,
          `area: area-${i % 12}`,
          `stage: stage-${i % 7}`,
          `estimate: ${i % 21}`,
          `source: import-${i % 9}`,
          `note: line ${i}`,
          'reviewers:',
          `- reviewer-${i % 25}`,
          `- reviewer-${(i + 5) % 25}`,
          `- reviewer-${(i + 11) % 25}`,
          'labels:',
          `- label-${i % 14}`,
          `- label-${(i + 3) % 14}`,
          `- label-${(i + 8) % 14}`,
        ].join('\n'),
        created: daysBefore(now, i % 365, 9),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
