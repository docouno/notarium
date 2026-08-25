// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AsidePlaceholder } from './AsidePlaceholder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('the panel a route shows while it has no subject', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (props: Parameters<typeof AsidePlaceholder>[0]) => {
    await act(async () => root.render(createElement(AsidePlaceholder, props)))
    return container.querySelector<HTMLElement>('[data-testid="aside-placeholder"]')!
  }

  it('reserves the shape of the panel while the subject is on its way', async () => {
    const panel = await render({ loading: true })

    // A skeleton, not a sentence: saying "nothing" about a read still in flight is the
    // claim this branch must not make. Two lines, because the box it reserves is a field
    // and its value — counted, since a placeholder has no labels to address.
    expect(panel.textContent).toBe('')
    expect(panel.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2)
  })

  it('states the reason the page gave it once the read is over', async () => {
    const panel = await render({ loading: false, blank: 'This ability didn’t open.' })

    expect(panel.textContent).toBe('This ability didn’t open.')
    expect(panel.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
