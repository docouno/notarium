import { useEffect, useMemo, useState } from 'react'
import type { ContextOrderEntry, Preview } from '@notarium/contract'
import { Button } from '../../core/Button'
import { Chip } from '../../core/Chips'
import { type MenuItem } from '../../core/ContextMenu'
import { EmptyState } from '../../core/EmptyState'
import { IconExternal, IconMinus, IconPin, IconPinOff, IconPlus, IconTrash } from '../../core/Icons'
import { type ReorderHandle, useReorder } from '../../libs/dnd/reorder'
import { ContextCard } from '../../widgets/ContextCard'
import { StatusBadge, TokenMeter } from './ContextMeters'
import { CardListSkeleton } from './ContextSkeletons'
import { orderItemsBy, parseEntryKey, pinKey, setKey } from './helpers/contextOrder'
import { pinsTrimmed, setsTrimmed } from './helpers/contextTrim'
import { formatTokens } from './helpers/format'
import type {
  ContextPinView,
  ContextSetItemView,
  ContextSetRowView,
  ContextSetTailState,
} from './types'
import styles from './ContextPage.module.scss'

export const PinEmptyState = ({
  title,
  hint,
  onAdd,
  testId,
  editable = true,
}: {
  title: string
  hint: string
  onAdd: () => void
  testId: string
  editable?: boolean
}) => (
  <EmptyState
    icon={<IconPin size={24} />}
    title={title}
    hint={hint}
    action={
      editable ? (
        <Button onClick={onAdd} data-testid={testId}>
          <IconPlus size={13} /> Add pinned note
        </Button>
      ) : undefined
    }
    testId={`${testId}-empty`}
  />
)

/** One pinned always-load note. Row: title (+ a home-space chip when it is a CROSS-SPACE
 *  pin #209) + weight meter; expands to snippet + meta (reading length · tags). Menu:
 *  open note · unpin. `onUnpin` gets the pin's space so the caller routes a same-space
 *  pin to the `always-load` tag and a cross-space one to the scope-pin registry. */
export const PinRow = ({
  pin,
  preview,
  scale,
  onOpen,
  onUnpin,
  reorder,
  editable = true,
}: {
  pin: ContextPinView
  preview?: Preview | null
  scale: number
  onOpen: (id: string) => void
  onUnpin: (noteId: string, space?: string) => void
  reorder?: ReorderHandle
  editable?: boolean
}) => {
  const meta: string[] = []

  if (pin.loaded === false) {
    meta.push('Over the token budget')
  }
  if (preview?.words) {
    meta.push(`${preview.words} ${preview.words === 1 ? 'word' : 'words'}`)
  }
  // `always-load` is the pin's own marker tag, not content — keep it out of the meta.
  const tags = (preview?.tags ?? []).filter((t) => t !== 'always-load')

  if (tags.length) {
    meta.push(tags.map((t) => `#${t}`).join(' '))
  }
  // Unpinning is REVERSIBLE — a neutral "Unpin", named + iconed the SAME on pins and sets
  // (never a scary "remove"/"delete"). Only a destructive set delete is red (#209 UX r5).
  const menu: MenuItem[] = [
    { label: 'Open note', icon: <IconExternal size={15} />, onClick: () => onOpen(pin.noteId) },
    ...(editable
      ? [
          { divider: true } as const,
          {
            label: 'Unpin',
            icon: <IconPinOff size={15} />,
            onClick: () => onUnpin(pin.noteId, pin.space),
          },
        ]
      : []),
  ]
  return (
    <ContextCard
      title={
        <span className={styles.itemTitle}>
          <span className={styles.itemName}>{pin.title}</span>
          <span className={styles.itemBadges} data-testid="context-item-badges">
            {pin.folderOverview && <Chip>Folder overview</Chip>}
            {pin.space && <Chip>{pin.space}</Chip>}
            {pin.loaded === false && <StatusBadge state="trimmed" />}
          </span>
          <TokenMeter tokens={pin.tokens} scale={scale} trimmed={pin.loaded === false} />
        </span>
      }
      summary={preview?.snippet}
      details={meta.length ? meta.join(' · ') : undefined}
      menu={menu}
      reorder={reorder}
      testId="context-pin-row"
    />
  )
}

/** One member note of a set as seen INSIDE the expanded set (#209). Resolved rows keep the
 * pin-like preview/meter; an unavailable paged row remains removable but exposes neither
 * content, an open action nor an invented zero weight. */
