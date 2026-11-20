use std::collections::{BTreeMap, HashSet};

use notarium_canonical::ProjectionErasures;
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ChatThreadId, HistoryIncarnation, NoteId, SpaceId, SpaceSeq, ThreadEntrySeq},
    model::{HistoryScope, Lifecycle},
    ports::Cancellation,
    value::YamlValue,
};

use super::{
    DerivedMutation, DerivedStore, ProjectionWatermark, SpaceApply, StageKey, invalid_row,
    mismatch,
    read::watermark,
    records::*,
    replay,
    schema::{SpaceGuard, lock_space_guard_with_origin, read_space_guard},
    sql::{Kind, SqlColumn, SqlRecord, SqlTransaction, SqlValue, key_filter, placeholders, value},
    staging::{StageBuffer, StagePage, invalid_limit},
    stale,
};

const MAX_DENSE_CAPACITY: u64 = u32::MAX as u64 + 1;
// Bound multi-row VALUES batches so both SQLite and PostgreSQL compile and cache
// one fixed-size batch statement per table without large-VALUES planner spikes.
const MAX_MULTI_ROW_PARAMS: usize = 2_400;
const MAX_BATCH_ROWS: usize = 100;

pub(crate) struct SeedWitness {
    space: SpaceId,
    guard: Option<SpaceGuard>,
    watermark: Option<WatermarkRecord>,
}

impl SeedWitness {
    pub(crate) fn previous_watermark(&self) -> Result<Option<ProjectionWatermark>, PortError> {
        self.watermark
            .clone()
            .map(WatermarkRecord::watermark)
            .transpose()
    }
}

