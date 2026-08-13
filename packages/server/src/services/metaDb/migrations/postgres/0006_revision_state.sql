ALTER TABLE note_revisions
  ADD COLUMN snapshot_format TEXT
  CHECK (snapshot_format IS NULL OR snapshot_format = 'markdown-v1');
