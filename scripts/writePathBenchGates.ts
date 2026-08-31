// Repeatable shape gates for the document work removed from the read/write path.
// Timings compare the pinned pre-change lexer, the current extractor and its floor
// in one process. Semantic checks keep token, link-order, offset and rewrite identity.

import { Marked, type TokenizerAndRendererExtension } from 'marked'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  hasDollarMathPair,
  matchMathBlock,
  matchMathInline,
  mathBlockStart,
  mathInlineStart,
  normalizeWikilinkTarget,
  parseFrontmatterBlock,
  parseWikilinks,
  rewriteWikilinkIdentities,
  stripFrontmatter,
  wikilinkPrefix,
} from '@notarium/core'
import {
  type LocatedWikilink,
  locateWikilinks,
  WIKILINK_TOKEN,
} from '../packages/core/src/libs/markdown/wikilinks/tokenOffsets'

const KIB = 1024
const BODY_BYTES = 830 * KIB
const SCALE_BYTES = [100 * KIB, 200 * KIB, 400 * KIB, BODY_BYTES] as const
const PROBE_LINK = '[[notarium-id:write-path-bench-target]]'
const INLINE_PROBE = ` ${PROBE_LINK}`
const BLOCK_PROBE = `\n\n${PROBE_LINK}`

const envInteger = (name: string, minimum: number, fallback: number): number => {
  const raw = process.env[name]

  if (raw === undefined) {
    return fallback
  }
  const parsed = Number(raw)

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }

  return parsed
}

const SAMPLES = envInteger('WRITE_PATH_SAMPLES', 30, 30)
const SCALE_SAMPLES = envInteger('WRITE_PATH_SCALE_SAMPLES', 5, 5)
const SEMANTIC_CASES = envInteger('WRITE_PATH_SEMANTIC_CASES', 150_000, 150_000)

type Stats = { medianMs: number; p95Ms: number; maxMs: number }
type PairedStats = {
  candidate: Stats
  floor: Stats
  ratios: Stats
}
type ComparedStats = {
  before: Stats
  candidate: Stats
  floor: Stats
  candidateFloorRatios: Stats
  gains: Stats
}
type SuffixWork = { blockChars: number; inlineChars: number; totalChars: number }
type BenchBody = { body: string; name: string; recordedBeforeMs: number | null }
type BodyStats = ComparedStats & {
  blockGateOpen: boolean
  bytes: number
  inlineGateOpen: boolean
  linkCount: number
  loadAdjustedRecorded?: {
    candidateMedianMs: number
    gain: number
    loadFactor: number
    recordedBeforeMs: number
  }
  suffixWork: SuffixWork
}

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * p) - 1] ?? 0
}

const stats = (values: readonly number[]): Stats => ({
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: Math.max(...values),
})

export const candidateFloorFailure = (
  name: string,
  result: Pick<ComparedStats, 'candidate' | 'floor' | 'candidateFloorRatios'>,
  bound = 3.5,
): string | null => {
  const medianRatio = result.candidateFloorRatios.medianMs
  const p95Ratio = result.candidate.p95Ms / result.floor.p95Ms

  return medianRatio > bound || p95Ratio > bound
    ? `${name}: candidate/floor median=${medianRatio.toFixed(2)} p95=${p95Ratio.toFixed(2)} exceeds ${bound.toFixed(1)} (paired-ratio p95=${result.candidateFloorRatios.p95Ms.toFixed(2)} diagnostic)`
    : null
}

const timed = (task: () => unknown): number => {
  const started = performance.now()

  task()
  return performance.now() - started
}

const measure = (task: () => unknown, samples: number, warmups = 2): Stats => {
  for (let index = 0; index < warmups; index++) {
    task()
  }

  return stats(Array.from({ length: samples }, () => timed(task)))
}

const paired = (candidate: () => unknown, floor: () => unknown, samples: number): PairedStats => {
  const candidateMs: number[] = []
  const floorMs: number[] = []
  const ratios: number[] = []

  candidate()
  floor()
  for (let index = 0; index < samples; index++) {
    let candidateSample: number
    let floorSample: number

    if (index % 2 === 0) {
      floorSample = timed(floor)
      candidateSample = timed(candidate)
    } else {
      candidateSample = timed(candidate)
      floorSample = timed(floor)
    }
    candidateMs.push(candidateSample)
    floorMs.push(floorSample)
    ratios.push(candidateSample / floorSample)
  }

  return { candidate: stats(candidateMs), floor: stats(floorMs), ratios: stats(ratios) }
}