impl DerivedStore {
    pub async fn register_scope(&self, scope: &HistoryScope) -> Result<(), PortError> {
        let scope = scope.clone();
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move { check_guard(&mut tx, &scope).await.map(|_| ()) })
            })
            .await
    }

    /// Observes the derived cut before canonical chooses an exact seed cutoff.
    pub(crate) async fn observe_seed(&self, space: &SpaceId) -> Result<SeedWitness, PortError> {
        let space = space.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    Ok(SeedWitness {
                        guard: read_space_guard(&mut tx, &space, false).await?,
                        watermark: watermark(&mut tx, &space).await?,
                        space,
                    })
                })
            })
            .await
    }

    /// Starts a private seed only if the state observed before its canonical
    /// header is still current. A stale worker cannot rebind a replaced Space.
    pub(crate) async fn begin_seed(
        &self,
        initial: &ProjectionWatermark,
        observed: SeedWitness,
        stop: &Cancellation,
    ) -> Result<bool, PortError> {
        if observed.space != initial.scope.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
        check_seed_cancellation(stop)?;
        let stop = stop.clone();
        let initial = initial.clone();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move {
                    let (guard, inserted) =
                        lock_space_guard_with_origin(&mut tx, &initial.scope).await?;
                    check_seed_cancellation(&stop)?;
                    let existing = watermark(&mut tx, &initial.scope.space_id).await?;
                    if (!inserted).then_some(&guard) != observed.guard.as_ref()
                        || existing != observed.watermark
                    {
                        return Err(stale());
                    }
                    let changed_history = guard.incarnation != initial.scope.incarnation;
                    let repair_incoming =
                        changed_history || existing.as_ref().is_some_and(|row| row.seed_in_progress);
                    if !changed_history
                        && (initial.projected_seq < guard.minimum_checkpoint_seq
                            || existing
                                .as_ref()
                                .is_some_and(|row| initial.projected_seq < row.projected_seq))
                    {
                        return Err(stale());
                    }
                    // Canonical table lock order:
                    //   projection_space_guard -> markers -> projection_apply_pages -> chat_note_refs.
                    if changed_history {
                        tx.execute(
                            "UPDATE projection_space_guard SET history_incarnation = ?, minimum_checkpoint_seq = 0 WHERE space_id = ?",
                            vec![value(&initial.scope.incarnation), value(&initial.scope.space_id)],
                        )
                        .await?;
                        for table in ["projected_purge_markers", "projected_redaction_markers"] {
                            tx.execute(
                                &format!("DELETE FROM {table} WHERE space_id = ?"),
                                vec![value(&initial.scope.space_id)],
                            )
                            .await?;
                        }
                        discard_incoming_staging(&mut tx, &initial.scope.space_id, None).await?;
                    }
                    tx.execute(
                        "DELETE FROM projection_apply_pages WHERE space_id = ?",
                        vec![value(&initial.scope.space_id)],
                    )
                    .await?;
                    if changed_history {
                        tx.execute(
                            "DELETE FROM chat_note_refs WHERE target_space_id = ? OR thread_space_id = ?",
                            vec![value(&initial.scope.space_id), value(&initial.scope.space_id)],
                        )
                        .await?;
                        tx.execute(
                            "DELETE FROM projection_checkpoints WHERE space_id = ?",
                            vec![value(&initial.scope.space_id)],
                        )
                        .await?;
                    }

                    replay::clear(&mut tx, &initial.scope.space_id).await?;
                    if changed_history {
                        clear_space(&mut tx, &initial.scope.space_id).await?;
                    }
                    let mut seeding = ProjectionWatermark {
                        projected_seq: SpaceSeq::ZERO,
                        snapshot_seq: SpaceSeq::ZERO,
                        graph_settled_seq: SpaceSeq::ZERO,
                        schema: None,
                        seed_in_progress: true,
                        ..initial
                    };
                    if let Some(existing) = existing
                        .filter(|row| row.history_incarnation == seeding.scope.incarnation)
                    {
                        seeding.next_dense_id = seeding.next_dense_id.max(existing.next_dense_id);
                        seeding.next_dense_folder_id =
                            seeding.next_dense_folder_id.max(existing.next_dense_folder_id);
                    }
                    validate_watermark(&seeding)?;
                    upsert(&mut tx, &WatermarkRecord::from_watermark(&seeding)).await?;
                    check_seed_cancellation(&stop)?;
                    Ok(repair_incoming)
                })
            })
            .await
    }

    /// Repairs one bounded page while the target history is private. Source
    /// redaction and target purge use the same ordered guards as this write.
    pub(crate) async fn repair_incoming_chat_refs(
        &self,
        target: &HistoryScope,
        source: &HistoryScope,
        rows: Vec<ProjectedChatRef>,
    ) -> Result<(), PortError> {
        if source.space_id == target.space_id || rows.len() > 200 {
            return Err(invalid_row());
        }
        for row in &rows {
            if row.target_space_id != target.space_id
                || row.target_incarnation != target.incarnation
                || row.thread_space_id != source.space_id
                || row.source_incarnation != source.incarnation
            {
                return Err(mismatch());
            }
        }
        if rows.is_empty() {
            return Ok(());
        }
        let target = target.clone();
        let guards = BTreeMap::from([
            (target.space_id.clone(), target.incarnation),
            (source.space_id.clone(), source.incarnation),
        ]);
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    lock_scopes(&mut tx, &target, guards).await?;
                    let current = watermark(&mut tx, &target.space_id)
                        .await?
                        .ok_or_else(stale)?;
                    if current.history_incarnation != target.incarnation
                        || !current.seed_in_progress
                    {
                        return Err(stale());
                    }
                    for row in rows {
                        if chat_reference_current(&mut tx, &row).await? {
                            upsert_chat_ref(&mut tx, &row).await?;
                        }
                    }
                    Ok(())
                })
            })
            .await
    }

    /// Reuses an existing row ID during a rebuild of the same incarnation.
    pub async fn note_dense_for_seed(
        &self,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<Option<u32>, PortError> {
        let scope = scope.clone();
        let note = note.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let Some(row) = watermark(&mut tx, &scope.space_id).await? else {
                        return Ok(None);
                    };
                    if row.history_incarnation != scope.incarnation {
                        return Err(mismatch());
                    }
                    let row = tx
                        .select(
                            "SELECT dense_id FROM projected_notes WHERE space_id = ? AND note_id = ?",
                            vec![value(&scope.space_id), value(&note)],
                            &[Kind::Integer],
                        )
                        .await?
                        .pop();
                    row.map(one::<u32>).transpose()
                })
            })
            .await
    }

    pub async fn folder_dense_for_seed(
        &self,
        scope: &HistoryScope,
        folder: &notarium_core::ids::FolderId,
    ) -> Result<Option<u32>, PortError> {
        let scope = scope.clone();
        let folder = folder.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let Some(row) = watermark(&mut tx, &scope.space_id).await? else {
                        return Ok(None);
                    };
                    if row.history_incarnation != scope.incarnation {
                        return Err(mismatch());
                    }
                    tx.select(
                        "SELECT dense_folder_id FROM projected_folders WHERE space_id = ? AND folder_id = ?",
                        vec![value(&scope.space_id), value(&folder)],
                        &[Kind::Integer],
                    )
                    .await?
                    .pop()
                    .map(one::<u32>)
                    .transpose()
                })
            })
            .await
    }

    /// Reconciles erasure markers with an exact serving history.
    pub async fn erase_visibility(
        &self,
        scope: &HistoryScope,
        through: SpaceSeq,
        purged: &[NoteId],
        redacted: &[(ChatThreadId, ThreadEntrySeq)],
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        let purged = purged.to_vec();
        let redacted = redacted.to_vec();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move {
                    check_guard(&mut tx, &scope).await?;
                    erase_guarded(&mut tx, &scope, through, &purged, &redacted).await
                })
            })
            .await
    }

    /// Removes committed data from the actual history of this generation.
    pub(crate) async fn erase_committed_visibility(
        &self,
        erasures: &ProjectionErasures,
    ) -> Result<(HistoryScope, SpaceSeq), PortError> {
        let erasures = erasures.clone();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move { erase_committed(&mut tx, &erasures).await })
            })
            .await
    }

    pub async fn apply(&self, change: &SpaceApply) -> Result<(), PortError> {
        self.apply_with_replay(change, None).await
    }

    /// Applies one complete incremental command in a single SQL transaction
    /// without roundtripping through `projection_apply_pages`.
    pub(crate) async fn apply_with_replay(
        &self,
        change: &SpaceApply,
        slots: Option<Vec<u8>>,
    ) -> Result<(), PortError> {
        let change = change.clone();
        let scrub = needs_scrub(&change.mutations);
        self.database
            .write_adaptive(move |mut tx| {
                Box::pin(async move {
                    let scopes = mutation_scopes(&change.watermark.scope, &change.mutations)?;
                    let floor = lock_scopes(&mut tx, &change.watermark.scope, scopes).await?;
                    check_apply_floor(&change.watermark, floor)?;
                    let current = watermark(&mut tx, &change.watermark.scope.space_id).await?;
                    if already_applied(current.as_ref(), change.expected, &change.watermark)? {
                        return Ok(((), false));
                    }
                    let seed = current.as_ref().is_some_and(|row| row.seed_in_progress);
                    if let Some(existing) = &current
                        && !existing.seed_in_progress
                        && existing.projected_seq == change.watermark.projected_seq
                        && change.mutations.iter().any(|mutation| {
                            !matches!(
                                mutation,
                                DerivedMutation::UpsertCluster(_) | DerivedMutation::DeleteClusters
                            )
                        })
                    {
                        return Err(stale());
                    }
                    if seed {
                        clear_space(&mut tx, &change.watermark.scope.space_id).await?;
                    }
                    apply_mutations(&mut tx, &change.watermark, &change.mutations).await?;
                    if scrub {
                        check_apply_floor(
                            &change.watermark,
                            checkpoint_floor(&mut tx, &change.watermark.scope.space_id).await?,
                        )?;
                    }
                    finish_apply(&mut tx, &change.watermark).await?;
                    if current
                        .as_ref()
                        .is_none_or(|row| row.projected_seq != change.watermark.projected_seq)
                    {
                        let slots = if scrub { None } else { slots };
                        replay::publish(&mut tx, &change.watermark, change.expected, slots).await?;
                    }
                    Ok(((), scrub || seed))
                })
            })
            .await
    }

    pub async fn stage_page(
        &self,
        key: &StageKey,
        page_no: u64,
        mutations: &[DerivedMutation],
    ) -> Result<(), PortError> {
        let mut page = StageBuffer::default();
        for mutation in mutations {
            if !page.push(key, mutation)? {
                return if mutations.len() == 1 {
                    self.stage_single(key, page_no, mutation).await
                } else {
                    Err(invalid_limit())
                };
            }
        }
        self.stage_buffer(key, page_no, page).await
    }

    pub(crate) async fn stage_buffer(
        &self,
        key: &StageKey,
        page_no: u64,
        page: StageBuffer,
    ) -> Result<(), PortError> {
        self.persist_staging_page(key, page_no, page.finish()?)
            .await
    }

    pub(crate) async fn stage_single(
        &self,
        key: &StageKey,
        page_no: u64,
        mutation: &DerivedMutation,
    ) -> Result<(), PortError> {
        let page = StagePage::single(key, mutation)?;
        self.persist_staging_page(key, page_no, page).await
    }

    async fn persist_staging_page(
        &self,
        key: &StageKey,
        page_no: u64,
        page: StagePage,
    ) -> Result<(), PortError> {
        if key.first > key.last {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        let key = key.clone();
        let StagePage { payload, checks } = page;
        let mut dependencies =
            BTreeMap::from([(key.scope.space_id.clone(), key.scope.incarnation)]);
        for row in &checks.references {
            add_chat_ref_scope(&mut dependencies, &key.scope, row)?;
        }
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let floor = lock_scopes(&mut tx, &key.scope, dependencies).await?;
                    if key.last < floor {
                        return Err(stale());
                    }
                    if any_purge_marked(&mut tx, &key.scope, &checks.notes).await? {
                        return Err(stale());
                    }
                    let mut args = stage_values(&key);
                    args.extend([value(&page_no), value(&checks.destructive), value(&payload)]);
                    let inserted = tx
                        .execute(
                            "INSERT INTO projection_apply_pages (space_id, history_incarnation, first_seq, last_seq, page_no, destructive, payload)
                             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                            args,
                        )
                        .await?;
                    if inserted == 0 {
                        let recorded = get_staging_page(&mut tx, &key, page_no)
                            .await?
                            .ok_or_else(stale)?;
                        if recorded != payload {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidState).into(),
                            );
                        }
                        return Ok(());
                    }
                    for row in checks.references {
                        if !chat_reference_current(&mut tx, &row).await? {
                            // Do not durably retain an invalidated locator in staging.
                            return Err(stale());
                        }
                        let mut values = stage_values(&key);
                        values.extend([
                            value(&page_no),
                            value(&row.target_space_id),
                            value(&row.target_incarnation),
                            value(&row.target_note_id),
                            value(&row.thread_id),
                            value(&row.entry_seq),
                        ]);
                        tx.execute(
                            "INSERT INTO projection_apply_chat_refs
                                (space_id, history_incarnation, first_seq, last_seq, page_no,
                                 target_space_id, target_incarnation, target_note_id, thread_id, entry_seq)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                            values,
                        )
                        .await?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub async fn publish_staged(
        &self,
        key: &StageKey,
        page_count: u64,
        next: &ProjectionWatermark,
        expected: Option<SpaceSeq>,
    ) -> Result<(), PortError> {
        self.publish_staged_with_replay(key, page_count, next, expected, None)
            .await
    }

    pub(crate) async fn publish_staged_with_replay(
        &self,
        key: &StageKey,
        page_count: u64,
        next: &ProjectionWatermark,
        expected: Option<SpaceSeq>,
        slots: Option<Vec<u8>>,
    ) -> Result<(), PortError> {
        if key.scope != next.scope || key.last != next.projected_seq || key.first > key.last {
            return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
        }
        let key = key.clone();
        let next = next.clone();
        self.database
            .write_adaptive(move |mut tx| {
                Box::pin(async move {
                    let dep_sql = "SELECT DISTINCT target_space_id, target_incarnation
                           FROM projection_apply_chat_refs WHERE space_id = ? AND history_incarnation = ?
                            AND first_seq = ? AND last_seq = ? ORDER BY target_space_id, target_incarnation";
                    let args = stage_values(&key);
                    let kinds = [Kind::Text, Kind::Bytes];
                    let deps = tx.select(dep_sql, args.clone(), &kinds).await?;
                    let mut scopes =
                        BTreeMap::from([(key.scope.space_id.clone(), key.scope.incarnation)]);
                    for mut row in deps.clone() {
                        let incarnation =
                            HistoryIncarnation::read(row.pop().ok_or_else(invalid_row)?)?;
                        let space = SpaceId::read(row.pop().ok_or_else(invalid_row)?)?;
                        add_scope(&mut scopes, space, incarnation)?;
                    }
                    let floor = lock_scopes(&mut tx, &key.scope, scopes).await?;
                    check_apply_floor(&next, floor)?;
                    if deps != tx.select(dep_sql, args, &kinds).await? {
                        return Err(stale());
                    }
                    let current = watermark(&mut tx, &key.scope.space_id).await?;
                    if already_applied(current.as_ref(), expected, &next)? {
                        return Ok(((), false));
                    }

                    let mut witness = tx
                        .select(
                            "SELECT COUNT(*), CAST(COALESCE(MAX(destructive), 0) AS BIGINT)
                               FROM projection_apply_pages
                              WHERE space_id = ? AND history_incarnation = ? AND first_seq = ? AND last_seq = ?",
                            stage_values(&key),
                            &[Kind::Integer, Kind::Integer],
                        )
                        .await?
                        .pop()
                        .ok_or_else(invalid_row)?;
                    let destructive = bool::read(witness.pop().ok_or_else(invalid_row)?)?;
                    if one::<u64>(witness)? != page_count {
                        return Err(stale());
                    }
                    let seed = current.as_ref().is_some_and(|row| row.seed_in_progress);
                    if seed {
                        clear_space(&mut tx, &next.scope.space_id).await?;
                    }
                    if page_count == 1 {
                        let encoded = get_staging_page(&mut tx, &key, 0)
                            .await?
                            .ok_or_else(stale)?;
                        let mutations: Vec<DerivedMutation> = decode(&encoded)?;
                        drop(encoded);
                        tx.execute(
                            "DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?
                             AND first_seq = ? AND last_seq = ?",
                            stage_values(&key),
                        )
                        .await?;
                        apply_mutations(&mut tx, &next, &mutations).await?;
                    } else {
                        // Stream multi-page stages without holding all decoded pages in RAM.
                        // `lock_scopes` already locked `projection_space_guard FOR UPDATE` for
                        // `key.scope` and every target Space in `deps` in sorted SpaceId order,
                        // serializing all overlapping `projection_apply_pages` and `chat_note_refs`
                        // mutations across Spaces.
                        for page in 0..page_count {
                            let encoded = get_staging_page(&mut tx, &key, page)
                                .await?
                                .ok_or_else(stale)?;
                            let mutations: Vec<DerivedMutation> = decode(&encoded)?;
                            drop(encoded);
                            apply_mutations(&mut tx, &next, &mutations).await?;
                        }
                        tx.execute(
                            "DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?
                             AND first_seq = ? AND last_seq = ?",
                            stage_values(&key),
                        )
                        .await?;
                    }
                    if destructive {
                        check_apply_floor(
                            &next,
                            checkpoint_floor(&mut tx, &key.scope.space_id).await?,
                        )?;
                    }
                    finish_apply(&mut tx, &next).await?;
                    let slots = if destructive { None } else { slots };
                    replay::publish(&mut tx, &next, expected, slots).await?;
                    Ok(((), destructive || seed))
                })
            })
            .await
    }

    pub async fn discard_staging(&self, scope: &HistoryScope) -> Result<(), PortError> {
        let scope = scope.clone();
        self.database
            .write_adaptive(move |mut tx| {
                Box::pin(async move {
                    check_guard(&mut tx, &scope).await?;
                    let deleted = tx
                        .execute(
                            "DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?",
                            vec![value(&scope.space_id), value(&scope.incarnation)],
                        )
                        .await?;
                    Ok(((), deleted > 0))
                })
            })
            .await
    }

    pub(crate) async fn validate_checkpoint_publication(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        self.database
            .read(move |mut tx| {
                Box::pin(async move {
                    let guard = read_space_guard(&mut tx, &scope.space_id, false)
                        .await?
                        .ok_or_else(stale)?;
                    if guard.incarnation != scope.incarnation {
                        return Err(mismatch());
                    }
                    let cut = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(stale)?;
                    if cut.history_incarnation != scope.incarnation
                        || cut.seed_in_progress
                        || cut.projected_seq != seq
                        || seq < guard.minimum_checkpoint_seq
                    {
                        return Err(stale());
                    }
                    Ok(())
                })
            })
            .await
    }

    pub(crate) async fn register_checkpoint(
        &self,
        checkpoint: &TrustedCheckpoint,
    ) -> Result<(), PortError> {
        let checkpoint = checkpoint.clone();
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let scope = HistoryScope {
                        space_id: checkpoint.space_id.clone(),
                        incarnation: checkpoint.history_incarnation,
                    };
                    check_guard(&mut tx, &scope).await?;
                    if checkpoint.seq < checkpoint_floor(&mut tx, &scope.space_id).await? {
                        return Err(stale());
                    }
                    let existing: Option<TrustedCheckpoint> =
                        select_key(&mut tx, &checkpoint).await?;
                    if let Some(existing) = existing {
                        return if existing == checkpoint {
                            Ok(())
                        } else {
                            Err(invalid_row())
                        };
                    }
                    upsert(&mut tx, &checkpoint).await
                })
            })
            .await
    }

    pub(crate) async fn forget_checkpoint(
        &self,
        checkpoint: &TrustedCheckpoint,
    ) -> Result<(), PortError> {
        let checkpoint = checkpoint.clone();
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    tx.execute(
                        &format!(
                            "DELETE FROM {} WHERE {}",
                            TrustedCheckpoint::TABLE,
                            key_filter::<TrustedCheckpoint>()
                        ),
                        checkpoint.key(),
                    )
                    .await?;
                    Ok(())
                })
            })
            .await
    }

    /// Validates that `observed` is still the exact unpublished head and removes
    /// any orphaned checkpoint trust record for it. Filesystem unlinking runs
    /// outside the database transaction under the runtime's maintenance gate.
    pub(crate) async fn forget_unpublished_checkpoint(
        &self,
        observed: &ProjectionWatermark,
        format_version: u32,
        platform_abi: String,
        publication_id: String,
    ) -> Result<(), PortError> {
        let scope = observed.scope.clone();
        let before = observed.snapshot_seq;
        let head = observed.projected_seq;
        self.database
            .write(false, move |mut tx| {
                Box::pin(async move {
                    let guard = check_guard(&mut tx, &scope).await?;
                    let cut = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(stale)?;
                    if cut.history_incarnation != scope.incarnation
                        || cut.seed_in_progress
                        || cut.snapshot_seq != before
                        || cut.projected_seq != head
                        || head <= before
                        || head < guard.minimum_checkpoint_seq
                    {
                        return Err(stale());
                    }
                    tx.execute(
                        "DELETE FROM projection_checkpoints
                         WHERE space_id = ? AND history_incarnation = ? AND seq = ?
                           AND format_version = ? AND platform_abi = ? AND publication_id = ?",
                        vec![
                            value(&scope.space_id),
                            value(&scope.incarnation),
                            value(&head),
                            value(&format_version),
                            value(&platform_abi),
                            value(&publication_id),
                        ],
                    )
                    .await?;
                    Ok(())
                })
            })
            .await
    }

    /// Installs a permanent same-history marker and removes all incoming copies.
    pub async fn purge_chat_target(
        &self,
        scope: &HistoryScope,
        target: &NoteId,
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        let target = target.clone();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move {
                    check_guard(&mut tx, &scope).await?;
                    purge_target(&mut tx, &scope, &target).await
                })
            })
            .await
    }

    pub async fn redact_chat_refs(
        &self,
        scope: &HistoryScope,
        entries: &[(ChatThreadId, ThreadEntrySeq)],
    ) -> Result<(), PortError> {
        let scope = scope.clone();
        let mut entries = entries.to_vec();
        entries.sort_unstable();
        entries.dedup();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move {
                    check_guard(&mut tx, &scope).await?;
                    // Canonical lock order: markers -> projection_apply_pages -> chat_note_refs.
                    for (thread, entry) in &entries {
                        insert_redaction_marker(&mut tx, &scope, thread, *entry).await?;
                    }
                    for (thread, entry) in &entries {
                        discard_redacted_staging(&mut tx, &scope, thread, *entry).await?;
                    }
                    for (thread, entry) in &entries {
                        delete_redacted_chat_refs(&mut tx, &scope, thread, *entry).await?;
                    }
                    Ok(())
                })
            })
            .await
    }
}

