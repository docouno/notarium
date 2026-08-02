export const SCAN_PHASE = {
  cold: 'cold',
  notes: 'notes',
  graph: 'graph',
  ready: 'ready',
  error: 'error',
} as const

export const INDEXING_STATE = {
  unknown: 'unknown',
  idle: 'idle',
  busy: 'busy',
} as const

export type ScanPhase = (typeof SCAN_PHASE)[keyof typeof SCAN_PHASE]
export type IndexingState = (typeof INDEXING_STATE)[keyof typeof INDEXING_STATE]

export const VECTOR_MODE = { vector: 'vector', fts: 'fts' } as const

export type VectorMode = (typeof VECTOR_MODE)[keyof typeof VECTOR_MODE]
