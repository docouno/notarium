import { defineClientFailure } from '../../../libs/clientFailure'

export class SkillTooLargeForActivationError extends Error {
  readonly isToolError = true
  readonly requiredTokens: number
  readonly maxTokens: number

  constructor(requiredTokens: number, maxTokens: number) {
    super(
      `SkillTooLargeForActivation { requiredTokens: ${requiredTokens}, maxTokens: ${maxTokens} } — read the ability with get_ability, then reduce or split it and retry with edit_ability`,
    )
    this.name = 'SkillTooLargeForActivation'
    this.requiredTokens = requiredTokens
    this.maxTokens = maxTokens
    defineClientFailure(this, { kind: 'actionable', message: this.message })
  }
}
