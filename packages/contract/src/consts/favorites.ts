export const FAVORITE_ENTITY_KIND = {
  note: 'note',
  folder: 'folder',
  project: 'project',
} as const

export type FavoriteEntityKind = (typeof FAVORITE_ENTITY_KIND)[keyof typeof FAVORITE_ENTITY_KIND]
