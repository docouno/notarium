// @vitest-environment jsdom

import { act, createElement, lazy } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReaderRegistry, parseViewDocument, type ReaderDefinition } from '@notarium/core'

import {
  assertViewRegistryParity,
  VIEW_READER_COMPONENTS,
  VIEW_READER_ICONS,
  VIEW_READER_REGISTRY,
  type ViewReaderComponentProps,
  ViewRuntime,
} from './ViewRuntime'

const stub: ReaderDefinition<{ label: string }> = {
  type: 'stub',
  compileOptions: (raw) =>
    typeof raw === 'object' && raw != null && typeof (raw as { label?: unknown }).label === 'string'
      ? { status: 'ready', options: { label: (raw as { label: string }).label } }
      : { status: 'invalid', diagnostics: ['Stub label is required.'] },
  dataNeeds: () => ({ properties: [], window: 'source' }),
  mutationCapabilities: () => ({}),
  project: (_data, options) => ({ label: options.label }),
}

const StubReader = ({ projection, mode }: ViewReaderComponentProps) =>
  createElement(
    'p',
    { 'data-testid': 'stub-reader' },
    `${(projection as { label: string }).label}:${mode}`,
  )

const ManifestReader = ({ manifest, loading }: ViewReaderComponentProps) =>
  createElement(
    'p',
    {
      'data-testid': 'manifest-reader',
      'data-snapshot': manifest?.snapshotGeneration,
      'data-schema': manifest?.schemaVersionToken,
    },
    loading ? 'loading' : manifest?.total,
  )

const WindowReader = ({ loadWindow }: ViewReaderComponentProps) =>
  createElement(
    'button',
    { type: 'button', onClick: () => void loadWindow({ group: 'group-a', limit: 25 }) },
    'Load window',
  )

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const carrierDocument = (views: string) =>
  ['```nota', 'version: 1', 'source: { kind: notes }', 'views:', views, '```'].join('\n')

