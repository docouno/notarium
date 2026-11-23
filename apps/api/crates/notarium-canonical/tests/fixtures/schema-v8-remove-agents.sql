DROP INDEX IF EXISTS idx_chat_pending_inputs_consumed;
ALTER TABLE chat_entries DROP COLUMN provenance_json;
ALTER TABLE chat_entries DROP COLUMN body_format;
ALTER TABLE chat_entries DROP COLUMN human_origin;
ALTER TABLE chat_threads DROP COLUMN active_run_generation;
ALTER TABLE chat_threads DROP COLUMN active_run_epoch;
DROP INDEX idx_ability_packages_active_slug;
CREATE UNIQUE INDEX uq_ability_packages_active_slug
    ON ability_packages(space_id, slug_fold) WHERE lifecycle_state = 'active';
