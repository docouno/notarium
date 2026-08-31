import { type Document, isMap, isScalar, isSeq, type Node, parseDocument, Scalar } from 'yaml'

import { isDurableScalar } from '../libs/id'
import { parseViewDocument, viewTypeForBody } from './parse'
import {
  type ParsedView,
  type ParsedViewBlock,
  type ParsedViewDocument,
  VIEW_BLOCK_STATUS,
  type ViewConfigPatch,
  type ViewObjectPatch,
  type ViewWriteResult,
} from './types'
import { decodeViewRef } from './viewRef'

export class ViewWriteError extends Error {}

type Target = {
  block: ParsedViewBlock
  view: ParsedView
  documentId: string
  versionToken: string
}

const targetOf = (parsed: ParsedViewDocument, viewRef: string): Target => {
  const decoded = decodeViewRef(viewRef)
  const view = parsed.views.find((candidate) => candidate.viewRef === viewRef)

  if (!decoded || !view || view.block !== decoded.block || view.occurrence !== decoded.view) {
    throw new ViewWriteError('viewRef is stale or does not belong to this projection')
  }
  const block = parsed.blocks[view.block]

  if (!block || block.status !== VIEW_BLOCK_STATUS.ready || !block.complete) {
    throw new ViewWriteError('view block is not structurally writable')
  }

  return {
    block,
    view,
    documentId: decoded.documentId,
    versionToken: decoded.versionToken,
  }
}

const verifyPayload = (content: string, block: ParsedViewBlock): void => {
  if (content.slice(block.payloadRange.start, block.payloadRange.end) !== block.payload) {
    throw new ViewWriteError('view block changed after it was parsed')
  }
}

const safePatchKey = (key: string): boolean => Boolean(key) && isDurableScalar(key)

const applyObjectPatch = (
  document: Document.Parsed,
  path: readonly (string | number)[],
  patch: ViewObjectPatch,
): void => {
  for (const key of patch.remove ?? []) {
    if (!safePatchKey(key)) {
      throw new ViewWriteError('view patch contains an invalid key')
    }
    document.deleteIn([...path, key])
  }
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (!safePatchKey(key)) {
      throw new ViewWriteError('view patch contains an invalid key')
    }
    document.setIn([...path, key], value)
  }
}

const parseWritablePayload = (payload: string): Document.Parsed => {
  const document = parseDocument(payload, {
    keepSourceTokens: true,
    prettyErrors: false,
    uniqueKeys: false,
  })

  if (document.errors.length > 0) {
    throw new ViewWriteError('view block is no longer valid YAML')
  }

  return document
}

const normalizeEol = (value: string, eol: '\n' | '\r\n'): string =>
  eol === '\n' ? value : value.replace(/\n/gu, '\r\n')

const validateWrite = (content: string, target: Target): ViewWriteResult => {
  const reparsed = parseViewDocument(content, {
    documentId: target.documentId,
    versionToken: target.versionToken,
  })
  const block = reparsed.blocks[target.block.occurrence]

  if (
    !block ||
    block.status !== VIEW_BLOCK_STATUS.ready ||
    !block.views.some((view) => view.occurrence === target.view.occurrence)
  ) {
    throw new ViewWriteError('view patch produced a non-executable carrier')
  }

  return { content, viewType: viewTypeForBody(content) }
}

/** Structural source/common/options patch. YAML owns formatting inside the target
 * payload; authored bytes before and after that exact range remain byte-identical. */
export const patchViewConfig = (
  content: string,
  parsed: ParsedViewDocument,
  viewRef: string,
  patch: ViewConfigPatch,
): ViewWriteResult => {
  const target = targetOf(parsed, viewRef)

  verifyPayload(content, target.block)
  const document = parseWritablePayload(target.block.payload)

  if (patch.source) {
    applyObjectPatch(document, ['source'], patch.source)
  }
  if (patch.common) {
    applyObjectPatch(document, ['views', target.view.occurrence], patch.common)
  }
  if (patch.options) {
    applyObjectPatch(document, ['views', target.view.occurrence, 'options'], patch.options)
  }
  const payload = normalizeEol(document.toString({ lineWidth: 0 }), target.block.eol)
  const next =
    content.slice(0, target.block.payloadRange.start) +
    payload +
    content.slice(target.block.payloadRange.end)

  return validateWrite(next, target)
}

