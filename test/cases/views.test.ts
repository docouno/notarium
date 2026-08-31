import { describe, expect, it } from 'vitest'
import { semanticViewContent } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

import { buildCaseWorld } from './build'
import { caseToFixture } from './toFixture'
import type { CaseEvent } from './types'

const creates = (name: string, scale = 1) =>
  buildCaseWorld(name, { scale }).events.filter(
    (event): event is Extract<CaseEvent, { op: 'create' }> => event.op === 'create',
  )

describe('views seed axis', () => {
  it('materializes browser, marker, failure and byte-witness states as ordinary notes', () => {
    const notes = creates('views')
    const byPath = new Map(notes.map((note) => [note.path, note]))

    expect(byPath.get('project/boards/sprint.md')?.content).toContain('unknown-reader')
    expect(byPath.get('project/boards/sprint.md')?.content).toContain('["vtask0000001","a0"]')
    expect(byPath.get('project/boards/team.md')?.content).toContain('["vtask0000002","a0"]')
    expect(byPath.get('project/boards/resource-limit.md')?.content).toContain('View 65')
    expect(byPath.get('project/states/oversize.md')?.content.length).toBeGreaterThan(1024 * 1024)
    expect(byPath.get('project/states/anchor.md')?.content).toContain('&source')
    expect(byPath.get('project/states/duplicate-key.md')?.content).toContain(
      'name: First, name: Second',
    )
    expect(byPath.get('project/states/marker-mismatch.md')?.frontmatter).toContain('view: table')
    expect(semanticViewContent(byPath.get('project/boards/sprint.md')!.content)).toContain(
      'aurora-view-prose',
    )
    expect(
      semanticViewContent(byPath.get('project/states/crlf-witness.md')!.content),
    ).not.toContain('nebula-config-only')
    expect(buildCaseWorld('views').externalSources).toHaveLength(4)
  })

  it('keeps the 50-document scale shape and a rankless tail under a reduced test scale', () => {
    const notes = creates('views-scale', 0.001)
    const boards = notes.filter((note) => note.path.startsWith('boards/'))
    const tasks = notes.filter((note) => note.path.startsWith('tasks/'))
    const ranks = boards[0]!.content.match(/^\s+\["vt\d+","[^"]+"\]$/gmu) ?? []

    expect(boards).toHaveLength(50)
    expect(tasks).toHaveLength(10)
    expect(ranks.length).toBeLessThan(tasks.length)
    expect(ranks.length).toBeGreaterThan(0)
  })

  it('projects marker match/mismatch/missing/stale states onto the fake stand', async () => {
    const fixture = caseToFixture(buildCaseWorld('views'))
    const space = fixture.spaces.find((candidate) => candidate.slug === 'views-lab')

    if (!space) {
      throw new Error('views-lab fixture is missing')
    }
    const rows = await new InMemoryStore({ space: 'views-lab', notes: space.notes }).list()
    const marker = (path: string) => rows.find((row) => row.filePath === path)?.viewType

    expect(marker('project/boards/sprint.md')).toBe('board')
    expect(marker('project/states/marker-mismatch.md')).toBe('table')
    expect(marker('project/states/marker-missing.md')).toBeUndefined()
    expect(marker('project/states/stale-marker.md')).toBe('board')
  })
})
