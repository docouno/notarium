/** The `current` resolution axis is domain-only — it never crosses this wire. */
export const RESOLVED_VIA = {
  slug: 'slug',
  noteAlias: 'note-alias',
  folderAlias: 'folder-alias',
} as const

export type ResolvedVia = (typeof RESOLVED_VIA)[keyof typeof RESOLVED_VIA]
