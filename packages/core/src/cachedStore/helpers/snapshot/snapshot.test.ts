import { describe, expect, it, vi } from 'vitest'

import type { NoteMeta } from '../../../knowledgeStore'
import { resolveLink } from '../../../referenceResolver'
import { Snapshot } from './snapshot'

describe('Snapshot hidden-class edge derivation', () => {
  it('drops stale hidden-source edges without building the user-corpus link index', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.notes.set('doc', {
      id: 'doc',
      title: 'Document',
      class: 'user-doc',
      filePath: 'document.md',
      modifiedAt: null,
      createdAt: null,
    })
    snapshot.notes.set('memory', {
      id: 'memory',
      title: 'Memory',
      class: 'agent-memory',
      filePath: '.notarium/memory/memory.md',
      modifiedAt: null,
      createdAt: null,
    })
    snapshot.edgesBySource.set('memory', [{ source: 'memory', target: 'doc', type: 'links_to' }])
    const graphVisibleNotes = vi.spyOn(snapshot, 'graphVisibleNotes')

    expect(snapshot.patchNoteEdges('memory', '[[Document]]')).toBe(true)
    expect(snapshot.edgesBySource.has('memory')).toBe(false)
    expect(snapshot.patchNoteEdges('memory', '[[Document]]')).toBe(false)
    expect(graphVisibleNotes).not.toHaveBeenCalled()
  })
})

// The alias set a snapshot meta carries is filtered by the SAME name key the resolver
// and the alias history use. On the bare slug a letterless past name and a letterless
// current title both key on '', so the filter dropped the retired name entirely — the
// note's `aliases` came back empty and every inbound `[[🎉🎉]]` re-ghosted after the
// next boot or trash restore (#296).
describe('Snapshot.aliasesFor keeps a letterless retired name', () => {
  it('retires a past name whose slug is empty instead of dropping it', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['🎉🎉'])

    expect(snapshot.aliasesFor('n', undefined, '✨✨')).toEqual(['🎉🎉'])
  })

  it('still drops a past name that IS the current title', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['🎉🎉'])

    // A→B→A leaves no stale self-alias, letterless or not.
    expect(snapshot.aliasesFor('n', undefined, '🎉🎉')).toBeUndefined()
  })

  it('treats one glyph in its two spellings as one name', () => {
    const snapshot = new Snapshot('links_to')
    snapshot.pastNames.set('n', ['❤️'])

    // `❤️` (with VS16) and `❤` are the same name — the retired form must not survive
    // as an alias of the title it already equals.
    expect(snapshot.aliasesFor('n', undefined, '❤')).toBeUndefined()
  })
})

// The resolve table is memoized so that one write costs its own path instead of
// the whole corpus (#302). The trade is that the key must cover EVERY input the
// table is built from: a missed input does not make a read slow, it makes it
// wrong — the write claims the note the link used to reach, and a ghost keeps
// offering a folder that has since moved. One input moves per test.
describe('Snapshot resolve-table memoization', () => {
  const setup = () => {
    const folders = { paths: [] as string[], version: 0 }
    const snap = new Snapshot(
      'links_to',
      () => folders.paths,
      () => folders.version,
    )

    const note = (id: string, filePath: string, title: string, extra?: Partial<NoteMeta>) => {
      snap.notes.set(id, {
        id,
        title,
        class: 'user-doc',
        filePath,
        modifiedAt: null,
        createdAt: null,
        ...extra,
      })
    }

    // What the directory channel does on a folder mutation: publish the new set
    // and report that it moved. The callback returns a fresh array every time, so
    // the counter is the only thing the table can compare.
    const setFolders = (paths: string[]) => {
      folders.paths = paths
      folders.version++
    }

    return { snap, note, setFolders }
  }

  it('sees a note that appeared since the last table', () => {
    const { snap, note } = setup()

    note('src', 'src.md', 'Source')
    expect(snap.resolvedTargetIds('[[Target]]')).toEqual([])

    note('t', 'target.md', 'Target')
    expect(snap.resolvedTargetIds('[[Target]]')).toEqual(['t'])
  })

  it('sees a folder that appeared since the last table', () => {
    const { snap, note, setFolders } = setup()

    note('src', 'docs/src.md', 'Source')
    // No `Empty` in the inventory: the ghost can only offer the spelling it was
    // asked for.
    expect(resolveLink('empty/New', snap.buildIndex()).ghost).toMatchObject({
      prefillDirectory: 'empty',
    })

    setFolders(['Empty'])
    // An empty folder is invisible to the note inventory, so this input reaches
    // the table only through the directory channel.
    expect(resolveLink('empty/New', snap.buildIndex()).ghost).toMatchObject({
      prefillDirectory: 'Empty',
    })
  })

  it('sees a folder path-alias that arrived since the last table', () => {
    const { snap, note } = setup()

    note('archived', 'archive/plan.md', 'Plan')
    note('n', 'docs/plan.md', 'Plan')
    // Without the history the path form misses and the bare last segment lands on
    // the OTHER `Plan`. A stale table here is not a missing edge, it is an edge
    // into the wrong note.
    expect(snap.resolvedTargetIds('[[old/plan]]')).toEqual(['archived'])

    // The server registry answers asynchronously, so this list lands AFTER the
    // rename already moved the notes and the folder set — by then both of the
    // other counters have stopped moving, and only the list's own identity says
    // `[[oldpath/note]]` can heal now.
    snap.folderAliases = [{ current: 'docs', alias: 'old' }]
    expect(snap.resolvedTargetIds('[[old/plan]]')).toEqual(['n'])
  })

  it('sees a past title the journal backfilled after the last table', () => {
    const { snap, note } = setup()

    note('n', 'note.md', 'Note')
    expect(snap.resolvedTargetIds('[[Older Note]]')).toEqual([])

    // `reloadHistoricalNames`, in the two steps the read-model performs: the
    // journal's past titles land in `pastNames`, and every meta they touch is
    // re-merged through `aliasesFor`. The history is NOT a table input on its own —
    // it reaches the table as an alias ON THE META, and that re-set is what the
    // memo key must (and does) see. Keying on the history itself instead would drop
    // the table on a reload that renamed nothing, and would still be relying on the
    // re-merge for the case that matters.
    snap.pastNames = new Map([['n', ['Older Note']]])
    for (const [id, meta] of [...snap.notes]) {
      snap.notes.set(id, { ...meta, aliases: snap.aliasesFor(id, meta.aliases, meta.title) })
    }

    expect(snap.resolvedTargetIds('[[Older Note]]')).toEqual(['n'])
  })
})

