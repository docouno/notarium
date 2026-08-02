import { useEffect, useRef, useState } from 'react'
import { BUCKET_GRAN, NOTE_SORT } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import {
  IconChevron,
  IconDensityL,
  IconDensityM,
  IconDensityS,
  IconFeed,
  IconLayers,
  IconList,
} from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { StateView } from '../../core/StateView'
import { useDismiss } from '../../libs/hooks/useDismiss'
import { useElementWidth } from '../../libs/hooks/useElementWidth'
import type { NoteView } from '../../libs/wire'
import { FEED_COLS, type FeedState } from '../FeedProvider'
import { LINES } from './consts'
import { FeedLoadingSkeleton } from './FeedItems'
import { FeedVirtualGrid, FeedVirtualGroupedGrid, FeedVirtualTimeline } from './FeedVirtualizers'
import styles from './FeedView.module.scss'

// The Feed page: a personal feed of documents. Controls (Sort / View / Group)
// and the folder filter are owned by the lifted useFeed state (shared with
// the aside facets). Rows/cards are real <a href> so middle/Ctrl-click opens a
// new tab while a plain click navigates in-app.
export const FeedView = ({ feed, onOpen }: { feed: FeedState; onOpen: (id: string) => void }) => {
  const {
    sort,
    setSort,
    view,
    setView,
    cols,
    setCols,
    group,
    setGroup,
    selected,
    tags,
    resetFolders,
    q,
    clearFilters,
    dateFrom,
    dateTo,
    total,
    buckets,
    bucketsGroup,
    loading,
    error,
    loaded,
  } = feed
  // A filter is active when any Feed filter axis narrows the window (#109/#190/#201),
  // so a dead-end can offer one escape even when the aside is collapsed.
  const filtered = selected.size > 0 || tags.length > 0 || Boolean(q || dateFrom || dateTo)
  const dateOf = (n: NoteView): string | null =>
    sort === NOTE_SORT.created ? n.createdAt : n.modifiedAt

  // Collapse the controls into a dropdown when the content area is too narrow to
  // lay them out in a row — measured with ResizeObserver, so it reacts to the
  // sidebar/aside opening too, not just window resizes.
  const headRef = useRef<HTMLElement>(null)
  const width = useElementWidth(headRef)
  // Threshold tracks the inline controls' natural width: the Group+Sort+Size+View
  // row is ~568px, plus the icon+title+gaps (~91px) on the left ≈ 660px to fit on
  // one line. Below that they'd wrap (flex-wrap) instead of collapsing, so fold
  // into the dropdown a touch earlier. ⚠️ Re-measure & bump if you add/remove a
  // control (this is why the Size toggle broke the old 560 value).
  const compact = width > 0 && width < 680
  // Mobile: too narrow for multiple cards across or a meaningful list/grid choice.
  // We drop the Size + View toggles entirely and force ONE simplified layout — a
  // single-column card stack with a moderate (not hero-tall) banner — regardless
  // of the stored view/cols (those are left untouched, so they restore on desktop).
  const mobile = width > 0 && width < 560
  // List view renders as the two-column timeline (desktop only — mobile forces the
  // single-column card layout below).
  const timeline = view === 'list' && !mobile

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  // Close the Options dropdown on an outside click or Escape (the trigger button is
  // `inside`, so it toggles instead of this reopening it). Only listens while open.
  useDismiss(menuOpen, () => setMenuOpen(false), { inside: [menuRef, menuBtnRef] })
  // Leaving compact mode removes the dropdown entirely — close it so it can't linger.
  useEffect(() => {
    if (!compact) {
      setMenuOpen(false)
    }
  }, [compact])

  // Order: Group → Sort → View.
  const groupSeg = (
    <Segmented
      value={group}
      onChange={setGroup}
      options={[
        { value: 'off', label: 'None', title: 'No grouping' },
        { value: BUCKET_GRAN.day, label: 'Day' },
        { value: BUCKET_GRAN.week, label: 'Week' },
        { value: BUCKET_GRAN.month, label: 'Month' },
      ]}
    />
  )
  const sortSeg = (
    <Segmented
      value={sort}
      onChange={setSort}
      options={[
        { value: NOTE_SORT.created, label: 'Created' },
        { value: NOTE_SORT.modified, label: 'Modified' },
      ]}
    />
  )
  const viewSeg = (
    <Segmented
      value={view}
      onChange={setView}
      options={[
        { value: 'list', icon: <IconList size={15} />, title: 'List' },
        { value: 'grid', icon: <IconLayers size={15} />, title: 'Grid' },
      ]}
    />
  )
  // Size toggle: how much each item shows — snippet length (2 / 6 / 12 lines) in
  // both views, and additionally the column count in Grid (fewer columns = bigger
  // cards). Shown in both views, to the left of the view toggle. Ordered small →
  // large (left → right), so the biggest option sits on the right and the icons
  // grow rightward — matches the intuitive "more = further right".
  const sizeSeg = (
    <Segmented
      value={cols}
      onChange={setCols}
      options={[
        {
          value: FEED_COLS.small,
          icon: <IconDensityS size={15} />,
          title: view === 'grid' ? 'Small (5 columns, 2 lines)' : 'Small (2 lines)',
        },
        {
          value: FEED_COLS.medium,
          icon: <IconDensityM size={15} />,
          title: view === 'grid' ? 'Medium (3 columns, 6 lines)' : 'Medium (6 lines)',
        },
        {
          value: FEED_COLS.large,
          icon: <IconDensityL size={15} />,
          title: view === 'grid' ? 'Large (1 column, 12 lines)' : 'Large (12 lines)',
        },
      ]}
    />
  )

  return (
    <div className={styles.feedPage}>
      <header className={styles.feedHead} ref={headRef}>
        <span className={styles.feedHeadIcon}>
          <IconFeed size={20} />
        </span>
        <h1 className={styles.feedTitle}>Feed</h1>
        {compact ? (
          <div className={styles.feedControlsCompact}>
            <Button
              ref={menuBtnRef}
              variant="ghost"
              active={menuOpen}
              className={styles.feedControlsBtn}
              onClick={() => setMenuOpen((o) => !o)}
            >
              Options <IconChevron size={13} className={menuOpen ? styles.open : ''} />
            </Button>
            {menuOpen && (
              <div className={styles.feedControlsMenu} ref={menuRef}>
                <div className={styles.feedCgroup}>
                  <span className={styles.feedCgroupLabel}>Group</span>
                  {groupSeg}
                </div>
                <div className={styles.feedCgroup}>
                  <span className={styles.feedCgroupLabel}>Sort</span>
                  {sortSeg}
                </div>
                {!mobile && (
                  <div className={styles.feedCgroup}>
                    <span className={styles.feedCgroupLabel}>Size</span>
                    {sizeSeg}
                  </div>
                )}
                {!mobile && (
                  <div className={styles.feedCgroup}>
                    <span className={styles.feedCgroupLabel}>View</span>
                    {viewSeg}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className={styles.feedControls}>
            {groupSeg}
            {sortSeg}
            {!mobile && sizeSeg}
            {!mobile && viewSeg}
          </div>
        )}
      </header>

      {/* No header chips for the active filters (#109): folder and tag filters both
          read off the aside now — selected tag chips are accented there, folders
          dim — the app's one filter language. The Feed content area shows only
          notes; nothing custom floats above the cards (it used to, and clashed with
          how every other filter surface reads). */}

      {/* A feed-load error no longer blanks the feed (#65). If we already have
          cards, a failed refresh shows as a non-blocking notice and the cards
          stay; only an error with NOTHING to show takes over the area. */}
      {error && (total ?? 0) > 0 && (
        <div className={styles.feedNotice}>
          <Notice variant="error" data-testid="feed-refresh-error">
            Couldn’t refresh the feed: {error}
          </Notice>
        </div>
      )}

      {error && (total ?? 0) === 0 && (
        <StateView
          tone="error"
          code="Error"
          icon={<IconFeed size={30} />}
          title="Couldn’t load the feed"
          description={error}
          testId="feed-error"
        />
      )}

      {!error && loading && !loaded && (
        <FeedLoadingSkeleton view={view} cols={cols} mobile={mobile} />
      )}

      {!error && loaded && total === 0 && (
        <div className={styles.feedEmpty}>
          <EmptyState
            icon={<IconFeed size={26} />}
            title={
              filtered
                ? 'No notes match the filter'
                : sort === NOTE_SORT.created
                  ? 'Nothing created in the last year'
                  : 'No notes yet'
            }
            hint={
              filtered
                ? 'No notes match the selected filters.'
                : sort === NOTE_SORT.created
                  ? 'Switch to Modified to see older notes.'
                  : 'Create your first note and it shows up here.'
            }
            // With the aside collapsed there's no other clear in view (the active
            // filters show in the panel, not over the content) — so a filtered
            // dead-end carries its own escape.
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    resetFolders()
                    clearFilters()
                  }}
                  data-testid="feed-empty-clear"
                >
                  Clear filters
                </Button>
              ) : undefined
            }
            testId="feed-empty"
          />
        </div>
      )}

      {(total ?? 0) > 0 && (
        <>
          {timeline ? (
            <FeedVirtualTimeline
              feed={feed}
              dateOf={dateOf}
              onOpen={onOpen}
              lines={LINES[cols]}
              cols={cols}
              // Per-row dates are redundant under day grouping (the header already is
              // the day); keep them for week/month (they reveal the exact day) and off.
              // Track the RENDERED grouping (bucketsGroup), not the selected one.
              showDate={bucketsGroup !== BUCKET_GRAN.day}
            />
          ) : bucketsGroup !== 'off' && buckets ? (
            <FeedVirtualGroupedGrid
              feed={feed}
              dateOf={dateOf}
              onOpen={onOpen}
              cols={cols}
              mobile={mobile}
            />
          ) : (
            // No grouping rendered yet — group=off, or the grouped grid's honest
            // fallback until the histogram for the selected grouping lands: ungrouped
            // block virtualization.
            <FeedVirtualGrid
              feed={feed}
              dateOf={dateOf}
              onOpen={onOpen}
              cols={cols}
              mobile={mobile}
            />
          )}
        </>
      )}
    </div>
  )
}
