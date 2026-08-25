import { describe, expect, it, vi } from 'vitest'

import type { NoteMeta } from '../../../knowledgeStore'
import { estimateTokens } from '../../../libs/markdown'
import { NoteFactsCache } from './noteFactsCache'

const meta = (title = 'Fallback'): NoteMeta => ({
  id: 'n',
  title,
  class: 'agent-memory',
  filePath: '.notarium/memory/n.md',
  modifiedAt: null,
  createdAt: null,
})

describe('NoteFactsCache', () => {
  it('derives the same projected title/body/frontmatter semantics as read()', () => {
    const row = meta()
    const cache = new NoteFactsCache({ getMeta: () => row })
    const raw = [
      '---',
      'summary: Short summary',
      'muted: true',
      '---',
      '# Projected title ###',
      '',
      'Body with [[Link]] and **markup**.',
    ].join('\n')

    expect(cache.setFromRaw('n', raw)).toBe(true)
    expect(cache.get('n')).toEqual({
      title: 'Projected title',
      summary: 'Short summary',
      snippet: 'Body with Link and markup.',
      muted: true,
      bodyTokens: estimateTokens('Body with [[Link]] and **markup**.'),
    })
  })

  it.each([' # Indented', '  # Indented', '   # Indented'])(
    'honours CommonMark title projection for %j',
    (heading) => {
      const cache = new NoteFactsCache({ getMeta: () => meta() })

      cache.setFromRaw('n', `${heading}\n\nBody`)
      expect(cache.get('n')?.title).toBe('Indented')
    },
  )

  it('falls back to the file basename when duplicate authored titles are ambiguous', () => {
    const row = { ...meta('Last title'), filePath: '.notarium/memory/from-path.md' }
    const cache = new NoteFactsCache({ getMeta: () => row })

    cache.setFromRaw(
      'n',
      ['---', 'title: First title', 'title: Last title', '---', 'Body'].join('\n'),
    )
    expect(cache.get('n')?.title).toBe('from-path')
  })

  it('reads a cold file once, invalidates explicitly, and rekeys atomically', async () => {
    const rows = new Map([['n', meta()]])
    const readBody = vi.fn(async () => '# First\n\nBody')
    const cache = new NoteFactsCache({ readBody, getMeta: (id) => rows.get(id) })

    await expect(cache.fromFile('n')).resolves.toMatchObject({ title: 'First' })
    await cache.fromFile('n')
    expect(readBody).toHaveBeenCalledOnce()

    cache.rekey('n', 'next')
    expect(cache.get('n')).toBeUndefined()
    expect(cache.get('next')).toMatchObject({ title: 'First' })

    cache.delete('next')
    expect(cache.get('next')).toBeUndefined()
  })
})
