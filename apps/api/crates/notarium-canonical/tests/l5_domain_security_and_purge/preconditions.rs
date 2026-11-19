use super::*;
use notarium_core::{
    ids::{ChatThreadId, JobId, LineageEpoch, PendingInputId, ThreadEntrySeq},
    ports::{
        CancelJob, ChatPort, ChatThreadKind, ContentJobKind, ContentJobPort, CreateChat, ForkChat,
        PendingChatInput, RollbackAgentRun,
    },
};

#[tokio::test]
async fn mutation_envelopes_validate_before_replay_on_both_drivers() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    for postgres in [false, true] {
        let root = TempDataRoot::new("mutation-predicates");
        let installation = sample_installation_id(92);
        let cfg = if postgres {
            fixtures.pg_local_config(installation, &schema, root.data_root())
        } else {
            CanonicalConfig::local_default(installation, root.data_root())
        };
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let owner = sample_principal_id(92);
        let (scope, folder) = seed_default_space(
            &store,
            sample_space_id(92),
            sample_incarnation(92),
            owner.clone(),
        )
        .await;
        let ctx = owner_ctx(&scope, owner.clone(), true, true);
        let create = next_mutation(
            &scope,
            &owner,
            CreateNote {
                folder_page: false,
                note: sample_note_id(92),
                parent: None,
                slug: "draft".into(),
                class: DocClass::UserDoc,
                carrier: "Draft.\n".into(),
            },
        );
        let committed = store
            .create_note(ctx.clone(), create.clone())
            .await
            .unwrap();
        let note = &committed.value.note;
        let revision = &committed.value.revision;
        let thread = ChatThreadId::from_bytes([91; 16]);
        let run = sample_run_id(92);
        // A real, already-used key ensures rejection precedes receipt handling.
        let pre = Preconditions {
            revision: Some(revision.clone()),
            ..Default::default()
        };
        macro_rules! request {
            ($input:expr, $pre:expr) => {
                Mutation {
                    identity: create.identity.clone(),
                    preconditions: $pre.clone(),
                    input: $input,
                }
            };
        }
        macro_rules! invalid {
            ($method:ident, $input:expr, $pre:expr) => {
                assert_validation_err(
                    &store.$method(ctx.clone(), request!($input, $pre)).await,
                    ValidationReason::InvalidState,
                );
            };
        }
        invalid!(create_note, create.input.clone(), pre);
        let batch = store
            .accept_batch(
                ctx.clone(),
                AcceptBatch {
                    items: vec![request!(BatchItem::Create(create.input.clone()), pre)],
                },
            )
            .await
            .unwrap();
        assert_eq!(
            batch.items[0].as_ref().unwrap_err(),
            &DomainError::validation(ValidationReason::InvalidState)
        );
        invalid!(
            publish_ability_package,
            PublishAbilityPackage {
                attached_skills: vec![],
                ability: AbilityId::from_bytes([92; 16]),
                kind: AbilityKind::Skill,
                entrypoint: note.clone(),
                files: vec![],
                expected_package_revision: None,
            },
            pre
        );
        invalid!(
            create_chat,
            CreateChat {
                thread: thread.clone(),
                kind: ChatThreadKind::Personal,
                owner: owner.clone(),
                project_folder: None,
                title: "Draft".into()
            },
            pre
        );
        invalid!(
            queue_chat_input,
            PendingChatInput {
                id: PendingInputId::from_bytes([92; 16]),
                thread: thread.clone(),
                sender: owner.clone(),
                body: "Draft.".into(),
                queued_base_leaf: ThreadEntrySeq::ZERO,
                in_flight_run: run.clone(),
                mentions_agent: false,
            },
            pre
        );
        invalid!(
            rollback_agent_run,
            RollbackAgentRun {
                run,
                expected_run_revision: revision.clone(),
                expected_entities: vec![],
                associated_board_expectations: vec![]
            },
            pre
        );
        invalid!(create_job, ContentJobKind::Backup, pre);
        invalid!(
            cancel_job,
            CancelJob {
                job: JobId::from_bytes([92; 16]),
                expected_lease: LeaseEpoch::ZERO
            },
            pre
        );

        let room = Preconditions {
            lineage: Some(LineageEpoch::ZERO),
            ..Default::default()
        };
        invalid!(
            rename_folder,
            RenameFolder {
                folder,
                name: "folder".into()
            },
            room
        );
        invalid!(
            fork_chat,
            ForkChat {
                thread,
                parent: ThreadEntrySeq::ZERO
            },
            room
        );

        let observed = next_mutation(
            &scope,
            &owner,
            ExternalObservation {
                note: note.clone(),
                base_revision: revision.clone(),
                disk_identity: ContentDigest::from_bytes([12; 32]),
                observed_digest: notarium_syntax::content_digest(&create.input.carrier),
                content: ObservedContent::Carrier(create.input.carrier.clone()),
            },
        );
        let mut wrong_room = observed.clone();
        wrong_room.preconditions.lease = Some(LeaseEpoch::new(5).unwrap());
        assert_validation_err(
            &store
                .accept_external_observation(ctx.clone(), wrong_room)
                .await,
            ValidationReason::InvalidAuthority,
        );
        let mut stale = observed;
        stale.preconditions.revision = Some(RevisionId::from_bytes([77; 16]));
        assert!(
            matches!(store.accept_external_observation(ctx.clone(), stale).await.unwrap(), ExternalObservationResult::Conflict {current} if current == *revision)
        );
        assert_eq!(
            store
                .create_note(ctx.clone(), create)
                .await
                .unwrap()
                .receipt,
            committed.receipt
        );
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            committed.receipt.seq()
        );
        runtime.shutdown().await.unwrap();
    }
    fixtures.drop_pg_schema(&schema).await;
}
