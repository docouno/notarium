import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ providers: false }))

vi.mock('../../composers/AuthProvider', () => ({
  useAuth: () => ({ mode: 'none', me: null }),
}))
vi.mock('../../composers/SpaceProvider', () => ({
  useSpace: () => ({ capabilities: { providers: harness.providers } }),
}))
vi.mock('../../layouts/SettingsLayout', () => ({
  SettingsLayout: ({ groups }: { groups: Array<Array<{ id: string }>> }) =>
    createElement(
      'div',
      null,
      groups.flat().map((tab) => createElement('span', { key: tab.id }, tab.id)),
    ),
}))

import { SettingsPage } from './SettingsPage'

describe('provider settings tabs', () => {
  beforeEach(() => {
    harness.providers = false
  })

  it('hides both tabs when /api/config says providers are off', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage))

    expect(html).not.toContain('credentials')
    expect(html).not.toContain('providers')
  })

  it('shows both tabs from the SpaceProvider capability even in mode none', () => {
    harness.providers = true
    const html = renderToStaticMarkup(createElement(SettingsPage))

    expect(html).toContain('credentials')
    expect(html).toContain('providers')
  })
})
