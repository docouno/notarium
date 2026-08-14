import { Link } from 'react-router'
import type { ActivityEvent, ActivityEventKind } from '@notarium/contract'
import { ActivityTimeline, ActivityTimelineRow } from '../../core/ActivityTimeline'
import { CardLink } from '../../core/CardLink'
import { EmptyState } from '../../core/EmptyState'
import {
  IconBot,
  IconClock,
  IconEdit,
  IconHistory,
  IconPlus,
  IconTrash,
  IconUser,
  IconX,
} from '../../core/Icons'
import type { NoticeVariant } from '../../core/Notice'
import { Skeleton } from '../../core/Skeleton'
import { folderCrumbs } from '../../libs/activity'
import { authorLabel } from '../../libs/author'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { folderRoute, noteRoute } from '../../libs/routing/routePaths'
import styles from './Dashboard.module.scss'

// The "what changed" feed (#33/#217): journal events (create/edit/restore/delete)
// as an activity timeline: location + note on the first line, then the shared feed
// grammar (action · actor · outcome). No card backdrop. Doubles
// as the heatmap day-drill (a selected day shows THAT day's events + a clear
// control). Moves aren't here on purpose — a pure folder move keeps title/body/tags
// so the journal dedups it (no event); `path` is the note's CURRENT folder.

const KIND_ICON: Record<ActivityEventKind, typeof IconPlus> = {
  created: IconPlus,
  edited: IconEdit,
  restored: IconHistory,
  deleted: IconTrash,
  // A gap is a moment, not an action: the clock is the honest glyph, and it gets
  // no colour of its own — nothing about it is attributable (#327).
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

// Per-row [title, meta] shimmer widths for the loading feed (#218) — varied so the
// column reads like real entries (differing note-name lengths) rather than a barcode.
const SKELETON_WIDTHS: Array<[string, string]> = [
  ['58%', '32%'],
  ['44%', '26%'],
  ['66%', '30%'],
  ['38%', '22%'],
  ['52%', '34%'],
  ['47%', '24%'],
]

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
  const churn =
    ev.charsAdded != null && ev.charsRemoved != null && (ev.charsAdded || ev.charsRemoved)
      ? `+${ev.charsAdded} −${ev.charsRemoved}`
      : null
  // Own UI edits stay implicit, but agents always remain named: their identity is
  // useful context even in a personal space. Other people keep their resolved label.
  const actor = ev.author && (author.agent || !ev.author.mine) ? author : null
  // The note's location as clickable breadcrumb segments (empty for a root note or
  // a deleted one whose path we no longer resolve — then just the title shows).
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
                {crumbs.map((c, i) => (
                  <span key={c.path}>
                    {i > 0 && (
                      <span className={styles.eventSep} aria-hidden>
                        ›
                      </span>
                    )}
                    <Link to={folderRoute(space, c.path)} className={styles.eventCrumbLink}>
                      {c.name}
                    </Link>
                  </span>
                ))}
              </span>
              {/* Boundary separator between the path and the title — its own flex
                  item so its margins don't collapse at the crumbs↔title edge (the
                  gap then matches the inter-folder ones exactly). */}
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

export const ActivityFeed = ({
  space,
  recent,
  loading,
  day,
  dayEvents,
  onClearDay,
  onOpen,
}: {
  space: string
  recent: ActivityEvent[]
  loading: boolean
  day: string | null
  dayEvents: ActivityEvent[] | null
  onClearDay: () => void
  onOpen: (id: string) => void
}) => {
  const drilling = day != null
  const events = drilling ? dayEvents : recent
  const busy = drilling ? dayEvents == null : loading

  return (
    <section data-testid="activity-feed">
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
      {busy ? (
        // Skeleton rows reuse the REAL `.event` frame (same icon-on-rail geometry,
        // same min-height, same two-line body), so each row is dimensionally a loaded
        // row — only the text is a shimmer. Widths vary per row so the column reads as
        // a feed, not a stack of identical bars (#218). Count reserves a plausible
        // feed height; the feed is the last element, so a length mismatch shifts
        // nothing above it. Icon disc stays neutral (no kind colour) — it's a node
        // placeholder, not a real event.
        <ActivityTimeline ariaHidden>
          {SKELETON_WIDTHS.map(([head, meta], i) => (
            <ActivityTimelineRow
              key={i}
              icon={null}
              primary={<Skeleton w={head} h={14} />}
              action={<Skeleton w={meta} h={11} />}
              time={<Skeleton w={46} h={11} />}
            />
          ))}
        </ActivityTimeline>
      ) : events && events.length ? (
        <ActivityTimeline>
          {events.map((ev) => (
            <EventRow key={ev.revisionId} ev={ev} space={space} onOpen={onOpen} />
          ))}
        </ActivityTimeline>
      ) : (
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
