-- The same digest is owned by an invalidated summary in two Spaces.
-- Only Space B also has a surviving sibling owner.
WITH fresh(id,slug) AS (VALUES
 ('sp_000000000000000000000000000000a1','stale-alone'),
 ('sp_000000000000000000000000000000b1','stale-shared'))
INSERT INTO spaces SELECT id,substr(manifest_checksum,1,16),'fld_00000000000000000000000000000001',
    slug,slug,'personal','principal_00000000000000000000000000000001','active',1,6,'{}',0,0
    FROM fresh CROSS JOIN schema_meta;
INSERT INTO change_commands SELECT space_id,history_incarnation,'redact-ancestor',6,6,
    'redact_chat_entry',NULL,0 FROM spaces WHERE slug IN ('stale-alone','stale-shared');
INSERT INTO chat_threads SELECT space_id,history_incarnation,'thr_00000000000000000000000000000001','personal',owner_id,NULL,
    'test',4,'rev_00000000000000000000000000000004',5,NULL,0,1,6,0,0,0,0 FROM spaces WHERE slug IN ('stale-alone','stale-shared');
WITH entries(n,parent,kind,stale) AS (VALUES (1,NULL,'redacted',0),(2,1,'compaction',1),(3,1,'compaction',1),(4,NULL,'compaction',0))
INSERT INTO chat_entries(space_id,thread_id,entry_seq,parent_seq,revision_id,kind,author_id,inline_text,payload_blake3,
    referenced_notes_json,ext_space_tainted,is_chain_node,branch_depth,created_space_seq,redacted_at_seq,checkpoint_stale)
SELECT s.space_id,t.thread_id,n,parent,CAST(n AS TEXT),entries.kind,s.owner_id,
    CASE WHEN n=3 THEN 'old retained inline summary' WHEN n=4 AND s.slug='stale-alone' THEN 'surviving summary' END,
    CASE WHEN n=2 OR (n=4 AND s.slug='stale-shared') THEN body_digest END,
    CASE WHEN stale=1 THEN '["sensitive-reference"]' ELSE '[]' END,0,1,
    CASE WHEN parent IS NULL THEN 1 ELSE 2 END,n+1,CASE WHEN n=1 THEN 6 END,stale
FROM spaces s JOIN chat_threads t ON t.space_id=s.space_id CROSS JOIN entries CROSS JOIN fixture_blob
WHERE s.slug IN ('stale-alone','stale-shared');
INSERT INTO blob_catalog(space_id,content_blake3,raw_size,compressed_size,ref_count,
    current_publication_id,admission_state,blob_state,touched_at_ms)
    SELECT space_id,body_digest,600,compressed_size,CASE WHEN slug='stale-alone' THEN 1 ELSE 2 END,
    'pub1','open','active',0 FROM spaces CROSS JOIN fixture_blob WHERE slug IN ('stale-alone','stale-shared');
INSERT INTO blob_publications SELECT space_id,'pub1',body_digest,1,'local_zstd_v1','active',1,1,600,compressed_size,0,0
    FROM spaces CROSS JOIN fixture_blob WHERE slug IN ('stale-alone','stale-shared');
INSERT INTO blob_references SELECT space_id,'chat_entry',thread_id || ':' || CAST(entry_seq AS TEXT),
    revision_id,'body',payload_blake3,'pub1',created_space_seq FROM chat_entries
    WHERE payload_blake3 IS NOT NULL AND space_id IN (SELECT space_id FROM spaces WHERE slug IN ('stale-alone','stale-shared'));
INSERT INTO change_payloads SELECT e.space_id,'detail-' || e.revision_id,'receipt_detail_v1',0,manifest_checksum,created_space_seq
    FROM chat_entries e JOIN spaces s ON s.space_id=e.space_id CROSS JOIN schema_meta
    WHERE s.slug IN ('stale-alone','stale-shared') AND e.kind='compaction';
INSERT INTO command_receipts SELECT e.space_id,s.history_incarnation,s.owner_id,e.revision_id,manifest_checksum,'completed',1,
    'detail-' || e.revision_id,manifest_checksum,created_space_seq,9999999999999
    FROM chat_entries e JOIN spaces s ON s.space_id=e.space_id CROSS JOIN schema_meta
    WHERE s.slug IN ('stale-alone','stale-shared') AND e.kind='compaction';
