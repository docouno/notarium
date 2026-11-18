SELECT CAST(
  (SELECT count(*) FROM chat_entries e JOIN spaces s ON s.space_id=e.space_id
   WHERE s.slug IN ('stale-alone','stale-shared') AND e.checkpoint_stale=1 AND e.inline_text=''
     AND e.payload_blake3 IS NULL AND e.referenced_notes_json='[]') = 4
  AND (SELECT count(*) FROM command_receipts r JOIN spaces s ON s.space_id=r.space_id
       WHERE s.slug IN ('stale-alone','stale-shared') AND response_payload_id IS NULL) = 4
  AND (SELECT count(*) FROM change_payloads p JOIN spaces s ON s.space_id=p.space_id
       WHERE s.slug IN ('stale-alone','stale-shared') AND erased_by_purge=1 AND effect_msgpack IS NULL) = 4
  AND (SELECT count(*) FROM blob_references b JOIN spaces s ON s.space_id=b.space_id
       WHERE s.slug IN ('stale-alone','stale-shared')) = 1
  AND EXISTS (SELECT 1 FROM blob_catalog b JOIN spaces s ON s.space_id=b.space_id
              WHERE s.slug='stale-shared' AND ref_count=1 AND admission_state='open' AND current_publication_id='pub1')
  AND EXISTS (SELECT 1 FROM blob_catalog b JOIN spaces s ON s.space_id=b.space_id
              WHERE s.slug='stale-alone' AND ref_count=0 AND admission_state='retiring' AND current_publication_id IS NULL)
  AND (SELECT count(*) FROM blob_retirement_targets t JOIN spaces s ON s.space_id=t.space_id
       WHERE s.slug IN ('stale-alone','stale-shared')) = 1
  AND EXISTS (SELECT 1 FROM blob_retirement_targets t JOIN spaces s ON s.space_id=t.space_id
              WHERE s.slug='stale-alone' AND t.publication_id='pub1')
  AND (SELECT count(*) FROM command_receipts r JOIN spaces s ON s.space_id=r.space_id
       WHERE s.slug IN ('stale-alone','stale-shared') AND response_payload_id='detail-4')=2
 AS INTEGER)
