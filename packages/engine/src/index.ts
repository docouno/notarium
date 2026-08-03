export {
  NotariumStore,
  createNotariumStore,
  parseNoteFile,
  serializeNoteFile,
  type CreateNotariumStoreOptions,
  type NotariumStoreOptions,
  type SearchTuning,
} from './services/notariumStore'
export { createLocalFsFiles, type FileStat, type FileStore } from './libs/files'
export {
  createNodeSqliteDriver,
  type NodeSqliteDriverOptions,
  type SqlDriver,
  type SqlValue,
} from './libs/sql'
export {
  createEmbedPool,
  createLocalOnnxEmbedder,
  localEmbedderAvailable,
  type Embedder,
  type EmbedKind,
  type EmbedPoolOptions,
  type LocalOnnxEmbedderOptions,
  type PoolWorker,
} from './libs/embedding'
export {
  createWholeNoteChunker,
  createHeadingChunker,
  CHUNK_CHAR_BUDGET,
  TARGET_CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  OVERLAP_CHARS,
  type Chunk,
  type ChunkInput,
  type Chunker,
} from './libs/chunking'
