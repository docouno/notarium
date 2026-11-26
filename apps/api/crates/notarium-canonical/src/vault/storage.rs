use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, PrincipalKind},
    error::{PortError, ValidationReason},
    ids::{ContentDigest, HistoryIncarnation, NoteId, RevisionId, SpaceSeq},
    model::{HistoryScope, PathTarget},
    ports::{NoteRevision, SpaceContext},
};
use notarium_syntax::unicode::{PortableFilename, lookup_key};

use super::{VaultBinding, VaultFileStamp, VaultHandoff, VaultObservation, VaultPath};
use crate::{
    BoxFuture, CanonicalStore, SpaceRecord,
    blobs::lock_and_check_space_tx,
    codec::{i64_to_space_seq, internal_not_committed},
    domain::common::CommandDeadline,
    runtime::{load_space_record, require_command_end_tx},
    sql_exec::BackendConn,
};

const MAX_PAGE: u16 = 256;
const MAX_RELATIVE_PATH_BYTES: usize = 32760;

macro_rules! observation_fields {
    () => {
        "note_id, rel_path, path_key, disk_identity, byte_size, mtime_seconds,
         mtime_nanos, disk_digest, observed_revision, carrier_digest"
    };
}

type BindingRow = (Vec<u8>, Vec<u8>, Vec<u8>, String, i64);

#[derive(sqlx::FromRow)]
struct ObservationRow {
    note_id: String,
    rel_path: String,
    path_key: String,
    disk_identity: Vec<u8>,
    byte_size: i64,
    mtime_seconds: i64,
    mtime_nanos: i32,
    disk_digest: Vec<u8>,
    observed_revision: String,
    carrier_digest: Vec<u8>,
}

impl TryFrom<ObservationRow> for VaultObservation {
    type Error = PortError;

    fn try_from(row: ObservationRow) -> Result<Self, PortError> {
        let result = Self {
            note: NoteId::parse(&row.note_id)?,
            revision: RevisionId::parse(&row.observed_revision)?,
            path: VaultPath {
                relative: row.rel_path,
                key: row.path_key,
            },
            file: VaultFileStamp {
                identity: digest(row.disk_identity)?,
                size: u64::try_from(row.byte_size).map_err(|_| corrupt("negative file size"))?,
                mtime_seconds: row.mtime_seconds,
                mtime_nanos: u32::try_from(row.mtime_nanos)
                    .map_err(|_| corrupt("negative file mtime"))?,
                digest: digest(row.disk_digest)?,
            },
            carrier_digest: digest(row.carrier_digest)?,
        };
        check_path(&result.path)?;
        check_file(&result.file)?;
        Ok(result)
    }
}

#[derive(sqlx::FromRow)]
struct HandoffRow {
    #[sqlx(flatten)]
    observation: ObservationRow,
    successor_note_id: Option<String>,
    successor_revision: Option<String>,
    purge_seq: i64,
}

impl TryFrom<HandoffRow> for VaultHandoff {
    type Error = PortError;

    fn try_from(row: HandoffRow) -> Result<Self, PortError> {
        let observation = VaultObservation::try_from(row.observation)?;
        let new_note = match (row.successor_note_id, row.successor_revision) {
            (Some(note), Some(revision)) => Some(NoteRevision {
                note: NoteId::parse(&note)?,
                revision: RevisionId::parse(&revision)?,
            }),
            (None, None) => None,
            _ => return Err(corrupt("incomplete successor identity")),
        };
        Ok(Self {
            old_note: observation.note.clone(),
            new_note,
            observation,
            purge_seq: i64_to_space_seq(row.purge_seq)?,
        })
    }
}

fn corrupt(reason: &'static str) -> PortError {
    internal_not_committed("vault_state_corrupt", reason)
}

fn digest(raw: Vec<u8>) -> Result<ContentDigest, PortError> {
    let bytes = raw.try_into().map_err(|_| corrupt("bad digest length"))?;
    Ok(ContentDigest::from_bytes(bytes))
}

fn generation_changed() -> PortError {
    DomainError::validation(ValidationReason::GenerationMismatch).into()
}

