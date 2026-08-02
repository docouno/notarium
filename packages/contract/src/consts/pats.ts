export const PAT_SCOPE = {
  read: 'read',
  write: 'write',
} as const

export type PatScope = (typeof PAT_SCOPE)[keyof typeof PAT_SCOPE]