export const SetItemRow = ({
  item,
  preview,
  scale,
  onOpen,
  onRemove,
  reorder,
  editable = true,
}: {
  item: ContextSetItemView
  preview?: Preview | null
  scale: number
  onOpen: (id: string) => void
  onRemove: () => void
  reorder?: ReorderHandle
  editable?: boolean
}) => (
  <ContextCard
    title={
      <span className={styles.itemTitle}>
        <span className={styles.itemName}>{item.title ?? 'Unavailable note'}</span>
        <span className={styles.itemBadges} data-testid="context-item-badges">
          {item.folderOverview && <Chip>Folder overview</Chip>}
          {item.space && <Chip>{item.space}</Chip>}
          {item.loaded === false && <StatusBadge state="trimmed" />}
        </span>
        {item.tokens === undefined ? (
          <span className={styles.meterSpacer} aria-hidden />
        ) : (
          <TokenMeter tokens={item.tokens} scale={scale} trimmed={item.loaded === false} />
        )}
      </span>
    }
    summary={item.title == null ? undefined : preview?.snippet}
    menu={[
      ...(item.title == null
        ? []
        : [
            {
              label: 'Open note',
              icon: <IconExternal size={15} />,
              onClick: () => onOpen(item.noteId),
            },
          ]),
      ...(editable
        ? [
            { divider: true } as const,
            // Reversible (the note can be re-added) → neutral. Scoped to "from set" so it never
            // reads as deleting the note itself, and named apart from the set's own "Unpin".
            { label: 'Remove from set', icon: <IconMinus size={15} />, onClick: onRemove },
          ]
        : []),
    ]}
    reorder={reorder}
    testId="context-set-item"
  />
)

/** A context set AS A PIN-LIST ROW (#209): an expandable card badged `Set` that reveals its
 *  member notes (each itself expandable, each removable from its own menu) — progressive
 *  disclosure, no separate manager. A budgeted row meters only loaded known weight; an
 *  unweighed identity row meters its complete resolved membership. `trimmed` is the explicit
 *  set-level hard-stop verdict, independent from access-only degradation.
 *  The row menu adds notes, unpins the set from this scope, or deletes it everywhere. */
