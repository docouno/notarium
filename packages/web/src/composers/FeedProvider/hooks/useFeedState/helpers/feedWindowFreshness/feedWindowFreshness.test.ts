import { describe, expect, it } from 'vitest'

import type { NoteView } from '../../../../../../libs/wire'
import {
  feedPagesToRefresh,
  filterRemovedFeedRows,
  invalidatedFeedPages,
  isCurrentFeedWindow,
} from './feedWindowFreshness'

const note = (id: string): NoteView => ({
  id,
  title: id,
  class: 'user-doc',
  filePath: `${id}.md`,
  modifiedAt: null,
  createdAt: null,
})

describe('feed window freshness', () => {
  it('rejects a response started before a changed-event revision', () => {
    expect(isCurrentFeedWindow({ queryKey: 'same', revision: 1 }, 'same', 2)).toBe(false)
  })

  it('restarts the first in-flight page when changed lands before any page is held', () => {
    const request = { queryKey: 'same', revision: 1 }
    const pending = invalidatedFeedPages(new Map(), new Set([0]))
    const calls: number[] = []

    for (const page of feedPagesToRefresh(pending, new Map())) {
      calls.push(page)
    }

    expect(isCurrentFeedWindow(request, 'same', 2)).toBe(false)
    expect(calls).toEqual([0])
  })

  it('keeps page zero as the liveness floor when no request or page survived', () => {
    expect([...invalidatedFeedPages(new Map(), new Set())]).toEqual([0])
  })

  it('removes deleted rows from already-rendered pages', () => {
    const pages = filterRemovedFeedRows(new Map([[0, [note('P'), note('D')]]]), ['P'])

    expect(pages.get(0)?.map((row) => row.id)).toEqual(['D'])
  })
})
