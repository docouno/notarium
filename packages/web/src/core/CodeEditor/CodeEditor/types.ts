import { type TextStats } from '../../../libs/editorStats'
import { type FocusGranularity } from '../focusMode'

/** Live text metrics the editor reports (#115): the whole document, plus the
 *  selection when it's non-empty (selection-aware status bar). */
export type EditorStatsReport = { doc: TextStats; selection: TextStats | null }

export type ToggleRef = {
  current: { onToggleFocus?: () => void; onToggleTypewriter?: () => void }
}

export type Focus = 'off' | FocusGranularity