export const SetRow = ({
  set,
  previews,
  scale,
  onOpen,
  onAddNotes,
  onDetach,
  onDelete,
  onRemoveItem,
  onReorderItems,
  tail,
  tailWake = 0,
  onLoadTail,
  reorder,
  editable = true,
}: {
  set: ContextSetRowView
  previews: Record<string, Preview | null>
  scale: number
  onOpen: (id: string) => void
  onAddNotes: (set: ContextSetRowView) => void
  onDetach: (set: ContextSetRowView) => void
  onDelete: (set: ContextSetRowView) => void
  onRemoveItem: (set: ContextSetRowView, noteId: string) => void
  onReorderItems: (set: ContextSetRowView, noteIds: string[]) => void
  tail?: ContextSetTailState
  tailWake?: number
  onLoadTail: (set: ContextSetRowView, reset?: boolean) => void
  reorder?: ReorderHandle
  editable?: boolean
}) => {
  const [expanded, setExpanded] = useState(false)
  const hasBudgetVerdict =
    set.hasBudgetVerdict === true || set.items.some((item) => item.loaded !== undefined)
  const total = set.items.reduce(
    (sum, item) => sum + (!hasBudgetVerdict || item.loaded === true ? (item.tokens ?? 0) : 0),
    0,
  )
  const trimmed = set.trimmed === true
  const coordinateTail = set.homeSpace && set.itemsTotal !== undefined ? tail : undefined
  const mergedItems = useMemo(() => {
    const byIndex = new Map<number, ContextSetItemView>()

    for (const item of set.items) {
      if (item.sourceIndex !== undefined) {
        byIndex.set(item.sourceIndex, item)
      }
    }
    for (const item of coordinateTail?.items ?? []) {
      const preview = byIndex.get(item.sourceIndex)
      const unavailable = item.title == null || item.space == null

      byIndex.set(item.sourceIndex, {
        ...(preview ?? {}),
        ...item,
        order: item.sourceIndex,
        ...(unavailable
          ? {
              folderOverview: undefined,
              loaded: undefined,
              space: null,
              title: null,
              tokens: undefined,
            }
          : {}),
      })
    }

    const merged =
      byIndex.size > 0
        ? [...byIndex.values()].sort(
            (left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0),
          )
        : set.items

    return coordinateTail?.optimisticOrder
      ? orderItemsBy(merged, coordinateTail.optimisticOrder)
      : merged
  }, [set.items, coordinateTail?.items, coordinateTail?.optimisticOrder])
  const rawTotal = set.itemsTotal
  const visibleCoordinates = new Set(
    mergedItems.flatMap((item) => (item.sourceIndex === undefined ? [] : [item.sourceIndex])),
  )
  const hasMore = rawTotal !== undefined && visibleCoordinates.size < rawTotal

  useEffect(() => {
    if (expanded && hasMore && !coordinateTail) {
      onLoadTail(set, true)
    }
  }, [coordinateTail, expanded, hasMore, onLoadTail, set, tailWake])
  // The set's OWN item order (#210) — a separate reorder list nested inside the expanded set.
  // Its `drag` is isolated from the outer pin+set list (each useReorder owns its own state),
  // so dragging a member never nudges the set among the pins. <2 items ⇒ inert.
  const itemKeys = mergedItems.map((item) => String(item.sourceIndex ?? item.order))
  const itemByKey = new Map(itemKeys.map((key, index) => [key, mergedItems[index]]))
  const { handleFor: itemHandle, listProps: itemListProps } = useReorder(
    itemKeys,
    (next) =>
      onReorderItems(
        set,
        next.flatMap((key) => {
          const item = itemByKey.get(key)
          return item ? [item.noteId] : []
        }),
      ),
    !editable || itemKeys.length < 2,
  )
  return (
    <ContextCard
      title={
        <span className={styles.itemTitle}>
          <span className={styles.itemName}>{set.name}</span>
          <span className={styles.itemBadges}>
            <Chip variant="accent">Set · {rawTotal ?? set.items.length}</Chip>
            {rawTotal !== undefined && (set.itemsLoaded ?? 0) < rawTotal && (
              <Chip>
                {set.itemsLoaded ?? 0} of {rawTotal}
              </Chip>
            )}
            {trimmed && <StatusBadge state="trimmed" />}
          </span>
          <TokenMeter tokens={total} scale={scale} trimmed={trimmed} />
        </span>
      }
      details={
        <div className={styles.list} {...itemListProps}>
          {mergedItems.length === 0 && !hasMore ? (
            <p className={styles.blockCaption}>
              No notes to show — items in spaces you can’t access are hidden.
            </p>
          ) : (
            mergedItems.map((item) => (
              <SetItemRow
                key={`${item.sourceIndex ?? item.order}:${item.noteId}`}
                item={item}
                preview={previews[item.noteId]}
                scale={scale}
                onOpen={onOpen}
                onRemove={() => onRemoveItem(set, item.noteId)}
                reorder={itemHandle(String(item.sourceIndex ?? item.order))}
                editable={editable}
              />
            ))
          )}
          {hasMore && (
            <div className={styles.tailActions}>
              {coordinateTail?.loading ? (
                <CardListSkeleton rows={2} />
              ) : coordinateTail?.error ? (
                <Button variant="ghost" onClick={() => onLoadTail(set)}>
                  Retry loading notes
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => onLoadTail(set)}>
                  Show more notes
                </Button>
              )}
            </div>
          )}
        </div>
      }
      menu={
        editable
          ? [
              // "Add notes" opens the add-picker for this set; per-item removal lives on each member
              // row. "Unpin" is the reversible detach from this scope — named like a pin's. The
              // destructive Delete is set off by a divider and confirmed (in the handler).
              {
                label: 'Add notes',
                icon: <IconPlus size={15} />,
                onClick: () => onAddNotes(set),
              },
              { label: 'Unpin', icon: <IconPinOff size={15} />, onClick: () => onDetach(set) },
              { divider: true },
              {
                label: 'Delete set',
                icon: <IconTrash size={15} />,
                danger: true,
                onClick: () => onDelete(set),
              },
            ]
          : undefined
      }
      reorder={reorder}
      open={expanded}
      onToggle={setExpanded}
      testId="context-set-row"
    />
  )
}

/** The Pinned block (#165/#208/#209): the always-load notes AND context sets in ONE
 *  list — a set is a badged, expandable row (its notes nest inside). Add via [+] (the
 *  one multi-select picker: pin notes or build a set); unpin / manage via the row menu. */
