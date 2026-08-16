ALTER TABLE note_identity
  ADD COLUMN legacy_name_aliases TEXT NOT NULL DEFAULT '[]';
