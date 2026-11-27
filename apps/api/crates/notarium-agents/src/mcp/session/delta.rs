use super::{
    super::{ToolCallContext, invalid},
    address::{project_for_folder, readable_spaces},
};
use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::{CommandKey, ContentDigest, ControlRevision, EpisodeId, SpaceId, SpaceSeq},
    model::FolderRef,
    ports::{
        AccessibleSpace, AccountMutation, AckOwner, AcknowledgeDelta, ChangeKind, ChangePage,
        ChangeRead, ChangeReadResult, ChangeSeed, EntityId, EpisodeLifecycle, PageLimit,
        SeedCursor, SeedPosition,
    },
    receipt::{AccountCommandIdentity, AcknowledgedCursor, ChangeCursor},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const PAGE_SIZE: u16 = 20;
const TICKET_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_TICKETS: usize = 256;
const MAX_TICKETS_PER_PRINCIPAL: usize = 32;
const MAX_STARTS: usize = 128;
const MAX_STARTS_PER_PRINCIPAL: usize = 16;
const CONTINUATION_PREFIX: &str = "continue_";
const DELIVERY_PREFIX: &str = "delivery_";

/// Every ticket describes exactly one delivered page and the next read position.
#[derive(Default)]
pub(in super::super) struct BootstrapContinuations {
    tickets: Mutex<VecDeque<(u128, Ticket)>>,
    starts: Mutex<VecDeque<StartWindow>>,
    #[cfg(any(test, feature = "test-support"))]
    ttl_override_ms: std::sync::atomic::AtomicU64,
}

#[derive(Clone)]
struct StartWindow {
    key: CommandKey,
    opened: Instant,
    batch: Arc<Batch>,
}

#[derive(Clone)]
struct Ticket {
    opened: Instant,
    batch: Arc<Batch>,
    position: Option<Position>,
    safe_ack: Option<ChangeCursor>,
    acknowledge: bool,
}

struct Batch {
    principal: notarium_core::ids::PrincipalId,
    episode: EpisodeId,
    owner: AckOwner,
    project: Option<FolderRef>,
    authority: ContentDigest,
    windows: Vec<Window>,
}

struct Window {
    baseline: ChangeCursor,
    cutoff: SpaceSeq,
    can_acknowledge: bool,
}

#[derive(Clone, Debug)]
struct Position {
    space_index: usize,
    state: PageState,
}

#[derive(Clone, Debug)]
enum PageState {
    Start,
    Log(ChangeCursor),
    Seed(SeedCursor),
}

fn stale() -> PortError {
    invalid(ValidationReason::CursorStale)
}