// The batch table is the write path's half of the same bargain the deferred ghost
// pass makes: while an import bracket is open, one table serves every write in it.
// It may therefore be BEHIND — by additions, which ghost, and by renames, which
// answer with the wrong LIVE note; the bracket's close re-derives every source
// against a fresh table, which repairs both. What it may never be behind by is a
// note leaving the graph — a dead or hidden id is not an answer a reader may be
// handed at all, so that rebuilds here and now.
describe('Snapshot batch resolve-table', () => {
  const setup = () => {
    const folders = { paths: [] as string[], version: 0 }
    const snap = new Snapshot(
      'links_to',
      () => folders.paths,
      () => folders.version,
    )

    const note = (id: string, filePath: string, title: string, extra?: Partial<NoteMeta>) => {
      snap.notes.set(id, {
        id,
        title,
        class: 'user-doc',
        filePath,
        modifiedAt: null,
        createdAt: null,
        ...extra,
      })
    }

    return { folders, snap, note }
  }

  it('serves one table across the batch it is added to', () => {
    const { snap, note } = setup()

    note('src', 'src.md', 'Source')
    const table = snap.batchIndex()

    note('t', 'target.md', 'Target')
    // The same table, so the batch pays for it once — and a link to the note the
    // batch itself just added ghosts, which is exactly what the deferred pass at the
    // close re-resolves.
    expect(snap.batchIndex()).toBe(table)
    expect(snap.resolvedTargetIds('[[Target]]', snap.batchIndex())).toEqual([])
    expect(snap.resolvedTargetIds('[[Target]]')).toEqual(['t'])
  })

  it('keeps serving it across a re-write that renames nothing', () => {
    const { snap, note } = setup()

    note('n', 'note.md', 'Note')
    const table = snap.batchIndex()

    // An import overwriting a note it already imported: new body, new stamp, same
    // name — nothing the table reads has moved.
    note('n', 'note.md', 'Note', { modifiedAt: '2026-08-14T00:00:00.000Z' })
    expect(snap.batchIndex()).toBe(table)
  })

  it('keeps serving it across a rename, and is behind by exactly that rename', () => {
    // Renaming per write is the shape of a REPEATED import: the archive lands on
    // the same paths and the titles changed. Rebuilding for each would pay the
    // corpus per write — the same quadratic the batch exists to avoid, reached
    // through the other door — so the table rides it, and the close repairs it.
    // The basename is deliberately not the title's, so the stale answer is the
    // TITLE key rather than a filename axis that never moved.
    const { snap, note } = setup()

    note('n', 'kept.md', 'Note')
    const table = snap.batchIndex()

    note('n', 'kept.md', 'Renamed')
    const next = snap.batchIndex()

    expect(next).toBe(table)
    // Stale in both directions — and BOTH answers name a live note, which is what
    // makes re-deriving the sources at the close a repair rather than a guess.
    expect(snap.resolvedTargetIds('[[Note]]', next)).toEqual(['n'])
    expect(snap.resolvedTargetIds('[[Renamed]]', next)).toEqual([])
    // The exact table — the one the close builds — has the rename.
    expect(snap.resolvedTargetIds('[[Renamed]]')).toEqual(['n'])
    expect(snap.resolvedTargetIds('[[Note]]')).toEqual([])
  })

  it('serves it across an addition that TAKES a name from the note holding it', () => {
    // The asymmetry the bound turns on: pass 1 (current names) ranks strictly above
    // pass 2 (aliases), so an addition is not a tie-break — it can hand a key to
    // the new note outright. Until the close this table still answers with the note
    // that has only the alias, and that is a live note under a name it no longer
    // holds, not a ghost the deferred pass would notice.
    const { snap, note } = setup()

    note('retired', 'retired.md', 'Retired Plan', { aliases: ['Plan'] })
    const table = snap.batchIndex()

    note('fresh', 'fresh.md', 'Plan')
    expect(snap.batchIndex()).toBe(table)
    expect(snap.resolvedTargetIds('[[Plan]]', table)).toEqual(['retired'])
    // What the close's fresh table says, and what the re-derived sources will get.
    expect(snap.resolvedTargetIds('[[Plan]]')).toEqual(['fresh'])
  })

  it('rebuilds rather than name a note that is gone', () => {
    const { snap, note } = setup()

    note('n', 'note.md', 'Note')
    const table = snap.batchIndex()

    snap.notes.delete('n')
    const next = snap.batchIndex()

    expect(next).not.toBe(table)
    expect(snap.resolvedTargetIds('[[Note]]', next)).toEqual([])
  })

  it('rebuilds rather than name a note that left the user graph', () => {
    const { snap, note } = setup()

    note('n', 'note.md', 'Note')
    const table = snap.batchIndex()

    // A class change removes the note from the table's own input set. Not a
    // rename the close could repair: until it did, the table would offer a HIDDEN
    // note as a link target, and an agent-memory note is not a user-graph answer
    // for one write, let alone a bracket.
    note('n', 'note.md', 'Note', { class: 'agent-memory' })
    expect(snap.batchIndex()).not.toBe(table)
    expect(snap.resolvedTargetIds('[[Note]]', snap.batchIndex())).toEqual([])
  })

  it('rides a new folder when no path history can retarget a name', () => {
    const { folders, snap, note } = setup()

    note('n', 'note.md', 'Note')
    const table = snap.batchIndex()

    folders.paths.push('new-folder')
    folders.version++
    expect(snap.batchIndex()).toBe(table)
  })

  it('rebuilds on the same folder change when path history can retarget a name', () => {
    const { folders, snap, note } = setup()

    note('n', 'note.md', 'Note')
    snap.folderAliases = [{ current: 'new-folder', alias: 'old-folder' }]
    const table = snap.batchIndex()

    folders.paths.push('new-folder')
    folders.version++
    expect(snap.batchIndex()).not.toBe(table)
  })
})

