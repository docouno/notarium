import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ providers: false }))

vi.mock('../SpaceProvider', () => ({
  useSpace: () => ({ capabilities: { providers: harness.providers }, space: 'main' }),
}))
vi.mock('react-router', () => ({
  Navigate: ({ to }: { to: string }) => createElement('span', { 'data-redirect': to }),
}))

import { ProviderSurfaceGate } from './ProviderSurfaceGate'

describe('ProviderSurfaceGate', () => {
  beforeEach(() => {
    harness.providers = false
  })

  it('redirects direct user and workspace URLs when the subsystem is off', () => {
    const user = renderToStaticMarkup(
      createElement(ProviderSurfaceGate, {
        scope: 'settings',
        children: createElement('b', null, 'secret form'),
      }),
    )
    const workspace = renderToStaticMarkup(
      createElement(ProviderSurfaceGate, {
        scope: 'workspace',
        children: createElement('b', null, 'consent'),
      }),
    )

    expect(user).toContain('data-redirect="/settings/appearance"')
    expect(user).not.toContain('secret form')
    expect(workspace).toContain('data-redirect="/s/main/management/general"')
    expect(workspace).not.toContain('consent')
  })

  it('renders the surface only from the SpaceProvider capability', () => {
    harness.providers = true
    const html = renderToStaticMarkup(
      createElement(ProviderSurfaceGate, {
        scope: 'settings',
        children: createElement('b', null, 'secret form'),
      }),
    )

    expect(html).toContain('secret form')
    expect(html).not.toContain('data-redirect')
  })
})