fn stage_values(key: &StageKey) -> Vec<SqlValue> {
    vec![
        value(&key.scope.space_id),
        value(&key.scope.incarnation),
        value(&key.first),
        value(&key.last),
    ]
}

async fn get_staging_page(
    tx: &mut SqlTransaction<'_>,
    key: &StageKey,
    page: u64,
) -> Result<Option<Vec<u8>>, PortError> {
    let mut params = stage_values(key);
    params.push(value(&page));
    tx.select(
        "SELECT payload FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?
            AND first_seq = ? AND last_seq = ? AND page_no = ?",
        params,
        &[Kind::Bytes],
    )
    .await?
    .pop()
    .map(one::<Vec<u8>>)
    .transpose()
}

fn one<T: SqlColumn>(mut row: Vec<SqlValue>) -> Result<T, PortError> {
    T::read(row.pop().ok_or_else(invalid_row)?)
}

fn add_scope(
    scopes: &mut BTreeMap<SpaceId, HistoryIncarnation>,
    space: SpaceId,
    incarnation: HistoryIncarnation,
) -> Result<(), PortError> {
    if scopes
        .insert(space, incarnation)
        .is_some_and(|old| old != incarnation)
    {
        return Err(mismatch());
    }
    Ok(())
}

fn mutation_scopes(
    source: &HistoryScope,
    mutations: &[DerivedMutation],
) -> Result<BTreeMap<SpaceId, HistoryIncarnation>, PortError> {
    let mut scopes = BTreeMap::from([(source.space_id.clone(), source.incarnation)]);
    for mutation in mutations {
        if let DerivedMutation::UpsertChatRef(row) = mutation {
            add_chat_ref_scope(&mut scopes, source, row)?;
        }
    }
    Ok(scopes)
}

