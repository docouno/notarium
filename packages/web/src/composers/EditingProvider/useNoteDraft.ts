import { useRef, useState } from 'react'
import type { AuthoredAttachment, OwnedAbilityLocator } from '@notarium/contract'
import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract/enums'
import { asciiSlug, DEFAULT_NOTE_TYPE, isSkillName } from '@notarium/core'
import { deriveNoteTitle } from '@notarium/core/markdown'
import type { SaveInput } from '../../libs/wire'

// The metadata aside edits the creation date (#186) as a CALENDAR DAY (`<input
// type="date">` → `YYYY-MM-DD`), but the note stores a full ISO-8601 instant — the
// wire keeps minute precision (a future time-of-day UI / an agent set an exact
// instant). These bridge the two: a note's instant → the local day the picker
// shows, and a picked day → that day's LOCAL midnight as a UTC instant. Local (not
// UTC) midnight on purpose: the Feed buckets `created` by local day under the same
// tz, so the day the user picked is the day it lands in (a UTC-midnight instant
// would slip to the previous day at a negative offset).
export const isoToDateInput = (iso: string | null | undefined): string => {
  if (!iso) {
    return ''
  }
  const d = new Date(iso)

  if (Number.isNaN(d.getTime())) {
    return ''
  }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const dateInputToIso = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toISOString()
}

/** What "Belongs to" ANSWERS, as one comparable value. The fields behind it are not
 *  independent — a project list means nothing under "the whole Space" — so dirty is
 *  judged on the answer alone: switching the segment and switching it back is not an
 *  edit, the user sees the sentence they started with and Save stays inert.
 *  canon: docs/web-ui.md#web-react */
const placementAnswer = (
  home: 'personal' | 'space',
  availability:
    | typeof ABILITY_AVAILABILITY_MODE.allProjects
    | typeof ABILITY_AVAILABILITY_MODE.selectedProjects,
  projects: readonly string[],
): string =>
  home === 'personal'
    ? 'personal'
    : availability === ABILITY_AVAILABILITY_MODE.allProjects
      ? 'space'
      : `projects:${[...projects].sort().join(',')}`

// The snapshot taken when editing starts; passing a new object (a new edit/new
// session) re-seeds the fields. While not editing the hook gets null and stays
// inert.
export type Draft = {
  isNew: boolean
  documentKind?: 'ability'
  abilityKind?: 'role' | 'skill'
  abilityLocator?: OwnedAbilityLocator
  /** The persisted draft this session was seeded from — the key it belongs to and
   *  whether it came back from storage. Carried BY the draft so the page's writer
   *  reads the key and the body out of one value. */
  abilityDraft?: { owner: string; draftId: string; restored: boolean }
  /** ID-derived fallback for a new Ability whose human H1 has no ASCII handle chars. */
  abilityNameFallback?: string
  /** The published package's machine key. Read-only: it is minted once at
   *  publication, and a rename would rekey every locator that points at it. */
  abilityName?: string
  /** A virtual folder page (#213 follow-up): no note exists yet, but the editor
   *  is authoring the folder's future `index.md`. Save materialises it lazily. */
  folderPagePath?: string
  /** New-note drafts save immediately once titled; virtual folder pages require
   *  an authored change so opening+closing a folder never writes `index.md`. */
  saveRequiresDirty?: boolean
  /** Folder pages are covers of a specific folder; their destination is fixed. */
  lockDirectory?: boolean
  /** The note's custom display slug (#100 phase 1); '' when it has none (the implicit
   *  title-derived default). The editor always addresses it on save. */
  slug: string
  directory: string
  /** The WHOLE document, including its leading `# H1` title line (#156): there is
   *  no separate title field — the title is a projection of this body, derived on
   *  save. startEdit reconstructs it (`# <title>` + the stored body); startNew seeds
   *  it on a `# ` heading so the cursor opens on the title line. */
  content: string
  tags: string[]
  noteType: string
  /** The ability's short manifest description, the one field the aside edits. */
  abilityDescription?: string
  attachments?: AuthoredAttachment[]
  abilityHome?: 'personal' | 'space'
  abilitySpace?: string
  abilitySpaceId?: string
  abilityAvailability?:
    typeof ABILITY_AVAILABILITY_MODE.allProjects | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
  /** The projects the ability covers, by stable project id — the identity the
   *  server answers with and the only one a project outside the picker survives. */
  abilityProjects?: string[]
  /** The note's creation instant (#186), full ISO-8601 UTC, for prefilling the
   *  editable date field; null when unknown (a fresh note before it's saved). */
  createdAt: string | null
}

