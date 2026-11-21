COALESCE(
    (SELECT p.phase FROM pending_purges p
     WHERE p.space_id=s.space_id AND p.phase>'completed' ORDER BY p.phase LIMIT 1),
    (SELECT p.phase FROM pending_purges p
     WHERE p.space_id=s.space_id AND p.phase<'completed' ORDER BY p.phase DESC LIMIT 1)
) IS NOT NULL
