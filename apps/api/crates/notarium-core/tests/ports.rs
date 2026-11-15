#[path = "support/ports.rs"]
mod support;
use notarium_core::{
    DomainError,
    auth::*,
    classes::*,
    ids::*,
    model::*,
    ports::{control::*, *},
    query::*,
    receipt::*,
    value::{ScalarValue, YamlValue},
};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Arc,
    task::{Context, Poll, Waker},
    time::Duration,
};

fn ready<T>(mut future: PortFuture<'_, T>) -> Result<T, notarium_core::error::PortError> {
    match Future::poll(future.as_mut(), &mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("pure test double unexpectedly scheduled runtime work"),
    }
}

/// Small immutable consumer fixture: pagination must represent real identities
/// without synthetic NoteIds or fallback to a different package revision.
#[derive(Default)]
struct ReadFixture {
    notes: Vec<NoteSnapshot>,
    threads: Vec<ChatThread>,
    jobs: Vec<ContentJob>,
    resources: BTreeMap<(AbilityId, RevisionId, AbilityResourceName), ClassifiedAbilityResource>,
}
impl ReadFixture {
    fn seed(&self, ctx: SpaceContext, request: ChangeRead) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(async move {
            ctx.check_current(&scope(1))?;
            let (cutoff, after, limit) = match request {
                ChangeRead::Seed {
                    scope: expected,
                    cutoff,
                    limit,
                } => {
                    expected.check(&scope(1))?;
                    (
                        cursor(cutoff.unwrap_or(SpaceSeq::new(10).unwrap()).get()),
                        None,
                        limit,
                    )
                }
                ChangeRead::ContinueSeed { cursor } => {
                    cursor.cutoff.check(&scope(1))?;
                    (cursor.cutoff, Some(cursor.after), cursor.limit)
                }
                ChangeRead::Log { .. } => return Err(DomainError::ResourceNotFound.into()),
            };
            let mut positions = Vec::new();
            positions.extend(
                self.notes
                    .iter()
                    .map(|n| SeedPosition::NotesAfter(n.document.reference().note_id.clone())),
            );
            positions.extend(
                self.threads
                    .iter()
                    .map(|t| SeedPosition::ThreadsAfter(t.id.clone())),
            );
            let start = after
                .as_ref()
                .map_or(0, |p| positions.iter().position(|v| v == p).unwrap() + 1);
            let end = (start + usize::from(limit.get())).min(positions.len());
            let mut notes = vec![];
            let mut threads = vec![];
            for position in &positions[start..end] {
                match position {
                    SeedPosition::NotesAfter(id) => notes.push(
                        self.notes
                            .iter()
                            .find(|n| &n.document.reference().note_id == id)
                            .unwrap()
                            .clone(),
                    ),
                    SeedPosition::ThreadsAfter(id) => {
                        threads.push(self.threads.iter().find(|t| &t.id == id).unwrap().clone())
                    }
                }
            }
            let next = (end < positions.len()).then(|| SeedCursor {
                cutoff: cutoff.clone(),
                after: positions[end - 1].clone(),
                limit,
            });
            Ok(ChangeReadResult::Seed(ChangeSeed {
                notes,
                threads,
                cutoff,
                next,
            }))
        })
    }
    fn publish(
        &mut self,
        package: PublishAbilityPackage,
        revision: RevisionId,
    ) -> AbilityPackageRevision {
        auth().authorize_ability_mutation().unwrap();
        let mut manifest = BTreeMap::new();
        for file in package.files {
            let name = if file.path == "SKILL.md" {
                AbilityResourceName::Entrypoint
            } else {
                AbilityResourceName::Auxiliary(file.path.clone())
            };
            manifest.insert(file.path, file.digest);
            let mut facts = resource_facts(DocClass::Skill);
            facts.ability_package = Some(package.ability.clone());
            let resource = ClassifiedAbilityResource::from_canonical(
                AbilityResourceRef {
                    space: scope(1).space_id,
                    ability: package.ability.clone(),
                    package_revision: revision.clone(),
                    resource: name.clone(),
                },
                facts,
                Lifecycle::Active,
                file.content,
                file.digest,
            )
            .unwrap();
            self.resources
                .insert((package.ability.clone(), revision.clone(), name), resource);
        }
        AbilityPackageRevision {
            ability: package.ability,
            revision,
            manifest,
        }
    }
}
fn resource_facts(class: DocClass) -> ResourceFacts {
    ResourceFacts {
        space: Space {
            id: scope(1).space_id,
            lifecycle: SpaceLifecycle::Active,
            kind: SpaceKind::Personal,
        },
        class,
        ancestor_folders: vec![],
        folder_write_locked: false,
        ability_package: None,
    }
}
fn note_snapshot(byte: u8, class: DocClass, lifecycle: Lifecycle) -> NoteSnapshot {
    NoteSnapshot {
        document: ClassifiedDocument::from_canonical(
            NoteRef {
                space_id: scope(1).space_id,
                note_id: NoteId::from_bytes([byte; 16]),
            },
            RevisionId::from_bytes([byte; 16]),
            resource_facts(class),
            lifecycle,
            "authored text".into(),
            ContentDigest::from_bytes([byte; 32]),
        )
        .unwrap(),
        parent: None,
        byte_size: 13,
        fields: BTreeMap::new(),
        diagnostics: vec![],
    }
}
impl NoteReadPort for ReadFixture {
    fn get_note(&self, ctx: SpaceContext, request: GetNote) -> PortFuture<'_, NoteSnapshot> {
        Box::pin(async move {
            ctx.check_current(&scope(1))?;
            let note = self
                .notes
                .iter()
                .find(|n| n.document.reference().note_id == request.note)
                .ok_or(DomainError::ResourceNotFound)?;
            note.document.explicit_read(ctx.auth())?;
            Ok(note.clone())
        })
    }
    fn list_notes(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<NoteQuery>,
    ) -> PortFuture<'_, FolderPage> {
        Box::pin(async move {
            ctx.check_current(&scope(1))?;
            let ReadRequest::Open { query, .. } = request else {
                return Err(DomainError::ResourceNotFound.into());
            };
            let items = self
                .notes
                .iter()
                .filter(|n| {
                    query.lifecycle.includes(n.document.lifecycle())
                        && query.classes.contains(&n.document.class())
                })
                .map(|n| {
                    Ok(NoteListCard {
                        document: n.document.listing(ctx.auth())?,
                        title: "Title".into(),
                        path: "note.md".into(),
                    })
                })
                .collect::<notarium_core::DomainResult<_>>()?;
            Ok(FolderPage {
                folder: FolderRef {
                    space_id: scope(1).space_id,
                    folder_id: FolderId::from_bytes([1; 16]),
                },
                page: None,
                children: CursorPage {
                    items,
                    next: None,
                    scope: scope(1),
                    canonical_seq: SpaceSeq::new(10).unwrap(),
                    projected_seq: SpaceSeq::new(10).unwrap(),
                    incomplete: false,
                    diagnostics: vec![],
                },
            })
        })
    }
    fn read_ability_resource(
        &self,
        ctx: SpaceContext,
        request: ReadAbilityResource,
    ) -> PortFuture<'_, ClassifiedAbilityResource> {
        Box::pin(async move {
            ctx.check_current(&scope(1))?;
            let resource = self
                .resources
                .get(&(request.ability, request.package_revision, request.resource))
                .ok_or(DomainError::ResourceNotFound)?;
            resource.explicit_read(ctx.auth())?;
            Ok(resource.clone())
        })
    }
    fn recent_activity(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        self.seed(ctx, request)
    }
    fn read_changes(
        &self,
        ctx: SpaceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        self.seed(ctx, request)
    }
}
impl ContentJobPort for ReadFixture {
    fn create_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<ContentJobKind>,
    ) -> PortFuture<'_, Committed<ContentJob>> {
        support::RejectingPorts.create_job(ctx, request)
    }
    fn get_job(&self, ctx: SpaceContext, job: JobId) -> PortFuture<'_, ContentJob> {
        support::RejectingPorts.get_job(ctx, job)
    }
    fn cancel_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<CancelJob>,
    ) -> PortFuture<'_, Committed<ContentJob>> {
        support::RejectingPorts.cancel_job(ctx, request)
    }
    fn list_jobs(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<JobQuery, JobId>,
    ) -> PortFuture<'_, CursorPage<ContentJob, JobId>> {
        Box::pin(async move {
            ctx.check_current(&scope(1))?;
            let (start, limit) = match request {
                ReadRequest::Open { query, .. } => (0, usize::from(query.limit.get())),
                ReadRequest::Continue { cursor } => {
                    cursor.check(&fixture_read())?;
                    (
                        self.jobs
                            .iter()
                            .position(|j| j.id == cursor.last.entity_id)
                            .unwrap()
                            + 1,
                        200,
                    )
                }
            };
            let end = (start + limit).min(self.jobs.len());
            let next = (end < self.jobs.len()).then(|| KeysetCursor {
                version: 1,
                scope: scope(1),
                fingerprint: fixture_read().fingerprint,
                effective_read: fixture_read().id,
                generation: fixture_read().cut.generation,
                base_cut: fixture_read().cut.projected_seq,
                last: SortTuple {
                    cells: vec![],
                    entity_id: self.jobs[end - 1].id.clone(),
                },
            });
            Ok(CursorPage {
                items: self.jobs[start..end].to_vec(),
                next,
                scope: scope(1),
                canonical_seq: SpaceSeq::new(10).unwrap(),
                projected_seq: SpaceSeq::new(10).unwrap(),
                incomplete: false,
                diagnostics: vec![],
            })
        })
    }
}
fn fixture_read() -> EffectiveRead {
    EffectiveRead {
        id: EffectiveReadId::from_bytes([1; 16]),
        cut: SnapshotCut {
            scope: scope(1),
            generation: ProjectionGeneration::new(1).unwrap(),
            canonical_seq: SpaceSeq::new(10).unwrap(),
            projected_seq: SpaceSeq::new(10).unwrap(),
        },
        fingerprint: ContentDigest::from_bytes([1; 32]),
        exact_receipts: ReceiptSet::default(),
        overlay: vec![],
    }
}