// The write path asks "who lives at this path" on every write; the snapshot answers
// from its own reverse index. What it answers must not depend on that index being a
// second source of truth — it tracks the map it lives in, move for move.
describe('Snapshot notes path index', () => {
  const meta = (id: string, filePath: string): NoteMeta => ({
    id,
    title: id,
    class: 'user-doc',
    filePath,
    modifiedAt: null,
    createdAt: null,
  })

  it('tracks arrivals, moves, displacement and departures', () => {
    const notes = new Snapshot('links_to').notes

    expect(notes.idsAt('a.md')).toEqual([])

    notes.set('n', meta('n', 'a.md'))
    expect(notes.idsAt('a.md')).toEqual(['n'])

    // A move: the old path stops answering, the new one starts.
    notes.set('n', meta('n', 'b/a.md'))
    expect(notes.idsAt('a.md')).toEqual([])
    expect(notes.idsAt('b/a.md')).toEqual(['n'])

    // Two ids on one path — what a delta or a displacing write leaves mid-flight.
    // Both are reported, in the order they BOUND to this path: 'n' moved here
    // first, so it answers first, even though the map itself still holds it in its
    // own original slot.
    notes.set('other', meta('other', 'b/a.md'))
    expect(notes.idsAt('b/a.md')).toEqual(['n', 'other'])

    notes.delete('n')
    expect(notes.idsAt('b/a.md')).toEqual(['other'])

    notes.clear()
    expect(notes.idsAt('b/a.md')).toEqual([])
  })
})
