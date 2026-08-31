import { describe, expect, it } from 'vitest'
import { createReaderRegistry, type ReaderDefinition } from '@notarium/core'

import {
  assertViewProjectionRegistryParity,
  projectReaderView,
  summarizeReaderView,
  type ViewProjectionAdapter,
} from './viewProjection'

const stub: ReaderDefinition<{ label: string }> = {
  type: 'stub',
  compileOptions: (raw) =>
    typeof raw === 'object' && raw != null && typeof (raw as { label?: unknown }).label === 'string'
      ? { status: 'ready', options: { label: (raw as { label: string }).label } }
      : { status: 'invalid', diagnostics: ['label is required'] },
  dataNeeds: () => ({ properties: [], window: 'source' }),
  mutationCapabilities: () => ({}),
  project: (data, options) => ({ data, label: options.label }),
}

const adapter: ViewProjectionAdapter = {
  summary: (projection) => `Summary: ${(projection as { label: string }).label}`,
  prose: (projection) => `Stub: ${(projection as { label: string }).label}`,
  structured: (projection) => ({
    kind: 'stub',
    label: (projection as { label: string }).label,
  }),
}

describe('server view projection adapters', () => {
  it('projects one registered stub independently from carrier and source code', () => {
    const registry = createReaderRegistry([stub])
    const adapters = { stub: adapter }

    expect(() => assertViewProjectionRegistryParity(registry, adapters)).not.toThrow()
    expect(
      projectReaderView(
        registry,
        adapters,
        { name: 'Example', type: 'stub', options: { label: 'Rows' } },
        { total: 3 },
      ),
    ).toEqual({
      status: 'ready',
      prose: 'Stub: Rows',
      structured: { kind: 'stub', label: 'Rows' },
    })
    expect(
      summarizeReaderView(
        registry,
        adapters,
        { name: 'Example', type: 'stub', options: { label: 'Rows' } },
        { total: 3 },
      ),
    ).toBe('Summary: Rows')
  })

  it('keeps unknown readers local and rejects registry drift', () => {
    const registry = createReaderRegistry([stub])

    expect(
      projectReaderView(registry, { stub: adapter }, { name: 'Later', type: 'later' }, {}),
    ).toEqual({ status: 'unsupported' })
    expect(() => assertViewProjectionRegistryParity(registry, {})).toThrow('out of sync')
  })
})