pub(super) fn check_actor(
    auth: &EngineAuthContext,
    scope: &HistoryScope,
    space: &SpaceRecord,
) -> Result<(), PortError> {
    space.scope.check(scope)?;
    let grant = auth
        .spaces()
        .get(&space.scope.space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    // Private binding state contains names of publications that can survive
    // domain erasure. Keep it with the original human installation actor.
    if auth.kind() != &PrincipalKind::DirectHuman
        || grant.project_root.is_some()
        || grant.read_classes.is_empty()
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    auth.authorize_space_write(&space.space)?;
    Ok(())
}

pub(super) fn check_path(path: &VaultPath) -> Result<(), PortError> {
    let invalid = || DomainError::validation(ValidationReason::InvalidPathComponent);
    if path.relative.len() > MAX_RELATIVE_PATH_BYTES || path.key.len() > MAX_RELATIVE_PATH_BYTES {
        return Err(invalid().into());
    }
    let mut keys = path.key.split('/');
    for component in path.relative.split('/') {
        PortableFilename::parse(component)?;
        let key = keys.next().ok_or_else(invalid)?;
        if key.is_empty()
            || key == "."
            || key == ".."
            || key.contains('\\')
            || key.chars().any(char::is_control)
        {
            return Err(invalid().into());
        }
        let folded = lookup_key(component);
        if matches!(folded.as_str(), ".git" | ".notarium") || folded.starts_with(".notarium-") {
            return Err(invalid().into());
        }
    }
    if keys.next().is_some()
        || !path
            .relative
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
    {
        return Err(invalid().into());
    }
    Ok(())
}

pub(super) fn check_file(file: &VaultFileStamp) -> Result<(), PortError> {
    if file.size > i64::MAX as u64 || file.mtime_nanos >= 1_000_000_000 {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    Ok(())
}

pub(super) fn check_page(limit: u16) -> Result<i64, PortError> {
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(DomainError::validation(ValidationReason::InvalidLimit).into());
    }
    Ok(i64::from(limit))
}

pub(super) async fn active_binding_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    auth: &EngineAuthContext,
) -> Result<Option<VaultBinding>, PortError> {
    let row: Option<BindingRow> =
        query!(
        tx, query_as,
        "SELECT binding_generation, history_incarnation, root_identity, actor_id, acknowledged_seq
         FROM vault_bindings WHERE space_id = $1 AND active = 1",
        fetch_optional, scope.space_id.as_str()
    )?;
    row.map(|(generation, incarnation, root_identity, actor, cursor)| {
        if actor != auth.principal().as_str() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let incarnation = incarnation
            .try_into()
            .map_err(|_| corrupt("bad incarnation length"))?;
        Ok(VaultBinding {
            scope: HistoryScope {
                space_id: scope.space_id.clone(),
                incarnation: HistoryIncarnation::from_bytes(incarnation),
            },
            generation: digest(generation)?,
            root_identity: digest(root_identity)?,
            cursor: i64_to_space_seq(cursor)?,
        })
    })
    .transpose()
}

pub(super) async fn require_binding_tx(
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
    space: &SpaceRecord,
    expected: &VaultBinding,
) -> Result<VaultBinding, PortError> {
    space.scope.check(ctx.scope())?;
    require_binding_for_actor_tx(tx, ctx.auth(), space, expected).await
}

pub(super) async fn require_binding_for_actor_tx(
    tx: &mut BackendConn<'_>,
    auth: &EngineAuthContext,
    space: &SpaceRecord,
    expected: &VaultBinding,
) -> Result<VaultBinding, PortError> {
    check_actor(auth, &expected.scope, space)?;
    let current = active_binding_tx(tx, &space.scope, auth)
        .await?
        .ok_or_else(generation_changed)?;
    if current.scope != expected.scope
        || current.generation != expected.generation
        || current.root_identity != expected.root_identity
    {
        return Err(generation_changed());
    }
    Ok(current)
}

