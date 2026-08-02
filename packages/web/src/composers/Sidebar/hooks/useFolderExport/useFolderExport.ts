import { useEffect, useRef } from 'react'
import { HTTP_STATUS } from '@notarium/contract/http'
import { useToast } from '../../../../core/Toast'
import { triggerDownload } from '../../../../libs/download'
import { errorText } from '../../../../libs/errors'
import type { SkeletonNode } from '../../../../libs/tree/tree'
import { api, ApiError, pollJobToTerminal } from '../../../../services/api'

export const useFolderExport = (space: string, closeMenu: () => void) => {
  const toast = useToast()
  // Export a folder subtree as a ZIP (#105 tail of #17). Async by default: enqueue a
  // folder-scoped export job, poll it to a terminal state via the SHARED poller (same
  // lifecycle as the Export tab — bounded, cancelable, swallows transient/404 poll
  // blips), surface progress as a sticky toast with a Cancel action, then auto-download
  // the finished archive. The poll is tied to an AbortController torn down on cancel /
  // space switch / unmount, so a stuck job never leaves a zombie poller behind. Only the
  // ENQUEUE 404 (no durable jobs on this host) drops to the synchronous streaming
  // download — a poll 404 (a GC'd job) is handled by the poller, not treated as fallback.
  const exportAbort = useRef<AbortController | null>(null)
  useEffect(() => () => exportAbort.current?.abort(), [space])
  const doExportFolder = async (node: SkeletonNode) => {
    closeMenu()
    const label = node.name || 'this space'
    const folder = node.path || undefined
    exportAbort.current?.abort()
    const ac = new AbortController()
    exportAbort.current = ac
    const pending = toast.info(`Preparing export of “${label}”…`, {
      duration: 0,
      action: { label: 'Cancel', onClick: () => ac.abort() },
    })
    let job

    try {
      job = await api.exportEnqueue(space, { folder })
    } catch (e) {
      toast.dismiss(pending)
      // No durable jobs on this host (enqueue 404) → the synchronous streaming download.
      if (e instanceof ApiError && e.status === HTTP_STATUS.NOT_FOUND) {
        triggerDownload(api.exportUrl(space, { folder }))
        return
      }
      toast.error(errorText(e))
      return
    }
    try {
      job = await pollJobToTerminal(space, job.id, { signal: ac.signal })
    } catch (e) {
      toast.dismiss(pending)
      // Aborted (Cancel / space switch / unmount) → cooperatively cancel the job server-side.
      if (ac.signal.aborted) {
        void api.jobCancel(space, job.id).catch(() => {})
        return
      }
      toast.error(errorText(e))
      return
    }
    toast.dismiss(pending)
    if (ac.signal.aborted) {
      return
    }
    if (job.status === 'succeeded' && job.artifact) {
      const href = api.jobDownloadUrl(space, job.id)
      triggerDownload(href)
      toast.success(`“${label}” exported`, {
        action: { label: 'Download again', onClick: () => triggerDownload(href) },
      })
    } else if (job.status === 'canceled') {
      // silent — the user asked to stop
    } else {
      toast.error(job.error || 'Export failed')
    }
  }

  return { doExportFolder }
}
