CREATE TABLE ability_availability (
  home_space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all-projects', 'selected-projects')),
  -- The registry note whose permanent purge ends this policy. NOT the package id:
  -- the package directory is named by the id its manifest declared, and claim
  -- arbitration can leave the note carrying a different one. A row that predates the
  -- writer knowing it stays NULL and is swept by the package id, which is exactly the
  -- pre-arbitration assumption and the best a row without the key can do.
  registry_note_id TEXT,
  PRIMARY KEY (home_space, package_id)
);

-- The home Space is a PLAIN COLUMN, like every other Space reference in this schema.
-- It was `REFERENCES spaces(id) ON DELETE CASCADE` until review round 4, and the only
-- foreign key to `spaces` this meta-DB has ever had. A foreign key is a lock statement
-- nobody writes: the `INSERT` took `FOR KEY SHARE` on the space row from the BOTTOM of
-- the lock ladder (L4a), while `purgeSpace` takes that same row `FOR UPDATE` above
-- `folders` (L4f) and descends past it — writer holds L4f and waits for the space row,
-- purge holds the space row and waits for L4f, PostgreSQL answers `40P01`. A `PUT
-- …/availability` racing a purge of its own Space got a 500 out of it.
--
-- Both halves of what the key did are done on purpose now, and better: the writer asks
-- `services/metaDb/abilityLifecycle` whether the target is still alive — under the
-- Space revision stripe, so the answer holds to COMMIT — and refuses with
-- `ABILITY_TARGET_PURGED` rather than a `23503` no route can tell from a bug; and
-- `purgeSpace` deletes these rows itself, in ladder order, before it deletes the Space.
-- canon: packages/server/src/services/metaDb/drivers/pg/lockOrder.ts

CREATE TABLE ability_project_bindings (
  home_space TEXT NOT NULL,
  package_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (home_space, package_id, project_id),
  FOREIGN KEY (home_space, package_id)
    REFERENCES ability_availability(home_space, package_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX idx_ability_project_bindings_project
  ON ability_project_bindings(project_id);

-- The key the permanent note purge sweeps by.
CREATE INDEX idx_ability_availability_registry_note
  ON ability_availability(home_space, registry_note_id);

CREATE FUNCTION cleanup_ability_project_bindings_on_folder_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type <> 'project' OR NEW.space <> OLD.space THEN
    DELETE FROM ability_project_bindings WHERE project_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ability_bindings_retype_project
AFTER UPDATE OF type, space ON folders
FOR EACH ROW
EXECUTE FUNCTION cleanup_ability_project_bindings_on_folder_change();
