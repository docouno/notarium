// The derived index (P2): rebuildable from the files at any moment, so a teardown
// is always LEGAL — but not always cheap. Schema now evolves as a forward-only
// in-process ladder (INDEX_MIGRATIONS): an additive change is an
// `ALTER TABLE … ADD COLUMN` step that PRESERVES rowids, so
// notes_fts and the rowid-keyed note_vectors (with their embedded_hash sentinel)
// survive untouched — no re-embed. Teardown+rebuild stays the honest FALLBACK for a
// version we can't step from. Nothing here is a system of record; the meta-DB
// (identity, journal) is where invariants live and deliberately has a separate,
// checksummed migration mechanism (docs/meta-db.md).

// v2 (#78): the notes table gained a `class` column — one index per space with
// a class discriminator (#74-F2), NOT an index-per-class.
// v3 (#81): the notes table gained `content_hash` (the embedding invalidation
// arbiter, P13) and — only when the vector channel is enabled — a `note_vectors`
// vec0 table holding one embedding per chunk, keyed by the note's rowid. The
// vector index is FULLY derived (P2/P13): a model/chunker change is a rebuild,
// not a migration. Both columns/tables come from the mount + the file, so a
// version bump just teardown+rebuilds and every file gets re-derived next scan.
// v4 (#81 Stage 3): the notes table gained `embedded_hash` — the completeness
// sentinel for MULTI-CHUNK embedding (heading-first chunker). A note's vectors
// are DELETE+N×INSERT; written as separate statements (no cross-await txn on the
// shared connection), a crash mid-loop would leave a PARTIAL set all tagged with
// the current content_hash, which a "exists a vector for this hash" predicate
// would mistake for complete. `embedded_hash` is set as the LAST step of a
// successful embed (the commit point): the "needs (re)embedding" predicate is
// `content_hash != embedded_hash`, so a partial write (sentinel never set) is
// re-embedded on the next backfill, the DELETE clearing the partial leftovers.
// v5 (#100 phase 0): the notes table gained `aliases` — past human names (former
// titles) the link resolver still honours, parsed from frontmatter `aliases:`,
// so a rename never breaks inbound [[Old Name]] links. Derived from the file, so
// a version bump teardown+rebuilds and every note re-derives its aliases.
// v6 (#100 phase 1): the notes table gained `slug` — the editable display slug (a
// URL/resolve name decoupled from the title AND the storage filename), parsed
// from frontmatter `slug:`. NULL when the note has no custom slug (the default is
// the implicit slug(title); not stored). Derived from the file, so a version
// bump teardown+rebuilds and every note re-derives its slug.
// v7 (#188): the notes table gained `note_type` — the note's kind (note/journal/…)
// for Spotlight/search badges, derived from the mount + frontmatter.
//
// These v1..v7 bumps ALL shipped as full teardowns (pre-ladder). The current shape
// above is the FROZEN ladder baseline (INDEX_MIGRATIONS[0], below); from here every
// additive change is an appended ALTER step, not a teardown. An index still stamped
// with the legacy string '7' already matches this baseline and adopts onto the
// ladder without a rebuild (see planIndexMigration / LEGACY_BASELINE_VERSION).
// Ladder step 2 adds `file_fingerprints`: a rowid-keyed raw-source hash + cheap
// adapter token used only for external-change reconciliation. Step 3 binds every
// fingerprint to the exact `notes.seq` materialization it describes: a lagging or
// ahead fingerprint is never trusted after a crash or concurrent reconcile. The
// table is deliberately separate from `notes.content_hash` (the vector input hash)
// and from FTS, so lazy adoption neither resets vectors nor churns FTS.

// Keys in the `meta` table that pin the vector partition's identity (P13). When
// any drifts from the live embedder/chunker, the partition is wiped and
// re-embedded — finer-grained than a full teardown (FTS/notes survive).
// `dimensions` is tracked separately because embedder_id (model@dtype) does not
// encode it: a dimensions change with an unchanged id would otherwise leave the
// vec0 table at the old `float[N]` width and reject every new INSERT.
export const META_EMBEDDER_ID = 'embedder_id'
export const META_CHUNKER_VERSION = 'chunker_version'
export const META_EMBEDDER_DIMS = 'embedder_dims'

