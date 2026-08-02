import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { folderRoute, noteRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { NotFoundPage } from '../NotFoundPage'

// `/folder/<id>` (#212) — the durable PAGE address of a folder, space-free like
// `/n/<id>`. The folder-id is stable across rename/move, so this permalink never
// breaks (the path-as-identity anti-pattern the whole model avoids): the registry
// resolves it to the folder's CURRENT space + path, and we hand off to the right
// surface — the page note's `/n/<id>` when the folder HAS a page (its body, in the
// standard reader, zero bespoke), else the virtual `/s/<space>/files/<path>`
// page (title + children summary; `index.md` is still materialised lazily on
// first save). A note keeps its id in the URL; a folder's
// canonical browse URL is its path, so resolving-then-redirecting here is the folder
// twin of the note's stale-slug canonicalisation — the id is the durable handle.
export const FolderPage = () => {
  const { id } = useParams<{ id: string }>()
  const [target, setTarget] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!id) {
      setFailed(true)
      return
    }
    const ac = new AbortController()
    setTarget(null)
    setFailed(false)
    api
      .folderGet(id, ac.signal)
      .then((f) => {
        setTarget(
          f.pageNoteId
            ? (noteRoute(f.pageNoteId) ?? folderRoute(f.space, f.path))
            : folderRoute(f.space, f.path),
        )
      })
      .catch(() => {
        if (!ac.signal.aborted) {
          setFailed(true)
        }
      })
    return () => ac.abort()
  }, [id])
  if (failed) {
    return <NotFoundPage />
  }
  if (target) {
    return <Navigate to={target} replace />
  }

  return (
    <div style={{ maxWidth: 640, margin: '12vh auto 0', padding: '0 24px' }}>
      <Skeleton w="40%" h={26} />
      <div style={{ marginTop: 16 }}>
        <SkeletonText lines={3} />
      </div>
    </div>
  )
}
