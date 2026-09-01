CREATE TABLE activity_projection_status (
  space TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ready', 'rebuilding')),
  legacy_through_revision_id INTEGER,
  next_source_ordinal INTEGER NOT NULL CHECK (next_source_ordinal >= 0),
  generation_counter INTEGER NOT NULL CHECK (generation_counter > 0),
  active_generation INTEGER,
  active_through INTEGER,
  build_generation INTEGER,
  rebuild_cursor INTEGER,
  rebuild_target INTEGER,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  build_source_generation INTEGER,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'ready' AND active_generation IS NOT NULL AND build_generation IS NULL)
    OR state = 'rebuilding'
  )
);

CREATE TABLE activity_revision_order (
  space TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  revision_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (space, source_ordinal)
);

CREATE INDEX idx_activity_revision_order_space_revision
  ON activity_revision_order(space, revision_id);

CREATE TABLE activity_note_actor_states (
  space TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_ordinal INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  note_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('principal', 'external', 'gap')),
  actor_key TEXT NOT NULL,
  class_key TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  chars_added_sum INTEGER NOT NULL,
  chars_added_known INTEGER NOT NULL CHECK (chars_added_known >= 0),
  chars_removed_sum INTEGER NOT NULL,
  chars_removed_known INTEGER NOT NULL CHECK (chars_removed_known >= 0),
  PRIMARY KEY (space, generation, source_ordinal),
  UNIQUE (space, generation, revision_id)
);

CREATE INDEX idx_activity_states_bucket_source
  ON activity_note_actor_states(
    space, generation, note_id, actor_kind, actor_key, class_key, source_ordinal
  );

CREATE TABLE activity_note_actor_heads (
  space TEXT NOT NULL,
  generation INTEGER NOT NULL,
  note_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('principal', 'external', 'gap')),
  actor_key TEXT NOT NULL,
  class_key TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  revision_id INTEGER NOT NULL,
  PRIMARY KEY (space, generation, note_id, actor_kind, actor_key, class_key)
);

CREATE INDEX idx_activity_heads_space_generation
  ON activity_note_actor_heads(
    space, generation, actor_kind, actor_key, class_key, note_id, source_ordinal, revision_id
  );

CREATE TABLE activity_projection_gc (
  space TEXT NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('states', 'heads')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space, generation)
);

-- A journal row belongs permanently to the Space in which it was committed.
-- Rehoming it would split the raw journal from both the per-Space order ledger
-- and the generation whose cumulative state already includes the row.
CREATE TRIGGER trg_note_revision_space_immutable
BEFORE UPDATE OF space ON note_revisions
FOR EACH ROW
WHEN OLD.space IS NOT NEW.space
BEGIN
  SELECT RAISE(ABORT, 'note revision space is immutable');
END;

CREATE TRIGGER trg_activity_projection_initialize
BEFORE INSERT ON note_revisions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM activity_projection_status AS existing WHERE existing.space = NEW.space
)
BEGIN
  INSERT INTO activity_projection_status (
    space, state, legacy_through_revision_id, next_source_ordinal,
    generation_counter, active_generation, active_through,
    build_generation, rebuild_cursor, rebuild_target,
    source_generation, build_source_generation, last_error_code, updated_at
  )
  SELECT
    NEW.space,
    CASE WHEN legacy.max_id IS NULL THEN 'ready' ELSE 'rebuilding' END,
    legacy.max_id,
    COALESCE(legacy.max_id, 0),
    1,
    CASE WHEN legacy.max_id IS NULL THEN 1 ELSE NULL END,
    NULL,
    CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 1 END,
    CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 0 END,
    legacy.max_id,
    1,
    CASE WHEN legacy.max_id IS NULL THEN NULL ELSE 1 END,
    NULL,
    CURRENT_TIMESTAMP
  FROM (
    SELECT MAX(revisions.id) AS max_id
      FROM note_revisions AS revisions
     WHERE revisions.space = NEW.space
       AND revisions.id <> NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM activity_revision_order AS ordered
          WHERE ordered.revision_id = revisions.id
       )
  ) AS legacy
  WHERE TRUE
  ON CONFLICT(space) DO NOTHING;
END;

