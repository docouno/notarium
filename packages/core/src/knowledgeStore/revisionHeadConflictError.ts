export class RevisionHeadConflictError extends Error {
  readonly code = 'revision_head_conflict'

  constructor(
    readonly noteId: string,
    readonly expectedRevisionId: string | null,
    readonly currentRevisionId: string | null,
  ) {
    super(
      `revision head conflict for ${noteId}: expected ${expectedRevisionId ?? 'none'}, current ${currentRevisionId ?? 'none'}`,
    )
    this.name = 'RevisionHeadConflictError'
  }
}
