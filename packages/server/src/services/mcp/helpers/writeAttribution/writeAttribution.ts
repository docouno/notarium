import type { AgentWriteAttribution, WriteInput } from '@notarium/core'

import { agentOwnerOf } from '../../../authz'
import type { Ctx } from '../../gateway'

/** Build the host-only attribution carried into the revision journal. The owner
 * keeps unbound agent writes visible; the session label is a GC-proof snapshot. */
export const writeAttributionOf = (
  ctx: Pick<Ctx, 'principal' | 'sessionOwner' | 'session' | 'agentCallId'>,
): Pick<WriteInput, 'principal' | 'agent'> => {
  const owner = ctx.session?.record.owner ?? ctx.sessionOwner ?? agentOwnerOf(ctx.principal)
  const agent: AgentWriteAttribution | undefined = owner
    ? {
        owner,
        agent: ctx.principal.label ?? null,
        ...(ctx.agentCallId ? { agentCallId: ctx.agentCallId } : {}),
        ...(ctx.session
          ? {
              session: {
                id: ctx.session.record.id,
                name: ctx.session.record.name,
                attach: ctx.session.attach,
              },
            }
          : {}),
      }
    : undefined

  return { principal: ctx.principal.id, ...(agent ? { agent } : {}) }
}
