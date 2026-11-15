#[path = "support/ports.rs"]
mod support;
use notarium_core::{
    DomainError,
    auth::*,
    classes::*,
    ids::*,
    model::*,
    ports::{control::*, *},
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
fn board_interception_retains_rank_intent_in_addition_to_field_overrides() {
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
            expected_rank_revision: RevisionId::from_bytes([3; 16]),
        }),
        fields: BTreeMap::from([("status".into(), Some(YamlValue::String("done".into())))]),
        expected_note: RevisionId::from_bytes([1; 16]),
        expected_view: RevisionId::from_bytes([1; 16]),
        expected_rank: RevisionId::from_bytes([1; 16]),
    };
    let request = InterceptedMutation {
        context: context(),
        identity: identity(1),
        preconditions: Preconditions {
            revision: Some(board.expected_note.clone()),
            ..Preconditions::default()
        },
        payload: InterceptedPayload::MoveBoardCard(board.clone()),
    };
    let InterceptedPayload::MoveBoardCard(intercepted) = request.payload else {
        panic!()
    };
    assert_eq!(intercepted, board);
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

struct GraphFixture {
    cut: SnapshotCut,
    notes: Vec<NoteId>,
    neighbors: Vec<DenseNodeId>,
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
    fn folder_subtree(&self, _: &FolderId) -> notarium_core::DomainResult<&[DenseNodeId]> {
        Ok(&self.0.neighbors)
    }
    fn outgoing(&self, node: DenseNodeId) -> notarium_core::DomainResult<&[DenseNodeId]> {
        self.note_id(node)?;
        Ok(&self.0.neighbors)
    }
    fn incoming(&self, node: DenseNodeId) -> notarium_core::DomainResult<&[DenseNodeId]> {
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
            Ok(notes.iter().map(|_| None).collect())
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
        neighbors: vec![DenseNodeId::new(generation, 0)],
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
    let node = old.lookup(&id).unwrap();
    let neighbors = old.outgoing(node).unwrap();
    *port.current.lock().unwrap() = graph(2);
    port.visible
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let new =
        ready(port.acquire_snapshot(context(), CausalBasis::Exact(ReceiptSet::default()))).unwrap();
    assert_eq!(old.note_id(neighbors[0]).unwrap(), &id);
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
                ChangeRead::Log { after, through, .. } => {
                    scope(1).check(&after.scope)?;
                    Ok(ChangeReadResult::Log(ChangePage {
                        changes: vec![],
                        next: ChangeCursor {
                            after: through,
                            ..after
                        },
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
            cursor: None,
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
