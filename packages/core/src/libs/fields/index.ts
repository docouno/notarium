export * from './consts'
export * from './types'
export * from './predicates'
export * from './displayName'
export * from './write'
export * from './match'
export * from './facet'
// `./blob` is re-exported BY NAME, unlike the two sinks above. `measureCappedNoteFields`
// is a test seam: its third argument makes the cap walk stop short, and a negative one
// makes a build over-sacrifice and drop keys it had room for. Under `export *` that seam
// stood in the public surface of `@notarium/core` with no caller — its one consumer is
// the co-located `blob.test.ts`, which reaches it through `./blob` and is unaffected.
export {
  buildNoteDetailFields,
  buildNoteFields,
  buildNoteFieldsBlob,
  parseNoteFields,
  patchNoteFields,
  serializeNoteFields,
} from './blob'
