-- Visit each Space with active jobs of this kind once. Each successor seeks
-- past all jobs in the previous Space, including healthy running leases.
WITH RECURSIVE walk(space_id, eligible_space, prior_count) AS (
    VALUES (CAST($1 AS TEXT), CAST(NULL AS TEXT), CAST(0 AS BIGINT))
    UNION ALL
    SELECT (
        SELECT min(next_space) FROM (
            SELECT (SELECT j.space_id FROM content_jobs j WHERE j.state='queued'
                AND j.job_kind=$3 AND j.space_id>w.space_id
                ORDER BY j.space_id,j.created_seq,j.job_id LIMIT 1) AS next_space
            UNION ALL
            SELECT (SELECT j.space_id FROM content_jobs j WHERE j.state='running'
                AND j.job_kind=$3 AND j.space_id>w.space_id
                ORDER BY j.space_id,j.claim_space_epoch,j.lease_until_ms,j.created_seq,j.job_id LIMIT 1)
        ) AS successors
    ), CASE WHEN w.space_id>$1 AND EXISTS (
        SELECT 1 FROM spaces s WHERE s.space_id=w.space_id AND s.lifecycle_state='active'
          AND (
            (SELECT j.job_id FROM content_jobs j WHERE j.job_kind=$3 AND j.space_id=w.space_id
                AND j.state='queued' ORDER BY j.created_seq,j.job_id LIMIT 1) IS NOT NULL
            OR (SELECT j.job_id FROM content_jobs j WHERE j.job_kind=$3 AND j.space_id=w.space_id
                AND j.state='running' AND j.claim_space_epoch IS NULL
                ORDER BY j.lease_until_ms,j.created_seq,j.job_id LIMIT 1) IS NOT NULL
            OR (SELECT j.job_id FROM content_jobs j WHERE j.job_kind=$3 AND j.space_id=w.space_id
                AND j.state='running' AND j.claim_space_epoch<s.active_epoch
                ORDER BY j.claim_space_epoch,j.lease_until_ms,j.created_seq,j.job_id LIMIT 1) IS NOT NULL
            OR (SELECT j.job_id FROM content_jobs j WHERE j.job_kind=$3 AND j.space_id=w.space_id
                AND j.state='running' AND j.claim_space_epoch>s.active_epoch
                ORDER BY j.claim_space_epoch,j.lease_until_ms,j.created_seq,j.job_id LIMIT 1) IS NOT NULL
            OR (SELECT j.job_id FROM content_jobs j WHERE j.job_kind=$3 AND j.space_id=w.space_id
                AND j.state='running' AND j.claim_space_epoch=s.active_epoch AND j.lease_until_ms<=$4
                ORDER BY j.lease_until_ms,j.created_seq,j.job_id LIMIT 1) IS NOT NULL
          )
    ) THEN w.space_id END,
    w.prior_count + CASE WHEN w.eligible_space IS NULL THEN 0 ELSE 1 END
    FROM walk w WHERE w.space_id IS NOT NULL
      AND w.prior_count + CASE WHEN w.eligible_space IS NULL THEN 0 ELSE 1 END < $2
)
SELECT w.eligible_space, (SELECT s.history_incarnation FROM spaces s WHERE s.space_id=w.eligible_space)
FROM walk w WHERE w.eligible_space IS NOT NULL ORDER BY w.eligible_space
