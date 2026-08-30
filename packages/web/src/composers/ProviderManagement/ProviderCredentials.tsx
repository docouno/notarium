import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CredentialCreateRequest,
  CredentialListItem,
  CredentialPatchRequest,
  CredentialResponse,
  ProviderResourceListItem,
  ProviderRetargetRequest,
} from '@notarium/contract'
import { PROVIDER_LIST_PAGE_SIZE } from '@notarium/contract/enums'
import { errorText } from '../../libs/errors'
import { api, ApiError } from '../../services/api'
import { ProviderCredentials as ProviderCredentialsWidget } from '../../widgets/ProviderManagement'

export const ProviderCredentials = () => {
  const [credentials, setCredentials] = useState<CredentialListItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<CredentialResponse | null>(null)
  const [referencedResources, setReferencedResources] = useState<ProviderResourceListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [continuationError, setContinuationError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const detailRequest = useRef(0)

  const listItemOf = (credential: CredentialResponse['credential']): CredentialListItem => ({
    id: credential.id,
    name: credential.name,
    kind: credential.kind,
    origin: credential.origin,
    disabledAt: credential.disabledAt,
    rpm: credential.rpm,
    tpm: credential.tpm,
  })

  const upsert = (item: CredentialListItem) =>
    setCredentials((current) => {
      if (!current) {
        return [item]
      }

      return current.some(({ id }) => id === item.id)
        ? current.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [item, ...current]
    })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await api.credentialsGet()
      setCredentials(page.items)
      setTotal(page.total)
      setNextCursor(page.nextCursor)
      setError(null)
      setContinuationError(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) {
      return
    }
    const cursor = nextCursor
    setLoadingMore(true)
    setContinuationError(null)
    try {
      const page = await api.credentialsGet({ cursor })
      setCredentials((current) => {
        const byId = new Map((current ?? []).map((item) => [item.id, item]))

        for (const item of page.items) {
          byId.set(item.id, item)
        }

        return [...byId.values()]
      })
      setTotal(page.total)
      setNextCursor(page.nextCursor)
    } catch (cause) {
      setContinuationError(errorText(cause))
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () => () => {
      detailRequest.current += 1
    },
    [],
  )

  const open = async (id: string) => {
    const request = ++detailRequest.current
    setSelectingId(id)
    setDetailError(null)
    try {
      const detail = await api.credentialGet(id)

      if (request === detailRequest.current) {
        setReferencedResources([])
        setSelected(detail)
      }
    } catch (cause) {
      if (request === detailRequest.current) {
        setDetailError(errorText(cause))
      }
    } finally {
      if (request === detailRequest.current) {
        setSelectingId(null)
      }
    }
  }

  const prepareRetarget = async () => {
    if (!selected) {
      throw new Error('Open a credential before retargeting resources.')
    }
    const first = await api.providerResourcesGet()
    const ownedResources = [...first.items]
    const seenCursors = new Set<string>()
    let cursor = first.nextCursor
    let pagesLeft = Math.ceil(first.total / PROVIDER_LIST_PAGE_SIZE) + 1

    while (cursor) {
      if (pagesLeft <= 0 || seenCursors.has(cursor)) {
        throw new Error('Provider resource inventory did not produce a complete cursor chain.')
      }
      pagesLeft -= 1
      seenCursors.add(cursor)
      const page = await api.providerResourcesGet({ cursor })
      ownedResources.push(...page.items)
      cursor = page.nextCursor
    }
    const unique = new Map(ownedResources.map((resource) => [resource.id, resource]))

    if (unique.size !== first.total) {
      throw new Error('Provider resource inventory changed while preparing Retarget; try again.')
    }
    const byId = unique
    const missing = selected.references.filter((reference) => !byId.has(reference.id))
    const incomplete = selected.references.filter((reference) => {
      const resource = byId.get(reference.id)
      return resource !== undefined && !resource.baseUrl
    })

    if (missing.length || incomplete.length) {
      const changed = [...missing, ...incomplete]
      throw new Error(
        `Referenced provider resources changed; refresh and try again: ${changed.map(({ name }) => name).join(', ')}`,
      )
    }
    setReferencedResources(
      selected.references.map((reference) => byId.get(reference.id) as ProviderResourceListItem),
    )
  }

  const create = async (input: CredentialCreateRequest) => {
    const created = await api.credentialCreate(input)
    upsert(listItemOf(created.credential))
    setTotal((current) => current + 1)
    setSelected(null)
    setReferencedResources([])
  }

  const patch = async (id: string, input: CredentialPatchRequest) => {
    const patched = await api.credentialPatch(id, input)
    upsert(listItemOf(patched.credential))
    setSelected(null)
    setReferencedResources([])
  }

  const retarget = async (id: string, input: ProviderRetargetRequest) => {
    try {
      const response = await api.credentialRetarget(id, input)
      upsert(listItemOf(response.credential))
    } catch (cause) {
      if (cause instanceof ApiError && cause.references?.length) {
        const references = cause.references
          .map((reference) =>
            'resolution' in reference
              ? `${reference.name}: ${reference.resolution}`
              : reference.name,
          )
          .join(', ')
        throw new Error(`${cause.message}: ${references}`)
      }
      throw cause
    }
    setSelected(null)
    setReferencedResources([])
  }

  const remove = async (id: string) => {
    try {
      await api.credentialDelete(id)
    } catch (cause) {
      await open(id).catch(() => {})
      throw cause
    }
    setSelected(null)
    setReferencedResources([])
    setCredentials((current) => current?.filter((credential) => credential.id !== id) ?? [])
    setTotal((current) => Math.max(0, current - 1))
  }

  return (
    <ProviderCredentialsWidget
      credentials={credentials}
      total={total}
      nextCursor={nextCursor}
      selected={selected}
      referencedResources={referencedResources}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      continuationError={continuationError}
      detailError={detailError}
      selectingId={selectingId}
      onSelect={open}
      onLoadMore={loadMore}
      onCreate={create}
      onPatch={patch}
      onPrepareRetarget={prepareRetarget}
      onRetarget={retarget}
      onDelete={remove}
      onClose={() => {
        detailRequest.current += 1
        setSelectingId(null)
        setDetailError(null)
        setSelected(null)
        setReferencedResources([])
      }}
    />
  )
}
