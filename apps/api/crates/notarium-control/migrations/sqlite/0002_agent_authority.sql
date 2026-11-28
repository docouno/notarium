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
    CHECK (instr(title,char(0))=0 AND ((deleted_at IS NULL AND length(CAST(title AS BLOB)) BETWEEN 1 AND 512) OR (deleted_at IS NOT NULL AND length(CAST(title AS BLOB)) <= 512))),
    CHECK (instr(init_prompt,char(0))=0 AND ((deleted_at IS NULL AND length(CAST(init_prompt AS BLOB)) BETWEEN 1 AND 32768) OR (deleted_at IS NOT NULL AND length(CAST(init_prompt AS BLOB)) <= 32768))),
    CHECK (instr(cron_expr,char(0))=0),
    CHECK (instr(timezone,char(0))=0),
    CHECK (instr(approved_role,char(0))=0),
    CHECK (instr(paused_reason,char(0))=0),
    CHECK (instr(budgets,char(0))=0),
    CHECK (instr(misfire_policy,char(0))=0),
    CHECK (coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (8 + coalesce(length(CAST(paused_reason AS BLOB)),0) + 8 + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048),
    CHECK (deleted_at IS NOT NULL OR coalesce(length(CAST(owner_id AS BLOB)),0) + coalesce(length(CAST(space_id AS BLOB)),0) + coalesce(length(CAST(project_folder_id AS BLOB)),0) + coalesce(length(CAST(schedule_id AS BLOB)),0) <= 2048)
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
SELECT schedule_id,owner_id,space_id,project_folder_id,CASE WHEN deleted_at IS NOT NULL THEN '' ELSE title END,init_prompt,cron_expr,timezone,approved_role,paused_reason,write_class_mask,budgets,misfire_policy,next_slot_utc_ms,deleted_at,config_revision,revision,created_at,updated_at FROM agent_schedules_v1;
INSERT INTO agent_schedule_runs(run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at)
SELECT run_id,schedule_id,slot_utc_ms,lease_epoch,claim_request_hash,claimed_schedule_revision,reserved_next_slot,status,started_at,finished_at,safe_result,owner_auth_version,config_revision,admission_epoch,history_scope,expires_at FROM agent_schedule_runs_v1;

DROP TABLE agent_schedule_runs_v1;
DROP TABLE agent_schedules_v1;

CREATE INDEX schedule_due ON agent_schedules(next_slot_utc_ms,schedule_id)
    WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms IS NOT NULL;
CREATE INDEX schedule_deleted ON agent_schedules(deleted_at,schedule_id)
    WHERE deleted_at IS NOT NULL;
CREATE INDEX schedule_owner ON agent_schedules(owner_id,space_id,schedule_id);
CREATE INDEX schedule_owner_live ON agent_schedules(owner_id,space_id,schedule_id)
    WHERE deleted_at IS NULL;
CREATE INDEX schedule_owner_project_live ON agent_schedules(owner_id,space_id,project_folder_id,schedule_id)
    WHERE deleted_at IS NULL;
CREATE INDEX schedule_run_status ON agent_schedule_runs(schedule_id,status,slot_utc_ms,run_id);
CREATE INDEX schedule_run_retention ON agent_schedule_runs(finished_at,run_id)
    WHERE status IN ('succeeded','failed','unknown') AND finished_at IS NOT NULL;
CREATE INDEX schedule_expired_run ON agent_schedule_runs(expires_at,run_id)
    WHERE status IN ('claimed','running');
CREATE INDEX episode_owner_name_open ON agent_episodes(owner_id,name,episode_id)
    WHERE lifecycle <> 'closed';
ALTER TABLE provider_attachments RENAME TO provider_attachments_v1;
CREATE TABLE provider_attachments (
    id TEXT NOT NULL PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES provider_resources(id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('personal','space','project')),
    target_owner TEXT, target_space TEXT NOT NULL, target_project TEXT,
    resource_epoch INTEGER NOT NULL CHECK (resource_epoch>=0), credential_epoch INTEGER CHECK (credential_epoch>=0),
    state TEXT NOT NULL CHECK (state IN ('pending','approved','revoked')),
    disclosure TEXT NOT NULL, expires_at INTEGER, revision INTEGER NOT NULL CHECK (revision>=0),
    CHECK ((target_kind='personal')=(target_owner IS NOT NULL)),
    CHECK ((target_kind='project')=(target_project IS NOT NULL)),
    CHECK (instr(id,char(0))=0),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(target_kind,char(0))=0),
    CHECK (instr(target_owner,char(0))=0),
    CHECK (instr(target_space,char(0))=0),
    CHECK (instr(target_project,char(0))=0),
    CHECK (instr(state,char(0))=0),
    CHECK (instr(disclosure,char(0))=0),
    CHECK (coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_owner AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(resource_id AS BLOB)),0) + coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(target_project AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(state AS BLOB)),0) + coalesce(length(CAST(resource_id AS BLOB)),0) <= 2048),
    CHECK (state <> 'approved' OR coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(id AS BLOB)),0) <= 2048),
    CHECK (state <> 'approved' OR target_kind <> 'project' OR coalesce(length(CAST(target_space AS BLOB)),0) + coalesce(length(CAST(target_project AS BLOB)),0) + coalesce(length(CAST(id AS BLOB)),0) <= 2048)
) STRICT;
INSERT INTO provider_attachments(id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision)
SELECT id,resource_id,target_kind,target_owner,target_space,target_project,resource_epoch,credential_epoch,state,disclosure,expires_at,revision FROM provider_attachments_v1;
DROP TABLE provider_attachments_v1;
CREATE UNIQUE INDEX attachment_personal ON provider_attachments(resource_id,target_owner,target_space) WHERE target_kind='personal';
CREATE UNIQUE INDEX attachment_space ON provider_attachments(resource_id,target_space) WHERE target_kind='space';
CREATE UNIQUE INDEX attachment_project ON provider_attachments(resource_id,target_space,target_project) WHERE target_kind='project';
CREATE INDEX attachment_target ON provider_attachments(target_space,state,resource_id);
CREATE INDEX attachment_resource ON provider_attachments(resource_id,id);
CREATE INDEX attachment_target_approved_id ON provider_attachments(target_space,id)
    WHERE state = 'approved';
