-- The caller supplies requested(note_id) from this rollback. Each subquery
-- probes a single note with the composite Space and note key.
-- room_status: NULL = no session, 0 = clean closed, 1 = active/dirty/pending, 2 = fenced.
SELECT requested.note_id,
       COALESCE((SELECT TRUE FROM revision_purge_fences p
                 WHERE p.space_id = $1 AND p.note_id = requested.note_id), FALSE) AS purged,
       (SELECT CASE
               WHEN s.room_state = 'fenced' THEN 2
               WHEN s.room_state <> 'closed' OR COALESCE(c.carrier_dirty, 0) <> 0
                    OR EXISTS (SELECT 1 FROM collab_update_log u
                               WHERE u.space_id = s.space_id AND u.note_id = s.note_id) THEN 1
               ELSE 0
               END
        FROM collab_sessions s LEFT JOIN collab_checkpoints c USING (space_id, note_id)
        WHERE s.space_id = $1 AND s.note_id = requested.note_id) AS room_status
FROM requested
