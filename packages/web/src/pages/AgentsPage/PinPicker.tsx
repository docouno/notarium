import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextSet } from '@notarium/contract'
import { NOTE_SORT } from '@notarium/contract/enums'
import { directoryOf, isFolderPageNote } from '@notarium/core'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import {
  IconChevron,
  IconLayers,
  IconPlus,
  IconSearch,
  IconWorkspace,
  IconX,
} from '../../core/Icons'
import { Modal } from '../../core/Modal'
import { Notice } from '../../core/Notice'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { api } from '../../services/api'
import type { PickedNote, SetSave } from './types'
import styles from './ContextPage.module.scss'

/** A ghost/chip trigger that opens an ELEVATED ContextMenu (above the picker modal) —
 *  the DS popover shared by the space chip and the "add set" menu, so neither reinvents a
 *  dropdown. `children` is the trigger's face; `items` the menu. */
const PickerMenu = ({
  className,
  children,
  items,
  testId,
  ariaLabel,
}: {
  className?: string
  children: ReactNode
  items: MenuItem[]
  testId?: string
  ariaLabel?: string
}) => {
  const ref = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={at != null}
        onClick={() => {
          if (at) {
            setAt(null)
            return
          }
          const r = ref.current?.getBoundingClientRect()

          if (r) {
            setAt({ x: r.left, y: r.bottom + 4, w: r.width })
          }
        }}
      >
        {children}
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          minWidth={at.w}
          items={items}
          elevated
          ignoreRef={ref}
          onClose={() => setAt(null)}
        />
      )}
    </>
  )
}

/** The ONE add-picker (#209 UX r6) — an EXTENSION of the pin flow, not a separate manager.
 *  Three intents share one surface, all the SAME shape (a note list + checkboxes, headed by
 *  a "From space" CHIP — one space at a time, the selection accumulating ACROSS switches → a
 *  cross-space pin/set with no cross-space search). PIN (default): pin the checked notes.
 *  CREATE SET: a ghost "Create set" flips into set-build (name at the FOOTER). ADD TO SET:
 *  opened from a set's "Add notes" — the same add-list, targeting that set (its current
 *  members excluded). Membership is TRIMMED per-item from the set row itself, so the picker
 *  is only ever ADD — no separate "edit" layout that would break from the create flow. */
