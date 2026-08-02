import { useCallback } from 'react'
import { useToast } from './Toast'

// One place for "put text on the clipboard, then confirm it" — so every copy
// affordance (Copy note id, Copy wikilink, Copy path…) gives the same visible
// feedback instead of copying silently (#232). `label` names WHAT was copied and
// `subject` names WHICH thing (the note title) so the toast reads
// "Copied note id: “My note”" — a bare id/wikilink isn't self-explanatory, so
// naming the note makes clear exactly what landed on the clipboard. Async-safe:
// the Clipboard API rejects (denied permission, insecure context) on the returned
// promise, not by throwing, so we branch on both missing-API and rejection.
type CopyMeta = { label?: string; subject?: string }

export const useCopy = () => {
  const toast = useToast()
  return useCallback(
    (text: string, meta: CopyMeta = {}) => {
      const label = meta.label ?? 'text'
      const subject = meta.subject?.trim()
      const done = subject ? `Copied ${label}: “${subject}”` : `Copied ${label}`
      const clip = navigator.clipboard

      if (!clip?.writeText) {
        toast.error('Clipboard isn’t available in this browser')
        return
      }
      void clip.writeText(text).then(
        () => toast.success(done),
        () => toast.error('Couldn’t copy to clipboard'),
      )
    },
    [toast],
  )
}
