import { type CSSProperties, type ImgHTMLAttributes, useMemo } from 'react'
import { CardLink } from '../../core/CardLink'
import { Chip, TagChips } from '../../core/Chips'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { absoluteDate } from '../../libs/datetime'
import { cardFieldValues, type PresentedCardField } from '../../libs/fields'
import type { NoteView } from '../../libs/wire'
import { FEED_COLS, type FeedCols, type FeedState } from '../FeedProvider'
import { useFieldSchema } from '../FieldSchemaProvider'
import { LINES } from './consts'
import { useCardPreview } from './hooks/useCardPreview'
import styles from './FeedView.module.scss'

// The date pill (neutral grey). Rendered as a bare sibling so a card/row can
// order it itself. The Feed keeps the `feedDate` class
// for its contextual overrides (the timeline gutter restyles it). Tag pills come
// from the shared <TagChips> (the dense-grid `display:none` rides `feedTag`).
const DateChip = ({ date }: { date: string }) =>
  date ? (
    <span className={styles.feedDate} data-testid="feed-date-chip">
      {date}
    </span>
  ) : null

const useCardFields = (note: NoteView): PresentedCardField[] => {
  const schema = useFieldSchema()

  return useMemo(() => cardFieldValues(note.fields, schema.fields), [note.fields, schema.fields])
}

const TypeChip = ({ noteType }: { noteType?: string }) =>
  noteType ? (
    <Chip variant="accent" className={styles.feedTag} title="Type" testId="feed-type-chip">
      {noteType}
    </Chip>
  ) : null

const FieldChips = ({ fields }: { fields: readonly PresentedCardField[] }) => (
  <>
    {fields.map((field) => (
      <Chip
        key={field.key}
        className={styles.feedTag}
        color={field.color}
        title={`${field.fieldLabel}: ${field.label}`}
        ariaLabel={`${field.fieldLabel}: ${field.label}`}
        testId="feed-field-chip"
      >
        {field.label}
      </Chip>
    ))}
  </>
)

const thumbProps = (src: string): ImgHTMLAttributes<HTMLImageElement> => ({
  src,
  alt: '',
  loading: 'lazy',
  decoding: 'async',
  // Self-hide a dead URL so it never leaves a broken-image box.
  onError: (e) => {
    e.currentTarget.style.display = 'none'
  },
})

// Grid card (Grid view): a Keep/Pinterest-style tile. A card *with* an image
// spans two grid rows (see .feed-grid in styles.css), so the dense auto-flow
// packs two text-only tiles beside it — a real grid, not ragged masonry.
export const FeedCard = ({
  note,
  dateValue,
  onOpen,
  lines,
}: {
  note: NoteView
  dateValue: string | null
  onOpen: (id: string) => void
  lines: number
}) => {
  const { ref, meta, loading, href, tags } = useCardPreview(note)
  const fields = useCardFields(note)
  const date = absoluteDate(dateValue)
  const tagBudget = Math.max(0, 4 - fields.length - (note.noteType ? 1 : 0))
  const summary = note.viewSummary?.status === 'ready' ? note.viewSummary : undefined
  const snippet = summary?.text ?? meta?.snippet
  return (
    <CardLink
      ref={ref}
      href={href}
      onOpen={() => onOpen(note.id)}
      className={cx(styles.feedCard, meta?.image && styles.hasImage)}
      testId="feed-item"
      dataId={note.id}
    >
      {/* c5 only (others hide it via CSS): a cover shimmer behind the title so the
          poster image doesn't pop in. Banner thumbs (c1/c3) aren't reserved —
          unknown image presence would jump more than it saves. */}
      {loading && <Skeleton className="feed-thumb-skeleton" />}
      {meta?.image && <img className={styles.feedThumb} {...thumbProps(meta.image)} />}
      <span className={styles.feedBody}>
        <span className={styles.feedRowTitle}>{note.title}</span>
        {!summary && loading ? (
          <SkeletonText className="feed-snippet-skeleton" lines={lines} />
        ) : (
          snippet && <span className={styles.feedSnippet}>{snippet}</span>
        )}
      </span>
      {(fields.length > 0 || date || note.noteType || tags.length > 0 || loading) && (
        <span className={styles.feedChips}>
          <DateChip date={date} />
          <TypeChip noteType={note.noteType} />
          <FieldChips fields={fields} />
          {loading ? (
            <Skeleton className="feed-chip-skeleton" />
          ) : (
            <TagChips tags={tags} max={tagBudget} itemClassName={styles.feedTag} />
          )}
        </span>
      )}
    </CardLink>
  )
}

