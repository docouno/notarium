// @vitest-environment jsdom

import { act, createContext, createElement, StrictMode, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseViewDocument } from '@notarium/core'

import { MarkdownDocument } from './MarkdownDocument'

const Value = createContext('missing')

const carrier = (name: string) =>
  `\`\`\`nota\nversion: 1\nsource: { kind: notes }\nviews: [{ name: ${name}, type: stub }]\n\`\`\``

const Reader = ({ occurrence }: { occurrence: number }) =>
  createElement('span', { 'data-testid': `portal-${occurrence}` }, useContext(Value))

describe('MarkdownDocument', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('mounts strict-mode portals in the existing React provider tree', async () => {
    const parsed = parseViewDocument(`${carrier('One')}\n\n${carrier('Two')}`)
    const html =
      '<p>Before</p><div data-notarium-view-block="0"></div><div data-notarium-view-block="1"></div>'

    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            Value.Provider,
            { value: 'provider-value' },
            createElement(MarkdownDocument, {
              html,
              viewBlocks: parsed.blocks,
              renderViewBlock: (block) => createElement(Reader, { occurrence: block.occurrence }),
            }),
          ),
        ),
      ),
    )

    expect(host.querySelector('[data-testid="portal-0"]')?.textContent).toBe('provider-value')
    expect(host.querySelector('[data-testid="portal-1"]')?.textContent).toBe('provider-value')
    expect(host.querySelectorAll('[data-notarium-view-block]')).toHaveLength(2)
  })

  it('unmounts portals when a new HTML document replaces their hosts', async () => {
    const first = parseViewDocument(carrier('One'))

    await act(async () =>
      root.render(
        createElement(MarkdownDocument, {
          html: '<div data-notarium-view-block="0"></div>',
          viewBlocks: first.blocks,
          renderViewBlock: (block) => createElement(Reader, { occurrence: block.occurrence }),
        }),
      ),
    )
    expect(host.querySelector('[data-testid="portal-0"]')).not.toBeNull()

    await act(async () =>
      root.render(
        createElement(MarkdownDocument, {
          html: '<p>Plain replacement</p>',
          viewBlocks: [],
        }),
      ),
    )

    expect(host.querySelector('[data-testid="portal-0"]')).toBeNull()
    expect(host.textContent).toBe('Plain replacement')
  })
})
