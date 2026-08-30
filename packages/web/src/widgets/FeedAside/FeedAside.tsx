import type { FieldDeclaration, FieldFacet, TagFacet } from '@notarium/contract'
import { FIELD_TYPE, NOTE_SORT } from '@notarium/contract/enums'
import { fieldValueMatchesType } from '@notarium/core'
import { DatePicker } from '../../core/DatePicker'
import { FacetChip } from '../../core/FacetChip'
import { IconStar, IconStarFilled, IconX } from '../../core/Icons'
import { MiniStat } from '../../core/MiniStat'
import { fieldDate } from '../../libs/datetime'
import { fieldDisplayName, fieldEnumOptionDisplayName } from '../../libs/fields'
import { FolderFilter } from '../FolderFilter'
import { TagFilter } from '../TagFilter'
import styles from './FeedAside.module.scss'

// Contextual aside for the Feed page: a couple of mini-stats, the shared folder
// FILTER (#93/#13) and the tag facet (#109). The FolderFilter widget owns the head,
// the FolderTree facet and the right-click menu (Show only this folder · Include/
// Exclude · Clear), so the Feed and the Memory filter share one assembly and can't drift. The
// selected-folder set is lifted in useFeedState (inclusion, subtree-cascading),
// shared with the page so the header reset and the data window stay in lockstep. The
// tag and field facets sit below it and drive the same server-side window as the page.
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
  fieldFacet: FieldFacet[]
  fieldFacetTruncated: boolean
  fieldDeclarations: FieldDeclaration[]
  isFieldSelected: (key: string, value: string) => boolean
  isFieldDaySelected: (key: string, day: string) => boolean
  isFieldActive: (key: string) => boolean
  toggleField: (key: string, value: string) => void
  toggleFieldDay: (key: string, day: string) => void
  clearField: (key: string) => void
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
    fieldFacet,
    fieldFacetTruncated,
    fieldDeclarations,
    isFieldSelected,
    isFieldDaySelected,
    isFieldActive,
    toggleField,
    toggleFieldDay,
    clearField,
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
  const declarations = new Map(fieldDeclarations.map((field) => [field.key, field]))
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

      {(fieldFacet.length > 0 || fieldFacetTruncated) && (
        <div className={styles.fieldFacets} data-testid="feed-field-filter">
          {fieldFacet.map((field) => {
            const declaration = declarations.get(field.key)
            const fieldLabel = declaration ? fieldDisplayName(declaration) : field.key
            return (
              <div className={styles.fieldFacet} key={field.key}>
                <div className={styles.fieldHead} title={fieldLabel}>
                  {fieldLabel}
                  <button
                    className="gf-section-reset"
                    onClick={() => clearField(field.key)}
                    disabled={!isFieldActive(field.key)}
                    title={`Clear ${fieldLabel} filter`}
                    aria-label={`Clear ${fieldLabel} filter`}
                    data-testid={`feed-field-filter-${field.key}-reset`}
                  >
                    <IconX size={13} />
                  </button>
                </div>
                {field.values.length > 0 ? (
                  <div className={styles.fieldValues}>
                    {field.values.map((value) => {
                      const dateValue =
                        declaration?.type === FIELD_TYPE.date &&
                        fieldValueMatchesType(declaration.type, value.value, declaration)
                      const active = dateValue
                        ? isFieldDaySelected(field.key, value.value)
                        : isFieldSelected(field.key, value.value)
                      const option = declaration?.values?.find(
                        (candidate) => candidate.key === value.value,
                      )
                      const label = option
                        ? fieldEnumOptionDisplayName(option)
                        : declaration?.type === FIELD_TYPE.date &&
                            fieldValueMatchesType(declaration.type, value.value, declaration)
                          ? fieldDate(value.value) || value.value
                          : value.value || 'empty'
                      const color = option?.color
                      return (
                        <FacetChip
                          key={value.value}
                          label={label}
                          count={value.count}
                          color={color}
                          selected={active}
                          onClick={() =>
                            dateValue
                              ? toggleFieldDay(field.key, value.value)
                              : toggleField(field.key, value.value)
                          }
                          ariaLabel={`${fieldLabel}: ${label}, ${value.count} ${value.count === 1 ? 'note' : 'notes'}`}
                          title={`${fieldLabel}: ${label}`}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <div className={styles.fieldEmpty}>No values yet</div>
                )}
              </div>
            )
          })}
          {fieldFacetTruncated && (
            <div className={styles.fieldEmpty}>More open fields are available</div>
          )}
        </div>
      )}

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
              onClear={() => setDateFrom('')}
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
              onClear={() => setDateTo('')}
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
