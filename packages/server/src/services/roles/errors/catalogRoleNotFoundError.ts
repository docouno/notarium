import { defineClientFailure } from '../../../libs/clientFailure'

export class CatalogRoleNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'not-found' })
  }
}
