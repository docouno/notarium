import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type {
  ActivityEvent,
  ActivityEventKind,
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
  const crumbs = folderCrumbs(ev.path)

  return (
    <ActivityTimelineRow
      icon={<Icon size={13} />}
      variant={KIND_VARIANT[ev.kind]}
      testId="dashboard-activity-row"
      primary={
        <div className={styles.eventPrimary}>
          {crumbs.length > 0 && (
            <>
              <span className={styles.eventCrumbs}>
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path}>
                    {index > 0 && (
                      <span className={styles.eventSep} aria-hidden>
                        ›
                      </span>
                    )}
                    <Link to={folderRoute(space, crumb.path)} className={styles.eventCrumbLink}>
                      {crumb.name}
                    </Link>
                  </span>
                ))}
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

type EventBranch = {
  kind: 'events'
  items: ActivityEvent[]
  through: string
  activityVersion: string
  nextCursor: string | null
  locationThrough: string
  lastRevisionId: string
  loading: boolean
  error: string | null
}

type FolderBranch = {
  kind: 'notes'
  response: Extract<ActivityGroupsResponse, { itemType: 'note' }> | null
  locationThrough: string
  through: string
  activityVersion: string
  lastAt: string
  loading: boolean
  error: string | null
}

type Branch = EventBranch | FolderBranch

type BranchRequest = {
  epoch: number
  sequence: number
  lease: string
}

const branchMatchesParent = (
  branch: Branch | undefined,
  parent: ActivityGroupsResponse,
): branch is Branch =>
  !!branch &&
  branch.through === parent.through &&
  branch.activityVersion === parent.activityVersion &&
  branch.locationThrough === parent.locationThrough

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
  loading,
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
  loading: boolean
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
  const busy = drilling ? dayOverview == null && dayError == null : loading
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [branches, setBranches] = useState<Record<string, Branch>>({})
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

  useEffect(() => {
    branchEpoch.current++
    latestBranchRequest.current.clear()
    setOpen(new Set())
    setBranches({})
    locationThroughRef.current = null
    activityVersionRef.current = null
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
      const previous = branchMatchesParent(current[key], parent) ? current[key] : undefined
      return {
        ...current,
        [key]: {
          kind: 'events',
          items: previous?.kind === 'events' ? previous.items : [],
          through: parent.through!,
          activityVersion: parent.activityVersion,
          nextCursor: previous?.kind === 'events' ? previous.nextCursor : null,
          locationThrough: parent.locationThrough,
          lastRevisionId: note.lastEvent.revisionId,
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
            lastRevisionId: note.lastEvent.revisionId,
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
    folder: Extract<ActivityGroupsResponse, { itemType: 'folder' }>['items'][number],
    parent: ActivityGroupsResponse,
    cursor?: string,
  ) => {
    if (!parent.through) {
      return
    }
    const request = beginBranchRequest(key)

    setBranches((current) => {
      const previous = branchMatchesParent(current[key], parent) ? current[key] : undefined
      return {
        ...current,
        [key]: {
          kind: 'notes',
          response: previous?.kind === 'notes' ? previous.response : null,
          locationThrough: parent.locationThrough,
          through: parent.through!,
          activityVersion: parent.activityVersion,
          lastAt: folder.lastAt,
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
            lastAt: folder.lastAt,
            loading: false,
            error: null,
          },
        }
      })
      for (const note of response.items) {
        const noteKey = branchKey('note', note.noteId)

        if (open.has(noteKey)) {
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
      setBranches((current) => ({
        ...current,
        [key]: {
          ...(current[key] as FolderBranch),
          loading: false,
          error: loadError instanceof Error ? loadError.message : 'Could not load folder',
        },
      }))
    }
  }

  reconcileRef.current = (next) => {
    if (next.kind !== 'groups') {
      return
    }
    const locationChanged =
      locationThroughRef.current != null &&
      locationThroughRef.current !== next.response.locationThrough
    const activityVersionChanged =
      activityVersionRef.current != null &&
      activityVersionRef.current !== next.response.activityVersion

    locationThroughRef.current = next.response.locationThrough
    activityVersionRef.current = next.response.activityVersion
    if (locationChanged || activityVersionChanged) {
      branchEpoch.current++
      latestBranchRequest.current.clear()
      setBranches({})
    }
    if (next.response.itemType === ACTIVITY_GROUP_BY.note) {
      for (const note of next.response.items) {
        const key = branchKey('note', note.noteId)
        const branch = branches[key]

        if (
          open.has(key) &&
          (locationChanged ||
            activityVersionChanged ||
            branch?.kind !== 'events' ||
            branch.through !== next.response.through ||
            branch.activityVersion !== next.response.activityVersion ||
            branch.lastRevisionId !== note.lastEvent.revisionId)
        ) {
          void loadNote(key, note, next.response)
        }
      }

      return
    }
    for (const folder of next.response.items) {
      const key = branchKey('folder', activityLocationIdentity(folder.location))
      const branch = branches[key]

      if (
        open.has(key) &&
        (locationChanged ||
          activityVersionChanged ||
          branch?.kind !== 'notes' ||
          branch.through !== next.response.through ||
          branch.activityVersion !== next.response.activityVersion ||
          branch.lastAt !== folder.lastAt)
      ) {
        void loadFolder(key, folder, next.response)
      }
    }
  }

  useEffect(() => {
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

  const renderBranchStatus = (branch: Branch | undefined, retry: () => Promise<void>) => {
    if (
      !branch ||
      (branch.loading && (branch.kind === 'events' ? !branch.items.length : !branch.response))
    ) {
      return <div className={styles.branchStatus}>Loading…</div>
    }
    if (branch.error) {
      return (
        <Notice variant="error" className={styles.branchStatus}>
          {branch.error} <button onClick={() => void retry()}>Retry</button>
        </Notice>
      )
    }

    return null
  }

  const renderNote = (note: ActivityNoteGroup, parent: ActivityGroupsResponse) => {
    const key = branchKey('note', note.noteId)
    const storedBranch = branches[key]
    const branch = branchMatchesParent(storedBranch, parent) ? storedBranch : undefined
    const expanded = open.has(key)
    const hasFolder = note.location.kind === ACTIVITY_LOCATION_KIND.folder
    const detail = (
      <div>
        {renderBranchStatus(branch, () => loadNote(key, note, parent))}
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
                <span className={styles.eventCrumbs}>{locationLabel(note.location)}</span>
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
        <ActivityTimeline ariaHidden>
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
              {renderBranchStatus(branch, () => loadFolder(key, folder, active.response))}
              {branch?.kind === 'notes' && branch.response && (
                <ActivityTimeline spine={false}>
                  {branch.response.items.map((note) => renderNote(note, branch.response!))}
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
              primary={id}
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
