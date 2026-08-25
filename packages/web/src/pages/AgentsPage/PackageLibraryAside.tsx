import { useEffect, useState } from 'react'
import type { AgentPackageLibraryFacets } from '@notarium/contract'
import { AsideSection, AsideSections } from '../../core/AsidePanel'
import { IconX } from '../../core/Icons'
import { SearchField } from '../../core/SearchField'
import { Segmented } from '../../core/Segmented'
import { FolderTree } from '../../widgets/FolderTree'
import {
  PACKAGE_LIBRARY_AVAILABILITIES,
  PACKAGE_LIBRARY_HOMES,
  PACKAGE_LIBRARY_SOURCES,
  type PackageLibraryAvailability,
  type PackageLibraryHome,
  type PackageLibraryPatch,
  type PackageLibrarySource,
  type PackageLibraryState,
} from './packageLibraryState'
import styles from './PackageLibraryAside.module.scss'

const QUERY_DEBOUNCE_MS = 300
const NO_EXPANDED_PROJECTS = new Set<string>()
type SourceFilter = PackageLibrarySource | 'any'
type HomeFilter = PackageLibraryHome | 'any'
type AvailabilityFilter = PackageLibraryAvailability | 'any'
// Captions only: the VALUES are the filter's own vocabulary, offered in its order.
// Exhaustive by type, so a value the URL learns to accept cannot reach the control
// without a word for it.
const SOURCE_LABELS: Record<PackageLibrarySource, string> = {
  owned: 'Mine',
  system: 'System',
  catalog: 'Catalog',
}
const HOME_LABELS: Record<PackageLibraryHome, string> = {
  personal: 'Personal',
  space: 'Space',
}
const AVAILABILITY_LABELS: Record<PackageLibraryAvailability, string> = {
  all: 'All projects',
  selected: 'Selected',
}

const Reset = ({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean
  onClick: () => void
  label: string
}) => (
  <button
    type="button"
    className="gf-section-reset"
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
  >
    <IconX size={13} />
  </button>
)

export const PackageLibraryFilters = ({
  state,
  facets,
  onChange,
}: {
  state: PackageLibraryState
  facets: AgentPackageLibraryFacets | null
  onChange: (patch: PackageLibraryPatch) => void
}) => {
  const [query, setQuery] = useState(state.q ?? '')

  useEffect(() => {
    setQuery(state.q ?? '')
  }, [state.q])

  useEffect(() => {
    const next = query.trim()

    if (next === (state.q ?? '')) {
      return undefined
    }
    const timeout = setTimeout(() => onChange({ q: next || null }), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [onChange, query, state.q])

  const projectAvailable =
    !state.project || facets?.projects.some(({ project }) => project.handle === state.project)

  return (
    <AsideSections testId="package-library-filters">
      <AsideSection
        heading="Search"
        action={
          <Reset
            disabled={!query && !state.q}
            onClick={() => {
              setQuery('')
              onChange({ q: null })
            }}
            label="Clear package search"
          />
        }
      >
        <SearchField
          value={query}
          onChange={setQuery}
          onClear={() => {
            setQuery('')
            onChange({ q: null })
          }}
          placeholder="Name or description"
          inputProps={{ 'aria-label': 'Search packages', 'data-testid': 'package-library-search' }}
        />
      </AsideSection>

      <AsideSection
        heading="Source"
        action={
          <Reset
            disabled={!state.source}
            onClick={() => onChange({ source: null })}
            label="Clear source filter"
          />
        }
      >
        <Segmented<SourceFilter>
          block
          value={state.source ?? 'any'}
          onChange={(source) => onChange({ source: source === 'any' ? null : source })}
          ariaLabel="Package source"
          options={[
            { value: 'any', label: 'All' },
            ...PACKAGE_LIBRARY_SOURCES.map((value) => ({
              value,
              label: SOURCE_LABELS[value],
              title: `${facets?.source[value] ?? 0} ${value}`,
            })),
          ]}
        />
      </AsideSection>

      <AsideSection
        heading="Home"
        action={
          <Reset
            disabled={!state.home}
            onClick={() => onChange({ home: null })}
            label="Clear home filter"
          />
        }
      >
        <Segmented<HomeFilter>
          block
          value={state.home ?? 'any'}
          onChange={(home) => onChange({ home: home === 'any' ? null : home })}
          ariaLabel="Package home"
          options={[
            { value: 'any', label: 'All' },
            ...PACKAGE_LIBRARY_HOMES.map((value) => ({ value, label: HOME_LABELS[value] })),
          ]}
        />
      </AsideSection>

      <AsideSection
        heading="Available in"
        action={
          <Reset
            disabled={!state.availability}
            onClick={() => onChange({ availability: null })}
            label="Clear availability filter"
          />
        }
      >
        <Segmented<AvailabilityFilter>
          block
          value={state.availability ?? 'any'}
          onChange={(availability) =>
            onChange({ availability: availability === 'any' ? null : availability })
          }
          ariaLabel="Project availability"
          options={[
            { value: 'any', label: 'Any' },
            ...PACKAGE_LIBRARY_AVAILABILITIES.map((value) => ({
              value,
              label: AVAILABILITY_LABELS[value],
            })),
          ]}
        />
      </AsideSection>

      {(facets?.projects.length || state.project) && (
        <AsideSection
          heading="Project"
          testId="package-library-project-filter"
          action={
            <Reset
              disabled={!state.project}
              onClick={() => onChange({ project: null })}
              label="Clear project filter"
            />
          }
        >
          {!projectAvailable && (
            <p className={styles.unavailable}>The selected project is no longer available.</p>
          )}
          {facets && facets.projects.length > 0 && (
            <FolderTree
              nodes={facets.projects.map(({ project, count }) => ({
                name: project.displayName,
                path: project.handle,
                count,
                children: [],
              }))}
              expanded={NO_EXPANDED_PROJECTS}
              onToggleExpand={() => {}}
              isSelected={(project) => state.project === project}
              onToggle={(project) =>
                onChange({ project: state.project === project ? null : project })
              }
              swatch={false}
            />
          )}
        </AsideSection>
      )}
    </AsideSections>
  )
}
