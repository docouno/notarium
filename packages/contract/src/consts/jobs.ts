export const JOB_STATUS = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
} as const

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS]

export const EXPORT_SCOPE = { user: 'user', all: 'all' } as const

export type ExportScope = (typeof EXPORT_SCOPE)[keyof typeof EXPORT_SCOPE]

export const FRONTMATTER_MODE = { keep: 'keep', strip: 'strip' } as const

export type FrontmatterMode = (typeof FRONTMATTER_MODE)[keyof typeof FRONTMATTER_MODE]
