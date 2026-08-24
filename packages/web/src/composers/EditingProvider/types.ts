import type { SaveInput } from '../../libs/wire'
import type { Draft, NoteDraftEditor } from './useNoteDraft'

type GhostSource = { id?: string; title: string; folder: string }

/** An unresolved (ghost) graph node a new note can be created from. */
export type Ghost = {
  title?: string
  prefillTitle?: string
  prefillDirectory?: string
  target?: string
  creatable?: boolean
  sources?: GhostSource[]
}

export type EditingSessionAdapter = {
  /** Stable for one routed document/draft; repeated registration is idempotent. */
  id: string
  draft: Draft
  canWrite: boolean
  /** Live target admission shared by buttons, hotkeys and the root Save guard. */
  canSave?: (editor: NoteDraftEditor) => boolean
  versionToken?: string
  save: (payload: SaveInput, versionToken?: string) => Promise<unknown>
  onSaved?: (result: unknown) => void | Promise<void>
  /** Cleanup shared by explicit cancel and a confirmed navigation away. */
  onDiscard?: () => void
  /** Extra action for the explicit Cancel control only (for example, leave a draft route). */
  onCancel?: () => void
  discardMessage?: string
}

export type EditingContextValue = {
  isEditing: boolean
  draft: Draft | null
  editor: NoteDraftEditor
  saving: boolean
  startSession: (adapter: EditingSessionAdapter) => void
  startNew: (directory?: unknown) => Promise<void>
  startEdit: () => void
  startFolderPageEdit: (folderPath: string, title: string) => Promise<void>
  createFromGhost: (ghost: Ghost | null) => Promise<void>
  /** Follow a [[wiki link]] the session cache couldn't resolve: ask the server,
   *  open the real note if it exists, else create-from-ghost it (#65 variant C). */
  openOrCreateFromWiki: (target: string) => Promise<void>
  saveDraft: (payload: SaveInput) => Promise<void>
  cancelEdit: () => void
  /** True when it's safe to drop the draft (clean, or the user confirmed). */
  ensureCanLeaveDraft: () => Promise<boolean>
  /** Wrap a non-navigation action so it first checks for unsaved edits and
   *  exits editing before running. */
  guarded: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => Promise<void>
}
