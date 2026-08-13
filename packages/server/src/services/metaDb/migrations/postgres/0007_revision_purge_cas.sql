CREATE OR REPLACE FUNCTION enforce_revision_purge_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('notarium.revision_purge_protocol', true) IS DISTINCT FROM 'v27' THEN
    RAISE EXCEPTION 'revision purge requires a fenced writer'
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$$;

ALTER TABLE note_revisions
  ADD COLUMN document_format TEXT
  CHECK (
    document_format IS NULL OR
    document_format IN ('markdown-v2', 'skill-markdown-v1', 'opaque-v1')
  );

ALTER TABLE revision_blobs
  ALTER COLUMN content TYPE BYTEA
  USING convert_to(content, 'UTF8');