// Timeline row (List view): a two-column row split by a continuous vertical spine
// — a left gutter holds the row's date and (if any) a thumbnail, the right column
// holds title + tags + snippet. Because the image lives in the gutter, the title
// always starts at the same x whether or not a note has an image — no placeholder
// needed. The snippet is a plain line-clamp box (no float), sidestepping the
// list's old float-vs-clamp dance entirely.
// `withRule` replaces the old `.feed-tl-row + .feed-tl-row` sibling selector:
// virtualized rows are absolutely positioned, so "am I first in my run" is
// computed from indices, not DOM adjacency.
export const FeedTimelineRow = ({
  note,
  dateValue,
  onOpen,
  lines,
  showDate,
  withRule,
}: {
  note: NoteView
  dateValue: string | null
  onOpen: (id: string) => void
  lines: number
  showDate: boolean
  withRule: boolean
}) => {
  const { ref, meta, loading, href, tags } = useCardPreview(note)
  const fields = useCardFields(note)
  const date = absoluteDate(dateValue)
  const tagBudget = Math.max(0, 4 - fields.length - (note.noteType ? 1 : 0))
  const summary = note.viewSummary?.status === 'ready' ? note.viewSummary : undefined
  const snippet = summary?.text ?? meta?.snippet
  return (
    <CardLink
      ref={ref}
      href={href}
      onOpen={() => onOpen(note.id)}
      className={cx(styles.feedTlRow, withRule && styles.withRule)}
      testId="feed-item"
      dataId={note.id}
    >
      <div className={styles.feedTlGutter}>
        {showDate && <DateChip date={date} />}
        {meta?.image && <img className={styles.feedTlThumb} {...thumbProps(meta.image)} />}
      </div>
      <div className={styles.feedTlMain}>
        <div className={styles.feedTlHead}>
          <span className={styles.feedTlTitle}>{note.title}</span>
          <span className={styles.feedTlTags}>
            <TypeChip noteType={note.noteType} />
            <FieldChips fields={fields} />
            {loading ? (
              <Skeleton className="feed-chip-skeleton" />
            ) : (
              <TagChips tags={tags} max={tagBudget} itemClassName={styles.feedTag} />
            )}
          </span>
        </div>
        {!summary && loading ? (
          <SkeletonText className="feed-snippet-skeleton" lines={lines} />
        ) : (
          snippet && <span className={cx(styles.feedSnippet, styles.feedTlSnippet)}>{snippet}</span>
        )}
      </div>
    </CardLink>
  )
}

// A timeline row whose page hasn't arrived yet (the virtualizer scrolled into
// an unfetched window): same two-column geometry, shimmer instead of content.
export const FeedTimelineGhostRow = ({ lines, withRule }: { lines: number; withRule: boolean }) => (
  <div className={cx(styles.feedTlRow, withRule && styles.withRule)} data-testid="feed-ghost">
    <div className={styles.feedTlGutter}>
      <Skeleton className="feed-chip-skeleton" />
    </div>
    <div className={styles.feedTlMain}>
      <div className={styles.feedTlHead}>
        <span className={cx(styles.feedTlTitle, styles.feedTlTitleGhost)}>
          <Skeleton className="feed-chip-skeleton" />
        </span>
      </div>
      <SkeletonText className="feed-snippet-skeleton" lines={Math.min(lines, 3)} />
    </div>
  </div>
)

// A grid tile whose page hasn't arrived yet: same card chrome, shimmer content.
// Always a 1-row text tile — an unknown image can't reserve a 2-row span
// honestly, and under-reserving re-packs less than over-reserving.
export const FeedGhostCard = ({ lines }: { lines: number }) => (
  <div className={styles.feedCard} data-testid="feed-ghost">
    <span className={styles.feedBody}>
      <span className={styles.feedRowTitle}>
        <Skeleton w="62%" h={13} radius={4} />
      </span>
      <SkeletonText className="feed-snippet-skeleton" lines={Math.min(lines, 4)} />
    </span>
    <span className={styles.feedChips}>
      <Skeleton className="feed-chip-skeleton" />
    </span>
  </div>
)

// First feed load (total unknown yet): a non-virtualized screenful of ghosts in
// the layout the real feed will take — grid tiles or timeline rows — instead of
// a "Loading…" line (#68 item 5). Reuses the same ghost components the virtualized
// scroll already shows for unfetched windows, so the first paint matches them.
export const FeedLoadingSkeleton = ({
  view,
  cols,
  mobile,
}: {
  view: FeedState['view']
  cols: FeedCols
  mobile: boolean
}) => {
  const timeline = view === 'list' && !mobile
  const lines = mobile ? LINES[FEED_COLS.medium] : LINES[cols]

  if (timeline) {
    return (
      <div
        className={cx(styles.feedTimeline, styles[`feed-timeline-c${cols}`])}
        style={{ '--lines': lines } as CSSProperties}
        data-testid="feed-loading"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <FeedTimelineGhostRow key={i} lines={lines} withRule={i > 0} />
        ))}
      </div>
    )
  }
  const cls = mobile
    ? cx(styles.feedGrid, styles.feedGridMobile)
    : cx(styles.feedGrid, styles[`feed-grid-c${cols}`])
  return (
    <div className={cls} style={{ '--lines': lines } as CSSProperties} data-testid="feed-loading">
      {Array.from({ length: mobile ? 6 : 12 }, (_, i) => (
        <FeedGhostCard key={i} lines={lines} />
      ))}
    </div>
  )
}
