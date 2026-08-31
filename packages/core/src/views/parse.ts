import {
  CST,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  Lexer,
  type Node,
  type Pair,
  parseDocument,
} from 'yaml'

import {
  type ParsedView,
  type ParsedViewBlock,
  type ParsedViewDocument,
  VIEW_BLOCK_STATUS,
  VIEW_DIAGNOSTIC,
  VIEW_DOCUMENT_LIMIT,
  VIEW_DOCUMENT_VERSION,
  type ViewBlockStatus,
  type ViewDefinition,
  type ViewDiagnostic,
  type ViewDocumentContext,
  type ViewMarkerProof,
  type ViewSourceDefinition,
} from './types'
import { encodeViewRef } from './viewRef'

type PhysicalLine = {
  start: number
  end: number
  next: number
  eol: '\n' | '\r\n'
}

type Fence = {
  char: '`' | '~'
  length: number
  line: PhysicalLine
  nota: boolean
}

const NOTA_HINT = /nota/iu
const YAML_SCALAR = '\u001f'

const lineAt = (text: string, start: number): PhysicalLine | null => {
  if (start >= text.length) {
    return null
  }
  const lf = text.indexOf('\n', start)

  if (lf < 0) {
    return { start, end: text.length, next: text.length, eol: '\n' }
  }
  const crlf = lf > start && text[lf - 1] === '\r'
  return {
    start,
    end: crlf ? lf - 1 : lf,
    next: lf + 1,
    eol: crlf ? '\r\n' : '\n',
  }
}

const openerOf = (text: string, line: PhysicalLine): Fence | null => {
  const raw = text.slice(line.start, line.end)
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(raw)

  if (!match) {
    return null
  }
  const fence = match[2]!
  const info = match[3]!.trim()

  if (fence[0] === '`' && info.includes('`')) {
    return null
  }

  return {
    char: fence[0] as '`' | '~',
    length: fence.length,
    line,
    nota: info.toLowerCase() === 'nota',
  }
}