impl BootstrapContinuations {
    #[cfg(any(test, feature = "test-support"))]
    pub(in super::super) fn set_ttl(&self, ttl: Duration) {
        self.ttl_override_ms.store(
            u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    fn ticket_ttl(&self) -> Duration {
        #[cfg(any(test, feature = "test-support"))]
        {
            let override_ms = self
                .ttl_override_ms
                .load(std::sync::atomic::Ordering::SeqCst);
            if override_ms > 0 {
                return Duration::from_millis(override_ms);
            }
        }
        TICKET_TTL
    }

    fn insert(&self, ticket: Ticket) -> Result<String, PortError> {
        let ttl = self.ticket_ttl();
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| invalid(ValidationReason::InvalidState))?;
        let id = u128::from_be_bytes(bytes);
        let mut tickets = self
            .tickets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tickets.retain(|(_, current)| current.opened.elapsed() < ttl);
        if tickets.iter().any(|(existing, _)| *existing == id) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let principal = &ticket.batch.principal;
        while tickets
            .iter()
            .filter(|(_, current)| &current.batch.principal == principal)
            .count()
            >= MAX_TICKETS_PER_PRINCIPAL
        {
            if let Some(pos) = tickets
                .iter()
                .position(|(_, current)| &current.batch.principal == principal)
            {
                tickets.remove(pos);
            } else {
                break;
            }
        }
        if tickets.len() == MAX_TICKETS {
            tickets.pop_front();
        }
        tickets.push_back((id, ticket));
        Ok(format!("{id:032x}"))
    }

    fn find(&self, value: &str, prefix: &str) -> Result<Ticket, PortError> {
        let ttl = self.ticket_ttl();
        let digits = value.strip_prefix(prefix).ok_or_else(stale)?;
        if digits.len() != 32 {
            return Err(stale());
        }
        let expected = u128::from_str_radix(digits, 16).map_err(|_| stale())?;
        let tickets = self
            .tickets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        tickets
            .iter()
            .find(|(id, current)| *id == expected && current.opened.elapsed() < ttl)
            .map(|(_, current)| current.clone())
            .ok_or_else(stale)
    }

    fn find_start(&self, key: &CommandKey, authority: ContentDigest) -> Option<StartWindow> {
        let ttl = self.ticket_ttl();
        self.starts
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .find(|entry| {
                &entry.key == key
                    && entry.batch.authority == authority
                    && entry.opened.elapsed() < ttl
            })
            .cloned()
    }

    fn save_start(&self, start: StartWindow) -> StartWindow {
        let ttl = self.ticket_ttl();
        let mut starts = self
            .starts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        starts.retain(|entry| entry.opened.elapsed() < ttl);
        if let Some(previous) = starts
            .iter()
            .find(|entry| entry.key == start.key && entry.batch.authority == start.batch.authority)
        {
            return previous.clone();
        }
        let principal = &start.batch.principal;
        while starts
            .iter()
            .filter(|entry| &entry.batch.principal == principal)
            .count()
            >= MAX_STARTS_PER_PRINCIPAL
        {
            if let Some(pos) = starts
                .iter()
                .position(|entry| &entry.batch.principal == principal)
            {
                starts.remove(pos);
            } else {
                break;
            }
        }
        if starts.len() == MAX_STARTS {
            starts.pop_front();
        }
        starts.push_back(start.clone());
        start
    }
}

fn authority(auth: &EngineAuthContext) -> Result<ContentDigest, PortError> {
    let spaces: Vec<_> = auth
        .spaces()
        .iter()
        .map(|(id, grant)| (id, grant.role, &grant.read_classes, &grant.project_root))
        .collect();
    let bytes = serde_json::to_vec(&(auth.principal(), auth.grant(), auth.bearer_scope(), spaces))
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    Ok(ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes()))
}

fn windows(
    auth: &EngineAuthContext,
    spaces: BTreeMap<SpaceId, AccessibleSpace>,
    acknowledged: &BTreeMap<SpaceId, AcknowledgedCursor>,
) -> Result<Vec<Window>, PortError> {
    let mut windows = Vec::with_capacity(spaces.len());
    for (id, item) in spaces {
        let grant = auth.spaces().get(&id).ok_or_else(stale)?;
        let after = match acknowledged.get(&id) {
            Some(ack) => {
                item.history.check(&ack.scope)?;
                if ack.seq > item.last_seq {
                    return Err(stale());
                }
                ack.seq
            }
            None => SpaceSeq::ZERO,
        };
        // Durable ledgers are per Space, so a restricted class or project view
        // cannot acknowledge content omitted from a future broader view.
        let can_acknowledge = !matches!(auth.kind(), notarium_core::auth::PrincipalKind::Keeper(_))
            && grant.project_root.is_none()
            && grant.read_classes == DocClass::all();
        windows.push(Window {
            baseline: ChangeCursor {
                scope: item.history,
                after,
            },
            cutoff: item.last_seq,
            can_acknowledge,
        });
    }
    Ok(windows)
}

