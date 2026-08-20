import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router'
import type { AgentPackageLibraryFacets } from '@notarium/contract'
import type { AsidePanelDef } from '../../core/AsideGroups'
import { agentsSurfaceOf } from '../../libs/routing/routePaths'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import { AgentsPanel } from './AgentsPanel'
import { PackageLibraryFilters } from './PackageLibraryAside'
import {
  canonicalPackageLibraryParams,
  type PackageLibraryPatch,
  type PackageLibraryState,
  patchPackageLibraryState,
  readPackageLibraryState,
} from './packageLibraryState'

const PACKAGE_LIBRARY_LAYOUT = [{ panels: ['filters'], activeTab: 'filters' }]
export type PackageLibraryKind = 'roles' | 'skills'

type PackageLibraryFrameContext = {
  state: PackageLibraryState
  setState: (patch: PackageLibraryPatch) => void
  reportFacets: (kind: PackageLibraryKind, facets: AgentPackageLibraryFacets | null) => void
}

export const usePackageLibraryFrame = (): PackageLibraryFrameContext =>
  useOutletContext<PackageLibraryFrameContext>()

/** Shared route shell for Roles and Skills. Switching the left rail keeps the
 *  discovery state and system aside alive while only the package page changes. */
export const PackageLibraryFrame = () => {
  const location = useLocation()
  const surface = agentsSurfaceOf(location.pathname)
  const kind: PackageLibraryKind = surface?.abilityKind ?? 'roles'
  const libraryIndex = surface?.abilityIndex === true
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useMemo(() => readPackageLibraryState(searchParams), [searchParams])
  const [reported, setReported] = useState<{
    kind: PackageLibraryKind
    facets: AgentPackageLibraryFacets | null
  } | null>(null)
  useEffect(() => {
    const canonical = canonicalPackageLibraryParams(searchParams)

    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const setState = useCallback(
    (patch: PackageLibraryPatch) => {
      setSearchParams(patchPackageLibraryState(searchParams, patch), { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const reportFacets = useCallback(
    (reportedKind: PackageLibraryKind, facets: AgentPackageLibraryFacets | null) => {
      setReported({ kind: reportedKind, facets })
    },
    [],
  )

  const facets = reported?.kind === kind ? reported.facets : null
  const panels: AsidePanelDef[] = [
    {
      id: 'filters',
      label: 'Filters',
      render: () => <PackageLibraryFilters state={state} facets={facets} onChange={setState} />,
    },
  ]
  return (
    <>
      <Outlet context={{ state, setState, reportFacets }} />
      {libraryIndex && (
        <AgentsPanel
          panels={panels}
          defaultLayout={PACKAGE_LIBRARY_LAYOUT}
          storageKey={STORAGE_KEYS.packageLibraryAsideGroups}
          label="library filters"
          modalLabel="Package library filters"
        />
      )}
    </>
  )
}
