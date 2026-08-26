// @vitest-environment jsdom
//
// The WIRING between a refused body and the button, which the extracted predicate cannot
// see: a revision whose blob is stored and unreadable looks perfectly restorable in the
// timeline row, so this screen is the only place that knows better — and a refusal is an
// ANSWER, not a missing entry. Counting it as missing re-entered the fetch effect forever.
//
// And the WIRING between a finished request and the screen: a body that arrived is
// worth nothing if the view never learns of it, so every way an answer can land — second
// of two, only one under a doubled effect pass, or a failure — is checked here for what
// reaches the DOM, not for what sits in memory.

import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_ERROR_REASON } from '@notarium/core'
import { DialogProvider } from '../../core/Dialog'
import { ToastProvider } from '../../core/Toast'
import type {
  NoteHistorySource,
  RevisionView as Revision,
  RevisionDetailView,
} from '../../libs/revisions'
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

/** A readable markdown body for `id`. `snapshot: null` keeps the comparison on the
 *  bodies, which is what the diff rows below are read against. */
const body = (id: string, content: string): RevisionDetailView =>
  ({
    ...row({ revisionId: id }),
    tags: [],
    contentMode: 'markdown',
    content,
    snapshot: null,
  }) as RevisionDetailView

/** Opaque bytes the renderer cannot diff against anything. */
const sourceBody = (id: string): RevisionDetailView =>
  ({
    ...row({ revisionId: id }),
    tags: [],
    contentMode: 'source',
    content: null,
    snapshot: null,
    source: { encoding: 'utf8', data: 'raw' },
  }) as RevisionDetailView

/** A body the journal never captured — used for either side, so the screen has to name it
 *  rather than render an empty column. */
const gapBody = (id: string): RevisionDetailView =>
  ({
    ...row({ revisionId: id, contentHash: null, unavailableReason: 'identity-conflict' }),
    tags: [],
    contentMode: 'gap',
    content: null,
    snapshot: null,
  }) as RevisionDetailView

