//! Historical membership from current heads, move aliases, and immutable revisions.
use super::*;

const PAGE: usize = 200;

macro_rules! candidate_probe {
    ($parents:literal, $head_index:literal, $alias_index:literal) => {
        concat!(
            "WITH parents(id) AS (", $parents, ")
             SELECT folder_id FROM folder_heads ", $head_index, "
             WHERE space_id=$1 AND parent_folder_id IN (SELECT id FROM parents) AND created_seq <= $2
             UNION ALL SELECT target_folder_id FROM folder_aliases ", $alias_index, "
             WHERE space_id=$1 AND old_parent_folder_id IN (SELECT id FROM parents) AND created_seq > $2
             LIMIT 201"
        )
    };
}
const SQLITE_HISTORICAL_CHILDREN: &str = candidate_probe!(
    "SELECT value FROM json_each($3)",
    "INDEXED BY idx_folder_heads_parent_lifecycle",
    "INDEXED BY idx_folder_aliases_lookup"
);
const PG_HISTORICAL_CHILDREN: &str = candidate_probe!(
    "SELECT jsonb_array_elements_text(CAST($3 AS JSONB))",
    "",
    ""
);

// Each arm seeks directly into (space, parent, lifecycle, folder_id). Merging
// the three ordered streams keeps the continuation stable across trash/restore.
macro_rules! heads {
    ($state:literal) => {
        concat!(
            "SELECT folder_id FROM folder_heads WHERE space_id=$1 AND created_seq <= $2
            AND parent_folder_id=$3 AND folder_id > $4 AND lifecycle_state='",
            $state,
            "' "
        )
    };
}
const HEADS: &str = concat!(
    heads!("active"),
    "UNION ALL ",
    heads!("trashed"),
    "UNION ALL ",
    heads!("purged"),
    "ORDER BY folder_id LIMIT 200"
);

// Alias keys are append-only. Use the primary key order, including its
// tiebreakers, so many moves sharing a slug never force a repeated sort.
const ALIASES: &str = "SELECT old_slug_fold,created_seq,target_folder_id FROM folder_aliases
    WHERE space_id=$1 AND old_parent_folder_id=$3 AND created_seq > $2
      AND (old_slug_fold,created_seq,target_folder_id) > ($4,$5,$6)
    ORDER BY old_slug_fold,created_seq,target_folder_id LIMIT 200";

enum ChildCursor {
    Heads(String),
    Aliases(String, i64, String),
}

impl CanonicalStore {
    /// A move atomically records the old parent as an alias. Resolve every
    /// candidate against its immutable revision to select the active children
    /// at the cut, including folders that subsequently moved away and back.
    pub async fn read_projection_folder_children_at_cut(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        cutoff: SpaceSeq,
        parents: &[FolderId],
    ) -> Result<Vec<FolderId>, PortError> {
        if parents.len() > PAGE {
            return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
        }
        let deadline = CommandDeadline::start(&ctx.budget, "read_projection_folder_children");
        let candidate_parents = parents.to_vec();
        let scope_for_keys = scope.clone();
        let small = self
            .with_projection_read(ctx, |tx| {
                Box::pin(async move {
                    checked_cut(tx, &scope_for_keys, cutoff).await?;
                    let sql = match tx {
                        BackendConn::Sqlite(_) => SQLITE_HISTORICAL_CHILDREN,
                        BackendConn::Postgres(_) => PG_HISTORICAL_CHILDREN,
                    };
                    let parents_json = serde_json::to_string(&candidate_parents)
                        .map_err(|_| corrupt("invalid historical folder IDs"))?;
                    let keys = read_rows!(
                        tx,
                        fetch_all,
                        "historical_folder_children",
                        (String,),
                        sql,
                        scope_for_keys.space_id.as_str(),
                        cutoff.get() as i64,
                        parents_json
                    )?;
                    if keys.len() > PAGE {
                        return Ok(None);
                    }
                    let keys = keys.into_iter().map(|(id,)| id).collect();
                    Ok(Some(
                        exact_children(tx, &scope_for_keys, cutoff, keys, &candidate_parents)
                            .await?,
                    ))
                })
            })
            .await?;
        if let Some(rows) = small {
            return Ok(rows);
        }

        let mut ctx = ctx.clone();
        let mut children = std::collections::BTreeSet::new();
        for parent in parents {
            let mut cursor = Some(ChildCursor::Heads(String::new()));
            while let Some(at) = cursor {
                ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
                let parent = parent.clone();
                let scope = scope.clone();
                let (rows, next) = self
                    .with_projection_read(&ctx, |tx| {
                        Box::pin(async move {
                            checked_cut(tx, &scope, cutoff).await?;
                            let (keys, next) =
                                candidate_page(tx, &scope, cutoff, &parent, at).await?;
                            let rows = exact_children(
                                tx,
                                &scope,
                                cutoff,
                                keys,
                                std::slice::from_ref(&parent),
                            )
                            .await?;
                            Ok((rows, next))
                        })
                    })
                    .await?;
                children.extend(rows);
                cursor = next;
            }
        }
        Ok(children.into_iter().collect())
    }
}