// The vec0 table LAYOUT version (#193) — the physical DDL shape of `note_vectors`,
// independent of which model/chunker filled it. Bumped when a DDL change needs an
// existing vector partition rebuilt even though the embedder identity is unchanged.
// v1 = `note_rowid partition key` (one tiny partition per note → KNN cost grew with
// note count, ~170x slower); v2 = flat `note_rowid` column. A drift here feeds the
// same wipe+backfill as an embedder/chunker drift (the index is derived/disposable,
// P2 — migration IS rebuild): the partition is dropped and re-embedded from the
// files. Tracked in `meta` so the rebuild is scoped to the vector half (FTS/notes
// survive), finer than a full teardown.
export const META_VEC_LAYOUT = 'vec_layout_version'
export const VEC_LAYOUT_VERSION = '2'
/** Last path covered by the rotating source-integrity sweep. It lives in the
 *  derived index so frequent restarts cannot keep resetting verification to the
 *  first lexicographic files. */
export const META_INTEGRITY_SWEEP_CURSOR = 'integrity_sweep_cursor'

// The version lives in `meta`, so the boot path creates JUST this table first
// to read the stored version BEFORE the rest of the schema — whose v2 `class`
// index would throw against a stale v1 `notes` table. Migration must tear down
// before it can build (see NotariumStore.ensureReady).
export const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// The frozen v1 baseline body (INDEX_MIGRATIONS[0]); module-local — the ladder is
// the only consumer. Never edit it; evolve the schema by APPENDING a ladder step.
const SCHEMA = `
${META_SCHEMA}
CREATE TABLE IF NOT EXISTS notes (
  path         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  class        TEXT NOT NULL DEFAULT 'user-doc',
  mtime_ms     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  created_at   TEXT,
  modified_at  TEXT,
  note_type    TEXT NOT NULL DEFAULT 'note',
  id_claim     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  aliases      TEXT NOT NULL DEFAULT '[]',
  slug         TEXT,
  body         TEXT NOT NULL,
  content_hash TEXT,
  embedded_hash TEXT,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_class ON notes(class);

CREATE INDEX IF NOT EXISTS idx_notes_seq ON notes(seq);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body, tags,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
`

// The vector half of the schema (#81), applied ONLY when an embedder is wired in
// (the vec0 extension is loaded). `note_vectors` carries one row per chunk:
//  - note_rowid: the notes.rowid the chunk came from — a PLAIN (filterable) vec0
//    metadata column. The delete trigger filters on it (`WHERE note_rowid = old.rowid`) and
//    the RRF read-path (Stage 2) collapses chunks→note and joins back to `notes` by
//    it. rowid is stable across edits and renames (UPDATE keeps it), the same
//    assumption FTS rides. It was a vec0 PARTITION KEY until #193: that sharded the
//    vectors into one tiny partition PER NOTE, and vec0's KNN pays a per-partition
//    cost — so search latency grew with the note COUNT (not the chunk count),
//    ~170x slower than a flat table on a 2k-note corpus (and partition delete was
//    3x slower too — measured). The partition key bought nothing the KNN ever used
//    (it never filtered by it), so it's gone; KNN now scans a single flat shard.
//  - content_hash: the note's embedding-source hash AT EMBED TIME (P13). It tags
//    each vector row with the source it derived from; it is NOT itself the
//    completeness arbiter. The "needs (re)embedding" decision is driven by the
//    notes.embedded_hash sentinel (predicate `content_hash != embedded_hash`, see
//    the file header), so a partial multi-chunk write — whose rows all carry the
//    current content_hash — is re-embedded rather than mistaken for done. A touch
//    that doesn't change content keeps the same hash → no re-embed.
//  - class: the note's mount class (#78), carried so the read-model can apply
//    the visibility post-filter to vector hits (the engine stays bare).
//  - chunk_index: AUXILIARY (`+`, stored not indexed) — which chunk of the note.
//  - chunk_text: AUXILIARY — the chunk's own text (heading-first chunker, Stage 3),
//    so a VECTOR-ONLY hit can show the matched fragment as its snippet instead of a
//    blind body-head prefix. Derived/disposable (P2); it roughly doubles a row's
//    size next to the float[dim] embedding — acceptable at our scale, revisited at
//    scale (#84). The RRF read-path returns the closest chunk's text per note.
//  - embedding: the unit-normalized vector; cosine distance for KNN.
// The AFTER DELETE trigger cascades a note's deletion into its vectors by rowid,
// so every delete path (rescan drop, external-delete on read, remove, reindex)
// cleans up for free — no per-call-site vector delete to forget. DROP TABLE on
// `notes` does NOT fire it, so a teardown is unaffected.
export const vecSchema = (dimensions: number): string => `
CREATE VIRTUAL TABLE IF NOT EXISTS note_vectors USING vec0(
  note_rowid integer,
  content_hash text,
  class text,
  +chunk_index integer,
  +chunk_text text,
  embedding float[${dimensions}] distance_metric=cosine
);

CREATE TRIGGER IF NOT EXISTS notes_vec_ad AFTER DELETE ON notes BEGIN
  DELETE FROM note_vectors WHERE note_rowid = old.rowid;
END;
`

