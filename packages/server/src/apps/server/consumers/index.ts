// Durable job layer barrel: a meta-DB-backed queue worker (jobRunner) + per-kind handlers.
// canon: docs/jobs.md#durable-job-layer-105

export { createJobRunner, JobAbortedError, TerminalJobError } from './jobRunner'
export type { JobContext, JobHandler, JobResult, JobRunner, JobRunnerOptions } from './jobRunner'
export { createExportHandler } from './exportJob'
export type { ExportHandlerDeps, ExportParams } from './exportJob'
export { createImportHandler } from './importJob'
export type { ImportHandlerDeps, ImportParams } from './importJob'
export { jobToWire } from './wire'
export { ARTIFACT_TTL_MS } from './jobRunner'

export const JOB_KIND_EXPORT = 'export'
export const JOB_KIND_IMPORT = 'import'
