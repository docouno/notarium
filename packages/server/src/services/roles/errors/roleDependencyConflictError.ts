import type { AbilityAttachmentHealth } from '@notarium/contract'
import { defineClientFailure } from '../../../libs/clientFailure'

type RoleDependencyConflictDetails = {
  attachment: string
  verdict: AbilityAttachmentHealth
  rule: string
  projectId?: string
}

export class RoleDependencyConflictError extends Error {
  constructor(
    message: string,
    readonly details?: RoleDependencyConflictDetails,
  ) {
    super(message)
    defineClientFailure(this, {
      kind: 'conflict',
      message: details
        ? `skill attachment "${details.attachment}" is ${details.verdict}; ${details.rule}`
        : 'ability attachments conflict with the requested operation',
    })
  }
}