fn add_chat_ref_scope(
    scopes: &mut BTreeMap<SpaceId, HistoryIncarnation>,
    source: &HistoryScope,
    row: &ProjectedChatRef,
) -> Result<(), PortError> {
    if row.thread_space_id != source.space_id || row.source_incarnation != source.incarnation {
        return Err(mismatch());
    }
    add_scope(scopes, row.target_space_id.clone(), row.target_incarnation)
}

async fn check_guard(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
) -> Result<SpaceGuard, PortError> {
    let (guard, _) = lock_space_guard_with_origin(tx, scope).await?;
    if guard.incarnation != scope.incarnation {
        return Err(mismatch());
    }
    Ok(guard)
}

async fn lock_scopes(
    tx: &mut SqlTransaction<'_>,
    source: &HistoryScope,
    scopes: BTreeMap<SpaceId, HistoryIncarnation>,
) -> Result<SpaceSeq, PortError> {
    let mut source_floor = None;
    for (space_id, incarnation) in scopes {
        if space_id == source.space_id {
            source_floor = Some(check_guard(tx, source).await?.minimum_checkpoint_seq);
        } else {
            let sql = if tx.postgres() {
                "SELECT history_incarnation FROM projection_space_guard WHERE space_id = ? FOR UPDATE"
            } else {
                "SELECT history_incarnation FROM projection_space_guard WHERE space_id = ?"
            };
            let actual = tx
                .select(sql, vec![value(&space_id)], &[Kind::Bytes])
                .await?
                .pop()
                .map(one::<HistoryIncarnation>)
                .transpose()?;
            if actual != Some(incarnation) {
                return Err(mismatch());
            }
        }
    }
    source_floor.ok_or_else(invalid_row)
}

