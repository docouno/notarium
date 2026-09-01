CREATE TABLE activity_projection_status (
  space TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ready', 'rebuilding')),
  legacy_through_revision_id BIGINT,
  next_source_ordinal BIGINT NOT NULL CHECK (next_source_ordinal >= 0),
  generation_counter BIGINT NOT NULL CHECK (generation_counter > 0),
  active_generation BIGINT,
  active_through BIGINT,
  build_generation BIGINT,
  rebuild_cursor BIGINT,
  rebuild_target BIGINT,
  source_generation BIGINT NOT NULL CHECK (source_generation > 0),
  build_source_generation BIGINT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'ready' AND active_generation IS NOT NULL AND build_generation IS NULL)
    OR state = 'rebuilding'
  )
);

CREATE TABLE activity_revision_order (
  space TEXT NOT NULL,
  source_ordinal BIGINT NOT NULL,
  revision_id BIGINT NOT NULL UNIQUE,
  PRIMARY KEY (space, source_ordinal)
);

CREATE INDEX idx_activity_revision_order_space_revision
  ON activity_revision_order(space, revision_id);

CREATE TABLE activity_note_actor_states (
  space TEXT NOT NULL,
  generation BIGINT NOT NULL,
  source_ordinal BIGINT NOT NULL,
  revision_id BIGINT NOT NULL,
  note_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('principal', 'external', 'gap')),
  actor_key TEXT NOT NULL,
  class_key TEXT NOT NULL,
  event_count BIGINT NOT NULL CHECK (event_count > 0),
  chars_added_sum BIGINT NOT NULL,
  chars_added_known BIGINT NOT NULL CHECK (chars_added_known >= 0),
  chars_removed_sum BIGINT NOT NULL,
  chars_removed_known BIGINT NOT NULL CHECK (chars_removed_known >= 0),
  PRIMARY KEY (space, generation, source_ordinal),
  UNIQUE (space, generation, revision_id)
);

CREATE INDEX idx_activity_states_bucket_source
  ON activity_note_actor_states(
    space, generation, note_id, actor_kind, actor_key, class_key, source_ordinal
  );

CREATE TABLE activity_note_actor_heads (
  space TEXT NOT NULL,
  generation BIGINT NOT NULL,
  note_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('principal', 'external', 'gap')),
  actor_key TEXT NOT NULL,
  class_key TEXT NOT NULL,
  source_ordinal BIGINT NOT NULL,
  revision_id BIGINT NOT NULL,
  PRIMARY KEY (space, generation, note_id, actor_kind, actor_key, class_key)
);

CREATE INDEX idx_activity_heads_space_generation
  ON activity_note_actor_heads(
    space, generation, actor_kind, actor_key, class_key, note_id, source_ordinal, revision_id
  );

CREATE TABLE activity_projection_gc (
  space TEXT NOT NULL,
  generation BIGINT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('states', 'heads')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space, generation)
);

-- A journal row belongs permanently to the Space in which it was committed.
-- Rehoming it would split the raw journal from both the per-Space order ledger
-- and the generation whose cumulative state already includes the row.
CREATE FUNCTION enforce_note_revision_space_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF OLD.space IS DISTINCT FROM NEW.space THEN
    RAISE EXCEPTION 'note revision space is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_note_revision_space_immutable
BEFORE UPDATE OF space ON note_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_note_revision_space_immutable();

CREATE FUNCTION advance_activity_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  projection activity_projection_status%ROWTYPE;
  legacy_max BIGINT;
  ordinal BIGINT;
  bucket_actor_kind TEXT;
  bucket_actor_key TEXT;
  bucket_class_key TEXT;
  previous activity_note_actor_states%ROWTYPE;
