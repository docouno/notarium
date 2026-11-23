//! Recover the bounded in-memory index tail from its durable slot witnesses.

use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{FolderId, SpaceSeq},
    ports::Cancellation,
};

use crate::{
    derived::{DerivedStore, ProjectionWatermark},
    index::{L0_BYTE_LIMIT, L0_EVENT_LIMIT, L0Delta},
};

use super::{
    apply::check_stop,
    checkpoint_error, graph_settle,
    records::{FolderCatalog, index_note},
};

const SLOT_LIMIT: usize = 4096;
const ANCESTRY_LIMIT: usize = 4096;
const EDGE_LIMIT: u32 = 65_536;
const BATCH: usize = 200;
const HEADER: usize = 20;
const MAGIC: &[u8; 4] = b"L0S1";
const JOURNAL_LIMIT: usize = 1024 * 1024;

#[derive(Default)]
struct Slots {
    notes: BTreeSet<u32>,
    folders: BTreeSet<u32>,
    outgoing: BTreeSet<u32>,
    incoming: BTreeSet<u32>,
}

pub(super) struct ChangedSlots(Option<Slots>);

impl Default for ChangedSlots {
    fn default() -> Self {
        Self(Some(Slots::default()))
    }
}

impl ChangedSlots {
    pub(super) fn note(&mut self, dense: u32) {
        self.record(|slots| {
            slots.notes.insert(dense);
        });
    }

    pub(super) fn folder(&mut self, dense: u32) {
        self.record(|slots| {
            slots.folders.insert(dense);
        });
    }

    pub(super) fn edges(&mut self, outgoing: &croaring::Bitmap, incoming: &croaring::Bitmap) {
        if outgoing.cardinality() + incoming.cardinality() > SLOT_LIMIT as u64 {
            self.0 = None;
            return;
        }
        self.record(|slots| {
            slots.outgoing.extend(outgoing.iter());
            slots.incoming.extend(incoming.iter());
        });
    }

    fn record(&mut self, write: impl FnOnce(&mut Slots)) {
        if let Some(slots) = &mut self.0 {
            write(slots);
            if slots.len() > SLOT_LIMIT {
                self.0 = None;
            }
        }
    }

    pub(super) fn encode(self) -> Option<Vec<u8>> {
        let slots = self.0?;
        let lists = [
            &slots.notes,
            &slots.folders,
            &slots.outgoing,
            &slots.incoming,
        ];
        let mut bytes = Vec::with_capacity(HEADER + slots.len() * size_of::<u32>());
        bytes.extend_from_slice(MAGIC);
        for list in lists {
            bytes.extend_from_slice(&(list.len() as u32).to_le_bytes());
        }
        bytes.extend(
            lists
                .into_iter()
                .flatten()
                .flat_map(|slot| slot.to_le_bytes()),
        );
        Some(bytes)
    }
}

impl Slots {
    fn len(&self) -> usize {
        self.notes.len() + self.folders.len() + self.outgoing.len() + self.incoming.len()
    }

    fn merge(&mut self, bytes: &[u8]) -> Option<()> {
        if bytes.get(..MAGIC.len())? != MAGIC {
            return None;
        }
        let mut lengths = bytes.get(MAGIC.len()..HEADER)?.as_chunks::<4>().0.iter();
        let (slots, remainder) = bytes.get(HEADER..)?.as_chunks::<4>();
        let mut slots = slots.iter();
        let lists = [
            &mut self.notes,
            &mut self.folders,
            &mut self.outgoing,
            &mut self.incoming,
        ];
        for list in lists {
            let count = u32::from_le_bytes(*lengths.next()?) as usize;
            if count > SLOT_LIMIT {
                return None;
            }
            let mut previous = None;
            for _ in 0..count {
                let slot = u32::from_le_bytes(*slots.next()?);
                if previous.is_some_and(|value| slot <= value) {
                    return None;
                }
                list.insert(slot);
                previous = Some(slot);
            }
        }
        (slots.next().is_none() && remainder.is_empty() && self.len() <= SLOT_LIMIT).then_some(())
    }

    fn within(&self, watermark: &ProjectionWatermark) -> bool {
        self.notes
            .iter()
            .chain(&self.outgoing)
            .chain(&self.incoming)
            .all(|&id| u64::from(id) < watermark.next_dense_id)
            && self
                .folders
                .iter()
                .all(|&id| u64::from(id) < watermark.next_dense_folder_id)
    }
}

