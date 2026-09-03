import type {
  ContextOrderPersistence,
  ContextSetAttachmentRecord,
  ContextSetsPersistence,
  ScopePinsPersistence,
} from '@notarium/server'

import type { ContextOrderDecl, ContextSetAttachDecl, ContextSetDecl, ScopePinDecl } from './types'

type ResolvedTarget = Omit<ContextSetAttachmentRecord, 'setId' | 'createdAt'>
type ResolvedNote = { space: string; noteId: string }

export const applyContextDeclarations = async (input: {
  contextSets: readonly ContextSetDecl[]
  scopePins: readonly ScopePinDecl[]
  contextOrder: readonly ContextOrderDecl[]
  persistence: {
    contextSets: ContextSetsPersistence
    scopePins: ScopePinsPersistence
    contextOrder: ContextOrderPersistence
  }
  resolveHomeSpace(slug: string): string | null
  resolveTarget(declaration: ContextSetAttachDecl): Promise<ResolvedTarget | null>
  resolveNote(logicalId: string): ResolvedNote | null
  freshId(): string
  createdAt: string
}): Promise<{
  contextSets: number
  scopePins: number
  contextOrders: number
  setIdByName: ReadonlyMap<string, string>
}> => {
  const setIdByName = new Map<string, string>()
  let contextSets = 0
  let scopePins = 0
  let contextOrders = 0

  for (const declaration of input.contextSets) {
    const homeSpace = input.resolveHomeSpace(declaration.homeSpace)

    if (!homeSpace) {
      throw new Error(`context set references unknown home space: ${declaration.homeSpace}`)
    }
    const setId = input.freshId()
    setIdByName.set(declaration.name, setId)
    await input.persistence.contextSets.createSet({
      id: setId,
      homeSpace,
      name: declaration.name,
      items: declaration.items.flatMap((logicalId) => {
        const note = input.resolveNote(logicalId)
        return note ? [note] : []
      }),
      createdAt: input.createdAt,
    })
    contextSets += 1
    for (const attachment of declaration.attach ?? []) {
      const target = await input.resolveTarget(attachment)

      if (target) {
        await input.persistence.contextSets.attach({
          setId,
          ...target,
          createdAt: input.createdAt,
        })
      }
    }
  }

  for (const declaration of input.scopePins) {
    const note = input.resolveNote(declaration.note)
    const target = await input.resolveTarget(declaration.attach)

    if (!note || !target) {
      continue
    }
    await input.persistence.scopePins.addPin({
      ...target,
      noteSpace: note.space,
      noteId: note.noteId,
      createdAt: input.createdAt,
    })
    scopePins += 1
  }

  for (const declaration of input.contextOrder) {
    const target = await input.resolveTarget(declaration.scope)

    if (!target) {
      continue
    }
    const entries: Array<{ entryKind: 'pin' | 'set'; entryRef: string }> = []

    for (const entry of declaration.entries) {
      if (entry.kind === 'set') {
        const setId = setIdByName.get(entry.name)

        if (setId) {
          entries.push({ entryKind: 'set', entryRef: setId })
        }
      } else {
        const note = input.resolveNote(entry.note)

        if (note) {
          entries.push({ entryKind: 'pin', entryRef: note.noteId })
        }
      }
    }

    if (!entries.length) {
      continue
    }
    await input.persistence.contextOrder.setOrder(
      target.targetKind,
      target.targetId,
      target.targetSpace,
      entries,
    )
    contextOrders += 1
  }

  return { contextSets, scopePins, contextOrders, setIdByName }
}