export const PinsBlock = ({
  pins,
  sets,
  previews,
  scale,
  onAdd,
  onOpen,
  onUnpin,
  onAddNotesToSet,
  onDetachSet,
  onDeleteSet,
  onRemoveItem,
  onReorder,
  onReorderSetItems,
  tails,
  tailWake,
  onLoadSetTail,
  emptyHint,
  addTestId,
  listTestId,
  editable = true,
}: {
  pins: ContextPinView[] | null
  sets: ContextSetRowView[] | null
  previews: Record<string, Preview | null>
  scale: number
  onAdd: () => void
  onOpen: (id: string) => void
  onUnpin: (id: string, space?: string) => void
  onAddNotesToSet: (set: ContextSetRowView) => void
  onDetachSet: (set: ContextSetRowView) => void
  onDeleteSet: (set: ContextSetRowView) => void
  onRemoveItem: (set: ContextSetRowView, noteId: string) => void
  /** Persist a new pin+set order for this scope (#210) — the whole sequence, kind+ref. */
  onReorder: (entries: ContextOrderEntry[]) => void
  /** Persist a new item order inside a set (#210). */
  onReorderSetItems: (set: ContextSetRowView, noteIds: string[]) => void
  tails: Record<string, ContextSetTailState>
  tailWake: Record<string, number>
  onLoadSetTail: (set: ContextSetRowView, reset?: boolean) => void
  emptyHint: string
  addTestId: string
  listTestId: string
  editable?: boolean
}) => {
  const trimmedTokens = pins ? pinsTrimmed(pins) + setsTrimmed(sets ?? []) : 0
  const empty = pins != null && pins.length === 0 && (sets == null || sets.length === 0)
  // Pins AND sets in ONE list, ordered by the server-curated `order` (#210): they share the
  // rank space, so a set can sit above a pin. Rendered as one DnD-reorderable list; the drag
  // keys are the server's order refs (`pin:<id>` / `set:<id>`), so a drop maps straight back.
  const entries = useMemo<
    Array<{ key: string; order: number; pin?: ContextPinView; set?: ContextSetRowView }>
  >(
    () =>
      [
        ...(pins ?? []).map((p) => ({ key: pinKey(p.noteId), order: p.order, pin: p })),
        ...(sets ?? []).map((s) => ({ key: setKey(s.id), order: s.order, set: s })),
      ].sort((a, b) => a.order - b.order),
    [pins, sets],
  )
  const keys = entries.map((e) => e.key)
  const { handleFor, listProps } = useReorder(
    keys,
    (next) => onReorder(next.map(parseEntryKey)),
    !editable || keys.length < 2,
  )
  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <IconPin size={13} />
        <span>Pinned</span>
        {!empty && editable && (
          <div className={styles.blockActions}>
            <Button
              variant="ghost"
              icon
              aria-label="Add to context"
              title="Pin notes or build a set"
              onClick={onAdd}
              data-testid={addTestId}
            >
              <IconPlus size={14} />
            </Button>
          </div>
        )}
      </div>
      {!pins ? (
        <CardListSkeleton rows={4} />
      ) : empty ? (
        <PinEmptyState
          title="Nothing pinned yet"
          hint={emptyHint}
          onAdd={onAdd}
          testId={addTestId}
          editable={editable}
        />
      ) : (
        <>
          {trimmedTokens > 0 && (
            <p className={styles.blockCaption}>
              <span className={styles.trimmedText}>≈{formatTokens(trimmedTokens)} trimmed</span> —
              over the token budget
            </p>
          )}
          <div className={styles.list} data-testid={listTestId} {...listProps}>
            {entries.map((e) =>
              e.pin ? (
                <PinRow
                  key={e.key}
                  pin={e.pin}
                  preview={previews[e.pin.noteId]}
                  scale={scale}
                  onOpen={onOpen}
                  onUnpin={onUnpin}
                  reorder={handleFor(e.key)}
                  editable={editable}
                />
              ) : e.set ? (
                <SetRow
                  key={e.key}
                  set={e.set}
                  previews={previews}
                  scale={scale}
                  onOpen={onOpen}
                  onAddNotes={onAddNotesToSet}
                  onDetach={onDetachSet}
                  onDelete={onDeleteSet}
                  onRemoveItem={onRemoveItem}
                  onReorderItems={onReorderSetItems}
                  tail={tails[e.set.id]}
                  tailWake={tailWake[e.set.id] ?? 0}
                  onLoadTail={onLoadSetTail}
                  reorder={handleFor(e.key)}
                  editable={editable}
                />
              ) : null,
            )}
          </div>
        </>
      )}
    </div>
  )
}