/** An answer this test resolves by hand, to place it on either side of a render. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

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

const render = async (
  revision: Revision,
  detail: (id: string) => Promise<RevisionDetailView>,
  // `strict` mounts the way the app itself does (main.tsx): React runs the fetch effect
  // twice on mount, and one request per id has to survive that.
  opts: { strict?: boolean } = {},
) => {
  let calls = 0
  const source = {
    list: async () => ({ items: [], total: 0 }),
    detail: async (id: string) => {
      calls++
      return detail(id)
    },
    restore: async () => {},
  } as unknown as NoteHistorySource

  const tree = createElement(
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
  )

  await act(async () => {
    root.render(opts.strict ? createElement(StrictMode, null, tree) : tree)
  })
  // Let every scheduled effect settle; a looping one would keep issuing requests here.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  return { calls: () => calls }
}

/** Flush whatever the just-resolved answer scheduled, including the render it causes. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const restoreButton = () => host.querySelector('[data-testid="history-restore"]')
const skeleton = () => host.querySelector('[data-testid="revision-skeleton"]')
const testId = (id: string) => host.querySelector(`[data-testid="${id}"]`)

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

describe('RevisionView delivering an answer to the screen', () => {
  it('shows the diff when the base body lands after a render, not only inside one batch', async () => {
    const current = deferred<RevisionDetailView>()
    const base = deferred<RevisionDetailView>()
    const probe = await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) =>
      id === '7' ? current.promise : base.promise,
    )

    // Nothing has answered yet: the shimmer is the whole point of this state.
    expect(skeleton()).not.toBeNull()

    // The order the stand shows: the selected body wins the race, renders, and the parent
    // arrives into the next frame. Both answers are equally "the request finished".
    current.resolve(body('7', 'line one\nline two\n'))
    await flush()
    base.resolve(body('6', 'line one\n'))
    await flush()

    expect(probe.calls()).toBe(2)
    expect(skeleton()).toBeNull()
    expect(testId('history-diff')?.textContent).toContain('line two')
  })

  it('delivers the single answer of a revision with no parent under a doubled effect pass', async () => {
    const probe = await render(row({ baseRevisionId: null }), async () => body('7', 'only body'), {
      strict: true,
    })

    // One request even though the effect ran twice — and it reaches the DOM.
    expect(probe.calls()).toBe(1)
    expect(skeleton()).toBeNull()
    expect(testId('history-diff')?.textContent).toContain('only body')
  })

  it('delivers both answers of a revision with a parent under a doubled effect pass', async () => {
    const probe = await render(
      row({ revisionId: '7', baseRevisionId: '6' }),
      async (id) => (id === '7' ? body('7', 'line one\nline two\n') : body('6', 'line one\n')),
      { strict: true },
    )

    expect(probe.calls()).toBe(2)
    expect(skeleton()).toBeNull()
    expect(testId('history-diff')?.textContent).toContain('line two')
  })

  it('says the body could not be loaded instead of shimmering forever', async () => {
    await render(row(), async () => {
      throw new Error('network')
    })

    expect(skeleton()).toBeNull()
    expect(testId('history-error')).not.toBeNull()
  })

  it('does not shimmer for a pair a settled parent already rules out', async () => {
    const current = deferred<RevisionDetailView>()
    await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) =>
      id === '7' ? current.promise : Promise.resolve(gapBody('6')),
    )

    // The selected body is still in flight, but the parent has answered "nothing captured":
    // no rows can come of this pair, so a shimmer here would promise what never arrives.
    expect(skeleton()).toBeNull()
    expect(testId('history-comparison-gap')).not.toBeNull()
  })

  it('stops waiting on a parent that can no longer produce rows', async () => {
    const current = deferred<RevisionDetailView>()
    await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) =>
      id === '7' ? current.promise : Promise.reject(unreadable()),
    )

    // The parent is refused, so no rows can come of this pair however the selected body
    // lands — shimmering under that verdict would promise what cannot arrive.
    expect(skeleton()).toBeNull()
    expect(testId('history-comparison-unreadable')).not.toBeNull()
  })

  it('stops waiting on a parent once its own body is the one that failed', async () => {
    const base = deferred<RevisionDetailView>()
    await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) => {
      if (id === '7') {
        return Promise.reject(new Error('network'))
      }

      return base.promise
    })

    // The selected body is the only one this screen can render rows from. Once it fails,
    // a still-flying parent is not something the user is waiting for.
    expect(skeleton()).toBeNull()
    expect(testId('history-error')).not.toBeNull()
  })

  it('keeps the Content shimmer while my own body is coming, whatever the parent did', async () => {
    const current = deferred<RevisionDetailView>()
    await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) =>
      id === '7' ? current.promise : Promise.resolve(gapBody('6')),
    )

    const content = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Content',
    )
    await act(async () => content?.click())

    // Changes has nothing left to wait for — the parent settled as a gap. This tab renders
    // my body alone, and it is still on its way, so the shimmer belongs here.
    expect(skeleton()).not.toBeNull()
  })

  it('says a body that came back a gap is a gap, instead of showing nothing', async () => {
    // The row was listed with a content hash, then the note was quarantined and the body
    // came back empty — the screen has to say so rather than render a blank column.
    await render(row({ contentHash: 'abc' }), async () => gapBody('7'))

    expect(skeleton()).toBeNull()
    // The row predates the quarantine, so its reason is empty and its hash still set —
    // reading the reason off the row would invent an external writer the server never
    // claimed. Restore goes with it: there is nothing left to restore.
    expect(testId('history-gap')?.textContent).toMatch(/identity was in doubt/iu)
    expect(restoreButton()?.hasAttribute('disabled')).toBe(true)
  })

  it('does not shimmer for a pair an opaque parent already rules out', async () => {
    const current = deferred<RevisionDetailView>()
    await render(row({ revisionId: '7', baseRevisionId: '6' }), (id) =>
      id === '7' ? current.promise : Promise.resolve(sourceBody('6')),
    )

    // Opaque bytes are not diffable, so this pair can never produce rows — the same verdict
    // as a gap parent, reached through the other settled non-markdown outcome.
    expect(skeleton()).toBeNull()
    expect(testId('history-comparison-source')).not.toBeNull()
  })

  it('adds no failure line to a row that never had a body', async () => {
    await render(row({ contentHash: null }), async () => {
      throw new Error('network')
    })

    // The row already says nothing was captured here. A second line about a failed request
    // for a body that never existed would contradict it.
    expect(testId('history-error')).toBeNull()
    expect(testId('history-gap')).not.toBeNull()
  })

  it('drops the shimmer when the selected copy itself is the one refused', async () => {
    await render(row(), async () => {
      throw unreadable()
    })

    // The verdict is in and it is final: nothing is on its way, so nothing may shimmer —
    // this row has no parent to be waiting on either.
    expect(skeleton()).toBeNull()
    expect(testId('history-unreadable')).not.toBeNull()
  })

  it('drops the shimmer on the Content tab too, not only in Changes', async () => {
    await render(row(), async () => {
      throw new Error('network')
    })

    const content = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Content',
    )
    await act(async () => content?.click())

    expect(skeleton()).toBeNull()
    expect(testId('history-error')).not.toBeNull()
  })

  it('says the PARENT body could not be loaded instead of shimmering forever', async () => {
    await render(row({ revisionId: '7', baseRevisionId: '6' }), async (id) => {
      if (id === '6') {
        throw new Error('network')
      }

      return body('7', 'line one\n')
    })

    expect(skeleton()).toBeNull()
    expect(testId('history-comparison-error')).not.toBeNull()
    // The selected body did load — the failure is named for the parent alone.
    expect(testId('history-error')).toBeNull()
  })
})