type BlockScalarToken = {
  type: 'block-scalar'
  offset: number
  indent: number
  props: Array<{ source: string }>
  source: string
}

type PhysicalSourceLine = {
  start: number
  end: number
  next: number
  indent: string
  value: string
}

const sourceLines = (source: string): PhysicalSourceLine[] => {
  const lines: PhysicalSourceLine[] = []
  let start = 0

  while (start < source.length) {
    const lf = source.indexOf('\n', start)
    const next = lf < 0 ? source.length : lf + 1
    const end = lf < 0 ? source.length : lf > start && source[lf - 1] === '\r' ? lf - 1 : lf
    const raw = source.slice(start, end)
    const indent = /^\s*/u.exec(raw)?.[0] ?? ''

    lines.push({ start, end, next, indent, value: raw.slice(indent.length).trimEnd() })
    start = next
  }

  return lines
}

const rankEntries = (
  lines: readonly PhysicalSourceLine[],
): Array<{
  line: PhysicalSourceLine
  id: string
  rank: string
}> => {
  const out: Array<{ line: PhysicalSourceLine; id: string; rank: string }> = []

  for (const line of lines) {
    if (!line.value) {
      continue
    }
    let parsed: unknown

    try {
      parsed = JSON.parse(line.value)
    } catch {
      throw new ViewWriteError('rank scalar contains malformed JSONL')
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      throw new ViewWriteError('rank scalar contains a non-tuple line')
    }
    out.push({ line, id: parsed[0], rank: parsed[1] })
  }

  return out
}

type RankScalar = {
  node: Scalar<string>
  token: BlockScalarToken | null
}

const rankScalarOf = (document: Document.Parsed, occurrence: number): RankScalar | null => {
  const node = document.getIn(['views', occurrence, 'options', 'order', 'ranks'], true)

  if (node == null) {
    return null
  }
  if (!isScalar(node) || typeof node.value !== 'string') {
    throw new ViewWriteError('rank overlay is not a writable scalar')
  }
  const token = node.srcToken as BlockScalarToken | undefined

  return {
    node: node as Scalar<string>,
    token:
      token?.type === 'block-scalar' && token.source != null && token.props != null ? token : null,
  }
}

const copyNodePresentation = (from: Node | null | undefined, to: Node): void => {
  if (!from) {
    return
  }
  to.comment = from.comment
  to.commentBefore = from.commentBefore
  to.spaceBefore = from.spaceBefore
}

const prepareRankPath = (
  document: Document.Parsed,
  occurrence: number,
): Node | null | undefined => {
  const views = document.getIn(['views'], true)
  const view = document.getIn(['views', occurrence], true)
  const options = document.getIn(['views', occurrence, 'options'], true)

  if (!isSeq(views) || !isMap(view) || !isMap(options)) {
    throw new ViewWriteError('view rank path is not structurally writable')
  }
  const orderPath = ['views', occurrence, 'options', 'order'] as const
  const previousOrder = document.getIn(orderPath, true) as Node | null | undefined
  let order = previousOrder

  if (!isMap(order)) {
    const replacement = document.createNode({})

    copyNodePresentation(previousOrder, replacement)
    document.setIn(orderPath, replacement)
    order = replacement
  }
  views.flow = false
  view.flow = false
  options.flow = false
  order.flow = false
  document.setIn([...orderPath, 'kind'], 'manual')

  return document.getIn([...orderPath, 'ranks'], true) as Node | null | undefined
}

const setRankScalar = (
  document: Document.Parsed,
  occurrence: number,
  value: string,
  previous?: Node | null,
): void => {
  const scalar = new Scalar(value)

  scalar.type = Scalar.BLOCK_LITERAL
  copyNodePresentation(previous, scalar)
  document.setIn(['views', occurrence, 'options', 'order', 'ranks'], scalar)
}

