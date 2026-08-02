import type { TagFacet } from '@notarium/contract'
import { NOTE_SORT } from '@notarium/contract/enums'
import { DatePicker } from '../../core/DatePicker'
import { IconStar, IconStarFilled, IconX } from '../../core/Icons'
import { MiniStat } from '../../core/MiniStat'
import { FolderFilter } from '../FolderFilter'
import { TagFilter } from '../TagFilter'
import styles from './FeedAside.module.scss'

// Contextual aside for the Feed page: a couple of mini-stats, the shared folder
// FILTER (#93/#13) and the tag facet (#109). The FolderFilter widget owns the head,
// the FolderTree facet and the right-click menu (Show only this folder · Include/
// Exclude · Clear), so the Feed and the Memory filter share one assembly and can't drift. The
// selected-folder set is lifted in useFeedState (inclusion, subtree-cascading),
// shared with the page so the header reset and the data window stay in lockstep. The
// tag facet is the second navigation axis below it — the same inclusion language
// (`?tag=`), fed by the server's tag index (no longer "tags live only on the cards").
type FeedFolderNode = { name: string; path: string; count: number; children: FeedFolderNode[] }

type FeedAsideBinding = {
  sort: 'created' | 'modified'
  stats: { total: number; week: number }
  folders: FeedFolderNode[]
  selected: Set<string>
  toggleFolder: (path: string) => void
  soloFolder: (path: string) => void
  resetFolders: () => void
  tagFacet: TagFacet[]
  tagSet: Set<string>
  toggleTag: (tag: string) => void
  clearTags: () => void
  dateFrom: string
  dateTo: string
  setDateFrom: (value: string) => void
  setDateTo: (value: string) => void
  clearDateRange: () => void
  favorite: boolean
  setFavorite: (next: boolean) => void
  favoriteCount: number
}

export const FeedAside = ({ feed }: { feed: FeedAsideBinding }) => {
  const {
    sort,
    stats,
    folders,
    selected,
    toggleFolder,
    soloFolder,
    resetFolders,
    tagFacet,
    tagSet,
    toggleTag,
    clearTags,
    dateFrom,
    dateTo,
    setDateFrom,
    setDateTo,
    clearDateRange,
    favorite,
    setFavorite,
    favoriteCount,
  } = feed
  const dateActive = Boolean(dateFrom || dateTo)
  const dateTitle = sort === NOTE_SORT.created ? 'Created date' : 'Modified date'
  return (
    <div className={styles.feedAside}>
      <div className={styles.feedStats}>
        <MiniStat value={stats.total} label="notes" />
        <MiniStat value={stats.week} label="this week" />
      </div>

      <div className={styles.favoriteFacet}>
        <button
          className={styles.favoriteToggle}
          type="button"
          aria-pressed={favorite}
          onClick={() => setFavorite(!favorite)}
          data-testid="feed-favorite-filter"
        >
          {favorite ? <IconStarFilled size={14} /> : <IconStar size={14} />}
          <span>Favorites</span>
          <span className={styles.favoriteCount}>{favoriteCount}</span>
        </button>
      </div>

      <FolderFilter
        title="Folders"
        noun="folder"
        nodes={folders}
        isSelected={(p) => selected.has(p)}
        onToggle={toggleFolder}
        onSolo={soloFolder}
        onReset={resetFolders}
        selectedCount={selected.size}
        testId="feed-folder-filter"
      />

      <TagFilter
        tags={tagFacet}
        selected={tagSet}
        onToggle={toggleTag}
        onClear={clearTags}
        testId="feed-tag-filter"
      />

      <div className={styles.dateFilter} data-testid="feed-date-filter">
        <div className={styles.dateHead}>
          {dateTitle}
          <button
            className="gf-section-reset"
            onClick={clearDateRange}
            disabled={!dateActive}
            title="Clear date filter"
            aria-label="Clear date filter"
            data-testid="feed-date-filter-reset"
          >
            <IconX size={13} />
          </button>
        </div>
        <div className={styles.dateGrid}>
          <div className={styles.dateField}>
            <span className={styles.dateLabel}>From</span>
            <DatePicker
              value={dateFrom}
              onChange={setDateFrom}
              max={dateTo || undefined}
              placeholder="Any date"
              aria-label="From date"
              data-testid="feed-date-from"
            />
          </div>
          <div className={styles.dateField}>
            <span className={styles.dateLabel}>To</span>
            <DatePicker
              value={dateTo}
              onChange={setDateTo}
              min={dateFrom || undefined}
              placeholder="Any date"
              aria-label="To date"
              data-testid="feed-date-to"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
