use std::{
    collections::BTreeMap,
    sync::{Arc, Weak},
};

use croaring::{Bitmap, Portable};
use notarium_canonical::codec::encode_msgpack;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ClusterId, NoteId, SpaceSeq},
    model::HistoryScope,
    ports::{Cancellation, PageLimit},
};

use crate::{
    derived::{DerivedMutation, DerivedStore, ProjectedCluster, SpaceApply},
    graph::{GraphAdjacency, LeidenSnapshot, SettledGraph},
    index::{IndexView, L0Delta, PostingKey},
};

use super::{ProjectionEngine, PublishedCut, checkpoint_error};

pub(super) async fn settle_mapped_cut(
    engine: &ProjectionEngine,
    current: &PublishedCut,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    let index = engine.open_index_async(current).await?;
    let scope = current.cut.scope.clone();
    let cutoff = current.cut.projected_seq;
    let previous = deferred_snapshot(current, &index).await?;
    let cancel = stop.clone();
    let (settled, mutations) = tokio::task::spawn_blocking(move || {
        let effective = active_plain(&index)?;
        let graph = SettledGraph {
            index: &index,
            settlement: previous.as_ref(),
        };
        let settled = LeidenSnapshot::compute(&graph, &scope, &effective, &cancel)?;
        let mutations = cluster_mutations(&settled, &graph, &scope, cutoff)?;
        Ok::<_, PortError>((settled, mutations))
    })
    .await
    .map_err(checkpoint_error)??;
    publish_settlement(current, settled, mutations, Weak::new()).await
}

async fn publish_settlement(
    current: &PublishedCut,
    settled: LeidenSnapshot,
    mutations: Vec<DerivedMutation>,
    handoff_graph_source: Weak<PublishedCut>,
) -> Result<Arc<PublishedCut>, PortError> {
    let cutoff = current.cut.projected_seq;
    let mut watermark = current.watermark.clone();
    watermark.graph_settled_seq = cutoff;
    current
        .store
        .apply(&SpaceApply {
            expected: Some(cutoff),
            watermark: watermark.clone(),
            mutations,
        })
        .await?;
    let mut delta = (*current.delta).clone();
    delta.settle_clusters(settled, cutoff);
    Ok(Arc::new(PublishedCut {
        handoff_graph_source,
        watermark,
        delta: Arc::new(delta),
        ..current.clone()
    }))
}

/// Both cuts describe the same canonical graph. Copy the serving partition
/// by NoteId even if independent intermediate settlements or dense allocation
/// gave the private generation different cluster identities.
pub(super) async fn align_for_handoff(
    engine: &ProjectionEngine,
    candidate: &PublishedCut,
    serving: &Arc<PublishedCut>,
    stop: &Cancellation,
) -> Result<Arc<PublishedCut>, PortError> {
    let cutoff = candidate.cut.projected_seq;
    let scope = &candidate.cut.scope;
    scope.check(&serving.cut.scope)?;
    if serving.watermark.graph_settled_seq != cutoff || serving.cut.projected_seq != cutoff {
        return Err(DomainError::validation(ValidationReason::CursorStale).into());
    }
    let source = engine.open_index_async(serving).await?;
    let target = engine.open_index_async(candidate).await?;
    let source_deferred = deferred_snapshot(serving, &source).await?;
    let target_deferred = deferred_snapshot(candidate, &target).await?;
    let previously_settled = candidate.watermark.graph_settled_seq == cutoff;
    let scope = scope.clone();
    let cancel = stop.clone();
    let update = tokio::task::spawn_blocking(move || {
        let source = SettledGraph {
            index: &source,
            settlement: source_deferred.as_ref(),
        };
        let graph = SettledGraph {
            index: &target,
            settlement: target_deferred.as_ref(),
        };
        let active = active_plain(&target)?;
        let inherited = |dense| {
            let note = graph.note_id(dense).ok_or_else(invalid_cluster)?;
            source
                .lookup(&note)
                .and_then(|old| source.cluster_key(old))
                .ok_or_else(invalid_cluster)
        };
        if previously_settled {
            let mut identical = true;
            for (n, dense) in active.iter().enumerate() {
                if n % 1024 == 0 {
                    super::apply::check_stop(&cancel)?;
                }
                if graph.cluster_key(dense) != Some(inherited(dense)?) {
                    identical = false;
                    break;
                }
            }
            if identical {
                return Ok(None);
            }
        }
        let mut members = std::collections::HashMap::<_, Bitmap>::new();
        for (n, dense) in active.iter().enumerate() {
            if n % 1024 == 0 {
                super::apply::check_stop(&cancel)?;
            }
            members.entry(inherited(dense)?).or_default().add(dense);
        }
        let members = members
            .into_iter()
            .map(|(key, nodes)| (key.into_cluster_id(), nodes))
            .collect();
        let settled = LeidenSnapshot::from_members(target.node_count(), members)?;
        let mut mutations = cluster_mutations(&settled, &graph, &scope, cutoff)?;
        mutations.push(DerivedMutation::InvalidateCheckpointClusters);
        Ok::<_, PortError>(Some((settled, mutations)))
    })
    .await
    .map_err(checkpoint_error)??;
    let source = Arc::downgrade(serving);
    match update {
        Some((settled, mutations)) => {
            publish_settlement(candidate, settled, mutations, source).await
        }
        None => Ok(Arc::new(PublishedCut {
            handoff_graph_source: source,
            ..candidate.clone()
        })),
    }
}

