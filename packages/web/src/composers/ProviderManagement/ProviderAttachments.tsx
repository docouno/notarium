import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderAttachmentListItem, ProviderAttachmentView } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { errorText } from '../../libs/errors'
import { api, ApiError } from '../../services/api'
import {
  type ProviderAttachmentAcceptUiOutcome,
  ProviderAttachments as ProviderAttachmentsWidget,
} from '../../widgets/ProviderManagement'
import { useSpace } from '../SpaceProvider'

export const ProviderAttachments = () => {
  const { space } = useSpace()
  const [items, setItems] = useState<ProviderAttachmentListItem[] | null>(null)
  const [selected, setSelected] = useState<ProviderAttachmentView | null>(null)
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [continuationError, setContinuationError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const detailRequest = useRef(0)

  const load = useCallback(async () => {
    detailRequest.current += 1
    setLoading(true)
    setItems(null)
    setSelected(null)
    setSelectingId(null)
    setDetailError(null)
    setTotal(0)
    setNextCursor(null)
    try {
      const page = await api.providerAttachmentsGet(space)
      setItems(page.items)
      setTotal(page.total)
      setNextCursor(page.nextCursor)
      setError(null)
      setContinuationError(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [space])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) {
      return
    }
    const cursor = nextCursor
    setLoadingMore(true)
    setContinuationError(null)
    try {
      const page = await api.providerAttachmentsGet(space, { cursor })
      setItems((current) => {
        const byId = new Map((current ?? []).map((item) => [item.attachment.id, item]))

        for (const item of page.items) {
          byId.set(item.attachment.id, item)
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

  const listItemOf = (view: ProviderAttachmentView): ProviderAttachmentListItem => ({
    attachment: {
      id: view.attachment.id,
      resourceId: view.attachment.resourceId,
      targetKind: view.attachment.targetKind,
      targetId: view.attachment.targetId,
      targetSpace: view.attachment.targetSpace,
      state: view.attachment.state,
      createdAt: view.attachment.createdAt,
      expiresAt: view.attachment.expiresAt,
    },
    resource: { ...view.resource, capabilities: [...view.resource.capabilities] },
  })

  const replaceView = (view: ProviderAttachmentView) => {
    setSelected(view)
    setItems(
      (current) =>
        current?.map((item) =>
          item.attachment.id === view.attachment.id ? listItemOf(view) : item,
        ) ?? [listItemOf(view)],
    )
  }

  const open = async (id: string) => {
    const request = ++detailRequest.current
    setSelectingId(id)
    setSelected(null)
    setDetailError(null)
    try {
      const detail = await api.providerAttachmentDetail(id)

      if (request === detailRequest.current) {
        setSelected(detail.view)
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

  const accept = async (
    view: ProviderAttachmentView,
  ): Promise<ProviderAttachmentAcceptUiOutcome> => {
    try {
      const result = await api.providerAttachmentAccept(view.attachment.id, view.currentEpochs)
      replaceView(result.view)
      return result.outcome
    } catch (cause) {
      if (cause instanceof ApiError && cause.reason === 'epoch-conflict' && cause.providerView) {
        replaceView(cause.providerView)
        return 'refreshed'
      }
      if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
        setSelected(null)
        await load()
        throw new Error('This attachment no longer exists.')
      }
      throw cause
    }
  }

  const detach = async (id: string) => {
    try {
      await api.providerAttachmentDetach(id)
      setItems((current) => current?.filter((item) => item.attachment.id !== id) ?? [])
      setSelected((current) => (current?.attachment.id === id ? null : current))
      setTotal((current) => Math.max(0, current - 1))
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === HTTP_STATUS.NOT_FOUND) {
        await load()
        throw new Error('This attachment no longer exists.')
      }
      throw cause
    }
  }

  return (
    <ProviderAttachmentsWidget
      items={items}
      total={total}
      nextCursor={nextCursor}
      selected={selected}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      continuationError={continuationError}
      detailError={detailError}
      selectingId={selectingId}
      onSelect={open}
      onClose={() => {
        detailRequest.current += 1
        setSelected(null)
        setSelectingId(null)
        setDetailError(null)
      }}
      onLoadMore={loadMore}
      onAccept={accept}
      onDetach={detach}
    />
  )
}
