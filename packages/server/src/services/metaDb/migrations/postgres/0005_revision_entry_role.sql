-- The role of a journal entry in its note's life, written by the WRITER at append.
-- Twin of the SQLite asset, minus its index: `hasAnyFor` here is already a four-buffer
-- Index Scan on idx_note_revisions_note (0.058 ms), the extra index makes it 0.133 ms
-- and costs +14.9% in table size. Asymmetric assets are allowed and precedented (0004).
-- canon: docs/note-history.md#model

-- Measured: this ALTER does not rewrite the table (37 ms over 200k rows, relfilenode
-- unchanged). DEFAULT 'change' is the mixed-version window — see the SQLite asset for
-- the two consequences it accepts.
ALTER TABLE note_revisions ADD COLUMN entry_role TEXT NOT NULL DEFAULT 'change'
  CHECK (entry_role IN ('origin', 'baseline', 'change'));

-- The first row of each (space, note_id) as a SET. Postgres plans the correlated form
-- with an index subplan (719 ms over 24k) rather than quadratically, so the shape is
-- chosen for SQLite — but the text stays identical in both dialects on purpose: this
-- backfill defines a rule, and two spellings of one rule drift.
--
-- `base_rev IS NULL` is the conjunct being replaced, kept byte-for-byte: a legacy first
-- row may carry a parent in another space (pre-#327 chaining ignored the space), and
-- calling those 'baseline' would silently drop them out of Activity at migration time.
UPDATE note_revisions
   SET entry_role = CASE WHEN kind = 'external' THEN 'baseline' ELSE 'origin' END
 WHERE base_rev IS NULL
   AND id IN (SELECT MIN(id) FROM note_revisions GROUP BY space, note_id);