#[test]
fn paginated_seed_and_jobs_preserve_their_own_identity_types_and_cut() {
    for (note_count, thread_count) in [(0, 201), (2, 201), (201, 2)] {
        let fixture = ReadFixture {
            notes: (1..=note_count)
                .map(|n| note_snapshot(n, DocClass::UserDoc, Lifecycle::Active))
                .collect(),
            threads: (1..=thread_count)
                .map(|n| ChatThread {
                    id: ChatThreadId::from_bytes([n; 16]),
                    space: scope(1).space_id,
                    kind: ChatThreadKind::Personal,
                    owner: PrincipalId::from_bytes([1; 16]),
                    project_folder: None,
                    head: ThreadEntrySeq::ZERO,
                    revision: RevisionId::from_bytes([n; 16]),
                    tainted: false,
                })
                .collect(),
            jobs: (1..=201)
                .map(|n| ContentJob {
                    id: JobId::from_bytes([n; 16]),
                    kind: ContentJobKind::Backup,
                    state: JobState::Queued,
                    completed_units: 0,
                    total_units: None,
                    lease: LeaseEpoch::ZERO,
                    artifacts: vec![],
                })
                .collect(),
            ..ReadFixture::default()
        };
        let reader: &dyn NoteReadPort = &fixture;
        let mut request = ChangeRead::Seed {
            scope: scope(1),
            cutoff: Some(SpaceSeq::new(10).unwrap()),
            limit: PageLimit::new(200).unwrap(),
        };
        let mut notes = vec![];
        let mut threads = vec![];
        let mut pages = 0;
        loop {
            let ChangeReadResult::Seed(page) =
                ready(reader.read_changes(context(), request)).unwrap()
            else {
                panic!()
            };
            assert_eq!(page.cutoff, cursor(10));
            assert!(page.notes.len() + page.threads.len() <= 200);
            notes.extend(
                page.notes
                    .into_iter()
                    .map(|n| n.document.reference().note_id.clone()),
            );
            threads.extend(page.threads.into_iter().map(|t| t.id));
            pages += 1;
            match page.next {
                Some(cursor) => request = ChangeRead::ContinueSeed { cursor },
                None => break,
            }
        }
        assert_eq!(pages, 2);
        assert_eq!(
            notes,
            fixture
                .notes
                .iter()
                .map(|n| n.document.reference().note_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            threads,
            fixture
                .threads
                .iter()
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
        );
        let jobs: &dyn ContentJobPort = &fixture;
        let first = ready(jobs.list_jobs(
            context(),
            ReadRequest::Open {
                query: JobQuery {
                    states: vec![JobState::Queued],
                    limit: PageLimit::new(200).unwrap(),
                },
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        ))
        .unwrap();
        let next = first.next.unwrap();
        let last: JobId = next.last.entity_id.clone();
        assert_eq!(last, fixture.jobs[199].id);
        let second =
            ready(jobs.list_jobs(context(), ReadRequest::Continue { cursor: next })).unwrap();
        assert_eq!(first.items.len(), 200);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, fixture.jobs[200].id);
        assert!(second.next.is_none());
    }
}

#[test]
fn trash_is_readable_and_listable_without_secondary_content_capabilities() {
    let fixture = ReadFixture {
        notes: vec![
            note_snapshot(1, DocClass::UserDoc, Lifecycle::Trashed),
            note_snapshot(2, DocClass::EncryptedNote, Lifecycle::Trashed),
            note_snapshot(3, DocClass::UserDoc, Lifecycle::Purged),
        ],
        ..ReadFixture::default()
    };
    let reader: &dyn NoteReadPort = &fixture;
    let note = ready(reader.get_note(
        context(),
        GetNote {
            note: NoteId::from_bytes([1; 16]),
            revision: None,
            causal: CausalBasis::Exact(ReceiptSet::default()),
        },
    ))
    .unwrap();
    assert_eq!(note.document.lifecycle(), Lifecycle::Trashed);
    assert_eq!(
        note.document.explicit_read(&auth()).unwrap(),
        "authored text"
    );
    let list = ready(reader.list_notes(
        context(),
        ReadRequest::Open {
            query: NoteQuery {
                folder: None,
                recursive: true,
                classes: DocClass::all(),
                lifecycle: LifecycleMask::Trashed,
                filter: FieldFilterAstV1 {
                    version: 1,
                    predicate: Predicate::All(vec![]),
                },
                sort: SortSpec::default(),
                limit: PageLimit::new(200).unwrap(),
            },
            causal: CausalBasis::Exact(ReceiptSet::default()),
        },
    ))
    .unwrap();
    assert_eq!(list.children.items.len(), 2);
    assert!(
        list.children
            .items
            .iter()
            .all(|c| c.document.lifecycle() == Lifecycle::Trashed)
    );
    for note in &fixture.notes {
        assert!(ClassEgressFence::search(note.document.clone(), &auth()).is_err());
        assert!(ClassEgressFence::projection(note.document.clone(), &auth()).is_err());
    }
    assert!(
        ready(reader.get_note(
            context(),
            GetNote {
                note: NoteId::from_bytes([3; 16]),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default())
            }
        ))
        .is_err()
    );
}