const closes = (text: string, line: PhysicalLine, opener: Fence): boolean => {
  const raw = text.slice(line.start, line.end)
  const match = /^( {0,3})(`+|~+)[ \t]*$/u.exec(raw)

  return Boolean(match && match[2]![0] === opener.char && match[2]!.length >= opener.length)
}

type ScannedFence = {
  complete: boolean
  eol: '\n' | '\r\n'
  sourceStart: number
  sourceEnd: number
  sourceTextEnd: number
  payloadStart: number
  payloadEnd: number
}

type FenceScan = {
  fences: ScannedFence[]
  total: number
  semanticContent: string
}

const notaFences = function* (raw: string): Generator<ScannedFence> {
  let start = 0
  let line = lineAt(raw, start)

  while (line) {
    const opener = openerOf(raw, line)

    if (!opener) {
      start = line.next
      line = lineAt(raw, start)
      continue
    }
    let cursor = line.next
    let candidate = lineAt(raw, cursor)
    let close: PhysicalLine | null = null

    while (candidate) {
      if (closes(raw, candidate, opener)) {
        close = candidate
        break
      }
      cursor = candidate.next
      candidate = lineAt(raw, cursor)
    }
    if (opener.nota) {
      yield {
        complete: close != null,
        eol: opener.line.eol,
        sourceStart: opener.line.start,
        sourceEnd: close?.next ?? raw.length,
        sourceTextEnd: close?.end ?? raw.length,
        payloadStart: opener.line.next,
        payloadEnd: close?.start ?? raw.length,
      }
    }
    start = close?.next ?? raw.length
    line = lineAt(raw, start)
  }
}

const scanFences = (raw: string): FenceScan => {
  const fences: ScannedFence[] = []
  const semanticSegments: string[] = []
  const semanticChunks: string[] = []
  let semanticCursor = 0
  let total = 0

  const flushSemantic = () => {
    if (semanticChunks.length > 0) {
      semanticSegments.push(semanticChunks.join(''))
      semanticChunks.length = 0
    }
  }

  const appendSemantic = (value: string) => {
    if (value) {
      semanticChunks.push(value)
    }
    if (semanticChunks.length >= 1_024) {
      flushSemantic()
    }
  }

  for (const fence of notaFences(raw)) {
    appendSemantic(raw.slice(semanticCursor, fence.sourceStart))
    appendSemantic(fence.eol + fence.eol)
    semanticCursor = fence.sourceEnd
    if (fences.length < VIEW_DOCUMENT_LIMIT.blocks) {
      fences.push(fence)
    }
    total++
  }

  appendSemantic(raw.slice(semanticCursor))
  flushSemantic()
  return {
    fences,
    total,
    semanticContent: semanticSegments.join(''),
  }
}

/** Exact carrier comparison for generic prose edits. It streams every carrier,
 * including those beyond the parser's bounded diagnostic/result projection. */
export const sameViewCarriers = (left: string, right: string): boolean => {
  if (!NOTA_HINT.test(left) && !NOTA_HINT.test(right)) {
    return true
  }
  const leftFences = notaFences(left)
  const rightFences = notaFences(right)

  while (true) {
    const leftFence = leftFences.next()
    const rightFence = rightFences.next()

    if (leftFence.done || rightFence.done) {
      return leftFence.done === rightFence.done
    }
    const leftSource = left.slice(leftFence.value.sourceStart, leftFence.value.sourceTextEnd)
    const rightSource = right.slice(rightFence.value.sourceStart, rightFence.value.sourceTextEnd)

    if (leftSource !== rightSource) {
      return false
    }
  }
}

/** Replace every carrier without materializing an unbounded range list. The
 * callback may render the bounded parser blocks and erase overflow carriers. */
export const replaceViewCarriers = (
  raw: string,
  replacement: (occurrence: number) => string,
): string => {
  if (!NOTA_HINT.test(raw)) {
    return raw
  }
  const segments: string[] = []
  const chunks: string[] = []
  let cursor = 0
  let occurrence = 0

  const append = (value: string) => {
    if (value) {
      chunks.push(value)
    }
    if (chunks.length >= 1_024) {
      segments.push(chunks.join(''))
      chunks.length = 0
    }
  }

  for (const fence of notaFences(raw)) {
    append(raw.slice(cursor, fence.sourceStart))
    append(replacement(occurrence++))
    cursor = fence.sourceEnd
  }
  if (occurrence === 0) {
    return raw
  }
  append(raw.slice(cursor))
  if (chunks.length > 0) {
    segments.push(chunks.join(''))
  }

  return segments.join('')
}

const utf8BytesWithin = (
  raw: string,
  start: number,
  end: number,
  budget: number,
): number | null => {
  let bytes = 0

  for (let index = start; index < end; index++) {
    const code = raw.charCodeAt(index)

    if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(index + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }

    if (bytes > budget) {
      return null
    }
  }

  return bytes
}

type YamlShape = {
  nodes: number
  tokens: number
  withinLimit: boolean
}

const inspectYamlShape = (payload: string, nodeBudget: number, tokenBudget: number): YamlShape => {
  let nodes = 0
  let tokens = 0
  let flowDepth = 0
  let inlineSequenceDepth = 0
  let atLineStart = true
  let leadingIndent = 0
  const blockIndents = [0]

  for (const lexeme of new Lexer().lex(payload)) {
    tokens++

    if (tokens > tokenBudget) {
      return { nodes, tokens, withinLimit: false }
    }
    const type = CST.tokenType(lexeme)

    if (type === 'newline') {
      atLineStart = true
      leadingIndent = 0
      inlineSequenceDepth = 0
      continue
    }
    if (atLineStart && type === 'space') {
      leadingIndent += lexeme.length
      continue
    }
    if (
      type === 'comment' ||
      type === 'byte-order-mark' ||
      type === 'doc-mode' ||
      type === 'doc-start'
    ) {
      continue
    }
    if (atLineStart) {
      while (blockIndents.length > 1 && blockIndents.at(-1)! > leadingIndent) {
        blockIndents.pop()
      }
      if (leadingIndent > blockIndents.at(-1)!) {
        blockIndents.push(leadingIndent)
      }
      atLineStart = false
    }
    if (type === 'flow-map-end' || type === 'flow-seq-end') {
      flowDepth = Math.max(0, flowDepth - 1)
    }
    if (
      lexeme === YAML_SCALAR ||
      type === 'single-quoted-scalar' ||
      type === 'double-quoted-scalar' ||
      type === 'alias' ||
      type === 'seq-item-ind' ||
      type === 'explicit-key-ind'
    ) {
      nodes++
    } else if (type === 'flow-map-start' || type === 'flow-seq-start') {
      nodes++
      flowDepth++
    }
    if (type === 'seq-item-ind') {
      inlineSequenceDepth++
    }
    const depth = blockIndents.length - 1 + flowDepth + inlineSequenceDepth

    if (nodes > nodeBudget || depth > VIEW_DOCUMENT_LIMIT.yamlDepth) {
      return { nodes, tokens, withinLimit: false }
    }
  }

  return { nodes, tokens, withinLimit: true }
}

const scalarKey = (pair: Pair): string | null => {
  const key = pair.key
  return isScalar(key) && typeof key.value === 'string' ? key.value : null
}

const inspectYaml = (
  node: Node | Pair | null | undefined,
): {
  references: boolean
  duplicateKeys: boolean
} => {
  let references = false
  let duplicateKeys = false

  const visit = (value: Node | Pair | null | undefined): void => {
    if (value == null) {
      return
    }
    if (isPair(value)) {
      if (scalarKey(value) === '<<') {
        references = true
      }
      visit(value.key as Node)
      visit(value.value as Node)
      return
    }
    if (isAlias(value) || ('anchor' in value && typeof value.anchor === 'string')) {
      references = true
    }
    if (isMap(value)) {
      const keys = new Set<string>()

      for (const pair of value.items) {
        const key = scalarKey(pair)

        if (key != null) {
          if (keys.has(key)) {
            duplicateKeys = true
          }
          keys.add(key)
        }
        visit(pair)
      }

      return
    }
    if (isSeq(value)) {
      for (const item of value.items) {
        visit(item as Node)
      }
    }
  }

  visit(node)
  return { references, duplicateKeys }
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const countAstLeaves = (value: unknown): number => {
  const object = objectOf(value)

  if (!object) {
    return 0
  }
  const nodes = Array.isArray(object.nodes) ? object.nodes : null

  if (!nodes) {
    return 1
  }

  return nodes.reduce((total, node) => total + countAstLeaves(node), 0)
}

const parseDefinitions = (
  root: Record<string, unknown>,
  block: number,
  context: ViewDocumentContext | undefined,
): {
  source?: ViewSourceDefinition
  views: ParsedView[]
  diagnostics: ViewDiagnostic[]
  invalid: boolean
  astLeaves: number
  properties: number
} => {
  const diagnostics: ViewDiagnostic[] = []
  const source = objectOf(root.source)
  const sourceKind = source?.kind

  if (!source || typeof sourceKind !== 'string' || !sourceKind.trim()) {
    diagnostics.push({
      code: VIEW_DIAGNOSTIC.invalidSource,
      message: 'source must be a tagged object with a non-empty kind',
      block,
    })
  }
  if (!Array.isArray(root.views) || root.views.length === 0) {
    diagnostics.push({
      code: VIEW_DIAGNOSTIC.invalidViews,
      message: 'views must be a non-empty array',
      block,
    })
    return {
      ...(source && typeof sourceKind === 'string'
        ? { source: source as ViewSourceDefinition }
        : {}),
      views: [],
      diagnostics,
      invalid: true,
      astLeaves: countAstLeaves(source?.filter),
      properties: 0,
    }
  }
  const views: ParsedView[] = []
  const names = new Map<string, number[]>()
  let properties = 0
  let astLeaves = countAstLeaves(source?.filter)

  root.views.forEach((rawView, occurrence) => {
    const view = objectOf(rawView)
    const name = view?.name
    const type = view?.type

    if (
      !view ||
      typeof name !== 'string' ||
      !name.trim() ||
      typeof type !== 'string' ||
      !type.trim()
    ) {
      diagnostics.push({
        code: VIEW_DIAGNOSTIC.invalidView,
        message: 'each view must have a non-empty name and type',
        block,
        view: occurrence,
      })
      return
    }
    const fields = view.fields

    if (
      fields !== undefined &&
      (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string'))
    ) {
      diagnostics.push({
        code: VIEW_DIAGNOSTIC.invalidView,
        message: 'view fields must be an array of property addresses',
        block,
        view: occurrence,
      })
      return
    }
    properties += Array.isArray(fields) ? fields.length : 0
    astLeaves += countAstLeaves(view.filter)
    const indexes = names.get(name) ?? []

    indexes.push(occurrence)
    names.set(name, indexes)
    views.push({
      block,
      occurrence,
      name,
      type,
      definition: view as ViewDefinition,
      ...(context
        ? {
            viewRef: encodeViewRef({
              documentId: context.documentId,
              versionToken: context.versionToken,
              block,
              view: occurrence,
            }),
          }
        : {}),
    })
  })
  for (const [name, occurrences] of names) {
    if (occurrences.length < 2) {
      continue
    }
    for (const occurrence of occurrences) {
      diagnostics.push({
        code: VIEW_DIAGNOSTIC.duplicateViewName,
        message: `duplicate view name: ${name}`,
        block,
        view: occurrence,
      })
    }
  }

  return {
    ...(source && typeof sourceKind === 'string' ? { source: source as ViewSourceDefinition } : {}),
    views,
    diagnostics,
    invalid:
      diagnostics.some((diagnostic) => diagnostic.code !== VIEW_DIAGNOSTIC.duplicateViewName) ||
      views.length === 0,
    astLeaves,
    properties,
  }
}

const primaryOf = (blocks: readonly ParsedViewBlock[]): ViewMarkerProof => {
  if (blocks.length === 0) {
    return { kind: 'absent' }
  }
  const first = blocks[0]!

  return first.status === VIEW_BLOCK_STATUS.ready && first.views[0]
    ? { kind: 'value', value: first.views[0].type }
    : { kind: 'unproven' }
}

const resourceLimitDiagnostic = (block: number): ViewDiagnostic => ({
  code: VIEW_DIAGNOSTIC.resourceLimit,
  message: 'view document exceeds its execution limits',
  block,
})

const limitedBlock = (raw: string, fence: ScannedFence, occurrence: number): ParsedViewBlock => ({
  occurrence,
  complete: fence.complete,
  eol: fence.eol,
  sourceRange: { start: fence.sourceStart, end: fence.sourceEnd },
  payloadRange: { start: fence.payloadStart, end: fence.payloadEnd },
  payload: raw.slice(fence.payloadStart, fence.payloadEnd),
  status: fence.complete ? VIEW_BLOCK_STATUS.resourceLimit : VIEW_BLOCK_STATUS.malformed,
  diagnostics: [
    ...(!fence.complete
      ? [
          {
            code: VIEW_DIAGNOSTIC.incompleteFence,
            message: 'nota fence is not closed',
            block: occurrence,
          } as const,
        ]
      : []),
    resourceLimitDiagnostic(occurrence),
  ],
  views: [],
})

const exceedsPreparseLimits = (raw: string, scan: FenceScan): boolean => {
  if (scan.total > VIEW_DOCUMENT_LIMIT.blocks) {
    return true
  }
  let totalPayloadBytes = 0

  for (const fence of scan.fences) {
    const bytes = utf8BytesWithin(
      raw,
      fence.payloadStart,
      fence.payloadEnd,
      VIEW_DOCUMENT_LIMIT.payloadBytes - totalPayloadBytes,
    )

    if (bytes == null) {
      return true
    }
    totalPayloadBytes += bytes
  }
  let totalYamlNodes = 0
  let totalYamlTokens = 0

  for (const fence of scan.fences) {
    const shape = inspectYamlShape(
      raw.slice(fence.payloadStart, fence.payloadEnd),
      VIEW_DOCUMENT_LIMIT.yamlNodes - totalYamlNodes,
      VIEW_DOCUMENT_LIMIT.yamlTokens - totalYamlTokens,
    )

    if (!shape.withinLimit) {
      return true
    }
    totalYamlNodes += shape.nodes
    totalYamlTokens += shape.tokens
  }

  return false
}

export const parseViewDocument = (
  raw: string,
  context?: ViewDocumentContext,
): ParsedViewDocument => {
  if (!NOTA_HINT.test(raw)) {
    return {
      blocks: [],
      views: [],
      diagnostics: [],
      primaryReader: { kind: 'absent' },
      semanticContent: raw,
    }
  }
  const scan = scanFences(raw)
  const fences = scan.fences

  if (scan.total === 0) {
    return {
      blocks: [],
      views: [],
      diagnostics: [],
      primaryReader: { kind: 'absent' },
      semanticContent: raw,
    }
  }
  if (exceedsPreparseLimits(raw, scan)) {
    const blocks = fences.map((fence, occurrence) => limitedBlock(raw, fence, occurrence))

    return {
      blocks,
      views: [],
      diagnostics: blocks.flatMap((block) => block.diagnostics),
      primaryReader: primaryOf(blocks),
      semanticContent: scan.semanticContent,
    }
  }
  const blocks: ParsedViewBlock[] = []
  let totalViews = 0
  let totalAstLeaves = 0
  let totalProperties = 0
  let executionLimitExceeded = false

  for (const [occurrence, fence] of fences.entries()) {
    if (executionLimitExceeded) {
      blocks.push(limitedBlock(raw, fence, occurrence))
      continue
    }
    const payload = raw.slice(fence.payloadStart, fence.payloadEnd)
    const diagnostics: ViewDiagnostic[] = []
    let status: ViewBlockStatus = VIEW_BLOCK_STATUS.ready
    let source: ViewSourceDefinition | undefined
    let views: ParsedView[] = []
    let yamlDocument: ParsedViewBlock['yamlDocument']

    if (!fence.complete) {
      status = VIEW_BLOCK_STATUS.malformed
      diagnostics.push({
        code: VIEW_DIAGNOSTIC.incompleteFence,
        message: 'nota fence is not closed',
        block: occurrence,
      })
    } else {
      yamlDocument = parseDocument(payload, {
        keepSourceTokens: true,
        prettyErrors: false,
        uniqueKeys: false,
      })
      if (yamlDocument.errors.length > 0) {
        status = VIEW_BLOCK_STATUS.malformed
        diagnostics.push({
          code: VIEW_DIAGNOSTIC.malformedYaml,
          message: yamlDocument.errors[0]?.message ?? 'malformed YAML',
          block: occurrence,
        })
      } else {
        const inspection = inspectYaml(yamlDocument.contents)

        if (inspection.references) {
          status = VIEW_BLOCK_STATUS.readOnly
          diagnostics.push({
            code: VIEW_DIAGNOSTIC.yamlNodeReference,
            message: 'YAML aliases, anchors and merge keys are read-only',
            block: occurrence,
          })
        }
        if (inspection.duplicateKeys) {
          status = VIEW_BLOCK_STATUS.readOnly
          diagnostics.push({
            code: VIEW_DIAGNOSTIC.duplicateSemanticKey,
            message: 'duplicate semantic YAML keys are read-only',
            block: occurrence,
          })
        }
        if (status === VIEW_BLOCK_STATUS.ready) {
          let value: unknown

          try {
            value = yamlDocument.toJS({ maxAliasCount: 0 })
          } catch {
            status = VIEW_BLOCK_STATUS.readOnly
            diagnostics.push({
              code: VIEW_DIAGNOSTIC.yamlNodeReference,
              message: 'YAML node references cannot be executed',
              block: occurrence,
            })
          }
          if (status === VIEW_BLOCK_STATUS.ready) {
            const root = objectOf(value)

            if (!root) {
              status = VIEW_BLOCK_STATUS.malformed
              diagnostics.push({
                code: VIEW_DIAGNOSTIC.invalidRoot,
                message: 'nota payload must be an object',
                block: occurrence,
              })
            } else if (!Number.isInteger(root.version) || Number(root.version) < 1) {
              status = VIEW_BLOCK_STATUS.malformed
              diagnostics.push({
                code: VIEW_DIAGNOSTIC.invalidRoot,
                message: 'nota version must be a positive integer',
                block: occurrence,
              })
            } else if (Number(root.version) > VIEW_DOCUMENT_VERSION) {
              status = VIEW_BLOCK_STATUS.future
              diagnostics.push({
                code: VIEW_DIAGNOSTIC.unsupportedVersion,
                message: `nota version ${String(root.version)} is newer than this client`,
                block: occurrence,
              })
            } else {
              const definitions = parseDefinitions(root, occurrence, context)

              source = definitions.source
              views = definitions.views
              for (const diagnostic of definitions.diagnostics) {
                diagnostics.push(diagnostic)
              }
              totalAstLeaves += definitions.astLeaves
              totalProperties += definitions.properties
              totalViews += views.length
              executionLimitExceeded =
                totalViews > VIEW_DOCUMENT_LIMIT.views ||
                totalAstLeaves > VIEW_DOCUMENT_LIMIT.astLeaves ||
                totalProperties > VIEW_DOCUMENT_LIMIT.properties
              if (definitions.invalid) {
                status = VIEW_BLOCK_STATUS.malformed
              }
            }
          }
        }
      }
    }
    blocks.push({
      occurrence,
      complete: fence.complete,
      eol: fence.eol,
      sourceRange: { start: fence.sourceStart, end: fence.sourceEnd },
      payloadRange: { start: fence.payloadStart, end: fence.payloadEnd },
      payload,
      status,
      diagnostics,
      ...(source ? { source } : {}),
      views,
      ...(yamlDocument ? { yamlDocument } : {}),
    })
  }

  if (executionLimitExceeded) {
    for (const block of blocks) {
      if (block.status === VIEW_BLOCK_STATUS.ready) {
        block.status = VIEW_BLOCK_STATUS.resourceLimit
      }
      delete block.source
      delete block.yamlDocument
      block.views = []
      if (
        !block.diagnostics.some((diagnostic) => diagnostic.code === VIEW_DIAGNOSTIC.resourceLimit)
      ) {
        block.diagnostics.push(resourceLimitDiagnostic(block.occurrence))
      }
    }
  }
  const views = blocks.flatMap((block) => block.views)
  const diagnostics = blocks.flatMap((block) => block.diagnostics)

  return {
    blocks,
    views,
    diagnostics,
    primaryReader: primaryOf(blocks),
    semanticContent: scan.semanticContent,
  }
}

export const semanticViewContent = (raw: string): string => parseViewDocument(raw).semanticContent

/** Three-state typed marker channel for a full-body save: value sets, empty clears,
 * and undefined preserves because malformed/future authority cannot be guessed. */
export const viewTypeForBody = (raw: string): string | undefined => {
  const proof = parseViewDocument(raw).primaryReader

  return proof.kind === 'value' ? proof.value : proof.kind === 'absent' ? '' : undefined
}