CREATE TRIGGER trg_activity_projection_advance
AFTER INSERT ON note_revisions
FOR EACH ROW
BEGIN
  UPDATE activity_projection_status
     SET next_source_ordinal = next_source_ordinal + 1,
         active_through = CASE WHEN state = 'ready' THEN next_source_ordinal + 1 ELSE active_through END,
         rebuild_target = CASE WHEN state = 'rebuilding' THEN next_source_ordinal + 1 ELSE rebuild_target END,
         updated_at = CURRENT_TIMESTAMP
   WHERE space = NEW.space;

  INSERT INTO activity_revision_order (space, source_ordinal, revision_id)
  SELECT space, next_source_ordinal, NEW.id
    FROM activity_projection_status
   WHERE space = NEW.space;

  INSERT INTO activity_note_actor_states (
    space, generation, source_ordinal, revision_id, note_id,
    actor_kind, actor_key, class_key,
    event_count, chars_added_sum, chars_added_known,
    chars_removed_sum, chars_removed_known
  )
  SELECT
    status.space,
    status.active_generation,
    status.next_source_ordinal,
    NEW.id,
    NEW.note_id,
    bucket.actor_kind,
    bucket.actor_key,
    bucket.class_key,
    COALESCE(previous.event_count, 0) + 1,
    COALESCE(previous.chars_added_sum, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_added IS NOT NULL THEN NEW.chars_added ELSE 0 END,
    COALESCE(previous.chars_added_known, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_added IS NOT NULL THEN 1 ELSE 0 END,
    COALESCE(previous.chars_removed_sum, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_removed IS NOT NULL THEN NEW.chars_removed ELSE 0 END,
    COALESCE(previous.chars_removed_known, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_removed IS NOT NULL THEN 1 ELSE 0 END
  FROM activity_projection_status AS status
  JOIN (
    SELECT
      CASE
        WHEN NEW.integrity <> 'trusted' THEN 'gap'
        WHEN NEW.principal IS NULL THEN 'external'
        ELSE 'principal'
      END AS actor_kind,
      CASE
        WHEN NEW.integrity = 'trusted' AND NEW.principal IS NOT NULL THEN NEW.principal
        ELSE ''
      END AS actor_key,
      CASE WHEN NEW.integrity <> 'trusted' THEN '' ELSE COALESCE(NEW.class, '') END AS class_key
  ) AS bucket
  LEFT JOIN activity_note_actor_heads AS head
    ON head.space = status.space
   AND head.generation = status.active_generation
   AND head.note_id = NEW.note_id
   AND head.actor_kind = bucket.actor_kind
   AND head.actor_key = bucket.actor_key
   AND head.class_key = bucket.class_key
  LEFT JOIN activity_note_actor_states AS previous
    ON previous.space = head.space
   AND previous.generation = head.generation
   AND previous.source_ordinal = head.source_ordinal
  WHERE status.space = NEW.space
    AND status.state = 'ready'
    AND (NEW.integrity <> 'trusted' OR NEW.entry_role <> 'baseline');

  INSERT INTO activity_note_actor_heads (
    space, generation, note_id, actor_kind, actor_key, class_key,
    source_ordinal, revision_id
  )
  SELECT
    state.space, state.generation, state.note_id,
    state.actor_kind, state.actor_key, state.class_key,
    state.source_ordinal, state.revision_id
  FROM activity_note_actor_states AS state
  WHERE state.space = NEW.space
    AND state.source_ordinal = (
      SELECT next_source_ordinal FROM activity_projection_status WHERE space = NEW.space
    )
  ON CONFLICT(space, generation, note_id, actor_kind, actor_key, class_key)
  DO UPDATE SET source_ordinal = excluded.source_ordinal, revision_id = excluded.revision_id;
END;

CREATE TRIGGER trg_activity_projection_invalidate_update
AFTER UPDATE OF note_id, space, entry_role, principal, class, chars_added, chars_removed, integrity
ON note_revisions
FOR EACH ROW
WHEN (
  OLD.note_id IS NOT NEW.note_id
  OR OLD.space IS NOT NEW.space
  OR OLD.entry_role IS NOT NEW.entry_role
  OR OLD.principal IS NOT NEW.principal
  OR OLD.class IS NOT NEW.class
  OR OLD.chars_added IS NOT NEW.chars_added
  OR OLD.chars_removed IS NOT NEW.chars_removed
  OR OLD.integrity IS NOT NEW.integrity
)
AND EXISTS (
  SELECT 1
    FROM activity_projection_status AS status
   WHERE status.space = OLD.space
     AND (status.active_generation IS NOT NULL OR status.build_generation IS NOT NULL)
)
BEGIN
  INSERT OR IGNORE INTO activity_projection_gc (space, generation, phase, updated_at)
  SELECT space, active_generation, 'states', CURRENT_TIMESTAMP
    FROM activity_projection_status
   WHERE space = OLD.space AND active_generation IS NOT NULL;

  INSERT OR IGNORE INTO activity_projection_gc (space, generation, phase, updated_at)
  SELECT space, build_generation, 'states', CURRENT_TIMESTAMP
    FROM activity_projection_status
   WHERE space = OLD.space AND build_generation IS NOT NULL;

  UPDATE activity_projection_status
     SET state = 'rebuilding',
         active_generation = NULL,
         active_through = NULL,
         build_generation = NULL,
         rebuild_cursor = NULL,
         rebuild_target = next_source_ordinal,
         source_generation = source_generation + 1,
         build_source_generation = NULL,
         last_error_code = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE space = OLD.space;
END;

CREATE TRIGGER trg_activity_projection_invalidate_delete
AFTER DELETE ON note_revisions
FOR EACH ROW
BEGIN
  DELETE FROM activity_revision_order WHERE revision_id = OLD.id;

  INSERT OR IGNORE INTO activity_projection_gc (space, generation, phase, updated_at)
  SELECT space, active_generation, 'states', CURRENT_TIMESTAMP
    FROM activity_projection_status
   WHERE space = OLD.space AND active_generation IS NOT NULL;

  INSERT OR IGNORE INTO activity_projection_gc (space, generation, phase, updated_at)
  SELECT space, build_generation, 'states', CURRENT_TIMESTAMP
    FROM activity_projection_status
   WHERE space = OLD.space AND build_generation IS NOT NULL;

  UPDATE activity_projection_status
     SET state = 'rebuilding',
         active_generation = NULL,
         active_through = NULL,
         build_generation = NULL,
         rebuild_cursor = NULL,
         rebuild_target = next_source_ordinal,
         source_generation = source_generation + 1,
         build_source_generation = NULL,
         last_error_code = NULL,
         updated_at = CURRENT_TIMESTAMP
   WHERE space = OLD.space
     AND (active_generation IS NOT NULL OR build_generation IS NOT NULL);
END;