const compared = (
  before: () => unknown,
  candidate: () => unknown,
  floor: () => unknown,
): ComparedStats => {
  const beforeMs: number[] = []
  const candidateMs: number[] = []
  const floorMs: number[] = []
  const candidateFloorRatios: number[] = []
  const gains: number[] = []

  before()
  candidate()
  floor()
  for (let index = 0; index < SAMPLES; index++) {
    let beforeSample = 0
    let candidateSample = 0
    let floorSample = 0

    const runBefore = (): void => {
      beforeSample = timed(before)
    }

    const runCandidate = (): void => {
      candidateSample = timed(candidate)
    }

    const runFloor = (): void => {
      floorSample = timed(floor)
    }
    const orders = [
      [runBefore, runCandidate, runFloor],
      [runCandidate, runFloor, runBefore],
      [runFloor, runBefore, runCandidate],
    ] as const

    for (const run of orders[index % orders.length]) {
      run()
    }
    beforeMs.push(beforeSample)
    candidateMs.push(candidateSample)
    floorMs.push(floorSample)
    candidateFloorRatios.push(candidateSample / floorSample)
    gains.push(beforeSample / candidateSample)
  }

  return {
    before: stats(beforeMs),
    candidate: stats(candidateMs),
    floor: stats(floorMs),
    candidateFloorRatios: stats(candidateFloorRatios),
    gains: stats(gains),
  }
}

const fit = (pattern: string, size = BODY_BYTES): string =>
  pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size)

const withProbe = (body: string, probe: string): string =>
  `${body.slice(0, body.length - probe.length)}${probe}`

const withInlineProbe = (body: string): string => withProbe(body, INLINE_PROBE)
const withBlockProbe = (body: string): string => withProbe(body, BLOCK_PROBE)

const proseLine =
  'alpha beta gamma delta epsilon zeta eta theta technical prose keeps the markdown body stable'

const paragraphs = (linesPerParagraph: number, marker = '', size = BODY_BYTES): string => {
  const paragraph = Array.from({ length: linesPerParagraph }, () => proseLine).join('\n')
  const body = fit(`${paragraph}\n\n`, size)
  return marker ? `${marker}\n${body.slice(marker.length + 1)}` : body
}

const denseInlineResidual = (size = BODY_BYTES): string => {
  const unit = `${'a'.repeat(39)}[`
  return `$ ${fit(unit, size).slice(2)}`
}

const blockResidual = (size = BODY_BYTES): string => {
  const chunks: string[] = []
  let length = 0
  const proseChunk = fit(`${'a'.repeat(39)}[`, 5_000)

  for (let paragraph = 0; length < size; paragraph++) {
    const chunk = paragraph % 6 === 0 ? '$$\nx + y\n$$' : proseChunk

    chunks.push(chunk)
    length += chunk.length + (chunks.length === 1 ? 0 : 2)
  }

  return chunks.join('\n\n').slice(0, size)
}

const realisticExport = (size = BODY_BYTES): string => {
  const unit = `${proseLine}\n\n\`\`\`ts\nconst price = '$5'\nconst path = 'C:\\\\vault'\n\`\`\`\n\n`
  const contentBytes = size - BLOCK_PROBE.length
  const completeUnits = unit.repeat(Math.floor(contentBytes / unit.length))
  const proseTail = fit(`${proseLine} `, contentBytes - completeUnits.length)

  return `${completeUnits}${proseTail}${BLOCK_PROBE}`
}

