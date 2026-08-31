import {
  BASE_52_DIGITS,
  BASE_62_DIGITS,
  generateKeyBetween,
  generateNKeysBetween,
} from 'fractional-indexing'

export const BOARD_RANK_MAX_BYTES = 64
export const BOARD_RANK_JITTER_STEPS = 32

export type RankBitSource = () => 0 | 1

export type BoardRankEntry = {
  noteId: string
  rank: string
}

export type ParsedBoardRanks = {
  entries: Map<string, string>
  diagnostics: string[]
  writable: boolean
}

const rankBytes = (rank: string): number => new TextEncoder().encode(rank).byteLength

export const isValidBoardRank = (rank: string): boolean => {
  if (
    !rank ||
    rankBytes(rank) > BOARD_RANK_MAX_BYTES ||
    !BASE_52_DIGITS.includes(rank[0]!) ||
    [...rank.slice(1)].some((digit) => !BASE_62_DIGITS.includes(digit))
  ) {
    return false
  }
  try {
    generateKeyBetween(rank, null)
    return true
  } catch {
    return false
  }
}

export const parseBoardRanks = (source: string | undefined): ParsedBoardRanks => {
  const entries = new Map<string, string>()
  const diagnostics: string[] = []

  if (!source) {
    return { entries, diagnostics, writable: true }
  }
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      continue
    }
    let tuple: unknown

    try {
      tuple = JSON.parse(line)
    } catch {
      diagnostics.push(`rank line ${index + 1} is not valid JSON`)
      continue
    }
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string'
    ) {
      diagnostics.push(`rank line ${index + 1} is not a [noteId, rank] tuple`)
      continue
    }
    if (entries.has(tuple[0])) {
      diagnostics.push(`rank line ${index + 1} duplicates note ${tuple[0]}`)
      continue
    }
    if (!isValidBoardRank(tuple[1])) {
      diagnostics.push(`rank line ${index + 1} has an invalid rank`)
      continue
    }
    entries.set(tuple[0], tuple[1])
  }

  return { entries, diagnostics, writable: diagnostics.length === 0 }
}

export const compareBoardRank = (left: BoardRankEntry, right: BoardRankEntry): number =>
  left.rank < right.rank
    ? -1
    : left.rank > right.rank
      ? 1
      : left.noteId < right.noteId
        ? -1
        : left.noteId > right.noteId
          ? 1
          : 0

/** Canonical midpoint followed by exactly 32 injected binary half choices. */
export const jitteredBoardRank = (
  previous: string | null,
  next: string | null,
  bit: RankBitSource,
): string => {
  let low = previous
  let high = next
  let rank = generateKeyBetween(low, high)

  for (let step = 0; step < BOARD_RANK_JITTER_STEPS; step++) {
    if (bit() === 0) {
      high = rank
    } else {
      low = rank
    }
    rank = generateKeyBetween(low, high)
  }

  return rank
}

export const rebalanceBoardRanks = (noteIds: readonly string[]): Map<string, string> => {
  const keys = generateNKeysBetween(null, null, noteIds.length)
  return new Map(noteIds.map((noteId, index) => [noteId, keys[index]!]))
}

export const rankNeedsRebalance = (rank: string): boolean => rankBytes(rank) > BOARD_RANK_MAX_BYTES

export const orderByBoardRanks = <T>(
  items: readonly T[],
  ranks: ReadonlyMap<string, string>,
  fields: { id: (item: T) => string; fallback: (left: T, right: T) => number },
): T[] =>
  [...items].sort((left, right) => {
    const leftId = fields.id(left)
    const rightId = fields.id(right)
    const leftRank = ranks.get(leftId)
    const rightRank = ranks.get(rightId)

    if (leftRank !== undefined && rightRank !== undefined) {
      return compareBoardRank(
        { noteId: leftId, rank: leftRank },
        { noteId: rightId, rank: rightRank },
      )
    }
    if (leftRank !== undefined) {
      return -1
    }
    if (rightRank !== undefined) {
      return 1
    }

    return fields.fallback(left, right)
  })
