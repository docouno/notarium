-- Bind each placement hop to both identities of the package that moved: the registry
-- note projected by the read model and the owner claim in physical SKILL.md bytes.
-- Claim arbitration may make them different. Existing 0016 rows cannot be backfilled
-- from an opaque locator and remain NULL deliberately: they still retire their source
-- address, but a resolver cannot prove the target and therefore fails closed.
ALTER TABLE ability_placement_trail ADD COLUMN registry_note_id TEXT;
ALTER TABLE ability_placement_trail ADD COLUMN manifest_note_id TEXT;

-- All rows written by the new producer carry both identities. Triggers allow the legacy
-- NULL rows already present at migration time while refusing a new/re-written partial row.
CREATE TRIGGER ability_placement_trail_identity_insert
BEFORE INSERT ON ability_placement_trail
WHEN NEW.registry_note_id IS NULL OR NEW.manifest_note_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ability placement trail requires both note identities');
END;

CREATE TRIGGER ability_placement_trail_identity_update
BEFORE UPDATE ON ability_placement_trail
WHEN NEW.registry_note_id IS NULL OR NEW.manifest_note_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ability placement trail requires both note identities');
END;
