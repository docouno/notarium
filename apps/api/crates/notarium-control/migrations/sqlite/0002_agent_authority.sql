ALTER TABLE pats ADD COLUMN ability_write INTEGER NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));
ALTER TABLE oauth_grants ADD COLUMN ability_write INTEGER NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));
ALTER TABLE oauth_access_tokens ADD COLUMN ability_write INTEGER NOT NULL DEFAULT 0
    CHECK (ability_write IN (0, 1) AND (ability_write = 0 OR scope = 'write'));

-- Preserve the 0001 tables and checks while making terminal calendar slots nullable.
-- Neither table is referenced by a third table. Rename the child first and copy
-- both tables with foreign-key enforcement still enabled.
ALTER TABLE agent_schedule_runs RENAME TO agent_schedule_runs_v1;
ALTER TABLE agent_schedules RENAME TO agent_schedules_v1;

CREATE TABLE agent_schedules (
    schedule_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), space_id TEXT NOT NULL,
    project_folder_id TEXT, title TEXT NOT NULL, init_prompt TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL, approved_role TEXT NOT NULL,
    approved_skills TEXT NOT NULL DEFAULT '[]' CHECK (instr(approved_skills,char(0))=0 AND length(CAST(approved_skills AS BLOB))<=65536),
    paused_reason TEXT CHECK (paused_reason IN ('owner_revoked','role_changed','space_unavailable','budget_exceeded','manual')),
    write_class_mask INTEGER NOT NULL CHECK (write_class_mask=1), budgets TEXT NOT NULL,
    misfire_policy TEXT NOT NULL CHECK (misfire_policy='coalesce_latest'), next_slot_utc_ms INTEGER,
    deleted_at INTEGER, config_revision INTEGER NOT NULL CHECK (config_revision>=0), revision INTEGER NOT NULL CHECK (revision>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK (instr(schedule_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(space_id,char(0))=0),
    CHECK (instr(project_folder_id,char(0))=0),
    CHECK (instr(title,char(0))=0 AND length(CAST(title AS BLOB)) BETWEEN 1 AND 512),
    CHECK (instr(init_prompt,char(0))=0 AND ((deleted_at IS NULL AND length(CAST(init_prompt AS BLOB)) BETWEEN 1 AND 32768) OR (deleted_at IS NOT NULL AND length(CAST(init_prompt AS BLOB)) <= 32768))),
    CHECK (instr(cron_expr,char(0))=0),
    CHECK (instr(timezone,char(0))=0),
    CHECK (instr(approved_role,char(0))=0),
    CHECK (instr(paused_reason,char(0))=0),
    CHECK (instr(budgets,char(0))=0),
    CHECK (instr(misfire_policy,char(0))=0),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (8 + coalesce(length(CAST(paused_reason AS BLOB)),0) + 8 + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048)
) STRICT;

CREATE TABLE agent_schedule_runs (
    run_id TEXT NOT NULL PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES agent_schedules(schedule_id) ON DELETE RESTRICT,
    slot_utc_ms INTEGER NOT NULL, lease_epoch INTEGER NOT NULL CHECK (lease_epoch>0),
    claim_request_hash BLOB NOT NULL CHECK (length(claim_request_hash)=32),
    claimed_schedule_revision INTEGER NOT NULL CHECK (claimed_schedule_revision>=0), reserved_next_slot INTEGER,
    approved_skills TEXT NOT NULL DEFAULT '[]' CHECK (instr(approved_skills,char(0))=0 AND length(CAST(approved_skills AS BLOB))<=65536),
    keeper_log_id TEXT CHECK (instr(keeper_log_id,char(0))=0),
    keeper_project_folder_id TEXT CHECK (instr(keeper_project_folder_id,char(0))=0),
    status TEXT NOT NULL CHECK (status IN ('claimed','running','succeeded','failed','unknown')),
    started_at INTEGER NOT NULL, finished_at INTEGER, safe_result TEXT CHECK (length(safe_result)<=4096),
    owner_auth_version INTEGER NOT NULL CHECK (owner_auth_version>=0), config_revision INTEGER NOT NULL CHECK (config_revision>=0),
    admission_epoch INTEGER NOT NULL CHECK (admission_epoch>=0), history_scope TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at>started_at),
    UNIQUE(schedule_id,slot_utc_ms), CHECK (reserved_next_slot IS NULL OR reserved_next_slot>slot_utc_ms),
    CHECK (keeper_log_id IS NOT NULL OR keeper_project_folder_id IS NULL),
    CHECK (instr(run_id,char(0))=0),
    CHECK (instr(schedule_id,char(0))=0),
    CHECK (instr(history_scope,char(0))=0 AND length(CAST(history_scope AS BLOB))<=2048),
    CHECK (instr(status,char(0))=0),
    CHECK (instr(safe_result,char(0))=0),
    CHECK (coalesce(length(CAST(run_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) + 8 <= 2048),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) + coalesce(length(CAST(status AS BLOB)),0) + 8 + coalesce(length(CAST(run_id AS BLOB)),0) <= 2048)
) STRICT;

INSERT INTO agent_schedules(schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at)
SELECT schedule_id,owner_id,space_id,project_folder_id,title,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at FROM agent_schedules_v1;
INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at)
SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at FROM agent_schedule_runs_v1;

DROP TABLE agent_schedule_runs_v1;
DROP TABLE agent_schedules_v1;

CREATE INDEX schedule_due ON agent_schedules(next_slot_utc_ms,schedule_id)
    WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms IS NOT NULL;
CREATE INDEX schedule_deleted ON agent_schedules(deleted_at,updated_at,schedule_id);
CREATE INDEX schedule_owner ON agent_schedules(owner_id,space_id,schedule_id);
CREATE INDEX schedule_run_status ON agent_schedule_runs(schedule_id,status,slot_utc_ms,run_id);
CREATE INDEX schedule_run_retention ON agent_schedule_runs(status,finished_at,run_id);
CREATE INDEX schedule_expired_run ON agent_schedule_runs(expires_at,run_id)
    WHERE status IN ('claimed','running');