impl CanonicalStore {
    pub async fn vault_binding(
        &self,
        ctx: &SpaceContext,
    ) -> Result<Option<VaultBinding>, PortError> {
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                check_actor(ctx.auth(), ctx.scope(), &space)?;
                active_binding_tx(tx, &space.scope, ctx.auth()).await
            })
        })
        .await
    }

    /// Establish a binding on first use or explicitly replace the currently
    /// observed generation. An old incarnation is never silently rebound.
    pub async fn bind_vault(
        &self,
        ctx: SpaceContext,
        root_identity: ContentDigest,
        new_generation: ContentDigest,
        expected_generation: Option<ContentDigest>,
    ) -> Result<VaultBinding, PortError> {
        self.write_vault_state(ctx, "bind_vault", move |tx, ctx, space| {
            Box::pin(async move {
                let old = active_binding_tx(tx, &space.scope, ctx.auth()).await?;
                if let Some(binding) = &old
                    && binding.generation == new_generation
                    && binding.root_identity == root_identity
                    && binding.scope == space.scope
                {
                    return Ok(binding.clone());
                }
                if old.as_ref().map(|binding| binding.generation) != expected_generation {
                    return Err(generation_changed());
                }
                let generation_used: Option<i64> = query!(
                    tx,
                    query_scalar,
                    "SELECT CAST(1 AS BIGINT) FROM vault_bindings
                     WHERE space_id = $1 AND binding_generation = $2",
                    fetch_optional,
                    space.scope.space_id.as_str(),
                    new_generation.as_bytes().as_slice()
                )?;
                if generation_used.is_some() {
                    return Err(generation_changed());
                }
                execute!(
                    tx,
                    "UPDATE vault_bindings SET active = 0 WHERE space_id = $1 AND active = 1",
                    space.scope.space_id.as_str()
                )?;
                execute!(
                    tx,
                    "INSERT INTO vault_bindings (
                        space_id, binding_generation, history_incarnation, root_identity,
                        actor_id, acknowledged_seq, active
                     ) VALUES ($1, $2, $3, $4, $5, 0, 1)",
                    space.scope.space_id.as_str(),
                    new_generation.as_bytes().as_slice(),
                    space.scope.incarnation.as_bytes().as_slice(),
                    root_identity.as_bytes().as_slice(),
                    ctx.auth().principal().as_str()
                )?;
                Ok(VaultBinding {
                    scope: space.scope,
                    generation: new_generation,
                    root_identity,
                    cursor: SpaceSeq::ZERO,
                })
            })
        })
        .await
    }

    pub async fn advance_vault_cursor(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: SpaceSeq,
        next: SpaceSeq,
    ) -> Result<(), PortError> {
        let binding = binding.clone();
        self.write_vault_state(ctx, "advance_vault_cursor", move |tx, ctx, space| {
            Box::pin(async move {
                let current = require_binding_tx(tx, &ctx, &space, &binding).await?;
                if next < expected || next > space.last_seq {
                    return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                }
                if current.cursor == next {
                    return Ok(());
                }
                if current.cursor != expected {
                    return Err(DomainError::validation(ValidationReason::CursorStale).into());
                }
                require_command_end_tx(tx, &binding.scope, next).await?;
                execute!(
                    tx,
                    "UPDATE vault_bindings SET acknowledged_seq = $3
                     WHERE space_id = $1 AND binding_generation = $2",
                    binding.scope.space_id.as_str(),
                    binding.generation.as_bytes().as_slice(),
                    next.get() as i64
                )?;
                Ok(())
            })
        })
        .await
    }

    pub async fn vault_observation_at(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        key: &str,
    ) -> Result<Option<VaultObservation>, PortError> {
        let key = key.to_owned();
        self.read_vault_state(ctx, binding, move |tx, binding| {
            Box::pin(async move { observation_for_key_tx(tx, &binding, &key).await })
        })
        .await
    }

    pub async fn vault_observation_for(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        note: &NoteId,
    ) -> Result<Option<VaultObservation>, PortError> {
        let note = note.clone();
        self.read_vault_state(ctx, binding, move |tx, binding| {
            Box::pin(async move { observation_for_note_tx(tx, &binding, &note).await })
        })
        .await
    }

    /// Page in the volume's comparison order, optionally within a directory.
    pub async fn vault_observations(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        prefix: Option<&str>,
        after: Option<&str>,
        limit: u16,
    ) -> Result<Vec<VaultObservation>, PortError> {
        let limit = check_page(limit)?;
        let after = after.unwrap_or_default().to_owned();
        let descendants = prefix.map(|prefix| (format!("{prefix}/"), format!("{prefix}0")));
        self.read_vault_state(ctx, binding, move |tx, binding| {
            Box::pin(async move {
                let sid = binding.scope.space_id.as_str();
                let generation = binding.generation.as_bytes().as_slice();
                let rows: Vec<ObservationRow> = if let Some((lower, upper)) = descendants {
                    query!(
                        tx,
                        query_as,
                        concat!(
                            "SELECT ",
                            observation_fields!(),
                            " FROM vault_observations
                        WHERE space_id = $1 AND binding_generation = $2 AND path_key > $3
                           AND path_key >= $4 AND path_key < $5 ORDER BY path_key LIMIT $6"
                        ),
                        fetch_all,
                        sid,
                        generation,
                        &after,
                        lower,
                        upper,
                        limit
                    )?
                } else {
                    query!(
                        tx,
                        query_as,
                        concat!(
                            "SELECT ",
                            observation_fields!(),
                            " FROM vault_observations
                        WHERE space_id = $1 AND binding_generation = $2 AND path_key > $3
                        ORDER BY path_key LIMIT $4"
                        ),
                        fetch_all,
                        sid,
                        generation,
                        &after,
                        limit
                    )?
                };
                rows.into_iter().map(VaultObservation::try_from).collect()
            })
        })
        .await
    }

    pub async fn put_vault_observation(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: Option<VaultObservation>,
        observation: VaultObservation,
    ) -> Result<(), PortError> {
        check_path(&observation.path)?;
        check_file(&observation.file)?;
        let binding = binding.clone();
        self.write_vault_state(ctx, "put_vault_observation", move |tx, ctx, space| {
            Box::pin(async move {
                require_binding_tx(tx, &ctx, &space, &binding).await?;
                super::content::require_vault_publication_tx(tx, &space, &ctx, &observation)
                    .await?;
                let current = observation_for_note_tx(tx, &binding, &observation.note).await?;
                if current.as_ref() == Some(&observation) {
                    return Ok(());
                }
                if current.as_ref() != expected.as_ref() {
                    return Err(observation_changed());
                }
                let pending: Option<i64> = query!(
                    tx,
                    query_scalar,
                    "SELECT CAST(1 AS BIGINT) FROM vault_handoffs
                     WHERE space_id = $1 AND binding_generation = $2 AND path_key = $3
                     UNION ALL
                     SELECT CAST(1 AS BIGINT) FROM vault_handoffs
                     WHERE space_id = $1 AND binding_generation = $2 AND successor_note_id = $4
                     LIMIT 1",
                    fetch_optional,
                    binding.scope.space_id.as_str(),
                    binding.generation.as_bytes().as_slice(),
                    &observation.path.key,
                    observation.note.as_str()
                )?;
                if pending.is_some() {
                    return Err(observation_changed());
                }
                upsert_observation_tx(tx, &binding, &observation).await
            })
        })
        .await
    }

    pub async fn remove_vault_observation(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultObservation,
    ) -> Result<(), PortError> {
        let binding = binding.clone();
        self.write_vault_state(ctx, "remove_vault_observation", move |tx, ctx, space| {
            Box::pin(async move {
                require_binding_tx(tx, &ctx, &space, &binding).await?;
                let current = observation_for_note_tx(tx, &binding, &expected.note).await?;
                if let Some(current) = current {
                    if current != expected {
                        return Err(observation_changed());
                    }
                    delete_observation_tx(tx, &binding, &expected.note).await?;
                }
                Ok(())
            })
        })
        .await
    }

    pub async fn vault_handoffs(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
    ) -> Result<Vec<VaultHandoff>, PortError> {
        self.read_vault_state(ctx, binding, |tx, binding| {
            Box::pin(async move {
                let rows: Vec<HandoffRow> = query!(
                    tx,
                    query_as,
                    concat!(
                        "SELECT ",
                        observation_fields!(),
                        ", successor_note_id,
                        successor_revision, purge_seq FROM vault_handoffs
                        WHERE space_id = $1 AND binding_generation = $2 ORDER BY note_id"
                    ),
                    fetch_all,
                    binding.scope.space_id.as_str(),
                    binding.generation.as_bytes().as_slice()
                )?;
                rows.into_iter().map(VaultHandoff::try_from).collect()
            })
        })
        .await
    }

    pub async fn vault_candidate_is_quarantined(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        path: &VaultPath,
        file: &VaultFileStamp,
        claimed: Option<&NoteId>,
    ) -> Result<bool, PortError> {
        let path = path.clone();
        let file = file.clone();
        let claimed = claimed.cloned();
        self.read_vault_state(ctx, binding, move |tx, binding| {
            Box::pin(async move {
                match guarded_candidate_tx(tx, &binding, &path, &file, claimed.as_ref()).await {
                    Ok(()) => Ok(false),
                    Err(PortError::Domain(DomainError::PathConflict { .. })) => Ok(true),
                    Err(error) => Err(error),
                }
            })
        })
        .await
    }

    pub async fn complete_vault_handoff(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultHandoff,
        successor: VaultObservation,
    ) -> Result<(), PortError> {
        check_file(&successor.file)?;
        if expected.new_note.as_ref().map(|n| &n.note) != Some(&successor.note)
            || expected.observation.path != successor.path
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        self.complete_handoff(ctx, binding, expected, Some(successor), || true)
            .await
    }

    /// Retire an ordinary purge witness only while its observed filesystem
    /// cut is valid. The callback runs inside the write transaction and must
    /// perform a bounded in-process check.
    pub async fn complete_vault_purge(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultHandoff,
        still_safe: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<(), PortError> {
        if expected.new_note.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        self.complete_handoff(ctx, binding, expected, None, still_safe)
            .await
    }

    async fn complete_handoff(
        &self,
        ctx: SpaceContext,
        binding: &VaultBinding,
        expected: VaultHandoff,
        successor: Option<VaultObservation>,
        still_safe: impl Fn() -> bool + Send + 'static,
    ) -> Result<(), PortError> {
        let binding = binding.clone();
        self.write_vault_state(ctx, "complete_vault_handoff", move |tx, ctx, space| {
            Box::pin(async move {
                require_binding_tx(tx, &ctx, &space, &binding).await?;
                if !still_safe() {
                    return Err(observation_changed());
                }
                let row: Option<HandoffRow> = query!(
                    tx,
                    query_as,
                    concat!(
                        "SELECT ",
                        observation_fields!(),
                        ", successor_note_id,
                        successor_revision, purge_seq FROM vault_handoffs
                        WHERE space_id = $1 AND binding_generation = $2 AND note_id = $3"
                    ),
                    fetch_optional,
                    binding.scope.space_id.as_str(),
                    binding.generation.as_bytes().as_slice(),
                    expected.old_note.as_str()
                )?;
                let Some(current) = row.map(VaultHandoff::try_from).transpose()? else {
                    if let Some(stamp) = &successor
                        && observation_for_note_tx(tx, &binding, &stamp.note)
                            .await?
                            .as_ref()
                            != Some(stamp)
                    {
                        return Err(observation_changed());
                    }
                    return Ok(());
                };
                if current != expected {
                    return Err(observation_changed());
                }
                if let Some(stamp) = &successor {
                    super::content::require_vault_publication_tx(tx, &space, &ctx, stamp).await?;
                    upsert_observation_tx(tx, &binding, stamp).await?;
                }
                execute!(
                    tx,
                    "DELETE FROM vault_handoffs
                         WHERE space_id = $1 AND binding_generation = $2 AND note_id = $3",
                    binding.scope.space_id.as_str(),
                    binding.generation.as_bytes().as_slice(),
                    expected.old_note.as_str()
                )?;
                if !still_safe() {
                    return Err(observation_changed());
                }
                Ok(())
            })
        })
        .await
    }

    pub(super) async fn read_vault_state<T, F>(
        &self,
        ctx: &SpaceContext,
        binding: &VaultBinding,
        operation: F,
    ) -> Result<T, PortError>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(
                &'a mut BackendConn<'_>,
                VaultBinding,
            ) -> BoxFuture<'a, Result<T, PortError>>
            + Send
            + 'static,
    {
        let expected = binding.clone();
        self.with_read_tx_budget(Some(&ctx.budget), |tx| {
            let ctx = ctx.clone();
            Box::pin(async move {
                let space = load_space_record(tx, &ctx.scope().space_id).await?;
                let binding = require_binding_tx(tx, &ctx, &space, &expected).await?;
                operation(tx, binding).await
            })
        })
        .await
    }

    pub(super) async fn write_vault_state<T, F>(
        &self,
        ctx: SpaceContext,
        name: &'static str,
        operation: F,
    ) -> Result<T, PortError>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(
                &'a mut BackendConn<'_>,
                SpaceContext,
                SpaceRecord,
            ) -> BoxFuture<'a, Result<T, PortError>>
            + Send
            + 'static,
    {
        let budget = ctx.budget.clone();
        let deadline = CommandDeadline::start(&budget, name);
        let space = deadline
            .prepare(&budget, || {
                self.read_space_fast_or_pool(&ctx.scope().space_id, Some(&budget))
            })
            .await?;
        check_actor(ctx.auth(), ctx.scope(), &space)?;
        self.inner
            .check_writer_epoch(&space.scope.space_id, space.active_epoch)?;
        self.with_auxiliary_command(Some((&budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let space = lock_and_check_space_tx(tx, &space.scope, space.active_epoch).await?;
                check_actor(ctx.auth(), ctx.scope(), &space)?;
                operation(tx, ctx, space).await
            })
        })
        .await
    }
}

