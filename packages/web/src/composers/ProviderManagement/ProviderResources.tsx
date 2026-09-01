import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CredentialListItem,
  ModelCapability,
  ProviderEffectiveEntry,
  ProviderResource,
  ProviderResourceCreateRequest,
  ProviderResourceListItem,
  ProviderResourcePatchRequest,
  ProviderResourceResponse,
  ProviderStatus,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { errorText } from '../../libs/errors'
import { api, ApiError } from '../../services/api'
import {
  type ProviderResourceListEntry,
  ProviderResources as ProviderResourcesWidget,
} from '../../widgets/ProviderManagement'
import { useSpace } from '../SpaceProvider'

export const ProviderResources = () => {
  const { spaces } = useSpace()
  const [owned, setOwned] = useState<ProviderResourceListItem[] | null>(null)
  const [effective, setEffective] = useState<ProviderEffectiveEntry[] | null>(null)
  const [ownedNextCursor, setOwnedNextCursor] = useState<string | null>(null)
  const [effectiveNextCursor, setEffectiveNextCursor] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<CredentialListItem[]>([])
  const [credentialsNextCursor, setCredentialsNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<ProviderResourceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingMoreCredentials, setLoadingMoreCredentials] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [continuationError, setContinuationError] = useState<string | null>(null)
  const [credentialContinuationError, setCredentialContinuationError] = useState<string | null>(
    null,
  )
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusById, setStatusById] = useState<ReadonlyMap<string, 'checking' | 'error'>>(
    () => new Map(),
  )
  const [ownedStatusById, setOwnedStatusById] = useState<
    ReadonlyMap<string, ProviderStatus | null>
  >(() => new Map())
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const statusRequest = useRef(new Map<string, number>())
  const statusRequestKind = useRef(new Map<string, 'batch' | 'exact'>())
  const statusSequence = useRef(0)
  const inventoryRequest = useRef(0)

  const listItemOf = (resource: ProviderResource): ProviderResourceListItem => ({
    id: resource.id,
    name: resource.name,
    wire: resource.wire,
    owner: resource.owner,
    ...(resource.baseUrl === undefined ? {} : { baseUrl: resource.baseUrl }),
    addressIsPrivate: resource.addressIsPrivate,
    capabilities: ['completion', 'embedding'].filter((capability) =>
      resource.models.some((model) => model.capabilities.includes(capability as ModelCapability)),
    ) as ModelCapability[],
    modelCount: resource.models.length,
    hasCredentials: resource.hasCredentials,
    disabledAt: resource.disabledAt,
  })

  const upsertOwned = (item: ProviderResourceListItem) =>
    setOwned((current) => {
      if (!current) {
        return [item]
      }

      return current.some(({ id }) => id === item.id)
        ? current.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [item, ...current]
    })

  const entries = useMemo<ProviderResourceListEntry[] | null>(() => {
    if (!owned || !effective) {
      return null
    }
    const effectiveById = new Map(effective.map((entry) => [entry.resource.id, entry]))
    const rows = new Map<string, ProviderResourceListEntry>()

    for (const entry of effective) {
      rows.set(entry.resource.id, {
        ...entry,
        owned: entry.resource.owner.mine,
        statusState: statusById.get(entry.resource.id) ?? 'ready',
      })
    }
    for (const resource of owned) {
      const effectiveEntry = effectiveById.get(resource.id)
      const statusResolved = effectiveById.has(resource.id) || ownedStatusById.has(resource.id)

      rows.set(resource.id, {
        resource,
        owned: true,
        unusableBecause:
          effectiveEntry?.unusableBecause ?? ownedStatusById.get(resource.id) ?? null,
        statusState: statusById.get(resource.id) ?? (statusResolved ? 'ready' : 'checking'),
      })
    }

    return [...rows.values()]
  }, [effective, owned, ownedStatusById, statusById])

  const hydrateOwnedStatuses = useCallback(
    async (ids: readonly string[], inventory: number): Promise<void> => {
      if (ids.length === 0 || inventoryRequest.current !== inventory) {
        return
      }
      const request = ++statusSequence.current

      for (const id of ids) {
        statusRequest.current.set(id, request)
        statusRequestKind.current.set(id, 'batch')
      }
      setStatusById((current) => {
        const next = new Map(current)

        for (const id of ids) {
          next.set(id, 'checking')
        }

        return next
      })
      try {
        const response = await api.providerResourceStatuses(ids)

        if (inventoryRequest.current !== inventory) {
          return
        }
        const received = new Map(response.items.map((item) => [item.id, item.unusableBecause]))
        const omitted = ids.some(
          (id) => statusRequest.current.get(id) === request && !received.has(id),
        )
        setOwnedStatusById((current) => {
          const next = new Map(current)

          for (const id of ids) {
            if (statusRequest.current.get(id) === request && received.has(id)) {
              next.set(id, received.get(id) ?? null)
            }
          }

          return next
        })
        setStatusById((current) => {
          const next = new Map(current)

          for (const id of ids) {
            if (statusRequest.current.get(id) !== request) {
              continue
            }
            if (received.has(id)) {
              next.delete(id)
            } else {
              next.set(id, 'error')
            }
          }

          return next
        })
        if (omitted) {
          setStatusError('Some provider statuses are unavailable.')
        }
      } catch (cause) {
        if (inventoryRequest.current !== inventory) {
          return
        }
        setStatusById((current) => {
          const next = new Map(current)

          for (const id of ids) {
            if (statusRequest.current.get(id) === request) {
              next.set(id, 'error')
            }
          }

          return next
        })
        if (ids.some((id) => statusRequest.current.get(id) === request)) {
          setStatusError(errorText(cause))
        }
      }
    },
    [],
  )

  const load = useCallback(async () => {
    const inventory = ++inventoryRequest.current

    setLoading(true)
    try {
      const [ownedPage, effectivePage, credentialPage] = await Promise.all([
        api.providerResourcesGet(),
        api.providerEffectiveGet(),
        api.credentialsGet(),
      ])

      if (inventoryRequest.current !== inventory) {
        return
      }
      const effectiveIds = new Set(effectivePage.items.map(({ resource }) => resource.id))
      const missingOwnedIds = ownedPage.items
        .map(({ id }) => id)
        .filter((id) => !effectiveIds.has(id))

      statusRequest.current.clear()
      statusRequestKind.current.clear()
      setOwned(ownedPage.items)
      setEffective(effectivePage.items)
      setOwnedNextCursor(ownedPage.nextCursor)
      setEffectiveNextCursor(effectivePage.nextCursor)
      setCredentials(credentialPage.items)
      setCredentialsNextCursor(credentialPage.nextCursor)
      setError(null)
      setContinuationError(null)
      setCredentialContinuationError(null)
      setStatusById(new Map())
      setOwnedStatusById(new Map())
      setStatusError(null)
      void hydrateOwnedStatuses(missingOwnedIds, inventory)
    } catch (cause) {
      if (inventoryRequest.current === inventory) {
        setError(errorText(cause))
      }
    } finally {
      if (inventoryRequest.current === inventory) {
        setLoading(false)
      }
    }
  }, [hydrateOwnedStatuses])

  const mergeResources = (
    current: ProviderResourceListItem[] | null,
    page: ProviderResourceListItem[],
  ) => {
    const byId = new Map((current ?? []).map((item) => [item.id, item]))

    for (const item of page) {
      byId.set(item.id, item)
    }

    return [...byId.values()]
  }

  const mergeEffective = (
    current: ProviderEffectiveEntry[] | null,
    page: ProviderEffectiveEntry[],
  ) => {
    const byId = new Map((current ?? []).map((item) => [item.resource.id, item]))

    for (const item of page) {
      byId.set(item.resource.id, item)
    }

    return [...byId.values()]
  }

  const setResourceStatus = (id: string, status: 'checking' | 'error' | null) =>
    setStatusById((current) => {
      const next = new Map(current)

      if (status) {
        next.set(id, status)
      } else {
        next.delete(id)
      }

      return next
    })

  const refreshEffective = async (id: string): Promise<void> => {
    const request = ++statusSequence.current
    statusRequest.current.set(id, request)
    statusRequestKind.current.set(id, 'exact')
    setResourceStatus(id, 'checking')
    setStatusError(null)
    try {
      const entry = await api.providerEffectiveDetail(id)

      if (statusRequest.current.get(id) !== request) {
        return
      }
      setOwnedStatusById((current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      })
      setEffective((current) => mergeEffective(current, [entry]))
      setResourceStatus(id, null)
    } catch (cause) {
      if (statusRequest.current.get(id) === request) {
        setResourceStatus(id, 'error')
        setStatusError(errorText(cause))
      }
    }
  }

  const loadMore = async () => {
    if ((!ownedNextCursor && !effectiveNextCursor) || loadingMore) {
      return
    }
    const ownedCursor = ownedNextCursor
    const effectiveCursor = effectiveNextCursor
    const statusSnapshot = statusSequence.current
    setLoadingMore(true)
    setContinuationError(null)
    try {
      const [ownedPage, effectivePage] = await Promise.all([
        ownedCursor ? api.providerResourcesGet({ cursor: ownedCursor }) : null,
        effectiveCursor ? api.providerEffectiveGet({ cursor: effectiveCursor }) : null,
      ])

      const canAcceptPageItem = (id: string) => {
        const request = statusRequest.current.get(id)

        return request === undefined || request <= statusSnapshot
      }
      // A page may supersede status work that already existed when it started,
      // but never a mutation/batch token created while the page was in flight.
      const acceptedOwnedItems = (ownedPage?.items ?? []).filter(({ id }) => canAcceptPageItem(id))
      const acceptedEffectiveEntries = (effectivePage?.items ?? []).filter(({ resource: { id } }) =>
        canAcceptPageItem(id),
      )
      const effectiveIds = new Set((effective ?? []).map(({ resource }) => resource.id))

      for (const entry of acceptedEffectiveEntries) {
        effectiveIds.add(entry.resource.id)
      }
      const missingOwnedIds = acceptedOwnedItems
        .map(({ id }) => id)
        .filter((id) => !effectiveIds.has(id) && !ownedStatusById.has(id))

      if (ownedPage) {
        setOwned((current) => mergeResources(current, acceptedOwnedItems))
        setOwnedNextCursor(ownedPage.nextCursor)
      }
      if (effectivePage) {
        const pageIds = new Set(acceptedEffectiveEntries.map(({ resource }) => resource.id))

        for (const id of pageIds) {
          statusRequest.current.delete(id)
          statusRequestKind.current.delete(id)
        }
        setStatusById((current) => {
          const next = new Map(current)

          for (const id of pageIds) {
            next.delete(id)
          }

          return next
        })
        setOwnedStatusById((current) => {
          const next = new Map(current)

          for (const id of pageIds) {
            next.delete(id)
          }

          return next
        })
        setEffective((current) => mergeEffective(current, acceptedEffectiveEntries))
        setEffectiveNextCursor(effectivePage.nextCursor)
      }
      void hydrateOwnedStatuses(missingOwnedIds, inventoryRequest.current)
    } catch (cause) {
      setContinuationError(errorText(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  const loadMoreCredentials = async () => {
    if (!credentialsNextCursor || loadingMoreCredentials) {
      return
    }
    const cursor = credentialsNextCursor
    setLoadingMoreCredentials(true)
    setCredentialContinuationError(null)
    try {
      const page = await api.credentialsGet({ cursor })
      setCredentials((current) => {
        const byId = new Map(current.map((item) => [item.id, item]))

        for (const item of page.items) {
          byId.set(item.id, item)
        }

        return [...byId.values()]
      })
      setCredentialsNextCursor(page.nextCursor)
    } catch (cause) {
      setCredentialContinuationError(errorText(cause))
    } finally {
      setLoadingMoreCredentials(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () => () => {
      detailRequest.current += 1
      inventoryRequest.current += 1
      statusRequest.current.clear()
      statusRequestKind.current.clear()
    },
    [],
  )

  const open = async (id: string) => {
    const request = ++detailRequest.current
    setSelectingId(id)
    setDetailError(null)
    try {
      const detail = await api.providerResourceGet(id)

      if (request === detailRequest.current) {
        setSelected(detail)
      }
    } catch (cause) {
      if (request === detailRequest.current) {
        if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
          setSelected(null)
          setOwned((current) => current?.filter((resource) => resource.id !== id) ?? [])
          setEffective((current) => current?.filter((entry) => entry.resource.id !== id) ?? [])
          setDetailError('This provider resource no longer exists.')
        } else {
          setDetailError(errorText(cause))
        }
      }
    } finally {
      if (request === detailRequest.current) {
        setSelectingId(null)
      }
    }
  }

  const create = async (input: ProviderResourceCreateRequest) => {
    const created = await api.providerResourceCreate(input)
    upsertOwned(listItemOf(created.resource))
    await refreshEffective(created.resource.id)
    setSelected(null)
  }

  const patch = async (id: string, input: ProviderResourcePatchRequest) => {
    try {
      const patched = await api.providerResourcePatch(id, input)
      upsertOwned(listItemOf(patched.resource))
      await refreshEffective(id)
      setSelected(patched)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
        setSelected(null)
        setOwned((current) => current?.filter((resource) => resource.id !== id) ?? [])
        setEffective((current) => current?.filter((entry) => entry.resource.id !== id) ?? [])
        setDetailError('This provider resource no longer exists.')
        return
      }
      throw cause
    }
  }

  const remove = async (id: string) => {
    try {
      await api.providerResourceDelete(id)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
        setDetailError('This provider resource no longer exists.')
      } else {
        throw cause
      }
    }
    setSelected((current) => (current?.resource.id === id ? null : current))
    setOwned((current) => current?.filter((resource) => resource.id !== id) ?? [])
    setEffective((current) => current?.filter((entry) => entry.resource.id !== id) ?? [])
    setOwnedStatusById((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
    statusRequest.current.set(id, ++statusSequence.current)
    statusRequestKind.current.delete(id)
    setResourceStatus(id, null)
  }

  const validate = async (id: string, capability: ModelCapability) => {
    try {
      const result = await api.providerValidate(id, { capability })
      setSelected({ resource: result.resource, warnings: [] })
      upsertOwned(listItemOf(result.resource))
      await refreshEffective(id)
      return result
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
        setSelected(null)
        setOwned((current) => current?.filter((resource) => resource.id !== id) ?? [])
        setEffective((current) => current?.filter((entry) => entry.resource.id !== id) ?? [])
        throw new Error('This provider resource no longer exists.')
      }
      throw cause
    }
  }

  const offer = async (resourceId: string, targetId: string) => {
    await api.providerAttachmentOffer({ resourceId, targetKind: 'space', targetId })
  }

  return (
    <ProviderResourcesWidget
      entries={entries}
      hasMore={Boolean(ownedNextCursor || effectiveNextCursor)}
      credentials={credentials}
      credentialsNextCursor={credentialsNextCursor}
      spaces={spaces}
      selected={selected}
      loading={loading}
      loadingMore={loadingMore}
      loadingMoreCredentials={loadingMoreCredentials}
      error={error}
      continuationError={continuationError}
      credentialContinuationError={credentialContinuationError}
      statusError={statusError}
      detailError={detailError}
      selectingId={selectingId}
      onSelect={open}
      onLoadMore={loadMore}
      onLoadMoreCredentials={loadMoreCredentials}
      onCreate={create}
      onPatch={patch}
      onDelete={remove}
      onValidate={validate}
      onOffer={offer}
      onClose={() => {
        detailRequest.current += 1
        setSelectingId(null)
        setDetailError(null)
        setSelected(null)
      }}
    />
  )
}
