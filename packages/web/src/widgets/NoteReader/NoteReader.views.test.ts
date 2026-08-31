// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ToastProvider } from '../../core/Toast'
import type { NoteDetailView } from '../../libs/wire'
import { NoteReader } from './NoteReader'

const carrier = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: Tasks
    type: board
    options: { groupBy: note.status }
\`\`\``

const note = (content: string, view?: string): NoteDetailView => ({
  id: 'view-note',
  title: 'View note',
  filePath: 'view-note.md',
  content,
  frontmatter: { ...(view !== undefined ? { view } : {}) },
  versionToken: 'v1:view-note',
})

describe('NoteReader view marker warnings', () => {
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
  })

  const render = async (value: NoteDetailView, live = true) => {
    await act(async () =>
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(NoteReader, {
            note: value,
            ...(live
              ? {
                  renderViewBlock: () => createElement('div', null, 'Live board'),
                  viewPresentation: (type: string) =>
                    type === 'board' ? ('workspace' as const) : ('document' as const),
                }
              : {}),
          }),
        ),
      ),
    )
  }

  it('stays quiet for a matching marker and warns when discovery is missing', async () => {
    await render(note(carrier, 'board'))
    expect(host.textContent).not.toContain('marker')
    expect(host.querySelector('[data-view-presentation="workspace"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="note-detail-meta"]')).toBeNull()

    await render(note(carrier))
    expect(host.textContent).toContain('View marker is missing; discovery may be incomplete.')
    expect(host.textContent).toContain('Live board')
  })

  it('names a valid-body mismatch but keeps marker-only and invalid notes quiet', async () => {
    await render(note(carrier, 'table'))
    expect(host.textContent).toContain('View marker “table” does not match primary reader “board”')

    await render(note('ordinary prose', 'board'))
    expect(host.textContent).not.toContain('View marker')

    await render(note('```nota\nversion: [\n```', 'board'))
    expect(host.textContent).not.toContain('View marker')
  })

  it('does not execute current-marker diagnostics in frozen raw history mode', async () => {
    await render(note('ordinary prose', 'board'), false)
    expect(host.textContent).not.toContain('has no executable block')
  })
})