#[test]
fn package_reads_select_exact_entrypoint_and_auxiliary_revisions() {
    let ability = AbilityId::from_bytes([1; 16]);
    let mut fixture = ReadFixture::default();
    for n in [1, 2] {
        let package = PublishAbilityPackage {
            ability: ability.clone(),
            kind: AbilityKind::Skill,
            entrypoint: NoteId::from_bytes([1; 16]),
            expected_package_revision: None,
            files: ["SKILL.md", "resources/rules.md"]
                .into_iter()
                .map(|path| AbilityFile {
                    path: path.into(),
                    content: format!("{path} revision {n}"),
                    digest: ContentDigest::from_bytes([n; 32]),
                })
                .collect(),
        };
        let committed = fixture.publish(package, RevisionId::from_bytes([n; 16]));
        assert_eq!(committed.manifest.len(), 2);
    }
    let reader: &dyn NoteReadPort = &fixture;
    let policy = ProviderPolicy {
        provider: ProviderResourceId::from_bytes([1; 16]),
        audience: ProviderAudience::Personal { consented: true },
        allowed_classes: DocClass::all(),
    };
    for n in [1, 2] {
        for (resource, path) in [
            (AbilityResourceName::Entrypoint, "SKILL.md"),
            (
                AbilityResourceName::Auxiliary("resources/rules.md".into()),
                "resources/rules.md",
            ),
        ] {
            let read = ready(reader.read_ability_resource(
                context(),
                ReadAbilityResource {
                    ability: ability.clone(),
                    package_revision: RevisionId::from_bytes([n; 16]),
                    resource,
                },
            ))
            .unwrap();
            assert_eq!(
                read.explicit_read(&auth()).unwrap(),
                format!("{path} revision {n}")
            );
            assert_eq!(
                read.reference().package_revision,
                RevisionId::from_bytes([n; 16])
            );
            assert_eq!(read.digest(), ContentDigest::from_bytes([n; 32]));
            assert!(!format!("{read:?}").contains("revision 1"));
            let provider = ClassEgressFence::ability(read.clone(), &auth(), &policy).unwrap();
            assert_eq!(provider.text(), read.explicit_read(&auth()).unwrap());
            assert!(
                ClassEgressFence::ability(
                    read,
                    &auth(),
                    &ProviderPolicy {
                        audience: ProviderAudience::Personal { consented: false },
                        ..policy.clone()
                    }
                )
                .is_err()
            );
        }
    }
    for (revision, resource) in [
        (3, AbilityResourceName::Entrypoint),
        (1, AbilityResourceName::Auxiliary("missing.md".into())),
    ] {
        assert!(
            ready(reader.read_ability_resource(
                context(),
                ReadAbilityResource {
                    ability: ability.clone(),
                    package_revision: RevisionId::from_bytes([revision; 16]),
                    resource
                }
            ))
            .is_err()
        );
    }
}
fn scope(history: u8) -> HistoryScope {
    HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([history; 16]),
    }
}
fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([1; 16]),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(1),
    }
}
fn auth() -> EngineAuthContext {
    EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes([1; 16]),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(
            scope(1).space_id,
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        true,
    ))
}
fn context() -> SpaceContext {
    SpaceContext::new(auth(), scope(1), budget()).unwrap()
}
fn identity(byte: u8) -> CommandIdentity {
    CommandIdentity {
        scope: scope(1),
        actor: PrincipalId::from_bytes([1; 16]),
        key: CommandKey::from_bytes([byte; 16]),
        hash: ContentDigest::from_bytes([byte; 32]),
    }
}

#[test]
fn all_nine_port_boundaries_are_object_safe_and_use_runtime_free_send_futures() {
    let ports = Arc::new(support::RejectingPorts);
    let _: Arc<dyn EnginePort> = ports.clone();
    let control: Arc<dyn ControlPort> = ports.clone();
    let _: Arc<dyn StructuralReadPort> = ports.clone();
    let _: Arc<dyn ChangeBroadcast> = ports.clone();
    let _: Arc<dyn EmbeddingProviderPort> = ports.clone();
    let _: Arc<dyn LiveCollabInterceptor> = ports.clone();
    let _: Arc<dyn EventBusPort> = ports.clone();
    let _: Arc<dyn SessionRevocationPort> = ports.clone();
    let _: Arc<dyn BackupParticipantPort> = ports.clone();
    let _: Arc<dyn BoardMutationFactsProvider> = ports.clone();
    fn require_send<T: Send>(_: &T) {}
    let call = control.whoami(AccountContext::new(auth(), budget()));
    require_send(&call);
    assert!(matches!(
        ready(call),
        Err(notarium_core::error::PortError::Domain(
            DomainError::ResourceNotFound
        ))
    ));
    let evidence = AuthEvidence::new(
        AuthEvidenceKind::Pat,
        "test-credential-must-not-appear".into(),
    );
    assert!(!format!("{evidence:?}").contains("test-credential"));
    assert!(
        ready(control.resolve_auth(PreAuthContext {
            budget: budget(),
            evidence
        }))
        .is_err()
    );
    assert!(context().check_current(&scope(2)).is_err());
    let cancellation = budget().cancellation;
    let clone = cancellation.clone();
    clone.cancel();
    assert!(cancellation.is_cancelled());
    assert!(
        ServiceAuthority::admit(ServicePurpose::Projection)
            .require(ServicePurpose::Backup)
            .is_err()
    );
}