pub(super) fn observation_changed() -> PortError {
    DomainError::validation(ValidationReason::CursorStale).into()
}

pub(super) async fn observation_for_note_tx(
    tx: &mut BackendConn<'_>,
    binding: &VaultBinding,
    note: &NoteId,
) -> Result<Option<VaultObservation>, PortError> {
    let row: Option<ObservationRow> = query!(
        tx,
        query_as,
        concat!(
            "SELECT ",
            observation_fields!(),
            " FROM vault_observations
                 WHERE space_id = $1 AND binding_generation = $2 AND note_id = $3"
        ),
        fetch_optional,
        binding.scope.space_id.as_str(),
        binding.generation.as_bytes().as_slice(),
        note.as_str()
    )?;
    row.map(VaultObservation::try_from).transpose()
}

pub(super) async fn observation_for_key_tx(
    tx: &mut BackendConn<'_>,
    binding: &VaultBinding,
    key: &str,
) -> Result<Option<VaultObservation>, PortError> {
    let row: Option<ObservationRow> = query!(
        tx,
        query_as,
        concat!(
            "SELECT ",
            observation_fields!(),
            " FROM vault_observations
                 WHERE space_id = $1 AND binding_generation = $2 AND path_key = $3"
        ),
        fetch_optional,
        binding.scope.space_id.as_str(),
        binding.generation.as_bytes().as_slice(),
        key
    )?;
    row.map(VaultObservation::try_from).transpose()
}

