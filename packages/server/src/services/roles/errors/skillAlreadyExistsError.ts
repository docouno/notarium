import { defineClientFailure } from '../../../libs/clientFailure'

export class SkillAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'conflict', message })
  }
}
