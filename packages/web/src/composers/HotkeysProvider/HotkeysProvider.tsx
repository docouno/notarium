import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'
import {
  type Binding,
  type Chord,
  chordFromEvent,
  chordKey,
  firesInInput,
  type HotkeyOverrides,
  loadOverrides,
  loadPreset,
  matchEditing,
  matchGlobal,
  type ResolvedKeymap,
  resolveKeymap,
  saveOverrides,
  savePreset,
} from '../../libs/hotkeys'
import {
  agentsRoute,
  feedRoute,
  filesRoute,
  graphRoute,
  settingsRoute,
  spaceRoute,
  trashRoute,
} from '../../libs/routing/routePaths'
import { useChrome } from '../ChromeProvider'
import { useEditing } from '../EditingProvider'
import { useSpace } from '../SpaceProvider'
import { useSpotlight } from '../SpotlightProvider'
import { Cheatsheet } from './Cheatsheet'

// HotkeysProvider (#30) — the ONE keyboard dispatcher. It resolves (active preset +
// user overrides) into a single keymap and is the sole owner of the global keydown
// listeners, the cheat sheet, and the persisted customisation. Everything else that
// used to wire its own listener (Spotlight's Cmd+P, the editor's Cmd+Enter, App.tsx's
// browser-default suppression) now flows through here, so there is exactly one place a
// key is interpreted — no parallel paths to drift (#30 §2/§5).
//
// It sits at the BOTTOM of the provider stack (inside Chrome/Space/Notes/Spotlight/
// Editing) because its handlers drive all of them; placement there also means the
// Settings editor, the cheat sheet and the editor keymap all read the same context.

type HotkeysApi = {
  resolved: ResolvedKeymap
  presetId: string
  setPreset: (id: string) => void
  overrides: HotkeyOverrides
  /** Replace an action's FULL set of bindings ([] = unbound). */
  setActionBindings: (actionId: string, bindings: Binding[]) => void
  /** Drop a single override → back to the preset default. */
  resetBinding: (actionId: string) => void
  /** Drop every override. */
  resetAll: () => void
  openCheatsheet: () => void
  /** While true the dispatcher stands down so the Settings editor can capture a raw
   *  keystroke (otherwise the key being recorded would also fire its action). */
  setRecording: (on: boolean) => void
}

const HotkeysContext = createContext<HotkeysApi | null>(null)

export const useHotkeys = (): HotkeysApi => {
  const ctx = useContext(HotkeysContext)

  if (!ctx) {
    throw new Error('useHotkeys must be used within HotkeysProvider')
  }

  return ctx
}

// How long a `g` prefix waits for its second key before it lapses.
const SEQUENCE_TIMEOUT_MS = 1200

/** A focused element that swallows plain-key shortcuts (you're typing into it). The
 *  CodeMirror surface counts — its `.cm-content` is contenteditable. */
const isEditableTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) {
    return false
  }
  const tag = el.tagName

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true
  }
  if (el.isContentEditable) {
    return true
  }

  return !!el.closest('.cm-editor')
}

const modalOpen = (): boolean => !!document.querySelector('[aria-modal="true"]')