pub(crate) async fn upsert_observation_tx(
    tx: &mut BackendConn<'_>,
    binding: &VaultBinding,
    observation: &VaultObservation,
) -> Result<(), PortError> {
    if observation_for_key_tx(tx, binding, &observation.path.key)
        .await?
        .is_some_and(|existing| existing.note != observation.note)
    {
        return Err(path_conflict(binding, &observation.path));
    }
    execute!(
        tx,
        "INSERT INTO vault_observations (
             space_id, binding_generation, note_id, rel_path, path_key, disk_identity,
             byte_size, mtime_seconds, mtime_nanos, disk_digest, observed_revision, carrier_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (space_id, binding_generation, note_id) DO UPDATE SET
            rel_path = excluded.rel_path, path_key = excluded.path_key,
            disk_identity = excluded.disk_identity, byte_size = excluded.byte_size,
            mtime_seconds = excluded.mtime_seconds, mtime_nanos = excluded.mtime_nanos,
            disk_digest = excluded.disk_digest, observed_revision = excluded.observed_revision,
            carrier_digest = excluded.carrier_digest",
        binding.scope.space_id.as_str(),
        binding.generation.as_bytes().as_slice(),
        observation.note.as_str(),
        &observation.path.relative,
        &observation.path.key,
        observation.file.identity.as_bytes().as_slice(),
        observation.file.size as i64,
        observation.file.mtime_seconds,
        observation.file.mtime_nanos as i32,
        observation.file.digest.as_bytes().as_slice(),
        observation.revision.as_str(),
        observation.carrier_digest.as_bytes().as_slice()
    )?;
    Ok(())
}

