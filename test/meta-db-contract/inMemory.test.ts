import { describe, expect, it } from 'vitest'

import { InMemoryRevisionPersistence, type RevisionInput } from '@notarium/core'

import { InMemoryAgentDeltaCursors } from '../fake-server/agentDeltaCursors'
import { InMemoryAgentSessions } from '../fake-server/agentSessions'
import { InMemoryFolders } from '../fake-server/folders'
import { InMemoryGatewayState } from '../fake-server/gatewayState'
import { InMemoryProjects } from '../fake-server/projects'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'

describeGatewayStateContract('in-memory twin', async () => ({
  persistence: new InMemoryGatewayState(),
}))

describeAgentDeltaCursorsContract('in-memory twin', async () => {
  const persistence = new InMemoryAgentDeltaCursors()
  const projects = new InMemoryProjects()
  const folders = new InMemoryFolders(projects)
  const sessions = new InMemoryAgentSessions()
  projects.attachLifecycle(persistence)
  sessions.attachLifecycle(persistence)
  return { persistence, sessions, projects, folders }
})

describeAgentSessionsContract('in-memory twin', async () => ({
  persistence: new InMemoryAgentSessions(),
}))

describeRevisionPersistenceContract('in-memory twin', async () => ({
  persistence: new InMemoryRevisionPersistence(),
}))

describe('in-memory revision test reset', () => {
  it('clear removes terminal fences before the next fake-server seed', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const input: RevisionInput = {
      noteId: 'reseeded-note',
      space: 'reseeded-space',
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      principal: 'ui',
      contentHash: 'reseeded-hash',
      title: 'Reseeded',
      class: 'user-doc',
      slug: null,
      tags: [],
      createdAt: '2026-07-23T00:00:00.000Z',
      charsAdded: 1,
      charsRemoved: 0,
    }

    await persistence.append(input, 'before reset')
    await persistence.purgeNotes([input.noteId])
    await expect(persistence.append(input, 'late')).rejects.toThrow(/permanently purged/)

    persistence.clear()

    await expect(persistence.append(input, 'after reset')).resolves.toMatchObject({
      id: '1',
      noteId: input.noteId,
    })
  })
})
