-- A legacy room with a checkpoint and tail, a delta-only room and a clean room.
INSERT INTO spaces (space_id, history_incarnation, root_folder_id, slug, slug_fold, space_kind,
                    owner_id, lifecycle_state, active_epoch, last_seq, settings_json, created_at_sec, created_at_nsec)
SELECT 'legacy-collab', substr(manifest_checksum, 1, 16), 'root', 'legacy', 'legacy', 'personal',
       'owner', 'active', 1, 2, '{}', 0, 0 FROM schema_meta;

INSERT INTO folder_heads (space_id, folder_id, parent_folder_id, is_root, slug, slug_fold, display_name,
                          is_project, lifecycle_state, rev_seq, head_rev_id, created_seq, updated_seq,
                          updated_at_sec, updated_at_nsec)
VALUES ('legacy-collab', 'root', NULL, 1, 'root', 'root', 'Root', 0, 'active', 0, 'root-rev', 0, 0, 0, 0);

WITH names(n) AS (VALUES ('checkpoint'), ('delta-only'), ('clean'))
INSERT INTO note_heads (space_id, note_id, parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                        head_rev_id, content_blake3, byte_size, lifecycle_state, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id)
SELECT 'legacy-collab', n, 'root', n, n, n, n, 'user-doc', 'rev', manifest_checksum, 1, 'active',
       1, 1, 0, 0, 0, 0, 'owner' FROM names CROSS JOIN schema_meta;

INSERT INTO collab_sessions (space_id, note_id, lease_epoch, lineage_epoch, carrier_rev_id, room_state,
                             updated_seq, yrs_snapshot_blob)
SELECT space_id, note_id, 7, 4, head_rev_id, 'closed', 1,
       CASE WHEN note_id = 'checkpoint' THEN content_blake3 END FROM note_heads WHERE space_id='legacy-collab';

INSERT INTO collab_update_log (space_id, note_id, lease_epoch, update_seq, update_bytes, created_at_ms)
SELECT space_id, note_id, 7, 1, content_blake3, 123 FROM note_heads
WHERE space_id='legacy-collab' AND note_id <> 'clean';

INSERT INTO backup_holds (backup_id, space_id, history_incarnation, owner_installation_id,
                          phase, cutoff_seq, witness_json, created_at_ms)
SELECT 'old-hold', space_id, history_incarnation, 'owner', 'pinned', 1, '{}', 0
FROM spaces WHERE space_id='legacy-collab';
