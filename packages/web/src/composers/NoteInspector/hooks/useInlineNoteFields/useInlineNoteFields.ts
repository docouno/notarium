import { useCallback, useEffect, useRef, useState } from 'react'

import type { NoteDetailView } from '../../../../libs/wire'

export type InlineFieldValue = string | string[]
type InlineFieldValues = Record<string, InlineFieldValue>
type PointWrite = (input: {
  id: string
  versionToken?: string
  fields: Record<string, InlineFieldValue | null>
}) => Promise<{ versionToken: string }>

const cloneFieldValues = (source: InlineFieldValues | undefined): InlineFieldValues => {
  const copy = Object.create(null) as InlineFieldValues

  for (const key of Object.getOwnPropertyNames(source ?? {})) {
    copy[key] = source![key]
  }

  return copy
}

export const useInlineNoteFields = ({
  note,
  canWrite,
  write,
  reload,
  onError,
}: {
  note: NoteDetailView | null
  canWrite: boolean
  write: PointWrite
  reload: () => Promise<boolean>
  onError: (message: string) => void
}) => {
  const [values, setValues] = useState<InlineFieldValues>(() =>
    cloneFieldValues(note?.fields?.keys),
  )
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const token = useRef(note?.versionToken)
  const active = useRef({ id: note?.id, versionToken: note?.versionToken })
  active.current = { id: note?.id, versionToken: note?.versionToken }
  const requestSeq = useRef(0)

  useEffect(() => {
    requestSeq.current += 1
    setValues(cloneFieldValues(note?.fields?.keys))
    token.current = note?.versionToken
    setBusyKey(null)
  }, [note?.fields?.keys, note?.id, note?.versionToken])

  const setField = useCallback(
    async (key: string, value: InlineFieldValue | null) => {
      if (!note?.id || busyKey || !canWrite) {
        return
      }
      const previous = cloneFieldValues(values)
      const next = cloneFieldValues(values)
      const requestId = note.id
      const requestVersion = note.versionToken
      const request = ++requestSeq.current
      const isCurrent = () =>
        request === requestSeq.current &&
        active.current.id === requestId &&
        active.current.versionToken === requestVersion

      if (value === null) {
        delete next[key]
      } else {
        next[key] = value
      }
      setValues(next)
      setBusyKey(key)
      let result: { versionToken: string }

      try {
        result = await write({
          id: requestId,
          versionToken: token.current,
          fields: { [key]: value },
        })
      } catch (cause) {
        if (!isCurrent()) {
          return
        }
        const error = cause as Error & {
          reason?: string
          current?: NoteDetailView
        }
        const conflictCurrent =
          error.reason === 'version_conflict' && error.current?.id === requestId
            ? error.current
            : undefined

        if (conflictCurrent) {
          token.current = conflictCurrent.versionToken
          setValues(cloneFieldValues(conflictCurrent.fields?.keys))
        } else {
          setValues(previous)
        }
        onError(error.message || 'Could not update field')
        if (conflictCurrent) {
          await reload().catch(() => undefined)
        }
        if (isCurrent()) {
          setBusyKey(null)
        }

        return
      }
      if (!isCurrent()) {
        return
      }
      token.current = result.versionToken
      try {
        const refreshed = await reload()

        if (!refreshed) {
          throw new Error('note refresh failed')
        }
      } catch {
        if (isCurrent()) {
          onError('Field was saved, but the note could not be refreshed')
        }
      }
      if (isCurrent()) {
        setBusyKey(null)
      }
    },
    [busyKey, canWrite, note?.id, note?.versionToken, onError, reload, values, write],
  )

  return { values, busyKey, setField }
}
