// @vitest-environment jsdom

import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { encodeWikilinkAlias, encodeWikilinkIdentity } from '@notarium/core'
import { effectiveSlug } from '@notarium/core/slug'

import '../../libs/markdown/markdown/markdown'
import { wikiLinkTarget } from '../../libs/markdown/markdown'
import { noteRouteForClass } from '../../libs/routing/routePaths'
import type { NoteView } from '../../libs/wire'
import { resolveKnownWiki } from './resolveKnownWiki'

const note = (id: string, filePath: string, title: string): NoteView => ({
  id,
  filePath,
  title,
  class: 'user-doc',
  modifiedAt: null,
  createdAt: null,
})

describe('resolveKnownWiki', () => {
  const known = [note('known-id', 'later/Same.md', 'Same')]

  it('does not finalize a human-name winner from a partial inventory', () => {
    // An unseen `earlier/same.md` can win the server's deterministic collision.
    expect(resolveKnownWiki('Same', known)).toBeNull()
  })

  it('finalizes only stable identity hits', () => {
    expect(resolveKnownWiki('known-id', known)).toBe(known[0])
    expect(resolveKnownWiki(encodeWikilinkIdentity('known-id'), known)).toBe(known[0])
    expect(resolveKnownWiki('later/Same.md', known)).toBeNull()
  })

  it('routes a rendered bracket alias to the selected stable identity, not its namesake', () => {
    const selected = note('physical-target-id', 'selected.md', '[MCP] Review')
    const namesake = note('decoy-id', 'decoy.md', '[MCP] Review')
    const target = encodeWikilinkIdentity(selected.id)
    const host = document.createElement('div')

    host.innerHTML = marked.parse(`[[${target}|${encodeWikilinkAlias(selected.title)}]]`) as string
    const decoded = wikiLinkTarget(host.querySelector('a')?.getAttribute('href'))
    const match = resolveKnownWiki(decoded ?? '', [namesake, selected])

    expect(decoded).toBe(target)
    expect(match).toBe(selected)
    expect(
      noteRouteForClass(match?.id, match?.class, effectiveSlug(match?.slug, match?.title ?? '')),
    ).toBe('/n/physical-target-id/mcp-review')
  })

  it('does not let a visible exact path outrank a potentially unseen plain id', () => {
    const visiblePath = note('path-note', 'Foo.md', 'Path note')

    // A server-only note with id `Foo` would win the id-first resolver. A partial
    // client cannot prove that no such note exists, so it must not take this path.
    expect(resolveKnownWiki('Foo', [visiblePath])).toBeNull()
  })

  it.each(['agent-memory', 'profile'] as const)(
    'never resolves a known %s identity on the user graph',
    (noteClass) => {
      const hidden = { ...note('hidden-id', 'hidden.md', 'Hidden'), class: noteClass }

      expect(resolveKnownWiki('hidden-id', [hidden])).toBeNull()
      expect(resolveKnownWiki(encodeWikilinkIdentity('hidden-id'), [hidden])).toBeNull()
    },
  )
})
