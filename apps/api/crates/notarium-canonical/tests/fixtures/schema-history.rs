// Reconstruct the archival tables on an empty current SQLite or PostgreSQL target.
// Before version 7 the shared predecessors need both sets of additions removed.
pub fn remove_later_features(version: u32, checksum: &str) -> &'static [&'static str] {
    const WITHOUT_AGENTS: &str = include_str!("schema-v8-remove-agents.sql");
    const WITHOUT_PROJECTIONS: &str = include_str!("schema-v6-remove-projection.sql");
    const OLD_CHAT_REFS: &str = include_str!("schema-v7-chat-refs.sql");
    const UNIQUE_ABILITY_SLOT: &str = "DROP INDEX idx_ability_packages_active_slug;
        CREATE UNIQUE INDEX uq_ability_packages_active_slug
            ON ability_packages(space_id,slug_fold) WHERE lifecycle_state='active'";

    match (version, checksum) {
        (1..=6, _) => &[WITHOUT_AGENTS, WITHOUT_PROJECTIONS],
        (7, "1a3cfcfe1c2d78948310fb1dafb04dba99e243ea821626e2de4d7009c3aa22b9") => {
            &[WITHOUT_AGENTS, OLD_CHAT_REFS]
        }
        (8, "085e724d4cf969a85265d36b616fe04bc78a51c3beadf86dee7f1664bee2dcd7") => {
            &[WITHOUT_AGENTS]
        }
        (7, "244ce610feed9e389063805c0c36190633a082df2b743fbf340c40418797e2a0") => {
            &[WITHOUT_PROJECTIONS, UNIQUE_ABILITY_SLOT]
        }
        (8, "ee1c8eada40f5ad7575b1fdf463b4e31961897dacfb81fd9aa549145d768100f") => {
            &[WITHOUT_PROJECTIONS]
        }
        _ => panic!("unsupported archival layout v{version} with checksum {checksum}"),
    }
}
