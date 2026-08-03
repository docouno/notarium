import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker, useLocation, useNavigate } from 'react-router'
import { HTTP_STATUS } from '@notarium/contract/http'
import { DEFAULT_NOTE_TYPE, STORE_ERROR_REASON } from '@notarium/core'
import { useDialog } from '../../../../core/Dialog'
import { useToast } from '../../../../core/Toast'
import {
  feedRoute,
  folderRoute,
  newDraftQuery,
  parseNewDraft,
  spaceRoute,
} from '../../../../libs/routing/routePaths'
import { folderOf } from '../../../../libs/tree/tree'
import type { NoteDetailView, SaveInput } from '../../../../libs/wire'
import { api, ApiError } from '../../../../services/api'
import { useNotes } from '../../../NotesProvider'
import { useSpace } from '../../../SpaceProvider'
import type { EditingContextValue, Ghost } from '../../types'
import { type Draft, useNoteDraft } from '../../useNoteDraft'
import styles from '../../EditingProvider.module.scss'

/** Whether a note title is short enough to name inside a button label. Titles are
 *  user-authored and unbounded, a button label never wraps, and a dialog row that
 *  cannot shrink pushes the label out of the panel on a phone — so a long title is
 *  DROPPED from the label rather than cut: truncation would only trade the overflow
 *  for a severed grapheme, and the name it was meant to preview is reported by the
 *  toast once the save lands anyway. Full-width scripts are counted double — the
 *  budget is rendered width, which is what actually overflows, not character count. */
const fitsInLabel = (title: string): boolean =>
  [...title].reduce((width, ch) => width + (ch.codePointAt(0)! > 0x2e7f ? 2 : 1), 0) <= 24

