import { createContext, type ReactNode, useContext } from 'react'
import { useFeedState } from './hooks/useFeedState'

// Feed page state, lifted so the page and its aside facets share one instance
// (same folder filter, same data window). Since #64 the Feed owns its own
// server-windowed data (sparse pages + honest total — see useFeedState);
// facets/stats ride NotesProvider's /api/tree, freshness rides the shared SSE
// stream. Visiting the Feed costs one window request, not the whole base.

export type FeedState = ReturnType<typeof useFeedState>
export { FEED_COLS } from './consts'
export type { FeedCols } from './types'

const FeedContext = createContext<FeedState | null>(null)

export const useFeed = (): FeedState => {
  const ctx = useContext(FeedContext)

  if (!ctx) {
    throw new Error('useFeed must be used within FeedProvider')
  }

  return ctx
}

export const FeedProvider = ({ children }: { children: ReactNode }) => {
  const feed = useFeedState()

  return <FeedContext.Provider value={feed}>{children}</FeedContext.Provider>
}