pub(super) async fn delete_observation_tx(
    tx: &mut BackendConn<'_>,
    binding: &VaultBinding,
    note: &NoteId,
) -> Result<(), PortError> {
    execute!(
        tx,
        "DELETE FROM vault_observations WHERE space_id = $1 AND binding_generation = $2 AND note_id = $3",
        binding.scope.space_id.as_str(),
        binding.generation.as_bytes().as_slice(),
        note.as_str()
    )?;
    Ok(())
}

pub(super) fn path_conflict(binding: &VaultBinding, path: &VaultPath) -> PortError {
    DomainError::PathConflict {
        target: PathTarget {
            space_id: binding.scope.space_id.clone(),
            parent: None,
            component: path.relative.clone(),
        },
    }
    .into()
}

/// Called inside the same writer savepoint that installs the purge fence.
/// No authority is derived from local state, and only recorded file evidence
/// crosses the SQL erasure boundary.
pub(crate) async fn handoff_purged_note_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    successor: Option<(&NoteId, &RevisionId)>,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    let sid = scope.space_id.as_str();
    let new_note = successor.map(|(note, _)| note.as_str());
    let new_revision = successor.map(|(_, revision)| revision.as_str());
    execute!(
        tx,
        "UPDATE vault_handoffs SET successor_note_id = $3, successor_revision = $4, purge_seq = $5
         WHERE space_id = $1 AND successor_note_id = $2",
        sid,
        note.as_str(),
        new_note,
        new_revision,
        seq.get() as i64
    )?;
    execute!(
        tx,
        "INSERT INTO vault_handoffs (
            space_id, binding_generation, note_id, rel_path, path_key, disk_identity, byte_size,
            mtime_seconds, mtime_nanos, disk_digest, observed_revision, carrier_digest,
            successor_note_id, successor_revision, purge_seq
         ) SELECT space_id, binding_generation, note_id, rel_path, path_key, disk_identity, byte_size,
            mtime_seconds, mtime_nanos, disk_digest, observed_revision, carrier_digest, $3, $4, $5
         FROM vault_observations WHERE space_id = $1 AND note_id = $2",
        sid, note.as_str(), new_note, new_revision, seq.get() as i64
    )?;
    execute!(
        tx,
        "DELETE FROM vault_observations WHERE space_id = $1 AND note_id = $2",
        sid,
        note.as_str()
    )?;
    Ok(())
}

