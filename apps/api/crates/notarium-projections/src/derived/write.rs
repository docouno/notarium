use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

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
    DerivedMutation, DerivedStore, ProjectionWatermark, SpaceApply, StageKey, internal,
    invalid_row, mismatch,
    read::{assert_cut, watermark},
    records::*,
    replay,
    schema::{SpaceGuard, lock_space_guard_with_origin, now_ms, read_space_guard},
    sql::{Kind, SqlColumn, SqlRecord, SqlTransaction, SqlValue, key_filter, placeholders, value},
    staging::{MAX_STAGE_BYTES, StageBuffer, StagePage, fragment_witness, invalid_limit},
    stale,
};

const MAX_CUT_RETENTION: Duration = Duration::from_secs(120);
const MAX_RETAINED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LEASES_PER_SPACE: u64 = 512;
const MAX_DENSE_CAPACITY: u64 = u32::MAX as u64 + 1;

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
        self.database.write(true, move |mut tx| Box::pin(async move {
            let (guard, inserted) = lock_space_guard_with_origin(&mut tx, &initial.scope).await?;
            check_seed_cancellation(&stop)?;
            let existing = watermark(&mut tx, &initial.scope.space_id).await?;
            if (!inserted).then_some(&guard) != observed.guard.as_ref() || existing != observed.watermark {
                return Err(stale());
            }
            let changed_history = guard.incarnation != initial.scope.incarnation;
            let repair_incoming = changed_history || existing.as_ref().is_some_and(|row| row.seed_in_progress);
            if !changed_history
                && (initial.projected_seq < guard.minimum_checkpoint_seq
                    || existing.as_ref().is_some_and(|row| initial.projected_seq < row.projected_seq))
            {
                return Err(stale());
            }
            if changed_history {
                tx.execute(
                    "UPDATE projection_space_guard SET history_incarnation = ?, minimum_checkpoint_seq = 0 WHERE space_id = ?",
                    vec![value(&initial.scope.incarnation), value(&initial.scope.space_id)],
                ).await?;
                for table in ["projected_purge_markers", "projected_redaction_markers"] {
                    tx.execute(&format!("DELETE FROM {table} WHERE space_id = ?"),
                        vec![value(&initial.scope.space_id)]).await?;
                }
                discard_incoming_staging(&mut tx, &initial.scope.space_id, None).await?;
                tx.execute("DELETE FROM chat_note_refs WHERE target_space_id = ?",
                    vec![value(&initial.scope.space_id)]).await?;
                tx.execute("DELETE FROM chat_note_refs WHERE thread_space_id = ?",
                    vec![value(&initial.scope.space_id)]).await?;
                tx.execute("DELETE FROM projection_checkpoints WHERE space_id = ?",
                    vec![value(&initial.scope.space_id)]).await?;
            }

            replay::clear(&mut tx, &initial.scope.space_id).await?;
            // The previous cards stay private until the replacement commits.
            // Their IDs are still available to seed builders that use dense_for_seed.
            tx.execute("DELETE FROM projection_apply_pages WHERE space_id = ?",
                vec![value(&initial.scope.space_id)]).await?;
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
            if let Some(existing) = existing.filter(|row| {
                row.history_incarnation == seeding.scope.incarnation
            }) {
                seeding.next_dense_id = seeding.next_dense_id.max(existing.next_dense_id);
                seeding.next_dense_folder_id = seeding.next_dense_folder_id.max(existing.next_dense_folder_id);
            }
            validate_watermark(&seeding)?;
            upsert(&mut tx, &WatermarkRecord::from_watermark(&seeding, SpaceSeq::ZERO), SpaceSeq::ZERO).await?;
            check_seed_cancellation(&stop)?;
            Ok(repair_incoming)
        })).await
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
            validate_locator(row)?;
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
                    let row = tx.select(
                "SELECT dense_id FROM projected_notes WHERE space_id = ? AND note_id = ?",
                vec![value(&scope.space_id), value(&note)],
                &[Kind::Integer],
            ).await?.pop();
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
        self.database.read(move |mut tx| Box::pin(async move {
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
            ).await?.pop().map(one::<u32>).transpose()
        })).await
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
        let change = change.clone();
        let scrub = needs_scrub(&change.mutations);
        let admission = Arc::clone(&self.page_admission);
        self.database
            .write(scrub, move |mut tx| {
                Box::pin(async move {
                    let scopes = mutation_scopes(&change.watermark.scope, &change.mutations)?;
                    let floor = lock_scopes(&mut tx, &change.watermark.scope, scopes).await?;
                    check_apply_floor(&change.watermark, floor)?;
                    let current = watermark(&mut tx, &change.watermark.scope.space_id).await?;
                    if already_applied(current.as_ref(), change.expected, &change.watermark)? {
                        return Ok(());
                    }
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
                    let floor =
                        prepare_apply(&mut tx, current.as_ref(), &change.watermark, scrub).await?;
                    apply_mutations(&mut tx, &change.watermark, &change.mutations).await?;
                    if scrub {
                        check_apply_floor(
                            &change.watermark,
                            checkpoint_floor(&mut tx, &change.watermark.scope.space_id).await?,
                        )?;
                    }
                    finish_apply(&mut tx, &change.watermark, floor, &admission).await?;
                    if current
                        .as_ref()
                        .is_none_or(|row| row.projected_seq != change.watermark.projected_seq)
                    {
                        // Direct writes do not have the runtime's exact touched slots.
                        replay::publish(&mut tx, &change.watermark, change.expected, None).await?;
                    }
                    Ok(())
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
        self.persist_staging_page(key, page_no, page.finish()).await
    }

    pub(crate) async fn stage_single(
        &self,
        key: &StageKey,
        page_no: u64,
        mutation: &DerivedMutation,
    ) -> Result<(), PortError> {
        let page = StagePage::large(key, mutation)?;
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
        let StagePage {
            payload,
            fragments,
            checks,
        } = page;
        let mut dependencies =
            BTreeMap::from([(key.scope.space_id.clone(), key.scope.incarnation)]);
        for row in &checks.references {
            add_chat_ref_scope(&mut dependencies, &key.scope, row)?;
        }
        self.database.write(false, move |mut tx| Box::pin(async move {
            let floor = lock_scopes(&mut tx, &key.scope, dependencies).await?;
            if key.last < floor {
                return Err(stale());
            }
            if tx.postgres() {
                if any_purge_marked(&mut tx, &key.scope, &checks.notes).await? {
                    return Err(stale());
                }
            } else {
                for note in checks.notes {
                    if purge_marked(&mut tx, &key.scope, &note).await? {
                        return Err(stale());
                    }
                }
            }
            let mut args = stage_values(&key);
            args.extend([value(&page_no), value(&checks.destructive), value(&payload)]);
            let inserted = tx.execute(
                "INSERT INTO projection_apply_pages (space_id, history_incarnation, first_seq, last_seq, page_no, destructive, payload)
                 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                args,
            ).await?;
            if inserted == 0 {
                let recorded = get_staging_page(&mut tx, &key, page_no).await?
                    .ok_or_else(stale)?;
                if recorded != payload {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                return Ok(());
            }
            for (ordinal, fragment) in fragments.into_iter().enumerate() {
                let ordinal = u64::try_from(ordinal).map_err(|_| invalid_row())?;
                let mut values = stage_values(&key);
                values.extend([value(&page_no), value(&ordinal), SqlValue::Bytes(Some(fragment))]);
                tx.execute(
                    "INSERT INTO projection_apply_page_fragments
                        (space_id, history_incarnation, first_seq, last_seq, page_no, fragment_no, payload)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    values,
                ).await?;
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
                ).await?;
            }
            Ok(())
        })).await
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
        let admission = Arc::clone(&self.page_admission);
        self.database.write_adaptive( move |mut tx| Box::pin(async move {
            let dep_sql = "SELECT DISTINCT target_space_id, target_incarnation
                   FROM projection_apply_chat_refs WHERE space_id = ? AND history_incarnation = ?
                    AND first_seq = ? AND last_seq = ? ORDER BY target_space_id, target_incarnation";
            let args = stage_values(&key);
            let kinds = [Kind::Text, Kind::Bytes];
            let deps = tx.select(dep_sql, args.clone(), &kinds).await?;
            let mut scopes = BTreeMap::from([(key.scope.space_id.clone(), key.scope.incarnation)]);
            for mut row in deps.clone() {
                let incarnation = HistoryIncarnation::read(row.pop().ok_or_else(invalid_row)?)?;
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

            // Check availability before changing live state, then consume at
            // most one page or oversized mutation at a time inside the final transaction.
            let mut witness = tx.select(
                "SELECT COUNT(*), CAST(COALESCE(MAX(destructive), 0) AS BIGINT)
                   FROM projection_apply_pages
                  WHERE space_id = ? AND history_incarnation = ? AND first_seq = ? AND last_seq = ?",
                stage_values(&key),
                &[Kind::Integer, Kind::Integer],
            ).await?.pop().ok_or_else(invalid_row)?;
            let destructive = bool::read(witness.pop().ok_or_else(invalid_row)?)?;
            if one::<u64>(witness)? != page_count {
                return Err(stale());
            }
            let seed = tx.postgres() && current.as_ref().is_some_and(|row| row.seed_in_progress);
            let floor = prepare_apply(&mut tx, current.as_ref(), &next, destructive).await?;
            for page in 0..page_count {
                let encoded = load_staging_payload(&mut tx, &key, page).await?;
                let mutations: Vec<DerivedMutation> = decode(&encoded)?;
                drop(encoded);
                if seed {
                    apply_seed_page(&mut tx, &next, &mutations).await?;
                } else {
                    apply_mutations(&mut tx, &next, &mutations).await?;
                }
            }
            tx.execute(
                "DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?
                 AND first_seq = ? AND last_seq = ?",
                stage_values(&key),
            ).await?;
            if destructive {
                check_apply_floor(&next, checkpoint_floor(&mut tx, &key.scope.space_id).await?)?;
            }
            finish_apply(&mut tx, &next, floor, &admission).await?;
            let slots = if destructive { None } else { slots };
            replay::publish(&mut tx, &next, expected, slots).await?;
            Ok(((), destructive || current.is_some_and(|row| row.seed_in_progress)))
        })).await
    }

    pub async fn discard_staging(&self, scope: &HistoryScope) -> Result<(), PortError> {
        let scope = scope.clone();
        self.database.write(true, move |mut tx| Box::pin(async move {
            check_guard(&mut tx, &scope).await?;
            tx.execute("DELETE FROM projection_apply_pages WHERE space_id = ? AND history_incarnation = ?",
                vec![value(&scope.space_id), value(&scope.incarnation)]).await?;
            tx.execute("DELETE FROM projection_link_scratch WHERE space_id = ? AND history_incarnation = ?",
                vec![value(&scope.space_id), value(&scope.incarnation)]).await?;
            Ok(())
        })).await
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
                    upsert(&mut tx, &checkpoint, SpaceSeq::ZERO).await
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

    /// Compare the unpublished head under the Space writer guard before
    /// reclaiming a local file or forgetting this cache's writer record.
    pub(crate) async fn reclaim_unpublished_checkpoint(
        &self,
        observed: &ProjectionWatermark,
        format_version: u32,
        platform_abi: String,
        publication_id: String,
        reclaim_file: impl FnOnce() -> Result<bool, PortError> + Send + 'static,
    ) -> Result<bool, PortError> {
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
                    if !reclaim_file()? {
                        return Ok(false);
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
                    Ok(true)
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
        let entries = entries.to_vec();
        self.database
            .write(true, move |mut tx| {
                Box::pin(async move {
                    check_guard(&mut tx, &scope).await?;
                    for (thread, entry) in entries {
                        redact_entry(&mut tx, &scope, &thread, entry).await?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub async fn retain_cut(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        ttl: Duration,
    ) -> Result<CutLease, PortError> {
        let lease = LeaseRegistration::new(LeaseKind::Cursor, ttl.min(MAX_CUT_RETENTION))?;
        let mut leases = self.register_leases(scope, cut, vec![lease], None).await?;
        Ok(CutLease(leases.pop().ok_or_else(invalid_row)?))
    }

    /// Pin the first page and establish the ordinary cursor lease in the same
    /// transaction which witnesses this cut under the writer/GC guard.
    pub(crate) async fn pin_open(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        retention: Duration,
        budget: Duration,
    ) -> Result<(CutLease, PagePin), PortError> {
        let (pin, deadline) = page_registration(budget)?;
        let lease = LeaseRegistration::new(LeaseKind::Cursor, retention.min(MAX_CUT_RETENTION))?;
        let mut leases = self
            .register_leases(scope, cut, vec![lease, pin], None)
            .await?;
        let pin = PagePin {
            _lease: leases.pop().ok_or_else(invalid_row)?,
            deadline,
        };
        Ok((CutLease(leases.pop().ok_or_else(invalid_row)?), pin))
    }

    /// Protect a single current hydration without leaving a resumable cursor.
    pub(crate) async fn pin_cut(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        budget: Duration,
    ) -> Result<PagePin, PortError> {
        let (pin, deadline) = page_registration(budget)?;
        let mut leases = self.register_leases(scope, cut, vec![pin], None).await?;
        Ok(PagePin {
            _lease: leases.pop().ok_or_else(invalid_row)?,
            deadline,
        })
    }

    async fn register_leases(
        &self,
        scope: &HistoryScope,
        cut: SpaceSeq,
        registrations: Vec<LeaseRegistration>,
        cursor: Option<[u8; 16]>,
    ) -> Result<Vec<RegisteredLease>, PortError> {
        let scope = scope.clone();
        let store = self.clone();
        self.database.write(false, move |mut tx| Box::pin(async move {
            check_guard(&mut tx, &scope).await?;
            let row = watermark(&mut tx, &scope.space_id).await?.ok_or_else(stale)?;
            assert_cut(&row, &scope, cut)?;
            if let Some(id) = cursor {
                check_cursor(&mut tx, &scope, cut, id).await?;
            }
            if registrations.iter().any(|lease| lease.kind == LeaseKind::Page) {
                store.page_admission.check(&scope, row.projected_seq)?;
            }
            let now = now_ms();
            for lease in &registrations {
                if lease.expires_at_ms <= now {
                    return Err(if lease.kind == LeaseKind::Page { page_deadline() } else { stale() });
                }
                let count = tx.select(
                    &format!(
                        "SELECT COUNT(*) FROM {} WHERE space_id = ?
                           AND history_incarnation = ? AND expires_at_ms > ?",
                        lease.kind.table(),
                    ),
                    vec![value(&scope.space_id), value(&scope.incarnation), value(&now)],
                    &[Kind::Integer],
                ).await?.pop().ok_or_else(invalid_row).and_then(one::<u64>)?;
                if count >= MAX_LEASES_PER_SPACE {
                    return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
                }
                tx.execute(
                    &format!(
                        "INSERT INTO {} (space_id, history_incarnation, lease_id, cut, expires_at_ms)
                         VALUES (?, ?, ?, ?, ?)",
                        lease.kind.table(),
                    ),
                    vec![value(&scope.space_id), value(&scope.incarnation), value(&lease.id.to_vec()),
                        value(&cut), value(&lease.expires_at_ms)],
                ).await?;
            }
            Ok(registrations.into_iter().map(|data| RegisteredLease {
                store: store.clone(), scope: scope.clone(), cut, data,
            }).collect())
        })).await
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LeaseKind {
    Cursor,
    Page,
}

impl LeaseKind {
    const fn table(self) -> &'static str {
        match self {
            Self::Cursor => "projection_cut_leases",
            Self::Page => "projection_page_pins",
        }
    }
}

struct LeaseRegistration {
    kind: LeaseKind,
    id: [u8; 16],
    expires_at_ms: i64,
}

impl LeaseRegistration {
    fn new(kind: LeaseKind, ttl: Duration) -> Result<Self, PortError> {
        let millis = ttl.as_millis() as i64;
        if millis == 0 {
            return Err(if kind == LeaseKind::Page {
                page_deadline()
            } else {
                stale()
            });
        }
        let mut id = [0; 16];
        getrandom::fill(&mut id).map_err(|_| internal("projection_lease_entropy"))?;
        Ok(Self {
            kind,
            id,
            expires_at_ms: now_ms().saturating_add(millis),
        })
    }
}

const MAX_PAGE_PIN: Duration = Duration::from_secs(5);
// A caller on an intentionally idle runtime can reopen admission after all
// protected pins and one normal worker retry interval were able to drain.
const PAGE_PRESSURE_IDLE: Duration = MAX_PAGE_PIN.saturating_add(Duration::from_secs(3));

/// Admission belongs to the active runtime for this Space. Durable pin rows
/// also protect bounded pages that were admitted before an owner handoff.
#[derive(Default)]
pub(super) struct PageAdmission(Mutex<BTreeMap<HistoryScope, (SpaceSeq, Instant)>>);

impl PageAdmission {
    fn block(&self, scope: &HistoryScope, promotion: SpaceSeq) -> PortError {
        let now = Instant::now();
        let mut blocked = self.0.lock().unwrap_or_else(|error| error.into_inner());
        blocked.retain(|_, (_, expires)| *expires > now);
        blocked.insert(scope.clone(), (promotion, now + PAGE_PRESSURE_IDLE));
        retention_pressure()
    }

    fn check(&self, scope: &HistoryScope, durable: SpaceSeq) -> Result<(), PortError> {
        let now = Instant::now();
        let mut blocked = self.0.lock().unwrap_or_else(|error| error.into_inner());
        match blocked.get(scope) {
            Some((promotion, expires)) if durable < *promotion && *expires > now => {
                Err(retention_pressure())
            }
            Some(_) => {
                blocked.remove(scope);
                Ok(())
            }
            None => Ok(()),
        }
    }
}

fn retention_pressure() -> PortError {
    notarium_canonical::codec::unavailable_retryable(
        "projection_retention_pressure",
        "in-flight page holds the oldest retained projection cut",
        Duration::from_millis(10),
    )
}

fn page_registration(budget: Duration) -> Result<(LeaseRegistration, Instant), PortError> {
    let ttl = budget.min(MAX_PAGE_PIN);
    let deadline = Instant::now() + ttl;
    Ok((LeaseRegistration::new(LeaseKind::Page, ttl)?, deadline))
}

fn page_deadline() -> PortError {
    notarium_canonical::codec::deadline_not_committed("projection_page", "page deadline exhausted")
}

async fn check_cursor(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    cut: SpaceSeq,
    id: [u8; 16],
) -> Result<(), PortError> {
    if !exists(
        tx,
        "SELECT CAST(1 AS BIGINT) FROM projection_cut_leases
          WHERE space_id = ? AND history_incarnation = ? AND lease_id = ?
            AND cut = ? AND expires_at_ms > ?",
        vec![
            value(&scope.space_id),
            value(&scope.incarnation),
            value(&id.to_vec()),
            value(&cut),
            value(&now_ms()),
        ],
    )
    .await?
    {
        return Err(stale());
    }
    Ok(())
}

struct RegisteredLease {
    store: DerivedStore,
    scope: HistoryScope,
    cut: SpaceSeq,
    data: LeaseRegistration,
}

/// A cursor's temporal versions are eligible for expiry and eviction.
pub struct CutLease(RegisteredLease);

impl CutLease {
    pub fn cut(&self) -> SpaceSeq {
        self.0.cut
    }

    pub async fn check(&self) -> Result<(), PortError> {
        if now_ms() >= self.0.data.expires_at_ms {
            return Err(stale());
        }
        let scope = self.0.scope.clone();
        let id = self.0.data.id;
        let cut = self.0.cut;
        self.0
            .store
            .database
            .read(move |mut tx| {
                Box::pin(async move {
                    let row = watermark(&mut tx, &scope.space_id)
                        .await?
                        .ok_or_else(stale)?;
                    assert_cut(&row, &scope, cut)?;
                    check_cursor(&mut tx, &scope, cut, id).await
                })
            })
            .await
    }

    /// Continue only from an admitted, unexpired ordinary cursor.
    pub(crate) async fn pin_page(&self, budget: Duration) -> Result<PagePin, PortError> {
        let (pin, deadline) = page_registration(budget)?;
        let mut leases = self
            .0
            .store
            .register_leases(&self.0.scope, self.0.cut, vec![pin], Some(self.0.data.id))
            .await?;
        Ok(PagePin {
            _lease: leases.pop().ok_or_else(invalid_row)?,
            deadline,
        })
    }
}

/// Temporary protection from routine history pruning while a bounded request
/// owns the page. Destructive erasure still revokes old cuts.
pub(crate) struct PagePin {
    _lease: RegisteredLease,
    deadline: Instant,
}

impl PagePin {
    pub(crate) async fn run<T>(
        &self,
        task: impl std::future::Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(page_deadline());
        }
        tokio::time::timeout(remaining, task)
            .await
            .map_err(|_| page_deadline())?
    }

    pub(crate) fn check_deadline(&self) -> Result<(), PortError> {
        if Instant::now() >= self.deadline {
            return Err(page_deadline());
        }
        Ok(())
    }
}

impl Drop for RegisteredLease {
    fn drop(&mut self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let store = self.store.clone();
        let scope = self.scope.clone();
        let table = self.data.kind.table();
        let id = self.data.id.to_vec();
        handle.spawn(async move {
            let _ = store
                .database
                .write(false, move |mut tx| {
                    Box::pin(async move {
                        tx.execute(
                            &format!(
                                "DELETE FROM {table}
                             WHERE space_id = ? AND history_incarnation = ? AND lease_id = ?"
                            ),
                            vec![
                                value(&scope.space_id),
                                value(&scope.incarnation),
                                value(&id),
                            ],
                        )
                        .await?;
                        Ok(())
                    })
                })
                .await;
        });
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

async fn load_staging_payload(
    tx: &mut SqlTransaction<'_>,
    key: &StageKey,
    page: u64,
) -> Result<Vec<u8>, PortError> {
    let stored = get_staging_page(tx, key, page).await?.ok_or_else(stale)?;
    let Some((length, digest)) = fragment_witness(&stored)? else {
        return Ok(stored);
    };
    let mut params = stage_values(key);
    params.push(value(&page));
    let fragments = length.div_ceil(MAX_STAGE_BYTES);
    let sizes = tx
        .select(
            "SELECT COUNT(*), CAST(COALESCE(SUM(length(payload)), 0) AS BIGINT)
           FROM projection_apply_page_fragments
          WHERE space_id = ? AND history_incarnation = ? AND first_seq = ?
            AND last_seq = ? AND page_no = ?",
            params.clone(),
            &[Kind::Integer, Kind::Integer],
        )
        .await?
        .pop()
        .ok_or_else(invalid_row)?;
    let [count, bytes] = sizes.try_into().map_err(|_| invalid_row())?;
    if u64::read(count)? != fragments as u64 || u64::read(bytes)? != length as u64 {
        return Err(stale());
    }
    let mut encoded = Vec::new();
    encoded
        .try_reserve_exact(length)
        .map_err(|_| invalid_row())?;
    let mut hasher = blake3::Hasher::new();
    for ordinal in 0..fragments as u64 {
        let mut values = params.clone();
        values.push(value(&ordinal));
        let fragment = tx
            .select(
                "SELECT payload FROM projection_apply_page_fragments
              WHERE space_id = ? AND history_incarnation = ? AND first_seq = ?
                AND last_seq = ? AND page_no = ? AND fragment_no = ?",
                values,
                &[Kind::Bytes],
            )
            .await?
            .pop()
            .map(one::<Vec<u8>>)
            .transpose()?
            .ok_or_else(stale)?;
        if fragment.len() != (length - encoded.len()).min(MAX_STAGE_BYTES) {
            return Err(invalid_row());
        }
        hasher.update(&fragment);
        encoded.extend_from_slice(&fragment);
    }
    if hasher.finalize().as_bytes() != &digest {
        return Err(invalid_row());
    }
    Ok(encoded)
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

async fn prepare_apply(
    tx: &mut SqlTransaction<'_>,
    current: Option<&WatermarkRecord>,
    next: &ProjectionWatermark,
    destructive: bool,
) -> Result<SpaceSeq, PortError> {
    if current.is_some_and(|state| state.seed_in_progress) {
        clear_space(tx, &next.scope.space_id).await?;
        return Ok(next.projected_seq);
    }
    if destructive {
        for kind in [LeaseKind::Cursor, LeaseKind::Page] {
            tx.execute(
                &format!("DELETE FROM {} WHERE space_id = ?", kind.table()),
                vec![value(&next.scope.space_id)],
            )
            .await?;
        }
        return Ok(next.projected_seq);
    }
    let now = now_ms();
    for kind in [LeaseKind::Cursor, LeaseKind::Page] {
        tx.execute(
            &format!(
                "DELETE FROM {} WHERE space_id = ? AND expires_at_ms <= ?",
                kind.table()
            ),
            vec![value(&next.scope.space_id), value(&now)],
        )
        .await?;
    }
    oldest_cut(tx, &next.scope, next.projected_seq).await
}

async fn finish_apply(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    floor: SpaceSeq,
    admission: &PageAdmission,
) -> Result<(), PortError> {
    let existing: Option<SchemaRecord> = tx
        .records(
            &format!(
                "SELECT {} FROM {} WHERE space_id = ?",
                SchemaRecord::columns(),
                SchemaRecord::TABLE
            ),
            vec![value(&next.scope.space_id)],
        )
        .await?
        .pop();
    if let Some(schema) = &next.schema {
        let row = SchemaRecord {
            space_id: next.scope.space_id.clone(),
            revision: schema.revision.clone(),
            fingerprint: schema.fingerprint,
            fields_msgpack: schema.fields_msgpack.clone(),
        };
        if existing.as_ref() != Some(&row) {
            upsert(tx, &row, next.projected_seq).await?;
        }
    } else if existing.is_some() {
        remove::<SchemaRecord>(
            tx,
            "space_id = ?",
            vec![value(&next.scope.space_id)],
            next.projected_seq,
        )
        .await?;
    }
    let floor = prune_history_budget(
        tx,
        &next.scope,
        next.projected_seq,
        floor,
        MAX_RETAINED_BYTES,
        admission,
    )
    .await?;
    if next.snapshot_seq == next.projected_seq {
        replay::clear(tx, &next.scope.space_id).await?;
    }
    upsert(
        tx,
        &WatermarkRecord::from_watermark(next, floor),
        next.projected_seq,
    )
    .await
}

pub(super) async fn prune_history_budget(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    projected_seq: SpaceSeq,
    mut floor: SpaceSeq,
    maximum: u64,
    admission: &PageAdmission,
) -> Result<SpaceSeq, PortError> {
    prune_history(tx, &scope.space_id, floor).await?;
    while floor < projected_seq && history_bytes(tx, &scope.space_id).await? > maximum {
        tx.execute(
            "DELETE FROM projection_cut_leases WHERE space_id = ? AND history_incarnation = ? AND cut <= ?",
            vec![value(&scope.space_id), value(&scope.incarnation), value(&floor)],
        ).await?;
        let next_floor = oldest_cut(tx, scope, projected_seq).await?;
        if next_floor <= floor {
            // Roll back this promotion. The same durable command is applied
            // after the page completes, without breaking its temporal reads.
            return Err(admission.block(scope, projected_seq));
        }
        floor = next_floor;
        prune_history(tx, &scope.space_id, floor).await?;
    }
    Ok(floor)
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
struct SeedBatch<'a> {
    notes: Vec<&'a ProjectedNote>,
    candidates: Vec<&'a CandidateLookupKey>,
    links: Vec<&'a ProjectedLink>,
    descriptor_deletes: Vec<&'a NoteId>,
}

async fn apply_seed_page(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    mutations: &[DerivedMutation],
) -> Result<(), PortError> {
    let mut batch = SeedBatch::default();
    for mutation in mutations {
        // These tables have independent keys and no foreign keys between them.
        // Flush before operations that can observe or alter more than one batch,
        // or change which descriptors a deletion must remove.
        let space = match mutation {
            DerivedMutation::UpsertNote(row) => {
                if u64::from(row.dense_id) >= next.next_dense_id
                    || u64::from(row.dense_folder_id) >= next.next_dense_folder_id
                    || row.lifecycle == Lifecycle::Purged
                {
                    return Err(stale());
                }
                if row.doc_class == DocClass::EncryptedNote && !encrypted_payload_empty(row)? {
                    return Err(invalid_row());
                }
                batch.notes.push(row);
                &row.space_id
            }
            DerivedMutation::UpsertCandidate(row) => {
                batch.candidates.push(row);
                &row.space_id
            }
            DerivedMutation::UpsertLink(row) => {
                batch.links.push(row);
                &row.space_id
            }
            DerivedMutation::DeleteDescriptors(note) => {
                batch.descriptor_deletes.push(note);
                continue;
            }
            other => {
                flush_seed_batch(tx, next, std::mem::take(&mut batch)).await?;
                apply_mutations(tx, next, std::slice::from_ref(other)).await?;
                continue;
            }
        };
        if *space != next.scope.space_id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
        }
    }
    flush_seed_batch(tx, next, batch).await
}

async fn flush_seed_batch(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    batch: SeedBatch<'_>,
) -> Result<(), PortError> {
    if any_purge_marked(tx, &next.scope, batch.notes.iter().map(|row| &row.note_id)).await? {
        return Err(stale());
    }
    let seq = next.projected_seq;
    upsert_seed_rows(tx, &batch.notes, seq).await?;
    upsert_seed_rows(tx, &batch.candidates, seq).await?;
    upsert_seed_rows(tx, &batch.links, seq).await?;
    if !batch.descriptor_deletes.is_empty() {
        let ids = placeholders(batch.descriptor_deletes.len());
        let args = std::iter::once(value(&next.scope.space_id))
            .chain(batch.descriptor_deletes.into_iter().map(value))
            .collect();
        let table = ProjectedViewDescriptor::TABLE;
        tx.execute(
            &format!("DELETE FROM {table} WHERE space_id = ? AND view_note_id IN ({ids})"),
            args,
        )
        .await?;
    }
    Ok(())
}

async fn upsert_seed_rows<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    rows: &[&R],
    seq: SpaceSeq,
) -> Result<(), PortError> {
    // prepare_apply cleared this Space, so surviving rows inserted during
    // publication all have begin_seq == seq and produce no before-images.
    let mut seen = HashSet::with_capacity(rows.len());
    let mut first = 0;
    for (index, row) in rows.iter().enumerate() {
        let key = row.key();
        if seen.contains(&key) {
            write_upsert_rows(tx, &rows[first..index], seq).await?;
            first = index;
            seen.clear();
        }
        seen.insert(key);
    }
    if first < rows.len() {
        write_upsert_rows(tx, &rows[first..], seq).await?;
    }
    Ok(())
}

async fn apply_mutations(
    tx: &mut SqlTransaction<'_>,
    next: &ProjectionWatermark,
    mutations: &[DerivedMutation],
) -> Result<(), PortError> {
    let space = &next.scope.space_id;
    let seq = next.projected_seq;
    for mutation in mutations {
        use DerivedMutation::*;
        macro_rules! scoped {
            ($row:expr, $operation:expr) => {{
                if $row.space_id != *space {
                    return Err(DomainError::validation(ValidationReason::ScopeMismatch).into());
                }
                $operation.await?;
            }};
        }
        match mutation {
            UpsertNote(row) => {
                if u64::from(row.dense_id) >= next.next_dense_id
                    || u64::from(row.dense_folder_id) >= next.next_dense_folder_id
                    || row.lifecycle == Lifecycle::Purged
                    || purge_marked(tx, &next.scope, &row.note_id).await?
                {
                    return Err(stale());
                }
                // Encrypted rows are identity-only. Refuse content payloads at
                // this boundary even if an extractor produced them by mistake.
                if row.doc_class == DocClass::EncryptedNote && !encrypted_payload_empty(row)? {
                    return Err(invalid_row());
                }
                scoped!(row, upsert(tx, row.as_ref(), seq));
            }
            UpsertFolder(row) => {
                if u64::from(row.dense_folder_id) >= next.next_dense_folder_id {
                    return Err(stale());
                }
                scoped!(row, upsert(tx, row, seq));
            }
            UpsertNoteAlias(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertFolderAlias(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertViewDescriptor(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertViewRank(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertCandidate(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertLink(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertChatThread(row) => scoped!(row, upsert(tx, row, seq)),
            UpsertCluster(row) => {
                if row.updated_seq != next.graph_settled_seq
                    || row.updated_seq < checkpoint_floor(tx, space).await?
                    || purge_marked(tx, &next.scope, &row.anchor_note_id).await?
                {
                    return Err(stale());
                }
                scoped!(row, upsert(tx, row, seq));
            }
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
                    seq,
                )
                .await?;
            }
            DeleteNoteLinks(dense) => {
                remove::<ProjectedLink>(
                    tx,
                    "space_id = ? AND src_dense_id = ?",
                    vec![value(space), value(dense)],
                    seq,
                )
                .await?;
            }
            DeleteLink(dense, ordinal) => {
                remove::<ProjectedLink>(
                    tx,
                    "space_id = ? AND src_dense_id = ? AND link_ord = ?",
                    vec![value(space), value(dense), value(ordinal)],
                    seq,
                )
                .await?;
            }
            DeleteDescriptors(note) => {
                remove::<ProjectedViewDescriptor>(
                    tx,
                    "space_id = ? AND view_note_id = ?",
                    vec![value(space), value(note)],
                    seq,
                )
                .await?;
            }
            DeleteRank(view, key, target) => {
                remove::<ProjectedViewRank>(
                    tx,
                    "space_id = ? AND view_note_id = ? AND view_key = ? AND target_note_id = ?",
                    vec![value(space), value(view), value(key), value(target)],
                    seq,
                )
                .await?;
            }
            DeleteThreadRefs(thread) => {
                remove::<ProjectedChatRef>(
                    tx,
                    "thread_space_id = ? AND thread_id = ?",
                    vec![value(space), value(thread)],
                    seq,
                )
                .await?;
            }
            DeleteClusters => {
                remove::<ProjectedCluster>(tx, "space_id = ?", vec![value(space)], seq).await?;
            }
            PurgeNote(note) => {
                raise_checkpoint_floor(tx, &next.scope, seq).await?;
                purge_note(tx, &next.scope, note, seq).await?;
            }
            RedactChatEntry(thread, entry) => redact_entry(tx, &next.scope, thread, *entry).await?,
        }
    }
    Ok(())
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

async fn upsert<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    row: &R,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    if R::TEMPORAL {
        preserve::<R>(tx, &key_filter::<R>(), row.key(), seq).await?;
    }
    write_upsert_rows(tx, &[row], seq).await
}

async fn write_upsert_rows<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    rows: &[&R],
    seq: SpaceSeq,
) -> Result<(), PortError> {
    let arity = R::COLUMNS.len() + usize::from(R::TEMPORAL);
    let mut args = Vec::with_capacity(rows.len() * arity);
    for row in rows {
        args.extend(row.values());
        if R::TEMPORAL {
            args.push(value(&seq));
        }
    }
    let mut columns = R::columns();
    let mut changed = R::COLUMNS
        .iter()
        .filter(|column| !R::KEY.contains(&column.name))
        .map(|column| format!("{} = excluded.{}", column.name, column.name))
        .collect::<Vec<_>>();
    if R::TEMPORAL {
        columns.push_str(", begin_seq");
        changed.push("begin_seq = excluded.begin_seq".to_owned());
    }
    let table = R::TABLE;
    let tuple = format!("({})", placeholders(arity));
    let values = vec![tuple.as_str(); rows.len()].join(", ");
    let key = R::KEY.join(", ");
    let set = changed.join(", ");
    tx.execute(
        &format!("INSERT INTO {table} ({columns}) VALUES {values} ON CONFLICT ({key}) DO UPDATE SET {set}"),
        args,
    ).await?;
    Ok(())
}

pub(super) fn validate_locator(row: &ProjectedChatRef) -> Result<(), PortError> {
    if row.end_byte <= row.start_byte || row.end_byte - row.start_byte > 4096 {
        return Err(invalid_row());
    }
    Ok(())
}

async fn upsert_chat_ref(
    tx: &mut SqlTransaction<'_>,
    row: &ProjectedChatRef,
) -> Result<(), PortError> {
    validate_locator(row)?;
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
                source_revision = excluded.source_revision, ref_ordinal = excluded.ref_ordinal,
                start_byte = excluded.start_byte, end_byte = excluded.end_byte
             WHERE excluded.source_incarnation <> chat_note_refs.source_incarnation
                OR excluded.target_incarnation <> chat_note_refs.target_incarnation
                OR excluded.source_revision <> chat_note_refs.source_revision
                OR excluded.ref_ordinal < chat_note_refs.ref_ordinal"
        ),
        args,
    ).await?;
    Ok(())
}

async fn preserve<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    filter: &str,
    mut args: Vec<SqlValue>,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    let table = R::TABLE;
    let history = R::history_table();
    let columns = R::columns();
    let postgres = tx.postgres();
    let dynamic_bytes = R::COLUMNS
        .iter()
        .filter_map(|column| match (column.kind, postgres) {
            (Kind::Integer, _) => None,
            (_, true) => Some(format!(" + COALESCE(octet_length({}), 0)", column.name)),
            (Kind::Text, false) => Some(format!(
                " + COALESCE(length(CAST({} AS BLOB)), 0)",
                column.name
            )),
            (Kind::Bytes, false) => Some(format!(" + COALESCE(length({}), 0)", column.name)),
        })
        .collect::<String>();
    let retained_bytes = format!("{} {dynamic_bytes}", 128 + R::COLUMNS.len() * 16);
    let mut params = vec![value(&seq)];
    params.append(&mut args);
    params.push(value(&seq));
    tx.execute(
        &format!(
            "INSERT INTO {history} ({columns}, begin_seq, end_seq, retained_bytes)
             SELECT {columns}, begin_seq, ?, {retained_bytes} FROM {table} WHERE ({filter}) AND begin_seq < ?
             ON CONFLICT DO NOTHING"
        ),
        params,
    ).await?;
    Ok(())
}

async fn remove<R: SqlRecord>(
    tx: &mut SqlTransaction<'_>,
    filter: &str,
    args: Vec<SqlValue>,
    seq: SpaceSeq,
) -> Result<(), PortError> {
    if R::TEMPORAL {
        preserve::<R>(tx, filter, args.clone(), seq).await?;
    }
    let table = R::TABLE;
    tx.execute(&format!("DELETE FROM {table} WHERE {filter}"), args)
        .await?;
    Ok(())
}

async fn clear_space(tx: &mut SqlTransaction<'_>, space: &SpaceId) -> Result<(), PortError> {
    for table in [
        SchemaRecord::TABLE,
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
        "projection_cut_leases",
        "projection_page_pins",
        "projection_link_scratch",
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
    prune_history(tx, space, SpaceSeq::MAX).await
}

const HISTORY_TABLES: &[&str] = &[
    SchemaRecord::TABLE,
    ProjectedFolder::TABLE,
    ProjectedFolderAlias::TABLE,
    ProjectedNote::TABLE,
    ProjectedViewDescriptor::TABLE,
    ProjectedViewRank::TABLE,
    ProjectedLink::TABLE,
    ProjectedNoteAlias::TABLE,
];

async fn prune_history(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
    floor: SpaceSeq,
) -> Result<(), PortError> {
    for table in HISTORY_TABLES {
        tx.execute(
            &format!("DELETE FROM {table}_history WHERE space_id = ? AND end_seq <= ?"),
            vec![value(space), value(&floor)],
        )
        .await?;
    }
    Ok(())
}

async fn history_bytes(tx: &mut SqlTransaction<'_>, space: &SpaceId) -> Result<u64, PortError> {
    let totals = HISTORY_TABLES
        .iter()
        .map(|table| {
            format!("SELECT SUM(retained_bytes) AS bytes FROM {table}_history WHERE space_id = ?")
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    tx.select(
        &format!("SELECT CAST(COALESCE(SUM(bytes), 0) AS BIGINT) FROM ({totals}) AS history"),
        vec![value(space); HISTORY_TABLES.len()],
        &[Kind::Integer],
    )
    .await?
    .pop()
    .ok_or_else(invalid_row)
    .and_then(one::<u64>)
}

async fn oldest_cut(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    fallback: SpaceSeq,
) -> Result<SpaceSeq, PortError> {
    let now = now_ms();
    let row = tx
        .select(
            "SELECT MIN(cut) FROM (
            SELECT MIN(cut) AS cut FROM projection_cut_leases
            WHERE space_id = ? AND history_incarnation = ? AND expires_at_ms > ?
            UNION ALL
            SELECT MIN(cut) AS cut FROM projection_page_pins
            WHERE space_id = ? AND history_incarnation = ? AND expires_at_ms > ?
        ) AS pinned_cuts",
            vec![
                value(&scope.space_id),
                value(&scope.incarnation),
                value(&now),
                value(&scope.space_id),
                value(&scope.incarnation),
                value(&now),
            ],
            &[Kind::Integer],
        )
        .await?
        .pop()
        .ok_or_else(invalid_row)?;
    Ok(one::<Option<SpaceSeq>>(row)?.unwrap_or(fallback))
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
    let mut args = vec![value(&scope.space_id), value(&scope.incarnation)];
    args.extend(notes.into_iter().map(value));
    if args.len() == 2 {
        return Ok(false);
    }
    let ids = placeholders(args.len() - 2);
    exists(
        tx,
        &format!(
            "SELECT CAST(1 AS BIGINT) FROM projected_purge_markers
             WHERE space_id = ? AND history_incarnation = ? AND note_id IN ({ids}) LIMIT 1"
        ),
        args,
    )
    .await
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
    if !purged.is_empty() {
        raise_checkpoint_floor(tx, scope, through).await?;
        replay::prune_before(tx, scope, through).await?;
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
        tx.execute(
            "DELETE FROM projection_cut_leases WHERE space_id = ? AND history_incarnation = ?
                    AND cut < ?",
            vec![
                value(&scope.space_id),
                value(&scope.incarnation),
                value(&through),
            ],
        )
        .await?;
        tx.execute(
            "DELETE FROM projection_page_pins WHERE space_id = ? AND history_incarnation = ?
                    AND cut < ?",
            vec![
                value(&scope.space_id),
                value(&scope.incarnation),
                value(&through),
            ],
        )
        .await?;
    }
    for note in purged {
        purge_note(tx, scope, note, through).await?;
    }
    for (thread, entry) in redacted {
        redact_entry(tx, scope, thread, *entry).await?;
    }
    if let Some(current) = watermark(tx, &scope.space_id).await? {
        if current.history_incarnation != scope.incarnation {
            return Err(mismatch());
        }
        if !purged.is_empty() {
            let floor = current
                .projected_seq
                .min(through)
                .max(current.retained_floor_seq);
            prune_history(tx, &scope.space_id, floor).await?;
            tx.execute(
                "UPDATE space_projection_watermarks SET retained_floor_seq = ?,
                    snapshot_seq = CASE WHEN snapshot_seq < ? THEN 0 ELSE snapshot_seq END,
                    graph_settled_seq = CASE WHEN graph_settled_seq < ? THEN 0 ELSE graph_settled_seq END
                 WHERE space_id = ? AND history_incarnation = ?",
                vec![value(&floor), value(&through), value(&through),
                    value(&scope.space_id), value(&scope.incarnation)],
            ).await?;
        }
    }
    Ok(())
}

async fn purge_target(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<(), PortError> {
    tx.execute(
        "INSERT INTO projected_purge_markers (space_id, history_incarnation, note_id) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING",
        vec![value(&scope.space_id), value(&scope.incarnation), value(note)],
    ).await?;
    tx.execute(
        "DELETE FROM chat_note_refs WHERE target_space_id = ? AND target_incarnation = ? AND target_note_id = ?",
        vec![value(&scope.space_id), value(&scope.incarnation), value(note)],
    ).await?;
    discard_incoming_staging(tx, &scope.space_id, Some((scope.incarnation, note))).await
}

async fn discard_incoming_staging(
    tx: &mut SqlTransaction<'_>,
    space: &SpaceId,
    identity: Option<(HistoryIncarnation, &NoteId)>,
) -> Result<(), PortError> {
    let mut args = vec![value(space)];
    let targeting = if let Some((incarnation, note)) = identity {
        args.extend([value(&incarnation), value(note)]);
        " AND target.target_incarnation = ? AND target.target_note_id = ?"
    } else {
        ""
    };
    let sql = format!(
        "DELETE FROM projection_apply_pages AS page WHERE EXISTS (
            SELECT 1 FROM projection_apply_chat_refs AS target
             WHERE target.target_space_id = ?{targeting}
                AND target.space_id = page.space_id AND target.history_incarnation = page.history_incarnation
                AND target.first_seq = page.first_seq AND target.last_seq = page.last_seq AND target.page_no = page.page_no
         )"
    );
    tx.execute(&sql, args).await?;
    Ok(())
}

async fn redact_entry(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    thread: &ChatThreadId,
    entry: ThreadEntrySeq,
) -> Result<(), PortError> {
    let args = vec![
        value(&scope.space_id),
        value(&scope.incarnation),
        value(thread),
        value(&entry),
    ];
    tx.execute(
        "INSERT INTO projected_redaction_markers (space_id, history_incarnation, thread_id, entry_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING",
        args.clone(),
    ).await?;
    tx.execute(
        "DELETE FROM chat_note_refs WHERE thread_space_id = ? AND source_incarnation = ?
            AND thread_id = ? AND entry_seq = ?",
        args.clone(),
    )
    .await?;
    tx.execute(
        "DELETE FROM projection_apply_pages AS page WHERE EXISTS (
            SELECT 1 FROM projection_apply_chat_refs AS source
             WHERE source.space_id = ? AND source.history_incarnation = ?
                AND source.thread_id = ? AND source.entry_seq = ?
                AND source.space_id = page.space_id AND source.history_incarnation = page.history_incarnation
                AND source.first_seq = page.first_seq AND source.last_seq = page.last_seq AND source.page_no = page.page_no
         )",
        args,
    ).await?;
    Ok(())
}

async fn purge_note(
    tx: &mut SqlTransaction<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    through: SpaceSeq,
) -> Result<(), PortError> {
    purge_target(tx, scope, note).await?;
    let space = &scope.space_id;
    tx.execute(
        "DELETE FROM projection_link_scratch WHERE space_id = ? AND history_incarnation = ? AND first_seq < ?",
        vec![value(space), value(&scope.incarnation), value(&through)],
    ).await?;
    let args = vec![value(space), value(note)];
    let dense = tx
        .select(
            "SELECT dense_id FROM projected_notes WHERE space_id = ? AND note_id = ?
         UNION
         SELECT dense_id FROM projected_notes_history WHERE space_id = ? AND note_id = ?",
            [args.clone(), args.clone()].concat(),
            &[Kind::Integer],
        )
        .await?;
    for id in dense {
        let id = one::<u32>(id)?;
        for table in ["projected_note_links", "projected_note_links_history"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE space_id = ? AND src_dense_id = ?"),
                vec![value(space), value(&id)],
            )
            .await?;
            tx.execute(
                &format!(
                    "UPDATE {table} SET resolved_dense_id = NULL, resolved_tier = NULL
                WHERE space_id = ? AND resolved_dense_id = ?"
                ),
                vec![value(space), value(&id)],
            )
            .await?;
        }
        tx.execute(
            "DELETE FROM candidate_lookup_keys WHERE space_id = ? AND target_dense_id = ?",
            vec![value(space), value(&id)],
        )
        .await?;
    }
    for (table, filter) in [
        ("projected_notes", "note_id = ?"),
        ("projected_note_aliases", "target_note_id = ?"),
        ("projected_view_descriptors", "view_note_id = ?"),
        (
            "projected_view_ranks",
            "(view_note_id = ? OR target_note_id = ?)",
        ),
    ] {
        let mut values = args.clone();
        if filter.contains(" OR ") {
            values.push(value(note));
        }
        for suffix in ["", "_history"] {
            tx.execute(
                &format!("DELETE FROM {table}{suffix} WHERE space_id = ? AND {filter}"),
                values.clone(),
            )
            .await?;
        }
    }
    for table in ["projected_folders", "projected_folders_history"] {
        tx.execute(
            &format!(
                "UPDATE {table} SET cover_note_id = NULL WHERE space_id = ? AND cover_note_id = ?"
            ),
            args.clone(),
        )
        .await?;
    }
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
