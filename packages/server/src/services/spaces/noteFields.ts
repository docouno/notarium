import { editNote, type FieldPatch, type KnowledgeStore } from '@notarium/core'

import type { FieldSchemaStore } from '../fields'
import { prepareFieldWrite } from '../fields'

export type SetNoteFieldsInput = {
  store: KnowledgeStore
  fieldSchemaStore?: FieldSchemaStore
  space: string
  id: string
  versionToken?: string
  fields: FieldPatch
  principal?: string
}

/** One metadata-only field patch under the note's ordinary CAS discipline. */
export const setNoteFields = async ({
  store,
  fieldSchemaStore,
  space,
  id,
  versionToken,
  fields,
  principal,
}: SetNoteFieldsInput): Promise<{ versionToken: string }> => {
  const fieldsUnquoted = await prepareFieldWrite(fieldSchemaStore, space, fields)
  const result = await editNote(store, {
    noteId: id,
    versionToken,
    fields,
    fieldsUnquoted,
    principal,
  })

  if (!result.versionToken) {
    throw new Error('field write returned no version token')
  }

  return { versionToken: result.versionToken }
}
