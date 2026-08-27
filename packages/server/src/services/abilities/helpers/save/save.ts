import type { AuthoredAttachment } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import {
  DOCUMENT_ROLE,
  frontmatterScalarEntry,
  promoteBodyTitle,
  type SkillLink,
  versionConflict,
  type WriteInput,
} from '@notarium/core'

import { AuthError } from '../../../auth'
import {
  RoleDependencyConflictError,
  skillLinksMetadataEntry,
  unwritableSkillLinks,
} from '../../../roles'
import type {
  AbilityAttachmentIntent,
  AbilityDocumentWrite,
  AbilitySaveDeps,
  AuthoredWriteResult,
  DeferredAbilityAttachments,
} from '../../types'
import type { AbilityPlacement } from '../placement'

const deferred = (
  attachments: AbilityAttachmentIntent,
): attachments is DeferredAbilityAttachments => !Array.isArray(attachments)

const sameLocator = (
  link: Extract<SkillLink, { kind: 'locator' }>,
  attachment: DeferredAbilityAttachments['attachments'][number],
  roleSpace: string,
): boolean => {
  const locator = attachment.locator

  if (link.source !== locator.source || link.packageId !== locator.packageId) {
    return false
  }
  if (
    link.source === 'owned' &&
    (locator.source !== 'owned' ||
      link.scope !== locator.location.scope ||
      locator.location.spaceId !== roleSpace)
  ) {
    return false
  }

  return attachment.label === undefined || attachment.label === link.label
}

const roleSpaceOf = (write: AbilityDocumentWrite): string | undefined => {
  const roleLocator =
    write.locator && 'locator' in write.locator ? write.locator.locator : write.locator

  return roleLocator?.location.spaceId
}

const sameAttachmentIntent = (
  write: AbilityDocumentWrite,
  current: readonly SkillLink[],
): boolean => {
  if (write.attachments === undefined) {
    return true
  }
  const roleSpace = roleSpaceOf(write)
  const intent = deferred(write.attachments)
    ? write.attachments.attachments
    : write.attachments.map((attachment) =>
        attachment.kind === 'exact'
          ? { locator: attachment.locator, label: attachment.label }
          : attachment,
      )

  return (
    roleSpace !== undefined &&
    intent.length === current.length &&
    intent.every((attachment, index) => {
      const link = current[index]

      if (!('locator' in attachment)) {
        return link?.kind === 'invalid' && link.raw === attachment.raw
      }

      return link?.kind === 'locator' && sameLocator(link, attachment, roleSpace)
    })
  )
}

const resolvedAttachments = async (
  attachments: AbilityAttachmentIntent,
  current: readonly SkillLink[],
  roleSpace: string,
): Promise<readonly AuthoredAttachment[]> => {
  if (!deferred(attachments)) {
    return attachments
  }
  const resolved = await attachments.resolve()

  if (
    resolved.length !== attachments.attachments.length ||
    !resolved.every((attachment, index) => {
      const expected = attachments.attachments[index]

      if (
        attachment.kind !== 'exact' ||
        expected === undefined ||
        attachment.locator.source !== expected.locator.source ||
        attachment.locator.packageId !== expected.locator.packageId
      ) {
        return false
      }
      if (
        attachment.locator.source === 'owned' &&
        (expected.locator.source !== 'owned' ||
          attachment.locator.location.scope !== expected.locator.location.scope ||
          attachment.locator.location.spaceId !== expected.locator.location.spaceId)
      ) {
        return false
      }

      return expected.label === undefined || attachment.label === expected.label
    })
  ) {
    throw new Error('deferred ability attachments changed during resolution')
  }

  return resolved.map((attachment, index) => {
    const expected = attachments.attachments[index]!
    const currentLink = current[index]

    // PATCH semantics: omission preserves a custom authored label only when the same
    // exact ref already occupies this position. A new or reordered ref keeps the live
    // dependency-name default returned by the resolver; an explicit label always wins.
    return expected.label === undefined &&
      currentLink?.kind === 'locator' &&
      sameLocator(currentLink, expected, roleSpace)
      ? { ...attachment, label: currentLink.label }
      : attachment
  })
}

const sameAuthoredDocument = (write: AbilityDocumentWrite): boolean => {
  if (!write.semanticNoop || write.input.versionToken !== write.target.note.versionToken) {
    return false
  }
  const projection = write.target.note.documentState?.projection
  const skill = projection?.skill

  if (!projection || !skill) {
    return false
  }
  const promoted = promoteBodyTitle(write.input.content ?? '', write.input.title)

  return (
    promoted.title === projection.title &&
    promoted.body === projection.body &&
    (write.description === undefined || write.description === skill.description) &&
    sameAttachmentIntent(write, skill.linkedSkills)
  )
}

