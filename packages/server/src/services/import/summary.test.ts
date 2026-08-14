// The summary collector's whole job is to stay bounded while its counters stay
// exact. Both halves are asserted here, because either one alone is a lie: a
// bounded result with invented counters describes an import that never happened.

import { describe, expect, it } from 'vitest'

import { IMPORT_DETAIL_CAP } from './consts'
import { createSummaryCollector } from './summary'

describe('createSummaryCollector', () => {
  it('counts every note but samples only the cap', () => {
    const collector = createSummaryCollector()
    const members = IMPORT_DETAIL_CAP + 50

    for (let i = 0; i < members; i++) {
      collector.file(`note-${i}.md`, 'markdown')
      collector.imported(`note-${i}.md`, `id-${i}`)
    }
    const summary = collector.snapshot()

    expect(summary.imported).toBe(members)
    expect(summary.files).toHaveLength(IMPORT_DETAIL_CAP)
    expect(summary.created).toHaveLength(IMPORT_DETAIL_CAP)
    // Omitted counts FILES, not calls. Charging it per note reported a 2 000-member
    // archive as 3 600 omitted files — twice the number of files it even had.
    expect(summary.filesOmitted).toBe(50)
  })

  it('never charges an omission twice for one member', () => {
    const collector = createSummaryCollector()

    for (let i = 0; i < IMPORT_DETAIL_CAP + 1; i++) {
      collector.file(`note-${i}.md`, 'markdown')
    }
    // The member past the cap is imported, skipped AND registered again; it is
    // still exactly ONE file missing from the sample.
    collector.imported(`note-${IMPORT_DETAIL_CAP}.md`)
    collector.skipped(`note-${IMPORT_DETAIL_CAP}.md`)
    collector.file(`note-${IMPORT_DETAIL_CAP}.md`, 'markdown')

    expect(collector.snapshot().filesOmitted).toBe(1)
  })

  it('caps per-note errors and reports the excess', () => {
    const collector = createSummaryCollector()

    for (let i = 0; i < IMPORT_DETAIL_CAP + 7; i++) {
      collector.failed(`Note ${i}`, 'boom')
    }
    const summary = collector.snapshot()

    expect(summary.failed).toBe(IMPORT_DETAIL_CAP + 7)
    expect(summary.errors).toHaveLength(IMPORT_DETAIL_CAP)
    expect(summary.errorsOmitted).toBe(7)
  })

  // A warning is the FIRST thing the cap throws away: `files` fills in archive
  // order, so 200 ordinary members spend the whole sample before the one member
  // that lost its links is ever reached, and the row its warning would go on is
  // never built. The counter is the half that does not depend on being lucky.
  it('counts every repoint refusal, including the ones past the sample', () => {
    const collector = createSummaryCollector()
    const members = IMPORT_DETAIL_CAP + 3

    for (let i = 0; i < members; i++) {
      const warned = i >= IMPORT_DETAIL_CAP

      collector.file(`note-${i}.md`, 'markdown', warned ? ['links were left at the source'] : [])
      if (warned) {
        collector.repointFailed()
      }
      collector.imported(`note-${i}.md`, `id-${i}`)
    }
    const summary = collector.snapshot()

    // Not one of the three warnings survived the cap — this is the finding, stated
    // as an assertion rather than as a hope.
    expect(summary.files.flatMap((file) => file.warnings)).toEqual([])
    expect(summary.repointFailed).toBe(3)
    expect(summary.imported).toBe(members)
  })

  it('omits the optional counters entirely when nothing was dropped', () => {
    const collector = createSummaryCollector()

    collector.file('a.md', 'markdown')
    collector.imported('a.md', 'id-a')
    const summary = collector.snapshot()

    expect(summary).not.toHaveProperty('filesOmitted')
    expect(summary).not.toHaveProperty('errorsOmitted')
    expect(summary).not.toHaveProperty('ignored')
    // Absent rather than 0: an import that proved every repoint produces the exact
    // result it produced before the field existed.
    expect(summary).not.toHaveProperty('repointFailed')
  })

  it('is safe to snapshot mid-run — a terminal failure reports the work done', () => {
    const collector = createSummaryCollector()

    collector.file('a.md', 'markdown')
    collector.imported('a.md', 'id-a')
    const partial = collector.snapshot()

    collector.file('b.md', 'markdown')
    collector.imported('b.md', 'id-b')

    // The earlier snapshot is a value, not a live view of the collector.
    expect(partial.imported).toBe(1)
    expect(partial.files).toHaveLength(1)
    expect(collector.snapshot().imported).toBe(2)
  })

  // "A value" has to mean the ROWS too. A spread of the map handed out the
  // collector's own live counters, so a later note edited a result already given
  // to a caller as the record of an earlier moment — invisible today only because
  // exactly one snapshot is ever kept.
  it('freezes the per-file rows of a snapshot, not just the array holding them', () => {
    const collector = createSummaryCollector()

    collector.file('a.md', 'markdown', ['one warning'])
    collector.imported('a.md', 'id-a')
    const partial = collector.snapshot()

    collector.imported('a.md', 'id-a2')
    collector.skipped('a.md')
    collector.file('a.md', 'markdown', ['a later warning'])

    expect(partial.files[0]).toEqual({
      file: 'a.md',
      format: 'markdown',
      imported: 1,
      skipped: 0,
      warnings: ['one warning'],
    })
  })

  // `ignored` is the one part of a summary the collector does not build: the tree
  // path hands it straight off the frozen PLAN. Passing it out by reference made
  // the summary a live window onto that plan, writable from either side.
  it('copies the ignored sample instead of sharing the plan’s own object', () => {
    const collector = createSummaryCollector()
    const fromPlan = { count: 2, files: ['logo.png', 'settings.json'] }

    collector.ignored(fromPlan)
    const snapshot = collector.snapshot()

    expect(snapshot.ignored).toEqual(fromPlan)
    expect(snapshot.ignored).not.toBe(fromPlan)
    expect(snapshot.ignored!.files).not.toBe(fromPlan.files)
    snapshot.ignored!.files.push('written through the summary')
    expect(fromPlan.files).toEqual(['logo.png', 'settings.json'])
  })
})
