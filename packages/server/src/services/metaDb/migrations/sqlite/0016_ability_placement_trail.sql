-- Where an owned package's ADDRESS went when it changed placement.
--
-- The owner's `disabled` bit (0015) is keyed by the whole locator, placement included,
-- and a placement move rewrites that column for every owner at once. Serializing the
-- two writers is not enough on its own: whoever computed an address one statement
-- before the move committed still writes at the address the package has LEFT, and the
-- same ability at its live address reads as enabled again — a role its owner just
-- switched off, silently back on. The move is the only writer that knows both ends of
-- the hop, so the move records it here and every read and write of an override
-- resolves through it.
--
-- One hop deep, never a chain: a move OUT of an address rewrites the rows that pointed
-- AT it, and a move INTO an address deletes the row that pointed OUT of it. So
-- `from_locator` is always an address some package used to stand at, `to_locator` is
-- always where it stands now, and a promotion undone by hand leaves no cycle to walk.
CREATE TABLE ability_placement_trail (
  from_locator TEXT PRIMARY KEY,
  to_locator   TEXT NOT NULL,
  -- The lifecycle key, exactly as `ability_preferences` carries one: the whole-Space
  -- purge sweeps by it. An address whose Space cannot be read from it is not recorded
  -- at all rather than recorded unsweepable.
  space_id     TEXT NOT NULL,
  CHECK (from_locator <> to_locator)
);

-- The two sweeps this table has: the rewrite that keeps it one hop deep, and the purge
-- that ends it.
CREATE INDEX ability_placement_trail_to ON ability_placement_trail (to_locator);
CREATE INDEX ability_placement_trail_space ON ability_placement_trail (space_id);