fn validate_watermark(next: &ProjectionWatermark) -> Result<(), PortError> {
    if next.snapshot_seq > next.projected_seq
        || next.graph_settled_seq > next.projected_seq
        || next.next_dense_id > MAX_DENSE_CAPACITY
        || next.next_dense_folder_id > MAX_DENSE_CAPACITY
    {
        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
    }
    Ok(())
}

fn already_applied(
    current: Option<&WatermarkRecord>,
    expected: Option<SpaceSeq>,
    next: &ProjectionWatermark,
) -> Result<bool, PortError> {
    validate_watermark(next)?;
    if next.seed_in_progress {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let Some(current) = current else {
        return if expected.is_none() {
            Ok(false)
        } else {
            Err(stale())
        };
    };
    if current.history_incarnation != next.scope.incarnation {
        return Err(mismatch());
    }
    if !current.seed_in_progress && expected != Some(current.projected_seq) {
        return if current.projected_seq == next.projected_seq {
            Ok(true)
        } else {
            Err(stale())
        };
    }
    if current.seed_in_progress && expected.is_some_and(|seq| seq != SpaceSeq::ZERO) {
        return Err(stale());
    }
    if next.projected_seq < current.projected_seq
        || next.snapshot_seq < current.snapshot_seq
        || next.graph_settled_seq < current.graph_settled_seq
        || next.next_dense_id < current.next_dense_id
        || next.next_dense_folder_id < current.next_dense_folder_id
    {
        return Err(stale());
    }
    Ok(false)
}

fn needs_scrub(mutations: &[DerivedMutation]) -> bool {
    mutations.iter().any(|m| {
        matches!(
            m,
            DerivedMutation::PurgeNote(_) | DerivedMutation::RedactChatEntry(..)
        )
    })
}

async fn finish_apply(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
) -> Result<(), PortError> {
    if next.snapshot_seq == next.projected_seq {
        replay::clear(tx, &next.scope.space_id).await?;
    }
    upsert(tx, &WatermarkRecord::from_watermark(next)).await
}

pub(super) fn encrypted_payload_empty(row: &ProjectedNote) -> Result<bool, PortError> {
    if !row.title.is_empty()
        || !row.title_fold.is_empty()
        || !row.preview.is_empty()
        || row.has_pending_nota
        || row.has_invalid_nota
    {
        return Ok(false);
    }
    Ok((row.raw_fields_msgpack.is_empty()
        || decode::<Option<BTreeMap<String, YamlValue>>>(&row.raw_fields_msgpack)?.is_none())
        && (row.header_diagnostic_msgpack.is_empty()
            || decode::<Option<notarium_core::error::Diagnostic>>(&row.header_diagnostic_msgpack)?
                .is_none())
        && (row.evaluated_fields_msgpack.is_empty()
            || decode::<
                BTreeMap<
                    String,
                    notarium_core::query::FieldObservation<notarium_core::query::FieldValue>,
                >,
            >(&row.evaluated_fields_msgpack)?
            .is_empty())
        && (row.diagnostics_msgpack.is_empty()
            || decode::<Vec<notarium_core::error::Diagnostic>>(&row.diagnostics_msgpack)?
                .is_empty())
        && (row.tags_msgpack.is_empty() || decode::<Vec<String>>(&row.tags_msgpack)?.is_empty())
        && (row.view_blocks_msgpack.is_empty()
            || decode::<Vec<crate::nota::ViewInput>>(&row.view_blocks_msgpack)?.is_empty()))
}

#[derive(Default)]
struct MutationBatch<'a> {
    notes: Vec<&'a ProjectedNote>,
    folders: Vec<&'a ProjectedFolder>,
    note_aliases: Vec<&'a ProjectedNoteAlias>,
    folder_aliases: Vec<&'a ProjectedFolderAlias>,
    descriptors: Vec<&'a ProjectedViewDescriptor>,
    ranks: Vec<&'a ProjectedViewRank>,
    candidates: Vec<&'a CandidateLookupKey>,
    links: Vec<&'a ProjectedLink>,
    chat_threads: Vec<&'a ProjectedChatThread>,
    clusters: Vec<&'a ProjectedCluster>,
}

impl MutationBatch<'_> {
    fn is_empty(&self) -> bool {
        self.notes.is_empty()
            && self.folders.is_empty()
            && self.note_aliases.is_empty()
            && self.folder_aliases.is_empty()
            && self.descriptors.is_empty()
            && self.ranks.is_empty()
            && self.candidates.is_empty()
            && self.links.is_empty()
            && self.chat_threads.is_empty()
            && self.clusters.is_empty()
    }
}

async fn flush_batch(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    batch: MutationBatch<'_>,
) -> Result<(), PortError> {
    if batch.is_empty() {
        return Ok(());
    }
    if any_purge_marked(
        tx,
        &next.scope,
        batch
            .notes
            .iter()
            .map(|row| &row.note_id)
            .chain(batch.clusters.iter().map(|row| &row.anchor_note_id)),
    )
    .await?
    {
        return Err(stale());
    }
    upsert_batch(tx, &batch.notes).await?;
    upsert_batch(tx, &batch.folders).await?;
    upsert_batch(tx, &batch.note_aliases).await?;
    upsert_batch(tx, &batch.folder_aliases).await?;
    upsert_batch(tx, &batch.descriptors).await?;
    upsert_batch(tx, &batch.ranks).await?;
    upsert_batch(tx, &batch.candidates).await?;
    upsert_batch(tx, &batch.links).await?;
    upsert_batch(tx, &batch.chat_threads).await?;
    upsert_batch(tx, &batch.clusters).await?;
    Ok(())
}

