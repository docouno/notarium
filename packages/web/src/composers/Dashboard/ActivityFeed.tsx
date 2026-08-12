import { Link } from 'react-router'
import type { ActivityEvent, ActivityEventKind } from '@notarium/contract'
import { CardLink } from '../../core/CardLink'
import { EmptyState } from '../../core/EmptyState'
import { IconClock, IconEdit, IconHistory, IconPlus, IconTrash, IconX } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { folderCrumbs } from '../../libs/activity'
import { authorLabel } from '../../libs/author'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { folderRoute, noteRoute } from '../../libs/routing/routePaths'
import styles from './Dashboard.module.scss'

// The "what changed" feed (#33/#217): journal events (create/edit/restore/delete)
// as a GitLab-style activity TIMELINE — a vertical spine with the kind icon sitting
// on it, then a two-line entry. Line one is the note's LOCATION as a breadcrumb
// (each folder clickable → its Files view) ending in the note title (→ the note),
// with the time right-aligned; line two is the metadata (kind · churn · the author,
// shown only in a shared space). No card backdrop (it's a full-width strip). Doubles
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
  // Show the actor only when it isn't the viewer (a shared space) — keeps the
  // common single-user feed clean (no "you · you · you"). A journal gap (#327)
  // arrives with `author: null`, so it drops out here without a rule of its own.
  const byOther = ev.author && !ev.author.mine ? author.text : null
  // The note's location as clickable breadcrumb segments (empty for a root note or
  // a deleted one whose path we no longer resolve — then just the title shows).
  const crumbs = folderCrumbs(ev.path)
  return (
    <div className={styles.event}>
      <span className={styles.eventIcon} data-kind={ev.kind} aria-hidden>
        <Icon size={13} />
      </span>
      <div className={styles.eventBody}>
        <div className={styles.eventHead}>
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
          <time className={styles.eventDate} title={exactDateTime(ev.at)}>
            {timeAgo(ev.at)}
          </time>
        </div>
        <div className={styles.eventMeta}>
          <span className={styles.eventVerb}>{KIND_VERB[ev.kind]}</span>
          {churn && <span className={styles.eventChurn}> · {churn}</span>}
          {byOther && <span className={styles.eventBy}> · {byOther}</span>}
        </div>
      </div>
    </div>
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
        <div className={styles.timeline} aria-hidden>
          {SKELETON_WIDTHS.map(([head, meta], i) => (
            <div key={i} className={styles.event}>
              <span className={styles.eventIcon} />
              <div className={styles.eventBody}>
                <Skeleton w={head} h={14} />
                <Skeleton w={meta} h={11} />
              </div>
            </div>
          ))}
        </div>
      ) : events && events.length ? (
        <div className={styles.timeline}>
          {events.map((ev) => (
            <EventRow key={ev.revisionId} ev={ev} space={space} onOpen={onOpen} />
          ))}
        </div>
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