const structurallyPutRank = (
  document: Document.Parsed,
  occurrence: number,
  scalar: RankScalar | null,
  noteId: string,
  rank: string | null,
): boolean => {
  const entries = scalar ? rankEntries(sourceLines(scalar.node.value)) : []
  const matches = entries.filter((entry) => entry.id === noteId)

  if (matches.length > 1) {
    throw new ViewWriteError('rank overlay contains a duplicate note id')
  }
  if (rank == null && matches.length === 0) {
    return false
  }
  const next = entries
    .filter((entry) => rank != null || entry.id !== noteId)
    .map((entry) => [entry.id, entry.rank] as [string, string])
  const match = next.find((entry) => entry[0] === noteId)

  if (match && rank != null) {
    match[1] = rank
  } else if (rank != null) {
    next.push([noteId, rank])
  }
  const previous = prepareRankPath(document, occurrence)

  setRankScalar(
    document,
    occurrence,
    next.map((tuple) => JSON.stringify(tuple)).join('\n'),
    previous,
  )

  return true
}

/** Point rank mutation. Existing JSONL tuples are replaced or removed by one exact
 * physical-line splice; creating the scalar falls back to the structural writer. */
export const putViewRank = (
  content: string,
  parsed: ParsedViewDocument,
  viewRef: string,
  noteId: string,
  rank: string | null,
): ViewWriteResult => {
  const target = targetOf(parsed, viewRef)

  verifyPayload(content, target.block)
  const document = parseWritablePayload(target.block.payload)
  const scalar = rankScalarOf(document, target.view.occurrence)

  if (!scalar || !scalar.token) {
    if (!structurallyPutRank(document, target.view.occurrence, scalar, noteId, rank)) {
      return { content, viewType: viewTypeForBody(content) }
    }
    const payload = normalizeEol(document.toString({ lineWidth: 0 }), target.block.eol)
    const next =
      content.slice(0, target.block.payloadRange.start) +
      payload +
      content.slice(target.block.payloadRange.end)

    return validateWrite(next, target)
  }
  const prefixBytes = scalar.token.props.reduce((size, prop) => size + prop.source.length, 0)
  const bodyOffset = scalar.token.offset + prefixBytes
  const lines = sourceLines(scalar.token.source)
  const entries = rankEntries(lines)
  const matches = entries.filter((entry) => entry.id === noteId)

  if (matches.length > 1) {
    throw new ViewWriteError('rank overlay contains a duplicate note id')
  }
  const payloadStart = target.block.payloadRange.start
  let next: string

  if (matches[0]) {
    const line = matches[0].line
    const start = payloadStart + bodyOffset + line.start
    const end = payloadStart + bodyOffset + (rank == null ? line.next : line.end)
    const replacement = rank == null ? '' : `${line.indent}${JSON.stringify([noteId, rank])}`

    next = content.slice(0, start) + replacement + content.slice(end)
  } else if (rank == null) {
    return { content, viewType: viewTypeForBody(content) }
  } else {
    const indent = lines.find((line) => line.value)?.indent ?? ' '.repeat(scalar.token.indent + 2)
    const insertion = `${indent}${JSON.stringify([noteId, rank])}${target.block.eol}`
    const at = payloadStart + bodyOffset + scalar.token.source.length

    next = content.slice(0, at) + insertion + content.slice(at)
  }

  return validateWrite(next, target)
}

/** Named rebalance path: replace the complete JSONL scalar in one structured write
 * while preserving every sibling/unknown YAML node and all bytes outside the payload. */
export const replaceViewRanks = (
  content: string,
  parsed: ParsedViewDocument,
  viewRef: string,
  entries: ReadonlyMap<string, string>,
): ViewWriteResult => {
  const target = targetOf(parsed, viewRef)

  verifyPayload(content, target.block)
  const document = parseWritablePayload(target.block.payload)
  const ranks = [...entries].map((tuple) => JSON.stringify(tuple)).join('\n')

  const previous = prepareRankPath(document, target.view.occurrence)

  setRankScalar(document, target.view.occurrence, ranks, previous)
  const payload = normalizeEol(document.toString({ lineWidth: 0 }), target.block.eol)
  const next =
    content.slice(0, target.block.payloadRange.start) +
    payload +
    content.slice(target.block.payloadRange.end)

  return validateWrite(next, target)
}
