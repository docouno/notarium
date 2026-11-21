use notarium_canonical::{ProjectionErasures, ProjectionVisibilityCleanup};
use notarium_core::{
    error::ValidationReason,
    model::NoteRef,
    patch::CarrierEditOrigin,
    ports::{
        AppendChat, ChatEntryKind, ChatInputBody, ChatPort, ChatThreadKind, CreateChat,
        DeleteDisposition, DeleteNote, EditNote, PageLimit, RedactChatEntry,
    },
    span::ByteSpan,
};
use notarium_projections::derived::{DerivedMutation, ProjectedChatRef, StageKey};

use super::*;

const CARRIER: &str = "# Doomed while offline\n";

/// Inject a missed physical cleanup to exercise recovery of stale derived data.
pub(super) fn disable_cleanup(store: &CanonicalStore) {
    struct NoProjector;

    impl ProjectionVisibilityCleanup for NoProjector {
        fn erase_visibility<'a>(
            &'a self,
            _canonical: &'a CanonicalStore,
            _: &'a ProjectionErasures,
        ) -> PortFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    store
        .set_projection_visibility_cleanup(&projection_context(), Arc::new(NoProjector))
        .unwrap();
}

pub(super) struct OfflineErasures {
    source: SpaceContext,
    unchanged_source: HistoryScope,
    survivor: HistoryScope,
    victim: NoteRevision,
    live: NoteId,
    thread: ChatThreadId,
    redacted: ThreadEntrySeq,
    old_incoming: ProjectedChatRef,
    old_outgoing: ProjectedChatRef,
    old_checkpoint: Option<PathBuf>,
}

impl OfflineErasures {
    pub(super) async fn prepare(
        store: &CanonicalStore,
        runtime: &ProjectorRuntime,
        derived: &DerivedStore,
    ) -> Self {
        let (source, author) = open_space(store).await;
        let (unchanged_source, foreign_author) = open_space(store).await;
        let (survivor, live_author) = open_space(store).await;
        let victim = note(
            store,
            &author,
            "offline-doomed",
            DocClass::UserDoc,
            CARRIER.into(),
        )
        .await;
        let live = note(
            store,
            &live_author,
            "offline-live",
            DocClass::UserDoc,
            "# Live\n".into(),
        )
        .await
        .note;
        sync(store, runtime, &source).await;
        sync(store, runtime, &survivor).await;

        let source_ctx = cross_scope(author.clone(), &live_author);
        let foreign_ctx = cross_scope(foreign_author, &source_ctx);
        let thread = create_thread(store, &source_ctx).await;
        let keep = append(
            store,
            &source_ctx,
            &thread,
            ThreadEntrySeq::ZERO,
            ChatEntryKind::Human,
            &survivor,
            &live,
        )
        .await;
        let redacted = append(
            store,
            &source_ctx,
            &thread,
            keep,
            ChatEntryKind::Human,
            &survivor,
            &live,
        )
        .await;
        let compaction = append(
            store,
            &source_ctx,
            &thread,
            redacted,
            ChatEntryKind::Compaction,
            &survivor,
            &live,
        )
        .await;

        let foreign_thread = create_thread(store, &foreign_ctx).await;
        append(
            store,
            &foreign_ctx,
            &foreign_thread,
            ThreadEntrySeq::ZERO,
            ChatEntryKind::Human,
            &source,
            &victim.note,
        )
        .await;
        for scope in [&source, &unchanged_source] {
            sync(store, runtime, scope).await;
        }
        let limit = PageLimit::new(20).unwrap();
        let mut incoming = derived
            .chat_ref_page(&source, &victim.note, None, limit)
            .await
            .unwrap();
        assert_eq!(incoming.len(), 1);
        let outgoing = derived
            .chat_ref_page(&survivor, &live, None, limit)
            .await
            .unwrap();
        assert_eq!(
            outgoing.iter().map(|row| row.entry_seq).collect::<Vec<_>>(),
            vec![keep, redacted, compaction]
        );
        let old_outgoing = outgoing
            .into_iter()
            .find(|row| row.entry_seq == redacted)
            .unwrap();
        Self {
            source: author,
            unchanged_source,
            survivor,
            victim,
            live,
            thread,
            redacted,
            old_incoming: incoming.pop().unwrap(),
            old_outgoing,
            old_checkpoint: None,
        }
    }