export const PinPicker = ({
  space,
  folder,
  excludeIds,
  onClose,
  spaceOptions,
  sets,
  attachedSetIds,
  initialSetId,
  initialSetHome,
  onPinNotes,
  onSaveSet,
}: {
  /** The ACTIVE scope's space slug — the default browse space, the boundary that decides a
   *  same-space pin (tag) vs a cross-space one (scope ref), AND where a NEW set is homed. */
  space: string
  /** A project scope's subtree path — narrows the note list WHEN browsing the scope's
   *  own space (a cross-space browse shows the whole other space). */
  folder?: string
  excludeIds: Set<string>
  onClose: () => void
  /** Readable spaces for the cross-space "From space" chip. */
  spaceOptions: Array<{ slug: string; label: string }>
  /** The caller's sets that may be attached to THIS scope (personal sets filtered out on a project). */
  sets: ContextSet[]
  /** Which of `sets` are already attached here (their notes already load). */
  attachedSetIds: Set<string>
  /** Open straight into ADD-to-set for this set (the "Add notes" row action) — its current
   *  members are excluded from the browse list. */
  initialSetId?: string
  /** The pre-targeted set's HOME space, so an add addresses its real home even if the
   *  attach-picker's set list (allSets) is stale (#209). */
  initialSetHome?: string
  onPinNotes: (items: PickedNote[]) => void
  onSaveSet: (save: SetSave) => void
}) => {
  // mode 'pin' = pin the checked notes; 'set' = save them into a set. `target` is 'new' (a
  // fresh set, name at the footer) or an existing set id (ADD to it, from its "Add notes").
  const [mode, setMode] = useState<'pin' | 'set'>(initialSetId ? 'set' : 'pin')
  const [target, setTarget] = useState<'new' | string>(initialSetId ?? 'new')
  const [notes, setNotes] = useState<Array<{
    id: string
    title: string
    filePath?: string
  }> | null>(null)
  const [q, setQ] = useState('')
  const [failed, setFailed] = useState(false)
  const [pickSpace, setPickSpace] = useState(space)
  // The checked notes → their {home space slug, title} — the space is what makes a pin/item
  // cross-space (the note may live in a space other than the scope's). Persists across space
  // switches, so a cross-space selection builds up without a cross-space search.
  const [checked, setChecked] = useState<Map<string, { space: string; title: string }>>(new Map())
  const [name, setName] = useState('')

  // ADD-to-set = an existing set (target is its id); NEW = a fresh set (name at the footer).
  const isAddToSet = mode === 'set' && target !== 'new'
  const isNewSet = mode === 'set' && target === 'new'
  const listSpace = pickSpace
  // The project subtree filter only applies in the scope's OWN space (a foreign browse is whole-space).
  const listFolder = listSpace === space ? folder : undefined
  const targetSet = target === 'new' ? null : sets.find((sset) => sset.id === target)
  // When adding to an existing set, exclude notes ALREADY in it (adding is idempotent anyway).
  const inTarget = useMemo(() => new Set(targetSet?.items.map((i) => i.noteId) ?? []), [targetSet])
  const spaceLabel = spaceOptions.find((o) => o.slug === pickSpace)?.label ?? pickSpace
  // A NEW set is HOMED in the active scope's space (not the browse space) — surfaced in the
  // footer so the user knows where it will live, instead of a redundant "name it" nag.
  const scopeSpaceLabel = spaceOptions.find((o) => o.slug === space)?.label ?? space
  // Existing sets not yet attached here — offered for one-click attach in the ghost menu.
  const attachable = useMemo(
    () => sets.filter((s) => !attachedSetIds.has(s.id)),
    [sets, attachedSetIds],
  )

  useEffect(() => {
    let live = true
    setNotes(null)
    api
      .notesGet(listSpace, {
        folder: listFolder,
        depth: 'subtree',
        limit: 50,
        sort: NOTE_SORT.title,
        q: q.trim() || undefined,
      })
      .then((page) => {
        if (live) {
          setFailed(false)
          setNotes(page.notes.map((n) => ({ id: n.id, title: n.title, filePath: n.filePath })))
        }
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [listSpace, listFolder, q])

  // Browse results = fetched notes minus what's already there: ADD-to-set hides current
  // members; pin/new-set hide notes already pinned in this scope.
  const candidates = useMemo(
    () =>
      (notes ?? [])
        .filter((n) => (isAddToSet ? !inTarget.has(n.id) : !excludeIds.has(n.id)))
        .slice(0, 50),
    [notes, excludeIds, inTarget, isAddToSet],
  )
  const toggle = (n: { id: string; title: string }) =>
    setChecked((prev) => {
      const next = new Map(prev)

      if (next.has(n.id)) {
        next.delete(n.id)
      } else {
        next.set(n.id, { space: listSpace, title: n.title })
      }

      return next
    })

  const startNewSet = () => {
    setMode('set')
    setTarget('new')
  }

  const cancelSet = () => {
    setMode('pin')
    setTarget('new')
    setName('')
  }

  const pickedNotes = (): PickedNote[] =>
    [...checked.entries()].map(([noteId, v]) => ({ space: v.space, noteId }))
  const canSave =
    mode === 'pin'
      ? checked.size > 0
      : isNewSet
        ? name.trim().length > 0 && checked.size > 0
        : checked.size > 0

  const save = () => {
    if (!canSave) {
      return
    }
    if (mode === 'pin') {
      onPinNotes(pickedNotes())
    }
    // Carry the target set's authoritative home so the parent addresses its CRUD there,
    // not the active scope's space (#209 — the last no-fallback-to-scope path).
    else {
      onSaveSet({
        setId: isNewSet ? null : target,
        name: name.trim(),
        items: pickedNotes(),
        home: isNewSet ? undefined : (initialSetHome ?? targetSet?.homeSpace),
      })
    }
  }

  // The footer's live hint (left of the primary action). The count lives here, never on the
  // button (#209 UX r4); a NEW set states WHERE it will live, an ADD which set it feeds.
  const footHint =
    mode === 'pin'
      ? checked.size > 0
        ? `${checked.size} selected`
        : 'Select notes to pin'
      : isNewSet
        ? checked.size > 0
          ? `New set in ${scopeSpaceLabel} · ${checked.size} selected`
          : `New set in ${scopeSpaceLabel}`
        : checked.size > 0
          ? `Add to ${targetSet?.name ?? 'set'} · ${checked.size} selected`
          : `Add to ${targetSet?.name ?? 'set'}`
  const saveLabel = mode === 'pin' ? 'Pin' : isNewSet ? 'Create set' : 'Add'

  // The set control (right of the space chip): ADD-to-set has none (you're feeding a specific
  // set); NEW-set mode a Cancel back to pinning; PIN mode a "Create set" button — or, when
  // sets exist to attach here, a menu (New set + one-click attach of each, by name).
  const setMenuItems: MenuItem[] = [
    { label: 'New set', icon: <IconPlus size={15} />, onClick: startNewSet },
    ...(attachable.length ? [{ divider: true } as MenuItem] : []),
    ...attachable.map((s) => ({
      label: s.name,
      icon: <IconLayers size={15} />,
      onClick: () => onSaveSet({ setId: s.id, name: '', items: [], home: s.homeSpace }),
    })),
  ]
  const setControl = isAddToSet ? (
    <span />
  ) : isNewSet ? (
    <Button variant="ghost" onClick={cancelSet} data-testid="pin-picker-cancel">
      <IconX size={13} /> Cancel
    </Button>
  ) : attachable.length > 0 ? (
    <PickerMenu
      className={styles.pickerGhostBtn}
      items={setMenuItems}
      testId="pin-picker-set-menu"
      ariaLabel="Add a set"
    >
      <IconLayers size={13} /> Add set <IconChevron size={12} className={styles.pickerChipCaret} />
    </PickerMenu>
  ) : (
    <Button variant="ghost" onClick={startNewSet} data-testid="pin-picker-create-set">
      <IconLayers size={13} /> Create set
    </Button>
  )

  return (
    <Modal
      onClose={onClose}
      size="md"
      labelledBy="pin-picker-title"
      className={styles.pickerPanel}
      overlayClassName={styles.pickerOverlay}
    >
      <div className={styles.picker} data-testid="pin-picker">
        <div className={styles.pickerHead}>
          <IconSearch size={18} className={styles.pickerSearchIcon} />
          <input
            className={styles.pickerInput}
            placeholder="Search notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            aria-label="Search notes"
            data-testid="pin-picker-filter"
          />
          <h2 id="pin-picker-title" className={styles.pickerTitle}>
            {isAddToSet ? `Add to ${targetSet?.name ?? 'set'}` : 'Add to context'}
          </h2>
        </div>

        {/* The action bar: the "From space" CHIP on the left (a single space at a time —
            the selection accumulates across switches) and the set control on the right
            (Create set / Add set menu / Cancel; none while adding to a set). Always shown so
            the set control has a stable home; the space chip is dropped for a lone space. */}
        <div className={styles.pickerActionBar}>
          {spaceOptions.length > 1 ? (
            <span className={styles.pickerSpaceGroup}>
              <span className={styles.pickerFieldLabel}>From</span>
              <PickerMenu
                className={styles.pickerChip}
                testId="pin-picker-space"
                ariaLabel="From space"
                items={spaceOptions.map((o) => ({
                  label: o.label,
                  radioGroup: 'From space',
                  active: o.slug === pickSpace,
                  onClick: () => setPickSpace(o.slug),
                }))}
              >
                <IconWorkspace size={13} /> {spaceLabel}{' '}
                <IconChevron size={12} className={styles.pickerChipCaret} />
              </PickerMenu>
            </span>
          ) : (
            <span />
          )}
          {setControl}
        </div>

        <div className={styles.pickerBody} id="pin-picker-list">
          {failed && <Notice variant="error">Couldn’t load notes.</Notice>}
          {!notes && !failed && (
            <div className={styles.pickerSkeleton} aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className={styles.pickerSkeletonRow}>
                  <Skeleton w={`${54 + ((i * 11) % 30)}%`} h={13} radius={4} />
                </div>
              ))}
            </div>
          )}
          {notes && (
            <ul className={styles.pickerList}>
              {candidates.length === 0 ? (
                <li className={styles.pickerEmpty}>No notes here.</li>
              ) : (
                candidates.map((n) => {
                  const on = checked.has(n.id)
                  const folderOverview = !!n.filePath && isFolderPageNote(n.filePath)
                  const folderPath = folderOverview
                    ? directoryOf(n.filePath!) || 'workspace root'
                    : null
                  const title = n.title || 'Untitled'
                  return (
                    <li key={n.id} data-testid="pin-picker-item">
                      <Checkbox
                        className={cx(styles.pickerRow, on && styles.pickerRowChecked)}
                        checked={on}
                        onChange={() => toggle(n)}
                        aria-label={
                          folderOverview ? `${title} · Folder overview · ${folderPath}` : title
                        }
                        label={
                          <span className={styles.pickerItemText}>
                            <span className={styles.pickerItemTitle}>{title}</span>
                            {folderOverview ? (
                              <span className={styles.pickerItemPath}>
                                Folder overview · {folderPath}
                              </span>
                            ) : n.filePath ? (
                              <span className={styles.pickerItemPath}>
                                {n.filePath.replace(/\.md$/, '')}
                              </span>
                            ) : null}
                          </span>
                        }
                      />
                    </li>
                  )
                })
              )}
            </ul>
          )}
        </div>

        <div className={styles.pickerFoot}>
          {/* Building a NEW set: the name lives at the FOOTER (not a stacked field up top). */}
          {isNewSet && (
            <input
              className={styles.pickerFootName}
              placeholder="Set name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="pin-picker-set-name"
              aria-label="Set name"
            />
          )}
          <div className={styles.pickerFootBar}>
            <span className={styles.muted}>{footHint}</span>
            {/* Always visible with a clear enabled/disabled state (primary dims when it
                can't act) — so in set-build the button and the name field read as one
                unit, and the count lives only in the hint (never doubled on the label). */}
            <Button
              variant="primary"
              onClick={save}
              disabled={!canSave}
              data-testid="pin-picker-save"
            >
              {saveLabel}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
