use super::*;
use notarium_canonical::{ProjectionChatEntryKey, ProjectionChatRef, ProjectionChatRefLimits};
use notarium_core::ports::{MaintenanceContext, ServicePurpose};

fn projection() -> MaintenanceContext {
    support::maintenance_ctx(ServicePurpose::Projection)
}

async fn create_space(store: &CanonicalStore, owner: &PrincipalId, seed: u8) -> HistoryScope {
    store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(seed),
            incarnation: sample_incarnation(seed),
            root_folder_id: sample_folder_id(seed),
            slug: format!("projected-chat-{seed}"),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope
}

async fn create_note_in(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    seed: u8,
) -> NoteRef {
    let note = sample_note_id(seed);
    store
        .create_note(
            owner_ctx(scope, owner.clone()),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: format!("projected-note-{seed}"),
                    class: DocClass::UserDoc,
                    carrier: "# Chat backlink target\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    NoteRef {
        space_id: scope.space_id.clone(),
        note_id: note,
    }
}

async fn append_in_new_thread(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    thread: ChatThreadId,
    refs: Vec<NoteRef>,
) -> ProjectionChatEntryKey {
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    store
        .create_chat(
            ctx.clone(),
            next_mutation(
                scope,
                actor,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: actor.clone(),
                    project_folder: None,
                    title: "Projection chat".into(),
                },
            ),
        )
        .await
        .unwrap();
    append_refs(store, ctx, thread, ThreadEntrySeq::ZERO, refs).await
}

