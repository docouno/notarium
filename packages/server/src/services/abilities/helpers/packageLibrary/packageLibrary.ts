import type { AgentPackageLibraryFacets, AgentPackageLibraryQuery } from '@notarium/contract'
import type { ProjectSummary } from '@notarium/contract/tools'

export type PackageLibraryCandidate<T> = {
  item: T
  name: string
  description: string
  source: 'system' | 'catalog' | 'owned'
  home?: 'personal' | 'space'
  availability?: 'all' | 'selected'
  projects: readonly string[]
  identity: string
}

type PackageLibraryCursor = {
  v: 1
  filter: string
  key: [string, string, string, string]
}

export class PackageLibraryCursorError extends Error {}

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase()

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const keyOf = <T>(candidate: PackageLibraryCandidate<T>): PackageLibraryCursor['key'] => [
  normalize(candidate.name),
  candidate.source,
  candidate.home ?? '',
  candidate.identity,
]

const compareKey = (
  left: PackageLibraryCursor['key'],
  right: PackageLibraryCursor['key'],
): number => {
  for (let index = 0; index < left.length; index++) {
    const compared = compareText(left[index], right[index])

    if (compared !== 0) {
      return compared
    }
  }

  return 0
}

const filterFingerprint = (query: AgentPackageLibraryQuery): string =>
  JSON.stringify({
    q: query.q ? normalize(query.q) : null,
    source: query.source ?? null,
    home: query.home ?? null,
    availability: query.availability ?? null,
    project: query.project ?? null,
    spaceId: query.spaceId ?? null,
  })

const encodeCursor = (cursor: PackageLibraryCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const decodeCursor = (
  raw: string | undefined,
  fingerprint: string,
): PackageLibraryCursor['key'] | undefined => {
  if (!raw) {
    return undefined
  }

  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<PackageLibraryCursor>

    if (
      value.v === 1 &&
      value.filter === fingerprint &&
      Array.isArray(value.key) &&
      value.key.length === 4 &&
      value.key.every((part) => typeof part === 'string')
    ) {
      return value.key as PackageLibraryCursor['key']
    }
  } catch {
    throw new PackageLibraryCursorError('bad cursor')
  }

  throw new PackageLibraryCursorError('bad cursor')
}

const matchesSearch = <T>(candidate: PackageLibraryCandidate<T>, query: string | undefined) => {
  if (!query) {
    return true
  }
  const needle = normalize(query)
  return (
    normalize(candidate.name).includes(needle) || normalize(candidate.description).includes(needle)
  )
}

const matchesFilters = <T>(
  candidate: PackageLibraryCandidate<T>,
  query: AgentPackageLibraryQuery,
): boolean =>
  (!query.source || candidate.source === query.source) &&
  (!query.home || candidate.home === query.home) &&
  (!query.availability || candidate.availability === query.availability) &&
  (!query.project || candidate.projects.includes(query.project))

const facetsOf = <T>(
  candidates: readonly PackageLibraryCandidate<T>[],
  projects: readonly ProjectSummary[],
): AgentPackageLibraryFacets => ({
  source: {
    system: candidates.filter(({ source }) => source === 'system').length,
    catalog: candidates.filter(({ source }) => source === 'catalog').length,
    owned: candidates.filter(({ source }) => source === 'owned').length,
  },
  home: {
    personal: candidates.filter(({ home }) => home === 'personal').length,
    space: candidates.filter(({ home }) => home === 'space').length,
  },
  availability: {
    all: candidates.filter(({ availability }) => availability === 'all').length,
    selected: candidates.filter(({ availability }) => availability === 'selected').length,
  },
  projects: projects.map((project) => ({
    project,
    count: candidates.filter((candidate) => candidate.projects.includes(project.handle)).length,
  })),
})

export const pagePackageLibrary = <T>({
  candidates,
  projects,
  query,
}: {
  candidates: readonly PackageLibraryCandidate<T>[]
  projects: readonly ProjectSummary[]
  query: AgentPackageLibraryQuery
}): {
  items: T[]
  filteredTotal: number
  nextCursor: string | null
  facets: AgentPackageLibraryFacets
} => {
  const searched = candidates.filter((candidate) => matchesSearch(candidate, query.q))
  const filtered = searched
    .filter((candidate) => matchesFilters(candidate, query))
    .sort((left, right) => compareKey(keyOf(left), keyOf(right)))
  const fingerprint = filterFingerprint(query)
  const after = decodeCursor(query.cursor, fingerprint)
  const start = after
    ? filtered.findIndex((candidate) => compareKey(keyOf(candidate), after) > 0)
    : 0
  const pageStart = start < 0 ? filtered.length : start
  const page = filtered.slice(pageStart, pageStart + query.limit)
  const hasMore = pageStart + page.length < filtered.length
  const last = hasMore ? page.at(-1) : undefined

  return {
    items: page.map(({ item }) => item),
    filteredTotal: filtered.length,
    nextCursor: last ? encodeCursor({ v: 1, filter: fingerprint, key: keyOf(last) }) : null,
    facets: facetsOf(searched, projects),
  }
}