CREATE INDEX attachment_target_project_approved_id ON provider_attachments(target_space,target_project,id)
    WHERE state = 'approved' AND target_kind = 'project';

ALTER TABLE provider_call_log RENAME TO provider_call_log_v1;
CREATE TABLE provider_call_log (
    call_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, principal TEXT NOT NULL, run_id TEXT,
    scope_id TEXT NOT NULL, intent_key TEXT NOT NULL, request_hash BLOB NOT NULL CHECK (length(request_hash)=32),
    resource_id TEXT NOT NULL, credential_id TEXT, policy_epochs TEXT NOT NULL, participating_spaces TEXT NOT NULL,
    model_id TEXT, reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens>=0), bucket_keys TEXT NOT NULL,
    delivery_state TEXT NOT NULL CHECK (delivery_state IN ('intent','sending','settled')),
    outcome TEXT CHECK (outcome IN ('completed','not_sent','unknown','failed','cancelled')),
    usage_source TEXT NOT NULL CHECK (usage_source IN ('exact','unknown','estimate')),
    input_tokens INTEGER CHECK (input_tokens>=0), output_tokens INTEGER CHECK (output_tokens>=0),
    diagnostic TEXT, dispatch_owner TEXT, created_at INTEGER NOT NULL, settled_at INTEGER,
    UNIQUE(principal,scope_id,intent_key),
    CHECK (instr(call_id,char(0))=0),
    CHECK (instr(owner_id,char(0))=0),
    CHECK (instr(principal,char(0))=0),
    CHECK (instr(run_id,char(0))=0),
    CHECK (instr(scope_id,char(0))=0),
    CHECK (instr(intent_key,char(0))=0),
    CHECK (instr(resource_id,char(0))=0),
    CHECK (instr(credential_id,char(0))=0),
    CHECK (instr(policy_epochs,char(0))=0),
    CHECK (instr(participating_spaces,char(0))=0),
    CHECK (instr(model_id,char(0))=0),
    CHECK (instr(bucket_keys,char(0))=0),
    CHECK (instr(delivery_state,char(0))=0),
    CHECK (instr(outcome,char(0))=0),
    CHECK (instr(usage_source,char(0))=0),
    CHECK (instr(diagnostic,char(0))=0),
    CHECK (instr(dispatch_owner,char(0))=0),
    CHECK (coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(principal AS BLOB)),0) + coalesce(length(CAST(scope_id AS BLOB)),0) + coalesce(length(CAST(intent_key AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(owner_id AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(delivery_state AS BLOB)),0) + 8 + coalesce(length(CAST(call_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(run_id AS BLOB)),0) + coalesce(length(CAST(call_id AS BLOB)),0) <= 2088)
) STRICT;
INSERT INTO provider_call_log(call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at)
SELECT call_id,owner_id,principal,run_id,scope_id,intent_key,request_hash,resource_id,credential_id,policy_epochs,participating_spaces,model_id,reserved_tokens,bucket_keys,delivery_state,outcome,usage_source,input_tokens,output_tokens,diagnostic,dispatch_owner,created_at,settled_at FROM provider_call_log_v1;
DROP TABLE provider_call_log_v1;
CREATE INDEX call_owner ON provider_call_log(owner_id,created_at,call_id);
CREATE INDEX call_pending ON provider_call_log(delivery_state,created_at,call_id);
CREATE INDEX call_settled ON provider_call_log(delivery_state,settled_at,call_id);
CREATE INDEX call_run ON provider_call_log(run_id,call_id);
ALTER TABLE ability_placement_trail RENAME TO ability_placement_trail_v1;
CREATE TABLE ability_placement_trail (
    source_placement TEXT NOT NULL, ability_id TEXT NOT NULL, destination_placement TEXT NOT NULL,
    destination_id TEXT NOT NULL, manifest_ref TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(source_placement,ability_id),
    CHECK (source_placement<>destination_placement OR ability_id<>destination_id),
    CHECK (instr(source_placement,char(0))=0),
    CHECK (instr(ability_id,char(0))=0),
    CHECK (instr(destination_placement,char(0))=0),
    CHECK (instr(destination_id,char(0))=0),
    CHECK (instr(manifest_ref,char(0))=0),
    CHECK (coalesce(length(CAST(source_placement AS BLOB)),0) + coalesce(length(CAST(ability_id AS BLOB)),0) <= 2048),
    CHECK (coalesce(length(CAST(destination_placement AS BLOB)),0) + coalesce(length(CAST(destination_id AS BLOB)),0) <= 2048)
) STRICT;
INSERT INTO ability_placement_trail(source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at)
SELECT source_placement,ability_id,destination_placement,destination_id,manifest_ref,created_at FROM ability_placement_trail_v1;
DROP TABLE ability_placement_trail_v1;
CREATE INDEX ability_trail_destination ON ability_placement_trail(destination_placement,destination_id);
CREATE INDEX ability_preference_placement ON ability_preferences(placement,ability_id,owner_id);
CREATE INDEX favorite_note_order ON favorites(owner_id,rank,space_id,entity_id)
    WHERE entity_kind = 'note';
CREATE INDEX context_order_lookup ON context_order(target_kind,target_id,entry_kind,entry_ref,rank);
