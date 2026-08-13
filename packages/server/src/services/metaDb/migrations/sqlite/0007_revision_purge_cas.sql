-- SQLite has no session protocol token. BEGIN IMMEDIATE in the application
-- serializes append and compare-and-purge before either observes lifecycle state.
ALTER TABLE note_revisions
  ADD COLUMN document_format TEXT
  CHECK (
    document_format IS NULL OR
    document_format IN ('markdown-v2', 'skill-markdown-v1', 'opaque-v1')
  );

-- SQLite's dynamic typing already stores Uint8Array values as BLOB in the
-- existing TEXT-affinity column. Legacy TEXT rows deliberately remain TEXT.
