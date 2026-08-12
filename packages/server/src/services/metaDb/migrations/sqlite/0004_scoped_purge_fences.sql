CREATE INDEX idx_note_revisions_base_rev ON note_revisions(base_rev);

CREATE INDEX idx_note_revisions_their_rev ON note_revisions(their_rev);

CREATE INDEX idx_note_revisions_source_rev ON note_revisions(source_rev);

CREATE INDEX idx_context_scope_pins_note ON context_scope_pins(note_space, note_id);

ALTER TABLE revision_purge_fences RENAME TO revision_purge_fences_v3;

-- `space` carries no DEFAULT: a fence written without one must FAIL, not become a global
-- fence. canon: docs/meta-db.md
CREATE TABLE revision_purge_fences (
  kind TEXT NOT NULL CHECK (kind IN ('note', 'space')),
  entity_id TEXT NOT NULL,
  space TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, space)
);

INSERT INTO revision_purge_fences (kind, entity_id, space)
SELECT kind, entity_id, CASE WHEN kind = 'space' THEN entity_id ELSE '' END
FROM revision_purge_fences_v3;

DROP TABLE revision_purge_fences_v3;

DROP TRIGGER trg_revision_append_lifecycle;

CREATE TRIGGER trg_revision_append_lifecycle
  BEFORE INSERT ON note_revisions
  WHEN EXISTS (
    SELECT 1
    FROM revision_purge_fences
    WHERE (kind = 'space' AND entity_id = NEW.space)
       OR (kind = 'note' AND entity_id = NEW.note_id AND space IN ('', NEW.space))
  )
BEGIN
  SELECT RAISE(ABORT, 'revision target was permanently purged');
END;

-- NOT NULL alone does not carry the rule above: the pre-#327 fence writer is
-- INSERT OR IGNORE, which swallows the violation and would commit its purge with no fence
-- at all. RAISE(ABORT) is not subject to the statement's OR IGNORE.
CREATE TRIGGER trg_purge_fence_requires_space
  BEFORE INSERT ON revision_purge_fences
  WHEN NEW.space IS NULL
BEGIN
  SELECT RAISE(ABORT, 'purge fence requires a space');
END;
