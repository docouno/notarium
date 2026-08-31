import type {
  BoardMoveRequest,
  BoardMoveResponse,
  DraftViewQueryRequest,
  DraftViewQueryResponse,
  ViewManifestResponse,
  ViewWindowRequest,
  ViewWindowResponse,
} from '@notarium/contract'

import { req, sp } from './client'

export const viewsApi = {
  noteViewsGet: (id: string, signal?: AbortSignal) =>
    req<ViewManifestResponse>(`/api/note/views?id=${encodeURIComponent(id)}`, { signal }),
  viewWindowPost: (body: ViewWindowRequest, signal?: AbortSignal) =>
    req<ViewWindowResponse>('/api/note/view-window', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
  draftViewQuery: (space: string, body: DraftViewQueryRequest, signal?: AbortSignal) =>
    req<DraftViewQueryResponse>(`${sp(space)}/view-query`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
  boardMove: (body: BoardMoveRequest, signal?: AbortSignal) =>
    req<BoardMoveResponse>('/api/note/board-move', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
}