async fn append_refs(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    thread: ChatThreadId,
    parent: ThreadEntrySeq,
    refs: Vec<NoteRef>,
) -> ProjectionChatEntryKey {
    let appended = store
        .append_chat(
            ctx.clone(),
            next_mutation(
                ctx.scope(),
                ctx.auth().principal(),
                AppendChat {
                    thread: thread.clone(),
                    parent,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("References".into()),
                    referenced_notes: refs,
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    ProjectionChatEntryKey {
        thread,
        seq: appended.value.seq,
    }
}

async fn collect(
    store: &CanonicalStore,
    scope: &HistoryScope,
    cutoff: SpaceSeq,
    expected_count: usize,
) -> Vec<ProjectionChatRef> {
    let limits = ProjectionChatRefLimits::new(PageLimit::new(101).unwrap()).unwrap();
    let mut position = None;
    let mut collected = Vec::new();
    let mut pages = 0;
    loop {
        let page = store
            .read_projection_chat_refs_page(&projection(), scope, cutoff, position, limits)
            .await
            .unwrap();
        assert!(page.refs.len() <= 101);
        pages += 1;
        assert!(pages < 20, "continuation did not advance");
        collected.extend(page.refs);
        if let Some(next) = page.next {
            position = Some(next);
        } else {
            break;
        }
    }
    assert_eq!(collected.len(), expected_count);
    collected
}

// Interleave committed writes between page transactions. Each write adds a
// new occurrence after both cursors, for the very target being traversed.
async fn fixed_cut_terminates_during_appends(store: &CanonicalStore) {
    let owner = sample_principal_id(0xA7);
    let source = create_space(store, &owner, 0xA7).await;
    let target = create_note_in(store, &source, &owner, 0xA7).await;
    let ctx = owner_ctx(&source, owner);
    let thread = sample_thread_id(0xA7);
    let first = append_in_new_thread(store, &ctx, thread.clone(), vec![target.clone()]).await;
    let second = append_refs(store, &ctx, thread.clone(), first.seq, vec![target.clone()]).await;
    let third = append_refs(
        store,
        &ctx,
        thread.clone(),
        second.seq,
        vec![target.clone()],
    )
    .await;
    let cutoff = store.read_space(&source.space_id).await.unwrap().last_seq;
    let limit = ProjectionChatRefLimits::new(PageLimit::new(1).unwrap()).unwrap();
    let mut head = third.seq;
    let mut all = None;
    let mut incoming = None;
    for (index, expected) in [first, second, third].into_iter().enumerate() {
        let all_page = store
            .read_projection_chat_refs_page(&projection(), &source, cutoff, all, limit)
            .await
            .unwrap();
        let target_page = store
            .read_projection_incoming_chat_refs_page(
                &projection(),
                &source,
                cutoff,
                &source,
                incoming,
                limit,
            )
            .await
            .unwrap();
        assert_eq!(all_page.refs, target_page.refs);
        assert_eq!(all_page.refs.len(), 1);
        assert_eq!(all_page.refs[0].locator.entry, expected);
        assert_eq!(all_page.refs[0].target, target);
        all = all_page.next;
        incoming = target_page.next;
        assert_eq!(all.is_some(), index < 2);
        assert_eq!(incoming.is_some(), index < 2);
        if index < 2 {
            head = append_refs(store, &ctx, thread.clone(), head, vec![target.clone()])
                .await
                .seq;
        }
    }
}

async fn exercise(store: &CanonicalStore) -> (HistoryScope, ProjectionChatEntryKey) {
    let owner = sample_principal_id(0x93);
    let source = create_space(store, &owner, 0x93).await;
    let foreign = create_space(store, &owner, 0x94).await;
    let local_note = create_note_in(store, &source, &owner, 0x93).await;
    let foreign_note = create_note_in(store, &foreign, &owner, 0x94).await;

    let ctx = owner_ctx(&source, owner.clone());
    let mut grants = ctx.auth().spaces().clone();
    grants.extend(owner_ctx(&foreign, owner.clone()).auth().spaces().clone());
    let ctx = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner.clone(),
            GrantId::from_bytes([0x93; 16]),
            grants,
            true,
        )),
        source.clone(),
        make_budget(),
    )
    .unwrap();
    let _empty = append_in_new_thread(store, &ctx, sample_thread_id(1), Vec::new()).await;
    let first_cut = store.read_space(&source.space_id).await.unwrap().last_seq;
    let mut extra_local = Vec::new();
    for seed in 0x97..0xA5 {
        extra_local.push(create_note_in(store, &source, &owner, seed).await);
    }
    let mut refs = Vec::new();
    refs.push(local_note.clone());
    refs.push(foreign_note.clone());
    refs.push(local_note.clone()); // duplicate target must deduplicate to first ordinal
    for note in &extra_local {
        refs.push(note.clone());
    }
    let expected_unique: Vec<_> = std::iter::once(local_note.clone())
        .chain(std::iter::once(foreign_note.clone()))
        .chain(extra_local.iter().cloned())
        .collect();
    let entry = append_in_new_thread(store, &ctx, sample_thread_id(2), refs).await;
    let cutoff = store.read_space(&source.space_id).await.unwrap().last_seq;
    // All occurrences are newer than first_cut. Neither range opens a continuation.
    let limits = ProjectionChatRefLimits::new(PageLimit::new(3).unwrap()).unwrap();
    let all = store
        .read_projection_chat_refs_page(&projection(), &source, first_cut, None, limits)
        .await
        .unwrap();
    let target = store
        .read_projection_incoming_chat_refs_page(
            &projection(),
            &source,
            first_cut,
            &source,
            None,
            limits,
        )
        .await
        .unwrap();
    for page in [all, target] {
        assert!(page.refs.is_empty());
        assert!(page.next.is_none());
    }
    let outer = collect(store, &source, cutoff, expected_unique.len()).await;
    assert_eq!(
        outer.iter().map(|r| r.target.clone()).collect::<Vec<_>>(),
        expected_unique
    );
    assert_eq!(outer[0].locator.ref_ordinal, 0);
    assert_eq!(outer[1].locator.ref_ordinal, 1);
    assert_eq!(outer[2].locator.ref_ordinal, 3);
    assert!(
        outer
            .iter()
            .all(|r| r.locator.source == source && r.locator.entry == entry)
    );
    let sample_local = outer
        .iter()
        .find(|r| r.target == local_note)
        .expect("fixture includes a local NoteRef");
    assert!(
        store
            .verify_projection_chat_ref(&projection(), sample_local)
            .await
            .unwrap()
    );
    let mut wrong_note = sample_local.clone();
    wrong_note.target = foreign_note.clone();
    wrong_note.target_scope = foreign.clone();
    assert!(
        !store
            .verify_projection_chat_ref(&projection(), &wrong_note)
            .await
            .unwrap()
    );
    let mut wrong_history = sample_local.clone();
    wrong_history.target_scope.incarnation = sample_incarnation(0x92);
    assert!(
        !store
            .verify_projection_chat_ref(&projection(), &wrong_history)
            .await
            .unwrap()
    );
    let mut wrong_ordinal = sample_local.clone();
    wrong_ordinal.locator.ref_ordinal += 1;
    assert!(
        !store
            .verify_projection_chat_ref(&projection(), &wrong_ordinal)
            .await
            .unwrap()
    );

    let heads = store
        .read_projection_chat_heads_page(
            &projection(),
            &source,
            cutoff,
            None,
            PageLimit::new(2).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(heads.len(), 2);
    assert_eq!(heads[1].thread.id, entry.thread);
    assert!(heads[1].thread.tainted);
    assert_eq!(heads[1].title, "Projection chat");
    let changes = store
        .read_projection_chat_changes_page(
            &projection(),
            &source,
            first_cut,
            cutoff,
            None,
            PageLimit::new(20).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changes.changes.len(), 1);
    assert_eq!(changes.changes[0].entry, entry);
    assert!(!changes.changes[0].removed);
    let limits = ProjectionChatRefLimits::new(PageLimit::new(9).unwrap()).unwrap();
    let partial = store
        .read_projection_chat_entry_refs_page(&projection(), &source, cutoff, &entry, None, limits)
        .await
        .unwrap();
    assert_eq!(partial.refs.len(), 9);
    assert!(partial.next.is_some());

    // Target-indexed lookup should return only references pointing to local_note's space.
    let targeted = store
        .read_projection_incoming_chat_refs_page(
            &projection(),
            &source,
            cutoff,
            &source,
            None,
            ProjectionChatRefLimits::new(PageLimit::new(200).unwrap()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(targeted.refs.len(), 1 + extra_local.len());
    assert!(
        targeted
            .refs
            .iter()
            .all(|r| r.target.space_id == source.space_id)
    );

    store
        .delete_note(
            owner_ctx(&foreign, owner.clone()),
            next_mutation(
                &foreign,
                &owner,
                DeleteNote {
                    note: foreign_note.note_id.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    let clean = collect(store, &source, cutoff, 1 + extra_local.len()).await;
    assert!(clean.iter().all(|r| r.target_scope == source));
    let removed = &outer[1];
    assert!(
        !store
            .verify_projection_chat_ref(&projection(), removed)
            .await
            .unwrap()
    );

    let head = store
        .read_projection_chat_head(&projection(), &source, None, &entry.thread)
        .await
        .unwrap()
        .unwrap();
    store
        .redact_chat_entry(
            ctx.clone(),
            next_mutation(
                &source,
                &owner,
                RedactChatEntry {
                    thread: entry.thread.clone(),
                    entry: entry.seq,
                    expected_thread_revision: head.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    assert_validation_err(
        &store
            .read_projection_chat_entry_refs_page(
                &projection(),
                &source,
                cutoff,
                &entry,
                partial.next,
                limits,
            )
            .await,
        ValidationReason::CursorStale,
    );
    assert!(
        !store
            .verify_projection_chat_ref(&projection(), sample_local)
            .await
            .unwrap()
    );
    let redacted = store.read_space(&source.space_id).await.unwrap().last_seq;
    // A second redaction must preserve the earliest redacted_at_seq so
    // incremental windows between cutoff and the first redaction never lose it.
    let head_after_first = store
        .read_projection_chat_head(&projection(), &source, None, &entry.thread)
        .await
        .unwrap()
        .unwrap();
    store
        .redact_chat_entry(
            ctx,
            next_mutation(
                &source,
                &owner,
                RedactChatEntry {
                    thread: entry.thread.clone(),
                    entry: entry.seq,
                    expected_thread_revision: head_after_first.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    assert!(collect(store, &source, redacted, 0).await.is_empty());
    let changes = store
        .read_projection_chat_changes_page(
            &projection(),
            &source,
            cutoff,
            redacted,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changes.changes.len(), 1);
    assert_eq!(changes.changes[0].entry, entry);
    assert!(changes.changes[0].removed);
    (source, entry)
}

const COVERED_COLUMNS: &str =
    "thread_id,entry_seq,revision_id,created_space_seq,redacted_at_seq,kind,
                              CAST(checkpoint_stale AS BIGINT)";
const V6_REMOVE_PROJECTION: &str = include_str!("../fixtures/schema-v6-remove-projection.sql");

struct V6Chat {
    scope: HistoryScope,
    entry: ProjectionChatEntryKey,
    repeated: NoteRef,
    tail: NoteRef,
    count: usize,
}

impl V6Chat {
    fn json(&self) -> String {
        let repeated = serde_json::to_string(&self.repeated).unwrap();
        let tail = serde_json::to_string(&self.tail).unwrap();
        let mut json = String::with_capacity((repeated.len() + 1) * self.count + 1);
        json.push('[');
        for _ in 1..self.count {
            json.push_str(&repeated);
            json.push(',');
        }
        json.push_str(&tail);
        json.push(']');
        json
    }
}

async fn plant_v6_chat_entries(store: &CanonicalStore) -> Vec<V6Chat> {
    let owner = sample_principal_id(0x95);
    let scope = create_space(store, &owner, 0x95).await;
    let repeated = create_note_in(store, &scope, &owner, 0x95).await;
    let tail = create_note_in(store, &scope, &owner, 0x96).await;
    let ctx = owner_ctx(&scope, owner);
    let mut fixtures = Vec::new();
    for (seed, count) in [(0x95, 10_000), (0x96, 50_000)] {
        let entry =
            append_in_new_thread(store, &ctx, sample_thread_id(seed), vec![repeated.clone()]).await;
        fixtures.push(V6Chat {
            scope: scope.clone(),
            entry,
            repeated: repeated.clone(),
            tail: tail.clone(),
            count,
        });
    }
    fixtures
}

// The fixture is created by real ChatPort commands, then reverts to the old
// schema and uses its original inline JSON representation regardless of size.
macro_rules! write_v6_chats {
    ($db:expr, $fixtures:expr) => {
        for fixture in &$fixtures {
            sqlx::query(
                "UPDATE chat_entries SET referenced_notes_json=$1
                WHERE space_id=$2 AND thread_id=$3 AND entry_seq=$4",
            )
            .bind(fixture.json())
            .bind(fixture.scope.space_id.as_str())
            .bind(fixture.entry.thread.as_str())
            .bind(fixture.entry.seq.get() as i64)
            .execute(&mut $db)
            .await
            .unwrap();
        }
    };
}

async fn covers_v6_references(store: &CanonicalStore, fixture: &V6Chat) -> usize {
    let V6Chat {
        scope,
        entry,
        repeated,
        tail,
        count,
    } = fixture;
    let cutoff = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let limits = ProjectionChatRefLimits::new(PageLimit::new(1).unwrap()).unwrap();
    let mut position = None;
    let mut collected = Vec::new();
    let mut pages = 0;
    loop {
        let page = store
            .read_projection_chat_entry_refs_page(
                &projection(),
                scope,
                cutoff,
                entry,
                position,
                limits,
            )
            .await
            .unwrap();
        assert!(page.refs.len() <= 1);
        pages += 1;
        collected.extend(page.refs);
        if let Some(next) = page.next {
            position = Some(next);
        } else {
            break;
        }
    }
    // Duplicate targets in legacy JSON deduplicate to first-occurrence ordinals.
    assert_eq!(collected.len(), 2);
    assert_eq!(collected[0].target, *repeated);
    assert_eq!(collected[0].locator.ref_ordinal, 0);
    assert_eq!(collected[1].target, *tail);
    assert_eq!(collected[1].locator.ref_ordinal as usize, *count - 1);
    assert!(
        store
            .verify_projection_chat_ref(&projection(), &collected[1])
            .await
            .unwrap()
    );
    pages
}

// Remove one v7 occurrence to verify that upgrading preserves the normalized
// rows even when the original entry still has a legacy inline reference.
macro_rules! downgrade_chat_refs_v7 {
    ($db:expr, $legacy:expr) => {{
        sqlx::raw_sql(include_str!("../fixtures/schema-v7-chat-refs.sql"))
            .execute(&mut $db)
            .await
            .unwrap();
        let removed = sqlx::query(
            "DELETE FROM chat_entry_note_refs WHERE space_id=$1 AND thread_id=$2 AND ref_ordinal=0",
        )
        .bind($legacy[0].scope.space_id.as_str())
        .bind($legacy[0].entry.thread.as_str())
        .execute(&mut $db)
        .await
        .unwrap();
        assert_eq!(removed.rows_affected(), 1);
        sqlx::query("UPDATE schema_meta SET schema_version=7,manifest_checksum=$1")
            .bind(
                hex::decode("1a3cfcfe1c2d78948310fb1dafb04dba99e243ea821626e2de4d7009c3aa22b9")
                    .unwrap(),
            )
            .execute(&mut $db)
            .await
            .unwrap();
    }};
}

async fn covers_v7_references(store: &CanonicalStore, legacy: &[V6Chat]) {
    let scope = &legacy[0].scope;
    let cutoff = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let refs = collect(store, scope, cutoff, 3).await;
    assert_eq!(refs[0].locator.entry, legacy[0].entry);
    assert_eq!(refs[0].locator.ref_ordinal as usize, legacy[0].count - 1);
    assert_eq!(refs[0].target, legacy[0].tail);
    assert_eq!(covers_v6_references(store, &legacy[1]).await, 2);
}

#[tokio::test]
async fn l7_projection_refs_sqlite_covering_pages_and_erasure() {
    let temp = TempDataRoot::new("projection-chat-sqlite");
    let config = CanonicalConfig::local_default(sample_installation_id(0x93), temp.data_root());
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let legacy = plant_v6_chat_entries(&store).await;
    runtime.shutdown().await.unwrap();
    let mut old = temp.open_raw_sqlite().await;
    sqlx::raw_sql(V6_REMOVE_PROJECTION)
        .execute(&mut old)
        .await
        .unwrap();
    sqlx::query("UPDATE schema_meta SET schema_version=6,manifest_checksum=$1")
        .bind(hex::decode(support::CANONICAL_V6_HASH).unwrap())
        .execute(&mut old)
        .await
        .unwrap();
    write_v6_chats!(old, legacy);
    drop(old);

    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    assert_eq!(covers_v6_references(&store, &legacy[0]).await, 2);
    assert_eq!(covers_v6_references(&store, &legacy[1]).await, 2);
    runtime.shutdown().await.unwrap();
    let mut old = temp.open_raw_sqlite().await;
    downgrade_chat_refs_v7!(old, legacy);
    drop(old);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    covers_v7_references(&store, &legacy).await;
    fixed_cut_terminates_during_appends(&store).await;
    let (scope, entry) = exercise(&store).await;
    let mut db = temp.open_raw_sqlite().await;
    let ref_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_entry_note_refs WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
    )
    .bind(scope.space_id.as_str())
    .bind(entry.thread.as_str())
    .bind(entry.seq.get() as i64)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(ref_rows, 0);

    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn l7_projection_refs_postgres_bounded_pages_and_erasure() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let temp = TempDataRoot::new("projection-chat-postgres");
    let config = fixtures.pg_local_config(sample_installation_id(0x94), &schema, temp.data_root());
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let legacy = plant_v6_chat_entries(&store).await;
    runtime.shutdown().await.unwrap();
    let mut db = fixtures.open_raw_pg().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET search_path TO \"{schema}\""
    )))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql(V6_REMOVE_PROJECTION)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE schema_meta SET schema_version=6,manifest_checksum=$1")
        .bind(hex::decode(support::CANONICAL_V6_HASH).unwrap())
        .execute(&mut db)
        .await
        .unwrap();
    write_v6_chats!(db, legacy);
    let (store, runtime) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let legacy_space = legacy[0].scope.space_id.clone();
    assert_eq!(covers_v6_references(&store, &legacy[0]).await, 2);
    assert_eq!(covers_v6_references(&store, &legacy[1]).await, 2);
    runtime.shutdown().await.unwrap();
    downgrade_chat_refs_v7!(db, legacy);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    covers_v7_references(&store, &legacy).await;
    fixed_cut_terminates_during_appends(&store).await;
    let (scope, entry) = exercise(&store).await;
    let ref_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_entry_note_refs WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
    )
    .bind(scope.space_id.as_str())
    .bind(entry.thread.as_str())
    .bind(entry.seq.get() as i64)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(ref_rows, 0);

    let indexdef: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_chat_entries_projection'",
    ).bind(&schema).fetch_one(&mut db).await.unwrap();
    assert!(indexdef.contains(
        "INCLUDE (revision_id, created_space_seq, redacted_at_seq, kind, checkpoint_stale)"
    ));
    sqlx::query("SET enable_seqscan TO off")
        .execute(&mut db)
        .await
        .unwrap();
    let explain = format!(
        "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT {COVERED_COLUMNS} FROM chat_entries
         WHERE space_id=$1 AND (thread_id,entry_seq)>($2,$3) ORDER BY thread_id,entry_seq LIMIT $4"
    );
    let plan: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(explain))
        .bind(legacy_space.as_str())
        .bind("")
        .bind(0_i64)
        .bind(5_i64)
        .fetch_all(&mut db)
        .await
        .unwrap();
    assert!(
        plan.iter()
            .all(|line| !line.contains("referenced_notes_json"))
    );
    assert!(
        plan.iter()
            .any(|line| line.contains("Index") && line.contains("chat_entries"))
    );
    let fixture = &legacy[1];
    let created: i64 = sqlx::query_scalar(
        "SELECT created_space_seq FROM chat_entries WHERE space_id=$1 AND thread_id=$2 AND entry_seq=$3",
    )
    .bind(legacy_space.as_str())
    .bind(fixture.entry.thread.as_str())
    .bind(fixture.entry.seq.get() as i64)
    .fetch_one(&mut db)
    .await
    .unwrap();
    let mut probe = sqlx::Connection::begin(&mut db).await.unwrap();
    // Give the planner a representative choice: most occurrences of this
    // source entry address another Space and have ordinals below its tail.
    sqlx::query(
        "INSERT INTO chat_entry_note_refs
         (space_id, thread_id, entry_seq, ref_ordinal, target_space_id, target_note_id, created_space_seq)
         SELECT $1,$2,$3,i,$4,'nt_' || md5(i::text),$5 FROM generate_series(1,8192) i",
    )
    .bind(legacy_space.as_str())
    .bind(fixture.entry.thread.as_str())
    .bind(fixture.entry.seq.get() as i64)
    .bind(scope.space_id.as_str())
    .bind(created)
    .execute(&mut *probe)
    .await
    .unwrap();
    sqlx::raw_sql("ANALYZE chat_entry_note_refs; RESET enable_seqscan")
        .execute(&mut *probe)
        .await
        .unwrap();
    let ref_plan: Vec<String> = sqlx::query_scalar(concat!(
        "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ",
        include_str!("../../src/projection_chat/verify_ref.sql")
    ))
    .bind(legacy_space.as_str())
    .bind(fixture.entry.thread.as_str())
    .bind(fixture.entry.seq.get() as i64)
    .bind((fixture.count - 1) as i64)
    .bind(fixture.tail.space_id.as_str())
    .bind(fixture.tail.note_id.as_str())
    .bind(created)
    .fetch_all(&mut *probe)
    .await
    .unwrap();
    assert_bounded_ref_plan(
        &ref_plan,
        &[".space_id", ".thread_id", ".entry_seq", ".ref_ordinal"],
    );
    let target_plan: Vec<String> = sqlx::query_scalar(concat!(
        "EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
         SELECT r.thread_id, r.entry_seq, r.ref_ordinal
         FROM chat_entry_note_refs r WHERE r.space_id=$1 AND ",
        include_str!("../../src/projection_chat/target_ref_range.sql")
    ))
    .bind(legacy_space.as_str())
    .bind(fixture.tail.space_id.as_str())
    .bind(created)
    .bind(created)
    .bind(fixture.entry.thread.as_str())
    .bind(fixture.entry.seq.get() as i64)
    .bind(0_i64)
    .bind(10_i64)
    .fetch_all(&mut *probe)
    .await
    .unwrap();
    assert_bounded_ref_plan(
        &target_plan,
        &[
            ".space_id",
            ".target_space_id",
            ".created_space_seq",
            "ROW(",
        ],
    );
    probe.rollback().await.unwrap();
    drop(db);
    runtime.shutdown().await.unwrap();
    fixtures.drop_pg_schema(&schema).await;
}

fn assert_bounded_ref_plan(plan: &[String], seek_columns: &[&str]) {
    let details = plan.join("\n");
    assert!(
        plan.iter().any(|line| line.contains("Index Cond:")
            && seek_columns.iter().all(|column| line.contains(column))),
        "{details}"
    );
    assert!(
        plan.iter()
            .any(|line| line.contains("Scan") && line.contains("rows=1 loops=1")),
        "{details}"
    );
    // The first execution buffer summary belongs to the root and includes all
    // descendants. Count hits as well as reads so a warm cache cannot hide a scan.
    let buffers = plan
        .iter()
        .take_while(|line| !line.trim_start().starts_with("Planning"))
        .find_map(|line| line.trim().strip_prefix("Buffers: shared "))
        .unwrap_or_else(|| panic!("missing execution buffers: {details}"));
    let blocks: usize = buffers
        .split_whitespace()
        .filter_map(|field| {
            field
                .strip_prefix("hit=")
                .or_else(|| field.strip_prefix("read="))
                .map(|n| n.trim_end_matches(',').parse::<usize>().unwrap())
        })
        .sum();
    assert!(
        (1..=32).contains(&blocks),
        "{blocks} execution blocks: {details}"
    );
}
