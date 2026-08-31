// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { VIEW_DOCUMENT_LIMIT } from '@notarium/core'

import { renderMarkdown, renderMarkdownDocument } from './markdown'

const source = [
  '# Before',
  '',
  'Text with a footnote.[^1]',
  '',
  '```nota',
  'version: 1',
  'source: { kind: notes }',
  'views: [{ name: Board, type: board }]',
  '```',
  '',
  '## After',
  '',
  '[^1]: Evidence.',
].join('\n')

describe('live Markdown view placeholders', () => {
  it('uses an inert sanitized host while keeping one surrounding Markdown document', () => {
    const rendered = renderMarkdownDocument(
      source,
      {},
      {
        documentId: 'note-1',
        versionToken: 'v1:test',
      },
    )

    expect(rendered.views.blocks).toHaveLength(1)
    expect(rendered.views.views[0]?.viewRef).toBeTruthy()
    expect(rendered.html).toContain('data-notarium-view-block="0"')
    expect(rendered.html).not.toContain('source: { kind: notes }')
    expect(rendered.html).toContain('<h1>Before</h1>')
    expect(rendered.html).toContain('<h2>After</h2>')
    expect(rendered.html).toContain('class="footnotes"')
  })

  it('keeps history/plain rendering raw and non-interactive', () => {
    const html = renderMarkdown(source)

    expect(html).not.toContain('data-notarium-view-block')
    expect(html).toContain('language-nota')
    expect(html).toContain('source: { kind: notes }')
  })

  it('does not interpolate hostile YAML into placeholder attributes', () => {
    const rendered = renderMarkdownDocument(
      `\`\`\`nota\nversion: 1\nsource: { kind: notes }\nviews: [{ name: '"><img src=x onerror=alert(1)>', type: later }]\n\`\`\``,
    )

    expect(rendered.html).toBe('<div data-notarium-view-block="0"></div>\n')
    expect(rendered.html).not.toContain('<img')
    expect(rendered.html).not.toContain('onerror')
  })

  it('erases overflow carriers instead of handing them to the Markdown renderer', () => {
    const rendered = renderMarkdownDocument(
      Array.from(
        { length: VIEW_DOCUMENT_LIMIT.blocks + 2 },
        (_, index) => `\`\`\`nota\nsecret-overflow-${index}\n\`\`\``,
      ).join('\n'),
    )

    expect(rendered.views.blocks).toHaveLength(VIEW_DOCUMENT_LIMIT.blocks)
    expect(rendered.html.match(/data-notarium-view-block=/gu)).toHaveLength(
      VIEW_DOCUMENT_LIMIT.blocks,
    )
    expect(rendered.html).not.toContain('secret-overflow')
    expect(rendered.html).not.toContain('language-nota')
  })
})
