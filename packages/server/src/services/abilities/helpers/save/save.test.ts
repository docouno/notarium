import { describe, expect, it, vi } from 'vitest'
import type { AuthoredAttachment, OwnedAbilityLocator } from '@notarium/contract'
import { analyzeDocumentState, DOCUMENT_ROLE, type NoteContent } from '@notarium/core'

import type { AuthService } from '../../../auth'
import type { Principal } from '../../../authz'
import type { OwnedAbilitySnapshot, RolesService } from '../../../roles'
import type { SpaceManager, SpaceStore } from '../../../spaces'
import type {
  AbilityAttachmentIntent,
  AbilityDocumentTarget,
  DeferredAbilityAttachments,
} from '../../types'
import { createAbilityDocumentWriter } from './save'

const ROLE_ID = 'RolePkg00001'
const SKILL_ID = 'SkillPkg0001'
const ATTACHMENT: AuthoredAttachment = {
  kind: 'exact',
  locator: { source: 'system', kind: 'skill', packageId: SKILL_ID },
  label: 'proof-skill',
}
const ROLE_LOCATOR: Extract<OwnedAbilityLocator, { kind: 'role' }> = {
  source: 'owned',
  kind: 'role',
  packageId: ROLE_ID,
  location: { scope: 'personal', spaceId: 'personal' },
}
const PRINCIPAL: Principal = {
  id: 'pat:alice:write',
  scope: 'write',
  username: 'alice',
  admin: false,
  system: false,
  grants: new Map([['personal', 'owner']]),
  spaces: null,
}

const manifestOf = (heading: string, body: string) =>
  Buffer.from(
    `---\nnotarium-id: ${ROLE_ID}\nname: retry-role\ndescription: Retry role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:system:${SKILL_ID}|proof-skill]]"\n---\n\n# ${heading}\n\n${body}\n`,
  )

/** One revision of the package as the store would serve it: the manifest bytes, and
 * the id/token/body view a read of those bytes produces. Body and token move together
 * here for the same reason they must move together on a 409 payload. */
const revisionOf = (source: Buffer, versionToken: string, filePath: string): NoteContent => {
  const documentState = analyzeDocumentState({
    source,
    role: DOCUMENT_ROLE.skillRoot,
    skillDirectoryName: ROLE_ID,
  })
  const projection = documentState.projection!

  return {
    id: ROLE_ID,
    title: projection.title,
    content: projection.body,
    frontmatter: {},
    filePath,
    versionToken,
    documentState,
  }
}

const world = () => {
  const source = manifestOf('Retry role', 'Current body.')
  const note = revisionOf(source, 'current-version', `.notarium/skills/${ROLE_ID}/SKILL.md`)
  // What the package holds RIGHT NOW, as opposed to `note` — the snapshot preparation
  // captured and released. A concurrent writer moves this one and only this one.
  let live = note
  let liveSource = source

  const commitConcurrently = (heading: string, body: string, versionToken: string) => {
    liveSource = manifestOf(heading, body)
    live = revisionOf(liveSource, versionToken, live.filePath!)
  }
  const write = vi.fn()
  const read = vi.fn(async () => live)
  const storeWrite = vi.fn(async (input, options) => {
    const physical = () => write(input)

    return options?.aroundWrite ? options.aroundWrite(physical) : physical()
  })
  const serializeOwnedRoleAttachments = vi.fn(
    async (): Promise<{
      links: string[]
      noteId: string
    }> => {
      throw new Error('attachment disappeared')
    },
  )
  const writer = createAbilityDocumentWriter(
    {
      roles: { serializeOwnedRoleAttachments } as unknown as RolesService,
      auth: { personalSpaceOf: vi.fn(async () => 'personal') } as unknown as AuthService,
      spaces: { has: () => true } as unknown as SpaceManager,
      store: {} as never,
    },
    async () => 'personal',
  )
  const target = {
    space: 'personal',
    store: { read, write: storeWrite } as unknown as SpaceStore,
    note,
  } as unknown as AbilityDocumentTarget

  const withTargetMutation = async <T>(task: (current: OwnedAbilitySnapshot) => Promise<T>) =>
    task({
      locator: ROLE_LOCATOR,
      registryNoteId: ROLE_ID,
      manifestNoteId: ROLE_ID,
      filePath: live.filePath!,
      versionToken: live.versionToken!,
      pkg: { directoryName: ROLE_ID, files: new Map([['SKILL.md', liveSource]]) },
    })
  const document = (content: string, attachments: AbilityAttachmentIntent = [ATTACHMENT]) => ({
    target,
    input: writer.writeInput({
      content,
      description: 'Retry role.',
      noteId: ROLE_ID,
      versionToken: 'current-version',
      principal: PRINCIPAL.id,
    }),
    description: 'Retry role.',
    locator: ROLE_LOCATOR,
    attachments,
    semanticNoop: true,
    withTargetMutation,
  })

  return {
    commitConcurrently,
    document,
    read,
    serializeOwnedRoleAttachments,
    storeWrite,
    write,
    writer,
  }
}