#[test]
fn room_open_close_and_command_changes_invalidate_linear_reservations() {
    let note = NoteId::from_bytes([1; 16]);
    let mut room = RoomFenceState::new(note.clone(), scope(1), LeaseEpoch::ZERO);
    let RollbackReservation::Closed(stale) = room.reserve(identity(1)).unwrap() else {
        panic!()
    };
    room.open().unwrap();
    assert!(matches!(
        room.reserve(identity(1)).unwrap(),
        RollbackReservation::SkippedRoomActive
    ));
    room.close().unwrap();
    assert!(room.consume(stale, &identity(1)).is_err());
    let RollbackReservation::Closed(wrong_command) = room.reserve(identity(1)).unwrap() else {
        panic!()
    };
    assert!(room.consume(wrong_command, &identity(2)).is_err());
    let RollbackReservation::Closed(valid) = room.reserve(identity(1)).unwrap() else {
        panic!()
    };
    let permit = room.consume(valid, &identity(1)).unwrap();
    assert_eq!(permit.note, note);
    assert_eq!(permit.identity, identity(1));
    let restored = CommandIdentity {
        scope: scope(2),
        ..identity(1)
    };
    assert!(room.reserve(restored).is_err());
}

#[test]
fn board_interception_retains_rank_intent_and_unforgeable_facts() {
    let authority = BoardPlannerAuthority::admit();
    let other_authority = BoardPlannerAuthority::admit();
    let board = MoveBoardCard {
        view: ViewRef {
            note: NoteId::from_bytes([1; 16]),
            key: ViewKey::from_bytes([1; 16]),
        },
        note: NoteId::from_bytes([2; 16]),
        group: GroupKey::Value(ScalarValue::String("done".into())),
        before: None,
        after: Some(RankNeighbor {
            note: NoteId::from_bytes([3; 16]),
            expected_rank: RankExpectation::Absent,
        }),
        fields: BTreeMap::from([("status".into(), Some(YamlValue::String("done".into())))]),
        expected_note: RevisionId::from_bytes([1; 16]),
        expected_view: RevisionId::from_bytes([1; 16]),
        expected_rank: RankExpectation::Absent,
    };
    let facts = BoardMoveFacts::attest(
        &authority,
        BoardMoveFactsSpec {
            scope: scope(1),
            cutoff: SpaceSeq::new(10).unwrap(),
            view: board.view.clone(),
            view_revision: board.expected_view.clone(),
            schema_revision: None,
            descriptor_fingerprint: ContentDigest::from_bytes([7; 32]),
            group_field: "status".into(),
            group_field_kind: BoardGroupFieldKind::String,
            groups: vec![EvaluatedBoardGroup {
                group: board.group.clone(),
                rows: vec![EvaluatedBoardRow {
                    note: NoteId::from_bytes([3; 16]),
                    expected_note: RevisionId::from_bytes([3; 16]),
                    expected_rank: RankExpectation::Absent,
                    base_order_binding: ContentDigest::from_bytes([3; 32]),
                }],
            }],
            before_placement: SemanticPlacement::InGroup {
                group: GroupKey::Value(ScalarValue::String("todo".into())),
                predecessor: None,
                successor: None,
            },
            base_order_binding: ContentDigest::from_bytes([2; 32]),
            after_eligible_in_group: true,
        },
    );
    assert!(facts.verify_authority(&authority).is_ok());
    assert!(facts.verify_authority(&other_authority).is_err());
    let request = InterceptedMutation {
        context: context(),
        identity: identity(1),
        preconditions: Preconditions {
            revision: Some(board.expected_note.clone()),
            ..Preconditions::default()
        },
        payload: InterceptedPayload::MoveBoardCard {
            card: board.clone(),
            facts: Box::new(facts.clone()),
        },
    };
    let InterceptedPayload::MoveBoardCard {
        card: intercepted,
        facts: intercepted_facts,
    } = request.payload
    else {
        panic!()
    };
    assert_eq!(intercepted, board);
    assert_eq!(*intercepted_facts, facts);
    let moved_elsewhere = MoveBoardCard {
        before: board.after.clone(),
        after: None,
        ..board.clone()
    };
    assert_ne!(board, moved_elsewhere);
    assert_eq!(board.fields, moved_elsewhere.fields);
}

#[test]
fn completion_accepts_authorized_chat_provenance_without_inventing_a_note() {
    let space = Space {
        id: scope(1).space_id,
        kind: SpaceKind::Shared,
        lifecycle: SpaceLifecycle::Active,
    };
    let policy = ProviderPolicy {
        provider: ProviderResourceId::from_bytes([1; 16]),
        audience: ProviderAudience::Shared {
            space: space.id.clone(),
            attached: true,
            space_consented: true,
            sender_consented: true,
        },
        allowed_classes: DocClass::all(),
    };
    let entry = CanonicalChatContent::from_canonical(
        space.clone(),
        ChatThreadId::from_bytes([1; 16]),
        ThreadEntrySeq::new(1).unwrap(),
        false,
        "hello-provider".into(),
    );
    assert!(!format!("{entry:?}").contains("hello-provider"));
    let admitted = ClassEgressFence::chat(entry.clone(), &auth(), &policy).unwrap();
    assert_eq!(admitted.text(), "hello-provider");
    assert_eq!(admitted.provider(), &policy.provider);
    let denied = ProviderPolicy {
        audience: ProviderAudience::Personal { consented: true },
        ..policy.clone()
    };
    assert!(ClassEgressFence::chat(entry, &auth(), &denied).is_err());
    let tainted = CanonicalChatContent::from_canonical(
        space,
        ChatThreadId::from_bytes([1; 16]),
        ThreadEntrySeq::new(2).unwrap(),
        true,
        "external".into(),
    );
    assert!(ClassEgressFence::chat(tainted, &auth(), &policy).is_err());
}

