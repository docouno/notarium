/** `/api/*` query-param key names, compile-time bound to the wire query schemas by
 *  `schemas/queryKeysGuard.ts`. canon: docs/contract.md#wire-consts */
export const QUERY_KEY = {
  sort: 'sort',
  offset: 'offset',
  limit: 'limit',
  folder: 'folder',
  depth: 'depth',
  folders: 'folders',
  tags: 'tags',
  q: 'q',
  from: 'from',
  to: 'to',
  tz: 'tz',
  dateField: 'dateField',
  favorite: 'favorite',
  preview: 'preview',
  group: 'group',
  author: 'author',
  tool: 'tool',
  filter: 'filter',
  beforeAt: 'beforeAt',
  beforeId: 'beforeId',
  aggregates: 'aggregates',
  cursor: 'cursor',
  frontmatter: 'frontmatter',
  scope: 'scope',
} as const

export type QueryKey = (typeof QUERY_KEY)[keyof typeof QUERY_KEY]
