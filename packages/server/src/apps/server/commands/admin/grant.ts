import type { SpaceRole } from '../../../../services/authz'
import type {
  AuthPersistence,
  MetaDb,
  SpaceRecord,
  SpacesPersistence,
} from '../../../../services/metaDb'
import { resolveSpaceRecord } from '../../../../services/spaces'

type GrantMemberDeps = {
  auth: Pick<AuthPersistence, 'getUser'>
  spaces: Pick<SpacesPersistence, 'list'>
  grantMemberToActiveSpace: MetaDb['grantMemberToActiveSpace']
  now?: () => Date
}

export type GrantMemberInput = {
  username: string
  space: string
  role: SpaceRole
}

/** Recovery membership write: resolve the operator-facing reference first and
 *  only ever persist the stable space id. Archived spaces fail explicitly: a
 *  successful grant must restore access now, not after an unstated future restore. */
export const grantSpaceMember = async (
  { auth, spaces, grantMemberToActiveSpace, now = () => new Date() }: GrantMemberDeps,
  { username, space, role }: GrantMemberInput,
): Promise<SpaceRecord> => {
  if (!(await auth.getUser(username))) {
    throw new Error(`no such user: ${username}`)
  }
  const record = resolveSpaceRecord(await spaces.list(), space)

  if (!record) {
    throw new Error(`no such space: ${space}`)
  }
  const result = await grantMemberToActiveSpace(record.id, username, role, now().toISOString())

  if (result.status === 'missing') {
    throw new Error(`no such space: ${space}`)
  }
  if (result.status === 'archived') {
    throw new Error(`space is archived: ${result.space.slug}`)
  }

  return result.space
}
