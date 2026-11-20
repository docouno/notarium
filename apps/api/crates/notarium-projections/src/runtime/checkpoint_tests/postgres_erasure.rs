use std::sync::Arc;

use notarium_canonical::{ProjectionErasures, ProjectionVisibilityCleanup};
use notarium_core::{error::CommitEffect, ports::BackupParticipantPort, receipt::ChangeCursor};
use sqlx::PgPool;

use super::*;
use crate::{
    derived::{GenerationControl, GenerationDescriptor},
    index::IndexNote,
    runtime::erasure::Eraser,
};

async fn ddl(pool: &PgPool, command: String) {
    sqlx::query(sqlx::AssertSqlSafe(command))
        .execute(pool)
        .await
        .unwrap();
}

fn purge(ctx: &SpaceContext, note: &NoteId) -> Mutation<DeleteNote> {
    Mutation {
        identity: command_identity(ctx),
        preconditions: Preconditions::default(),
        input: DeleteNote {
            note: note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    }
}

async fn expect_unconfirmed(
    canonical: &CanonicalStore,
    ctx: &SpaceContext,
    mutation: &Mutation<DeleteNote>,
) {
    let error = canonical
        .delete_note(ctx.clone(), mutation.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(error, PortError::Internal(f) | PortError::Unavailable(f)
            if f.effect() == CommitEffect::Unknown),
        "{error:?}"
    );
}

async fn restore(canonical: &CanonicalStore, ctx: &SpaceContext) -> SpaceContext {
    let scope = HistoryScope {
        space_id: ctx.scope().space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(entropy()),
    };
    let after = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    canonical
        .restore_cursors(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            vec![ChangeCursor {
                scope: scope.clone(),
                after,
            }],
        )
        .await
        .unwrap();
    SpaceContext::new(ctx.auth().clone(), scope, budget()).unwrap()
}

async fn floor(pool: &PgPool, schema: &str, scope: &HistoryScope) -> (Vec<u8>, i64) {
    let sql = format!(
        "SELECT history_incarnation, minimum_checkpoint_seq FROM {schema}.projection_space_guard WHERE space_id=$1"
    );
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(scope.space_id.as_str())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn detached_postgres_purge_retries_missing_and_reset_generations() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (config, pool, canonical_schema, prefix) = postgres_fixture(&root).await;
    let (canonical, writer) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let ctx = owner(&canonical).await;
    let neighbor = owner(&canonical).await;
    let victim = create(&canonical, &ctx, "victim", "purged".into()).await;
    let unrelated = create(&canonical, &neighbor, "neighbor", "another space".into()).await;
    let initial = ProjectionGeneration::new(GENERATION).unwrap();
    let next = initial.checked_next().unwrap();
    let g1 = format!("{prefix}_g1");
    let g2 = format!("{prefix}_g2");
    let derived = DerivedStore::open_postgres(pool.clone(), &prefix, initial)
        .await
        .unwrap();
    let projector = start(&canonical, &derived, &root).await;
    let engine = projector.engine();
    let scope = ctx.scope();
    let old_scope = scope.clone();
    let old_pool = engine.pool.clone();
    let seq = victim.receipt.seq();
    engine
        .wait_for_projected(scope, seq, &budget())
        .await
        .unwrap();
    engine
        .wait_for_projected(neighbor.scope(), unrelated.receipt.seq(), &budget())
        .await
        .unwrap();
    let active_file = root.space_fast_index(initial, &scope.space_id, seq);
    assert!(active_file.is_file());
    let candidate_file = root.space_fast_index(next, &scope.space_id, seq);

    let control = GenerationControl::open_postgres(pool.clone(), &prefix)
        .await
        .unwrap();
    let active = control.active().await.unwrap().unwrap();
    let candidate = GenerationDescriptor {
        generation: next,
        publication_epoch: active.publication_epoch + 1,
        cut_fingerprint: active.cut_fingerprint,
    };
    let eraser = Arc::new(Eraser::new(&engine).unwrap());
    let (header, parent, lifecycle) = {
        let cut = engine.published_cut(scope).unwrap();
        let index = engine.open_index(&cut).unwrap();
        let header = index
            .note_header(index.dense_id(&victim.value.note).unwrap())
            .unwrap();
        let dense = header.parent_dense_folder_id;
        let parent = FolderId::parse(index.folder_id_str(dense).unwrap()).unwrap();
        (header, parent, index.folder_lifecycle(dense).unwrap())
    };
    drop(engine);
    projector.shutdown().await.unwrap();
    drop(derived);

    assert!(
        control
            .reserve_candidate(Some(&active), &candidate)
            .await
            .unwrap()
    );
    drop(
        DerivedStore::open_postgres(pool.clone(), &prefix, next)
            .await
            .unwrap(),
    );
    let publish_candidate = |seq| {
        let mut builder = FastIndexBuilder::default();
        builder
            .add_folder(header.parent_dense_folder_id, &parent, lifecycle)
            .unwrap();
        builder
            .add_note(IndexNote {
                dense: 0,
                id: &victim.value.note,
                header,
                ancestors: &[header.parent_dense_folder_id],
                trashed_ancestor: false,
                fields: &Default::default(),
                tags: &[],
                ability: None,
            })
            .unwrap();
        let identity = IndexIdentity {
            generation: next,
            scope: scope.clone(),
            seq,
        };
        let path = root.space_fast_index(next, &scope.space_id, seq);
        drop(builder.publish(&path, identity).unwrap());
        path
    };
    publish_candidate(seq);
    let above_floor = publish_candidate(SpaceSeq::new(seq.get() + 100).unwrap());
    let temporary = above_floor.with_file_name(".fast-index-0123456789abcdef0123456789abcdef.tmp");
    std::fs::copy(&above_floor, &temporary).unwrap();

    // Stop at the durable boundary between a real candidate reset and its initializer.
    ddl(
        &pool,
        format!("UPDATE {g2}.derived_schema_meta SET mmap_format_ver = 0"),
    )
    .await;
    control
        .reset_obsolete_postgres_candidate(&active, &candidate)
        .await
        .unwrap();
    let (namespace, tables): (bool, bool) =
        sqlx::query_as("SELECT to_regnamespace($1) IS NOT NULL, to_regclass($2) IS NOT NULL")
            .bind(&g2)
            .bind(format!("{g2}.derived_schema_meta"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(namespace && !tables);
    assert_eq!(
        control.candidate().await.unwrap().as_ref(),
        Some(&candidate)
    );
    canonical
        .delete_note(neighbor.clone(), purge(&neighbor, &unrelated.value.note))
        .await
        .unwrap();

    // Restore retains the victim and its identifier in the replacement history.
    let ctx = restore(&canonical, &ctx).await;
    let scope = ctx.scope();
    // The stopped projector left its H1 admission behind. Rebind the canonical
    // owner in H2 before handing this epoch to the reopened writer.
    canonical
        .admit_projection_space(&projection_context(), scope)
        .await
        .unwrap();
    // The active namespace can also be absent from the SQL inventory.
    ddl(&pool, format!("DROP SCHEMA {g1} CASCADE")).await;
    let mutation = purge(&ctx, &victim.value.note);
    expect_unconfirmed(&canonical, &ctx, &mutation).await;
    assert!(active_file.is_file() && candidate_file.is_file() && above_floor.is_file());
    let committed = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    assert!(committed > seq);

    drop(
        DerivedStore::open_postgres(pool.clone(), &prefix, initial)
            .await
            .unwrap(),
    );
    expect_unconfirmed(&canonical, &ctx, &mutation).await;
    assert!(!active_file.exists() && candidate_file.is_file());

    let clean_file = root.space_fast_index(next, &scope.space_id, committed);
    let stale = FastIndexBuilder::default()
        .publish(
            &clean_file,
            IndexIdentity {
                generation: next,
                scope: old_scope,
                seq: committed,
            },
        )
        .unwrap()
        .0;
    stale.register_for_erasure(&old_pool);
    // Restore may reuse this immutable name before an old lease is revoked.
    BaseIndexHandle::discard_unleased(&clean_file).unwrap();
    let identity = IndexIdentity {
        generation: next,
        scope: scope.clone(),
        seq: committed,
    };
    drop(
        FastIndexBuilder::default()
            .publish(&clean_file, identity)
            .unwrap(),
    );
    let foreign = candidate_file.with_file_name(".fast-index-1123456789abcdef0123456789abcdef.tmp");
    let identity = IndexIdentity {
        generation: next,
        scope: neighbor.scope().clone(),
        seq,
    };
    let neighbor_file = root.space_fast_index(next, &neighbor.scope().space_id, seq);
    drop(
        FastIndexBuilder::default()
            .publish(&neighbor_file, identity)
            .unwrap(),
    );
    std::fs::copy(&neighbor_file, &foreign).unwrap();
    // Reopen canonical to discard in-memory debt and retry from the receipt.
    let revocation = MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Revocation),
        budget: budget(),
    };
    canonical
        .drain_projection_owner(&revocation, scope)
        .await
        .unwrap();
    writer.shutdown().await.unwrap();
    drop(canonical);
    let (canonical, writer) = CanonicalRuntime::open(config).await.unwrap();
    let epoch = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    canonical
        .advance_space_lease(&revocation, scope, epoch.checked_next().unwrap())
        .await
        .unwrap();
    canonical
        .set_projection_visibility_cleanup(&projection_context(), eraser.clone())
        .unwrap();
    ddl(&pool, format!("DROP SCHEMA {g2}")).await;
    // A complete old-history temporary image alone must keep a missing SQL
    // namespace unconfirmed, even above this purge's sequence.
    BaseIndexHandle::discard_unleased(&candidate_file).unwrap();
    BaseIndexHandle::discard_unleased(&above_floor).unwrap();
    expect_unconfirmed(&canonical, &ctx, &mutation).await;
    assert!(temporary.is_file());

    // Reinitialization can persist the new guard before receipt replay. Its
    // exact history cannot identify the abandoned images of the previous one.
    DerivedStore::open_postgres(pool.clone(), &prefix, next)
        .await
        .unwrap()
        .register_scope(scope)
        .await
        .unwrap();
    publish_candidate(SpaceSeq::new(seq.get() + 100).unwrap());
    let replay = canonical.delete_note(ctx.clone(), mutation).await.unwrap();
    assert_eq!(replay.receipt.seq(), committed);
    assert!(!temporary.exists() && !above_floor.exists());
    assert!(stale.open(&old_pool).is_err());
    drop(stale);
    assert!(clean_file.is_file() && foreign.is_file() && neighbor_file.is_file());
    assert_eq!(
        floor(&pool, &g2, scope).await,
        (
            scope.incarnation.as_bytes().to_vec(),
            committed.get() as i64
        )
    );
    assert_eq!(
        canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq,
        committed
    );

    // Deliver the old callback after another real restore and a new admission.
    let latest = restore(&canonical, &ctx).await;
    let derived = DerivedStore::open_postgres(pool.clone(), &prefix, initial)
        .await
        .unwrap();
    let projector = start(&canonical, &derived, &root).await;
    let engine = projector.engine();
    engine
        .wait_for_projected(latest.scope(), committed, &budget())
        .await
        .unwrap();
    let path = root.space_fast_index(initial, &scope.space_id, committed);
    assert!(path.is_file());
    let before = floor(&pool, &g1, latest.scope()).await;
    assert_eq!(before.0, latest.scope().incarnation.as_bytes().to_vec());
    eraser
        .erase_visibility(
            &canonical,
            &ProjectionErasures {
                scope: scope.clone(),
                through: committed,
                purged: vec![victim.value.note.clone()],
                redacted: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert!(path.is_file());
    assert_eq!(floor(&pool, &g1, latest.scope()).await, before);
    projector.shutdown().await.unwrap();
    drop(engine);
    drop(derived);
    writer.shutdown().await.unwrap();
    for schema in [canonical_schema, g1, g2, format!("{prefix}_ctrl")] {
        ddl(&pool, format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).await;
    }
    pool.close().await;
}