#[test]
fn mcp_coverage_has_28_named_operations_and_typed_method_witnesses() {
    // Registry orchestration belongs to the agent adapter. These references fail
    // to compile if its required domain operation disappears or becomes generic.
    let tools = [
        "start_session",
        "list_abilities",
        "use_role",
        "use_skill",
        "whoami",
        "get_my_projects",
        "list_notes",
        "recent_activity",
        "search",
        "get_note",
        "recall",
        "get_ability",
        "create_ability",
        "edit_ability",
        "delete_ability",
        "create_note",
        "create_notes",
        "edit_note",
        "remember_about_user",
        "remember_about_project",
        "link",
        "link_many",
        "delete_note",
        "move_note",
        "rename_note",
        "move_folder",
        "rename_folder",
        "rename_project",
    ];
    assert_eq!(
        tools
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        28
    );
    let _ = (
        <dyn ControlPort>::start_or_resume_episode,
        <dyn ControlPort>::bootstrap_context,
        <dyn ControlPort>::acknowledge_delta,
        <dyn ControlPort>::discover_abilities,
        <dyn ControlPort>::resolve_ability,
        <dyn ControlPort>::update_episode,
        <dyn ControlPort>::whoami,
        <dyn ControlPort>::list_projects,
        <dyn ControlPort>::get_ability,
        <dyn ControlPort>::update_ability_binding,
        <dyn ControlPort>::resolve_memory_target,
    );
    let _ = (
        <dyn EnginePort>::list_notes,
        <dyn EnginePort>::recent_activity,
        <dyn EnginePort>::search,
        <dyn EnginePort>::get_note,
        <dyn EnginePort>::query_view,
        <dyn EnginePort>::recall,
        <dyn EnginePort>::publish_ability_package,
        <dyn EnginePort>::create_note,
        <dyn EnginePort>::accept_batch,
        <dyn EnginePort>::edit_note,
        <dyn EnginePort>::append_memory,
        <dyn EnginePort>::link,
        <dyn EnginePort>::link_many,
        <dyn EnginePort>::delete_note,
        <dyn EnginePort>::move_note,
        <dyn EnginePort>::rename_note,
        <dyn EnginePort>::move_folder,
        <dyn EnginePort>::rename_folder,
        <dyn EnginePort>::rename_project,
    );
}

struct ClusterGraphFixture {
    cut: SnapshotCut,
    clusters: BTreeMap<ClusterId, Vec<NoteId>>,
    project: FolderId,
}
impl ViewGraphPort for ClusterGraphFixture {
    fn query_view(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<ViewQuery>,
    ) -> PortFuture<'_, ViewResult> {
        support::RejectingPorts.query_view(ctx, request)
    }
    fn move_board_card(
        &self,
        ctx: SpaceContext,
        request: Mutation<MoveBoardCard>,
    ) -> PortFuture<'_, Committed<BoardMoveResult>> {
        support::RejectingPorts.move_board_card(ctx, request)
    }
    fn query_graph(&self, ctx: SpaceContext, request: GraphQuery) -> PortFuture<'_, GraphResult> {
        Box::pin(async move {
            ctx.check_current(&self.cut.scope)?;
            request.validate()?;
            let mut edges = vec![];
            let nodes: Vec<_> = match request.tier {
                GraphTier::Superclusters => {
                    let nodes: Vec<_> = self
                        .clusters
                        .iter()
                        .map(|(id, members)| GraphNode {
                            id: GraphNodeId::Cluster(id.clone()),
                            card: None,
                            member_count: members.len() as u64,
                        })
                        .collect();
                    if nodes.len() == 2 {
                        edges.push(GraphEdge {
                            source: nodes[0].id.clone(),
                            target: nodes[1].id.clone(),
                            weight: 1.0,
                        });
                    }
                    nodes
                }
                GraphTier::Lens {
                    cluster,
                    project,
                    tags,
                } => {
                    let members: Vec<_> = match cluster {
                        Some(id) => self
                            .clusters
                            .get(&id)
                            .ok_or(DomainError::ResourceNotFound)?
                            .clone(),
                        None => self
                            .clusters
                            .values()
                            .flatten()
                            .cloned()
                            .collect::<std::collections::BTreeSet<_>>()
                            .into_iter()
                            .collect(),
                    };
                    // Every fixture member belongs to this project and tag.
                    let matches = project.is_none_or(|p| p == self.project)
                        && tags.iter().all(|tag| tag == "visible")
                        && request.filter.matches(&BTreeMap::new(), &BTreeMap::new())?;
                    members
                        .into_iter()
                        .filter(|_| matches)
                        .map(|id| GraphNode {
                            id: GraphNodeId::Note(id),
                            card: None,
                            member_count: 1,
                        })
                        .collect()
                }
                GraphTier::Neighborhood { .. } => {
                    return Err(DomainError::ResourceNotFound.into());
                }
            };
            Ok(GraphResult {
                nodes,
                edges,
                hidden_count: 0,
                truncated: false,
                cut: self.cut.clone(),
            })
        })
    }
}

