import { defineClientFailure } from '../../../libs/clientFailure'

export class CatalogSkillNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'not-found' })
  }
}
