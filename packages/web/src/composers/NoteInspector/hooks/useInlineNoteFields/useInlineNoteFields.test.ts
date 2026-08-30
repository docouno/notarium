// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { NoteDetailView } from '../../../../libs/wire'
import { useInlineNoteFields } from './useInlineNoteFields'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detail = (id: string, versionToken: string, status: string): NoteDetailView =>
  ({
    id,
    title: id,
    content: '',
    frontmatter: { status },
    fields: { keys: { status }, order: ['status'] },
    versionToken,
  }) as NoteDetailView

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('useInlineNoteFields', () => {
  it('ignores a late failure from the note that is no longer active', async () => {
    const request = deferred<{ versionToken: string }>()
    const write = vi.fn(() => request.promise)
    const container = document.createElement('div')
    const root = createRoot(container)
    let current!: ReturnType<typeof useInlineNoteFields>

    const Harness = ({ note }: { note: NoteDetailView }) => {
      current = useInlineNoteFields({
        note,
        canWrite: true,
        write,
        reload: vi.fn().mockResolvedValue(true),
        onError: vi.fn(),
      })
      return null
    }

    await act(async () => root.render(createElement(Harness, { note: detail('a', 'a1', 'doing') })))
    let pending!: Promise<void>
    await act(async () => {
      pending = current.setField('status', 'todo')
    })
    await act(async () =>
      root.render(createElement(Harness, { note: detail('b', 'b1', 'review') })),
    )
    await act(async () => {
      request.reject(new Error('late failure'))
      await pending
    })

    expect(current.values).toEqual({ status: 'review' })
    expect(current.busyKey).toBeNull()
    await act(async () => root.unmount())
  })

  it('adopts conflict current so the next point write uses the fresh token', async () => {
    const currentDetail = detail('a', 'a2', 'remote')
    const conflict = Object.assign(new Error('note changed'), {
      reason: 'version_conflict',
      current: currentDetail,
    })
    const write = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ versionToken: 'a3' })
    const reload = vi.fn().mockResolvedValue(true)
    const initial = detail('a', 'a1', 'doing')
    const container = document.createElement('div')
    const root = createRoot(container)
    let current!: ReturnType<typeof useInlineNoteFields>

    const Harness = () => {
      current = useInlineNoteFields({
        note: initial,
        canWrite: true,
        write,
        reload,
        onError: vi.fn(),
      })
      return null
    }

    await act(async () => root.render(createElement(Harness)))
    await act(async () => current.setField('status', 'todo'))
    expect(current.values).toEqual({ status: 'remote' })
    await act(async () => current.setField('status', 'done'))
    expect(write.mock.calls[1][0].versionToken).toBe('a2')
    await act(async () => root.unmount())
  })

  it('reports a successful write whose in-place refresh did not publish fresh truth', async () => {
    const onError = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    let current!: ReturnType<typeof useInlineNoteFields>
    const note = detail('a', 'a1', 'doing')
    const write = vi.fn().mockResolvedValue({ versionToken: 'a2' })
    const reload = vi.fn().mockResolvedValue(false)

    const Harness = () => {
      current = useInlineNoteFields({
        note,
        canWrite: true,
        write,
        reload,
        onError,
      })
      return null
    }

    await act(async () => root.render(createElement(Harness)))
    await act(async () => current.setField('status', 'done'))

    expect(onError).toHaveBeenCalledWith('Field was saved, but the note could not be refreshed')
    expect(current.busyKey).toBeNull()
    await act(async () => root.unmount())
  })
})
