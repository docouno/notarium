import { defineClientFailure } from '../../../libs/clientFailure'

export class AbilityPackageNotRestorableError extends Error {
  readonly isToolError = true

  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'actionable', message })
  }
}
