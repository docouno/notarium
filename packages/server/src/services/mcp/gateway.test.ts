import { describe, expect, it } from 'vitest'
import { memoryConvergenceExhausted } from '@notarium/core'

import { toolErrorMessage } from './gateway'

describe('toolErrorMessage', () => {
  it('tells a memory convergence loser to repeat without asking for a caller token', () => {
    const error = memoryConvergenceExhausted('general', 9, {
      id: 'memory-id',
      title: 'general',
      class: 'agent-memory',
      filePath: '.notarium/memory/general.md',
      content: 'live body',
      frontmatter: {},
      versionToken: 'live-token',
    })
    const message = toolErrorMessage(error, 'remember_about_user')

    expect(message).toContain('Repeat the same call')
    expect(message).not.toContain('get_note')
    expect(message).not.toContain('versionToken')
  })
})