async fn apply_mutations(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    mutations: &[DerivedMutation],
) -> Result<(), PortError> {
    let space = &next.scope.space_id;
    let seq = next.projected_seq;
    let mut cached_floor: Option<SpaceSeq> = None;
    let mut batch = MutationBatch::default();

    for mutation in mutations {
        use DerivedMutation::*;
        macro_rules! check_space {
            ($row:expr) => {
                if $row.space_id != *space {
                    return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
                }
            };
        }
        match mutation {
            UpsertNote(row) => {
                check_space!(row);
                if u64::from(row.dense_id) >= next.next_dense_id
                    || u64::from(row.dense_folder_id) >= next.next_dense_folder_id
                    || row.lifecycle == Lifecycle::Purged
                {
                    return Err(stale());
                }
                if row.doc_class == DocClass::EncryptedNote && !encrypted_payload_empty(row)? {
                    return Err(invalid_row());
                }
                batch.notes.push(row.as_ref());
            }
            UpsertFolder(row) => {
                check_space!(row);
                if u64::from(row.dense_folder_id) >= next.next_dense_folder_id {
                    return Err(stale());
                }
                batch.folders.push(row);
            }
            UpsertNoteAlias(row) => {
                check_space!(row);
                batch.note_aliases.push(row);
            }
            UpsertFolderAlias(row) => {
                check_space!(row);
                batch.folder_aliases.push(row);
            }
            UpsertViewDescriptor(row) => {
                check_space!(row);
                batch.descriptors.push(row);
            }
            UpsertViewRank(row) => {
                check_space!(row);
                batch.ranks.push(row);
            }
            UpsertCandidate(row) => {
                check_space!(row);
                batch.candidates.push(row);
            }
            UpsertLink(row) => {
                check_space!(row);
                batch.links.push(row);
            }
            UpsertChatThread(row) => {
                check_space!(row);
                batch.chat_threads.push(row);
            }
            UpsertCluster(row) => {
                check_space!(row);
                let floor = match cached_floor {
                    Some(floor) => floor,
                    None => {
                        let floor = checkpoint_floor(tx, space).await?;
                        cached_floor = Some(floor);
                        floor
                    }
                };
                if row.updated_seq != next.graph_settled_seq || row.updated_seq < floor {
                    return Err(stale());
                }
                batch.clusters.push(row);
            }
            other => {
                flush_batch(tx, next, std::mem::take(&mut batch)).await?;
                match other {
                    UpsertChatRef(row) => {
                        if chat_reference_current(tx, row).await? {
                            upsert_chat_ref(tx, row).await?;
                        }
                    }
                    DeleteNoteCandidates(dense) => {
                        remove::<CandidateLookupKey>(
                            tx,
                            "space_id = ? AND target_dense_id = ?",
                            vec![value(space), value(dense)],
                        )
                        .await?;
                    }
                    DeleteNoteLinks(dense) => {
                        remove::<ProjectedLink>(
                            tx,
                            "space_id = ? AND src_dense_id = ?",
                            vec![value(space), value(dense)],
                        )
                        .await?;
                    }
                    DeleteLink(dense, ordinal) => {
                        remove::<ProjectedLink>(
                            tx,
                            "space_id = ? AND src_dense_id = ? AND link_ord = ?",
                            vec![value(space), value(dense), value(ordinal)],
                        )
                        .await?;
                    }
                    DeleteDescriptors(note) => {
                        remove::<ProjectedViewDescriptor>(
                            tx,
                            "space_id = ? AND view_note_id = ?",
                            vec![value(space), value(note)],
                        )
                        .await?;
                    }
                    DeleteRank(view, key, target) => {
                        remove::<ProjectedViewRank>(
                            tx,
                            "space_id = ? AND view_note_id = ? AND view_key = ? AND target_note_id = ?",
                            vec![value(space), value(view), value(key), value(target)],
                        )
                        .await?;
                    }
                    DeleteThreadRefs(thread) => {
                        remove::<ProjectedChatRef>(
                            tx,
                            "thread_space_id = ? AND thread_id = ?",
                            vec![value(space), value(thread)],
                        )
                        .await?;
                    }
                    DeleteClusters => {
                        remove::<ProjectedCluster>(tx, "space_id = ?", vec![value(space)]).await?;
                    }
                    PurgeNote(note) => {
                        raise_checkpoint_floor(tx, &next.scope, seq).await?;
                        cached_floor = None;
                        purge_note(tx, &next.scope, note, seq).await?;
                    }
                    RedactChatEntry(thread, entry) => {
                        redact_entry(tx, &next.scope, thread, *entry).await?;
                    }
                    UpsertNote(_)
                    | UpsertFolder(_)
                    | UpsertNoteAlias(_)
                    | UpsertFolderAlias(_)
                    | UpsertViewDescriptor(_)
                    | UpsertViewRank(_)
                    | UpsertCandidate(_)
                    | UpsertLink(_)
                    | UpsertChatThread(_)
                    | UpsertCluster(_) => unreachable!(),
                }
            }
        }
    }
    flush_batch(tx, next, batch).await
}

async fn select_key<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    row: &R,
) -> Result<Option<R>, PortError> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        R::columns(),
        R::TABLE,
        key_filter::<R>()
    );
    Ok(tx.records(&sql, row.key()).await?.pop())
}

async fn upsert<R: SqlRecord>(tx: &mut SqlTransaction<'_>, row: &R) -> Result<(), PortError> {
    write_upsert_rows(tx, &[row], true).await
}

async fn upsert_batch<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    rows: &[&R],
) -> Result<(), PortError> {
    if rows.is_empty() {
        return Ok(());
    }
    if rows.len() == 1 {
        return write_upsert_rows(tx, rows, true).await;
    }
    let max_rows = (MAX_MULTI_ROW_PARAMS / R::COLUMNS.len().max(1)).clamp(1, MAX_BATCH_ROWS);
    let mut seen = HashSet::with_capacity(rows.len().min(max_rows));
    let mut first = 0;
    for (index, row) in rows.iter().enumerate() {
        let key = row.key();
        if index - first >= max_rows || seen.contains(&key) {
            let chunk = &rows[first..index];
            write_upsert_rows(tx, chunk, chunk.len() == 1 || chunk.len() == max_rows).await?;
            first = index;
            seen.clear();
        }
        seen.insert(key);
    }
    if first < rows.len() {
        let chunk = &rows[first..];
        write_upsert_rows(tx, chunk, chunk.len() == 1 || chunk.len() == max_rows).await?;
    }
    Ok(())
}

async fn write_upsert_rows<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    rows: &[&R],
    cached: bool,
) -> Result<(), PortError> {
    if rows.is_empty() {
        return Ok(());
    }
    let arity = R::COLUMNS.len();
    let mut args = Vec::with_capacity(rows.len() * arity);
    for row in rows {
        args.extend(row.values());
    }
    let columns = R::columns();
    let changed = R::COLUMNS
        .iter()
        .filter(|column| !R::KEY.contains(&column.name))
        .map(|column| format!("{} = excluded.{}", column.name, column.name))
        .collect::<Vec<_>>();
    let table = R::TABLE;
    let tuple = format!("({})", placeholders(arity));
    let values = vec![tuple.as_str(); rows.len()].join(", ");
    let key = R::KEY.join(", ");
    let sql = if changed.is_empty() {
        format!("INSERT INTO {table} ({columns}) VALUES {values} ON CONFLICT ({key}) DO NOTHING")
    } else {
        let set = changed.join(", ");
        format!(
            "INSERT INTO {table} ({columns}) VALUES {values} ON CONFLICT ({key}) DO UPDATE SET {set}"
        )
    };
    if cached {
        tx.execute(&sql, args).await?;
    } else {
        tx.execute_uncached(&sql, args).await?;
    }
    Ok(())
}

async fn upsert_chat_ref(
    tx: &mut SqlTransaction<'_>,
    row: &ProjectedChatRef,
) -> Result<(), PortError> {
    let key = "target_space_id, target_note_id, thread_space_id, thread_id, entry_seq";
    let table = ProjectedChatRef::TABLE;
    let columns = ProjectedChatRef::columns();
    let args = row.values();
    let values = placeholders(args.len());
    tx.execute(
        &format!(
            "INSERT INTO {table} ({columns}) VALUES ({values})
             ON CONFLICT ({key}) DO UPDATE SET
                source_incarnation = excluded.source_incarnation, target_incarnation = excluded.target_incarnation,
                source_revision = excluded.source_revision, ref_ordinal = excluded.ref_ordinal
             WHERE excluded.source_incarnation <> chat_note_refs.source_incarnation
                OR excluded.target_incarnation <> chat_note_refs.target_incarnation
                OR excluded.source_revision <> chat_note_refs.source_revision
                OR excluded.ref_ordinal < chat_note_refs.ref_ordinal"
        ),
        args,
    )
    .await?;
    Ok(())
}