async fn tail_slots(
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
    stop: &Cancellation,
) -> Result<Option<Slots>, PortError> {
    let mut slots = Slots::default();
    let mut total = 0usize;
    let mut cursor = watermark.snapshot_seq;
    while cursor < watermark.projected_seq {
        check_stop(stop)?;
        let Some(page) = store.replay_page(watermark, cursor).await? else {
            return Ok(None);
        };
        if page.is_empty() {
            return Ok(None);
        }
        for row in page {
            total = total.saturating_add(row.slots.len() + 64);
            if cursor != row.after
                || cursor >= row.through
                || total > JOURNAL_LIMIT
                || slots.merge(&row.slots).is_none()
            {
                return Ok(None);
            }
            cursor = row.through;
        }
    }
    Ok(slots.within(watermark).then_some(slots))
}

pub(super) async fn restore(
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
    graph_seq: SpaceSeq,
    stop: &Cancellation,
) -> Result<Option<L0Delta>, PortError> {
    let span = watermark
        .projected_seq
        .get()
        .saturating_sub(watermark.snapshot_seq.get());
    if span >= u64::from(L0_EVENT_LIMIT) {
        return Ok(None);
    }
    let scope = &watermark.scope;
    let cutoff = watermark.projected_seq;
    let Some(slots) = tail_slots(store, watermark, stop).await? else {
        return Ok(None);
    };
    let mut delta = if watermark.graph_settled_seq > graph_seq {
        graph_settle::restore_settlement(
            store,
            scope,
            watermark.graph_settled_seq,
            u32::try_from(watermark.next_dense_id).map_err(checkpoint_error)?,
        )
        .await?
    } else {
        L0Delta::default()
    };
    // Standalone checkpoint recovery has no index slots to hydrate.
    if span == 0 {
        return Ok(Some(delta));
    }

    let folder_slots: Vec<_> = slots.folders.into_iter().collect();
    let mut folders = FolderCatalog::default();
    for batch in folder_slots.chunks(BATCH) {
        check_stop(stop)?;
        let rows = store.replay_folders(scope, cutoff, batch).await?;
        if rows.len() != batch.len() {
            return Ok(None);
        }
        for row in rows {
            delta
                .replace_folder(row.dense_folder_id, &row.folder_id, row.lifecycle)
                .map_err(checkpoint_error)?;
            folders.rows.insert(row.folder_id.clone(), row);
        }
    }

    let note_slots: Vec<_> = slots.notes.into_iter().collect();
    for batch in note_slots.chunks(BATCH) {
        check_stop(stop)?;
        let rows = store.hydrate(scope, cutoff, batch).await?;
        let Some(rows) = rows.into_iter().collect::<Option<Vec<_>>>() else {
            return Ok(None);
        };
        let start = rows
            .iter()
            .map(|row| row.parent_folder_id.clone())
            .collect::<BTreeSet<_>>();
        if !load_ancestors(store, watermark, &mut folders, start, stop).await? {
            return Ok(None);
        }
        for row in rows {
            let location = folders.location(&row.parent_folder_id)?;
            index_note(&row, &location, |note| delta.replace_note(note))?;
            if delta.approx_bytes() > L0_BYTE_LIMIT {
                return Ok(None);
            }
        }
    }

    let mut edge_budget = EDGE_LIMIT;
    for (incoming, nodes) in [(false, slots.outgoing), (true, slots.incoming)] {
        let nodes: Vec<_> = nodes.into_iter().collect();
        for batch in nodes.chunks(BATCH) {
            check_stop(stop)?;
            let Some(edges) = store
                .replay_edges(scope, cutoff, batch, incoming, edge_budget)
                .await?
            else {
                return Ok(None);
            };
            edge_budget -= edges.len() as u32;
            let mut adjacency: BTreeMap<u32, Vec<u32>> =
                batch.iter().map(|&node| (node, Vec::new())).collect();
            for (source, target) in edges {
                let (node, neighbor) = if incoming {
                    (target, source)
                } else {
                    (source, target)
                };
                let Some(neighbors) = adjacency.get_mut(&node) else {
                    return Ok(None);
                };
                if u64::from(neighbor) >= watermark.next_dense_id {
                    return Ok(None);
                }
                neighbors.push(neighbor);
            }
            for (node, neighbors) in adjacency {
                if incoming {
                    delta.replace_adjacency(node, None, Some(neighbors));
                } else {
                    delta.replace_adjacency(node, Some(neighbors), None);
                }
            }
        }
    }
    if delta.approx_bytes() > L0_BYTE_LIMIT {
        return Ok(None);
    }
    if !store.replay_cut_is_current(watermark).await? {
        return Err(DomainError::validation(ValidationReason::CursorStale).into());
    }
    delta.record_events(u32::try_from(span).map_err(checkpoint_error)?);
    Ok(Some(delta))
}

