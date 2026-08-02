import { useState } from 'react'
import type { Draft } from '../../../../composers/EditingProvider'

// Edit ↔ Preview lives in the topbar (a single toggle button left of Save), so
// its state is lifted here; EditorBody renders source or the rendered draft off
// it. `editorKey` remounts EditorBody/CodeEditor on every fresh draft — CodeMirror
// seeds its document once on mount and never re-reads `value`, so without a per-
// draft key a draft→draft SWAP that keeps EditorBody mounted (e.g. "New note"
// while already editing: the clear+seed effects batch, so `draft` goes A→B with no
// intermediate null commit and isEditing never flips false) would leave the editor
// — and the status bar, the preview snapshot, the live save-getter — showing the
// PREVIOUS note's body (it would even save A's text under B). Both the key bump and
// the Preview→source reset run DURING render (prev-value pattern) so the remount
// already lands on source: an effect would lag a frame and fire the preview→edit
// refocus, stealing the caret into a brand-new note's body.
export const useEditorPreview = (draft: Draft | null) => {
  const [editorPreview, setEditorPreview] = useState(false)
  const [seenDraft, setSeenDraft] = useState(draft)
  const [editorKey, setEditorKey] = useState(0)

  if (seenDraft !== draft) {
    setSeenDraft(draft)
    setEditorPreview(false)
    setEditorKey((k) => k + 1)
  }

  return { editorPreview, setEditorPreview, editorKey }
}
