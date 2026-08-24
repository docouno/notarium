DROP TRIGGER trg_revision_append_lifecycle;

ALTER TABLE note_revisions RENAME TO note_revisions_baseline;

CREATE TABLE note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  space TEXT NOT NULL,
  base_rev INTEGER,
  their_rev INTEGER,
  source_rev INTEGER,
  kind TEXT NOT NULL,
  principal TEXT,
  content_hash TEXT,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  chars_added INTEGER,
  chars_removed INTEGER,
  class TEXT,
  slug TEXT,
  agent_owner TEXT,
  agent_name TEXT,
  session_id TEXT,
  session_name TEXT,
  session_attach TEXT
    CHECK (session_attach IS NULL OR session_attach IN ('declared', 'inferred')),
  integrity TEXT NOT NULL
    CHECK (integrity IN ('trusted', 'quarantined')),
  entry_role TEXT NOT NULL
    CHECK (entry_role IN ('origin', 'baseline', 'change')),
  state_format TEXT
    CHECK (
      state_format IS NULL OR
      state_format IN ('markdown-v1', 'markdown-v2', 'skill-markdown-v1', 'opaque-v1')
    ),
  semantic_fingerprint TEXT,
  restore_safety TEXT
    CHECK (restore_safety IN ('safe', 'blocked', 'unknown'))
);

INSERT INTO note_revisions
  (id, note_id, space, base_rev, their_rev, source_rev, kind, principal,
   content_hash, title, tags, created_at, chars_added, chars_removed, class, slug,
   agent_owner, agent_name, session_id, session_name, session_attach, integrity,
   entry_role, state_format, semantic_fingerprint, restore_safety)
SELECT revisions.id,
       revisions.note_id,
       revisions.space,
       revisions.base_rev,
       revisions.their_rev,
       revisions.source_rev,
       revisions.kind,
       revisions.principal,
       revisions.content_hash,
       revisions.title,
       revisions.tags,
       revisions.created_at,
       revisions.chars_added,
       revisions.chars_removed,
       revisions.class,
       revisions.slug,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       'trusted',
       CASE
         WHEN revisions.base_rev IS NULL
          AND revisions.id = first_entries.first_id
           THEN CASE WHEN revisions.kind = 'external' THEN 'baseline' ELSE 'origin' END
         ELSE 'change'
       END,
       NULL,
       NULL,
       NULL
  FROM note_revisions_baseline AS revisions
  LEFT JOIN (
    SELECT space, note_id, MIN(id) AS first_id
      FROM note_revisions_baseline
     GROUP BY space, note_id
  ) AS first_entries
    ON first_entries.space = revisions.space
   AND first_entries.note_id = revisions.note_id;

DROP TABLE note_revisions_baseline;

CREATE INDEX idx_note_revisions_note
  ON note_revisions(note_id, id);

CREATE INDEX idx_note_revisions_space_created
  ON note_revisions(space, created_at);

CREATE INDEX idx_note_revisions_space_id
  ON note_revisions(space, id);

CREATE INDEX idx_note_revisions_space_note
  ON note_revisions(space, note_id, id);

CREATE INDEX idx_note_revisions_base_rev
  ON note_revisions(base_rev);

CREATE INDEX idx_note_revisions_their_rev
  ON note_revisions(their_rev);

CREATE INDEX idx_note_revisions_source_rev
  ON note_revisions(source_rev);

CREATE INDEX idx_note_revisions_agent_session_created
  ON note_revisions(agent_owner, session_id, created_at DESC, id DESC);

CREATE INDEX idx_note_revisions_agent_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE agent_owner IS NOT NULL;

CREATE INDEX idx_note_revisions_agent_outside_created
  ON note_revisions(agent_owner, created_at DESC, id DESC)
  WHERE session_id IS NULL AND agent_owner IS NOT NULL;

CREATE INDEX idx_note_revisions_agent_owner_name_created
  ON note_revisions(agent_owner, agent_name, created_at DESC, id DESC)
  WHERE integrity = 'trusted';

CREATE INDEX idx_context_scope_pins_note
  ON context_scope_pins(note_space, note_id);

ALTER TABLE revision_purge_fences RENAME TO revision_purge_fences_baseline;

CREATE TABLE revision_purge_fences (
  kind TEXT NOT NULL CHECK (kind IN ('note', 'space')),
  entity_id TEXT NOT NULL,
  space TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, space)
);

INSERT INTO revision_purge_fences (kind, entity_id, space)
SELECT kind, entity_id, CASE WHEN kind = 'space' THEN entity_id ELSE '' END
  FROM revision_purge_fences_baseline;

DROP TABLE revision_purge_fences_baseline;

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

CREATE TRIGGER trg_purge_fence_requires_space
  BEFORE INSERT ON revision_purge_fences
  WHEN NEW.space IS NULL
BEGIN
  SELECT RAISE(ABORT, 'purge fence requires a space');
END;

CREATE TABLE revision_heads (
  space TEXT NOT NULL,
  note_id TEXT NOT NULL,
  revision_id INTEGER NOT NULL UNIQUE,
  semantic_fingerprint TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('live', 'deleted')),
  PRIMARY KEY (space, note_id)
);

INSERT INTO revision_heads (note_id, space, revision_id, semantic_fingerprint, lifecycle)
SELECT revisions.note_id,
       revisions.space,
       revisions.id,
       revisions.semantic_fingerprint,
       CASE WHEN revisions.kind = 'delete' THEN 'deleted' ELSE 'live' END
  FROM note_revisions AS revisions
 WHERE revisions.integrity = 'trusted'
   AND revisions.id = (
     SELECT MAX(candidate.id)
       FROM note_revisions AS candidate
      WHERE candidate.space = revisions.space
        AND candidate.note_id = revisions.note_id
        AND candidate.integrity = 'trusted'
   );

CREATE INDEX idx_revision_heads_space
  ON revision_heads(space, revision_id);

CREATE TRIGGER trg_revision_head_advance
AFTER INSERT ON note_revisions
FOR EACH ROW
WHEN NEW.integrity = 'trusted'
BEGIN
  INSERT INTO revision_heads
    (note_id, space, revision_id, semantic_fingerprint, lifecycle)
  VALUES (
    NEW.note_id,
    NEW.space,
    NEW.id,
    NEW.semantic_fingerprint,
    CASE WHEN NEW.kind = 'delete' THEN 'deleted' ELSE 'live' END
  )
  ON CONFLICT(space, note_id) DO UPDATE SET
    revision_id = excluded.revision_id,
    semantic_fingerprint = excluded.semantic_fingerprint,
    lifecycle = excluded.lifecycle;
END;
