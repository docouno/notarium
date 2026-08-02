import { describe, expect, it } from 'vitest'

import { buildCasesWorld, buildCaseWorld, mergeWorlds } from './build'
import type { CaseEvent, CaseWorld } from './types'

// The favorites seed case (#42/#245) + the mergeWorlds carry. Guards the seed MODEL
// (the applier's folder-identity mint is verified live via `make seed CASE=favorites`,
// but the declaration + combine path is pure and cheap to pin here). Regression guard
// for "mergeWorlds silently drops favorites when cases are combined".

const createIds = (events: CaseEvent[]) =>
  new Set(events.filter((e) => e.op === 'create').map((e) => e.noteId))

describe('favorites seed case (#42/#245)', () => {
  it('declares the intended stars: two notes in different folders, a folder, a project', () => {
    const w = buildCaseWorld('favorites')
    const favs = w.favorites ?? []
    expect(favs.length).toBe(4)

    const notes = favs.filter((f) => f.kind === 'note')
    const folders = favs.filter((f) => f.kind === 'folder')
    const projects = favs.filter((f) => f.kind === 'project')
    expect(notes.length).toBe(2)
    expect(folders.map((f) => f.ref)).toEqual(['research'])
    expect(projects.map((f) => f.ref)).toEqual(['Roadmap'])

    // Every note star must reference a note the case actually creates, else the real
    // applier throws ("favorite references unknown note").
    const ids = createIds(w.events)

    for (const n of notes) {
      expect(ids.has(n.ref)).toBe(true)
    }

    // The starred FOLDER holds a note (else the applier's folder guard rejects it) and
    // the starred PROJECT path is a marked project in the world.
    expect(w.events.some((e) => e.op === 'create' && e.path.startsWith('research/'))).toBe(true)
    expect((w.projects ?? []).some((p) => p.path === 'Roadmap')).toBe(true)
  })

  it('mergeWorlds carries favorites and namespaces NOTE refs (folder/project paths pass through)', () => {
    const merged = buildCasesWorld('favorites,folder-page')
    const favs = merged.favorites ?? []
    // All four favorites survive the combine (the dropped-on-merge bug).
    expect(favs.length).toBe(4)

    // Note refs are namespaced to the case (so they still resolve after the id remap);
    // folder/project refs are paths and pass through unchanged.
    const ids = createIds(merged.events)

    for (const f of favs) {
      if (f.kind === 'note') {
        expect(f.ref.startsWith('favorites:')).toBe(true)
        expect(ids.has(f.ref)).toBe(true) // matches a namespaced create event
      } else {
        expect(f.ref).not.toContain(':') // a plain path, untouched
      }
    }
  })

  it('mergeWorlds dedups a folder/project starred by TWO cases, but keeps distinct note refs', () => {
    const world = (favorites: CaseWorld['favorites']): CaseWorld => ({
      now: '2026-07-01T12:00:00.000Z',
      spaces: [{ slug: 'main' }],
      events: [],
      favorites,
    })
    const merged = mergeWorlds([
      {
        name: 'a',
        world: world([
          { space: 'main', kind: 'folder', ref: 'research' },
          { space: 'main', kind: 'project', ref: 'Roadmap' },
          { space: 'main', kind: 'note', ref: 'n-1' },
        ]),
      },
      {
        name: 'b',
        world: world([
          { space: 'main', kind: 'folder', ref: 'research' }, // same folder path → dedup
          { space: 'main', kind: 'project', ref: 'Roadmap' }, // same project path → dedup
          { space: 'main', kind: 'note', ref: 'n-1' }, // same LOGICAL id, different case → distinct
        ]),
      },
    ])
    const favs = merged.favorites ?? []
    // folder + project collapse to one each (idempotent per space+kind+path); the two
    // note stars stay distinct because their refs are namespaced per case.
    expect(favs.filter((f) => f.kind === 'folder')).toEqual([
      { space: 'main', kind: 'folder', ref: 'research' },
    ])
    expect(favs.filter((f) => f.kind === 'project')).toEqual([
      { space: 'main', kind: 'project', ref: 'Roadmap' },
    ])
    expect(
      favs
        .filter((f) => f.kind === 'note')
        .map((f) => f.ref)
        .sort(),
    ).toEqual(['a:n-1', 'b:n-1'])
  })
})
