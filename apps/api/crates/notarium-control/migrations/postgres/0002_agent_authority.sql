ALTER TABLE v1_control.pats ADD COLUMN ability_write BIGINT NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));
ALTER TABLE v1_control.oauth_grants ADD COLUMN ability_write BIGINT NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));
ALTER TABLE v1_control.oauth_access_tokens ADD COLUMN ability_write BIGINT NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));

ALTER TABLE v1_control.agent_schedules
    ALTER COLUMN next_slot_utc_ms DROP NOT NULL,
    ADD COLUMN approved_skills TEXT COLLATE "C" NOT NULL DEFAULT '[]'
        CHECK (octet_length(approved_skills)<=65536);
ALTER TABLE v1_control.agent_schedule_runs
    ALTER COLUMN reserved_next_slot DROP NOT NULL,
    ADD COLUMN approved_skills TEXT COLLATE "C" NOT NULL DEFAULT '[]'
        CHECK (octet_length(approved_skills)<=65536),
    ADD COLUMN keeper_log_id TEXT COLLATE "C",
    ADD COLUMN keeper_project_folder_id TEXT COLLATE "C",
    ADD CHECK (keeper_log_id IS NOT NULL OR keeper_project_folder_id IS NULL);

DROP INDEX v1_control.schedule_due;
CREATE INDEX schedule_due ON v1_control.agent_schedules(next_slot_utc_ms,schedule_id)
    WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms IS NOT NULL;
DROP INDEX v1_control.schedule_deleted;
CREATE INDEX schedule_deleted ON v1_control.agent_schedules(deleted_at,updated_at,schedule_id)
    WHERE deleted_at IS NOT NULL;
DROP INDEX v1_control.schedule_run_retention;
CREATE INDEX schedule_run_retention ON v1_control.agent_schedule_runs(status,finished_at,run_id)
    WHERE status IN ('succeeded','failed','unknown');
CREATE INDEX schedule_expired_run ON v1_control.agent_schedule_runs(expires_at,run_id)
    WHERE status IN ('claimed','running');
CREATE INDEX call_run ON v1_control.provider_call_log(run_id,call_id);
CREATE INDEX ability_trail_destination ON v1_control.ability_placement_trail(destination_placement,destination_id);
CREATE INDEX ability_preference_placement ON v1_control.ability_preferences(placement,ability_id,owner_id);