// Dropping the vector half: the trigger first (it references note_vectors), then
// the vec0 table. Runs ONLY with the vec0 extension loaded — a DROP on a vec0
// table whose module is absent throws "no such module", so the base TEARDOWN
// must NOT carry it (it runs even when the vector channel is off).
export const VEC_TEARDOWN = `
DROP TRIGGER IF EXISTS notes_vec_ad;
DROP TABLE IF EXISTS note_vectors;
`

export const TEARDOWN = `
DROP TRIGGER IF EXISTS notes_vec_ad;
DROP TRIGGER IF EXISTS notes_fingerprint_ad;
DROP TRIGGER IF EXISTS notes_document_proof_ad;
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TABLE IF EXISTS file_fingerprints;
DROP TABLE IF EXISTS document_proofs;
DROP TABLE IF EXISTS notes_fts;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS meta;
`

// ── Index schema migration ladder ────────────────────────────────────────────
// The notes/FTS half of the index evolves as its own forward-only ladder. This is
// the SQLite index driver; the cloud pg profile is a separate KnowledgeStore, and
// the non-rebuildable meta-DB has a separate checksummed two-dialect history. Boot
// applies the missing index steps in order, EACH in its own
// transaction that also stamps the version — so a crash mid-step rolls the step back
// and the next boot re-applies it cleanly (SQLite DDL is transactional). The point:
// an ADDITIVE step is an `ALTER TABLE … ADD COLUMN`, which keeps rowids — so
// note_vectors (keyed by notes.rowid) and the embedded_hash sentinel survive, and the
// note is NOT re-embedded. This is what a full teardown could not do: #188's additive
// note_type column (a version bump) dropped notes+vectors and re-embedded every note
// from scratch, the trigger behind the #196 backfill storm.