const scaleBodies = (size: number): Array<{ body: string; name: string }> => [
  { name: 'one-none', body: withInlineProbe(fit(`${proseLine} ! `, size)) },
  {
    name: 'one-dollar',
    body: withInlineProbe(`$ ${fit(`${proseLine} ! `, size).slice(2)}`),
  },
  {
    name: 'one-double-dollar',
    body: withInlineProbe(`$$x$$ ${fit(`${proseLine} ! `, size).slice(6)}`),
  },
  {
    name: 'one-bracket',
    body: withInlineProbe(`\\[x\\] ${fit(`${proseLine} ! `, size).slice(7)}`),
  },
  { name: 'paragraphs-8-none', body: withBlockProbe(paragraphs(8, '', size)) },
  {
    name: 'paragraphs-8-dollar',
    body: withBlockProbe(paragraphs(8, '$ price marker', size)),
  },
  {
    name: 'paragraphs-8-double-dollar',
    body: withBlockProbe(paragraphs(8, '$$\nx\n$$', size)),
  },
  {
    name: 'paragraphs-8-bracket',
    body: withBlockProbe(paragraphs(8, '\\[\nx\n\\]', size)),
  },
  { name: 'paragraphs-3-none', body: withBlockProbe(paragraphs(3, '', size)) },
  {
    name: 'paragraphs-3-dollar',
    body: withBlockProbe(paragraphs(3, '$ price marker', size)),
  },
  {
    name: 'paragraphs-3-double-dollar',
    body: withBlockProbe(paragraphs(3, '$$\nx\n$$', size)),
  },
  {
    name: 'paragraphs-3-bracket',
    body: withBlockProbe(paragraphs(3, '\\[\nx\n\\]', size)),
  },
]

const boundedBodies = (): BenchBody[] => [
  {
    name: 'one-none',
    body: withInlineProbe(fit(`${proseLine} ! `)),
    recordedBeforeMs: 656.2,
  },
  {
    name: 'one-dollar-first-bracket',
    body: withInlineProbe(`$ [ ${fit(`${proseLine} ! `).slice(4)}`),
    recordedBeforeMs: 662.2,
  },
  {
    name: 'E-inline-stop-1-per-40',
    body: withInlineProbe(denseInlineResidual()),
    recordedBeforeMs: null,
  },
  {
    name: 'one-double-dollar',
    body: withInlineProbe(`$$x$$ ${fit(`${proseLine} ! `).slice(6)}`),
    recordedBeforeMs: 676.3,
  },
  {
    name: 'one-bracket',
    body: withInlineProbe(`\\[x\\] ${fit(`${proseLine} ! `).slice(7)}`),
    recordedBeforeMs: 664.6,
  },
  {
    name: 'paragraphs-8-none',
    body: withBlockProbe(paragraphs(8)),
    recordedBeforeMs: 360.2,
  },
  {
    name: 'paragraphs-8-dollar',
    body: withBlockProbe(paragraphs(8, '$ price marker')),
    recordedBeforeMs: 362.8,
  },
  {
    name: 'paragraphs-8-double-dollar',
    body: withBlockProbe(paragraphs(8, '$$\nx\n$$')),
    recordedBeforeMs: 366.1,
  },
  {
    name: 'paragraphs-8-bracket',
    body: withBlockProbe(paragraphs(8, '\\[\nx\n\\]')),
    recordedBeforeMs: 362.9,
  },
  {
    name: 'paragraphs-3-double-dollar',
    body: withBlockProbe(paragraphs(3, '$$\nx\n$$')),
    recordedBeforeMs: 826.3,
  },
  {
    name: 'F-display-every-sixth-paragraph',
    body: withBlockProbe(blockResidual()),
    recordedBeforeMs: 493.7,
  },
  {
    name: 'realistic-export',
    body: realisticExport(),
    recordedBeforeMs: 1_443.8,
  },
]

const floorMarkdown = new Marked({ gfm: true, breaks: true })

