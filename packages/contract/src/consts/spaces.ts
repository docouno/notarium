export const META_DB = {
  sqlite: 'sqlite',
  postgres: 'postgres',
  none: 'none',
} as const

export type MetaDb = (typeof META_DB)[keyof typeof META_DB]

export const SEARCH_MODE = { fts: 'fts', hybrid: 'hybrid' } as const

export type SearchMode = (typeof SEARCH_MODE)[keyof typeof SEARCH_MODE]