/** One forward migration step (SQLite DDL), applied inside a transaction with its
 *  version stamp — so it may be multi-statement and a crash rolls it back whole
 *  (never a half-applied, non-idempotent `ADD COLUMN` that wedges the next boot).
 *  A ladder step MUST be ADDITIVE and rowid-preserving — `ALTER TABLE … ADD COLUMN`,
 *  a new index, a new trigger — AND derivation-neutral: it must not change how a row
 *  is derived from its file (the content_hash input, the parsed body/title/tags). The
 *  rescan skips unchanged files by mtime+size, so a step that reshaped derivation
 *  without a rebuild would silently leave them carrying a STALE content_hash / FTS row
 *  / vectors. That additive-only rule is what keeps the ladder cheap BY CONSTRUCTION:
 *  an additive step keeps rowids, so note_vectors (keyed by notes.rowid) and the
 *  embedded_hash sentinel ride along untouched — no re-embed.
 *
 *  A NON-additive reshape (dropping/retyping a column — a rowid-resetting table
 *  rebuild) is deliberately NOT expressible here: it would silently misattribute the
 *  rowid-keyed vectors and desync the external-content FTS. When one is genuinely
 *  needed, introduce it with a PERSISTENT rebuild marker (like the embedder-identity
 *  meta keys) that forces a vector wipe+re-embed AND an FTS rebuild — plus its own
 *  tests. Until then a full teardown, always legal for a derived index (P2), is the
 *  escape.
 *
 *  ONE exception to derivation-neutrality, and it carries its own condition: a step
 *  MAY change how a row derives from its file if the SAME transaction clears
 *  `file_fingerprints` and every rescan exit knows the new projection. The wipe makes
 *  each row source-verify once, so the skip-by-mtime+size shortcut cannot leave a
 *  stale projection behind; and because fingerprints are deliberately separate from
 *  `notes.content_hash` and from FTS, clearing them touches neither vectors nor the
 *  FTS schema — the persistent invalidation signal rides the ladder itself instead of
 *  a second version marker beside it. */
export type IndexMigration = { sql: string }

const FILE_FINGERPRINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_fingerprints (
  note_rowid  INTEGER PRIMARY KEY,
  source_hash TEXT NOT NULL,
  change_token TEXT
);

CREATE TRIGGER IF NOT EXISTS notes_fingerprint_ad AFTER DELETE ON notes BEGIN
  DELETE FROM file_fingerprints WHERE note_rowid = old.rowid;
END;
`

const FILE_FINGERPRINT_VERSION_SCHEMA = `
ALTER TABLE file_fingerprints ADD COLUMN note_seq INTEGER;
`

const NOTE_ID_CLAIM_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_notes_id_claim ON notes(id_claim);
`

const DOCUMENT_PROOF_SCHEMA = `
CREATE TABLE IF NOT EXISTS document_proofs (
  note_rowid INTEGER PRIMARY KEY,
  source_hash TEXT NOT NULL,
  proof_json  TEXT NOT NULL,
  receipt_id  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS notes_document_proof_ad AFTER DELETE ON notes BEGIN
  DELETE FROM document_proofs WHERE note_rowid = old.rowid;
END;
`

const IMPORT_SOURCE_SCHEMA = `
ALTER TABLE notes ADD COLUMN source_locator TEXT;
`

/** The authored-frontmatter column, and the `file_fingerprints` wipe that makes every
 *  already-indexed row source-verify it. That same already-paid pass materializes
 *  canonical legacy source locators consistently instead of only on field-bearing rows.
 *  The default is a note with no author keys,
 *  which is a valid NON-empty blob: the empty string is reserved as the poll sentinel
 *  for "this row's column was not selected".
 *  canon: docs/search.md#how-it-is-indexed-write-path */
const NOTE_FIELDS_SCHEMA = `
ALTER TABLE notes ADD COLUMN fields TEXT NOT NULL DEFAULT '{"keys":{}}';
DELETE FROM file_fingerprints;
`

const DOCUMENT_PROOF_CONTEXT_SCHEMA = `
ALTER TABLE document_proofs ADD COLUMN context_json TEXT;
`

/** Metadata-only writes must not delete+reinsert unchanged FTS rows. SQLite's
 * original broad UPDATE trigger fires even when only `fields`/mtime/seq changed;
 * narrow it to the three columns the FTS table actually owns. */
const FTS_UPDATE_TRIGGER_SCHEMA = `
DROP TRIGGER IF EXISTS notes_au;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body, tags ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
  VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags)
  VALUES (new.rowid, new.title, new.body, new.tags);
END;
`

/** The ladder. INDEX_MIGRATIONS[0] is the FROZEN baseline — the meta+notes+FTS schema
 *  as it shipped at legacy version '7' (note_type included). A fresh index replays it
 *  from 0; a legacy '7' index replays it too, but every statement is CREATE IF NOT
 *  EXISTS, so it is a no-op that adopts the ladder without a rebuild (and self-heals a
 *  missing index/trigger). NEVER edit an existing step: a new column/table APPENDS a
 *  step here (baseline stays frozen); that append is what stays cheap (no
 *  re-embed). This derived-index ladder is not the meta-DB migration history. */