export const createAbilityDocumentWriter = (
  { roles }: AbilitySaveDeps,
  personalSpaceFor: AbilityPlacement['personalSpaceFor'],
) => {
  const prepareDocument = async (
    principal: Parameters<AbilitySaveDeps['store']['noteStore']>[0],
    write: AbilityDocumentWrite,
  ): Promise<() => Promise<AuthoredWriteResult>> => {
    const live = write.target.note

    if (live.documentState?.role !== DOCUMENT_ROLE.skillRoot) {
      throw new Error('ability document target is not a package root')
    }
    if ((write.locator === undefined) !== (write.attachments === undefined)) {
      throw new Error('ability locator and attachments must be passed together')
    }

    return async () => {
      const currentId = live.id ?? write.input.originalId

      // Immutable evidence wins before mutable dependency resolution. The store still
      // receives this token below and remains the final arbiter if another write lands
      // after preparation but before its physical CAS.
      if (currentId && live.versionToken && write.input.versionToken !== live.versionToken) {
        throw versionConflict({ ...live, id: currentId, versionToken: live.versionToken })
      }
      if (write.attachments !== undefined && live.documentState!.projection?.skill == null) {
        throw new AuthError(
          HTTP_STATUS.BAD_REQUEST,
          'Role attachments require an editable Role package root',
        )
      }
      if (sameAuthoredDocument(write)) {
        if (!currentId || !live.versionToken) {
          throw new Error('ability document has no version token')
        }
        if (!write.withTargetMutation) {
          throw new Error('ability semantic no-op has no exact target mutation scope')
        }
        const verified = await write.withTargetMutation(async (current) =>
          current.versionToken === write.input.versionToken
            ? {
                applied: {
                  id: current.registryNoteId,
                  filePath: current.filePath,
                  title: live.title,
                  class: live.class,
                  versionToken: current.versionToken,
                },
              }
            : { applied: null },
        )

        if (!verified.applied) {
          // `current` on a 409 is ONE live observation by contract — the body and title
          // the conflict dialog shows are the ones its token retries against. The exact
          // scope answers with a token only; pairing it with the released preparation
          // snapshot would show the writer its OWN body as "latest saved" and let the
          // retry overwrite the revision it never saw. So staleness is reported out of
          // the scope, and the payload is read once after release by the ordinary read
          // every other conflict in the system carries.
          const current = await write.target.store.read(currentId)

          if (!current.versionToken) {
            throw new Error('ability document has no version token')
          }

          throw versionConflict({
            ...current,
            id: current.id ?? currentId,
            versionToken: current.versionToken,
          })
        }

        return { ...verified.applied, outcome: 'skipped' }
      }
      let links: string[] | undefined
      let attachmentFrontmatter

      if (write.locator && write.attachments) {
        const roleSpace = roleSpaceOf(write)
        const projection = live.documentState!.projection!

        if (!roleSpace || !projection.skill) {
          throw new Error('ability attachment intent has no Role placement')
        }
        const attachments = await resolvedAttachments(
          write.attachments,
          projection.skill.linkedSkills,
          roleSpace,
        )
        const validated = await roles.serializeOwnedRoleAttachments(
          principal,
          write.locator,
          attachments,
          await personalSpaceFor(principal),
        )

        if (validated.noteId !== (live.id ?? write.input.originalId)) {
          throw new Error('ability locator does not address this note')
        }
        links = validated.links
        const unwritable = unwritableSkillLinks(links)

        if (unwritable.length) {
          throw new RoleDependencyConflictError(
            `attachment cannot be written back to SKILL.md: ${unwritable.join(' ')}`,
          )
        }
        attachmentFrontmatter = skillLinksMetadataEntry(projection.frontmatterEntries, links)
      }
      const input: WriteInput = {
        ...write.input,
        originalId: live.id ?? write.input.originalId,
        frontmatter: [
          ...(write.input.frontmatter ?? []),
          ...(attachmentFrontmatter ? [attachmentFrontmatter] : []),
        ],
        preservePath: true,
      }
      const result = await write.target.store.write(
        input,
        write.withTargetMutation
          ? {
              aroundWrite: (physical) => write.withTargetMutation!(() => physical()),
              resourceAdmitted: true,
            }
          : undefined,
      )

      if (!result.id || !result.versionToken) {
        throw new Error('ability write produced no identity or version token')
      }

      return { ...result, id: result.id, versionToken: result.versionToken, outcome: 'applied' }
    }
  }

  const writeDocument = async (
    principal: Parameters<AbilitySaveDeps['store']['noteStore']>[0],
    write: AbilityDocumentWrite,
  ): Promise<AuthoredWriteResult> => (await prepareDocument(principal, write))()

  const writeInput = ({
    content,
    description,
    noteId,
    versionToken,
    principal,
  }: {
    content: string
    description: string
    noteId: string
    versionToken: string
    principal: string
  }): WriteInput => ({
    title: '',
    content,
    originalId: noteId,
    versionToken,
    principal,
    frontmatter: [frontmatterScalarEntry('description', description)],
  })

  return { prepareDocument, writeDocument, writeInput }
}
