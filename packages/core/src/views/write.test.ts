import { describe, expect, it } from 'vitest'
import { isScalar } from 'yaml'

import { parseViewDocument } from './parse'
import { boardReaderDefinition } from './readers/board'
import { compileReaderView, createReaderRegistry } from './registry'
import { patchViewConfig, putViewRank, replaceViewRanks, ViewWriteError } from './write'

const content = (ranks = '["task-a","a0V"]\n          ["task-b","a1V"]') =>
  [
    'Prose before.',
    '',
    '```nota',
    'version: 1',
    '# root comment',
    'source:',
    '  kind: notes',
    '  scope: project',
    '  foreign: keep-me',
    'views:',
    '  - name: Board',
    '    type: board',
    '    foreignCommon: keep-me-too',
    '    options:',
    '      groupBy: note.status',
    '      foreignOption: keep-option',
    '      order:',
    '        kind: manual',
    '        ranks: |-',
    `          ${ranks}`,
    '```',
    '',
    'Prose after.',
  ].join('\n')

const parsed = (body: string) =>
  parseViewDocument(body, { documentId: 'view-note', versionToken: 'v1:body' })

const readerRegistry = createReaderRegistry([boardReaderDefinition])

const expectBoardReady = (body: string) => {
  const projection = parsed(body)
  const view = projection.views[0]

  expect(view).toBeDefined()
  expect(compileReaderView(readerRegistry, view!.definition)).toMatchObject({ status: 'ready' })

  return projection
}

const rankValue = (body: string): string => {
  const node = parsed(body).blocks[0]?.yamlDocument?.getIn(
    ['views', 0, 'options', 'order', 'ranks'],
    true,
  )

  expect(isScalar(node) && typeof node.value === 'string').toBe(true)
  return isScalar(node) && typeof node.value === 'string' ? node.value : ''
}

describe('patchViewConfig', () => {
  it('patches one payload while preserving prose, comments and unknown keys', () => {
    const before = content()
    const projection = parsed(before)
    const result = patchViewConfig(before, projection, projection.views[0]!.viewRef!, {
      source: { set: { scope: 'space' } },
      common: { set: { limit: 42 } },
      options: { set: { groupBy: 'note.stage' } },
    })

    expect(result.content.startsWith('Prose before.\n\n```nota\n')).toBe(true)
    expect(result.content.endsWith('```\n\nProse after.')).toBe(true)
    expect(result.content).toContain('# root comment')
    expect(result.content).toContain('foreign: keep-me')
    expect(result.content).toContain('foreignCommon: keep-me-too')
    expect(result.content).toContain('foreignOption: keep-option')
    expect(result.content).toContain('scope: space')
    expect(result.content).toContain('groupBy: note.stage')
    expect(result.viewType).toBe('board')
  })

  it('refuses a stale range witness instead of retargeting by name', () => {
    const before = content()
    const projection = parsed(before)
    const changed = before.replace('foreign: keep-me', 'foreign: changed')

    expect(() =>
      patchViewConfig(changed, projection, projection.views[0]!.viewRef!, {
        options: { set: { groupBy: 'note.stage' } },
      }),
    ).toThrow(ViewWriteError)
  })
})