export const INDEX_MIGRATIONS: readonly IndexMigration[] = [
  { sql: SCHEMA },
  { sql: FILE_FINGERPRINT_SCHEMA },
  { sql: FILE_FINGERPRINT_VERSION_SCHEMA },
  { sql: NOTE_ID_CLAIM_INDEX_SCHEMA },
  { sql: DOCUMENT_PROOF_SCHEMA },
  // `source_locator` and proof context shipped on main before the task-local
  // `fields` projection. Preserve that published lineage and append fields: a
  // deployed index must neither skip fields nor replay an existing main column.
  { sql: IMPORT_SOURCE_SCHEMA },
  { sql: DOCUMENT_PROOF_CONTEXT_SCHEMA },
  { sql: NOTE_FIELDS_SCHEMA },
  { sql: FTS_UPDATE_TRIGGER_SCHEMA },
]

/** The current ladder length — the integer version an index converges to. */
export const INDEX_SCHEMA_VERSION = INDEX_MIGRATIONS.length

/** Meta-row key holding the ladder's integer version (the current scheme). */
export const INDEX_VERSION_KEY = 'index_schema_version'
/** The pre-ladder meta-row key, a STRING version ('1'..'7'). Read once to bridge an
 *  existing index onto the ladder, then retired — never written again. */
export const LEGACY_VERSION_KEY = 'schema_version'
/** The last pre-ladder version. An index stamped with THIS already carries the
 *  MIGRATIONS[0] baseline shape, so it adopts onto the ladder by replaying step 0
 *  (all CREATE IF NOT EXISTS → a no-op) — no teardown, no re-embed. Older legacy
 *  strings ('1'..'6') predate baseline columns and can't be stepped, so they fall
 *  through to a teardown+rebuild. */
export const LEGACY_BASELINE_VERSION = '7'

export type IndexMigrationPlan = {
  /** Resume applying the ladder from here: INDEX_MIGRATIONS[fromVersion..target). */
  fromVersion: number
  /** Drop the notes/FTS index first (rowids reset → the vector half must wipe). */
  teardown: boolean
}

/** Decide how to bring a stored index up to the target ladder version. Pure, so the
 *  boot path stays a thin apply-loop and every transition is unit-tested:
 *   - already on the ladder → resume from the stored integer (rebuild if it is
 *     corrupt or newer than we know — never step blindly);
 *   - a FRESH index (no version at all) OR the legacy baseline '7' → build/replay
 *     from 0 with no teardown (step 0 is idempotent CREATE IF NOT EXISTS, so a '7'
 *     index adopts the ladder in place, keeping its rows and vectors);
 *   - any older/unknown legacy → teardown + rebuild from 0 (P2 fallback). */
export const planIndexMigration = (opts: {
  ladderVersion: string | undefined
  legacyVersion: string | undefined
  target?: number
}): IndexMigrationPlan => {
  const target = opts.target ?? INDEX_SCHEMA_VERSION
  const { ladderVersion, legacyVersion } = opts

  if (ladderVersion != null) {
    // A clean non-negative integer within [0, target] is a live ladder version;
    // anything else (corrupt, or newer than this build knows) rebuilds rather than
    // stepping blindly. The strict digit test rejects '1abc'/'1.9' → rebuild.
    const v = /^\d+$/.test(ladderVersion) ? Number.parseInt(ladderVersion, 10) : NaN

    if (Number.isInteger(v) && v <= target) {
      return { fromVersion: v, teardown: false }
    }

    return { fromVersion: 0, teardown: true }
  }
  if (legacyVersion == null || legacyVersion === LEGACY_BASELINE_VERSION) {
    return { fromVersion: 0, teardown: false }
  }

  return { fromVersion: 0, teardown: true }
}
