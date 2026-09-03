import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityFolderGroup,
  ActivityGroupsResponse,
  ActivityLocation,
  ActivityNoteGroup,
} from '@notarium/contract'
import { ACTIVITY_GROUP_BY, ACTIVITY_LOCATION_KIND } from '@notarium/contract/enums'
import { ActivityTimeline, ActivityTimelineRow } from '../../core/ActivityTimeline'
import { CardLink } from '../../core/CardLink'
import { EmptyState } from '../../core/EmptyState'
import {
  IconBot,
  IconClock,
  IconDoc,
  IconEdit,
  IconFolder,
  IconHistory,
  IconList,
  IconPlus,
  IconTrash,
  IconUser,
  IconX,
} from '../../core/Icons'
import { Notice, type NoticeVariant } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { Skeleton } from '../../core/Skeleton'
import { dayRangeUtc, folderCrumbs } from '../../libs/activity'
import { authorLabel } from '../../libs/author'
import { cx } from '../../libs/cx/cx'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { folderRoute, noteRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { isActivityProjectionRebuilding, requiresActivitySnapshotRecovery } from './activityErrors'
import type { ActivityGroup } from './activityPreferences'
import type { ActivityOverview } from './useDashboardActivityFeed'
import { type ActivityScope, TZ } from './useDashboardData'
import styles from './Dashboard.module.scss'

const DETAIL_LIMIT = 25

const KIND_ICON: Record<ActivityEventKind, typeof IconPlus> = {
  created: IconPlus,
  edited: IconEdit,
  restored: IconHistory,
  deleted: IconTrash,
  unavailable: IconClock,
}
const KIND_VERB: Record<ActivityEventKind, string> = {
  created: 'Created',
  edited: 'Edited',
  restored: 'Restored',
  deleted: 'Deleted',
  unavailable: 'Unavailable',
}
const KIND_VARIANT: Partial<Record<ActivityEventKind, NoticeVariant>> = {
  created: 'success',
  edited: 'info',
  restored: 'warning',
  deleted: 'error',
}
const SKELETON_WIDTHS: Array<[string, string]> = [
  ['58%', '32%'],
  ['44%', '26%'],
  ['66%', '30%'],
  ['38%', '22%'],
  ['52%', '34%'],
  ['47%', '24%'],
]

export const activityChurnText = (
  charsAdded: number | string | null,
  charsRemoved: number | string | null,
): string | null => {
  const parts = [
    ...(charsAdded == null ? [] : [`+${charsAdded}`]),
    ...(charsRemoved == null ? [] : [`−${charsRemoved}`]),
  ]

  return parts.length ? parts.join(' ') : null
}

/** Whether the feed has nothing honest to show for the current slice — the one
 *  render switch for the skeleton. In the standing lane a null overview is a
 *  skeleton unless it is a terminal failure with no recovery latched, which gets
 *  the failure chrome under the error notice instead. A request in flight is
 *  never a reason: a background refresh updates published rows in place. The
 *  drill lane reads its own two fields, exactly as before. */
export const activityFeedBusy = (
  overview: ActivityOverview | null,
  error: string | null,
  invalidated: boolean,
  day: string | null,
  dayOverview: ActivityOverview | null,
  dayError: string | null,
): boolean =>
  day != null
    ? dayOverview == null && dayError == null
    : overview == null && (invalidated || error == null)

const locationLabel = (location: ActivityNoteGroup['location']): string =>
  location.kind === ACTIVITY_LOCATION_KIND.folder
    ? location.path
    : location.kind === ACTIVITY_LOCATION_KIND.root
      ? 'Workspace root'
      : 'No current folder'

export const activityFolderGroupLabel = (location: ActivityLocation): string =>
  location.kind === ACTIVITY_LOCATION_KIND.folder
    ? `Folder · ${location.path}`
    : locationLabel(location)

export const activityLocationIdentity = (location: ActivityLocation): string =>
  location.kind === ACTIVITY_LOCATION_KIND.folder ? `folder:${location.path}` : location.kind

// Location reads the same in every Group mode: a folder path is the breadcrumb
// every raw event row has always drawn — each segment a real link into its Files
// view — while the structural `root` / `unavailable` buckets stay plain text,
// because there is nowhere to navigate. Callers own the surrounding `.eventCrumbs`
// span and their own visibility gate; the raw event row adapts its wire `path`
// (`''` root, `null` unavailable → nothing) into the same union here.
const LocationCrumbs = ({
  space,
  location,
  subject,
}: {
  space: string
  location: ActivityLocation
  /** The deepest segment IS this row's subject — the folder group row. Then the path
   *  carries the row's voice and everything leading to it stays dim, the same way a
   *  note row reads: context muted, the thing acted upon bright. */
  subject?: boolean
}) => {
  if (location.kind !== ACTIVITY_LOCATION_KIND.folder) {
    return locationLabel(location)
  }
  const crumbs = folderCrumbs(location.path)

  return crumbs.map((crumb, index) => (
    <span key={crumb.path}>
      {index > 0 && (
        <span className={styles.eventSep} aria-hidden>
          ›
        </span>
      )}
      <Link
        to={folderRoute(space, crumb.path)}
        className={cx(
          styles.eventCrumbLink,
          subject && index === crumbs.length - 1 && styles.eventCrumbSubject,
        )}
      >
        {crumb.name}
      </Link>
    </span>
  ))
}

const EventRow = ({
  ev,
  space,
  onOpen,
}: {
  ev: ActivityEvent
  space: string
  onOpen: (id: string) => void
}) => {
  const Icon = KIND_ICON[ev.kind]
  const author = authorLabel(ev.author)
  const churn = activityChurnText(ev.charsAdded, ev.charsRemoved)
  const actor = ev.author && (author.agent || !ev.author.mine) ? author : null
  const location: ActivityLocation | null = ev.path
    ? { kind: ACTIVITY_LOCATION_KIND.folder, path: ev.path }
    : null

  return (
    <ActivityTimelineRow
      icon={<Icon size={13} />}
      variant={KIND_VARIANT[ev.kind]}
      testId="dashboard-activity-row"
      primary={
        <div className={styles.eventPrimary}>
          {location && (
            <>
              <span className={styles.eventCrumbs}>
                <LocationCrumbs space={space} location={location} />
              </span>
              <span className={styles.eventSep} aria-hidden>
                ›
              </span>
            </>
          )}
          <CardLink
            href={noteRoute(ev.noteId)}
            onOpen={() => onOpen(ev.noteId)}
            className={styles.eventTitle}
            dataId={ev.noteId}
          >
            {ev.title || 'Untitled'}
          </CardLink>
        </div>
      }
      time={<time title={exactDateTime(ev.at)}>{timeAgo(ev.at)}</time>}
      action={KIND_VERB[ev.kind]}
      actor={
        actor ? (
          <>
            {actor.agent ? <IconBot size={12} /> : <IconUser size={12} />}
            {actor.text}
          </>
        ) : undefined
      }
      outcome={churn ?? undefined}
    />
  )
}

// The group row a branch was loaded under, kept on the branch so the next parent
// can be compared field by field. With the model lease and the location cut
// pinned and the journal append-only, a byte-equal row proves no event landed for
// this branch between the two source cuts.
type NoteRowStamp = {
  count: string
  charsAdded: string | null
  charsRemoved: string | null
  lastRevisionId: string
}

type FolderRowStamp = {
  noteCount: number
  eventCount: string
  charsAdded: string | null
  charsRemoved: string | null
  lastAt: string
}

export type EventBranch = NoteRowStamp & {
  kind: 'events'
  items: ActivityEvent[]
  through: string
  activityVersion: string
  nextCursor: string | null
  locationThrough: string
  loading: boolean
  error: string | null
}

export type FolderBranch = FolderRowStamp & {
  kind: 'notes'
  response: Extract<ActivityGroupsResponse, { itemType: 'note' }> | null
  locationThrough: string
  through: string
  activityVersion: string
  loading: boolean
  error: string | null
}

export type Branch = EventBranch | FolderBranch

type BranchRequest = {
  epoch: number
  sequence: number
  lease: string
}

const noteRowStamp = (note: ActivityNoteGroup): NoteRowStamp => ({
  count: note.count,
  charsAdded: note.charsAdded,
  charsRemoved: note.charsRemoved,
  lastRevisionId: note.lastEvent.revisionId,
})

const folderRowStamp = (folder: ActivityFolderGroup): FolderRowStamp => ({
  noteCount: folder.noteCount,
  eventCount: folder.eventCount,
  charsAdded: folder.charsAdded,
  charsRemoved: folder.charsRemoved,
  lastAt: folder.lastAt,
})

// `lastEvent` is compared by revision id, not deep-equal: its author label is
// re-resolved per request and is versioned by nothing.
const sameNoteRow = (branch: NoteRowStamp, note: ActivityNoteGroup): boolean =>
  branch.count === note.count &&
  branch.charsAdded === note.charsAdded &&
  branch.charsRemoved === note.charsRemoved &&
  branch.lastRevisionId === note.lastEvent.revisionId

const sameFolderRow = (branch: FolderRowStamp, folder: ActivityFolderGroup): boolean =>
  branch.noteCount === folder.noteCount &&
  branch.eventCount === folder.eventCount &&
  branch.charsAdded === folder.charsAdded &&
  branch.charsRemoved === folder.charsRemoved &&
  branch.lastAt === folder.lastAt

// The render guard: a branch shows only under the exact parent cut it was loaded
// for — source cut, model lease, location cut. Strict on purpose, in three places
// at once: a collapsed branch must fail it so re-expanding reloads; a refreshing
// branch must fail it so carried items stay hidden until the reload lands; and in
// the commit that first carries a new parent it is what keeps old detail from
// rendering under it until the pre-paint pass has re-stamped or refreshed it.
const branchMatchesParent = (
  branch: Branch | undefined,
  parent: ActivityGroupsResponse,
): branch is Branch =>
  !!branch &&
  branch.through === parent.through &&
  branch.activityVersion === parent.activityVersion &&
  branch.locationThrough === parent.locationThrough

// Carry-over keeps a refreshing branch's items on screen. It matches on the two
// cuts that would make the items wrong — the model lease and the location cut —
// and NOT on the source cut: an advanced `through` is exactly what a refresh is.
// It governs the reload's placeholder only; the render guard above stays strict.
const carriedBranch = (
  branch: Branch | undefined,
  parent: ActivityGroupsResponse,
): Branch | undefined =>
  branch &&
  branch.activityVersion === parent.activityVersion &&
  branch.locationThrough === parent.locationThrough
    ? branch
    : undefined

/** One pre-paint pass over the branches the current parent owns — the open keys
 *  the parent supplies a group row for — with exactly one of three outcomes each.
 *  KEEP: same cut, nothing to do. RE-KEY: only the source cut advanced, the branch
 *  is settled (not loading, no error, no continuation cursor — a cursor is bound to
 *  its cut server-side) and its own group row is unchanged, so it is re-stamped to
 *  the new cut without a request. REFRESH: everything else — the caller issues
 *  exactly one reload, whose optimistic write owns the entry; the pass never
 *  re-stamps a refreshed branch, or the render guard would show old detail under
 *  the new parent. The settled tests gate the re-stamp, not the action. Keys
 *  outside the domain are untouched: a nested note branch is maintained by its
 *  folder branch, and a key whose row left the overview has no row to reconcile
 *  against — which is why a folder with a nested request in flight is refreshed
 *  rather than re-keyed. */
export const reconcileBranches = (
  branches: Record<string, Branch>,
  parent: ActivityGroupsResponse,
  open: ReadonlySet<string>,
  keyOf: (kind: 'folder' | 'note', id: string) => string,
  isPending: (key: string) => boolean,
): { rekeyed: Array<[string, Branch]>; refresh: Set<string> } => {
  const rekeyed: Array<[string, Branch]> = []
  const refresh = new Set<string>()
  const through = parent.through
  const pinned = (branch: Branch): boolean =>
    branch.activityVersion === parent.activityVersion &&
    branch.locationThrough === parent.locationThrough
  const settled = (branch: Branch, cursor: string | null): boolean =>
    !branch.loading && branch.error == null && cursor == null
  // `loading` is a claim about a request, and a cut advance discards every request
  // it finds in flight. A branch whose claim no longer has a live request behind it
  // renders `Loading…` with nothing coming, so it is refreshed even at an unchanged
  // cut — the one state the KEEP outcome must not sit on.
  const alive = (key: string, branch: Branch): boolean => !branch.loading || isPending(key)
  // A folder is settled only when its nested notes are too. Re-keying issues no
  // request, while the lease bump that comes with every cut advance has already
  // discarded whatever a nested branch had in flight — and a nested key is outside
  // this pass's domain, so nothing else would ever re-issue it. Refreshing the
  // folder instead lets its own reload re-seed the nested branch, which is the one
  // producer nested keys have.
  const nestedIdle = (branch: FolderBranch): boolean =>
    (branch.response?.items ?? []).every((note) => {
      const nestedKey = keyOf('note', note.noteId)

      return !(open.has(nestedKey) && branches[nestedKey]?.loading)
    })

  if (parent.itemType === ACTIVITY_GROUP_BY.note) {
    for (const note of parent.items) {
      const key = keyOf('note', note.noteId)
      const branch = branches[key]

      if (!open.has(key)) {
        continue
      }
      if (branch?.kind !== 'events' || !pinned(branch)) {
        refresh.add(key)
      } else if (branch.through === through) {
        if (!alive(key, branch)) {
          refresh.add(key)
        }
        continue
      } else if (
        through != null &&
        settled(branch, branch.nextCursor) &&
        sameNoteRow(branch, note)
      ) {
        rekeyed.push([key, { ...branch, through }])
      } else {
        refresh.add(key)
      }
    }

    return { rekeyed, refresh }
  }
  for (const folder of parent.items) {
    const key = keyOf('folder', activityLocationIdentity(folder.location))
    const branch = branches[key]

    if (!open.has(key)) {
      continue
    }
    if (branch?.kind !== 'notes' || !pinned(branch)) {
      refresh.add(key)
    } else if (branch.through === through) {
      if (!alive(key, branch)) {
        refresh.add(key)
      }
      continue
    } else if (
      through != null &&
      settled(branch, branch.response?.nextCursor ?? null) &&
      nestedIdle(branch) &&
      sameFolderRow(branch, folder)
    ) {
      rekeyed.push([key, { ...branch, through }])
    } else {
      refresh.add(key)
    }
  }

  return { rekeyed, refresh }
}

const activityOverviewLease = (overview: ActivityOverview | null): string => {
  if (!overview) {
    return 'pending'
  }
  const { through, activityVersion } = overview.response

  return JSON.stringify([
    overview.kind,
    through ?? null,
    activityVersion ?? null,
    overview.kind === 'groups' ? overview.response.locationThrough : null,
  ])
}

export const ActivityFeed = ({
  space,
  overview,
  invalidated,
  rebuildingProlonged,
  error,
  stale,
  onRetry,
  onSnapshotRecovery,
  group,
  onGroupChange,
  scope,
  day,
  dayOverview,
  dayError,
  onDayRetry,
  onClearDay,
  onOpen,
}: {
  space: string
  overview: ActivityOverview | null
  /** A typed recovery is latched for this slice: the null overview is a skeleton
   *  under the notice, never the failure chrome. */
  invalidated: boolean
  /** The projection rebuild behind the skeleton has outlasted its threshold and
   *  deserves one line of explanation — in both lanes, because the open day reads
   *  the rebuild state from the standing feed (its own gate is closed meanwhile). */
  rebuildingProlonged: boolean
  error: string | null
  stale: boolean
  onRetry: () => void
  onSnapshotRecovery: (rebuilding: boolean) => void
  group: ActivityGroup
  onGroupChange: (group: ActivityGroup) => void
  scope: ActivityScope
  day: string | null
  dayOverview: ActivityOverview | null
  dayError: string | null
  onDayRetry: () => void
  onClearDay: () => void
  onOpen: (id: string) => void
}) => {
  const drilling = day != null
  const active = drilling ? dayOverview : overview
  const busy = activityFeedBusy(overview, error, invalidated, day, dayOverview, dayError)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [branches, setBranches] = useState<Record<string, Branch>>({})
  // Async continuations — a folder reload re-seeding its nested notes — must read
  // the open set as it is when they land, not as it was when they were issued:
  // with carry-over the folder keeps rendering its nested rows while its refresh is
  // in flight, so a note expanded mid-flight is only in the CURRENT set.
  const openRef = useRef(open)
  openRef.current = open
  const branchEpoch = useRef(0)
  const branchSequence = useRef(0)
  const latestBranchRequest = useRef(new Map<string, number>())
  const branchLease = JSON.stringify([
    space,
    day ?? null,
    scope,
    group,
    activityOverviewLease(active),
  ])
  const branchLeaseRef = useRef(branchLease)
  const locationThroughRef = useRef<string | null>(null)
  const activityVersionRef = useRef<string | null>(null)
  const reconcileRef = useRef<(next: ActivityOverview) => void>(() => undefined)
  const range = day ? dayRangeUtc(day, TZ) : {}

  useLayoutEffect(() => {
    if (branchLeaseRef.current !== branchLease) {
      branchLeaseRef.current = branchLease
      branchEpoch.current++
      latestBranchRequest.current.clear()
    }
  }, [branchLease])

  // A namespace change (Space, Group, scope, day) drops the open set and every
  // branch. The cut refs deliberately survive it: they belong to the pre-paint pass
  // below, which writes them on every grouped parent it sees. Resetting them here
  // would race that pass — layout runs before passive in the same commit — and a
  // nulled ref would read the next overview as first sight, skipping the wholesale
  // clear on a later location-only advance while the render guard still fails: a
  // stuck `Loading…` with nothing in flight. Leftover values are harmless because
  // `branchKey` is namespaced by exactly these deps: no old-namespace key can be
  // in `open`, and a spurious wholesale clear hits an already-empty map.
  useEffect(() => {
    branchEpoch.current++
    latestBranchRequest.current.clear()
    setOpen(new Set())
    setBranches({})
  }, [space, group, scope, day])

  const branchKey = (kind: 'folder' | 'note', id: string) =>
    `${space}:${day ?? 'standing'}:${scope}:${group}:${kind}:${id}`

  const beginBranchRequest = (key: string) => {
    const request = {
      epoch: branchEpoch.current,
      sequence: ++branchSequence.current,
      lease: branchLeaseRef.current,
    }

    latestBranchRequest.current.set(key, request.sequence)
    return request
  }

  // The map holds exactly the requests that can still land: an entry is added when
  // one is issued, dropped when it settles, and every entry is dropped wholesale
  // when a lease change invalidates them all. So membership answers one question
  // literally — is a request for this key in flight — and that is the only thing its
  // readers ask, about their own key and about a producer's alike. Anything weaker
  // (an entry that outlives its request) reads as a promise nobody is keeping.
  const endBranchRequest = (key: string, request: BranchRequest) => {
    if (latestBranchRequest.current.get(key) === request.sequence) {
      latestBranchRequest.current.delete(key)
    }
  }

  const isBranchPending = (key: string) => latestBranchRequest.current.has(key)

  const isCurrentBranchRequest = (key: string, request: BranchRequest): boolean =>
    request.epoch === branchEpoch.current &&
    request.lease === branchLeaseRef.current &&
    latestBranchRequest.current.get(key) === request.sequence

  const recoverSnapshot = (key: string, request: BranchRequest, recoveryError?: unknown) => {
    if (!isCurrentBranchRequest(key, request)) {
      return
    }
    branchEpoch.current++
    latestBranchRequest.current.clear()
    setBranches({})
    onSnapshotRecovery(isActivityProjectionRebuilding(recoveryError))
    if (drilling) {
      onDayRetry()
    }
  }

  const loadNote = async (
    key: string,
    note: ActivityNoteGroup,
    parent: ActivityGroupsResponse,
    cursor?: string,
  ) => {
    if (!parent.through) {
      return
    }
    const request = beginBranchRequest(key)

    setBranches((current) => {
      const previous = carriedBranch(current[key], parent)
      const carried = previous?.kind === 'events' ? previous : undefined

      return {
        ...current,
        [key]: {
          kind: 'events',
          items: carried?.items ?? [],
          through: parent.through!,
          activityVersion: parent.activityVersion,
          nextCursor: carried && carried.through === parent.through ? carried.nextCursor : null,
          locationThrough: parent.locationThrough,
          ...noteRowStamp(note),
          loading: true,
          error: null,
        },
      }
    })
    try {
      const response = await api.activityEventsGet(space, {
        ...range,
        author: scope === 'mine' ? 'mine' : undefined,
        noteId: note.noteId,
        through: parent.through,
        activityVersion: parent.activityVersion,
        locationThrough: parent.locationThrough,
        cursor,
        limit: DETAIL_LIMIT,
      })

      if (!isCurrentBranchRequest(key, request)) {
        return
      }
      if (
        response.through !== parent.through ||
        response.activityVersion !== parent.activityVersion
      ) {
        recoverSnapshot(key, request)
        return
      }
      endBranchRequest(key, request)
      setBranches((current) => {
        const branch = current[key]
        const items =
          cursor && branch?.kind === 'events'
            ? [...branch.items, ...response.events]
            : response.events
        return {
          ...current,
          [key]: {
            kind: 'events',
            items,
            through: parent.through!,
            activityVersion: parent.activityVersion,
            nextCursor: response.nextCursor ?? null,
            locationThrough: parent.locationThrough,
            ...noteRowStamp(note),
            loading: false,
            error: null,
          },
        }
      })
    } catch (loadError) {
      if (!isCurrentBranchRequest(key, request)) {
        return
      }
      if (requiresActivitySnapshotRecovery(loadError)) {
        recoverSnapshot(key, request, loadError)
        return
      }
      endBranchRequest(key, request)
      setBranches((current) => ({
        ...current,
        [key]: {
          ...(current[key] as EventBranch),
          loading: false,
          error: loadError instanceof Error ? loadError.message : 'Could not load changes',
        },
      }))
    }
  }

  const loadFolder = async (
    key: string,
    folder: ActivityFolderGroup,
    parent: ActivityGroupsResponse,
    cursor?: string,
  ) => {
    if (!parent.through) {
      return
    }
    const request = beginBranchRequest(key)

    setBranches((current) => {
      const previous = carriedBranch(current[key], parent)
      const carried = previous?.kind === 'notes' ? previous : undefined

      return {
        ...current,
        [key]: {
          kind: 'notes',
          // The continuation cursor lives inside the carried page and is bound to
          // that page's cut, so on a cut advance exactly that one field is nulled.
          // The page's own cuts stay: its nested branches sit at the same old cut,
          // and the server accepts an older `through` on their requests.
          response:
            carried?.response == null
              ? null
              : carried.through === parent.through
                ? carried.response
                : { ...carried.response, nextCursor: null },
          locationThrough: parent.locationThrough,
          through: parent.through!,
          activityVersion: parent.activityVersion,
          ...folderRowStamp(folder),
          loading: true,
          error: null,
        },
      }
    })
    try {
      const response = await api.activityGroupsGet(space, {
        by: ACTIVITY_GROUP_BY.folder,
        ...range,
        author: scope === 'mine' ? 'mine' : undefined,
        limit: DETAIL_LIMIT,
        cursor,
        through: parent.through,
        activityVersion: parent.activityVersion,
        locationThrough: parent.locationThrough,
        location: folder.location.kind,
        path:
          folder.location.kind === ACTIVITY_LOCATION_KIND.folder ? folder.location.path : undefined,
      })

      if (response.itemType !== ACTIVITY_GROUP_BY.note) {
        throw new Error('invalid folder detail')
      }
      if (!isCurrentBranchRequest(key, request)) {
        return
      }
      if (
        response.through !== parent.through ||
        response.activityVersion !== parent.activityVersion ||
        response.locationThrough !== parent.locationThrough
      ) {
        recoverSnapshot(key, request)
        return
      }
      endBranchRequest(key, request)
      setBranches((current) => {
        const branch = current[key]
        const prior = branch?.kind === 'notes' ? branch.response : null
        const merged =
          cursor && prior ? { ...response, items: [...prior.items, ...response.items] } : response
        return {
          ...current,
          [key]: {
            kind: 'notes',
            response: merged,
            locationThrough: parent.locationThrough,
            through: parent.through!,
            activityVersion: parent.activityVersion,
            ...folderRowStamp(folder),
            loading: false,
            error: null,
          },
        }
      })
      for (const note of response.items) {
        const noteKey = branchKey('note', note.noteId)

        if (openRef.current.has(noteKey)) {
          void loadNote(noteKey, note, response)
        }
      }
    } catch (loadError) {
      if (!isCurrentBranchRequest(key, request)) {
        return
      }
      if (requiresActivitySnapshotRecovery(loadError)) {
        recoverSnapshot(key, request, loadError)
        return
      }
      endBranchRequest(key, request)
      setBranches((current) => {
        const failed = current[key] as FolderBranch
        // The reload was the one producer that would have re-seeded this folder's
        // nested notes, and the cut advance behind it already discarded whatever they
        // had in flight. Without this they would render `Loading…` with nothing
        // coming and no way back — their own disclosure sees a current branch and
        // issues nothing. Give them the failure instead: a Retry that works, on the
        // page still under them.
        const orphaned = (failed.response?.items ?? []).flatMap((note) => {
          const noteKey = branchKey('note', note.noteId)
          const nested = current[noteKey]

          return nested?.loading && !isBranchPending(noteKey)
            ? [[noteKey, { ...nested, loading: false, error: 'Could not load changes' }] as const]
            : []
        })

        return {
          ...current,
          ...Object.fromEntries(orphaned),
          [key]: {
            ...failed,
            loading: false,
            error: loadError instanceof Error ? loadError.message : 'Could not load folder',
          },
        }
      })
    }
  }

  // The pre-paint pass. A model-lease or location-cut change still clears every
  // branch wholesale (the open set survives a location change and drops with the
  // namespace); everything else is decided per key by `reconcileBranches`. Re-stamps
  // are written first and reloads issued after: each reload's optimistic write is a
  // functional update and lands on top of the re-keyed map, never under it.
  reconcileRef.current = (next) => {
    if (next.kind !== 'groups') {
      return
    }
    const parent = next.response
    const locationChanged =
      locationThroughRef.current != null && locationThroughRef.current !== parent.locationThrough
    const activityVersionChanged =
      activityVersionRef.current != null && activityVersionRef.current !== parent.activityVersion
    const cleared = locationChanged || activityVersionChanged

    locationThroughRef.current = parent.locationThrough
    activityVersionRef.current = parent.activityVersion
    if (cleared) {
      branchEpoch.current++
      latestBranchRequest.current.clear()
      setBranches({})
    }
    const { rekeyed, refresh } = reconcileBranches(
      cleared ? {} : branches,
      parent,
      open,
      branchKey,
      isBranchPending,
    )

    if (rekeyed.length) {
      setBranches((current) => ({ ...current, ...Object.fromEntries(rekeyed) }))
    }
    if (parent.itemType === ACTIVITY_GROUP_BY.note) {
      for (const note of parent.items) {
        const key = branchKey('note', note.noteId)

        if (refresh.has(key)) {
          void loadNote(key, note, parent)
        }
      }

      return
    }
    for (const folder of parent.items) {
      const key = branchKey('folder', activityLocationIdentity(folder.location))

      if (refresh.has(key)) {
        void loadFolder(key, folder, parent)
      }
    }
  }

  // Layout, not passive, and declared after the lease effect above — both on
  // purpose. After: the pass must see the bumped epoch and the current lease, or
  // its own reloads would be discarded as stale and the branches this pass keeps
  // warm would sit at `Loading…` forever. Layout: in the commit that first carries a
  // new parent every open branch fails the strict render guard, and a passive pass
  // would let that commit paint `Loading…` over rows the user is reading; a re-stamp
  // from a layout effect re-renders before paint. Deps are the overview alone —
  // every successful publication is a fresh identity, and `open`/`branches` are read
  // through the render-assigned function above.
  useLayoutEffect(() => {
    if (active) {
      reconcileRef.current(active)
    }
  }, [active])

  const toggle = (
    key: string,
    expanded: boolean,
    hasCurrentBranch: boolean,
    load: () => Promise<void>,
  ) => {
    setOpen((current) => {
      const next = new Set(current)

      if (expanded) {
        next.add(key)
      } else {
        next.delete(key)
      }

      return next
    })
    if (expanded && !hasCurrentBranch) {
      void load()
    }
  }

  // `Loading…` is a promise that something is coming, so it is drawn only while a
  // request that can deliver is in flight. A cut advance discards every request it
  // finds, and the pass repairs only the keys it owns — a nested note under a folder
  // it kept, or a collapsed key, is outside it and would otherwise spin forever with
  // a disclosure that issues nothing. Those get the truth and a Retry that works: it
  // reloads against the page still rendered under them, at the cut that page was
  // fetched for.
  // A nested note has two producers, and both count: its own request while it has
  // one, and its folder's reload when it does not — that reload's re-seed is what
  // will deliver. Reading only the nested key flashes a failure over every ordinary
  // append for a whole round trip; reading only the folder calls a healthy first
  // expand a failure whenever the folder itself is idle.
  const renderBranchStatus = (
    key: string,
    branch: Branch | undefined,
    retry: () => Promise<void>,
    producerKey?: string,
  ) => {
    const delivering = isBranchPending(key) || (producerKey != null && isBranchPending(producerKey))
    const failure =
      branch && branch.loading && !delivering ? 'Could not load changes' : branch?.error

    if (
      !failure &&
      (!branch ||
        (branch.loading && (branch.kind === 'events' ? !branch.items.length : !branch.response)))
    ) {
      return <div className={styles.branchStatus}>Loading…</div>
    }
    if (failure) {
      return (
        <Notice variant="error" className={styles.branchStatus}>
          {failure} <button onClick={() => void retry()}>Retry</button>
        </Notice>
      )
    }

    return null
  }

  const renderNote = (
    note: ActivityNoteGroup,
    parent: ActivityGroupsResponse,
    /** Set when this row is nested under a folder branch: that branch's key, the one
     *  producer a nested note has. */
    producerKey?: string,
  ) => {
    const key = branchKey('note', note.noteId)
    const storedBranch = branches[key]
    const branch = branchMatchesParent(storedBranch, parent) ? storedBranch : undefined
    const expanded = open.has(key)
    const hasFolder = note.location.kind === ACTIVITY_LOCATION_KIND.folder
    const detail = (
      <div>
        {renderBranchStatus(key, branch, () => loadNote(key, note, parent), producerKey)}
        {branch?.kind === 'events' && branch.items.length > 0 && (
          <ActivityTimeline spine={false}>
            {branch.items.map((event) => (
              <EventRow key={event.revisionId} ev={event} space={space} onOpen={onOpen} />
            ))}
          </ActivityTimeline>
        )}
        {branch?.kind === 'events' && branch.nextCursor && !branch.loading && (
          <button
            type="button"
            className={styles.loadOlder}
            onClick={() => void loadNote(key, note, parent, branch.nextCursor!)}
          >
            Load older changes
          </button>
        )}
      </div>
    )

    return (
      <ActivityTimelineRow
        key={key}
        icon={<IconDoc size={13} />}
        testId="dashboard-activity-note-group"
        primary={
          <div className={styles.eventPrimary}>
            {hasFolder && (
              <>
                <span className={styles.eventCrumbs}>
                  <LocationCrumbs space={space} location={note.location} />
                </span>
                <span className={styles.eventSep} aria-hidden>
                  ›
                </span>
              </>
            )}
            <CardLink
              href={noteRoute(note.noteId)}
              onOpen={() => onOpen(note.noteId)}
              className={styles.eventTitle}
              dataId={note.noteId}
            >
              {note.title || 'Untitled'}
            </CardLink>
          </div>
        }
        time={<time title={exactDateTime(note.lastEvent.at)}>{timeAgo(note.lastEvent.at)}</time>}
        action={`${note.count} ${note.count === '1' ? 'change' : 'changes'}`}
        outcome={activityChurnText(note.charsAdded, note.charsRemoved) ?? undefined}
        detail={detail}
        disclosureLabel={`${expanded ? 'Collapse' : 'Expand'} changes for ${note.title || 'Untitled'}`}
        expanded={expanded}
        onExpandedChange={(next) =>
          toggle(key, next, branch != null, () => loadNote(key, note, parent))
        }
      />
    )
  }

  const content = () => {
    if (busy) {
      return (
        <ActivityTimeline ariaHidden skeleton>
          {SKELETON_WIDTHS.map(([head, meta], index) => (
            <ActivityTimelineRow
              key={index}
              icon={null}
              primary={<Skeleton w={head} h={14} />}
              action={<Skeleton w={meta} h={11} />}
              time={<Skeleton w={46} h={11} />}
            />
          ))}
        </ActivityTimeline>
      )
    }
    if (!active) {
      const failed = drilling ? dayError != null : error != null

      return failed ? <div className={styles.feedEmpty} aria-hidden /> : null
    }
    if (active.kind === 'events') {
      return active.response.events.length ? (
        <ActivityTimeline>
          {active.response.events.map((event) => (
            <EventRow key={event.revisionId} ev={event} space={space} onOpen={onOpen} />
          ))}
        </ActivityTimeline>
      ) : null
    }
    if (!active.response.items.length) {
      return null
    }
    if (active.response.itemType === ACTIVITY_GROUP_BY.note) {
      return (
        <ActivityTimeline>
          {active.response.items.map((note) => renderNote(note, active.response))}
        </ActivityTimeline>
      )
    }

    return (
      <ActivityTimeline>
        {active.response.items.map((folder) => {
          const id = activityFolderGroupLabel(folder.location)
          const key = branchKey('folder', activityLocationIdentity(folder.location))
          const storedBranch = branches[key]
          const branch = branchMatchesParent(storedBranch, active.response)
            ? storedBranch
            : undefined
          const expanded = open.has(key)
          const detail = (
            <div>
              {renderBranchStatus(key, branch, () => loadFolder(key, folder, active.response))}
              {branch?.kind === 'notes' && branch.response && (
                <ActivityTimeline spine={false}>
                  {branch.response.items.map((note) => renderNote(note, branch.response!, key))}
                </ActivityTimeline>
              )}
              {branch?.kind === 'notes' && branch.response?.nextCursor && !branch.loading && (
                <button
                  type="button"
                  className={styles.loadOlder}
                  onClick={() =>
                    void loadFolder(key, folder, active.response, branch.response!.nextCursor!)
                  }
                >
                  Load older notes
                </button>
              )}
            </div>
          )

          return (
            <ActivityTimelineRow
              key={key}
              icon={<IconFolder size={13} />}
              testId="dashboard-activity-folder-group"
              primary={
                // The `Folder · ` qualifier stays plain text ahead of the linked
                // segments, so a real folder named `Workspace root` still cannot be
                // read as the structural bucket; the buckets themselves stay labels.
                // Everything but the row's subject is dim: the qualifier and the
                // parent segments are context, the folder itself is what changed.
                folder.location.kind === ACTIVITY_LOCATION_KIND.folder ? (
                  <span className={styles.folderQualifier}>
                    {'Folder · '}
                    <LocationCrumbs space={space} location={folder.location} subject />
                  </span>
                ) : (
                  id
                )
              }
              time={<time title={exactDateTime(folder.lastAt)}>{timeAgo(folder.lastAt)}</time>}
              action={`${folder.noteCount} ${folder.noteCount === 1 ? 'note' : 'notes'}`}
              context={`${folder.eventCount} ${folder.eventCount === '1' ? 'change' : 'changes'}`}
              outcome={activityChurnText(folder.charsAdded, folder.charsRemoved) ?? undefined}
              detail={detail}
              disclosureLabel={`${expanded ? 'Collapse' : 'Expand'} notes in ${id}`}
              expanded={expanded}
              onExpandedChange={(next) =>
                toggle(key, next, branch != null, () => loadFolder(key, folder, active.response))
              }
            />
          )
        })}
      </ActivityTimeline>
    )
  }

  const rendered = content()

  return (
    <section data-testid="activity-feed">
      <div className={styles.feedHeading}>
        <h2 className={styles.feedTitle}>
          <IconClock size={15} /> {drilling ? `Changes on ${day}` : 'What changed'}
          {drilling && (
            <button
              type="button"
              className={styles.feedClear}
              onClick={onClearDay}
              title="Back to recent"
            >
              <IconX size={13} /> clear
            </button>
          )}
        </h2>
        <Segmented
          value={group}
          onChange={onGroupChange}
          ariaLabel="Group activity"
          options={[
            { value: 'note', label: 'Note', icon: <IconDoc size={13} /> },
            { value: 'folder', label: 'Folder', icon: <IconFolder size={13} /> },
            { value: 'none', label: 'None', icon: <IconList size={13} /> },
          ]}
        />
      </div>
      {/* A rebuild is a state, not a failure: a polite status with no button. There is
          nothing a click could do — a retry only re-enters the same lease — and the
          projection's own `changed` frame swaps the skeleton for rows. In flow like
          every feed notice, so the skeleton moves down by its height: accepted.
          Suppressed exactly where the failure notice below takes the lane, and not a
          line earlier: that notice is standing-only, so inside the drill this is the
          reader's only explanation of the skeleton and must survive a standing
          error. */}
      {rebuildingProlonged && !(error && !drilling) && (
        <Notice variant="info" className={styles.feedNotice}>
          Rebuilding the activity summary. This can take a while; the feed will refresh on its own
          when it’s done.
        </Notice>
      )}
      {error && !drilling && (
        <Notice variant={stale ? 'warning' : 'error'} className={styles.feedNotice}>
          {error} <button onClick={onRetry}>Retry</button>
        </Notice>
      )}
      {dayError && drilling && (
        <Notice variant="error" className={styles.feedNotice}>
          {dayError} <button onClick={onDayRetry}>Retry</button>
        </Notice>
      )}
      {rendered ?? (
        <div className={styles.feedEmpty}>
          <EmptyState
            variant="bare"
            icon={<IconClock size={20} />}
            title={drilling ? 'Nothing changed this day' : 'No activity yet'}
            hint={drilling ? undefined : 'Edits you make will show up here.'}
          />
        </div>
      )}
    </section>
  )
}