async fn deferred_snapshot(
    cut: &PublishedCut,
    index: &IndexView,
) -> Result<Option<LeidenSnapshot>, PortError> {
    match index.deferred_clusters() {
        Some(seq) => Ok(Some(
            load_clusters(&cut.store, &cut.cut.scope, seq, index.node_count(), None).await?,
        )),
        None => Ok(None),
    }
}

pub(super) async fn restore_settlement(
    store: &DerivedStore,
    scope: &HistoryScope,
    settled: SpaceSeq,
    node_count: u32,
) -> Result<L0Delta, PortError> {
    let mut delta = L0Delta::default();
    if settled != SpaceSeq::ZERO {
        let clusters = load_clusters(store, scope, settled, node_count, None).await?;
        delta.settle_clusters(clusters, settled);
    }
    Ok(delta)
}

pub(super) async fn load_clusters(
    store: &DerivedStore,
    scope: &HistoryScope,
    settled: SpaceSeq,
    node_count: u32,
    only: Option<&ClusterId>,
) -> Result<LeidenSnapshot, PortError> {
    let mut members = BTreeMap::new();
    let mut after = None;
    let page =
        PageLimit::new(if only.is_some() { 1 } else { 200 }).expect("settlement page is bounded");
    loop {
        let rows = store
            .graph_clusters_page(scope, settled, after.as_ref(), only, page)
            .await?;
        let count = rows.len();
        for row in rows {
            let bitmap = Bitmap::try_deserialize::<Portable>(&row.members_roaring)
                .ok_or_else(invalid_cluster)?;
            if bitmap.cardinality() != row.member_count
                || bitmap.get_serialized_size_in_bytes::<Portable>() != row.members_roaring.len()
                || members.insert(row.cluster_id.clone(), bitmap).is_some()
            {
                return Err(invalid_cluster());
            }
            after = Some(row.cluster_id);
        }
        if count < usize::from(page.get()) || only.is_some() {
            break;
        }
    }
    Ok(LeidenSnapshot::from_members(node_count, members)?)
}

pub(super) fn active_plain(index: &IndexView) -> Result<Bitmap, PortError> {
    let mut effective = index
        .posting(&PostingKey::Active)
        .map_err(checkpoint_error)?;
    effective.andnot_inplace(
        &index
            .posting(&PostingKey::TrashedSubtree)
            .map_err(checkpoint_error)?,
    );
    effective.andnot_inplace(
        &index
            .posting(&PostingKey::Encrypted)
            .map_err(checkpoint_error)?,
    );
    Ok(effective)
}

pub(super) fn cluster_mutations(
    snapshot: &LeidenSnapshot,
    graph: &impl GraphAdjacency,
    scope: &HistoryScope,
    seq: SpaceSeq,
) -> Result<Vec<DerivedMutation>, PortError> {
    let mut mutations = Vec::with_capacity(snapshot.members.len() + 1);
    mutations.push(DerivedMutation::DeleteClusters);
    for (cluster, members) in &snapshot.members {
        let mut anchor: Option<&str> = None;
        let mut edges = BTreeMap::<&ClusterId, u64>::new();
        for dense in members.iter() {
            let note = graph.note_id_str(dense).ok_or_else(invalid_cluster)?;
            anchor = Some(anchor.map_or(note, |current| current.min(note)));
            for target in graph.outgoing(dense) {
                if let Some(other) = snapshot.cluster(target)
                    && other != cluster
                {
                    *edges.entry(other).or_default() += 1;
                }
            }
        }
        let anchor_note_id = NoteId::parse(anchor.ok_or_else(invalid_cluster)?)?;
        mutations.push(DerivedMutation::UpsertCluster(ProjectedCluster {
            space_id: scope.space_id.clone(),
            cluster_id: cluster.clone(),
            member_count: members.cardinality(),
            anchor_note_id,
            members_roaring: members.serialize::<Portable>(),
            inter_edges_msgpack: encode_msgpack(&edges)?,
            updated_seq: seq,
        }));
    }
    Ok(mutations)
}

