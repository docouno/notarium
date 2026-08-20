CREATE TABLE ability_preferences (
  owner            TEXT NOT NULL,
  locator          TEXT NOT NULL,
  space_id         TEXT,
  registry_note_id TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (owner, locator),
  -- An Owned override is found again by the lifecycle that ends it, so it carries
  -- both keys or neither: a System package has no registry note and no Space to be
  -- purged with. Everything else about the ability is inside the canonical locator.
  CHECK ((space_id IS NULL) = (registry_note_id IS NULL))
);

CREATE INDEX ability_preferences_lifecycle
  ON ability_preferences (space_id, registry_note_id);

-- A placement move rewrites the locator for EVERY owner at once, so it can name no
-- prefix of the `(owner, locator)` primary key. Without this index that rewrite is a
-- full scan of every owner's overrides in the installation.
CREATE INDEX ability_preferences_locator
  ON ability_preferences (locator);
