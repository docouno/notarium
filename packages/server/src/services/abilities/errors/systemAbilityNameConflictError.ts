import { defineClientFailure } from '../../../libs/clientFailure'

export class SystemAbilityNameConflictError extends Error {
  readonly isToolError = true

  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'conflict', message })
  }
}