fn invalid_cluster() -> PortError {
    DomainError::validation(ValidationReason::InvalidState).into()
}

#[cfg(test)]
mod tests {
    use std::{fs, num::NonZeroUsize, path::PathBuf};

    use notarium_core::{
        epoch::DataRoot,
        ids::{FolderId, HistoryIncarnation, NoteId, ProjectionGeneration, SpaceId},
    };

    use super::*;
    use crate::{
        derived::ProjectionWatermark,
        index::{FastIndexBuilder, IndexIdentity, MmapPool},
    };

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let mut suffix = [0; 12];
            getrandom::fill(&mut suffix).unwrap();
            let path =
                std::env::temp_dir().join(format!("projection-clusters-{}", hex::encode(suffix)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn durable_same_sequence_settlement_reopens_without_rewriting_the_checkpoint() {
        let scratch = Scratch::new();
        let root = DataRoot::new(&scratch.0);
        let generation = ProjectionGeneration::new(1).unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([2; 16]),
            incarnation: HistoryIncarnation::from_bytes([3; 16]),
        };
        let root_folder = FolderId::from_bytes([4; 16]);
        let seq = SpaceSeq::new(4).unwrap();
        let mut watermark = ProjectionWatermark {
            scope: scope.clone(),
            root_folder_id: root_folder,
            next_dense_id: 2,
            next_dense_folder_id: 0,
            projected_seq: seq,
            snapshot_seq: seq,
            graph_settled_seq: SpaceSeq::ZERO,
            schema: None,
            seed_in_progress: false,
            updated_at_ms: 0,
        };
        let store = DerivedStore::open_sqlite(&root, generation).await.unwrap();
        store
            .apply(&SpaceApply {
                expected: None,
                watermark: watermark.clone(),
                mutations: Vec::new(),
            })
            .await
            .unwrap();
        let path = root.space_fast_index(generation, &scope.space_id, seq);
        let mut builder = FastIndexBuilder::default();
        builder.reserve_dense(2, 0);
        let (base, _) = builder
            .publish(
                &path,
                IndexIdentity {
                    generation,
                    scope: scope.clone(),
                    seq,
                },
            )
            .unwrap();
        let digest = blake3::hash(&fs::read(&path).unwrap());
        let pool = MmapPool::new(NonZeroUsize::MIN);
        let index = IndexView::new(base.open(&pool).unwrap(), Arc::new(L0Delta::default()));
        assert_eq!(index.cluster(1), None);

        let cluster = ClusterId::from_bytes([8; 16]);
        let member: Bitmap = [1].into_iter().collect();
        watermark.graph_settled_seq = seq;
        store
            .apply(&SpaceApply {
                expected: Some(seq),
                watermark,
                mutations: vec![
                    DerivedMutation::DeleteClusters,
                    DerivedMutation::UpsertCluster(ProjectedCluster {
                        space_id: scope.space_id.clone(),
                        cluster_id: cluster.clone(),
                        member_count: 1,
                        anchor_note_id: NoteId::from_bytes([6; 16]),
                        members_roaring: member.serialize::<Portable>(),
                        inter_edges_msgpack: encode_msgpack(&BTreeMap::<ClusterId, u64>::new())
                            .unwrap(),
                        updated_seq: seq,
                    }),
                ],
            })
            .await
            .unwrap();
        drop(store);
        let reopened = DerivedStore::open_sqlite(&root, generation).await.unwrap();
        let delta = restore_settlement(&reopened, &scope, seq, 2).await.unwrap();
        let settled = IndexView::new(base.open(&pool).unwrap(), Arc::new(delta));
        assert_eq!(settled.cluster(1), Some(cluster.clone()));
        assert_eq!(
            settled
                .posting(&PostingKey::ClusterMembers(cluster))
                .unwrap(),
            member
        );
        assert_eq!(
            index.cluster(1),
            None,
            "older readers keep their prior cluster cut"
        );
        assert_eq!(blake3::hash(&fs::read(path).unwrap()), digest);
    }
}
