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
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT c.conname INTO constraint_name
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'v1_control.agent_schedules'::regclass
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%octet_length(title)%';
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE v1_control.agent_schedules DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;
ALTER TABLE v1_control.agent_schedules
    ADD CHECK ((deleted_at IS NULL AND octet_length(title) BETWEEN 1 AND 512) OR (deleted_at IS NOT NULL AND octet_length(title) <= 512));
ALTER TABLE v1_control.provider_call_log
    ADD CHECK (coalesce(octet_length(run_id),0) + coalesce(octet_length(call_id),0) <= 2048);
ALTER TABLE v1_control.provider_attachments
    ADD CHECK (coalesce(octet_length(target_space),0) + coalesce(octet_length(id),0) <= 2048),
    ADD CHECK (coalesce(octet_length(target_space),0) + coalesce(octet_length(target_project),0) + coalesce(octet_length(id),0) <= 2048);
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
CREATE INDEX schedule_deleted ON v1_control.agent_schedules(deleted_at,schedule_id)
    WHERE deleted_at IS NOT NULL;
CREATE INDEX schedule_owner_live ON v1_control.agent_schedules(owner_id,space_id,schedule_id)
    WHERE deleted_at IS NULL;
CREATE INDEX schedule_owner_project_live ON v1_control.agent_schedules(owner_id,space_id,project_folder_id,schedule_id)
    WHERE deleted_at IS NULL;
DROP INDEX v1_control.schedule_run_retention;
CREATE INDEX schedule_run_retention ON v1_control.agent_schedule_runs(finished_at,run_id)
    WHERE status IN ('succeeded','failed','unknown') AND finished_at IS NOT NULL;
CREATE INDEX schedule_expired_run ON v1_control.agent_schedule_runs(expires_at,run_id)
    WHERE status IN ('claimed','running');
CREATE INDEX episode_owner_name_open ON v1_control.agent_episodes(owner_id,name,episode_id)
    WHERE lifecycle <> 'closed';
CREATE INDEX attachment_target_approved_id ON v1_control.provider_attachments(target_space,id)
    WHERE state = 'approved';
CREATE INDEX attachment_target_project_approved_id ON v1_control.provider_attachments(target_space,target_project,id)
    WHERE state = 'approved' AND target_kind = 'project';
CREATE INDEX call_run ON v1_control.provider_call_log(run_id,call_id);
CREATE INDEX ability_trail_destination ON v1_control.ability_placement_trail(destination_placement,destination_id);
CREATE INDEX ability_preference_placement ON v1_control.ability_preferences(placement,ability_id,owner_id);
CREATE INDEX favorite_note_order ON v1_control.favorites(owner_id,rank,space_id,entity_id)
    WHERE entity_kind = 'note';
CREATE INDEX context_order_lookup ON v1_control.context_order(target_kind,target_id,entry_kind,entry_ref,rank);
