// @vitest-environment jsdom
//
// The WIRING between a refused body and the button, which the extracted predicate cannot
// see: a revision whose blob is stored and unreadable looks perfectly restorable in the
// timeline row, so this screen is the only place that knows better — and a refusal is an
// ANSWER, not a missing entry. Counting it as missing re-entered the fetch effect forever.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_ERROR_REASON } from '@notarium/core'
import { DialogProvider } from '../../core/Dialog'
import { ToastProvider } from '../../core/Toast'
import type { NoteHistorySource, RevisionView as Revision } from '../../libs/revisions'
import { RevisionView } from './RevisionView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (over: Partial<Revision> = {}): Revision =>
  ({
    revisionId: '7',
    noteId: 'note-1',
    kind: 'write',
    principal: 'ui',
    author: null,
    createdAt: '2026-08-11T10:00:00.000Z',
    contentHash: 'abc',
    stateFormat: 'markdown-v2',
    // The journal's columns describe a fully restorable revision — that is the point.
    restoreAvailability: 'full',
    baseRevisionId: null,
    title: 'A note',
    charsAdded: null,
    charsRemoved: null,
    ...over,
  }) as Revision

const unreadable = () =>
  Object.assign(new Error('refused'), {
    reason: STORE_ERROR_REASON.revisionContentUnreadable,
    isToolError: true,
  })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = async (revision: Revision, detail: (id: string) => Promise<never>) => {
  let calls = 0
  const source = {
    list: async () => ({ items: [], total: 0 }),
    detail: async (id: string) => {
      calls++
      return detail(id)
    },
    restore: async () => {},
  } as unknown as NoteHistorySource

  await act(async () => {
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(
          DialogProvider,
          null,
          createElement(RevisionView, {
            source,
            revision,
            isLatest: false,
            onBack: () => {},
            onRestored: () => {},
          }),
        ),
      ),
    )
  })
  // Let every scheduled effect settle; a looping one would keep issuing requests here.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  return { calls: () => calls }
}

const restoreButton = () => host.querySelector('[data-testid="history-restore"]')

describe('RevisionView over a stored copy this server cannot open', () => {
  it('asks for the body once and does not re-enter its own fetch effect', async () => {
    const probe = await render(row(), async () => {
      throw unreadable()
    })

    expect(probe.calls()).toBe(1)
  })

  it('withdraws Restore even though the row says the revision is fully restorable', async () => {
    await render(row(), async () => {
      throw unreadable()
    })

    expect(restoreButton()?.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('[data-testid="history-unreadable"]')?.textContent).toMatch(
      /can no longer read it/iu,
    )
  })

  it('says so when it is the PARENT that cannot be read, instead of shimmering forever', async () => {
    const probe = await render(row({ baseRevisionId: '6' }), async (id) => {
      throw id === '6' ? unreadable() : new Error('vanished')
    })

    expect(probe.calls()).toBe(2)
    expect(
      host.querySelector('[data-testid="history-comparison-unreadable"]')?.textContent,
    ).toMatch(/parent revision/iu)
  })

  it('still asks once for an ordinary failure it cannot classify', async () => {
    const probe = await render(row(), async () => {
      throw new Error('network')
    })

    expect(probe.calls()).toBe(1)
    // An unclassified failure is not a durable fact about the copy: the row still rules.
    expect(restoreButton()?.hasAttribute('disabled')).toBe(false)
  })
})