describe('putViewRank', () => {
  it('changes one JSONL line and leaves semantic content stable', () => {
    const before = content()
    const projection = parsed(before)
    const result = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-a', 'a0Z')
    const beforeLines = before.split('\n')
    const afterLines = result.content.split('\n')

    expect(afterLines).toHaveLength(beforeLines.length)
    expect(afterLines.filter((line, index) => line !== beforeLines[index])).toEqual([
      '          ["task-a","a0Z"]',
    ])
    expect(parsed(result.content).semanticContent).toBe(projection.semanticContent)
  })

  it('adds and removes one rank tuple without touching its neighbours', () => {
    const before = content()
    const projection = parsed(before)
    const added = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-c', 'a2V')

    expect(added.content).toContain('["task-c","a2V"]')
    const addedProjection = parsed(added.content)
    const removed = putViewRank(
      added.content,
      addedProjection,
      addedProjection.views[0]!.viewRef!,
      'task-b',
      null,
    )

    expect(removed.content).not.toContain('["task-b","a1V"]')
    expect(removed.content).toContain('["task-a","a0V"]')
    expect(removed.content).toContain('["task-c","a2V"]')
  })

  it('materializes a one-entry overlay as a writable block scalar', () => {
    const before = content().replace(
      '      order:\n        kind: manual\n        ranks: |-\n          ["task-a","a0V"]\n          ["task-b","a1V"]',
      '      order:\n        kind: manual',
    )
    const projection = parsed(before)
    const first = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-a', 'a0V')
    const reparsed = parsed(first.content)
    const second = putViewRank(
      first.content,
      reparsed,
      reparsed.views[0]!.viewRef!,
      'task-b',
      'a1V',
    )

    expect(first.content).toMatch(/ranks: \|-?\n\s+\["task-a","a0V"\]/u)
    expect(second.content).toContain('["task-b","a1V"]')
  })

  it('creates a complete manual order when the optional order mapping is absent', () => {
    const before = content().replace(
      '      order:\n        kind: manual\n        ranks: |-\n          ["task-a","a0V"]\n          ["task-b","a1V"]',
      '',
    )
    const projection = expectBoardReady(before)
    const first = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-a', 'a0V')
    const firstProjection = expectBoardReady(first.content)
    const second = putViewRank(
      first.content,
      firstProjection,
      firstProjection.views[0]!.viewRef!,
      'task-a',
      'a0Z',
    )

    expect(first.content).toMatch(/order:\n\s+kind: manual\n\s+ranks: \|-\n\s+\["task-a","a0V"\]/u)
    expect(second.content).toContain('["task-a","a0Z"]')
    expectBoardReady(second.content)
  })

  it('canonicalizes flow ancestors and an inline rank while preserving authored siblings', () => {
    const before = [
      'Prose before.',
      '',
      '```nota',
      'version: 1',
      '# root comment survives the structural rewrite',
      'source: { kind: notes, foreignSource: keep-source }',
      'views: [{ name: Board, type: board, foreignView: keep-view, options: { groupBy: note.status, foreignOption: keep-option, order: { kind: manual, foreignOrder: keep-order, ranks: \'["task-a","a0V"]\' } } }]',
      '```',
      '',
      'Prose after.',
    ].join('\n')
    const projection = expectBoardReady(before)
    const removed = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-a', null)
    const first = putViewRank(before, projection, projection.views[0]!.viewRef!, 'task-b', 'a1V')
    const firstProjection = expectBoardReady(first.content)
    const second = putViewRank(
      first.content,
      firstProjection,
      firstProjection.views[0]!.viewRef!,
      'task-a',
      'a0Z',
    )

    expect(first.content).toContain('# root comment survives the structural rewrite')
    expect(first.content).toContain('foreignSource: keep-source')
    expect(first.content).toContain('foreignView: keep-view')
    expect(first.content).toContain('foreignOption: keep-option')
    expect(first.content).toContain('foreignOrder: keep-order')
    expect(rankValue(removed.content)).toBe('')
    expectBoardReady(removed.content)
    expect(first.content).toMatch(/views:\n\s+- name: Board/u)
    expect(first.content).toMatch(/order:\n\s+kind: manual/u)
    expect(first.content).toMatch(/ranks: \|-\n\s+\["task-a","a0V"\]/u)
    expect(rankValue(first.content).split('\n')).toEqual(['["task-a","a0V"]', '["task-b","a1V"]'])
    expect(second.content).toContain('["task-a","a0Z"]')
    expectBoardReady(second.content)
    expect(second.content.startsWith('Prose before.\n\n```nota\n')).toBe(true)
    expect(second.content.endsWith('```\n\nProse after.')).toBe(true)
  })

  it('refuses malformed or duplicate rank tuples', () => {
    const duplicate = content('["task-a","a0V"]\n          ["task-a","a1V"]')
    const projection = parsed(duplicate)

    expect(() =>
      putViewRank(duplicate, projection, projection.views[0]!.viewRef!, 'task-a', 'a2V'),
    ).toThrow('duplicate note id')
  })

  it('rebalances the rank scalar without losing unknown order siblings', () => {
    const before = content()
    const projection = parsed(before)
    const result = replaceViewRanks(
      before,
      projection,
      projection.views[0]!.viewRef!,
      new Map([
        ['task-b', 'a0'],
        ['task-a', 'a1'],
      ]),
    )

    expect(result.content).toContain('["task-b","a0"]')
    expect(result.content).toContain('["task-a","a1"]')
    expect(result.content).toContain('foreignOption: keep-option')
    expect(result.content).toContain('Prose before.')
    expect(result.content).toContain('Prose after.')
  })

  it('materializes and keeps a 10k rebalance writable for a later point update', () => {
    const before = content().replace(
      '      order:\n        kind: manual\n        ranks: |-\n          ["task-a","a0V"]\n          ["task-b","a1V"]',
      '',
    )
    const projection = expectBoardReady(before)
    const entries = new Map(
      Array.from({ length: 10_000 }, (_, index) => [
        `task-${index}`,
        `a${String(index).padStart(5, '0')}`,
      ]),
    )
    const rebalanced = replaceViewRanks(before, projection, projection.views[0]!.viewRef!, entries)
    const rebalancedProjection = expectBoardReady(rebalanced.content)
    const updated = putViewRank(
      rebalanced.content,
      rebalancedProjection,
      rebalancedProjection.views[0]!.viewRef!,
      'task-9999',
      'z-last',
    )

    expect(rebalanced.content).toMatch(/ranks: \|-/u)
    expect(rankValue(rebalanced.content).split('\n')).toHaveLength(10_000)
    expect(rankValue(updated.content).split('\n')).toHaveLength(10_000)
    expect(updated.content).toContain('["task-9999","z-last"]')
    expectBoardReady(updated.content)
  })
})
