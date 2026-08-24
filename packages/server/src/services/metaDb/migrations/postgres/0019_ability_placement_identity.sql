-- Bind each placement hop to both identities of the package that moved: the registry
-- note projected by the read model and the owner claim in physical SKILL.md bytes.
-- Claim arbitration may make them different. Existing 0016 rows cannot be backfilled
-- from an opaque locator and remain NULL deliberately: they still retire their source
-- address, but a resolver cannot prove the target and therefore fails closed.
ALTER TABLE ability_placement_trail ADD COLUMN registry_note_id TEXT;
ALTER TABLE ability_placement_trail ADD COLUMN manifest_note_id TEXT;

-- NOT VALID preserves legacy NULL rows but enforces both identities on every new or
-- rewritten row. The move producer rewrites historical rows with the pair it proved.
ALTER TABLE ability_placement_trail
  ADD CONSTRAINT ability_placement_trail_registry_note_id
  CHECK (registry_note_id IS NOT NULL AND manifest_note_id IS NOT NULL) NOT VALID;