export const HotkeysProvider = ({ children }: { children: ReactNode }) => {
  const chrome = useChrome()
  const spotlight = useSpotlight()
  const editing = useEditing()
  const { space } = useSpace()
  const navigate = useNavigate()

  const [presetId, setPresetState] = useState(loadPreset)
  const [overrides, setOverridesState] = useState<HotkeyOverrides>(loadOverrides)
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

  const resolved = useMemo(() => resolveKeymap(presetId, overrides), [presetId, overrides])

  // Handler for each GLOBAL action id. Rebuilt when its deps change; the listener
  // reads it through a ref so it never has to re-subscribe (and never goes stale).
  const handlers = useMemo<Record<string, () => void>>(
    () => ({
      'palette.notes': () => spotlight.toggle(),
      // Both the ⌘P palette and the `/` "focus search" open the same quick-switcher
      // now — the rail Search VIEW was removed for the topbar search (#190).
      'search.focus': () => spotlight.open(),
      'help.keys': () => setCheatsheetOpen(true),
      'view.theme': () => chrome.setTheme(chrome.theme === 'dark' ? 'light' : 'dark'),
      'view.leftPanel': () => chrome.toggleLeftPanel(),
      'view.rightPanel': () => chrome.toggleAside(),
      'go.home': () => navigate(spaceRoute(space)),
      'go.feed': () => navigate(feedRoute(space)),
      'go.graph': () => navigate(graphRoute(space)),
      'go.files': () => navigate(filesRoute(space)),
      'go.agents': () => navigate(agentsRoute()),
      'go.trash': () => navigate(trashRoute(space)),
      'go.settings': () => navigate(settingsRoute()),
      'note.new': () => void editing.startNew(),
      'note.edit': () => editing.startEdit(),
    }),
    [chrome, spotlight, editing, navigate, space],
  )

  // Refs the listeners read — keeps the keydown subscription mounted ONCE.
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const editingRef = useRef(editing)
  editingRef.current = editing

  // ── Global dispatcher: capture phase on window, so a focused editor/input can't
  // swallow a shortcut before it reaches us (the layout-agnostic Cmd+P pattern from
  // #31, now generalised). Owns sequence state (the pending `g` prefix) + suppression.
  const pendingRef = useRef<Chord | null>(null)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Settings is recording a keystroke — the dispatcher stands aside (see setRecording).
  const recordingRef = useRef(false)
  const clearPending = useCallback(() => {
    pendingRef.current = null
    if (pendingTimer.current) {
      clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || recordingRef.current) {
        return
      } // mid-IME / Settings is capturing
      const chord = chordFromEvent(e)

      if (!chord) {
        return
      }
      const km = resolvedRef.current
      const inEditor = e.target instanceof Element && !!e.target.closest('.cm-editor')

      // Zone priority (VS Code's editorTextFocus): while focus is in the editor, ITS
      // chords win — defer entirely to CodeMirror, even when the same chord is also bound
      // to a global action (e.g. Cmd+D = multi-cursor here, "new note" elsewhere). Stand
      // fully aside: don't fire the global action and don't preventDefault (CM does that).
      if (inEditor && km.editorKeys.has(chordKey(chord))) {
        return
      }
      const editable = isEditableTarget(e.target)
      const m = matchGlobal(km, chord, {
        pending: pendingRef.current,
        editable,
        modalOpen: modalOpen(),
      })

      // The matcher consumed (or rejected) any in-flight prefix; reflect that.
      if (pendingRef.current && !m.pending) {
        clearPending()
      }
      if (m.pending) {
        clearPending()
        pendingRef.current = m.pending
        pendingTimer.current = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS)
      }
      if (m.preventDefault) {
        e.preventDefault()
      }
      if (m.actionId) {
        e.stopPropagation()
        handlersRef.current[m.actionId]?.()
        return
      }
      // No global action fired — suppress the browser default of any modifier chord the
      // app OWNS (Cmd+S save-page, Cmd+D bookmark, Cmd+P print…), so a stray press never
      // does the browser thing, in OR out of the surface that uses it. (Editor chords in
      // the editor already returned above, so CM still gets them.)
      if (!m.preventDefault && km.modifierBoundKeys.has(chordKey(chord))) {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      clearPending()
    }
  }, [clearPending])

  // ── Editing dispatcher: BUBBLE phase, so the editor's own popups get the key
  // first (the slash menu owns Escape; a snippet field owns Tab). Only live while a
  // draft is open. Save/Cancel chords come from the same resolved map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || recordingRef.current) {
        return
      }
      const ed = editingRef.current

      if (!ed.isEditing) {
        return
      }
      const chord = chordFromEvent(e)

      if (!chord) {
        return
      }
      const actionId = matchEditing(resolvedRef.current, chord)

      if (!actionId) {
        return
      }
      if (actionId === 'editing.save') {
        // Save must carry a modifier — a bare typing key bound here (only reachable via a
        // hand-edited override; the recorder blocks it) would save on every keystroke.
        if (!firesInInput(chord)) {
          return
        }
        // A dialog open over the editor owns its own confirm-Enter (#31 new-tab,
        // conflict dialog) — don't background-save from inside one.
        if (e.target instanceof Element && e.target.closest('[role="dialog"]')) {
          return
        }
        e.preventDefault()
        // This dispatcher runs in bubble phase, after the focused ChipInput/TextValue
        // handles Enter. React may not have committed that state yet, so build the
        // payload in a microtask; useNoteDraft's event-time refs already carry both a
        // focused text edit and an uncommitted list token from this key event.
        queueMicrotask(() => {
          const current = editingRef.current

          if (current.isEditing && current.editor.canSave && !current.saving) {
            void current.saveDraft(current.editor.buildPayload())
          }
        })

        return
      }
      if (actionId === 'editing.cancel') {
        // Esc is shared: a modal or the editor's autocomplete popup own it first. Only
        // exit the editor when neither is up.
        if (modalOpen() || document.querySelector('.cm-tooltip-autocomplete')) {
          return
        }
        e.preventDefault()
        void ed.ensureCanLeaveDraft().then((ok) => {
          if (ok) {
            ed.cancelEdit()
          }
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Persisted mutators.
  const setPreset = useCallback((id: string) => {
    setPresetState(id)
    savePreset(id)
  }, [])
  const setActionBindings = useCallback((actionId: string, bindings: Binding[]) => {
    setOverridesState((prev) => {
      const next = { ...prev, [actionId]: bindings }
      saveOverrides(next)
      return next
    })
  }, [])
  const resetBinding = useCallback((actionId: string) => {
    setOverridesState((prev) => {
      const next = { ...prev }
      delete next[actionId]
      saveOverrides(next)
      return next
    })
  }, [])
  const resetAll = useCallback(() => {
    setOverridesState({})
    saveOverrides({})
  }, [])

  const api = useMemo<HotkeysApi>(
    () => ({
      resolved,
      presetId,
      setPreset,
      overrides,
      setActionBindings,
      resetBinding,
      resetAll,
      openCheatsheet: () => setCheatsheetOpen(true),
      setRecording: (on: boolean) => {
        recordingRef.current = on
      },
    }),
    [resolved, presetId, setPreset, overrides, setActionBindings, resetBinding, resetAll],
  )

  return (
    <HotkeysContext.Provider value={api}>
      {children}
      {cheatsheetOpen && (
        <Cheatsheet resolved={resolved} onClose={() => setCheatsheetOpen(false)} />
      )}
    </HotkeysContext.Provider>
  )
}
