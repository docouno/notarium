import { InMemoryRevisionPersistence, type Revision, type RevisionInput } from '@notarium/core'

import type { InMemorySessionAudit } from './sessionAudit'

/** Per-space journal used by the fake app: normal history plus a cross-space audit tap. */
export class AuditedRevisionPersistence extends InMemoryRevisionPersistence {
  constructor(
    private readonly audit: InMemorySessionAudit,
    private readonly space: string,
  ) {
    super()
  }

  override async append(revision: RevisionInput, content: string | null): Promise<Revision> {
    const stored = await super.append(revision, content)

    this.audit.captureRevision(stored)
    return stored
  }

  override clear(): void {
    super.clear()
    this.audit.clearWritesForSpace(this.space)
  }
}