    pub(super) async fn mutate_offline(
        &mut self,
        store: &CanonicalStore,
        derived: &DerivedStore,
        root: &DataRoot,
    ) {
        let scope = self.source.scope();
        let watermark = derived.watermarks(&scope.space_id).await.unwrap().unwrap();
        let checkpoint = find_checkpoint_file(
            root,
            derived.generation(),
            &scope.space_id,
            watermark.snapshot_seq,
        )
        .unwrap();
        assert!(checkpoint.is_file());
        self.old_checkpoint = Some(checkpoint);

        let body = notarium_syntax::frontmatter::analyze(CARRIER, DocClass::UserDoc)
            .unwrap()
            .carrier
            .body;
        let plan = notarium_syntax::patch::plan(
            CARRIER,
            body,
            vec![(
                CarrierEditOrigin::Body,
                ByteSpan::new(CARRIER.len(), CARRIER.len()).unwrap(),
                "Private carrier edited while no projector is running.\n".into(),
            )],
        )
        .unwrap();
        let mut request = mutation(
            &self.source,
            EditNote {
                note: self.victim.note.clone(),
                plan,
            },
        );
        request.preconditions.revision = Some(self.victim.revision.clone());
        store.edit_note(self.source.clone(), request).await.unwrap();
        let head = store
            .read_projection_chat_head(&projection_context(), scope, None, &self.thread)
            .await
            .unwrap()
            .unwrap()
            .thread;
        // Reading a tainted thread during redaction taints that request.
        // The subsequent note purge uses the owner's separate author context.
        let redaction_ctx = SpaceContext::new(
            EngineAuthContext::for_human(VerifiedHuman::attest(
                self.source.auth().principal().clone(),
                GrantId::from_bytes(random_bytes()),
                self.source.auth().spaces().clone(),
                false,
            )),
            scope.clone(),
            budget(),
        )
        .unwrap();
        let redacted = store
            .redact_chat_entry(
                redaction_ctx.clone(),
                mutation(
                    &redaction_ctx,
                    RedactChatEntry {
                        thread: self.thread.clone(),
                        entry: self.redacted,
                        expected_thread_revision: head.revision,
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(redacted.value.invalidated_contexts.len(), 1);
        store
            .delete_note(
                self.source.clone(),
                mutation(
                    &self.source,
                    DeleteNote {
                        note: self.victim.note.clone(),
                        disposition: DeleteDisposition::Purge,
                    },
                ),
            )
            .await
            .unwrap();

        // This fixture only proves recovery if the live cleanup never ran.
        assert_eq!(
            derived
                .chat_ref_page(scope, &self.victim.note, None, PageLimit::new(20).unwrap())
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            derived
                .chat_ref_page(
                    &self.survivor,
                    &self.live,
                    None,
                    PageLimit::new(20).unwrap()
                )
                .await
                .unwrap()
                .len(),
            3
        );
    }

    pub(super) async fn verify(
        self,
        store: &CanonicalStore,
        runtime: &ProjectorRuntime,
        derived: &DerivedStore,
    ) {
        let scope = self.source.scope();
        sync(store, runtime, scope).await;
        let limit = PageLimit::new(20).unwrap();
        assert!(
            derived
                .chat_ref_page(scope, &self.victim.note, None, limit)
                .await
                .unwrap()
                .is_empty()
        );
        let live = derived
            .chat_ref_page(&self.survivor, &self.live, None, limit)
            .await
            .unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].entry_seq, ThreadEntrySeq::new(1).unwrap());
        assert!(!self.old_checkpoint.unwrap().exists());

        // Old staged locators must fail under either marker even though the
        // source and target histories themselves have not changed.
        for (source, stale) in [
            (scope, self.old_outgoing),
            (&self.unchanged_source, self.old_incoming),
        ] {
            let next = store
                .read_space(&source.space_id)
                .await
                .unwrap()
                .last_seq
                .checked_next()
                .unwrap();
            let key = StageKey {
                scope: source.clone(),
                first: next,
                last: next,
            };
            assert!(matches!(
                derived.stage_page(&key, 0, &[DerivedMutation::UpsertChatRef(stale)]).await,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::CursorStale
            ));
        }
    }
}

fn cross_scope(source: SpaceContext, target: &SpaceContext) -> SpaceContext {
    let mut grants = source.auth().spaces().clone();
    grants.extend(target.auth().spaces().clone());
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        source.auth().principal().clone(),
        GrantId::from_bytes(random_bytes()),
        grants,
        false,
    ));
    SpaceContext::new(auth, source.scope().clone(), budget()).unwrap()
}

async fn create_thread(store: &CanonicalStore, owner: &SpaceContext) -> ChatThreadId {
    let thread = ChatThreadId::from_bytes(random_bytes());
    store
        .create_chat(
            owner.clone(),
            mutation(
                owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.auth().principal().clone(),
                    project_folder: None,
                    title: "Offline erasure".into(),
                },
            ),
        )
        .await
        .unwrap();
    thread
}

async fn append(
    store: &CanonicalStore,
    owner: &SpaceContext,
    thread: &ChatThreadId,
    parent: ThreadEntrySeq,
    kind: ChatEntryKind,
    target: &HistoryScope,
    note: &NoteId,
) -> ThreadEntrySeq {
    store
        .append_chat(
            owner.clone(),
            mutation(
                owner,
                AppendChat {
                    thread: thread.clone(),
                    parent,
                    kind,
                    body: ChatInputBody::Text("Link".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: target.space_id.clone(),
                        note_id: note.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap()
        .value
        .seq
}
