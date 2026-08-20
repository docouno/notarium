import { directoryOf, type KnowledgeStore, serializeSkillLocator } from '@notarium/core'
import {
  type AbilityAvailability,
  type RoleHomeLocation,
  type RoleLocation,
  type RolesService,
  skillLinksMetadataEntry,
} from '@notarium/server'

import type { AgentRoleDecl } from './types'

/** One published Role, in declaration order. Package ids are minted at publish time,
 *  so this is the only place a later declaration — or an owner preference row — can
 *  learn the exact address a declaration ended up at. */
export type AppliedAgentRole = {
  declaration: AgentRoleDecl
  location: RoleLocation
  packageId: string
  noteId: string
}

/** A role attached where a skill belongs, by exact locator. Owned attachment locators
 *  carry a Personal or Space scope only, and the dependency is resolved inside the
 *  attaching role's own space, so a declaration that names anything else is refused
 *  rather than published as a link nothing can resolve. */
const attachedRoleLink = (
  published: readonly AppliedAgentRole[],
  declaration: AgentRoleDecl,
  location: RoleLocation,
  name: string,
): string => {
  const target = published.find(
    (entry) =>
      entry.declaration.name === name &&
      entry.location.scope !== 'project' &&
      entry.location.space === location.space,
  )

  if (!target) {
    throw new Error(
      `agent role ${declaration.name} attaches ${name}, which is not a Personal or Space role published earlier in its own space`,
    )
  }

  return serializeSkillLocator({
    scope: target.location.scope === 'personal' ? 'personal' : 'space',
    packageId: target.packageId,
    label: name,
  })
}

export const applyAgentRoleDeclarations = async ({
  declarations,
  roles,
  resolveLocation,
  storeForSpace,
}: {
  declarations: readonly AgentRoleDecl[]
  roles: RolesService
  /** Where the declaration lands, plus the publishing caller's OWN space — see
   *  `personalSpaceSeam.ts`. `personalSpace` is not optional on purpose: the service
   *  decides where a role's dependencies live from it, and the answer a host forgets
   *  to give is the answer that published an unresolvable link. */
  resolveLocation: (declaration: AgentRoleDecl) => Promise<{
    location: RoleLocation
    personalSpace: string | null
    availability?: AbilityAvailability
  }>
  storeForSpace: (space: string) => Promise<KnowledgeStore>
}): Promise<AppliedAgentRole[]> => {
  const published: AppliedAgentRole[] = []

  for (const declaration of declarations) {
    // Catalog Add takes a location and nothing else, so a declared reach would be
    // dropped by the very applier that exists to reproduce the declaration.
    if (declaration.source !== 'custom' && declaration.availability) {
      throw new Error(
        `agent role ${declaration.name} declares availability, which a Catalog Add cannot carry — author it as a custom role`,
      )
    }
    const { location, personalSpace, availability } = await resolveLocation(declaration)
    let role

    if (declaration.source === 'custom') {
      role = await roles.createCustomRole(
        declaration.name,
        declaration.description,
        declaration.instructions,
        location as RoleHomeLocation,
        { personalSpace, ...(availability ? { availability } : {}) },
      )
    } else {
      role = await roles.addFromCatalog(declaration.name, location, personalSpace)
    }
    published.push({
      declaration,
      location,
      packageId: role.packageId,
      noteId: role.noteId,
    })

    const links = [
      ...(declaration.attachRole
        ? [attachedRoleLink(published, declaration, location, declaration.attachRole)]
        : []),
      ...(declaration.invalidAttachment ? [declaration.invalidAttachment] : []),
    ]

    if (links.length) {
      const store = await storeForSpace(role.space)
      const live = await store.read(role.noteId)
      const entries = live.documentState?.projection?.frontmatterEntries

      if (!entries) {
        throw new Error(`seeded Agent Role is not a readable package root: ${role.noteId}`)
      }
      await store.write({
        title: live.title ?? declaration.name,
        content: live.content,
        frontmatter: [skillLinksMetadataEntry(entries, links)],
        originalId: role.noteId,
        versionToken: live.versionToken,
        preservePath: true,
        principal: 'seed',
      })
    }

    if (declaration.deleted) {
      const store = await storeForSpace(role.space)
      const live = await store.read(role.noteId)

      if (!store.removeDir) {
        throw new Error(`space store cannot delete Agent Role packages: ${role.space}`)
      }
      await store.removeDir(directoryOf(live.filePath ?? ''), {
        internalAddress: true,
        principal: 'seed',
      })
    }
  }

  return published
}
