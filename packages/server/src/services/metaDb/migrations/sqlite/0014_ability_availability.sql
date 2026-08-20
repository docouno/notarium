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
-- foreign key to `spaces` this meta-DB has ever had; PostgreSQL cannot keep it (the
-- implicit `FOR KEY SHARE` it takes on the space row inverts the tier-4 lock order
-- against `purgeSpace`, which is a `40P01` on a live write), and a schema that
-- disagrees between the dialects is its own defect. Nothing is lost here: the delete
-- trigger below already restates the cascade, and the writer asks
-- `services/metaDb/abilityLifecycle` whether the target is alive before it writes.

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

-- A RETYPE carries no key change — a project row becoming a plain folder, or moving
-- to another Space, keeps its id — so no foreign key can see it and the trigger below
-- is the only cascade there is. The two delete triggers restate cascades the keys
-- above already give on a connection with foreign_keys on (which `node:sqlite` gives
-- by default): they cost one redundant delete and hold if a host ever turns it off.
CREATE TRIGGER trg_ability_bindings_delete_project
AFTER DELETE ON folders
BEGIN
  DELETE FROM ability_project_bindings WHERE project_id = OLD.id;
END;

CREATE TRIGGER trg_ability_bindings_retype_project
AFTER UPDATE OF type, space ON folders
WHEN NEW.type <> 'project' OR NEW.space <> OLD.space
BEGIN
  DELETE FROM ability_project_bindings WHERE project_id = OLD.id;
END;

CREATE TRIGGER trg_ability_availability_delete_space
AFTER DELETE ON spaces
BEGIN
  DELETE FROM ability_project_bindings WHERE home_space = OLD.id;
  DELETE FROM ability_availability WHERE home_space = OLD.id;
END;
