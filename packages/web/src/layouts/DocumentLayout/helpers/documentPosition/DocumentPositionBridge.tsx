import { type Text } from '@codemirror/state'
import { type EditorView, type ViewUpdate } from '@codemirror/view'
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePageFrameScroll } from '../../../PageFrame'
import {
  captureFullSourcePosition,
  captureRenderedPosition,
  createDocumentBodyPositionModel,
  createFullSourcePositionModel,
  type DocumentPositionAnchor,
  type FullSourcePositionModel,
  type RenderedHeadingGeometry,
  resolveFullSourcePosition,
  resolveRenderedPosition,
} from './documentPosition'

const POSITION_ROOT = '[data-document-position-root]'
const TRANSFER_GAP = 6

type PositionKey = {
  noteId: string
  generation: number
  surface: 'document'
}

type PositionSnapshot = {
  key: PositionKey
  anchor: DocumentPositionAnchor
  source: string
  versionToken: string
}

type ReaderSnapshot = Omit<PositionSnapshot, 'key'> & { noteId: string }

type ActivePositionIntent =
  { kind: 'enterPending'; snapshot: PositionSnapshot } | { kind: 'editing'; key: PositionKey }

type PositionIntent =
  | { kind: 'idle' }
  | ActivePositionIntent
  | { kind: 'exitPending'; snapshot: PositionSnapshot; resume: ActivePositionIntent }

export type DocumentPositionNote = {
  id: string
  body: string
  versionToken: string
}

export type DocumentPositionControls = {
  initialSelection?: number
  onEditorView: (view: EditorView | null) => void
  onEditorUpdate: (view: EditorView, update: ViewUpdate) => void
}

type DocumentPositionBridgeProps = {
  note: DocumentPositionNote | null
  routeNoteId: string | null
  standardReader: boolean
  isEditing: boolean
  saving: boolean
  preview: boolean
  typewriter: boolean
  draftContent: string | null
  registerBeforeStartEdit: (capture: () => void) => () => void
  registerBeforeCancelEdit: (capture: () => void) => () => void
  children: (controls: DocumentPositionControls) => ReactNode
}

const px = (value: string): number => parseFloat(value) || 0

const topInset = (): number =>
  px(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h'))

const headingGeometry = (root: HTMLElement): RenderedHeadingGeometry[] =>
  Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    top: heading.getBoundingClientRect().top,
  }))

const rootGeometry = (
  scroller: HTMLElement,
): {
  root: HTMLElement
  top: number
  bottom: number
  headings: RenderedHeadingGeometry[]
} | null => {
  const root = scroller.querySelector<HTMLElement>(POSITION_ROOT)

  if (!root) {
    return null
  }
  const rect = root.getBoundingClientRect()

  if (!(rect.bottom > rect.top)) {
    return null
  }

  return { root, top: rect.top, bottom: rect.bottom, headings: headingGeometry(root) }
}