const previousMathBlockStart = (source: string): number | undefined => {
  const match = /\n {0,3}(?:\$\$|\\\[)/.exec(source)
  return match ? match.index + 1 : undefined
}

const previousMathInlineStart = (source: string): number | undefined => {
  const match = /\$|\\[([]/.exec(source)
  return match?.index
}

type LinkToken = { type: typeof WIKILINK_TOKEN; raw: string; target: string }

const wikilinkTokenizer = (source: string): LinkToken | undefined => {
  const match = wikilinkPrefix(source)
  return match ? { type: WIKILINK_TOKEN, raw: match.raw, target: match.target } : undefined
}

const legacyWikilink: TokenizerAndRendererExtension = {
  name: WIKILINK_TOKEN,
  level: 'inline',
  start: (source) => {
    const index = source.indexOf('[[')
    return index === -1 ? undefined : index
  },
  tokenizer: wikilinkTokenizer,
}

const legacyMathBlock: TokenizerAndRendererExtension = {
  name: 'notariumMathBlock',
  level: 'block',
  start: previousMathBlockStart,
  tokenizer: (source) => {
    const match = matchMathBlock(source)
    return match ? { type: 'notariumMathBlock', raw: match.raw } : undefined
  },
}

const legacyMathInline: TokenizerAndRendererExtension = {
  name: 'notariumMathInline',
  level: 'inline',
  start: previousMathInlineStart,
  tokenizer: (source) => {
    const match = matchMathInline(source)
    return match ? { type: 'notariumMathInline', raw: match.raw } : undefined
  },
}

const legacyMarkdown = new Marked({ gfm: true, breaks: true })
legacyMarkdown.use({ extensions: [legacyWikilink, legacyMathBlock, legacyMathInline] })

let candidateInlineGate: boolean | undefined
let candidateBlockGate: boolean | undefined
let activeSuffixWork: SuffixWork | null = null

const candidateWikilink: TokenizerAndRendererExtension = {
  name: WIKILINK_TOKEN,
  level: 'inline',
  tokenizer: wikilinkTokenizer,
}
const candidateMathBlock: TokenizerAndRendererExtension = {
  name: 'notariumMathBlock',
  level: 'block',
  start: (source) => {
    if (candidateBlockGate === false) {
      return undefined
    }
    if (activeSuffixWork) {
      activeSuffixWork.blockChars += source.length
      activeSuffixWork.totalChars += source.length
    }

    return mathBlockStart(source)
  },
  tokenizer: legacyMathBlock.tokenizer,
}
const candidateMathInline: TokenizerAndRendererExtension = {
  name: 'notariumMathInline',
  level: 'inline',
  start: (source) => {
    if (candidateInlineGate === false) {
      return undefined
    }
    if (activeSuffixWork) {
      activeSuffixWork.inlineChars += source.length
      activeSuffixWork.totalChars += source.length
    }

    return mathInlineStart(source)
  },
  tokenizer: legacyMathInline.tokenizer,
}
const candidateMarkdown = new Marked({ gfm: true, breaks: true })
candidateMarkdown.use({ extensions: [candidateWikilink, candidateMathBlock, candidateMathInline] })

const candidateTokens = (source: string, countSuffixes = false) => {
  const previousInlineGate = candidateInlineGate
  const previousBlockGate = candidateBlockGate
  const previousSuffixWork = activeSuffixWork
  const suffixWork: SuffixWork = { blockChars: 0, inlineChars: 0, totalChars: 0 }

  candidateInlineGate = hasDollarMathPair(source)
  candidateBlockGate = source.includes('$$') || source.includes('\\[')
  activeSuffixWork = countSuffixes ? suffixWork : null
  try {
    return { suffixWork, tokens: candidateMarkdown.lexer(source) }
  } finally {
    candidateInlineGate = previousInlineGate
    candidateBlockGate = previousBlockGate
    activeSuffixWork = previousSuffixWork
  }
}

const normalizedLinks = (tokens: unknown[], source: string): LocatedWikilink[] =>
  locateWikilinks(tokens, source)
    .map((link) => ({ ...link, target: normalizeWikilinkTarget(link.target) }))
    .filter((link) => link.target !== '')

const legacyReading = (source: string) => {
  const tokens = legacyMarkdown.lexer(source)
  return { links: normalizedLinks(tokens, source), tokens }
}

const legacyParseWikilinks = (source: string): string[] =>
  legacyReading(source).links.map((link) => link.target)

const loadAdjustedRecorded = (
  result: ComparedStats,
  recordedBeforeMs: number | null,
): BodyStats['loadAdjustedRecorded'] => {
  if (recordedBeforeMs === null) {
    return undefined
  }
  const loadFactor = result.before.medianMs / recordedBeforeMs
  const candidateMedianMs = result.candidate.medianMs / loadFactor

  return {
    candidateMedianMs,
    gain: recordedBeforeMs / candidateMedianMs,
    loadFactor,
    recordedBeforeMs,
  }
}

const byteSafeRewrite = (source: string, before: readonly string[]): string | null => {
  const ids = new Set([...source.matchAll(/notarium-id:(s\d+)/g)].map((match) => match[1]))
  const mapping = new Map([...ids].map((id) => [id, `t${id.slice(1)}`]))
  let rewritten: string

  try {
    rewritten = rewriteWikilinkIdentities(source, mapping)
  } catch (error) {
    return `rewrite refused: ${(error as Error).message}`
  }
  const expected = before.map((target) => target.replace('notarium-id:s', 'notarium-id:t'))

  if (JSON.stringify(parseWikilinks(rewritten)) !== JSON.stringify(expected)) {
    return 'rewritten links differ from the legacy reading'
  }
  if (rewritten.length !== source.length) {
    return 'rewrite changed document length'
  }
  for (let index = 0; index < source.length; index++) {
    if (source[index] === rewritten[index]) {
      continue
    }
    if (
      source[index] !== 's' ||
      rewritten[index] !== 't' ||
      !source.startsWith('notarium-id:', index - 12)
    ) {
      return `rewrite changed an unrelated byte at ${index}`
    }
  }

  return null
}

type SemanticForm = { cases: string[]; name: string }

const semanticForms = (): SemanticForm[] => {
  const link = (index: number): string => `[[notarium-id:s${String(index).padStart(3, '0')}]]`

  return [
    { name: 'plain-no-markers', cases: ['plain text', `plain text\n\n${link(1)}`] },
    { name: 'plain-link', cases: [`prose ${link(2)}`] },
    { name: 'fenced-code', cases: [`\`\`\`md\n${link(3)}\n\`\`\`\n\n${link(4)}`] },
    { name: 'indented-code', cases: [`    ${link(5)}\n\n${link(6)}`] },
    { name: 'code-span', cases: [`\`${link(7)}\` and ${link(8)}`] },
    { name: 'table-cell', cases: [`| ${link(9)} |\n| --- |`] },
    { name: 'headings', cases: [`# ${link(10)}\n\nTitle ${link(11)}\n---`] },
    { name: 'containers', cases: [`> - ${link(12)}`] },
    { name: 'dollar-math', cases: [`$${link(13)}$ and ${link(14)}`] },
    { name: 'backslash-math', cases: [`\\(${link(15)}\\) and ${link(16)}`] },
    { name: 'escaped-backslashes', cases: [`\\\\(x\\\\) ${link(17)}`] },
    { name: 'spanning-bracket-math', cases: [`\\[\n${link(18)}\n\\]\n\n${link(19)}`] },
    { name: 'display-blocks', cases: [`$$\n${link(20)}\n$$\n\n${link(21)}`] },
    { name: 'dollar-prose', cases: [`cost $5 and $10; ${link(22)}`] },
    { name: 'realistic-export', cases: [`const price = '$5'\n\n${link(23)}`] },
    { name: 'single-bracket', cases: ['[label](url)', `[label](url)\n\n${link(24)}`] },
    { name: 'escaped-markers', cases: [`\\$ \\\\[ ${link(25)}`] },
    { name: 'no-final-newline', cases: [link(26)] },
    { name: 'crlf-tabs', cases: [`>\t${link(27)}\r\n`] },
    { name: 'normalization', cases: [`[[notarium-id:s028|alias]] ${link(29)}`] },
    { name: 'large-one-none', cases: [`${fit(`${proseLine} `)}\n\n${link(30)}`] },
    { name: 'large-paragraphs', cases: [`${paragraphs(8)}\n\n${link(31)}`] },
    { name: 'large-one-dollar', cases: [`$ ${fit(`${proseLine} ! `).slice(2)}\n\n${link(32)}`] },
    { name: 'large-realistic', cases: [`${realisticExport()}\n\n${link(33)}`] },
    { name: 'large-double-dollar', cases: [`${paragraphs(8, '$$\nx\n$$')}\n\n${link(34)}`] },
    { name: 'large-bracket', cases: [`${paragraphs(8, '\\[\nx\n\\]')}\n\n${link(35)}`] },
    { name: 'block-residual', cases: [`${blockResidual()}\n\n${link(36)}`] },
    { name: 'inline-residual', cases: [`${denseInlineResidual()}\n\n${link(37)}`] },
  ]
}

const generatedDocument = (seed: number): string => {
  let state = seed >>> 0
  let linkIndex = 0

  const random = (): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return state
  }

  const nextLink = (): string => {
    const id = `${String(seed).padStart(6, '0')}${String(linkIndex++).padStart(2, '0')}`
    return `[[notarium-id:s${id}]]`
  }

  const fragment = (choice: number): string => {
    switch (choice) {
      case 0:
        return `prose ${nextLink()}`
      case 1:
        return `\`${nextLink()}\``
      case 2:
        return `> quoted ${nextLink()}`
      case 3:
        return `- item ${nextLink()}`
      case 4:
        return `| ${nextLink()} |\n| --- |`
      case 5:
        return `$x$ ${nextLink()}`
      case 6:
        return `\\(${nextLink()}\\) outside ${nextLink()}`
      case 7:
        return `\`\`\`md\n${nextLink()}\n\`\`\``
      case 8:
        return `cost $5 and $10 ${nextLink()}`
      default:
        return `\\${nextLink()}`
    }
  }
  const count = 2 + (random() % 5)
  const selected: string[] = []

  for (let index = 0; index < count; index++) {
    selected.push(fragment(random() % 10))
  }
  const separator = random() % 4 === 0 ? '\r\n\r\n' : '\n\n'
  const body = selected.join(separator)
  return random() % 5 === 0 ? body : `${body}${separator}`
}

const semanticFailures = (): { failures: string[]; namedCases: number; namedForms: number } => {
  const failures: string[] = []
  let differences = 0
  const forms = semanticForms()
  let namedCases = 0

  const fail = (message: string): void => {
    differences++
    if (failures.length < 20) {
      failures.push(message)
    }
  }

  const check = (name: string, source: string): void => {
    const legacy = legacyReading(source)
    const candidate = candidateTokens(source)
    const candidateLinks = normalizedLinks(candidate.tokens, source)
    const legacyTargets = legacy.links.map((link) => link.target)
    const productTargets = parseWikilinks(source)

    if (JSON.stringify(legacy.tokens) !== JSON.stringify(candidate.tokens)) {
      fail(`${name}: token tree differs from the pinned legacy lexer`)
      return
    }
    if (JSON.stringify(legacy.links) !== JSON.stringify(candidateLinks)) {
      fail(
        `${name}: links/offsets ${JSON.stringify(candidateLinks)} != ${JSON.stringify(legacy.links)}`,
      )
      return
    }
    if (JSON.stringify(productTargets) !== JSON.stringify(legacyTargets)) {
      fail(
        `${name}: product targets ${JSON.stringify(productTargets)} != ${JSON.stringify(legacyTargets)}`,
      )
      return
    }
    const rewriteFailure = byteSafeRewrite(source, legacyTargets)

    if (rewriteFailure) {
      fail(`${name}: ${rewriteFailure}`)
    }
  }

  for (const form of forms) {
    form.cases.forEach((source, index) => check(`${form.name}-${index + 1}`, source))
    namedCases += form.cases.length
  }
  for (let seed = 1; seed <= SEMANTIC_CASES; seed++) {
    check(`generated-${seed}`, generatedDocument(seed))
  }
  if (differences > failures.length) {
    failures.push(`${differences - failures.length} additional semantic differences`)
  }

  return { failures, namedCases, namedForms: forms.length }
}

const run = async (): Promise<void> => {
  const failures: string[] = []
  const scale: Record<
    string,
    Record<string, PairedStats & { linkCount: number; suffixWork: SuffixWork }>
  > = {}

  for (const size of SCALE_BYTES) {
    console.error(`bench: scale ${size / KIB} KiB`)
    const rows: Record<string, PairedStats & { linkCount: number; suffixWork: SuffixWork }> = {}

    for (const { body, name } of scaleBodies(size)) {
      const linkCount = parseWikilinks(body).length

      if (linkCount !== 1) {
        failures.push(
          `${name}@${size / KIB}KiB: expected one live probe wikilink, got ${linkCount}`,
        )
      }
      rows[name] = {
        ...paired(
          () => parseWikilinks(body),
          () => floorMarkdown.lexer(body),
          SCALE_SAMPLES,
        ),
        linkCount,
        suffixWork: candidateTokens(body, true).suffixWork,
      }
    }
    scale[`${size / KIB}KiB`] = rows
  }

  const bodies: Record<string, BodyStats> = {}

  for (const { body, name, recordedBeforeMs } of boundedBodies()) {
    console.error(`bench: bounded ${name}`)
    const linkCount = parseWikilinks(body).length

    if (linkCount !== 1) {
      failures.push(`${name}: expected one live probe wikilink, got ${linkCount}`)
    }
    const result = compared(
      () => legacyParseWikilinks(body),
      () => parseWikilinks(body),
      () => floorMarkdown.lexer(body),
    )

    bodies[name] = {
      ...result,
      blockGateOpen: body.includes('$$') || body.includes('\\['),
      bytes: Buffer.byteLength(body),
      inlineGateOpen: body.includes('$'),
      linkCount,
      loadAdjustedRecorded: loadAdjustedRecorded(result, recordedBeforeMs),
      suffixWork: candidateTokens(body, true).suffixWork,
    }
    const floorFailure = candidateFloorFailure(name, result)

    if (floorFailure) {
      failures.push(floorFailure)
    }
    if (result.gains.medianMs < 1) {
      failures.push(
        `${name}: pinned-before/candidate median gain ${result.gains.medianMs.toFixed(2)} is below 1`,
      )
    }
  }

  const frontmatter = Array.from(
    { length: 32 },
    (_, index) => `field-${index}: ${'value'.repeat(6)}`,
  ).join('\n')
  const frontmatterBody = `---\n${frontmatter}\n---\n${fit('body ', 3_400)}`
  const frontmatterFull = measure(() => parseFrontmatterBlock(frontmatterBody), SAMPLES)
  const frontmatterStrip = measure(() => stripFrontmatter(frontmatterBody), SAMPLES)
  const frontmatterRatio = frontmatterStrip.medianMs / frontmatterFull.medianMs
  const noClosing = `---\n${fit('body ', BODY_BYTES - 4)}`
  const noClosingFull = measure(() => parseFrontmatterBlock(noClosing), SAMPLES)
  const noClosingStrip = measure(() => stripFrontmatter(noClosing), SAMPLES)

  if (frontmatterRatio > 0.3) {
    failures.push(`frontmatter strip/full median ratio ${frontmatterRatio.toFixed(3)} exceeds 0.3`)
  }

  const representativeBefore: Record<string, { medianMs: number; p95Ms: number }> = {
    'THIRD_PARTY_NOTICES.md': { medianMs: 193.36, p95Ms: 200.46 },
    'docs/web-ui.md': { medianMs: 2.22, p95Ms: 2.36 },
    'docs/backup.md': { medianMs: 1.29, p95Ms: 1.47 },
  }
  const representatives: Record<
    string,
    ComparedStats & {
      loadAdjustedRecorded: NonNullable<BodyStats['loadAdjustedRecorded']>
      recordedBefore: (typeof representativeBefore)[string]
    }
  > = {}

  for (const [path, recordedBefore] of Object.entries(representativeBefore)) {
    const body = await readFile(path, 'utf8')
    const result = compared(
      () => legacyParseWikilinks(body),
      () => parseWikilinks(body),
      () => floorMarkdown.lexer(body),
    )
    const adjusted = loadAdjustedRecorded(result, recordedBefore.medianMs)!

    representatives[path] = { ...result, loadAdjustedRecorded: adjusted, recordedBefore }
    if (result.gains.medianMs < 1) {
      failures.push(
        `${path}: pinned-before/candidate median gain ${result.gains.medianMs.toFixed(2)} is below 1`,
      )
    }
    const floorFailure = candidateFloorFailure(path, result)

    if (floorFailure) {
      failures.push(floorFailure)
    }
  }

  console.error(`bench: 28 named forms + ${SEMANTIC_CASES} generated semantic cases`)
  const semantics = semanticFailures()
  failures.push(...semantics.failures)
  const report = {
    node: process.version,
    samples: SAMPLES,
    scaleSamples: SCALE_SAMPLES,
    semanticCases: SEMANTIC_CASES,
    bodyBytes: BODY_BYTES,
    scale,
    bodies,
    representatives,
    semantics: { namedForms: semantics.namedForms, namedCases: semantics.namedCases },
    frontmatter: {
      entries32: { full: frontmatterFull, strip: frontmatterStrip, ratio: frontmatterRatio },
      noClosing830KiB: {
        full: noClosingFull,
        strip: noClosingStrip,
        ratio: noClosingStrip.medianMs / noClosingFull.medianMs,
      },
    },
    gate: { passed: failures.length === 0, failures },
  }

  console.log(JSON.stringify(report, null, 2))
  if (failures.length) {
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run()
}