pub(super) async fn open(
    call: &ToolCallContext<'_>,
    episode: EpisodeId,
    owner: AckOwner,
    project: Option<FolderRef>,
    acknowledged: &BTreeMap<SpaceId, AcknowledgedCursor>,
    acknowledge: bool,
) -> Result<Value, PortError> {
    let account = call.account();
    let authority = authority(account.auth())?;
    let key = call.command_key("bootstrap-window", 0);
    if let Some(start) = call.registry.bootstrap.find_start(&key, authority) {
        if start.batch.episode != episode || start.batch.project != project {
            return Err(stale());
        }
        revalidate(call, &start.batch, Some(0), None).await?;
        return page(call, start.opened, start.batch, next_space(0), acknowledge).await;
    }
    let batch = Arc::new(Batch {
        principal: account.auth().principal().clone(),
        episode,
        owner,
        project,
        authority,
        windows: windows(account.auth(), readable_spaces(call).await?, acknowledged)?,
    });
    let start = call.registry.bootstrap.save_start(StartWindow {
        key,
        opened: Instant::now(),
        batch,
    });
    page(call, start.opened, start.batch, next_space(0), acknowledge).await
}

async fn revalidate(
    call: &ToolCallContext<'_>,
    batch: &Batch,
    active_space_index: Option<usize>,
    ack_space: Option<&SpaceId>,
) -> Result<(), PortError> {
    if authority(call.account().auth())? != batch.authority {
        return Err(stale());
    }
    let episode = call
        .registry
        .control
        .get_episode(call.account(), batch.episode.clone())
        .await?;
    if episode.lifecycle == EpisodeLifecycle::Closed || episode.project_hint != batch.project {
        return Err(stale());
    }
    if let Some(project) = &batch.project {
        project_for_folder(call, project).await?;
    }
    // Validate only the Space window(s) actively being read or acknowledged in
    // this call rather than re-reading all S Spaces on every pagination hop;
    // any membership or grant change across any Space is already caught in O(1)
    // by `batch.authority` above.
    let mut checked = std::collections::BTreeSet::new();
    if let Some(idx) = active_space_index
        && let Some(window) = batch.windows.get(idx)
    {
        checked.insert(&window.baseline.scope.space_id);
        let current = super::readable_space(call, &window.baseline.scope.space_id)
            .await
            .map_err(|err| match err {
                PortError::Domain(DomainError::ResourceNotFound) => stale(),
                other => other,
            })?;
        current.history.check(&window.baseline.scope)?;
        if current.last_seq < window.cutoff {
            return Err(stale());
        }
    }
    if let Some(space_id) = ack_space
        && checked.insert(space_id)
        && let Some(window) = batch
            .windows
            .iter()
            .find(|w| &w.baseline.scope.space_id == space_id)
    {
        let current = super::readable_space(call, space_id)
            .await
            .map_err(|err| match err {
                PortError::Domain(DomainError::ResourceNotFound) => stale(),
                other => other,
            })?;
        current.history.check(&window.baseline.scope)?;
        if current.last_seq < window.cutoff {
            return Err(stale());
        }
    }
    Ok(())
}

pub(super) async fn resume(
    call: &ToolCallContext<'_>,
    token: &str,
    receipt: Option<&str>,
    allow_ack: bool,
) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.start-session-delta.v1";
    if let Some(receipt) = receipt
        && (receipt.strip_prefix(DELIVERY_PREFIX).is_none()
            || receipt.strip_prefix(DELIVERY_PREFIX) != token.strip_prefix(CONTINUATION_PREFIX))
    {
        return Err(stale());
    }
    let existing_ack = call
        .lookup_journal::<Option<PendingDeliveryAck>>("delta-resume-ack")
        .await?;
    let mut acked = false;
    if let Some(Some(pending)) = &existing_ack {
        // Replay any already-journaled delivery acknowledgement BEFORE looking
        // up the process-local continuation ticket so failover replays still
        // commit the durable ACK even if the continuation ticket has moved/expired.
        acknowledge_prepared(call, pending).await.map_err(|error| {
            super::super::note_tools::batch_operational_error(LABEL, error, true)
        })?;
        acked = true;
    }
    let ticket = call.registry.bootstrap.find(token, CONTINUATION_PREFIX)?;
    let position = ticket.position.clone().ok_or_else(stale)?;
    revalidate(
        call,
        &ticket.batch,
        Some(position.space_index),
        ticket.safe_ack.as_ref().map(|c| &c.scope.space_id),
    )
    .await
    .map_err(|error| super::super::note_tools::batch_operational_error(LABEL, error, acked))?;
    let acknowledge = ticket.acknowledge && allow_ack;
    let pending = match existing_ack {
        Some(saved) => saved,
        None => {
            let computed = if acknowledge {
                ticket
                    .safe_ack
                    .as_ref()
                    .map(|delivered| PendingDeliveryAck {
                        owner: ticket.batch.owner.clone(),
                        delivered: delivered.clone(),
                    })
            } else {
                None
            };
            call.journal("delta-resume-ack", || async move { Ok(computed) })
                .await?
        }
    };
    if !acked && let Some(pending) = &pending {
        acknowledge_prepared(call, pending).await?;
        acked = true;
    }
    page(call, Instant::now(), ticket.batch, position, acknowledge)
        .await
        .map_err(|error| super::super::note_tools::batch_operational_error(LABEL, error, acked))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingDeliveryAck {
    owner: AckOwner,
    delivered: ChangeCursor,
}

