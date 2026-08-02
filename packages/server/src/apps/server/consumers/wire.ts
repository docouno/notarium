// Project an internal JobRecord onto the wire Job shape; internal claim/lock fields
// (locked_by, principal, space) deliberately never cross to the client. Used by BOTH the
// SSE `job` event (live) and the status/list endpoints (poll), so the two never drift.
// canon: docs/contract.md#mappers · docs/jobs.md#model

import type { Job } from '@notarium/contract'

import type { JobRecord } from '../../../services/metaDb'

export const jobToWire = (j: JobRecord): Job => {
  const total = j.progressTotal
  const ratio = total && total > 0 ? Math.min(1, j.progressDone / total) : null
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: { done: j.progressDone, total: total ?? null, ratio, phase: j.phase },
    artifact:
      j.status === 'succeeded' && j.artifactRef
        ? {
            name: j.artifactName ?? 'export.zip',
            bytes: j.artifactBytes,
            expiresAt: j.expiresAt,
          }
        : null,
    result: j.result ?? null,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    completedAt: j.completedAt,
  }
}
