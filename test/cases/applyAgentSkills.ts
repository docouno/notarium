import {
  analyzeDocumentState,
  directoryOf,
  DOCUMENT_ROLE,
  frontmatterScalarEntry,
  type KnowledgeStore,
  serializeSkillLocator,
} from '@notarium/core'
import {
  type AbilityAvailability,
  parseSkillFile,
  type RoleLibrary,
  type RoleLocation,
  type RolesService,
  type SkillHomeLocation,
  withSkillLinks,
} from '@notarium/server'

import type { AgentRoleDependencySkillDecl, AgentSkillDecl } from './types'

/** One published Skill, in declaration order — the exact address an owner preference
 *  row has to name. */
export type AppliedAgentSkill = {
  declaration: AgentSkillDecl
  location: SkillHomeLocation
  /** The package's exact id, which is also the id of its `SKILL.md` note: the applier
   *  reads, renames and links the package by that one value. */
  packageId: string
  /** The manifest name AFTER a declared rename — what a link label and a card show. */
  name: string
}

const sourceText = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)

const titleForWrite = (
  projection: NonNullable<ReturnType<typeof analyzeDocumentState>['projection']>,
): string =>
  projection.titleOrigin.kind === 'hidden-h1' ? projection.titleOrigin.title : projection.title

const writeAnalyzedRoot = async (
  store: KnowledgeStore,
  noteId: string,
  raw: string,
): Promise<void> => {
  const state = analyzeDocumentState({
    source: new TextEncoder().encode(raw),
    role: DOCUMENT_ROLE.skillRoot,
    skillDirectoryName: noteId,
  })
  const projection = state.projection

  if (!projection?.skill) {
    throw new Error(`seed produced an invalid Agent Skill package: ${noteId}`)
  }
  const live = await store.read(noteId)

  await store.write({
    title: titleForWrite(projection),
    content: projection.body,
    frontmatter: projection.frontmatterEntries,
    originalId: noteId,
    versionToken: live.versionToken,
    preservePath: true,
    principal: 'seed',
  })
}

const linkedPackageId = async (
  library: RoleLibrary,
  roleLocation: RoleLocation,
  skillLocation: SkillHomeLocation,
  declaration: AgentRoleDependencySkillDecl,
): Promise<string> => {
  const role = await library.getSkill(roleLocation, declaration.role)
  const manifest = role?.files.get('SKILL.md')

  if (!role || !manifest) {
    throw new Error(
      `agent skill ${declaration.name} references an unknown role ${declaration.role}`,
    )
  }
  const parsed = parseSkillFile(sourceText(manifest), role.directoryName)
  const link = parsed.linkedSkills.find(
    (candidate) =>
      candidate.kind === 'locator' &&
      candidate.source === 'owned' &&
      candidate.scope === skillLocation.scope &&
      candidate.label === declaration.name,
  )

  if (!link || link.kind !== 'locator') {
    throw new Error(
      `role ${declaration.role} has no exact linked skill ${declaration.name} in ${skillLocation.scope}`,
    )
  }

  return link.packageId
}

const mutateSkill = async (
  store: KnowledgeStore,
  noteId: string,
  declaration: AgentSkillDecl,
): Promise<string> => {
  const live = await store.read(noteId)
  const skill = live.documentState?.projection?.skill

  if (!skill) {
    throw new Error(`agent skill ${declaration.name} is not a readable package root`)
  }
  const name = declaration.renameTo ?? skill.name
  const custom = declaration.source === undefined || declaration.source === 'custom'
  const description = custom ? declaration.description : skill.description
  const content =
    custom && declaration.instructions !== undefined ? declaration.instructions : live.content

  await store.write({
    title: titleForWrite(live.documentState!.projection!),
    content,
    frontmatter: [
      frontmatterScalarEntry('name', name),
      frontmatterScalarEntry('description', description),
    ],
    originalId: noteId,
    versionToken: live.versionToken,
    preservePath: true,
    principal: 'seed',
  })

  return name
}

const linkFromRole = async (
  library: RoleLibrary,
  store: KnowledgeStore,
  roleLocation: RoleLocation,
  skillLocation: SkillHomeLocation,
  roleName: string,
  noteId: string,
  label: string,
): Promise<void> => {
  const role = await library.getSkill(roleLocation, roleName)
  const manifest = role?.files.get('SKILL.md')

  if (!role || !manifest) {
    throw new Error(`agent skill ${label} references an unknown role ${roleName}`)
  }
  const parsed = parseSkillFile(sourceText(manifest), role.directoryName)
  const links = parsed.linkedSkills.map((link) =>
    link.kind === 'name'
      ? `[[${link.name}]]`
      : link.kind === 'invalid'
        ? link.raw
        : link.source === 'system'
          ? serializeSkillLocator({
              source: 'system',
              packageId: link.packageId,
              label: link.label,
            })
          : serializeSkillLocator({
              scope: link.scope,
              packageId: link.packageId,
              label: link.label,
            }),
  )
  links.push(serializeSkillLocator({ scope: skillLocation.scope, packageId: noteId, label }))
  await writeAnalyzedRoot(store, role.directoryName, withSkillLinks(sourceText(manifest), links))
}

/** Apply declarative skill states through production role/store seams. Package ids
 * are minted by create/Add and every later operation addresses that exact id. */
export const applyAgentSkillDeclarations = async ({
  declarations,
  roles,
  library,
  resolveLocation,
  storeForSpace,
}: {
  declarations: readonly AgentSkillDecl[]
  roles: RolesService
  library: RoleLibrary
  resolveLocation: (declaration: AgentSkillDecl) => Promise<{
    role: RoleLocation
    skill: SkillHomeLocation
    availability?: AbilityAvailability
  }>
  storeForSpace: (space: string) => Promise<KnowledgeStore>
}): Promise<AppliedAgentSkill[]> => {
  const published: AppliedAgentSkill[] = []

  for (const declaration of declarations) {
    const location = await resolveLocation(declaration)
    const noteId =
      declaration.source === 'role-dependency'
        ? await linkedPackageId(library, location.role, location.skill, declaration)
        : declaration.source === 'catalog'
          ? (
              await roles.addSkillFromCatalog(
                declaration.name,
                location.skill,
                location.availability,
              )
            ).noteId
          : (
              await roles.createCustomSkill(
                declaration.name,
                declaration.description,
                declaration.instructions ?? '',
                location.skill,
                location.availability,
              )
            ).noteId
    const store = await storeForSpace(location.skill.space)
    const finalName = await mutateSkill(store, noteId, declaration)
    published.push({
      declaration,
      location: location.skill,
      packageId: noteId,
      name: finalName,
    })

    if (declaration.linkedRole) {
      await linkFromRole(
        library,
        store,
        location.role,
        location.skill,
        declaration.linkedRole,
        noteId,
        finalName,
      )
    }
    if (declaration.deleted) {
      const live = await store.read(noteId)

      if (!store.removeDir) {
        throw new Error(`space store cannot delete Agent Skill packages: ${location.skill.space}`)
      }
      await store.removeDir(directoryOf(live.filePath ?? ''), {
        internalAddress: true,
        principal: 'seed',
      })
    }
  }

  return published
}
