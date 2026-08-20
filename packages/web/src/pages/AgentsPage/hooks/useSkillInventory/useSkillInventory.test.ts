// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeAgentSkillsResponse } from '@notarium/contract'
import type { SkillInventory } from '../../helpers/skillInventory'

const harness = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('../../helpers/skillInventory', () => ({ loadSkillInventory: harness.load }))

import { type SkillInventoryState, useSkillInventory } from './useSkillInventory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })

  return { promise, resolve }
}

const inventoryOf = (spaceId: string): SkillInventory =>
  ({
    first: {
      items: [],
      projects: [
        {
          id: `${spaceId}-project`,
          handle: `${spaceId}/p`,
          displayName: spaceId,
          space: spaceId,
          status: 'active',
        },
      ],
    } as unknown as MeAgentSkillsResponse,
    all: [],
  }) as SkillInventory

describe('the ability page’s inventory reader', () => {
  let container: HTMLDivElement
  let root: Root
  let live: SkillInventoryState

  const Probe = () => {
    live = useSkillInventory(null)
    return null
  }

  beforeEach(async () => {
    harness.load.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Probe)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  // Open role A of one Space from the library, then role B of another right after.
  // The drain walks up to twenty pages, so A's answer is the one that lands second.
  it('keeps the Space asked for last when an earlier read answers after it', async () => {
    const first = deferred<SkillInventory>()
    const second = deferred<SkillInventory>()

    harness.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    await act(async () => {
      void live.read('space-a')
      void live.read('space-b')
    })
    await act(async () => {
      second.resolve(inventoryOf('space-b'))
      first.resolve(inventoryOf('space-a'))
      await first.promise
    })

    expect(live.inventory?.projects.map((entry) => entry.space)).toEqual(['space-b'])
  })

  it('adopts the answer of a read nothing has superseded', async () => {
    harness.load.mockResolvedValueOnce(inventoryOf('space-a'))

    await act(async () => {
      await live.read('space-a')
    })

    expect(live.inventory?.projects.map((entry) => entry.space)).toEqual(['space-a'])
  })
})