export const DocumentPositionBridge = ({
  note,
  routeNoteId,
  standardReader,
  isEditing,
  saving,
  preview,
  typewriter,
  draftContent,
  registerBeforeStartEdit,
  registerBeforeCancelEdit,
  children,
}: DocumentPositionBridgeProps) => {
  const scrollRef = usePageFrameScroll()
  const [intent, setIntentState] = useState<PositionIntent>({ kind: 'idle' })
  const noteBody = note?.body ?? null
  const readerPositionModel = useMemo(
    () => (standardReader && noteBody !== null ? createDocumentBodyPositionModel(noteBody) : null),
    [noteBody, standardReader],
  )
  const needsDraftPositionModel = intent.kind === 'enterPending'
  const draftPositionModel = useMemo(
    () =>
      needsDraftPositionModel && draftContent !== null
        ? createFullSourcePositionModel(draftContent)
        : null,
    [draftContent, needsDraftPositionModel],
  )
  const intentRef = useRef(intent)
  const generationRef = useRef(0)
  const latestReaderRef = useRef<ReaderSnapshot | null>(null)
  const latestEditorRef = useRef<PositionSnapshot | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const editorSourceRef = useRef<{ doc: Text; model: FullSourcePositionModel } | null>(null)
  const captureRafRef = useRef(0)
  const alignmentRafRef = useRef(0)
  const alignedFrameRef = useRef(0)
  const currentRef = useRef({
    note,
    routeNoteId,
    standardReader,
    isEditing,
    saving,
    preview,
    typewriter,
    readerPositionModel,
  })
  currentRef.current = {
    note,
    routeNoteId,
    standardReader,
    isEditing,
    saving,
    preview,
    typewriter,
    readerPositionModel,
  }

  const setIntent = useCallback((next: PositionIntent) => {
    intentRef.current = next
    setIntentState(next)
  }, [])

  const cancelCaptureFrame = useCallback(() => {
    if (captureRafRef.current) {
      cancelAnimationFrame(captureRafRef.current)
      captureRafRef.current = 0
    }
  }, [])

  const cancelAlignmentFrame = useCallback(() => {
    if (alignmentRafRef.current) {
      cancelAnimationFrame(alignmentRafRef.current)
      alignmentRafRef.current = 0
    }
    alignedFrameRef.current = 0
  }, [])

  const captureReaderNow = useCallback((): ReaderSnapshot | null => {
    const current = currentRef.current
    const scroller = scrollRef.current

    if (
      !current.standardReader ||
      !current.note ||
      !current.readerPositionModel ||
      current.routeNoteId !== current.note.id ||
      !scroller
    ) {
      return null
    }
    const geometry = rootGeometry(scroller)

    if (!geometry) {
      return null
    }
    const scrollerRect = scroller.getBoundingClientRect()
    const anchor = captureRenderedPosition({
      body: current.readerPositionModel,
      headings: geometry.headings,
      rootTop: geometry.top,
      rootBottom: geometry.bottom,
      referenceTop: scrollerRect.top + topInset(),
    })
    const snapshot: ReaderSnapshot = {
      noteId: current.note.id,
      anchor,
      source: current.note.body,
      versionToken: current.note.versionToken,
    }
    latestReaderRef.current = snapshot

    return snapshot
  }, [scrollRef])

  const scheduleReaderCapture = useCallback(() => {
    if (captureRafRef.current) {
      return
    }
    captureRafRef.current = requestAnimationFrame(() => {
      captureRafRef.current = 0
      captureReaderNow()
    })
  }, [captureReaderNow])

  const flushReaderBeforeStartEdit = useCallback(() => {
    cancelCaptureFrame()
    const current = currentRef.current
    const captured = captureReaderNow()
    const latest = latestReaderRef.current
    const snapshot =
      captured ??
      (latest &&
      current.note &&
      latest.noteId === current.note.id &&
      latest.versionToken === current.note.versionToken
        ? latest
        : null)

    if (!snapshot || !current.note || current.routeNoteId !== current.note.id) {
      return
    }
    const key: PositionKey = {
      noteId: current.note.id,
      surface: 'document',
      generation: ++generationRef.current,
    }
    latestEditorRef.current = null
    editorSourceRef.current = null
    setIntent({ kind: 'enterPending', snapshot: { ...snapshot, key } })
  }, [cancelCaptureFrame, captureReaderNow, setIntent])

  // Keep a current immutable reader snapshot, and observe only the scoped root
  // inside this PageFrame. The synchronous transition callback above consumes any
  // pending frame and measures the live DOM before EditingProvider drops it.
  useLayoutEffect(() => {
    const scroller = scrollRef.current

    if (!standardReader || !note || !scroller) {
      return undefined
    }
    captureReaderNow()
    scroller.addEventListener('scroll', scheduleReaderCapture, { passive: true })
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleReaderCapture)
    resize?.observe(scroller)
    const root = scroller.querySelector<HTMLElement>(POSITION_ROOT)

    if (root) {
      resize?.observe(root)
    }
    const mutation = new MutationObserver(scheduleReaderCapture)
    mutation.observe(scroller, { childList: true, subtree: true })

    return () => {
      scroller.removeEventListener('scroll', scheduleReaderCapture)
      resize?.disconnect()
      mutation.disconnect()
      cancelCaptureFrame()
    }
  }, [cancelCaptureFrame, captureReaderNow, note, scheduleReaderCapture, scrollRef, standardReader])

  useLayoutEffect(() => {
    if (!standardReader || !note || routeNoteId !== note.id) {
      return undefined
    }

    return registerBeforeStartEdit(flushReaderBeforeStartEdit)
  }, [flushReaderBeforeStartEdit, note, registerBeforeStartEdit, routeNoteId, standardReader])

  const editorPositionModelFor = useCallback((view: EditorView): FullSourcePositionModel => {
    const doc = view.state.doc
    const cached = editorSourceRef.current

    if (cached?.doc === doc) {
      return cached.model
    }
    const model = createFullSourcePositionModel(doc.toString())
    editorSourceRef.current = { doc, model }

    return model
  }, [])

  const captureEditorNow = useCallback(
    (candidate?: EditorView | null): PositionSnapshot | null => {
      const view = candidate ?? editorViewRef.current
      const current = currentRef.current
      const activeIntent = intentRef.current
      const key =
        activeIntent.kind === 'enterPending'
          ? activeIntent.snapshot.key
          : activeIntent.kind === 'editing'
            ? activeIntent.key
            : activeIntent.kind === 'exitPending'
              ? activeIntent.snapshot.key
              : null

      if (!view || !key || current.routeNoteId !== key.noteId) {
        return null
      }
      const sourceModel = editorPositionModelFor(view)
      let sourcePosition = view.state.selection.main.head
      const scroller = scrollRef.current

      if (!current.preview && scroller && view.dom.isConnected) {
        const contentRect = view.contentDOM.getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        const visiblePosition = view.posAtCoords({
          x: Math.max(contentRect.left + 1, Math.min(contentRect.right - 1, contentRect.left + 8)),
          y: scrollerRect.top + topInset() + TRANSFER_GAP,
        })

        if (visiblePosition !== null) {
          sourcePosition = visiblePosition
        } else if (latestEditorRef.current?.key === key) {
          return latestEditorRef.current
        }
      } else if (!current.preview && latestEditorRef.current?.key === key) {
        return latestEditorRef.current
      }
      const snapshot: PositionSnapshot = {
        key,
        anchor: captureFullSourcePosition(sourceModel, sourcePosition),
        source: sourceModel.body.body,
        versionToken: current.note?.versionToken ?? '',
      }
      latestEditorRef.current = snapshot

      return snapshot
    },
    [editorPositionModelFor, scrollRef],
  )

  const scheduleEditorCapture = useCallback(() => {
    if (captureRafRef.current) {
      return
    }
    captureRafRef.current = requestAnimationFrame(() => {
      captureRafRef.current = 0
      captureEditorNow()
    })
  }, [captureEditorNow])

  const alignEditorWhenMeasurable = useCallback(
    (view: EditorView) => {
      const activeIntent = intentRef.current

      if (activeIntent.kind !== 'enterPending') {
        return
      }
      const key = activeIntent.snapshot.key

      const matchesPendingIntent = () => {
        const candidate = intentRef.current

        return (
          editorViewRef.current === view &&
          candidate.kind === 'enterPending' &&
          candidate.snapshot.key.noteId === key.noteId &&
          candidate.snapshot.key.generation === key.generation
        )
      }
      cancelAlignmentFrame()

      const verify = () => {
        if (alignmentRafRef.current) {
          return
        }
        alignmentRafRef.current = requestAnimationFrame(() => {
          alignmentRafRef.current = 0

          if (!matchesPendingIntent() || !view.dom.isConnected) {
            return
          }
          if (currentRef.current.preview) {
            return
          }
          if (currentRef.current.typewriter) {
            setIntent({ kind: 'editing', key })
            return
          }
          view.requestMeasure({
            read: (measuredView) => {
              const scroller = scrollRef.current
              const coords = measuredView.coordsAtPos(measuredView.state.selection.main.head)

              if (!scroller || !coords) {
                return null
              }
              const scrollerRect = scroller.getBoundingClientRect()

              return {
                scroller,
                delta: coords.top - (scrollerRect.top + topInset() + TRANSFER_GAP),
              }
            },
            write: (measurement) => {
              if (!matchesPendingIntent()) {
                return
              }
              if (!measurement) {
                verify()
                return
              }
              if (Math.abs(measurement.delta) > 1) {
                measurement.scroller.scrollTop += measurement.delta
                alignedFrameRef.current = 0
                verify()
                return
              }
              // A lazy first mount can finish one measurement before CodeMirror's
              // own deferred viewport correction. Consume the transfer only after
              // two consecutive measured frames agree, so that late correction is
              // observed and cannot leave the selected virtual line off-screen.
              alignedFrameRef.current += 1
              if (alignedFrameRef.current < 2) {
                verify()
                return
              }
              setIntent({ kind: 'editing', key })
            },
          })
        })
      }

      verify()
    },
    [cancelAlignmentFrame, scrollRef, setIntent],
  )

  const freezeEditorExit = useCallback(
    (view?: EditorView | null) => {
      cancelCaptureFrame()
      const activeIntent = intentRef.current

      if (activeIntent.kind === 'idle' || activeIntent.kind === 'exitPending') {
        return
      }
      const snapshot =
        captureEditorNow(view) ??
        latestEditorRef.current ??
        (activeIntent.kind === 'enterPending' ? activeIntent.snapshot : null)

      if (snapshot) {
        setIntent({ kind: 'exitPending', snapshot, resume: activeIntent })
      }
    },
    [cancelCaptureFrame, captureEditorNow, setIntent],
  )

  useLayoutEffect(() => {
    if (!isEditing) {
      return undefined
    }

    return registerBeforeCancelEdit(() => freezeEditorExit(editorViewRef.current))
  }, [freezeEditorExit, isEditing, registerBeforeCancelEdit])

  const onEditorView = useCallback(
    (view: EditorView | null) => {
      const previous = editorViewRef.current

      if (!view) {
        cancelAlignmentFrame()
        if (previous && intentRef.current.kind !== 'exitPending') {
          if (!currentRef.current.isEditing) {
            freezeEditorExit(previous)
          } else {
            captureEditorNow(previous)
          }
        }
        editorViewRef.current = null
        editorSourceRef.current = null
        cancelCaptureFrame()
        return
      }
      editorViewRef.current = view
      editorSourceRef.current = null
      const activeIntent = intentRef.current

      if (activeIntent.kind === 'enterPending') {
        alignEditorWhenMeasurable(view)
      }
      scheduleEditorCapture()
    },
    [
      alignEditorWhenMeasurable,
      cancelAlignmentFrame,
      cancelCaptureFrame,
      captureEditorNow,
      freezeEditorExit,
      scheduleEditorCapture,
    ],
  )

  useLayoutEffect(() => {
    if (isEditing && !preview && editorViewRef.current && intent.kind === 'enterPending') {
      alignEditorWhenMeasurable(editorViewRef.current)
    }
  }, [alignEditorWhenMeasurable, intent, isEditing, preview, typewriter])

  const onEditorUpdate = useCallback(
    (_view: EditorView, update: ViewUpdate) => {
      if (update.docChanged) {
        editorSourceRef.current = null
        return
      }
      if (update.geometryChanged || update.viewportChanged) {
        scheduleEditorCapture()
      }
    },
    [scheduleEditorCapture],
  )

  useLayoutEffect(() => {
    const scroller = scrollRef.current

    if (!isEditing || !editorViewRef.current || !scroller) {
      return undefined
    }
    scroller.addEventListener('scroll', scheduleEditorCapture, { passive: true })
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleEditorCapture)
    resize?.observe(scroller)
    resize?.observe(editorViewRef.current.dom)

    return () => {
      scroller.removeEventListener('scroll', scheduleEditorCapture)
      resize?.disconnect()
    }
  }, [isEditing, scheduleEditorCapture, scrollRef])

  // Dirty Save freezes the viewport anchor while the EditorView is still live.
  // A failed/conflicted save leaves editing active and resumes normal capture.
  useLayoutEffect(() => {
    if (
      saving &&
      isEditing &&
      (intentRef.current.kind === 'editing' || intentRef.current.kind === 'enterPending')
    ) {
      freezeEditorExit(editorViewRef.current)
    } else if (!saving && isEditing && intentRef.current.kind === 'exitPending') {
      setIntent(intentRef.current.resume)
      scheduleEditorCapture()
    }
  }, [freezeEditorExit, isEditing, saving, scheduleEditorCapture, setIntent])

  // Note id and document presentation are the transfer identity. Slug/path and
  // React Router location keys deliberately are not, so canonical replaces for
  // the same note continue the pending restore.
  useLayoutEffect(() => {
    const activeIntent = intentRef.current

    if (activeIntent.kind === 'idle') {
      return
    }
    const key = activeIntent.kind === 'editing' ? activeIntent.key : activeIntent.snapshot.key

    if (routeNoteId !== key.noteId) {
      latestEditorRef.current = null
      setIntent({ kind: 'idle' })
      return
    }
    if (!isEditing && !saving && note?.id === key.noteId && !standardReader) {
      latestEditorRef.current = null
      setIntent({ kind: 'idle' })
    }
  }, [isEditing, note?.id, routeNoteId, saving, setIntent, standardReader])

  // Consume exit intent only after the matching reader is measurable. Mutation
  // and resize observers express readiness without a timer; after the first
  // successful placement the intent is cleared, so later media/layout changes
  // cannot rubber-band the user.
  useLayoutEffect(() => {
    if (
      intent.kind !== 'exitPending' ||
      isEditing ||
      saving ||
      !standardReader ||
      !note ||
      !readerPositionModel ||
      note.id !== intent.snapshot.key.noteId
    ) {
      return undefined
    }
    const scroller = scrollRef.current

    if (!scroller) {
      return undefined
    }
    let consumed = false

    const restore = () => {
      if (consumed) {
        return
      }
      const geometry = rootGeometry(scroller)

      if (!geometry) {
        return
      }
      const scrollerRect = scroller.getBoundingClientRect()
      const target = resolveRenderedPosition({
        body: readerPositionModel,
        anchorSource: intent.snapshot.source,
        headings: geometry.headings,
        rootTop: geometry.top,
        rootBottom: geometry.bottom,
        anchor: intent.snapshot.anchor,
      })
      const delta = target - (scrollerRect.top + topInset())

      if (Math.abs(delta) > 1) {
        scroller.scrollTop += delta
      }
      consumed = true
      latestEditorRef.current = null
      setIntent({ kind: 'idle' })
    }
    restore()

    if (consumed) {
      return undefined
    }
    const mutation = new MutationObserver(restore)
    mutation.observe(scroller, { childList: true, subtree: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    resize?.observe(scroller)

    return () => {
      mutation.disconnect()
      resize?.disconnect()
    }
  }, [intent, isEditing, note, readerPositionModel, saving, scrollRef, setIntent, standardReader])

  useLayoutEffect(
    () => () => {
      cancelCaptureFrame()
      cancelAlignmentFrame()
    },
    [cancelAlignmentFrame, cancelCaptureFrame],
  )

  const initialSelection = useMemo(() => {
    if (
      intent.kind !== 'enterPending' ||
      !draftPositionModel ||
      routeNoteId !== intent.snapshot.key.noteId
    ) {
      return undefined
    }

    return resolveFullSourcePosition(draftPositionModel, intent.snapshot.anchor)
  }, [draftPositionModel, intent, routeNoteId])

  return children({ initialSelection, onEditorView, onEditorUpdate })
}
