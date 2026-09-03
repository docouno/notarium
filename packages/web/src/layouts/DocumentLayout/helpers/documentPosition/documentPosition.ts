import { promoteBodyTitle } from '@notarium/core'
import { listHeadings } from '@notarium/core/markdown'

export type DocumentPositionAnchor = {
  headingOrdinal?: number
  sectionProgress: number
  documentProgress: number
}

export type RenderedHeadingGeometry = {
  level: number
  top: number
}

type RenderedPositionInput = {
  body: string | DocumentBodyPositionModel
  /** The body whose source topology produced the anchor. A different current
   * reader must degrade to document progress instead of reusing its ordinals. */
  anchorSource?: string
  headings: readonly RenderedHeadingGeometry[]
  rootTop: number
  rootBottom: number
}

const clampProgress = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

const progressBetween = (value: number, start: number, end: number): number =>
  end > start ? clampProgress((value - start) / (end - start)) : 0

const lineStarts = (text: string): number[] => {
  const starts = [0]

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1)
    }
  }

  return starts
}

const lineAtOffset = (starts: readonly number[], offset: number): number => {
  const target = Math.max(0, offset)
  let low = 0
  let high = starts.length - 1

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)

    if (starts[middle] <= target) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return low
}

type SourceHeading = ReturnType<typeof listHeadings>[number]

export type DocumentBodyPositionModel = {
  body: string
  lineStarts: readonly number[]
  headings: readonly SourceHeading[]
}

export type FullSourcePositionModel = {
  source: string
  bodyStart: number
  body: DocumentBodyPositionModel
}

export const createDocumentBodyPositionModel = (body: string): DocumentBodyPositionModel => ({
  body,
  lineStarts: lineStarts(body),
  headings: listHeadings(body),
})

export const createFullSourcePositionModel = (source: string): FullSourcePositionModel => {
  const body = promoteBodyTitle(source).body

  return {
    source,
    bodyStart: source.length - body.length,
    body: createDocumentBodyPositionModel(body),
  }
}

const bodyPositionModel = (body: string | DocumentBodyPositionModel): DocumentBodyPositionModel =>
  typeof body === 'string' ? createDocumentBodyPositionModel(body) : body

const fullSourcePositionModel = (
  source: string | FullSourcePositionModel,
): FullSourcePositionModel =>
  typeof source === 'string' ? createFullSourcePositionModel(source) : source

const renderedTopologyMatches = (
  body: DocumentBodyPositionModel,
  rendered: readonly RenderedHeadingGeometry[],
): boolean => {
  const source = body.headings

  return (
    source.length === rendered.length &&
    source.every((heading, index) => heading.level === rendered[index]?.level)
  )
}

/** Capture a semantic reader position from rendered geometry. Pixel coordinates
 * are consumed here and never become transition identity. */
export const captureRenderedPosition = (
  input: RenderedPositionInput & { referenceTop: number },
): DocumentPositionAnchor => {
  const { body, headings, rootTop, rootBottom, referenceTop } = input
  const model = bodyPositionModel(body)
  const documentProgress = progressBetween(referenceTop, rootTop, rootBottom)

  if (!renderedTopologyMatches(model, headings)) {
    return { sectionProgress: 0, documentProgress }
  }
  let headingOrdinal = -1

  for (let i = 0; i < headings.length; i++) {
    if (headings[i].top <= referenceTop) {
      headingOrdinal = i
    } else {
      break
    }
  }
  if (headingOrdinal < 0) {
    return { sectionProgress: 0, documentProgress }
  }
  const sectionTop = headings[headingOrdinal].top
  const sectionBottom = headings[headingOrdinal + 1]?.top ?? rootBottom

  return {
    headingOrdinal,
    sectionProgress: progressBetween(referenceTop, sectionTop, sectionBottom),
    documentProgress,
  }
}

/** Resolve an anchor against the reader currently on screen. A topology change
 * degrades to whole-document progress instead of guessing a heading. */
export const resolveRenderedPosition = (
  input: RenderedPositionInput & { anchor: DocumentPositionAnchor },
): number => {
  const { body, anchorSource, headings, rootTop, rootBottom, anchor } = input
  const model = bodyPositionModel(body)
  const ordinal = anchor.headingOrdinal

  if (
    (anchorSource === undefined || anchorSource === model.body) &&
    ordinal !== undefined &&
    ordinal >= 0 &&
    ordinal < headings.length &&
    renderedTopologyMatches(model, headings)
  ) {
    const sectionTop = headings[ordinal].top
    const sectionBottom = headings[ordinal + 1]?.top ?? rootBottom

    return sectionTop + (sectionBottom - sectionTop) * clampProgress(anchor.sectionProgress)
  }

  return rootTop + (rootBottom - rootTop) * clampProgress(anchor.documentProgress)
}

const bodyLineForAnchor = (
  body: DocumentBodyPositionModel,
  anchor: DocumentPositionAnchor,
): number => {
  const starts = body.lineStarts
  const headings = body.headings
  const ordinal = anchor.headingOrdinal

  if (ordinal !== undefined && ordinal >= 0 && ordinal < headings.length) {
    const start = headings[ordinal].line
    const end = headings[ordinal + 1]?.line ?? starts.length
    const length = Math.max(1, end - start)

    return Math.min(end - 1, start + Math.floor(clampProgress(anchor.sectionProgress) * length))
  }

  return Math.min(
    starts.length - 1,
    Math.floor(clampProgress(anchor.documentProgress) * starts.length),
  )
}

/** Map a reader anchor into the full editor document. promoteBodyTitle owns the
 * synthetic leading title split, so body heading ordinals never count that H1. */
export const resolveFullSourcePosition = (
  fullSource: string | FullSourcePositionModel,
  anchor: DocumentPositionAnchor,
): number => {
  const model = fullSourcePositionModel(fullSource)
  const bodyLine = bodyLineForAnchor(model.body, anchor)

  return Math.max(
    0,
    Math.min(model.source.length, model.bodyStart + model.body.lineStarts[bodyLine]),
  )
}

/** Convert a CodeMirror source position back to the same body-relative anchor
 * model. The position is measured in source-line space, not in editor pixels. */
export const captureFullSourcePosition = (
  fullSource: string | FullSourcePositionModel,
  sourcePosition: number,
): DocumentPositionAnchor => {
  const model = fullSourcePositionModel(fullSource)
  const body = model.body.body
  const starts = model.body.lineStarts
  const bodyOffset = Math.max(0, Math.min(body.length, sourcePosition - model.bodyStart))
  const line = lineAtOffset(starts, bodyOffset)
  const headings = model.body.headings
  let headingOrdinal = -1

  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line <= line) {
      headingOrdinal = i
    } else {
      break
    }
  }
  const documentProgress = clampProgress(line / starts.length)

  if (headingOrdinal < 0) {
    return { sectionProgress: 0, documentProgress }
  }
  const sectionStart = headings[headingOrdinal].line
  const sectionEnd = headings[headingOrdinal + 1]?.line ?? starts.length
  const sectionLength = Math.max(1, sectionEnd - sectionStart)

  return {
    headingOrdinal,
    sectionProgress: clampProgress((line - sectionStart) / sectionLength),
    documentProgress,
  }
}