export const useEditingState = (): EditingContextValue => {
  const { space, canWrite } = useSpace()
  const { nav, note, clearReader, refreshFolders, openNote, reloadNote } = useNotes()
  const { confirm, alert, choice } = useDialog()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const [draft, setDraftState] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  // Live editing state, shared across the topbar actions, the main column
  // (EditorBody) and the aside (EditorMeta). Inert while `draft` is null.
  const editor = useNoteDraft(draft)
  const isEditing = draft != null

  // Refs mirror the latest values for the blocker predicate and key handlers,
  // which must not re-subscribe on every keystroke. draftRef is updated
  // synchronously on set so a navigation issued in the same tick sees it.
  const editorRef = useRef(editor)
  editorRef.current = editor
  const draftRef = useRef<Draft | null>(draft)
  // `bypassRef` silences the blocker for the synchronous window in which our
  // own already-confirmed actions navigate (the draft state hasn't re-rendered
  // yet, so the predicate would otherwise still see the old dirty draft).
  const bypassRef = useRef(false)

  const setDraft = useCallback((d: Draft | null) => {
    draftRef.current = d
    setDraftState(d)
  }, [])

  // Any router navigation while dirty is intercepted here (the other half of
  // the hybrid guard — non-navigation actions go through ensureCanLeaveDraft).
  const blocker = useBlocker(
    useCallback(() => {
      if (bypassRef.current) {
        return false
      }

      return !!(draftRef.current && editorRef.current.dirty)
    }, []),
  )

  const ensureCanLeaveDraft = useCallback(async () => {
    if (!(draftRef.current && editorRef.current.dirty)) {
      return true
    }

    return confirm({
      title: 'Discard unsaved changes?',
      message: 'Your edits to this note haven’t been saved.',
      confirmLabel: 'Discard',
      danger: true,
    })
  }, [confirm])

  // The current scope's URL — a new-note draft lives on top of it (a folder
  // browse stays on that folder, the space home stays put, Feed keeps its URL).
  // Everything is the ACTIVE space's URL (#16).
  const scopeHref = useCallback(() => {
    return nav.type === 'feed'
      ? feedRoute(space)
      : nav.type === 'folder'
        ? folderRoute(space, nav.folder)
        : spaceRoute(space)
  }, [nav, space])

  // Open a new-note draft by NAVIGATING to its URL: the create-intent rides the
  // query on the scope URL (?new&title&dir&link), and the seed effect below turns
  // it into a live draft on landing. Going through the URL is what makes the form
  // survive back/forward/reload (#65) — an ephemeral draft owned no history entry,
  // so forward-nav and refresh dropped it. The reader is cleared so the editor
  // overlays cleanly; bypassRef silences the unsaved-guard for this one navigation
  // (any old draft is discarded by the clear-on-nav effect, then re-seeded).
  const goNewDraft = useCallback(
    (prefill: { title?: string; dir?: string; links?: string[] }) => {
      clearReader()
      bypassRef.current = true
      navigate(`${scopeHref()}${newDraftQuery(prefill)}`)
      bypassRef.current = false
    },
    [clearReader, navigate, scopeHref],
  )

  // Start a blank new-note draft. `directory` defaults to the current browse
  // folder; pass an explicit string (incl. '') to create in a specific folder
  // (the tree context menu's "New note"). Non-string values are tolerated because
  // toolbar buttons wire onClick straight to startNew (React passes the event).
  const startNew = useCallback(
    async (directory?: unknown) => {
      if (!canWrite) {
        return
      } // reader-gating (#111): no create path, even if an affordance leaked
      if (!(await ensureCanLeaveDraft())) {
        return
      }
      const dir =
        typeof directory === 'string' ? directory : nav.type === 'folder' ? nav.folder : ''
      goNewDraft({ dir })
    },
    [canWrite, ensureCanLeaveDraft, nav, goNewDraft],
  )

  // Start a new-note draft that "closes" an unresolved (ghost) link. Two things
  // must hold for the link to resolve once saved:
  //  - the new note's slug must equal the ghost's target slug (the resolver matches
  //    [[links]] by slug), which the server guaranteed via prefillTitle;
  //  - the body carries a [[backlink]] to every note that pointed at the ghost, so
  //    the relation is visible from both sides right away.
  // Directory is best-effort: an explicit folder in the ghost's target path wins,
  // else sit beside the (first) referencing note, else root — always editable.
  const createFromGhost = useCallback(
    async (ghost: Ghost | null) => {
      if (!ghost) {
        return
      }
      // A reader can't turn a ghost into a note — answer honestly (the same toast
      // the wiki-link path gives) instead of a silent no-op, on every ghost-create
      // surface (inspector links, graph). #111 reader-gating.
      if (!canWrite) {
        toast.error('This note doesn’t exist.')
        return
      }
      if (!(await ensureCanLeaveDraft())) {
        return
      }
      const sources = Array.isArray(ghost.sources) ? ghost.sources : []
      const targetDir = ghost.target && ghost.target.includes('/') ? folderOf(ghost.target) : ''
      goNewDraft({
        title: ghost.prefillTitle || ghost.title || '',
        dir: targetDir || sources[0]?.folder || '',
        links: sources.map((s) => s.title).filter(Boolean),
      })
    },
    [canWrite, ensureCanLeaveDraft, goNewDraft, toast],
  )

  // Follow a [[wiki link]] the reader's session cache couldn't resolve. The cache
  // is best-effort (only what's been listed this session), so a miss there is NOT
  // proof the note is absent — ask the server's resolver (WITHIN the space, #16).
  // A hit opens the real note; a genuine 404 is a ghost → create-from-ghost it,
  // prefilled so saving closes the link (slug from the link's last segment, a
  // [[backlink]] to the note we came from). Variant C of #65: a broken link is an
  // invitation to create, not an error.
  const openOrCreateFromWiki = useCallback(
    async (target: string) => {
      try {
        const found = await api.noteResolve(space, target)
        await openNote(found.id)
      } catch (e) {
        if (e instanceof ApiError && e.status === HTTP_STATUS.NOT_FOUND) {
          // A reader can't turn a broken link into a new note — it's just absent.
          if (!canWrite) {
            toast.error('This note doesn’t exist.')
            return
          }
          await createFromGhost({
            title: target.split('/').pop() || target,
            target,
            sources:
              note && note.id && note.filePath
                ? [{ id: note.id, title: note.title || '', folder: folderOf(note.filePath) }]
                : [],
          })
          return
        }
        toast.error((e as Error).message)
      }
    },
    [space, canWrite, openNote, createFromGhost, note, toast],
  )

  // The version the editor read, pinned when editing STARTS (#50). A ref, not
  // draft state, for two reasons: updating it (conflict dialog) must not
  // re-seed useNoteDraft and wipe the typed text; and it must NOT follow a
  // live `note` refresh (SSE-driven reload) — the token asserts what the user
  // actually saw, that's the whole CAS handshake.
  const versionTokenRef = useRef<string | undefined>(undefined)

  const startEdit = useCallback(() => {
    if (!note || !canWrite) {
      return
    }
    versionTokenRef.current = note.versionToken
    setDraft({
      isNew: false,
      slug: note.slug || '', // #100 phase 1: prefill the custom slug ('' = implicit default)
      directory: folderOf(note.filePath),
      // Reconstruct the WHOLE document (#156): the stored body has its title H1
      // stripped (the reader serves it that way), so prepend `# <title>`. The editor
      // edits the title inline as the first line; the save chokepoint derives the
      // title from it and strips the heading back off. The versionToken (pinned
      // above) is unaffected — it tracks the stored, H1-less body.
      content: note.title ? `# ${note.title}\n\n${note.content}` : note.content,
      tags: Array.isArray(note.frontmatter?.tags) ? (note.frontmatter.tags as string[]) : [],
      noteType: (note.frontmatter?.type as string) || DEFAULT_NOTE_TYPE,
      // Prefill the editable creation date (#186) from the note's resolved instant.
      createdAt: note.createdAt ?? null,
    })
  }, [note, canWrite, setDraft])

  const startFolderPageEdit = useCallback(
    async (folderPath: string, title: string) => {
      if (!canWrite) {
        return
      }
      if (!(await ensureCanLeaveDraft())) {
        return
      }
      versionTokenRef.current = undefined
      setDraft({
        isNew: true,
        folderPagePath: folderPath,
        saveRequiresDirty: true,
        lockDirectory: true,
        slug: '',
        directory: folderPath,
        content: `# ${title}\n\n`,
        tags: [],
        noteType: DEFAULT_NOTE_TYPE,
        createdAt: null,
      })
    },
    [canWrite, ensureCanLeaveDraft, setDraft],
  )

  const resolveFolderPageMaterializeConflict = useCallback(
    async (current: NoteDetailView, payload: SaveInput, folderPagePath: string): Promise<void> => {
      let live = current

      for (;;) {
        const picked = await choice({
          title: 'Folder page already exists',
          message:
            'This folder page was saved elsewhere after you started editing. Your draft is still here; choose whether to keep editing or explicitly replace the saved page.',
          options: [
            { value: 'cancel', label: 'Keep editing' },
            { value: 'overwrite', label: 'Save my version', variant: 'danger' },
            { value: 'view', label: 'Show saved page', variant: 'primary' },
          ],
        })

        if (picked === 'overwrite') {
          try {
            const saved = await api.noteSave(space, {
              ...payload,
              originalId: live.id,
              versionToken: live.versionToken,
            })
            await refreshFolders([folderPagePath])
            setDraft(null)
            await openNote(saved.id)
            return
          } catch (e) {
            if (e instanceof ApiError && e.status === HTTP_STATUS.CONFLICT && e.current) {
              live = e.current
              continue
            }
            throw e
          }
        }
        if (picked === 'view') {
          await alert({
            size: 'lg',
            title: 'Saved folder page',
            message: (
              <>
                <p className={styles.conflictHint}>
                  Read-only. Your draft is untouched in the editor.
                </p>
                <pre className={styles.conflictBody} data-testid="folder-page-current-content">
                  {live.content}
                </pre>
              </>
            ),
            confirmLabel: 'Back to my draft',
          })
        }

        return
      }
    },
    [choice, alert, openNote, refreshFolders, setDraft, space],
  )

  // The create-collision flow: the folder already holds a note under this title
  // and the server refused rather than replace its body. Like the CAS conflict
  // below, NOTHING is lost at this point — the draft is untouched in the editor;
  // this dialog only decides what happens next. Answers the SaveInput to retry
  // with, or null to stay put. `existing` is absent when the collision was caught
  // on disk truth alone, and the "open it" way out honestly disappears with it.
  const resolveCreateCollision = useCallback(
    async (err: ApiError, payload: SaveInput): Promise<SaveInput | null> => {
      const taken = err.existing
      // A named occupant with NO free name offered means the whole `<title> N` series
      // is taken: retrying with uniquify would only reproduce this dialog, so the
      // option is dropped rather than dangled. Without an occupant the refusal came
      // from disk truth, where uniquify still steps past the file it cannot name.
      const canFreeName = !taken || Boolean(err.suggestedTitle)
      const keepEditing = { value: 'cancel', label: 'Keep editing' }
      const openExisting = taken ? [{ value: 'open', label: 'Open the existing note' }] : []
      const saveFree = canFreeName
        ? [
            {
              value: 'uniquify',
              // Name the free title the server picked; the generic wording covers both
              // a refusal from disk truth (no suggestion at all) and a title too long
              // to sit in a label.
              label:
                err.suggestedTitle && fitsInLabel(err.suggestedTitle)
                  ? `Save as “${err.suggestedTitle}”`
                  : 'Save under a free name',
              variant: 'primary' as const,
            },
          ]
        : []
      const picked = await choice({
        // Three actions, one of them carrying a note title — they do not fit the
        // default panel on one row, and a stacked row of buttons reads worse here
        // than a wider panel.
        size: 'md',
        title: 'A note with this name already exists here',
        message: taken
          ? `“${taken.title}” already lives in this folder. Your text is untouched — nothing has been overwritten.`
          : 'This folder already holds a file under this name. Your text is untouched — nothing has been overwritten.',
        // The dialog focuses its LAST option (core/Dialog), and a save shortcut leaves
        // the keyboard on it — so the trailing slot is always a SAFE action. Opening
        // the existing note is the one branch that drops the draft; it never sits there.
        options: canFreeName
          ? [keepEditing, ...openExisting, ...saveFree]
          : [...openExisting, keepEditing],
      })

      if (picked === 'uniquify') {
        return { ...payload, ifExists: 'uniquify' }
      }
      // Leaving for the existing note drops the draft, so it goes through the same
      // discard confirmation every other "leave a dirty draft" path uses — the
      // dialog above promised the text was safe.
      if (picked === 'open' && taken && (await ensureCanLeaveDraft())) {
        setDraft(null)
        await openNote(taken.id)
      }

      return null
    },
    [choice, ensureCanLeaveDraft, openNote, setDraft],
  )

  const saveDraft = useCallback(
    async (payload: SaveInput) => {
      // Root guard (#111): if the role was downgraded to reader mid-edit, the save
      // would 403 — refuse it honestly instead. Covers both the Save button and the
      // ⌘/Ctrl+Enter shortcut, which bypasses any button gating.
      if (!canWrite) {
        toast.error('You have read-only access to this space.')
        return
      }
      setSaving(true)
      try {
        const folderPagePath = draftRef.current?.folderPagePath

        if (folderPagePath !== undefined) {
          try {
            const created = await api.folderPageCreate(space, folderPagePath, payload)
            await refreshFolders([folderPagePath])
            setDraft(null)
            await openNote(created.pageNoteId)
          } catch (e) {
            // Another tab/agent may have materialised the same virtual folder page
            // after this draft started. Treat that as a real edit conflict: keep this
            // draft until the user explicitly decides whether to overwrite.
            if (e instanceof ApiError && e.status === HTTP_STATUS.CONFLICT) {
              const liveTree = await api.treeGet(space)
              const pageNoteId =
                liveTree.folders.find((f) => f.path === folderPagePath)?.pageNoteId ?? null

              if (pageNoteId) {
                const current = await api.noteGet(pageNoteId)
                await resolveFolderPageMaterializeConflict(current, payload, folderPagePath)
                return
              }
            }
            throw e
          }

          return
        }
        // Editing an existing note: pass its note-id so the backend renames/moves
        // the file in place (via move_note) instead of writing a duplicate, plus
        // the version token the edit started from — the server refuses to
        // overwrite a note that changed underneath (409, #50).
        const isEdit = Boolean(draftRef.current && !draftRef.current.isNew && note)
        const body = isEdit
          ? { ...payload, originalId: note!.id, versionToken: versionTokenRef.current }
          : payload
        const saved = await api.noteSave(space, body)
        // Narrow refresh (#94): the saved note's folder, plus — when an edit moved
        // it out of its old directory — that one too. Never the whole loaded set.
        const savedDir = payload.directory ?? ''
        const dirs = isEdit && note ? [savedDir, folderOf(note.filePath)] : [savedDir]
        await refreshFolders(dirs)
        setDraft(null)
        if (isEdit) {
          // Same id — the URL holds still across the save (even a rename); the
          // reader just refreshes in place.
          await reloadNote()
        } else {
          // A uniquify retry lands under a name the user did not type — say which,
          // so the rename they consented to is still visible.
          if (payload.ifExists && saved.title) {
            toast.success(`Saved as “${saved.title}”.`)
          }
          await openNote(saved.id)
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === HTTP_STATUS.CONFLICT && e.current) {
          await resolveConflict(e.current, payload)
          return
        }
        if (
          e instanceof ApiError &&
          e.status === HTTP_STATUS.CONFLICT &&
          e.reason === STORE_ERROR_REASON.noteAlreadyExists
        ) {
          const retry = await resolveCreateCollision(e, payload)

          if (retry) {
            await saveDraft(retry)
          }

          return
        }
        // A failed save keeps the draft in the editor (nothing lost) and reports
        // the reason as a toast — not the old global banner (#65). The draft stays
        // open so the user can retry or copy their text out.
        toast.error((e as Error).message)
      } finally {
        setSaving(false)
      }
      // resolveConflict is declared after this callback (it retries via
      // saveDraft — mutual recursion), and the uniquify retry above re-enters
      // saveDraft itself; both closures capture this render's binding, so the
      // reference is always the in-sync one.
    },
    [
      note,
      space,
      canWrite,
      refreshFolders,
      openNote,
      reloadNote,
      toast,
      setDraft,
      resolveCreateCollision,
      resolveFolderPageMaterializeConflict,
    ],
  )

  // The 409 flow (#50): the save lost the race — another tab, an agent or an
  // external edit wrote first. NOTHING is lost at this point (the server
  // refused to overwrite, the draft is still in the editor); this dialog only
  // decides what happens next. P3 in UI form: no option silently drops a side.
  const resolveConflict = useCallback(
    async (current: NoteDetailView, payload: SaveInput) => {
      const picked = await choice({
        title: 'Note changed on the server',
        message:
          'This note was saved by someone else — another tab, an agent or an external edit — after you started editing. Your text is untouched; nothing has been overwritten yet.',
        options: [
          { value: 'cancel', label: 'Keep editing' },
          { value: 'overwrite', label: 'Save my version', variant: 'danger' },
          { value: 'view', label: 'Show latest', variant: 'primary' },
        ],
      })

      if (picked === 'overwrite') {
        // Retry with the token of the version the user just chose to discard —
        // an explicit, informed overwrite. If a THIRD write sneaks in meanwhile,
        // the CAS honestly conflicts again.
        versionTokenRef.current = current.versionToken
        await saveDraft(payload)
        return
      }
      if (picked === 'view') {
        // Viewing is purely informational — it does NOT adopt the live token.
        // Overwriting must always be the explicit dialog action: the next save
        // conflicts again (with whatever is live by then) and the only way
        // through is "Save my version". Time may pass between viewing and
        // saving; a plain-looking Save must never overwrite silently.
        await alert({
          size: 'lg',
          title: 'Latest saved version',
          message: (
            <>
              <p className={styles.conflictHint}>
                Read-only. Your draft is untouched in the editor — carry over what you need. Saving
                will ask again before anything is overwritten.
              </p>
              <pre className={styles.conflictBody} data-testid="conflict-current-content">
                {current.content}
              </pre>
            </>
          ),
          confirmLabel: 'Back to my draft',
        })
      }
      // 'cancel' / Escape: keep editing with the stale token — a later save
      // conflicts again, which is honest.
    },
    [choice, alert, saveDraft],
  )

  // Cancel falls back to whatever the reader holds underneath the overlay: the
  // open note (edit) or the splash/folder browse (new). For a new-note draft the
  // form lived on a ?new URL — strip the intent so a reload or forward-nav doesn't
  // resurrect the form the user just dismissed (setDraft(null) first, so the
  // clean-up navigation isn't itself guarded).
  const cancelEdit = useCallback(() => {
    setDraft(null)
    if (parseNewDraft(window.location.search)) {
      navigate(window.location.pathname, { replace: true })
    }
  }, [setDraft, navigate])

  const guarded = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      async (...args: A) => {
        if (!(await ensureCanLeaveDraft())) {
          return
        }
        if (draftRef.current) {
          setDraft(null)
        }
        bypassRef.current = true
        try {
          fn(...args)
        } finally {
          bypassRef.current = false
        }
      },
    [ensureCanLeaveDraft, setDraft],
  )

  // A blocked navigation = the dirty-draft confirm, then proceed or stay.
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      return
    }
    let stale = false
    void ensureCanLeaveDraft().then((ok) => {
      if (stale) {
        return
      }
      if (ok) {
        blocker.proceed()
      } else {
        blocker.reset()
      }
    })
    return () => {
      stale = true
    }
  }, [blocker, ensureCanLeaveDraft])

  // A landed navigation exits editing — the old draft must not survive under the
  // new location. Runs on every navigation; the seed effect below re-creates the
  // draft afterwards when the new URL itself asks for one (a ?new create-intent),
  // so a clear→seed pair handles "navigate from one new-draft URL to another".
  useEffect(() => {
    if (draftRef.current) {
      setDraft(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  // Seed a new-note draft from a ?new URL (#65). Reached three ways and all must
  // restore the form: the create action navigates here, and so do browser
  // back/forward and a reload of the same URL. Idempotent — seeds only when the
  // URL asks for it and no draft is live (the clear effect above ran first, so a
  // stale draft is already gone; typing never re-seeds, deps are location-only).
  useEffect(() => {
    const nd = parseNewDraft(location.search)

    // A reader who deep-links a ?new URL must not be dropped into an editor.
    if (!nd || draftRef.current || !canWrite) {
      return
    }
    const linkLines = nd.links.length ? `${nd.links.map((l) => `[[${l}]]`).join('\n')}\n` : ''
    setDraft({
      isNew: true,
      slug: '', // #100 phase 1: a new note starts on the implicit title-derived slug
      directory: nd.dir,
      // Open on the title line (#156): a titled new note (created from a ghost link)
      // pre-fills its `# H1`; a blank one starts on an empty `# ` so the caret lands
      // on the title slot (EditorBody seeds cursor:'end'). Any prefill links follow.
      content: nd.title
        ? `# ${nd.title}\n\n${linkLines}`
        : `# ${linkLines ? `\n\n${linkLines}` : ''}`,
      tags: [],
      noteType: DEFAULT_NOTE_TYPE,
      // A fresh note has no instant yet — the date field starts empty and the engine
      // dates it now unless the user backdates it (#186).
      createdAt: null,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  // A tab close/reload while dirty falls back to the browser's native prompt.
  useEffect(() => {
    if (!(isEditing && editor.dirty)) {
      return
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isEditing, editor.dirty])

  // The editing shortcuts (Save = ⌘/Ctrl+Enter, Cancel = Esc by default) are owned by
  // the central HotkeysProvider (#30): it reads `isEditing`/`editor`/`saving` off this
  // context and calls `saveDraft`/`cancelEdit`, with the same "a dialog owns Enter"
  // and "the slash menu owns Esc" guards. The bindings are customisable in Settings.

  const value: EditingContextValue = {
    isEditing,
    draft,
    editor,
    saving,
    startNew,
    startEdit,
    startFolderPageEdit,
    createFromGhost,
    openOrCreateFromWiki,
    saveDraft,
    cancelEdit,
    ensureCanLeaveDraft,
    guarded,
  }

  return value
}