#[test]
fn cluster_identity_survives_membership_changes_and_selects_a_typed_lens() {
    let first = ClusterId::from_bytes([1; 16]);
    let second = ClusterId::from_bytes([2; 16]);
    let note = |value| NoteId::from_bytes([value; 16]);
    let project = FolderId::from_bytes([3; 16]);
    let query = |tier| GraphQuery {
        tier,
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(vec![]),
        },
    };
    let old = ClusterGraphFixture {
        cut: fixture_read().cut,
        clusters: BTreeMap::from([
            (first.clone(), vec![note(1), note(2)]),
            (second.clone(), vec![note(3)]),
        ]),
        project: project.clone(),
    };
    let new = ClusterGraphFixture {
        cut: SnapshotCut {
            generation: ProjectionGeneration::new(2).unwrap(),
            projected_seq: SpaceSeq::new(11).unwrap(),
            canonical_seq: SpaceSeq::new(11).unwrap(),
            ..old.cut.clone()
        },
        clusters: BTreeMap::from([
            (first.clone(), vec![note(2), note(4)]),
            (second.clone(), vec![note(3), note(1)]),
        ]),
        project: project.clone(),
    };
    let old_port: &dyn ViewGraphPort = &old;
    let new_port: &dyn ViewGraphPort = &new;
    let before = ready(old_port.query_graph(context(), query(GraphTier::Superclusters))).unwrap();
    let after = ready(new_port.query_graph(context(), query(GraphTier::Superclusters))).unwrap();
    let expected = vec![
        GraphNodeId::Cluster(first.clone()),
        GraphNodeId::Cluster(second.clone()),
    ];
    for result in [&before, &after] {
        assert_eq!(
            result
                .nodes
                .iter()
                .map(|n| n.id.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(result.nodes.iter().all(|n| n.card.is_none()));
        assert_eq!(result.edges[0].source, expected[0]);
        assert_eq!(result.edges[0].target, expected[1]);
    }
    assert_ne!(before.cut.generation, after.cut.generation);
    assert_eq!(before.nodes[1].member_count, 1);
    assert_eq!(after.nodes[1].member_count, 2);
    let GraphNodeId::Cluster(selected) = after.nodes[0].id.clone() else {
        panic!("the supernode must carry a cluster identity");
    };
    let lens = |cluster, project| {
        query(GraphTier::Lens {
            cluster,
            project,
            tags: vec!["visible".into()],
        })
    };
    for (port, members) in [
        (
            old_port,
            vec![GraphNodeId::Note(note(1)), GraphNodeId::Note(note(2))],
        ),
        (
            new_port,
            vec![GraphNodeId::Note(note(2)), GraphNodeId::Note(note(4))],
        ),
    ] {
        let result = ready(port.query_graph(
            context(),
            lens(Some(selected.clone()), Some(project.clone())),
        ))
        .unwrap();
        assert_eq!(
            result.nodes.into_iter().map(|n| n.id).collect::<Vec<_>>(),
            members
        );
    }
    let excluded = ready(new_port.query_graph(
        context(),
        lens(Some(selected), Some(FolderId::from_bytes([9; 16]))),
    ))
    .unwrap();
    assert!(excluded.nodes.is_empty());
    assert!(
        ready(new_port.query_graph(context(), lens(Some(ClusterId::from_bytes([9; 16])), None),))
            .is_err()
    );
    let stale = SpaceContext::new(auth(), scope(2), budget()).unwrap();
    assert!(ready(new_port.query_graph(stale, query(GraphTier::Superclusters))).is_err());
    assert_eq!(query(GraphTier::Superclusters).node_limit(), 500);
    assert_eq!(lens(None, None).node_limit(), 2000);
    assert!(
        query(GraphTier::Neighborhood {
            note: note(1),
            hops: 3
        })
        .validate()
        .is_err()
    );
}

struct GraphFixture {
    cut: SnapshotCut,
    notes: Vec<NoteId>,
    neighbors: Vec<u32>,
}
struct PinnedGraph(Arc<GraphFixture>);
impl StructuralSnapshot for PinnedGraph {
    fn cut(&self) -> &SnapshotCut {
        &self.0.cut
    }
    fn lookup(&self, note: &NoteId) -> Option<DenseNodeId> {
        self.0
            .notes
            .iter()
            .position(|n| n == note)
            .map(|i| DenseNodeId::new(self.0.cut.generation, i as u32))
    }
    fn note_id(&self, node: DenseNodeId) -> notarium_core::DomainResult<&NoteId> {
        self.0
            .notes
            .get(node.index(self.0.cut.generation)? as usize)
            .ok_or(DomainError::ResourceNotFound)
    }
    fn folder_subtree(&self, _: &FolderId) -> notarium_core::DomainResult<DenseNodeIter<'_>> {
        Ok(DenseNodeIter::from_iter(
            self.0.cut.generation,
            self.0.neighbors.iter().copied(),
        ))
    }
    fn outgoing(&self, node: DenseNodeId) -> notarium_core::DomainResult<DenseNodeIter<'_>> {
        self.note_id(node)?;
        Ok(DenseNodeIter::from_slice(
            self.0.cut.generation,
            &self.0.neighbors,
        ))
    }
    fn incoming(&self, node: DenseNodeId) -> notarium_core::DomainResult<DenseNodeIter<'_>> {
        self.outgoing(node)
    }
}
struct StructuralFixture {
    current: std::sync::Mutex<Arc<GraphFixture>>,
    visible: std::sync::atomic::AtomicBool,
}
impl StructuralReadPort for StructuralFixture {
    fn acquire_snapshot(
        &self,
        ctx: SpaceContext,
        _: CausalBasis,
    ) -> PortFuture<'_, Box<dyn StructuralSnapshot>> {
        Box::pin(async move {
            let current = self.current.lock().unwrap().clone();
            ctx.check_current(&current.cut.scope)?;
            Ok(Box::new(PinnedGraph(current)) as Box<dyn StructuralSnapshot>)
        })
    }
    fn is_live_visible(&self, ctx: &SpaceContext, _: &NoteId) -> notarium_core::DomainResult<bool> {
        ctx.check_current(&self.current.lock().unwrap().cut.scope)?;
        Ok(self.visible.load(std::sync::atomic::Ordering::SeqCst))
    }
    fn hydrate(
        &self,
        ctx: SpaceContext,
        cut: SnapshotCut,
        notes: Vec<NoteId>,
    ) -> PortFuture<'_, Vec<Option<NoteCard>>> {
        Box::pin(async move {
            ctx.check_current(&cut.scope)?;
            // This adapter owns only compact indices and metadata, no carrier
            // store. Hydration must not manufacture empty canonical content.
            let current = self.current.lock().unwrap().clone();
            let mut cards = Vec::new();
            for note in notes {
                if !self.is_live_visible(&ctx, &note)? || !current.notes.contains(&note) {
                    cards.push(None);
                    continue;
                }
                let metadata = ClassifiedMetadata::from_canonical(
                    NoteRef {
                        space_id: cut.scope.space_id.clone(),
                        note_id: note,
                    },
                    RevisionId::from_bytes([1; 16]),
                    ResourceFacts {
                        space: Space {
                            id: cut.scope.space_id.clone(),
                            lifecycle: SpaceLifecycle::Active,
                            kind: SpaceKind::Personal,
                        },
                        class: DocClass::UserDoc,
                        ancestor_folders: vec![],
                        folder_write_locked: false,
                        ability_package: None,
                    },
                    Lifecycle::Active,
                    ContentDigest::from_bytes([1; 32]),
                )?;
                cards.push(Some(NoteCard {
                    document: ClassEgressFence::search_metadata(metadata, ctx.auth())?,
                    title: "Title".into(),
                    path: "Folder/title".into(),
                    preview: "preview".into(),
                }));
            }
            Ok(cards)
        })
    }
}
fn graph(generation: u64) -> Arc<GraphFixture> {
    let generation = ProjectionGeneration::new(generation).unwrap();
    Arc::new(GraphFixture {
        cut: SnapshotCut {
            scope: scope(1),
            generation,
            canonical_seq: SpaceSeq::new(10).unwrap(),
            projected_seq: SpaceSeq::new(10).unwrap(),
        },
        notes: vec![NoteId::from_bytes([1; 16])],
        neighbors: vec![0],
    })
}
#[test]
fn pinned_graph_survives_a_swap_but_visibility_uses_the_current_fence() {
    let port = StructuralFixture {
        current: std::sync::Mutex::new(graph(1)),
        visible: true.into(),
    };
    let old =
        ready(port.acquire_snapshot(context(), CausalBasis::Exact(ReceiptSet::default()))).unwrap();
    let id = NoteId::from_bytes([1; 16]);
    let interface: &dyn StructuralReadPort = &port;
    let page = ready(interface.hydrate(
        context(),
        old.cut().clone(),
        vec![NoteId::from_bytes([9; 16]), id.clone()],
    ))
    .unwrap();
    assert!(page[0].is_none());
    assert_eq!(
        page[1]
            .as_ref()
            .unwrap()
            .document
            .provenance()
            .reference()
            .note_id,
        id
    );
    assert_eq!(page[1].as_ref().unwrap().preview, "preview");
    let node = old.lookup(&id).unwrap();
    let mut neighbors = old.outgoing(node).unwrap();
    *port.current.lock().unwrap() = graph(2);
    port.visible
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let new =
        ready(port.acquire_snapshot(context(), CausalBasis::Exact(ReceiptSet::default()))).unwrap();
    assert_eq!(old.note_id(neighbors.next().unwrap()).unwrap(), &id);
    assert!(new.note_id(node).is_err());
    assert!(!port.is_live_visible(&context(), &id).unwrap());
    assert_eq!(
        ready(port.hydrate(context(), old.cut().clone(), vec![id.clone(), id]))
            .unwrap()
            .len(),
        2
    );
}