impl PendingDeliveryAck {
    pub(super) fn is_for_parent(&self, parent: Option<&EpisodeId>) -> bool {
        matches!(&self.owner, AckOwner::Episode(acked) if parent == Some(acked))
    }

    pub(super) fn for_episode(&self, episode: EpisodeId) -> Self {
        Self {
            owner: AckOwner::Episode(episode),
            delivered: self.delivered.clone(),
        }
    }
}

pub(super) async fn prepare_delivery(
    call: &ToolCallContext<'_>,
    token: &str,
    allow_ack: bool,
) -> Result<Option<PendingDeliveryAck>, PortError> {
    let ticket = call.registry.bootstrap.find(token, DELIVERY_PREFIX)?;
    revalidate(
        call,
        &ticket.batch,
        None,
        ticket.safe_ack.as_ref().map(|c| &c.scope.space_id),
    )
    .await?;
    if !allow_ack || !ticket.acknowledge {
        return Ok(None);
    }
    Ok(ticket.safe_ack.map(|delivered| PendingDeliveryAck {
        owner: ticket.batch.owner.clone(),
        delivered,
    }))
}

pub(super) async fn deliver_journaled(
    call: &ToolCallContext<'_>,
    token: &str,
    allow_ack: bool,
) -> Result<bool, PortError> {
    const LABEL: &str = "notarium.mcp.delta-ack.v1";
    let mut invoked_fresh = false;
    let pending: Option<PendingDeliveryAck> = call
        .journal("delivery-ack", || async {
            invoked_fresh = true;
            prepare_delivery(call, token, allow_ack).await
        })
        .await?;
    let replayed = !invoked_fresh;
    let Some(pending) = pending else {
        return Ok(false);
    };
    acknowledge_prepared(call, &pending)
        .await
        .map_err(|error| {
            super::super::note_tools::batch_operational_error(LABEL, error, replayed)
        })?;
    Ok(true)
}

pub(super) async fn acknowledge_prepared(
    call: &ToolCallContext<'_>,
    pending: &PendingDeliveryAck,
) -> Result<(), PortError> {
    let account = call.account();
    let actor = account.auth().principal();
    let identity = ack_identity(actor, &pending.owner, &pending.delivered)?;
    call.registry
        .control
        .acknowledge_delta(
            account,
            AccountMutation {
                identity,
                input: AcknowledgeDelta {
                    owner: pending.owner.clone(),
                    delivered: pending.delivered.clone(),
                },
            },
        )
        .await
        .map_err(|error| {
            super::super::note_tools::batch_operational_error(
                "notarium.mcp.delta-ack.v1",
                error,
                false,
            )
        })?;
    Ok(())
}

