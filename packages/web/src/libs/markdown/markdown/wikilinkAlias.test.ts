// @vitest-environment jsdom

import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { encodeWikilinkAlias, encodeWikilinkIdentity } from '@notarium/core'

import './markdown'

describe('identity wikilink aliases', () => {
  it.each(['[MCP] Review', '&[MCP] <Review>'])(
    'renders encoded title %s as one exact stable-target anchor',
    (title) => {
      const target = encodeWikilinkIdentity('physical-target-id')
      const source = `[[${target}|${encodeWikilinkAlias(title)}]]`
      const host = document.createElement('div')

      host.innerHTML = marked.parse(source) as string
      const anchors = host.querySelectorAll('a')

      expect(anchors).toHaveLength(1)
      expect(anchors[0].textContent).toBe(title)
      expect(anchors[0].children).toHaveLength(0)
      expect(anchors[0].getAttribute('href')).toBe(`#wiki/${encodeURIComponent(target)}`)
    },
  )
})