BEGIN
  SELECT * INTO projection
    FROM activity_projection_status
   WHERE space = NEW.space
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT MAX(revisions.id)
      INTO legacy_max
      FROM note_revisions AS revisions
     WHERE revisions.space = NEW.space
       AND revisions.id <> NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM activity_revision_order AS ordered
          WHERE ordered.revision_id = revisions.id
       );

    INSERT INTO activity_projection_status (
      space, state, legacy_through_revision_id, next_source_ordinal,
      generation_counter, active_generation, active_through,
      build_generation, rebuild_cursor, rebuild_target,
      source_generation, build_source_generation, last_error_code, updated_at
    )
    VALUES (
      NEW.space,
      CASE WHEN legacy_max IS NULL THEN 'ready' ELSE 'rebuilding' END,
      legacy_max,
      COALESCE(legacy_max, 0),
      1,
      CASE WHEN legacy_max IS NULL THEN 1 ELSE NULL END,
      NULL,
      CASE WHEN legacy_max IS NULL THEN NULL ELSE 1 END,
      CASE WHEN legacy_max IS NULL THEN NULL ELSE 0 END,
      legacy_max,
      1,
      CASE WHEN legacy_max IS NULL THEN NULL ELSE 1 END,
      NULL,
      CURRENT_TIMESTAMP::text
    )
    ON CONFLICT (space) DO NOTHING;

    SELECT * INTO projection
      FROM activity_projection_status
     WHERE space = NEW.space
     FOR UPDATE;
  END IF;

  ordinal := projection.next_source_ordinal + 1;

  INSERT INTO activity_revision_order (space, source_ordinal, revision_id)
  VALUES (NEW.space, ordinal, NEW.id);

  UPDATE activity_projection_status
     SET next_source_ordinal = ordinal,
         active_through = CASE WHEN state = 'ready' THEN ordinal ELSE active_through END,
         rebuild_target = CASE WHEN state = 'rebuilding' THEN ordinal ELSE rebuild_target END,
         updated_at = CURRENT_TIMESTAMP::text
   WHERE space = NEW.space;

  IF projection.state <> 'ready'
     OR (NEW.integrity = 'trusted' AND NEW.entry_role = 'baseline') THEN
    RETURN NEW;
  END IF;

  bucket_actor_kind := CASE
    WHEN NEW.integrity <> 'trusted' THEN 'gap'
    WHEN NEW.principal IS NULL THEN 'external'
    ELSE 'principal'
  END;
  bucket_actor_key := CASE WHEN bucket_actor_kind = 'principal' THEN NEW.principal ELSE '' END;
  bucket_class_key := CASE
    WHEN bucket_actor_kind = 'gap' THEN ''
    ELSE COALESCE(NEW.class, '')
  END;

  SELECT states.* INTO previous
    FROM activity_note_actor_heads AS heads
    JOIN activity_note_actor_states AS states
      ON states.space = heads.space
     AND states.generation = heads.generation
     AND states.source_ordinal = heads.source_ordinal
   WHERE heads.space = NEW.space
     AND heads.generation = projection.active_generation
     AND heads.note_id = NEW.note_id
     AND heads.actor_kind = bucket_actor_kind
     AND heads.actor_key = bucket_actor_key
     AND heads.class_key = bucket_class_key;

  INSERT INTO activity_note_actor_states (
    space, generation, source_ordinal, revision_id, note_id,
    actor_kind, actor_key, class_key,
    event_count, chars_added_sum, chars_added_known,
    chars_removed_sum, chars_removed_known
  )
  VALUES (
    NEW.space, projection.active_generation, ordinal, NEW.id, NEW.note_id,
    bucket_actor_kind, bucket_actor_key, bucket_class_key,
    COALESCE(previous.event_count, 0) + 1,
    COALESCE(previous.chars_added_sum, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_added IS NOT NULL THEN NEW.chars_added ELSE 0 END,
    COALESCE(previous.chars_added_known, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_added IS NOT NULL THEN 1 ELSE 0 END,
    COALESCE(previous.chars_removed_sum, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_removed IS NOT NULL THEN NEW.chars_removed ELSE 0 END,
    COALESCE(previous.chars_removed_known, 0)
      + CASE WHEN NEW.integrity = 'trusted' AND NEW.chars_removed IS NOT NULL THEN 1 ELSE 0 END
  );

  INSERT INTO activity_note_actor_heads (
    space, generation, note_id, actor_kind, actor_key, class_key,
    source_ordinal, revision_id
  )
  VALUES (
    NEW.space, projection.active_generation, NEW.note_id,
    bucket_actor_kind, bucket_actor_key, bucket_class_key,
    ordinal, NEW.id
  )
  ON CONFLICT (space, generation, note_id, actor_kind, actor_key, class_key)
  DO UPDATE SET source_ordinal = EXCLUDED.source_ordinal, revision_id = EXCLUDED.revision_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_activity_projection_advance
AFTER INSERT ON note_revisions
FOR EACH ROW EXECUTE FUNCTION advance_activity_projection();

CREATE FUNCTION invalidate_activity_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  projection activity_projection_status%ROWTYPE;
  affected_space TEXT;
BEGIN
  affected_space := CASE WHEN TG_OP = 'DELETE' THEN OLD.space ELSE NEW.space END;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM activity_revision_order WHERE revision_id = OLD.id;
  END IF;

  SELECT * INTO projection
    FROM activity_projection_status
   WHERE space = affected_space
   FOR UPDATE;

  IF NOT FOUND OR (projection.active_generation IS NULL AND projection.build_generation IS NULL) THEN
    RETURN NULL;
  END IF;

  IF projection.active_generation IS NOT NULL THEN
    INSERT INTO activity_projection_gc (space, generation, phase, updated_at)
    VALUES (affected_space, projection.active_generation, 'states', CURRENT_TIMESTAMP::text)
    ON CONFLICT (space, generation) DO NOTHING;
  END IF;

  IF projection.build_generation IS NOT NULL THEN
    INSERT INTO activity_projection_gc (space, generation, phase, updated_at)
    VALUES (affected_space, projection.build_generation, 'states', CURRENT_TIMESTAMP::text)
    ON CONFLICT (space, generation) DO NOTHING;
  END IF;

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
         updated_at = CURRENT_TIMESTAMP::text
   WHERE space = affected_space;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_activity_projection_invalidate_update
AFTER UPDATE OF note_id, space, entry_role, principal, class, chars_added, chars_removed, integrity
ON note_revisions
FOR EACH ROW
WHEN (
  OLD.note_id IS DISTINCT FROM NEW.note_id
  OR OLD.space IS DISTINCT FROM NEW.space
  OR OLD.entry_role IS DISTINCT FROM NEW.entry_role
  OR OLD.principal IS DISTINCT FROM NEW.principal
  OR OLD.class IS DISTINCT FROM NEW.class
  OR OLD.chars_added IS DISTINCT FROM NEW.chars_added
  OR OLD.chars_removed IS DISTINCT FROM NEW.chars_removed
  OR OLD.integrity IS DISTINCT FROM NEW.integrity
)
EXECUTE FUNCTION invalidate_activity_projection();

CREATE TRIGGER trg_activity_projection_invalidate_delete
AFTER DELETE ON note_revisions
FOR EACH ROW EXECUTE FUNCTION invalidate_activity_projection();
