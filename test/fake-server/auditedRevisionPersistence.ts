import { InMemoryRevisionPersistence, type Revision, type RevisionInput } from '@notarium/core'

import type { InMemorySessionAudit } from './sessionAudit'

/** The facets a permanent note purge ends, announced by the host that owns the
 *  journal. The drivers do it in one transaction because the rows live in one
 *  database; here the journal is the only place that knows a purge happened. */
type PurgeListeners = {
  notePurged(space: string, registryNoteIds: readonly string[]): void
}

/** Per-space journal used by the fake app: normal history plus a cross-space audit tap. */
export class AuditedRevisionPersistence extends InMemoryRevisionPersistence {
  constructor(
    private readonly audit: InMemorySessionAudit,
    private readonly space: string,
    private readonly purgeListeners: readonly PurgeListeners[] = [],
  ) {
    super()
  }

  /** A purged registry note takes an ability's owner preference and reach with it,
   *  and closes the fence that keeps either from being written again. */
  override async purgeNotes(
    space: string,
    noteIds: readonly string[],
    expectedLatest?: ReadonlyMap<string, string>,
  ): Promise<readonly string[]> {
    const purged = await super.purgeNotes(space, noteIds, expectedLatest)

    for (const listener of this.purgeListeners) {
      listener.notePurged(space, purged)
    }

    return purged
  }

  override async append(revision: RevisionInput, content: string | null): Promise<Revision> {
    const stored = await super.append(revision, content)

    this.audit.captureRevision(stored)
    return stored
  }

  /** One row, one integrity — the SQL drivers read `integrity` off the very row the
   *  audit stream selects, so the tap must learn about a quarantine, not diverge. */
  override quarantineForTest(revisionIds: readonly string[]): void {
    super.quarantineForTest(revisionIds)
    this.audit.quarantineRevisions(revisionIds)
  }

  override clear(): void {
    super.clear()
    this.audit.clearWritesForSpace(this.space)
  }
}
