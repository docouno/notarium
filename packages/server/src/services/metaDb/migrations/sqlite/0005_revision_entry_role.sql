-- The role of a journal entry in its note's life, written by the WRITER at append.
-- Before it, four consumers each inferred the same thing from `kind='external' AND
-- base_rev IS NULL`, and that stopped meaning "the note's first entry" the moment
-- quarantine landed: a contaminated chain leaves a note with no trusted parent, so a
-- perfectly ordinary later edit looked exactly like a first sighting. canon:
-- docs/note-history.md#model

-- Before the backfill, and SQLite-only. `space = ?` and `note_id = ?` are equalities on
-- the leading columns of two DIFFERENT indexes, and with no sqlite_stat1 the planner
-- takes idx_note_revisions_space_id and walks the space's whole journal: measured
-- hasAnyFor at 2.40 ms/call over 25k rows against 0.0034 ms with this index. Postgres
-- has no such defect (its idx_note_revisions_note already seeks) and the index there
-- costs +14.9% table size for nothing, so that half is deliberately absent.
CREATE INDEX idx_note_revisions_space_note ON note_revisions(space, note_id, id);

-- DEFAULT 'change' is the mixed-version window, and it has two accepted consequences,
-- both permanent for rows written during it: a synthetic baseline written by the old
-- process counts as an edit, and a note genuinely BORN in that window stays 'change'
-- forever — it will read as "edited" on every surface, and it cannot be reopened later
-- because inferring the role on read is exactly what this column abolishes. The window
-- is a rollback to the previous image; the alternative (NOT NULL without a default)
-- crashes the old writer on every append.
ALTER TABLE note_revisions ADD COLUMN entry_role TEXT NOT NULL DEFAULT 'change'
  CHECK (entry_role IN ('origin', 'baseline', 'change'));

-- The first row of each (space, note_id) taken as a SET, not with a correlated
-- subquery: measured on node:sqlite, the correlated form is 38.6 s over 24k rows and
-- 43 s over 25k — quadratic in the space's journal — against 12.6 ms and 25.2 ms here.
--
-- `base_rev IS NULL` is byte-for-byte the conjunct being replaced, and it is load
-- bearing: a legacy first row CAN carry a parent (pre-#327 the chain was keyed by note
-- id alone, across spaces — the very population this task exists for). Without it those
-- rows would become 'baseline' and vanish from Activity on migration, before any
-- settlement, where no quarantine fixture would ever see them. They stay 'change'.
--
-- The writer's own rule is deliberately NOT reproduced here for that class: it would
-- call such a row 'baseline'.
UPDATE note_revisions
   SET entry_role = CASE WHEN kind = 'external' THEN 'baseline' ELSE 'origin' END
 WHERE base_rev IS NULL
   AND id IN (SELECT MIN(id) FROM note_revisions GROUP BY space, note_id);