async fn load_ancestors(
    store: &DerivedStore,
    watermark: &ProjectionWatermark,
    folders: &mut FolderCatalog,
    roots: BTreeSet<FolderId>,
    stop: &Cancellation,
) -> Result<bool, PortError> {
    let mut queue: BTreeSet<_> = roots
        .iter()
        .filter(|id| !folders.rows.contains_key(*id))
        .cloned()
        .collect();
    // Preloaded changed folders may have a parent outside the loaded set.
    queue.extend(folders.rows.values().filter_map(|row| {
        row.parent_folder_id
            .as_ref()
            .filter(|id| !folders.rows.contains_key(*id))
            .cloned()
    }));
    while !queue.is_empty() {
        check_stop(stop)?;
        if queue.len() + folders.rows.len() > ANCESTRY_LIMIT {
            return Ok(false);
        }
        let pending = queue.into_iter().collect::<Vec<_>>();
        queue = BTreeSet::new();
        for batch in pending.chunks(BATCH) {
            let fetched = store
                .hydrate_folders(&watermark.scope, watermark.projected_seq, batch)
                .await?;
            if fetched.len() != batch.len() {
                return Ok(false);
            }
            queue.extend(
                fetched
                    .values()
                    .filter_map(|row| row.parent_folder_id.clone()),
            );
            folders.rows.extend(fetched);
        }
        queue.retain(|id| !folders.rows.contains_key(id));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_encodes_only_sorted_slot_keys_and_rejects_incomplete_payload() {
        let mut changed = ChangedSlots::default();
        for id in [9, 2, 9] {
            changed.note(id);
        }
        changed.folder(4);
        changed.edges(&croaring::Bitmap::of(&[7]), &croaring::Bitmap::of(&[5, 6]));
        let bytes = changed.encode().unwrap();
        let mut decoded = Slots::default();
        decoded.merge(&bytes).unwrap();
        assert_eq!(decoded.notes, BTreeSet::from([2, 9]));
        assert_eq!(decoded.folders, BTreeSet::from([4]));
        assert_eq!(decoded.outgoing, BTreeSet::from([7]));
        assert_eq!(decoded.incoming, BTreeSet::from([5, 6]));
        assert!(Slots::default().merge(&bytes[..bytes.len() - 1]).is_none());
        let mut reversed = bytes;
        reversed[HEADER..HEADER + 4].copy_from_slice(&10u32.to_le_bytes());
        assert!(Slots::default().merge(&reversed).is_none());
    }

    #[test]
    fn oversized_commands_stop_collecting_slots() {
        let mut changed = ChangedSlots::default();
        for slot in 0..=SLOT_LIMIT as u32 {
            changed.note(slot);
        }
        changed.folder(1);
        assert!(changed.encode().is_none());
    }

    #[tokio::test]
    async fn restart_replays_changed_rows_and_repairs_a_missing_journal() {
        use notarium_canonical::{
            CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec,
        };
        use notarium_core::{
            auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
            classes::DocClass,
            epoch::DataRoot,
            ids::*,
            ports::{
                CallBudget, CommandSeqRange, CreateNote, MaintenanceContext, Mutation,
                NoteWritePort, Preconditions, ServiceAuthority, ServicePurpose, SpaceContext,
            },
            receipt::{CommandIdentity, MutationReceiptToken},
        };
        use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
        use std::{path::PathBuf, time::Duration};

        use crate::index::PostingKey;
        use crate::runtime::{ProjectionConfig, ProjectorRuntime, apply};

        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        async fn stop_without_checkpoint(mut runtime: ProjectorRuntime) {
            let worker = runtime.worker.take().unwrap();
            worker.abort();
            assert!(worker.await.unwrap_err().is_cancelled());
        }
        async fn note(
            canonical: &CanonicalStore,
            human: &SpaceContext,
            nonce: u8,
            slug: &str,
            carrier: &str,
        ) -> (NoteId, MutationReceiptToken) {
            let id = NoteId::from_bytes([nonce; 16]);
            let written = canonical
                .create_note(
                    human.clone(),
                    Mutation {
                        identity: CommandIdentity {
                            scope: human.scope().clone(),
                            actor: human.auth().principal().clone(),
                            key: CommandKey::from_bytes([nonce; 16]),
                            hash: ContentDigest::from_bytes([nonce; 32]),
                        },
                        preconditions: Preconditions::default(),
                        input: CreateNote {
                            folder_page: false,
                            note: id.clone(),
                            parent: None,
                            slug: slug.into(),
                            class: DocClass::UserDoc,
                            carrier: carrier.into(),
                        },
                    },
                )
                .await
                .unwrap();
            (id, written.receipt)
        }

        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        let scratch =
            Scratch(std::env::temp_dir().join(format!("projection-replay-{}", hex::encode(nonce))));
        let root = DataRoot::new(&scratch.0);
        let (canonical, canonical_runtime) = CanonicalRuntime::open(
            CanonicalConfig::local_default(InstallationId::from_bytes([1; 16]), root.clone()),
        )
        .await
        .unwrap();
        let owner = PrincipalId::from_bytes([2; 16]);
        let space = canonical
            .create_space(CreateSpaceSpec {
                space_id: SpaceId::from_bytes([3; 16]),
                incarnation: HistoryIncarnation::from_bytes([4; 16]),
                root_folder_id: FolderId::from_bytes([5; 16]),
                slug: "projection-tail".into(),
                kind: SpaceKind::Shared,
                owner: owner.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        let budget = CallBudget {
            request: RequestId::from_bytes([6; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(15),
        };
        let context = MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Projection),
            budget: budget.clone(),
        };
        let human = SpaceContext::new(
            EngineAuthContext::for_human(VerifiedHuman::attest(
                owner,
                GrantId::from_bytes([7; 16]),
                BTreeMap::from([(
                    space.scope.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                )]),
                false,
            )),
            space.scope.clone(),
            budget.clone(),
        )
        .unwrap();
        let scope = &space.scope;
        let (target, base_receipt) = note(&canonical, &human, 10, "target", "# Target").await;
        let base_seq = base_receipt.seq();
        let generation = ProjectionGeneration::new(1).unwrap();
        let store = DerivedStore::open_sqlite(&root, generation).await.unwrap();
        let start = || {
            ProjectorRuntime::start_for_test(
                canonical.clone(),
                context.clone(),
                store.clone(),
                root.clone(),
                ProjectionConfig::default(),
            )
        };
        let runtime = start().await.unwrap();
        let original_engine = runtime.engine();
        let cut = original_engine
            .wait_for_cut(scope, base_seq, &budget, budget.remaining)
            .await
            .unwrap();
        assert_eq!(cut.watermark.snapshot_seq, base_seq);

        // Run one production apply after stopping the timer-driven worker. This
        // retains the same durable window as a crash after commit, before flush.
        stop_without_checkpoint(runtime).await;
        let (source, tail_receipt) = note(
            &canonical,
            &human,
            11,
            "source",
            "# Source

[[target]] #trail",
        )
        .await;
        let tail_seq = tail_receipt.seq();
        let range = CommandSeqRange::new(tail_seq, tail_seq).unwrap();
        let applied = apply::command(&original_engine, &cut, range, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(applied.cut.watermark.snapshot_seq, base_seq);
        drop(applied);
        drop(cut);
        drop(original_engine);

        let assert_index = |engine: &crate::runtime::ProjectionEngine,
                            cut: &crate::runtime::PublishedCut| {
            let index = engine.open_index(cut).unwrap();
            let source = index.dense_id(&source).unwrap();
            let target = index.dense_id(&target).unwrap();
            assert_eq!(index.outgoing(source).collect::<Vec<_>>(), [target]);
            assert_eq!(index.incoming(target).collect::<Vec<_>>(), [source]);
            assert!(
                index
                    .posting(&PostingKey::Tag("trail".into()))
                    .unwrap()
                    .contains(source)
            );
        };

        let runtime = start().await.unwrap();
        let engine = runtime.engine();
        let cut = engine
            .wait_for_cut(scope, tail_seq, &budget, budget.remaining)
            .await
            .unwrap();
        assert_eq!(cut.watermark.snapshot_seq, base_seq);
        assert!(
            std::fs::read_dir(root.space_fast_index_dir(generation, &scope.space_id))
                .into_iter()
                .flatten()
                .flatten()
                .all(|entry| {
                    let name = entry.file_name();
                    !name
                        .to_str()
                        .is_some_and(|s| s.starts_with(&format!("fast_index_{}", tail_seq.get())))
                })
        );
        assert_index(&engine, &cut);
        stop_without_checkpoint(runtime).await;
        drop(cut);
        drop(engine);

        let mut raw = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(root.derived(generation)),
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM projection_index_replay")
            .execute(&mut raw)
            .await
            .unwrap();
        raw.close().await.unwrap();

        let runtime = start().await.unwrap();
        let engine = runtime.engine();
        let cut = engine
            .wait_for_cut(scope, tail_seq, &budget, budget.remaining)
            .await
            .unwrap();
        assert_eq!(cut.watermark.snapshot_seq, tail_seq);
        assert_index(&engine, &cut);
        runtime.shutdown().await.unwrap();
        canonical_runtime.shutdown().await.unwrap();
    }
}
