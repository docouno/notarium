// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldSchemaResponse } from '@notarium/contract'

const harness = vi.hoisted(() => ({
  space: 'one',
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock('../../services/api', () => ({
  api: { fieldSchemaGet: harness.get, fieldSchemaPut: harness.put },
}))
vi.mock('../SpaceProvider', () => ({ useSpace: () => ({ space: harness.space }) }))

import {
  type FieldSchemaContextValue,
  FieldSchemaProvider,
  useFieldSchema,
  useFieldSchemaForSpace,
} from './FieldSchemaProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const response = (token: string, key: string): FieldSchemaResponse => ({
  version: 1,
  fields: [{ key, type: 'text' }],
  versionToken: token,
  valueWrites: true,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('FieldSchemaProvider', () => {
  let container: HTMLDivElement
  let root: Root
  let observed: FieldSchemaContextValue | null

  const Probe = () => {
    observed = useFieldSchema()
    return null
  }
  const render = () =>
    act(async () => {
      root.render(createElement(FieldSchemaProvider, null, createElement(Probe)))
      await Promise.resolve()
      await Promise.resolve()
    })

  beforeEach(() => {
    harness.space = 'one'
    harness.get.mockReset()
    harness.put.mockReset()
    observed = null
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('uses the fresh PUT token as the feed-facing revision and on the next save', async () => {
    harness.get.mockResolvedValue(response('one:1', 'status'))
    harness.put
      .mockResolvedValueOnce(response('one:2', 'owner'))
      .mockResolvedValueOnce(response('one:3', 'priority'))

    await render()
    expect(observed?.revision).toBe('one:1')

    await act(async () => {
      await observed!.update([{ key: 'owner', type: 'text' }], 'one:1')
    })
    expect(observed?.revision).toBe('one:2')
    expect(harness.put).toHaveBeenLastCalledWith('one', {
      version: 1,
      fields: [{ key: 'owner', type: 'text' }],
      versionToken: 'one:1',
    })

    await act(async () => {
      await observed!.update([{ key: 'priority', type: 'number' }], 'one:2')
    })
    expect(harness.put).toHaveBeenLastCalledWith('one', {
      version: 1,
      fields: [{ key: 'priority', type: 'number' }],
      versionToken: 'one:2',
    })
  })

  it('never substitutes its cached revision for the caller-pinned token', async () => {
    harness.get.mockResolvedValue(response('one:1', 'status'))
    harness.put.mockResolvedValue(response('one:2', 'owner'))

    await render()
    await act(async () => {
      await observed!.update([{ key: 'owner', type: 'text' }], 'draft:stale')
    })

    expect(harness.put).toHaveBeenCalledWith('one', {
      version: 1,
      fields: [{ key: 'owner', type: 'text' }],
      versionToken: 'draft:stale',
    })
  })

  it('keeps independent snapshots per space across an in-place switch', async () => {
    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:1', 'beta'),
    )

    await render()
    expect(observed?.fields[0].key).toBe('alpha')

    harness.space = 'two'
    await render()
    expect(observed?.fields[0].key).toBe('beta')

    harness.space = 'one'
    await render()
    // The cached one-space snapshot is available synchronously while its refresh runs.
    expect(observed?.fields[0].key).toBe('alpha')
  })

  it('loads a note-owned space without replacing the active schema', async () => {
    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:1', 'beta'),
    )

    await render()
    await act(async () => {
      await observed!.reloadSpace('two')
    })

    expect(observed?.space).toBe('one')
    expect(observed?.fields[0].key).toBe('alpha')
    expect(observed?.snapshotFor('two')?.fields[0].key).toBe('beta')
  })

  it('does not paint a late space-A PUT over active space B', async () => {
    const late = deferred<FieldSchemaResponse>()
    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:1', 'beta'),
    )
    harness.put.mockReturnValue(late.promise)
    await render()
    const oldUpdate = observed!.update([{ key: 'late-alpha', type: 'text' }], 'one:1')

    harness.space = 'two'
    await render()
    expect(observed?.fields[0].key).toBe('beta')

    await act(async () => {
      late.resolve(response('one:2', 'late-alpha'))
      await oldUpdate
    })
    expect(observed?.fields[0].key).toBe('beta')
  })

  it('keeps a late space-A save failure and recovery out of active space B', async () => {
    let rejectPut!: (cause: unknown) => void
    const put = new Promise<FieldSchemaResponse>((_resolve, reject) => {
      rejectPut = reject
    })
    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:1', 'beta'),
    )
    harness.put.mockReturnValue(put)
    await render()
    const oldUpdate = observed!.update([{ key: 'late-alpha', type: 'text' }], 'one:1')

    harness.space = 'two'
    await render()
    await act(async () => {
      rejectPut(new Error('space one save failed'))
      await expect(oldUpdate).rejects.toThrow('space one save failed')
    })

    expect(observed?.space).toBe('two')
    expect(observed?.fields[0].key).toBe('beta')
    expect(observed?.error).toBeNull()
  })

  it('does not let an earlier GET roll back a successful PUT in the same space', async () => {
    const lateGet = deferred<FieldSchemaResponse>()
    harness.get
      .mockResolvedValueOnce(response('one:1', 'status'))
      .mockReturnValueOnce(lateGet.promise)
    harness.put.mockResolvedValue(response('one:2', 'owner'))
    await render()

    let reload!: Promise<FieldSchemaResponse | undefined>
    await act(async () => {
      reload = observed!.reload()
      await Promise.resolve()
    })
    await act(async () => {
      await observed!.update([{ key: 'owner', type: 'text' }], 'one:1')
    })
    await act(async () => {
      lateGet.resolve(response('one:1', 'status'))
      await reload
    })

    expect(observed?.revision).toBe('one:2')
    expect(observed?.fields[0].key).toBe('owner')
  })

  it('does not accept a GET that starts while a PUT is in flight', async () => {
    const latePut = deferred<FieldSchemaResponse>()
    const duringPutGet = deferred<FieldSchemaResponse>()
    harness.get
      .mockResolvedValueOnce(response('one:1', 'status'))
      .mockReturnValueOnce(duringPutGet.promise)
    harness.put.mockReturnValue(latePut.promise)
    await render()

    let update!: Promise<FieldSchemaResponse>
    let reload!: Promise<FieldSchemaResponse | undefined>
    await act(async () => {
      update = observed!.update([{ key: 'owner', type: 'text' }], 'one:1')
      reload = observed!.reload()
      await Promise.resolve()
    })
    await act(async () => {
      duringPutGet.resolve(response('one:1', 'status'))
      await reload
    })
    expect(observed?.revision).toBe('one:1')

    await act(async () => {
      latePut.resolve(response('one:2', 'owner'))
      await update
    })
    expect(observed?.revision).toBe('one:2')
    expect(observed?.fields[0].key).toBe('owner')
  })

  it('caches a foreign-space load error for that space only', async () => {
    harness.get
      .mockResolvedValueOnce(response('one:1', 'alpha'))
      .mockRejectedValueOnce(new Error('schema two unavailable'))
    await render()

    await act(async () => {
      await observed!.reloadSpace('two')
    })

    expect(observed?.error).toBeNull()
    expect(observed?.snapshotFor('two')?.error).toBe('schema two unavailable')
    expect(observed?.snapshotFor('two')?.readOnly).toBe(true)
    expect(observed?.snapshotFor('two')?.valueWrites).toBe(false)
  })

  it('never pairs the previous space schema with the next space identity', async () => {
    const spaceTwo = deferred<FieldSchemaResponse>()
    harness.get.mockImplementation((space: string) =>
      space === 'one' ? Promise.resolve(response('one:1', 'alpha')) : spaceTwo.promise,
    )
    await render()

    harness.space = 'two'
    await act(async () => {
      root.render(createElement(FieldSchemaProvider, null, createElement(Probe)))
      await Promise.resolve()
    })

    expect(observed?.space).toBe('two')
    expect(observed?.fields).toEqual([])
    expect(observed?.revision).toBe('loading')

    await act(async () => {
      spaceTwo.resolve(response('two:1', 'beta'))
      await Promise.resolve()
    })
  })

  it('single-flights a cold foreign-space load shared by multiple consumers', async () => {
    const spaceTwo = deferred<FieldSchemaResponse>()
    harness.get.mockImplementation((space: string) =>
      space === 'one' ? Promise.resolve(response('one:1', 'alpha')) : spaceTwo.promise,
    )
    const ForeignProbe = () => {
      useFieldSchemaForSpace('two')
      return null
    }

    await act(async () => {
      root.render(
        createElement(
          FieldSchemaProvider,
          null,
          createElement(ForeignProbe),
          createElement(ForeignProbe),
        ),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.get.mock.calls.filter(([space]) => space === 'two')).toHaveLength(1)

    await act(async () => {
      spaceTwo.resolve(response('two:1', 'beta'))
      await Promise.resolve()
    })
  })

  it('queues a fresh read when invalidation arrives during an older GET', async () => {
    const stale = deferred<FieldSchemaResponse>()
    harness.get
      .mockResolvedValueOnce(response('one:1', 'alpha'))
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(response('one:2', 'beta'))
    await render()

    let first!: Promise<FieldSchemaResponse | undefined>
    let invalidation!: Promise<FieldSchemaResponse | undefined>
    await act(async () => {
      first = observed!.reload()
      await Promise.resolve()
      invalidation = observed!.reload()
      stale.resolve(response('one:1', 'alpha'))
      await first
      await invalidation
    })

    expect(harness.get).toHaveBeenCalledTimes(3)
    expect(observed?.revision).toBe('one:2')
    expect(observed?.fields[0].key).toBe('beta')
  })

  it('revalidates mounted foreign-space consumers on focus', async () => {
    const ForeignProbe = () => {
      useFieldSchemaForSpace('two')
      return null
    }
    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:1', 'beta'),
    )
    await act(async () => {
      root.render(
        createElement(FieldSchemaProvider, null, createElement(Probe), createElement(ForeignProbe)),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    harness.get.mockImplementation(async (space: string) =>
      space === 'one' ? response('one:1', 'alpha') : response('two:2', 'gamma'),
    )
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(observed?.snapshotFor('two')?.versionToken).toBe('two:2')
  })
})
