import { describe, expect, it } from 'vitest'
import {
  captureFullSourcePosition,
  captureRenderedPosition,
  createDocumentBodyPositionModel,
  createFullSourcePositionModel,
  resolveFullSourcePosition,
  resolveRenderedPosition,
} from './documentPosition'

const lineAt = (source: string, position: number): string => {
  const start = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1
  const end = source.indexOf('\n', position)

  return source.slice(start, end < 0 ? source.length : end)
}

describe('document position anchor', () => {
  it('maps duplicate ATX labels by ordinal and ignores a fenced pseudo-heading', () => {
    const body = [
      '## Same',
      'first',
      '```md',
      '## not a heading',
      '```',
      '## Same',
      'second sentinel',
    ].join('\n')
    const full = `# Document\n\n${body}`
    const position = resolveFullSourcePosition(full, {
      headingOrdinal: 1,
      sectionProgress: 0.5,
      documentProgress: 0,
    })

    expect(position).toBeGreaterThan(full.indexOf('## Same', full.indexOf('## Same') + 1))
    expect(lineAt(full, position)).toBe('second sentinel')
  })

  it('preserves non-zero progress bands and excludes the synthetic title H1', () => {
    const section = Array.from({ length: 12 }, (_, index) => `alpha ${index}`).join('\n')
    const body = `## Alpha\n${section}\n## Omega\nomega`
    const full = `# Synthetic title\n\n${body}`
    const quarter = resolveFullSourcePosition(full, {
      headingOrdinal: 0,
      sectionProgress: 0.25,
      documentProgress: 0,
    })
    const threeQuarters = resolveFullSourcePosition(full, {
      headingOrdinal: 0,
      sectionProgress: 0.75,
      documentProgress: 0,
    })

    expect(lineAt(full, quarter)).toBe('alpha 2')
    expect(lineAt(full, threeQuarters)).toBe('alpha 8')
    expect(quarter).toBeGreaterThan(full.indexOf('## Alpha'))
    expect(threeQuarters).toBeGreaterThan(quarter)
  })

  it('round-trips an editor source line through the body-relative model', () => {
    const full = [
      '# Title',
      '',
      '## A',
      ...Array.from({ length: 20 }, (_, index) => `a-${index}`),
      '## B',
      ...Array.from({ length: 20 }, (_, index) => `b-${index}`),
    ].join('\n')
    const sourcePosition = full.indexOf('b-13')
    const anchor = captureFullSourcePosition(full, sourcePosition)
    const restored = resolveFullSourcePosition(full, anchor)

    expect(anchor.headingOrdinal).toBe(1)
    expect(anchor.sectionProgress).toBeGreaterThan(0)
    expect(lineAt(full, restored)).toBe('b-13')
  })

  it('uses document progress for flat documents at distinct non-middle positions', () => {
    const body = Array.from({ length: 400 }, (_, index) => `flat-${index}`).join('\n')
    const full = `# Flat\n\n${body}`
    const first = resolveFullSourcePosition(full, {
      sectionProgress: 0,
      documentProgress: 0.2,
    })
    const second = resolveFullSourcePosition(full, {
      sectionProgress: 0,
      documentProgress: 0.8,
    })

    expect(lineAt(full, first)).toBe('flat-80')
    expect(lineAt(full, second)).toBe('flat-320')
    expect(first).not.toBe(second)
  })

  it('captures rendered section progress and falls back on topology mismatch', () => {
    const body = '## A\na\n## B\nb'
    const matching = [
      { level: 2, top: 100 },
      { level: 2, top: 500 },
    ]
    const captured = captureRenderedPosition({
      body,
      headings: matching,
      rootTop: 0,
      rootBottom: 900,
      referenceTop: 300,
    })

    expect(captured).toEqual({
      headingOrdinal: 0,
      sectionProgress: 0.5,
      documentProgress: 1 / 3,
    })
    expect(
      resolveRenderedPosition({
        body,
        headings: matching,
        rootTop: 0,
        rootBottom: 900,
        anchor: captured,
      }),
    ).toBe(300)

    const mismatch = [{ level: 1, top: 100 }, ...matching]
    const fallback = captureRenderedPosition({
      body,
      headings: mismatch,
      rootTop: 0,
      rootBottom: 900,
      referenceTop: 225,
    })

    expect(fallback.headingOrdinal).toBeUndefined()
    expect(
      resolveRenderedPosition({
        body,
        headings: mismatch,
        rootTop: 100,
        rootBottom: 500,
        anchor: { ...captured, documentProgress: 0.25 },
      }),
    ).toBe(200)
  })

  it('uses document progress above the first matching rendered heading', () => {
    const captured = captureRenderedPosition({
      body: 'intro\n## A\nbody',
      headings: [{ level: 2, top: 300 }],
      rootTop: 100,
      rootBottom: 700,
      referenceTop: 200,
    })

    expect(captured.headingOrdinal).toBeUndefined()
    expect(captured.documentProgress).toBeCloseTo(1 / 6)
  })

  it('uses document progress when the frozen anchor source differs from the reader body', () => {
    const body = '## A\na0\na1\n## B\nb0\nTARGET\nb2\n## C\nc0'
    const editedBody = body.replace('## B', '## Inserted\nx0\n## B')
    const full = `# Title\n\n${editedBody}`
    const anchor = captureFullSourcePosition(full, full.indexOf('TARGET'))
    const headings = [
      { level: 2, top: 100 },
      { level: 2, top: 300 },
      { level: 2, top: 500 },
    ]

    expect(
      resolveRenderedPosition({
        body,
        anchorSource: editedBody,
        headings,
        rootTop: 50,
        rootBottom: 700,
        anchor,
      }),
    ).toBeCloseTo(50 + 650 * anchor.documentProgress)
  })

  it('reuses precomputed reader and editor source models across position changes', () => {
    const body = `## Stable\n${'line\n'.repeat(2_000)}`
    const bodyModel = createDocumentBodyPositionModel(body)
    const fullModel = createFullSourcePositionModel(`# Title\n\n${body}`)
    const rendered = [{ level: 2, top: 100 }]
    const first = captureRenderedPosition({
      body: bodyModel,
      headings: rendered,
      rootTop: 50,
      rootBottom: 2_000,
      referenceTop: 500,
    })
    const second = captureRenderedPosition({
      body: bodyModel,
      headings: rendered,
      rootTop: 50,
      rootBottom: 2_000,
      referenceTop: 1_500,
    })

    expect(first.documentProgress).toBeLessThan(second.documentProgress)
    expect(
      captureFullSourcePosition(fullModel, resolveFullSourcePosition(fullModel, second)),
    ).toMatchObject({ headingOrdinal: 0 })
  })

  it('clamps shortened and empty documents without spreading huge input', () => {
    const shortened = '# Title\n\n## Only\nlast'
    const atEnd = resolveFullSourcePosition(shortened, {
      headingOrdinal: 9,
      sectionProgress: 1,
      documentProgress: 1,
    })
    const huge = `# Huge\n\n${'line\n'.repeat(150_000)}`

    expect(atEnd).toBeLessThanOrEqual(shortened.length)
    expect(resolveFullSourcePosition('', { sectionProgress: 1, documentProgress: 1 })).toBe(0)
    expect(
      resolveFullSourcePosition(huge, { sectionProgress: 0, documentProgress: 0.75 }),
    ).toBeGreaterThan(huge.length / 2)
  })
})
