use std::sync::LazyLock;

use super::ArchiveJobClass;

pub(super) const RUNNABLE_ARCHIVE_SCOPES: &str = include_str!("job_scopes.sql");

pub(super) fn candidate_sql(class: Option<ArchiveJobClass>, sqlite: bool) -> &'static str {
    static QUERIES: LazyLock<[[String; 3]; 2]> = LazyLock::new(|| {
        [false, true].map(|sqlite| {
            [
                None,
                Some(ArchiveJobClass::Import),
                Some(ArchiveJobClass::Export),
            ]
            .map(|class| build_candidate_sql(class, sqlite))
        })
    });
    let class_index = match class {
        None => 0,
        Some(ArchiveJobClass::Import) => 1,
        Some(ArchiveJobClass::Export) => 2,
    };
    &QUERIES[usize::from(sqlite)][class_index]
}

fn build_candidate_sql(class: Option<ArchiveJobClass>, sqlite: bool) -> String {
    let kinds: &[&str] = match class {
        None => &[
            "import", "export", "backup", "restore", "reindex", "reembed",
        ],
        Some(ArchiveJobClass::Import) => &["import"],
        Some(ArchiveJobClass::Export) => &["export"],
    };
    let fifo_index = if sqlite {
        " INDEXED BY idx_content_jobs_claim"
    } else {
        ""
    };
    let lease_index = if sqlite {
        " INDEXED BY idx_content_jobs_reclaim"
    } else {
        ""
    };
    let mut heads = Vec::new();
    // A generic claimant needs at most six FIFO heads regardless of queue depth.
    for kind in kinds {
        heads.push(format!(
            "SELECT * FROM (SELECT job_id,created_seq FROM content_jobs{fifo_index}
             WHERE state='queued' AND job_kind='{kind}'
               AND space_id=$1 AND (created_seq,job_id)>($3,$4)
             ORDER BY created_seq,job_id LIMIT 1) AS queued"
        ));
    }
    let kinds = kinds
        .iter()
        .map(|kind| format!("'{kind}'"))
        .collect::<Vec<_>>()
        .join(",");
    // Separate, disjoint index ranges keep healthy leases out of the FIFO sort.
    for eligibility in [
        "claim_space_epoch IS NULL",
        "claim_space_epoch<$5",
        "claim_space_epoch>$5",
        "claim_space_epoch=$5 AND lease_until_ms<=$2",
    ] {
        heads.push(format!(
            "SELECT * FROM (SELECT job_id,created_seq FROM content_jobs{lease_index}
             WHERE state='running' AND job_kind IN ({kinds}) AND space_id=$1
               AND {eligibility} AND (created_seq,job_id)>($3,$4)
             ORDER BY created_seq,job_id LIMIT 1) AS reclaimable"
        ));
    }
    format!(
        "{} ORDER BY created_seq,job_id LIMIT 1",
        heads.join(" UNION ALL ")
    )
}