async fn remove<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    filter: &str,
    args: Vec<SqlValue>,
) -> Result<(), PortError> {
    let table = R::TABLE;
    tx.execute(&format!("DELETE FROM {table} WHERE {filter}"), args)
        .await?;
    Ok(())
}

async fn clear_space(tx: &mut SqlTransaction<'_>, space: &SpaceId) -> Result<(), PortError> {
    for table in [
        ProjectedFolder::TABLE,
        ProjectedFolderAlias::TABLE,
        ProjectedNote::TABLE,
        ProjectedViewDescriptor::TABLE,
        ProjectedViewRank::TABLE,
        CandidateLookupKey::TABLE,
        ProjectedLink::TABLE,
        ProjectedNoteAlias::TABLE,
        ProjectedChatThread::TABLE,
        ProjectedCluster::TABLE,
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE space_id = ?"),
            vec![value(space)],
        )
        .await?;
    }
    // Chat occurrences are immutable within a source history. Redaction
    // and purges erase them under the shared guards. Keeping them here also
    // preserves repairs another target performed while this seed was private.
    Ok(())
}

fn check_seed_cancellation(stop: &Cancellation) -> Result<(), PortError> {
    if stop.is_cancelled() {
        return Err(notarium_canonical::codec::cancelled_not_committed(
            "projection_seed",
            "seed admission cancelled",
        ));
    }
    Ok(())
}

fn check_apply_floor(next: &ProjectionWatermark, floor: SpaceSeq) -> Result<(), PortError> {
    if next.projected_seq < floor
        || [next.snapshot_seq, next.graph_settled_seq]
            .into_iter()
            .any(|seq| seq != SpaceSeq::ZERO && seq < floor)
    {
        return Err(stale());
    }
    Ok(())
}

async fn checkpoint_floor(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
) -> Result<SpaceSeq, PortError> {
    tx.select(
        "SELECT minimum_checkpoint_seq FROM projection_space_guard WHERE space_id = ?",
        vec![value(space)],
        &[Kind::Integer],
    )
    .await?
    .pop()
    .ok_or_else(invalid_row)
    .and_then(one::<SpaceSeq>)
}