export type NoteDraftEditor = ReturnType<typeof useNoteDraft>

export const abilityMachineName = (title: string, fallback: string): string => {
  const fromTitle = asciiSlug(title)
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '')

  return fromTitle || fallback
}

// Shared editing state for a note draft. The edit UI is split across regions — the
// topbar actions, the main column (the document) and the right aside (folder/slug/
// type/tags) — so the live form state is lifted here and handed to each region
// instead of living inside one editor component. Since #156 the title is no longer a
// field: it's the document's leading `# H1`, so `derivedTitle` below is computed FROM
// the body (the same rule the server applies on save) and drives the save-gate and
// the slug placeholder.
export function useNoteDraft(initialDraft: Draft | null) {
  const [slug, setSlug] = useState(initialDraft?.slug || '')
  const [directory, setDirectory] = useState(initialDraft?.directory || '')
  const [tags, setTags] = useState<string[]>(initialDraft?.tags || [])
  const [noteType, setNoteType] = useState(initialDraft?.noteType || DEFAULT_NOTE_TYPE)
  const [abilityDescription, setAbilityDescription] = useState(
    initialDraft?.abilityDescription || '',
  )
  const [attachments, setAttachments] = useState<AuthoredAttachment[]>(
    initialDraft?.attachments ?? [],
  )
  const [abilityHome, setAbilityHome] = useState<'personal' | 'space'>(
    initialDraft?.abilityHome ?? 'personal',
  )
  const [abilityAvailability, setAbilityAvailability] = useState<
    typeof ABILITY_AVAILABILITY_MODE.allProjects | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
  >(initialDraft?.abilityAvailability ?? ABILITY_AVAILABILITY_MODE.allProjects)
  const [abilityProjects, setAbilityProjects] = useState<string[]>(
    initialDraft?.abilityProjects ?? [],
  )
  // The creation date as the picker shows it (#186): the note's instant reduced to a
  // local `YYYY-MM-DD`. '' = no date set yet (a fresh note). The seed it's compared
  // against on save lives in `createdSeed` so a save only sends the date when the
  // user actually moved it (untouched notes keep their exact stored instant).
  const createdSeed = isoToDateInput(initialDraft?.createdAt)
  const [createdDate, setCreatedDate] = useState(createdSeed)
  const [contentDirty, setContentDirty] = useState(false)
  const [contentVersion, setContentVersion] = useState(0)
  // The title the body currently derives to — recomputed on every edit so the save
  // gate and the slug placeholder track what the user types on the first line.
  const [derivedTitle, setDerivedTitle] = useState(() =>
    deriveNoteTitle(initialDraft?.content || ''),
  )

  // The live CodeMirror getter, registered on editor mount and unregistered on
  // unmount (registerContent(null)). null = no editor → fall back to the draft
  // snapshot. OWNED by the editor lifecycle on purpose: a draft-change effect
  // here must never touch it — parent effects run AFTER child effects, so a
  // reset in the effect below would overwrite the getter the editor just
  // registered in the same commit, and every body edit would silently read as
  // the initial snapshot (dirty never flips, saves drop the typed text).
  const getContent = useRef<(() => string) | null>(null)
  const readContent = () => getContent.current?.() ?? initialDraft?.content ?? ''

  // Re-seed every field when a fresh draft begins (keyed on object identity: a new
  // draft object is created for each startEdit/startNew). Done DURING render via
  // the prev-value pattern — NOT an effect — so the very first render of a new
  // draft already holds its values. An effect would lag the fields one render
  // behind `initialDraft`: for that frame the body is still the old one while the
  // draft has a new one, so `dirty` reads true and anything keyed on it (the red
  // "discard" Cancel) flashes red before the effect catches up. React restarts the
  // render with the seeded state before it ever paints, so there's no stale frame.
  const [seededDraft, setSeededDraft] = useState(initialDraft)

  if (seededDraft !== initialDraft) {
    setSeededDraft(initialDraft)
    setSlug(initialDraft?.slug || '')
    setDirectory(initialDraft?.directory || '')
    setTags(initialDraft?.tags || [])
    setNoteType(initialDraft?.noteType || DEFAULT_NOTE_TYPE)
    setAbilityDescription(initialDraft?.abilityDescription || '')
    setAttachments(initialDraft?.attachments ?? [])
    setAbilityHome(initialDraft?.abilityHome ?? 'personal')
    setAbilityAvailability(
      initialDraft?.abilityAvailability ?? ABILITY_AVAILABILITY_MODE.allProjects,
    )
    setAbilityProjects(initialDraft?.abilityProjects ?? [])
    setCreatedDate(isoToDateInput(initialDraft?.createdAt))
    setContentDirty(false)
    setContentVersion(0)
    setDerivedTitle(deriveNoteTitle(initialDraft?.content || ''))
  }

  const registerContent = (fn: (() => string) | null) => {
    getContent.current = fn
  }

  // Recompute dirtiness against the initial snapshot rather than latching a
  // one-way flag, so typing and then reverting the body (e.g. type-then-undo)
  // correctly reports "not dirty" — same contract as the field comparisons. The
  // derived title is refreshed in the same pass (cheap regex over the first lines).
  const onContentChange = () => {
    const body = readContent()
    setContentDirty(body !== (initialDraft?.content || ''))
    setContentVersion((version) => version + 1)
    setDerivedTitle(deriveNoteTitle(body))
  }

  // The ordered attachment list diverged from the snapshot. Published separately
  // because a save sends attachments ONLY then: an unrelated instruction save must
  // preserve the invalid raw rows the server is still holding.
  const attachmentsDirty =
    JSON.stringify(attachments) !== JSON.stringify(initialDraft?.attachments ?? [])
  // Dirty when any aside field diverges from the initial snapshot, or the body
  // changed (the body now carries the title, so a title edit flips contentDirty).
  // Tags compared via JSON so order matters and tag values containing spaces or
  // commas can't collide (a plain join could read ["a b"] and ["a","b"] as equal).
  const fieldsDirty =
    slug !== (initialDraft?.slug || '') ||
    directory !== (initialDraft?.directory || '') ||
    noteType !== (initialDraft?.noteType || DEFAULT_NOTE_TYPE) ||
    abilityDescription !== (initialDraft?.abilityDescription || '') ||
    attachmentsDirty ||
    placementAnswer(abilityHome, abilityAvailability, abilityProjects) !==
      placementAnswer(
        initialDraft?.abilityHome ?? 'personal',
        initialDraft?.abilityAvailability ?? ABILITY_AVAILABILITY_MODE.allProjects,
        initialDraft?.abilityProjects ?? [],
      ) ||
    createdDate !== createdSeed ||
    JSON.stringify(tags) !== JSON.stringify(initialDraft?.tags || [])
  const dirty = !!initialDraft && (fieldsDirty || contentDirty)

  // Saveable once the document yields a title; for an *existing* note we also
  // require real changes so Save stays inert when nothing diverges from the
  // snapshot. A new note is saveable as soon as its first line names it — including
  // a prefilled draft (e.g. created from a ghost link) whose fields match their seed
  // and so aren't "dirty". Gates both the Save button and the Ctrl/Cmd+S shortcut
  // from a single source of truth.
  const isNew = !!initialDraft?.isNew
  const saveRequiresDirty = !!initialDraft?.saveRequiresDirty
  // A NEW ability mints its key from the title it is being given; a published one
  // keeps the key it was minted with — there is no field that edits it.
  const abilityName =
    initialDraft?.documentKind === 'ability' && isNew
      ? abilityMachineName(derivedTitle, initialDraft.abilityNameFallback ?? '')
      : (initialDraft?.abilityName ?? '').trim()
  // Asked, not restated: the machine name the editor accepts is the one the package
  // may carry, LENGTH included — a bound this door used to leave to the server.
  const abilityNameValid = isSkillName(abilityName)
  // "Only these projects" with nothing chosen is not a reach — it is an ability
  // nobody can use, arrived at by accident. Asked of a new and an existing ability
  // alike: an empty selection would reach the server as a reach nobody can use and
  // come back as a rejected save.
  const abilityPlacementValid =
    initialDraft?.documentKind !== 'ability' ||
    abilityHome !== 'space' ||
    abilityAvailability === ABILITY_AVAILABILITY_MODE.allProjects ||
    abilityProjects.length > 0
  const documentValid =
    initialDraft?.documentKind === 'ability'
      ? abilityNameValid && Boolean(derivedTitle.trim()) && abilityPlacementValid
      : Boolean(derivedTitle.trim())
  const canSave = documentValid && ((isNew && !saveRequiresDirty) || dirty)

  // The editor's camelCase save view (libs/wire SaveInput) — the api service
  // assembles the snake wire body from it; the form never spells the wire. No
  // `title` since #156: the server derives it from `content` at the write chokepoint.
  const buildPayload = (): SaveInput => {
    if (initialDraft?.documentKind === 'ability') {
      // ADDRESSLESS on purpose: an ability's package can be relocated by the very
      // save that carries this payload, so the address is the save run's to state
      // (helpers/abilitySave) — a snapshot address would retry into a 404.
      return {
        content: readContent(),
        name: abilityName,
        description: abilityDescription.trim(),
      }
    }

    return {
      // Always addressed (#100 phase 1): a value sets the custom slug, '' clears it back
      // to the implicit default. The host softens/lazies it (storedSlug).
      slug: slug.trim(),
      directory: directory.trim(),
      noteType: noteType.trim() || DEFAULT_NOTE_TYPE,
      tags,
      content: readContent(),
      // Authored creation date (#186): sent ONLY when the user moved it off the seed
      // AND a day is set — so a normal save never restamps `created`, and clearing the
      // field is a no-op (there's no "reset to birthtime" channel in scope). Built as
      // the picked day's LOCAL midnight ISO instant.
      ...(createdDate && createdDate !== createdSeed
        ? { createdAt: dateInputToIso(createdDate) }
        : {}),
    }
  }

  return {
    slug,
    setSlug,
    directory,
    setDirectory,
    tags,
    setTags,
    noteType,
    setNoteType,
    abilityDescription,
    setAbilityDescription,
    attachments,
    setAttachments,
    attachmentsDirty,
    abilityHome,
    setAbilityHome,
    abilityAvailability,
    setAbilityAvailability,
    abilityProjects,
    setAbilityProjects,
    createdDate,
    setCreatedDate,
    registerContent,
    onContentChange,
    contentVersion,
    dirty,
    canSave,
    buildPayload,
    isNew,
    lockDirectory: !!initialDraft?.lockDirectory,
    isAbility: initialDraft?.documentKind === 'ability',
    abilityKind: initialDraft?.abilityKind,
    abilitySpace: initialDraft?.abilitySpace ?? '',
    abilitySpaceId: initialDraft?.abilitySpaceId ?? '',
    abilityMachineName: abilityName,
    content: initialDraft?.content || '',
    /** The title the body derives to (#156) — read-only, for the slug placeholder.
     *  The note has no editable title field; this just mirrors the leading `# H1`. */
    title: derivedTitle,
  }
}
