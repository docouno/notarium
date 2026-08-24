import { defineClientFailure } from '../../../libs/clientFailure'

export class RoleAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'conflict', message })
  }
}