async fn raise_checkpoint_floor(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> Result<(), PortError> {
    tx.execute(
        "UPDATE projection_space_guard SET minimum_checkpoint_seq = ?
         WHERE space_id = ? AND history_incarnation = ? AND minimum_checkpoint_seq < ?",
        vec![
            value(&through),
            value(&scope.space_id),
            value(&scope.incarnation),
            value(&through),
        ],
    )
    .await?;
    Ok(())
}

async fn exists(
    tx: &mut SqlTransaction<'_>,
    sql: &str,
    args: Vec<SqlValue>,
) -> Result<bool, PortError> {
    Ok(!tx.select(sql, args, &[Kind::Integer]).await?.is_empty())
}

async fn purge_marked(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<bool, PortError> {
    exists(
        tx,
        "SELECT CAST(1 AS BIGINT) FROM projected_purge_markers
         WHERE space_id = ? AND history_incarnation = ? AND note_id = ?",
        vec![
            value(&scope.space_id),
            value(&scope.incarnation),
            value(note),
        ],
    )
    .await
}

async fn any_purge_marked<'a>(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    notes: impl IntoIterator<Item = &'a NoteId>,
) -> Result<bool, PortError> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for note in notes {
        if seen.insert(note) {
            unique.push(note);
        }
    }
    if unique.is_empty() {
        return Ok(false);
    }
    for chunk in unique.chunks(500) {
        let mut args = vec![value(&scope.space_id), value(&scope.incarnation)];
        args.extend(chunk.iter().copied().map(value));
        let ids = placeholders(chunk.len());
        if exists(
            tx,
            &format!(
                "SELECT CAST(1 AS BIGINT) FROM projected_purge_markers
                 WHERE space_id = ? AND history_incarnation = ? AND note_id IN ({ids}) LIMIT 1"
            ),
            args,
        )
        .await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn chat_reference_current(
    tx: &mut SqlTransaction<'_>,
    row: &ProjectedChatRef,
) -> Result<bool, PortError> {
    let target_scope = HistoryScope {
        space_id: row.target_space_id.clone(),
        incarnation: row.target_incarnation,
    };
    if purge_marked(tx, &target_scope, &row.target_note_id).await? {
        return Ok(false);
    }
    let redacted = exists(
        tx,
        "SELECT CAST(1 AS BIGINT) FROM projected_redaction_markers
            WHERE space_id = ? AND history_incarnation = ? AND thread_id = ? AND entry_seq = ?",
        vec![
            value(&row.thread_space_id),
            value(&row.source_incarnation),
            value(&row.thread_id),
            value(&row.entry_seq),
        ],
    )
    .await?;
    Ok(!redacted)
}

pub(super) async fn erase_committed(
    tx: &mut SqlTransaction<'_>,
    erasures: &ProjectionErasures,
) -> Result<(HistoryScope, SpaceSeq), PortError> {
    // An erasure or cross-Space staging can register the guard before the
    // first watermark. Choose the history under the same lock as deletion.
    let (guard, _) = lock_space_guard_with_origin(tx, &erasures.scope).await?;
    let scope = HistoryScope {
        space_id: erasures.scope.space_id.clone(),
        incarnation: guard.incarnation,
    };
    let through = if scope == erasures.scope {
        erasures.through
    } else {
        SpaceSeq::MAX
    };
    let redacted = erasures
        .redacted
        .iter()
        .map(|row| (row.thread.clone(), row.entry))
        .collect::<Vec<_>>();
    erase_guarded(tx, &scope, through, &erasures.purged, &redacted).await?;
    Ok((scope, through))
}

async fn erase_guarded(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    through: SpaceSeq,
    purged: &[NoteId],
    redacted: &[(ChatThreadId, ThreadEntrySeq)],
) -> Result<(), PortError> {
    let mut sorted_purged = purged.to_vec();
    sorted_purged.sort_unstable();
    sorted_purged.dedup();
    let mut sorted_redacted = redacted.to_vec();
    sorted_redacted.sort_unstable();
    sorted_redacted.dedup();

    if !sorted_purged.is_empty() {
        raise_checkpoint_floor(tx, scope, through).await?;
        replay::prune_before(tx, scope, through).await?;
    }
    // Canonical lock order across all items in this transaction:
    //   1) projected_purge_markers -> projected_redaction_markers
    //   2) projection_apply_pages (own + incoming + redacted)
    //   3) chat_note_refs + remaining per-note row cleanup
    for note in &sorted_purged {
        insert_purge_marker(tx, scope, note).await?;
    }
    for (thread, entry) in &sorted_redacted {
        insert_redaction_marker(tx, scope, thread, *entry).await?;
    }
    if !sorted_purged.is_empty() {
        tx.execute(
            "DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?
                    AND first_seq < ?",
            vec![
                value(&scope.space_id),
                value(&scope.incarnation),
                value(&through),
            ],
        )
        .await?;
    }
    for note in &sorted_purged {
        discard_incoming_staging(tx, &scope.space_id, Some((scope.incarnation, note))).await?;
    }
    for (thread, entry) in &sorted_redacted {
        discard_redacted_staging(tx, scope, thread, *entry).await?;
    }
    for note in &sorted_purged {
        delete_target_chat_refs(tx, scope, note).await?;
        purge_note_rows(tx, scope, note, through).await?;
    }
    for (thread, entry) in &sorted_redacted {
        delete_redacted_chat_refs(tx, scope, thread, *entry).await?;
    }
    if let Some(current) = watermark(tx, &scope.space_id).await? {
        if current.history_incarnation != scope.incarnation {
            return Err(mismatch());
        }
        if !sorted_purged.is_empty() {
            tx.execute(
                "UPDATE space_projection_watermarks SET
                    snapshot_seq = CASE WHEN snapshot_seq < ? THEN 0 ELSE snapshot_seq END,
                    graph_settled_seq = CASE WHEN graph_settled_seq < ? THEN 0 ELSE graph_settled_seq END
                 WHERE space_id = ? AND history_incarnation = ?",
                vec![
                    value(&through),
                    value(&through),
                    value(&scope.space_id),
                    value(&scope.incarnation),
                ],
            )
            .await?;
        }
    }
    Ok(())
}

async fn insert_purge_marker(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<(), PortError> {
    tx.execute(
        "INSERT INTO projected_purge_markers (space_id, history_incarnation, note_id) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING",
        vec![value(&scope.space_id), value(&scope.incarnation), value(note)],
    )
    .await?;
    Ok(())
}

async fn delete_target_chat_refs(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM chat_note_refs WHERE target_space_id = ? AND target_incarnation = ? AND target_note_id = ?",
        vec![value(&scope.space_id), value(&scope.incarnation), value(note)],
    )
    .await?;
    Ok(())
}

async fn purge_target(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<(), PortError> {
    // Canonical lock order: markers -> projection_apply_pages -> chat_note_refs.
    insert_purge_marker(tx, scope, note).await?;
    discard_incoming_staging(tx, &scope.space_id, Some((scope.incarnation, note))).await?;
    delete_target_chat_refs(tx, scope, note).await?;
    Ok(())
}

async fn discard_incoming_staging(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
    identity: Option<(HistoryIncarnation, &NoteId)>,
) -> Result<(), PortError> {
    let mut args = vec![value(space)];
    let targeting = if let Some((incarnation, note)) = identity {
        args.extend([value(&incarnation), value(note)]);
        " AND target_incarnation = ? AND target_note_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "DELETE FROM projection_apply_pages
         WHERE (space_id, history_incarnation, first_seq, last_seq, page_no) IN (
             SELECT space_id, history_incarnation, first_seq, last_seq, page_no
             FROM projection_apply_chat_refs
             WHERE target_space_id = ?{targeting}
         )"
    );
    tx.execute(&sql, args).await?;
    Ok(())
}

fn redaction_args(
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Vec<SqlValue> {
    vec![
        value(&scope.space_id),
        value(&scope.incarnation),
        value(thread),
        value(&entry),
    ]
}

async fn insert_redaction_marker(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<(), PortError> {
    tx.execute(
        "INSERT INTO projected_redaction_markers (space_id, history_incarnation, thread_id, entry_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING",
        redaction_args(scope, thread, entry),
    )
    .await?;
    Ok(())
}

async fn discard_redacted_staging(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM projection_apply_pages
         WHERE (space_id, history_incarnation, first_seq, last_seq, page_no) IN (
             SELECT space_id, history_incarnation, first_seq, last_seq, page_no
             FROM projection_apply_chat_refs
             WHERE space_id = ? AND history_incarnation = ? AND thread_id = ? AND entry_seq = ?
         )",
        redaction_args(scope, thread, entry),
    )
    .await?;
    Ok(())
}

async fn delete_redacted_chat_refs(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<(), PortError> {
    tx.execute(
        "DELETE FROM chat_note_refs WHERE thread_space_id = ? AND source_incarnation = ?
            AND thread_id = ? AND entry_seq = ?",
        redaction_args(scope, thread, entry),
    )
    .await?;
    Ok(())
}

async fn redact_entry(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<(), PortError> {
    // Canonical lock order: markers -> projection_apply_pages -> chat_note_refs.
    insert_redaction_marker(tx, scope, thread, entry).await?;
    discard_redacted_staging(tx, scope, thread, entry).await?;
    delete_redacted_chat_refs(tx, scope, thread, entry).await?;
    Ok(())
}

async fn purge_note(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    through: SpaceSeq,
) -> Result<(), PortError> {
    purge_target(tx, scope, note).await?;
    purge_note_rows(tx, scope, note, through).await
}

async fn purge_note_rows(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    through: SpaceSeq,
) -> Result<(), PortError> {
    let space = &scope.space_id;
    let args = vec![value(space), value(note)];
    let dense = tx
        .select(
            "SELECT dense_id FROM projected_notes WHERE space_id = ? AND note_id = ?",
            args.clone(),
            &[Kind::Integer],
        )
        .await?;
    for id in dense {
        let id = one::<u32>(id)?;
        tx.execute(
            "DELETE FROM projected_note_links WHERE space_id = ? AND src_dense_id = ?",
            vec![value(space), value(&id)],
        )
        .await?;
        tx.execute(
            "UPDATE projected_note_links SET resolved_dense_id = NULL, resolved_tier = NULL
             WHERE space_id = ? AND resolved_dense_id = ?",
            vec![value(space), value(&id)],
        )
        .await?;
        tx.execute(
            "DELETE FROM candidate_lookup_keys WHERE space_id = ? AND target_dense_id = ?",
            vec![value(space), value(&id)],
        )
        .await?;
    }
    tx.execute(
        "DELETE FROM projected_notes WHERE space_id = ? AND note_id = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "DELETE FROM projected_note_aliases WHERE space_id = ? AND target_note_id = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "DELETE FROM projected_view_descriptors WHERE space_id = ? AND view_note_id = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "DELETE FROM projected_view_ranks WHERE space_id = ? AND view_note_id = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "DELETE FROM projected_view_ranks WHERE space_id = ? AND target_note_id = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "UPDATE projected_folders SET cover_note_id = NULL WHERE space_id = ? AND cover_note_id = ?",
        args,
    )
    .await?;
    tx.execute(
        "DELETE FROM graph_clusters WHERE space_id = ? AND updated_seq < ?",
        vec![value(space), value(&through)],
    )
    .await?;
    tx.execute(
        "DELETE FROM projection_checkpoints WHERE space_id = ? AND seq < ?",
        vec![value(space), value(&through)],
    )
    .await?;
    Ok(())
}
