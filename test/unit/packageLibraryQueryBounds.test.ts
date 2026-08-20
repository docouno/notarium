import { describe, expect, it } from 'vitest'

import { AgentPackageLibraryQuerySchema } from '@notarium/contract'
import { AGENT_PACKAGE_LIBRARY_QUERY_MAX } from '@notarium/contract/enums'
import {
  packageLibraryQuery,
  readPackageLibraryState,
} from '../../packages/web/src/pages/AgentsPage/packageLibraryState'

/**
 * The URL is the library's state, and it is reachable by pasting — so every URL the
 * SPA accepts has to compose into a request the wire accepts. Lives here rather than
 * beside the state because it asks the zod schema, which the SPA may not import at
 * runtime (#56): the two sides only ever meet in a gate.
 */
describe('package library query bounds', () => {
  it('keeps a pasted search askable', () => {
    const state = readPackageLibraryState(
      new URLSearchParams(`q=${'x'.repeat(AGENT_PACKAGE_LIBRARY_QUERY_MAX + 40)}`),
    )

    // Past the limit the request is not a narrower search — it is a 400 that empties
    // the whole listing, for a URL the reader is still looking at.
    expect(AgentPackageLibraryQuerySchema.safeParse(packageLibraryQuery(state)).success).toBe(true)
  })
})
