// Reconstruct the archival tables on an empty current SQLite or PostgreSQL target.
pub fn remove_later_features(version: u32, checksum: &str) -> &'static [&'static str] {
    const WITHOUT_AGENTS: &str = include_str!("schema-v8-remove-agents.sql");
    const WITHOUT_PROJECTIONS: &str = include_str!("schema-v6-remove-projection.sql");
    const OLD_CHAT_REFS: &str = include_str!("schema-v7-chat-refs.sql");

    match (version, checksum) {
        (1..=6, _) => &[WITHOUT_AGENTS, WITHOUT_PROJECTIONS],
        (7, "1a3cfcfe1c2d78948310fb1dafb04dba99e243ea821626e2de4d7009c3aa22b9") => {
            &[WITHOUT_AGENTS, OLD_CHAT_REFS]
        }
        (8, "085e724d4cf969a85265d36b616fe04bc78a51c3beadf86dee7f1664bee2dcd7") => {
            &[WITHOUT_AGENTS]
        }
        (9, "a906f0cf2dc6d4948cd01b180491c1cbe796160ef88e18a706a96e7f36c8fd84") => &[],
        _ => panic!("unsupported archival layout v{version} with checksum {checksum}"),
    }
}