fn ack_identity(
    principal: &notarium_core::ids::PrincipalId,
    owner: &AckOwner,
    delivered: &ChangeCursor,
) -> Result<AccountCommandIdentity, PortError> {
    let bytes = serde_json::to_vec(&("bootstrap-delivered-v1", principal, owner, delivered))
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let hash = blake3::hash(&bytes);
    let mut key = [0; 16];
    key.copy_from_slice(&hash.as_bytes()[..16]);
    Ok(AccountCommandIdentity {
        owner: principal.clone(),
        actor: principal.clone(),
        key: CommandKey::from_bytes(key),
        hash: ContentDigest::from_bytes(*hash.as_bytes()),
        // ACK uses an atomic MAX and does not CAS the account revision.
        expected: ControlRevision::ZERO,
    })
}

fn next_space(space_index: usize) -> Position {
    Position {
        space_index,
        state: PageState::Start,
    }
}

fn pending_position(batch: &Batch, mut position: Position) -> Option<Position> {
    while let Some(window) = batch.windows.get(position.space_index) {
        if !matches!(position.state, PageState::Start) || window.baseline.after < window.cutoff {
            return Some(position);
        }
        position.space_index += 1;
    }
    None
}

async fn page(
    call: &ToolCallContext<'_>,
    opened: Instant,
    batch: Arc<Batch>,
    position: Position,
    acknowledge: bool,
) -> Result<Value, PortError> {
    let Some(position) = pending_position(&batch, position) else {
        return Ok(json!({ "changes": [], "complete": true }));
    };
    let window = &batch.windows[position.space_index];
    let context = call.space(window.baseline.scope.clone())?;
    let limit = PageLimit::new(PAGE_SIZE)?;
    let after = match &position.state {
        PageState::Log(after) => after.clone(),
        _ => window.baseline.clone(),
    };
    let reading_seed = matches!(position.state, PageState::Seed(_));
    let request = match &position.state {
        PageState::Seed(cursor) => ChangeRead::ContinueSeed {
            cursor: cursor.clone(),
        },
        _ => ChangeRead::Log {
            after: after.clone(),
            through: window.cutoff,
            limit,
        },
    };
    let mut reset = false;
    let data = match call
        .registry
        .engine
        .read_changes(context.with_preflight_taint(), request)
        .await
    {
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::PurgeResync && !reading_seed =>
        {
            reset = true;
            call.registry
                .engine
                .read_changes(
                    context.with_preflight_taint(),
                    ChangeRead::Seed {
                        scope: window.baseline.scope.clone(),
                        cutoff: Some(window.cutoff),
                        limit,
                    },
                )
                .await?
        }
        result => result?,
    };
    let (mut value, next, safe_ack) = match data {
        ChangeReadResult::Log(log) if !reset && !reading_seed => {
            validate_log(&log, &after, window)?;
            let next = if log.complete {
                next_space(position.space_index + 1)
            } else {
                Position {
                    space_index: position.space_index,
                    state: PageState::Log(log.next),
                }
            };
            let ack = (log.safe_ack_end > window.baseline.after).then(|| ChangeCursor {
                scope: window.baseline.scope.clone(),
                after: log.safe_ack_end,
            });
            let items: Vec<_> = log
                .changes
                .into_iter()
                .filter(|change| change.class != Some(DocClass::EncryptedNote))
                .filter_map(|change| {
                    let (entity, id, note) = match &change.entity {
                        EntityId::Note(note) => ("note", note.as_str(), Some(note)),
                        EntityId::Folder(folder) => ("folder", folder.as_str(), None),
                        EntityId::Ability(ability) => ("ability", ability.as_str(), None),
                        EntityId::Job(job) => ("job", job.as_str(), None),
                        EntityId::Thread(_) => return None,
                    };
                    let kind = match change.kind {
                        ChangeKind::Create => "create",
                        ChangeKind::Edit => "edit",
                        ChangeKind::Move => "move",
                        ChangeKind::Rename => "rename",
                        ChangeKind::Trash => "trash",
                        ChangeKind::Restore => "restore",
                        ChangeKind::Purge => "purge",
                        ChangeKind::Redact => "redact",
                    };
                    Some(json!({
                        "space": change.cursor.scope.space_id,
                        "seq": change.cursor.after,
                        "entity": entity,
                        "entityId": id,
                        "noteId": note,
                        "kind": kind,
                        "revision": change.revision,
                        "lifecycle": change.lifecycle,
                    }))
                })
                .collect();
            if !items.is_empty()
                && context
                    .auth()
                    .pinned_write_space()
                    .is_some_and(|pin| pin != &window.baseline.scope.space_id)
            {
                context.auth().taint().mark_external_read();
            }
            (json!({ "changes": items }), next, ack)
        }
        ChangeReadResult::Seed(seed) if reset || reading_seed => {
            validate_seed(&seed, &position.state, window, limit)?;
            let complete = seed.next.is_none();
            let mut items = Vec::new();
            for note in seed.notes {
                let document = &note.document;
                if document.class() == DocClass::EncryptedNote {
                    continue;
                }
                if document.reference().space_id != window.baseline.scope.space_id {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                if let Err(error) =
                    ClassEgressFence::mcp_note_metadata(&document.metadata(), context.auth())
                {
                    let error = PortError::from(error);
                    if super::super::corpus::hidden(&error) {
                        continue;
                    }
                    return Err(error);
                }
                items.push(json!({
                    "space": document.reference().space_id,
                    "noteId": document.reference().note_id,
                    "revision": document.revision(),
                    "kind": "seed",
                    "title": note.provenance.as_ref().map(|facts| &facts.title),
                    "path": note.provenance.as_ref().map(|facts| &facts.path),
                }));
            }
            let next = match seed.next {
                Some(cursor) => Position {
                    space_index: position.space_index,
                    state: PageState::Seed(cursor),
                },
                None => next_space(position.space_index + 1),
            };
            let value = json!({
                "changes": items,
                "seed": {
                    "space": seed.cutoff.scope.space_id,
                    "cutoff": seed.cutoff.after,
                    "reset": reset,
                    "complete": complete,
                }
            });
            (value, next, complete.then_some(seed.cutoff))
        }
        _ => return Err(invalid(ValidationReason::InvalidState)),
    };

    let next = pending_position(&batch, next);
    value["complete"] = json!(next.is_none());
    let safe_ack = safe_ack.filter(|_| window.can_acknowledge);
    if next.is_some() || (acknowledge && safe_ack.is_some()) {
        let further = next.is_some();
        let receipt = acknowledge && safe_ack.is_some();
        let id = call.registry.bootstrap.insert(Ticket {
            opened,
            batch,
            position: next,
            safe_ack,
            acknowledge,
        })?;
        if further {
            let continuation = format!("{CONTINUATION_PREFIX}{id}");
            value["continuation"] = json!(continuation);
            value["nextAction"] = json!({
                "tool": "start_session",
                "arguments": { "continuation": continuation },
            });
        }
        if receipt {
            value["deliveryReceipt"] = json!(format!("{DELIVERY_PREFIX}{id}"));
        }
    }
    Ok(value)
}

fn validate_log(log: &ChangePage, after: &ChangeCursor, window: &Window) -> Result<(), PortError> {
    log.next.scope.check(&window.baseline.scope)?;
    if log.cutoff != window.cutoff
        || log.next.after <= after.after
        || log.next.after > window.cutoff
        || log.complete != (log.next.after == window.cutoff)
        || log.safe_ack_end > log.next.after
        || log.changes.len() > usize::from(PAGE_SIZE)
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let mut previous = after.after;
    for change in &log.changes {
        change.cursor.scope.check(&after.scope)?;
        if change.cursor.after <= previous
            || change.cursor.after > log.next.after
            || !change.command_range.contains(change.cursor.after)
            || (change.command_range.splits_cutoff(log.safe_ack_end))
        {
            return Err(invalid(ValidationReason::InvalidState));
        }
        previous = change.cursor.after;
    }
    Ok(())
}

fn validate_seed(
    seed: &ChangeSeed,
    previous: &PageState,
    window: &Window,
    limit: PageLimit,
) -> Result<(), PortError> {
    seed.cutoff.scope.check(&window.baseline.scope)?;
    if seed.cutoff.after != window.cutoff
        || seed.notes.len() + seed.threads.len() > usize::from(limit.get())
        || seed.next.as_ref().is_some_and(|cursor| {
            cursor.cutoff != seed.cutoff
                || cursor.limit != limit
                || matches!(previous, PageState::Seed(old) if !advances_seed(&old.after, &cursor.after))
        })
    {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(())
}

fn advances_seed(previous: &SeedPosition, next: &SeedPosition) -> bool {
    match (previous, next) {
        (SeedPosition::NotesAfter(old), SeedPosition::NotesAfter(next)) => next > old,
        (SeedPosition::ThreadsAfter(old), SeedPosition::ThreadsAfter(next)) => next > old,
        (SeedPosition::NotesAfter(_), SeedPosition::ThreadsAfter(_)) => true,
        (SeedPosition::ThreadsAfter(_), SeedPosition::NotesAfter(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::{
        ids::{ChatThreadId, HistoryIncarnation, NoteId, PrincipalId, RevisionId},
        model::{HistoryScope, Lifecycle},
        ports::{Change, CommandSeqRange},
        receipt::MutationEffect,
    };

    fn seq(value: u64) -> SpaceSeq {
        SpaceSeq::new(value).unwrap()
    }

    fn scope(byte: u8) -> HistoryScope {
        HistoryScope {
            space_id: SpaceId::from_bytes([byte; 16]),
            incarnation: HistoryIncarnation::from_bytes([byte; 16]),
        }
    }

    fn cursor(scope: &HistoryScope, after: u64) -> ChangeCursor {
        ChangeCursor {
            scope: scope.clone(),
            after: seq(after),
        }
    }

    #[test]
    fn log_position_can_split_a_command_while_the_ack_stays_before_it() {
        let space = scope(1);
        let window = Window {
            baseline: cursor(&space, 100),
            cutoff: seq(102),
            can_acknowledge: true,
        };
        let row = |after| Change {
            cursor: cursor(&space, after),
            command_range: CommandSeqRange::new(seq(101), seq(102)).unwrap(),
            entity: EntityId::Note(NoteId::from_bytes([1; 16])),
            kind: ChangeKind::Edit,
            revision: RevisionId::from_bytes([2; 16]),
            lifecycle: Lifecycle::Active,
            class: Some(DocClass::UserDoc),
            effect: MutationEffect::NoRelevantEffect,
            provenance: None,
        };
        let mut first = ChangePage {
            changes: vec![row(101)],
            next: cursor(&space, 101),
            safe_ack_end: seq(100),
            cutoff: seq(102),
            complete: false,
        };
        validate_log(&first, &window.baseline, &window).unwrap();
        first.safe_ack_end = seq(101);
        assert!(validate_log(&first, &window.baseline, &window).is_err());
        let second = ChangePage {
            changes: vec![row(102)],
            next: cursor(&space, 102),
            safe_ack_end: seq(102),
            cutoff: seq(102),
            complete: true,
        };
        validate_log(&second, &first.next, &window).unwrap();
        let owner = AckOwner::Episode(EpisodeId::from_bytes([3; 16]));
        let principal = PrincipalId::from_bytes([4; 16]);
        let ack = ack_identity(&principal, &owner, &second.next).unwrap();
        assert_eq!(ack, ack_identity(&principal, &owner, &second.next).unwrap());
        assert_ne!(
            ack.key,
            ack_identity(&principal, &AckOwner::Account, &second.next)
                .unwrap()
                .key
        );
    }

    #[test]
    fn a_ticket_distinguishes_continuation_from_delivery_and_skips_caught_up_spaces() {
        let first = scope(1);
        let second = scope(2);
        let batch = Arc::new(Batch {
            principal: PrincipalId::from_bytes([9; 16]),
            episode: EpisodeId::from_bytes([7; 16]),
            owner: AckOwner::Account,
            project: None,
            authority: ContentDigest::from_bytes([8; 32]),
            windows: vec![
                Window {
                    baseline: cursor(&first, 5),
                    cutoff: seq(5),
                    can_acknowledge: true,
                },
                Window {
                    baseline: cursor(&second, 0),
                    cutoff: seq(21),
                    can_acknowledge: true,
                },
            ],
        });
        let position = pending_position(&batch, next_space(0)).unwrap();
        assert_eq!(position.space_index, 1);
        let state = BootstrapContinuations::default();
        let id = state
            .insert(Ticket {
                opened: Instant::now(),
                batch,
                position: Some(position),
                safe_ack: Some(cursor(&second, 20)),
                acknowledge: true,
            })
            .unwrap();
        let delivery = format!("{DELIVERY_PREFIX}{id}");
        let continuation = format!("{CONTINUATION_PREFIX}{id}");
        assert!(state.find(&delivery, CONTINUATION_PREFIX).is_err());
        assert!(state.find(&continuation, DELIVERY_PREFIX).is_err());
        assert_eq!(
            state.find(&delivery, DELIVERY_PREFIX).unwrap().safe_ack,
            Some(cursor(&second, 20))
        );
        assert_eq!(
            state
                .find(&continuation, CONTINUATION_PREFIX)
                .unwrap()
                .position
                .unwrap()
                .space_index,
            1
        );
    }

    #[test]
    fn a_seed_keeps_its_cut_and_cannot_restart_an_older_phase() {
        let space = scope(5);
        let window = Window {
            baseline: cursor(&space, 2),
            cutoff: seq(9),
            can_acknowledge: true,
        };
        let limit = PageLimit::new(PAGE_SIZE).unwrap();
        let mut next = SeedCursor {
            cutoff: cursor(&space, 9),
            after: SeedPosition::ThreadsAfter(ChatThreadId::from_bytes([1; 16])),
            limit,
        };
        let previous = PageState::Seed(SeedCursor {
            cutoff: next.cutoff.clone(),
            after: SeedPosition::NotesAfter(NoteId::from_bytes([2; 16])),
            limit,
        });
        let mut seed = ChangeSeed {
            notes: Vec::new(),
            threads: Vec::new(),
            cutoff: next.cutoff.clone(),
            next: Some(next.clone()),
        };
        validate_seed(&seed, &previous, &window, limit).unwrap();
        let previous = PageState::Seed(next.clone());
        next.after = SeedPosition::NotesAfter(NoteId::from_bytes([3; 16]));
        seed.next = Some(next);
        assert!(validate_seed(&seed, &previous, &window, limit).is_err());
        seed.cutoff.after = seq(10);
        seed.next = None;
        assert!(validate_seed(&seed, &previous, &window, limit).is_err());
    }

    #[test]
    fn continuation_ticket_expires_after_idle_ttl() {
        let space = scope(9);
        let batch = Arc::new(Batch {
            principal: PrincipalId::from_bytes([9; 16]),
            episode: EpisodeId::from_bytes([7; 16]),
            owner: AckOwner::Account,
            project: None,
            authority: ContentDigest::from_bytes([8; 32]),
            windows: vec![Window {
                baseline: cursor(&space, 0),
                cutoff: seq(10),
                can_acknowledge: true,
            }],
        });
        let state = BootstrapContinuations::default();
        state.set_ttl(Duration::from_millis(30));
        let token_id = state
            .insert(Ticket {
                opened: Instant::now(),
                batch,
                position: Some(next_space(0)),
                safe_ack: None,
                acknowledge: true,
            })
            .unwrap();
        let token = format!("{CONTINUATION_PREFIX}{token_id}");
        assert!(state.find(&token, CONTINUATION_PREFIX).is_ok());
        std::thread::sleep(Duration::from_millis(45));
        assert!(
            state.find(&token, CONTINUATION_PREFIX).is_err(),
            "idle ticket must expire after TTL"
        );
    }
}