struct SubscriptionFixture {
    processed: ChangeCursor,
    delivered: SpaceSeq,
    notices: std::collections::VecDeque<ChangeNotice>,
}
impl ChangeSubscription for SubscriptionFixture {
    fn processed(&self) -> &ChangeCursor {
        &self.processed
    }
    fn next(&mut self) -> PortFuture<'_, Option<ChangeNotice>> {
        Box::pin(async {
            let next = self.notices.pop_front();
            if let Some(ChangeNotice::Advanced(c) | ChangeNotice::SeedRequired { cutoff: c }) =
                &next
            {
                self.delivered = c.after;
            }
            Ok(next)
        })
    }
    fn acknowledge(&mut self, processed: ChangeCursor) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.processed.scope.check(&processed.scope)?;
            if processed.after < self.processed.after || processed.after > self.delivered {
                return Err(DomainError::ResourceNotFound.into());
            }
            self.processed = processed;
            Ok(())
        })
    }
}
fn cursor(n: u64) -> ChangeCursor {
    ChangeCursor {
        scope: scope(1),
        after: SpaceSeq::new(n).unwrap(),
    }
}
struct BroadcastFixture;
impl ChangeBroadcast for BroadcastFixture {
    fn subscribe(
        &self,
        ctx: MaintenanceContext,
        after: ChangeCursor,
    ) -> PortFuture<'_, Box<dyn ChangeSubscription>> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Projection)?;
            scope(1).check(&after.scope)?;
            Ok(Box::new(SubscriptionFixture {
                processed: after.clone(),
                delivered: after.after,
                notices: [
                    ChangeNotice::SeedRequired { cutoff: cursor(10) },
                    ChangeNotice::Advanced(cursor(11)),
                ]
                .into(),
            }) as Box<dyn ChangeSubscription>)
        })
    }
    fn catch_up(
        &self,
        ctx: MaintenanceContext,
        request: ChangeRead,
    ) -> PortFuture<'_, ChangeReadResult> {
        Box::pin(async move {
            ctx.authority.require(ServicePurpose::Projection)?;
            match request {
                ChangeRead::Seed {
                    scope: expected, ..
                } => {
                    scope(1).check(&expected)?;
                    Ok(ChangeReadResult::Seed(ChangeSeed {
                        notes: vec![],
                        threads: vec![],
                        cutoff: cursor(10),
                        next: None,
                    }))
                }
                ChangeRead::ContinueSeed { .. } => {
                    unreachable!("empty fixture seed has no continuation")
                }
                ChangeRead::Log { after, through, .. } => {
                    scope(1).check(&after.scope)?;
                    Ok(ChangeReadResult::Log(ChangePage {
                        changes: vec![],
                        next: ChangeCursor {
                            after: through,
                            ..after
                        },
                        safe_ack_end: through,
                        cutoff: through,
                        complete: true,
                    }))
                }
            }
        })
    }
}
fn maintenance(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: budget(),
    }
}
#[test]
fn subscribers_own_independent_acknowledgements_and_seed_cutoffs() {
    let broadcast = BroadcastFixture;
    let mut search =
        ready(broadcast.subscribe(maintenance(ServicePurpose::Projection), cursor(0))).unwrap();
    let mut projection =
        ready(broadcast.subscribe(maintenance(ServicePurpose::Projection), cursor(0))).unwrap();
    assert!(ready(search.acknowledge(cursor(10))).is_err());
    assert!(matches!(
        ready(search.next()).unwrap(),
        Some(ChangeNotice::SeedRequired { .. })
    ));
    let ChangeReadResult::Seed(seed) = ready(broadcast.catch_up(
        maintenance(ServicePurpose::Projection),
        ChangeRead::Seed {
            scope: scope(1),
            cutoff: None,
            limit: PageLimit::new(100).unwrap(),
        },
    ))
    .unwrap() else {
        panic!()
    };
    ready(search.acknowledge(seed.cutoff)).unwrap();
    assert_eq!(projection.processed().after, SpaceSeq::ZERO);
    assert!(matches!(
        ready(search.next()).unwrap(),
        Some(ChangeNotice::Advanced(_))
    ));
    ready(search.acknowledge(cursor(11))).unwrap();
    assert_eq!(search.processed().after, SpaceSeq::new(11).unwrap());
    ready(projection.next()).unwrap();
    ready(projection.acknowledge(cursor(10))).unwrap();
    assert!(
        ready(search.acknowledge(ChangeCursor {
            scope: scope(2),
            after: SpaceSeq::new(11).unwrap()
        }))
        .is_err()
    );
    assert_eq!(projection.processed().after, SpaceSeq::new(10).unwrap());
}