pub(super) async fn guarded_candidate_tx(
    tx: &mut BackendConn<'_>,
    binding: &VaultBinding,
    path: &VaultPath,
    file: &VaultFileStamp,
    claimed: Option<&NoteId>,
) -> Result<(), PortError> {
    // Stale incarnations and bindings cannot authorize a filesystem mutation.
    // Their surviving witnesses still prohibit automatic import of a match.
    let result: Option<i64> = query!(
        tx, query_scalar,
        "SELECT CAST(1 AS BIGINT) FROM vault_bindings b
         WHERE b.space_id = $1 AND (
             EXISTS (SELECT 1 FROM vault_handoffs h
                     WHERE h.space_id = b.space_id AND h.binding_generation = b.binding_generation
                       AND h.disk_identity = $4)
             OR (b.root_identity = $2 AND (
                 EXISTS (SELECT 1 FROM vault_handoffs h
                         WHERE h.space_id = b.space_id AND h.binding_generation = b.binding_generation
                           AND h.path_key = $3)
                 OR ($5 = 1 AND EXISTS (SELECT 1 FROM vault_handoffs h
                         WHERE h.space_id = b.space_id AND h.binding_generation = b.binding_generation
                           AND h.disk_digest = $6))
             ))
             OR (b.binding_generation <> $7 AND (
                 EXISTS (SELECT 1 FROM vault_observations o
                         WHERE o.space_id = b.space_id AND o.binding_generation = b.binding_generation
                           AND o.disk_identity = $4)
                 OR (b.root_identity = $2 AND (
                     EXISTS (SELECT 1 FROM vault_observations o
                             WHERE o.space_id = b.space_id AND o.binding_generation = b.binding_generation
                               AND o.path_key = $3)
                     OR ($5 = 1 AND EXISTS (SELECT 1 FROM vault_observations o
                             WHERE o.space_id = b.space_id AND o.binding_generation = b.binding_generation
                               AND o.disk_digest = $6))
                 ))
             ))
         )
         LIMIT 1",
        fetch_optional, binding.scope.space_id.as_str(), binding.root_identity.as_bytes().as_slice(),
        &path.key, file.identity.as_bytes().as_slice(), i32::from(claimed.is_none()),
        file.digest.as_bytes().as_slice(), binding.generation.as_bytes().as_slice()
    )?;
    if result.is_some() {
        return Err(path_conflict(binding, path));
    }
    Ok(())
}