describe('ability authored document preparation', () => {
  it('repairs a projection-less physical skill root through a body write', async () => {
    const { document, write, writer } = world()
    const valid = document('# Retry role\n\nCurrent body.\n')
    const malformed = {
      ...valid.target,
      note: {
        ...valid.target.note,
        documentState: { ...valid.target.note.documentState!, projection: null },
      },
    } as AbilityDocumentTarget

    write.mockResolvedValueOnce({
      id: ROLE_ID,
      filePath: `.notarium/skills/${ROLE_ID}/SKILL.md`,
      versionToken: 'repaired-version',
    })
    const commit = await writer.prepareDocument(PRINCIPAL, {
      target: malformed,
      input: {
        title: '',
        content: '# Retry role\n\nRepaired body.\n',
        originalId: ROLE_ID,
        versionToken: 'current-version',
        principal: PRINCIPAL.id,
      },
    })

    await expect(commit()).resolves.toMatchObject({
      id: ROLE_ID,
      versionToken: 'repaired-version',
      outcome: 'applied',
    })
    expect(write).toHaveBeenCalledOnce()
  })

  it('keeps typed attachment mutation fail-closed without a skill projection', async () => {
    const { document, write, writer } = world()
    const valid = document('# Retry role\n\nCurrent body.\n')
    const malformed = {
      ...valid.target,
      note: {
        ...valid.target.note,
        documentState: { ...valid.target.note.documentState!, projection: null },
      },
    } as AbilityDocumentTarget

    const commit = await writer.prepareDocument(PRINCIPAL, { ...valid, target: malformed })

    await expect(commit()).rejects.toMatchObject({
      status: 400,
      message: 'Role attachments require an editable Role package root',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('reports canonical stale CAS before resolving a vanished attachment', async () => {
    const { document, serializeOwnedRoleAttachments, write, writer } = world()
    const resolve = vi.fn(async () => {
      throw new Error('attachment disappeared')
    })
    const attachments: DeferredAbilityAttachments = {
      kind: 'deferred',
      attachments: [{ locator: ATTACHMENT.locator }],
      resolve,
    }
    const candidate = document('# Retry role\n\nChanged body.\n', attachments)
    const commit = await writer.prepareDocument(PRINCIPAL, {
      ...candidate,
      input: { ...candidate.input, versionToken: 'stale-version' },
    })

    await expect(commit()).rejects.toMatchObject({
      reason: 'version_conflict',
      current: { id: ROLE_ID, versionToken: 'current-version' },
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(serializeOwnedRoleAttachments).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('recognises an already-applied document before validating a vanished attachment', async () => {
    const { document, serializeOwnedRoleAttachments, storeWrite, write, writer } = world()

    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nCurrent body.\n'),
    )

    await expect(commit()).resolves.toMatchObject({
      id: ROLE_ID,
      versionToken: 'current-version',
      outcome: 'skipped',
    })
    expect(serializeOwnedRoleAttachments).not.toHaveBeenCalled()
    expect(storeWrite).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('conflicts when an apparent no-op changes after preparation', async () => {
    const { commitConcurrently, document, storeWrite, write, writer } = world()
    const candidate = document('# Retry role\n\nCurrent body.\n')
    const commit = await writer.prepareDocument(PRINCIPAL, candidate)

    commitConcurrently('Retry role', 'Foreign body.', 'concurrent-version')

    // The whole point of the payload: the dialog shows `current` as "latest saved
    // version" and retries with `current.versionToken`. A body from the released
    // preparation snapshot next to the concurrent writer's token would show this
    // writer its OWN text as the one it is about to overwrite.
    await expect(commit()).rejects.toMatchObject({
      reason: 'version_conflict',
      current: {
        id: ROLE_ID,
        versionToken: 'concurrent-version',
        title: 'Retry role',
        content: 'Foreign body.\n',
      },
    })
    expect(storeWrite).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('carries the concurrent title on a no-op conflict, never the prepared one', async () => {
    const { commitConcurrently, document, writer } = world()
    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nCurrent body.\n'),
    )

    commitConcurrently('Renamed role', 'Foreign body.', 'concurrent-version')

    await expect(commit()).rejects.toMatchObject({
      reason: 'version_conflict',
      current: {
        id: ROLE_ID,
        versionToken: 'concurrent-version',
        title: 'Renamed role',
        content: 'Foreign body.\n',
      },
    })
  })

  it('still validates attachments before a new authored write', async () => {
    const { document, serializeOwnedRoleAttachments, write, writer } = world()

    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nChanged body.\n'),
    )

    await expect(commit()).rejects.toThrow('attachment disappeared')
    expect(serializeOwnedRoleAttachments).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not mistake an attachment-only change for a semantic no-op', async () => {
    const { document, serializeOwnedRoleAttachments, write, writer } = world()
    const changed = { ...ATTACHMENT, label: 'renamed-proof' }

    serializeOwnedRoleAttachments.mockResolvedValueOnce({
      noteId: ROLE_ID,
      links: [`[[notarium-id:system:${SKILL_ID}|renamed-proof]]`],
    })
    write.mockResolvedValueOnce({
      id: ROLE_ID,
      filePath: `.notarium/skills/${ROLE_ID}/SKILL.md`,
      versionToken: 'next-version',
    })
    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nCurrent body.\n', [changed]),
    )

    await expect(commit()).resolves.toMatchObject({
      id: ROLE_ID,
      versionToken: 'next-version',
      outcome: 'applied',
    })
    expect(serializeOwnedRoleAttachments).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledOnce()
  })

  it('uses the current positional label to prove a deferred resume no-op', async () => {
    const { document, serializeOwnedRoleAttachments, write, writer } = world()
    const resolve = vi.fn(async () => {
      throw new Error('attachment disappeared')
    })
    const attachments: DeferredAbilityAttachments = {
      kind: 'deferred',
      attachments: [{ locator: ATTACHMENT.locator }],
      resolve,
    }

    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nCurrent body.\n', attachments),
    )

    await expect(commit()).resolves.toMatchObject({ outcome: 'skipped' })
    expect(resolve).not.toHaveBeenCalled()
    expect(serializeOwnedRoleAttachments).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('preserves a positional custom label while resolving a changed document', async () => {
    const { document, serializeOwnedRoleAttachments, write, writer } = world()
    const resolve = vi.fn(async () => [{ ...ATTACHMENT, label: 'live-default' }])
    const attachments: DeferredAbilityAttachments = {
      kind: 'deferred',
      attachments: [{ locator: ATTACHMENT.locator }],
      resolve,
    }

    serializeOwnedRoleAttachments.mockResolvedValueOnce({
      noteId: ROLE_ID,
      links: [`[[notarium-id:system:${SKILL_ID}|proof-skill]]`],
    })
    write.mockResolvedValueOnce({
      id: ROLE_ID,
      filePath: `.notarium/skills/${ROLE_ID}/SKILL.md`,
      versionToken: 'next-version',
    })
    const commit = await writer.prepareDocument(
      PRINCIPAL,
      document('# Retry role\n\nChanged body.\n', attachments),
    )

    await expect(commit()).resolves.toMatchObject({ outcome: 'applied' })
    expect(resolve).toHaveBeenCalledOnce()
    expect(serializeOwnedRoleAttachments).toHaveBeenCalledWith(
      PRINCIPAL,
      ROLE_LOCATOR,
      [{ ...ATTACHMENT, label: 'proof-skill' }],
      'personal',
    )
    expect(write).toHaveBeenCalledOnce()
  })
})