async fn candidate_page(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    parent: &FolderId,
    at: ChildCursor,
) -> Result<(Vec<String>, Option<ChildCursor>), PortError> {
    let space = scope.space_id.as_str();
    let cut = cutoff.get() as i64;
    match at {
        ChildCursor::Heads(after) => {
            let keys = read_rows!(
                tx,
                fetch_all,
                "historical_child_heads",
                (String,),
                HEADS,
                space,
                cut,
                parent.as_str(),
                after
            )?;
            let next = if keys.len() == PAGE {
                ChildCursor::Heads(keys[PAGE - 1].0.clone())
            } else {
                ChildCursor::Aliases(String::new(), 0, String::new())
            };
            Ok((keys.into_iter().map(|(id,)| id).collect(), Some(next)))
        }
        ChildCursor::Aliases(slug, at, id) => {
            let keys = read_rows!(
                tx,
                fetch_all,
                "historical_child_aliases",
                (String, i64, String),
                ALIASES,
                space,
                cut,
                parent.as_str(),
                slug,
                at,
                id
            )?;
            let next = (keys.len() == PAGE).then(|| {
                let (slug, at, id) = keys[PAGE - 1].clone();
                ChildCursor::Aliases(slug, at, id)
            });
            Ok((keys.into_iter().map(|(_, _, id)| id).collect(), next))
        }
    }
}

async fn exact_children(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    keys: Vec<String>,
    parents: &[FolderId],
) -> Result<Vec<FolderId>, PortError> {
    let ids = keys
        .into_iter()
        .map(|id| FolderId::parse(&id))
        .collect::<Result<Vec<_>, _>>()?;
    let rows = folders_at_batch(tx, scope, cutoff, &ids).await?;
    let mut children: Vec<_> = rows
        .into_values()
        .map(|row| row.metadata)
        .filter(|row| {
            row.lifecycle == Lifecycle::Active
                && row
                    .parent_folder_id
                    .as_ref()
                    .is_some_and(|parent| parents.contains(parent))
        })
        .map(|row| row.folder_id)
        .collect();
    children.sort_unstable();
    Ok(children)
}

#[test]
fn historical_children_seek_the_requested_parents_among_unrelated_folders() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
        .unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF;
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<16385)
        INSERT INTO folder_heads(space_id,folder_id,parent_folder_id,is_root,slug,slug_fold,display_name,
            is_project,lifecycle_state,rev_seq,head_rev_id,created_seq,updated_seq,updated_at_sec,updated_at_nsec)
        SELECT 's',printf('f%d',n),'unrelated',0,printf('f%d',n),printf('f%d',n),'folder',
            0,'active',1,'rev',1,1,0,0 FROM numbers;").unwrap();
    db.execute(
        "INSERT INTO folder_aliases SELECT space_id,'old',folder_id,folder_id,20 FROM folder_heads",
        [],
    )
    .unwrap();
    let mut query = db.prepare(SQLITE_HISTORICAL_CHILDREN).unwrap();
    query
        .raw_bind_parameter(query.parameter_index("$1").unwrap().unwrap(), "s")
        .unwrap();
    query
        .raw_bind_parameter(query.parameter_index("$2").unwrap().unwrap(), 10)
        .unwrap();
    query
        .raw_bind_parameter(
            query.parameter_index("$3").unwrap().unwrap(),
            r#"["empty"]"#,
        )
        .unwrap();
    assert!(query.raw_query().next().unwrap().is_none());
    assert!(
        query.get_status(rusqlite::StatementStatus::VmStep) < 1000,
        "a leaf lookup must not visit unrelated folder heads"
    );

    for (sql, parent) in [(HEADS, "unrelated"), (ALIASES, "old")] {
        let mut page = db.prepare(sql).unwrap();
        for (name, value) in [("$1", "s"), ("$3", parent), ("$4", "f8000")] {
            page.raw_bind_parameter(page.parameter_index(name).unwrap().unwrap(), value)
                .unwrap();
        }
        page.raw_bind_parameter(page.parameter_index("$2").unwrap().unwrap(), 10)
            .unwrap();
        if sql == ALIASES {
            page.raw_bind_parameter(page.parameter_index("$5").unwrap().unwrap(), 20)
                .unwrap();
            page.raw_bind_parameter(page.parameter_index("$6").unwrap().unwrap(), "f8000")
                .unwrap();
        }
        let mut rows = page.raw_query();
        let mut count = 0;
        while rows.next().unwrap().is_some() {
            count += 1;
        }
        drop(rows);
        assert_eq!(count, PAGE);
        assert!(
            page.get_status(rusqlite::StatementStatus::VmStep) < 8000,
            "continuations must seek the previous key even in a wide parent"
        );
    }
}