describe('ViewRuntime', () => {
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders a registered stub and keeps an unknown sibling local', async () => {
    const parsed = parseViewDocument(
      carrierDocument(
        [
          '  - name: Stub',
          '    type: stub',
          '    options: { label: Rows }',
          '  - name: Later',
          '    type: later-reader',
        ].join('\n'),
      ),
    )
    const registry = createReaderRegistry([stub])
    const components = { stub: StubReader }

    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'draft',
          registry,
          components,
        }),
      ),
    )
    expect(host.querySelector('[data-testid="stub-reader"]')?.textContent).toBe('Rows:draft')
    expect(host.textContent).not.toContain('Show source')

    const later = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Later'),
    )!
    await act(async () => later.click())

    expect(host.textContent).toContain('Reader “later-reader” is not installed.')
    expect(host.textContent).not.toContain('Show source')
  })

  it('keeps lazy reader loading and import failure inside the local view boundary', async () => {
    const parsed = parseViewDocument(
      carrierDocument('  - { name: Stub, type: stub, options: { label: Rows } }'),
    )
    const module = deferred<{ default: typeof StubReader }>()
    const LazyStub = lazy(() => module.promise)
    const registry = createReaderRegistry([stub])

    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'draft',
          registry,
          components: { stub: LazyStub },
        }),
      ),
    )
    expect(host.querySelector('[data-testid="view-reader-module-skeleton"]')).not.toBeNull()

    await act(async () => {
      module.resolve({ default: StubReader })
      await module.promise
    })
    expect(host.querySelector('[data-testid="stub-reader"]')?.textContent).toBe('Rows:draft')

    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const BrokenStub = lazy(() => Promise.reject(new Error('chunk unavailable')))
    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'draft',
          registry,
          components: { stub: BrokenStub },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('This reader failed to render.')
  })

  it('renders malformed reader options as a reader-local error', async () => {
    const parsed = parseViewDocument(carrierDocument('  - { name: Stub, type: stub, options: {} }'))

    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'current-reader',
          registry: createReaderRegistry([stub]),
          components: { stub: StubReader },
        }),
      ),
    )

    expect(host.textContent).toContain('Stub label is required.')
  })

  it('keeps a malformed carrier local without adding source disclosure chrome', async () => {
    const parsed = parseViewDocument('```nota\nversion: [\n```')

    await act(async () =>
      root.render(createElement(ViewRuntime, { block: parsed.blocks[0]!, mode: 'current-reader' })),
    )

    expect(host.textContent).toContain('could not be parsed')
    expect(host.textContent).not.toContain('Show source')
  })

  it('generation-fences a stale manifest response across refreshes', async () => {
    const parsed = parseViewDocument(
      carrierDocument('  - { name: Stub, type: stub, options: { label: Rows } }'),
      { documentId: 'view-note', versionToken: 'v1:view-note' },
    )
    const viewRef = parsed.views[0]!.viewRef!
    const first = deferred<Response>()
    const second = deferred<Response>()
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    vi.stubGlobal('fetch', fetch)
    const render = (refreshKey: number) =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'current-reader',
          registry: createReaderRegistry([stub]),
          components: { stub: ManifestReader },
          refreshKey,
        }),
      )

    await act(async () => render(0))
    await act(async () => render(1))
    await act(async () => {
      second.resolve(
        new Response(
          JSON.stringify({
            documentId: 'view-note',
            documentVersionToken: 'v1:view-note',
            snapshotGeneration: 'new',
            schemaVersionToken: 'schema-new',
            views: [
              {
                viewRef,
                block: 0,
                occurrence: 0,
                name: 'Stub',
                type: 'stub',
                status: 'ready',
                total: 2,
                snapshotGeneration: 'new',
                schemaVersionToken: 'schema-new',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      await second.promise
    })
    expect(host.querySelector('[data-testid="manifest-reader"]')?.textContent).toBe('2')
    expect(
      host.querySelector('[data-testid="manifest-reader"]')?.getAttribute('data-snapshot'),
    ).toBe('new')
    expect(host.querySelector('[data-testid="manifest-reader"]')?.getAttribute('data-schema')).toBe(
      'schema-new',
    )

    await act(async () => {
      first.resolve(
        new Response(
          JSON.stringify({
            documentId: 'view-note',
            documentVersionToken: 'v1:view-note',
            snapshotGeneration: 'old',
            views: [
              {
                viewRef,
                block: 0,
                occurrence: 0,
                name: 'Stub',
                type: 'stub',
                status: 'ready',
                total: 1,
                snapshotGeneration: 'old',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      await first.promise
    })
    expect(host.querySelector('[data-testid="manifest-reader"]')?.textContent).toBe('2')
  })

  it('binds saved window requests to the retained manifest versions', async () => {
    const parsed = parseViewDocument(
      carrierDocument('  - { name: Stub, type: stub, options: { label: Rows } }'),
      { documentId: 'view-note', versionToken: 'v1:view-note' },
    )
    const viewRef = parsed.views[0]!.viewRef!
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            documentId: 'view-note',
            documentVersionToken: 'v1:view-note',
            snapshotGeneration: 'top-level-snapshot',
            schemaVersionToken: 'top-level-schema',
            views: [
              {
                viewRef,
                block: 0,
                occurrence: 0,
                name: 'Stub',
                type: 'stub',
                status: 'ready',
                total: 0,
                snapshotGeneration: 'snapshot-7',
                schemaVersionToken: 'schema-3',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            viewRef,
            group: 'group-a',
            offset: 0,
            limit: 25,
            total: 0,
            snapshotGeneration: 'snapshot-7',
            schemaVersionToken: 'schema-3',
            rows: [],
            execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

    vi.stubGlobal('fetch', fetch)
    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'current-reader',
          registry: createReaderRegistry([stub]),
          components: { stub: WindowReader },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      viewRef,
      snapshotGeneration: 'snapshot-7',
      schemaVersionToken: 'schema-3',
      group: 'group-a',
      offset: 0,
      limit: 25,
    })
  })

  it('binds draft windows after the unbound skeleton query establishes a version', async () => {
    const parsed = parseViewDocument(
      carrierDocument('  - { name: Stub, type: stub, options: { label: Rows } }'),
    )
    const draftResponse = {
      draft: true,
      group: 'group-a',
      offset: 0,
      limit: 25,
      total: 0,
      snapshotGeneration: 'draft-snapshot-4',
      schemaVersionToken: 'draft-schema-2',
      rows: [],
      groups: [],
      execution: { exactReads: 0, exactCacheHits: 0, exactRemaining: 0 },
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...draftResponse, group: undefined, limit: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(draftResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    vi.stubGlobal('fetch', fetch)
    await act(async () =>
      root.render(
        createElement(ViewRuntime, {
          block: parsed.blocks[0]!,
          mode: 'draft',
          context: { kind: 'draft', space: 'team', directory: 'work' },
          registry: createReaderRegistry([stub]),
          components: { stub: WindowReader },
        }),
      ),
    )
    await act(async () => Promise.resolve())
    const initial = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))

    expect(initial).not.toHaveProperty('snapshotGeneration')
    expect(initial).not.toHaveProperty('schemaVersionToken')
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      snapshotGeneration: 'draft-snapshot-4',
      schemaVersionToken: 'draft-schema-2',
      window: { group: 'group-a', offset: 0, limit: 25 },
    })
  })
})

describe('view registry parity', () => {
  it('keeps the built-in board definition and component in lockstep', () => {
    expect(() =>
      assertViewRegistryParity(VIEW_READER_REGISTRY, VIEW_READER_COMPONENTS, VIEW_READER_ICONS),
    ).not.toThrow()
  })

  it('requires one component for every pure definition and no extras', () => {
    const registry = createReaderRegistry([stub])

    expect(() => assertViewRegistryParity(registry, { stub: StubReader })).not.toThrow()
    expect(() => assertViewRegistryParity(registry, {})).toThrow('out of sync')
    expect(() => assertViewRegistryParity(createReaderRegistry([]), { extra: StubReader })).toThrow(
      'out of sync',
    )
  })
})