#[derive(Default, Debug)]
struct BackupState {
    holds: usize,
    pauses: usize,
    snapshots: usize,
}
type BackupStateRef = Arc<std::sync::Mutex<BackupState>>;
enum GuardKind {
    Hold,
    Pause,
    Snapshot,
}
struct PhaseGuard {
    state: BackupStateRef,
    kind: GuardKind,
}
impl PhaseGuard {
    fn new(state: &BackupStateRef, kind: GuardKind) -> Self {
        let mut value = state.lock().unwrap();
        match kind {
            GuardKind::Hold => value.holds += 1,
            GuardKind::Pause => value.pauses += 1,
            GuardKind::Snapshot => value.snapshots += 1,
        }
        Self {
            state: state.clone(),
            kind,
        }
    }
}
impl Drop for PhaseGuard {
    fn drop(&mut self) {
        let mut value = self.state.lock().unwrap();
        match self.kind {
            GuardKind::Hold => value.holds -= 1,
            GuardKind::Pause => value.pauses -= 1,
            GuardKind::Snapshot => value.snapshots -= 1,
        }
    }
}
fn witness() -> BackupWitness {
    BackupWitness {
        installation: InstallationId::from_bytes([1; 16]),
        histories: vec![cursor(10)],
        canaries: vec![],
    }
}
struct HoldFixture {
    _guard: PhaseGuard,
    witness: BackupWitness,
}
impl BackupHold for HoldFixture {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn release(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            drop(self);
            Ok(())
        })
    }
}
struct PauseFixture {
    guard: PhaseGuard,
    fail: bool,
}
impl PausedBackup for PauseFixture {
    fn open_cut(&mut self) -> PortFuture<'_, Box<dyn BackupSnapshot>> {
        Box::pin(async {
            if self.fail {
                return Err(DomainError::ResourceNotFound.into());
            }
            Ok(Box::new(SnapshotFixture {
                guard: PhaseGuard::new(&self.guard.state, GuardKind::Snapshot),
                witness: witness(),
            }) as Box<dyn BackupSnapshot>)
        })
    }
    fn resume(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            drop(self);
            Ok(())
        })
    }
}
struct SnapshotFixture {
    guard: PhaseGuard,
    witness: BackupWitness,
}
impl BackupSnapshot for SnapshotFixture {
    fn witness(&self) -> &BackupWitness {
        &self.witness
    }
    fn spool(
        &mut self,
        budget: BackupBudget,
        cancellation: Cancellation,
    ) -> PortFuture<'_, BackupSpool> {
        Box::pin(async move {
            assert_eq!(self.guard.state.lock().unwrap().pauses, 0);
            budget.check(BackupProgress {
                elapsed: Duration::from_millis(10),
                pinned_wal_bytes: 20,
                spool_bytes: 30,
            })?;
            if cancellation.is_cancelled() {
                return Err(DomainError::ResourceNotFound.into());
            }
            Ok(BackupSpool {
                artifact: ArtifactId::from_bytes([1; 16]),
                bytes: 30,
                digest: ContentDigest::from_bytes([1; 32]),
                witness: self.witness.clone(),
            })
        })
    }
    fn close(self: Box<Self>) -> PortFuture<'static, ()> {
        Box::pin(async move {
            drop(self);
            Ok(())
        })
    }
}
struct PreparedFixture {
    state: BackupStateRef,
    fail: bool,
}
impl PreparedBackup for PreparedFixture {
    fn acquire_hold(&mut self) -> PortFuture<'_, Box<dyn BackupHold>> {
        Box::pin(async {
            Ok(Box::new(HoldFixture {
                _guard: PhaseGuard::new(&self.state, GuardKind::Hold),
                witness: witness(),
            }) as Box<dyn BackupHold>)
        })
    }
    fn pause_writes(&mut self) -> PortFuture<'_, Box<dyn PausedBackup>> {
        Box::pin(async {
            Ok(Box::new(PauseFixture {
                guard: PhaseGuard::new(&self.state, GuardKind::Pause),
                fail: self.fail,
            }) as Box<dyn PausedBackup>)
        })
    }
}
fn backup_budget() -> BackupBudget {
    BackupBudget {
        deadline: Duration::from_secs(1),
        max_pinned_wal_bytes: 100,
        max_spool_bytes: 100,
    }
}
fn paired_copy(
    state: &BackupStateRef,
    second_fails: bool,
    budget: BackupBudget,
    cancel: Cancellation,
) -> Result<(), notarium_core::error::PortError> {
    let mut holds = Vec::new();
    let mut pauses = Vec::new();
    let mut snapshots = Vec::new();
    for fail in [false, second_fails] {
        let mut prepared: Box<dyn PreparedBackup> = Box::new(PreparedFixture {
            state: state.clone(),
            fail,
        });
        holds.push(ready(prepared.acquire_hold())?);
        pauses.push(ready(prepared.pause_writes())?);
    }
    for pause in &mut pauses {
        snapshots.push(ready(pause.open_cut())?);
    }
    while let Some(pause) = pauses.pop() {
        ready(pause.resume())?;
    }
    {
        let value = state.lock().unwrap();
        assert_eq!((value.holds, value.pauses, value.snapshots), (2, 0, 2));
    }
    for snapshot in &mut snapshots {
        ready(snapshot.spool(budget, cancel.clone()))?;
    }
    while let Some(snapshot) = snapshots.pop() {
        ready(snapshot.close())?;
    }
    {
        let value = state.lock().unwrap();
        assert_eq!((value.holds, value.pauses, value.snapshots), (2, 0, 0));
    }
    // Stable spools exist; the independent CAS hold survives through blob copy.
    while let Some(hold) = holds.pop() {
        ready(hold.release())?;
    }
    Ok(())
}
#[test]
fn backup_guards_release_every_phase_on_second_participant_failure_budget_or_cancel() {
    let state = Arc::new(std::sync::Mutex::new(BackupState::default()));
    assert!(paired_copy(&state, false, backup_budget(), Cancellation::default()).is_ok());
    assert!(paired_copy(&state, true, backup_budget(), Cancellation::default()).is_err());
    for budget in [
        BackupBudget {
            deadline: Duration::ZERO,
            ..backup_budget()
        },
        BackupBudget {
            max_pinned_wal_bytes: 0,
            ..backup_budget()
        },
        BackupBudget {
            max_spool_bytes: 0,
            ..backup_budget()
        },
    ] {
        assert!(paired_copy(&state, false, budget, Cancellation::default()).is_err());
    }
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(paired_copy(&state, false, backup_budget(), cancel).is_err());
    let value = state.lock().unwrap();
    assert_eq!((value.holds, value.pauses, value.snapshots), (0, 0, 0));
}

#[test]
fn canonical_seams_enforce_command_ranges_chat_staging_and_nanosecond_timestamps() {
    use notarium_core::{error::ValidationReason, value::Timestamp};

    let _ = <dyn NoteWritePort>::mint_and_purge;

    let range =
        CommandSeqRange::new(SpaceSeq::new(101).unwrap(), SpaceSeq::new(102).unwrap()).unwrap();
    assert!(range.contains(SpaceSeq::new(101).unwrap()));
    assert!(range.contains(SpaceSeq::new(102).unwrap()));
    assert!(range.splits_cutoff(SpaceSeq::new(101).unwrap()));
    assert!(!range.splits_cutoff(SpaceSeq::new(100).unwrap()));
    assert!(!range.splits_cutoff(SpaceSeq::new(102).unwrap()));
    assert!(CommandSeqRange::new(SpaceSeq::ZERO, SpaceSeq::new(1).unwrap()).is_err());
    assert!(CommandSeqRange::new(SpaceSeq::new(5).unwrap(), SpaceSeq::new(4).unwrap()).is_err());

    assert!(DomainError::validation(ValidationReason::PurgeResync).requires_resync());
    assert!(!DomainError::validation(ValidationReason::InvalidCutoff).requires_resync());
    assert!(!DomainError::validation(ValidationReason::NotReady).requires_resync());

    assert!(
        StagedChatBlob::attest_canonical(
            scope(1).space_id,
            PrincipalId::from_bytes([1; 16]),
            ContentDigest::from_bytes([1; 32]),
            512,
        )
        .is_err()
    );
    let staged = StagedChatBlob::attest_canonical(
        scope(1).space_id,
        PrincipalId::from_bytes([1; 16]),
        ContentDigest::from_bytes([2; 32]),
        513,
    )
    .unwrap();
    assert_eq!(staged.byte_len(), 513);

    let ts = Timestamp::parse("2026-11-15T12:34:56.123456789Z").unwrap();
    let roundtrip = Timestamp::from_unix_parts(ts.unix_seconds(), ts.nanosecond()).unwrap();
    assert_eq!(ts, roundtrip);
    assert!(Timestamp::from_unix_parts(ts.unix_seconds(), 1_000_000_000).is_err());
}
