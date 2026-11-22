use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap, HashMap},
};

use croaring::Bitmap;
use notarium_canonical::codec::cancelled_not_committed;
use notarium_core::{
    DomainError, DomainResult,
    error::PortError,
    ids::{ClusterId, NoteId},
    model::SnapshotCut,
    ports::{GraphEdge, GraphNode, GraphNodeId, GraphResult, GraphTier},
};

use crate::index::{ClusterKey, GraphSections, IndexView, PostingKey};

mod leiden;
pub(crate) use leiden::LeidenSnapshot;

/// The same adjacency is read by graph queries and the background partitioner.
/// Implementations borrow existing adjacency and never expand an entire CSR
/// section just to answer a query.
pub(crate) trait GraphAdjacency {
    fn node_count(&self) -> u32;
    fn lookup(&self, note: &NoteId) -> Option<u32>;
    fn lookup_str(&self, note: &str) -> Option<u32>;
    fn note_id(&self, node: u32) -> Option<NoteId>;
    fn note_id_str(&self, node: u32) -> Option<&str>;
    fn outgoing(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_;
    fn incoming(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_;
    fn cluster_key(&self, node: u32) -> Option<ClusterKey<'_>>;

    fn cluster_members(&self, cluster: &ClusterId) -> DomainResult<Option<Bitmap>> {
        let target = ClusterKey::from_borrowed(cluster);
        let members = (0..self.node_count())
            .filter(|&node| self.cluster_key(node) == Some(target))
            .collect::<Bitmap>();
        Ok((!members.is_empty()).then_some(members))
    }
}

impl GraphAdjacency for IndexView {
    fn node_count(&self) -> u32 {
        self.node_count()
    }

    fn lookup(&self, note: &NoteId) -> Option<u32> {
        self.dense_id(note)
    }

    fn lookup_str(&self, note: &str) -> Option<u32> {
        self.dense_id_str(note)
    }

    fn note_id(&self, node: u32) -> Option<NoteId> {
        self.note_id(self.dense(node)).ok()
    }

    fn note_id_str(&self, node: u32) -> Option<&str> {
        self.note_id_str(node)
    }

    fn outgoing(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.outgoing(node)
    }

    fn incoming(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.incoming(node)
    }

    fn cluster_key(&self, node: u32) -> Option<ClusterKey<'_>> {
        self.cluster_key(node)
    }

    fn cluster_members(&self, id: &ClusterId) -> DomainResult<Option<Bitmap>> {
        let members = self
            .posting(&PostingKey::ClusterMembers(id.clone()))
            .map_err(|_| {
                DomainError::validation(notarium_core::error::ValidationReason::InvalidState)
            })?;
        Ok((!members.is_empty()).then_some(members))
    }
}

/// An oversized graph settlement is looked up from durable rows on demand.
/// The graph's edges and note identities remain borrowed from the mmap.
pub(crate) struct SettledGraph<'a> {
    pub index: &'a IndexView,
    pub settlement: Option<&'a LeidenSnapshot>,
}

impl GraphAdjacency for SettledGraph<'_> {
    fn node_count(&self) -> u32 {
        self.index.node_count()
    }

    fn lookup(&self, note: &NoteId) -> Option<u32> {
        self.index.dense_id(note)
    }

    fn lookup_str(&self, note: &str) -> Option<u32> {
        self.index.dense_id_str(note)
    }

    fn note_id(&self, node: u32) -> Option<NoteId> {
        GraphAdjacency::note_id(self.index, node)
    }

    fn note_id_str(&self, node: u32) -> Option<&str> {
        self.index.note_id_str(node)
    }

    fn outgoing(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.index.outgoing(node)
    }

    fn incoming(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.index.incoming(node)
    }

    fn cluster_key(&self, node: u32) -> Option<ClusterKey<'_>> {
        match self.settlement {
            Some(settlement) => settlement.cluster(node).map(ClusterKey::from_borrowed),
            None => self.index.cluster_key(node),
        }
    }

    fn cluster_members(&self, id: &ClusterId) -> DomainResult<Option<Bitmap>> {
        match self.settlement {
            Some(settlement) => Ok(settlement.members.get(id).cloned()),
            None => GraphAdjacency::cluster_members(self.index, id),
        }
    }
}

/// In-memory adjacency for the background checkpoint builder. The request
/// path uses `IndexView` directly.
pub(crate) struct GraphBuild<'a> {
    pub notes: &'a [Option<NoteId>],
    pub sections: &'a GraphSections,
}

impl GraphAdjacency for GraphBuild<'_> {
    fn node_count(&self) -> u32 {
        self.notes.len() as u32
    }

    fn lookup(&self, note: &NoteId) -> Option<u32> {
        self.lookup_str(note.as_str())
    }

    fn lookup_str(&self, note: &str) -> Option<u32> {
        self.notes
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|id| id.as_str() == note))
            .map(|index| index as u32)
    }

    fn note_id(&self, node: u32) -> Option<NoteId> {
        self.notes.get(node as usize).and_then(Clone::clone)
    }

    fn note_id_str(&self, node: u32) -> Option<&str> {
        self.notes
            .get(node as usize)
            .and_then(|entry| entry.as_ref().map(NoteId::as_str))
    }

    fn outgoing(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.sections
            .outgoing
            .get(node as usize)
            .into_iter()
            .flatten()
            .copied()
    }

    fn incoming(&self, node: u32) -> impl Iterator<Item = u32> + Send + '_ {
        self.sections
            .incoming
            .get(node as usize)
            .into_iter()
            .flatten()
            .copied()
    }

    fn cluster_key(&self, node: u32) -> Option<ClusterKey<'_>> {
        self.sections
            .clusters
            .get(node as usize)
            .and_then(|entry| entry.as_ref().map(ClusterKey::from_borrowed))
    }
}

const MAX_CLUSTERS: usize = 500;
const MAX_NOTES: usize = 2_000;
const MAX_LENS_EDGES: usize = 16_000;
const SCAN_CHECK_INTERVAL: usize = 1_024;

/// A dropped graph request releases its blocking worker after a bounded scan,
/// including rows whose edges are all filtered out or have already been seen.
struct GraphScan<'a> {
    abandoned: &'a mut dyn FnMut() -> bool,
    remaining: usize,
}

impl GraphScan<'_> {
    fn check(&mut self) -> Result<(), PortError> {
        if (self.abandoned)() {
            return Err(cancelled_not_committed(
                "projection_graph",
                "read abandoned",
            ));
        }
        Ok(())
    }

    fn visit(&mut self) -> Result<(), PortError> {
        self.remaining -= 1;
        if self.remaining == 0 {
            self.remaining = SCAN_CHECK_INTERVAL;
            self.check()?;
        }
        Ok(())
    }
}

pub(crate) struct GraphPlan {
    pub result: GraphResult,
    /// (position in result.nodes, dense note ID), in presentation order.
    pub hydration: Vec<(usize, u32)>,
}

/// Plan a response without reading card payloads. `authorized` contains ONLY
/// active plain notes authorized for the caller (excluding `HiddenByAuth` so
/// `hidden_count` never leaks cardinality of unauthorized projects/classes).
/// `filtered` is the subset of `authorized` matching `query.filter`.
pub(crate) fn plan_graph(
    adjacency: &impl GraphAdjacency,
    cut: SnapshotCut,
    tier: &GraphTier,
    authorized: &Bitmap,
    filtered: &Bitmap,
    lens_scope: Option<&Bitmap>,
    mut abandoned: impl FnMut() -> bool,
) -> Result<GraphPlan, PortError> {
    let mut scan = GraphScan {
        abandoned: &mut abandoned,
        remaining: SCAN_CHECK_INTERVAL,
    };
    scan.check()?;
    let visible = if authorized.and_cardinality(filtered) == filtered.cardinality() {
        std::borrow::Cow::Borrowed(filtered)
    } else {
        std::borrow::Cow::Owned(authorized.and(filtered))
    };
    let filtered_out = authorized.cardinality() - visible.cardinality();
    match tier {
        GraphTier::Superclusters => {
            superclusters(adjacency, cut, &visible, filtered_out, &mut scan)
        }
        GraphTier::Lens { cluster, .. } => {
            let mut eligible = visible;
            if let Some(scope) = lens_scope {
                eligible.to_mut().and_inplace(scope);
            }
            if let Some(cluster) = cluster {
                let members = adjacency
                    .cluster_members(cluster)?
                    .ok_or(DomainError::ResourceNotFound)?;
                // Require at least one authorized note in the cluster so callers
                // cannot probe existence of unauthorized clusters.
                if authorized.and_cardinality(&members) == 0 {
                    return Err(DomainError::ResourceNotFound.into());
                }
                eligible.to_mut().and_inplace(&members);
            }
            let hidden = authorized.cardinality() - eligible.cardinality();
            lens(adjacency, cut, &eligible, hidden, &mut scan)
        }
        GraphTier::Neighborhood { note, hops } => neighborhood(
            adjacency,
            cut,
            note,
            *hops,
            &visible,
            filtered_out,
            &mut scan,
        ),
    }
}

fn superclusters(
    adjacency: &impl GraphAdjacency,
    cut: SnapshotCut,
    visible: &Bitmap,
    hidden: u64,
    scan: &mut GraphScan<'_>,
) -> Result<GraphPlan, PortError> {
    let mut cluster_slots = HashMap::<ClusterKey<'_>, usize>::new();
    let mut clusters: Vec<(ClusterId, Bitmap)> = Vec::new();
    let mut unclustered = 0u64;
    for dense in visible.iter() {
        scan.visit()?;
        if let Some(key) = adjacency.cluster_key(dense) {
            let slot = if let Some(&slot) = cluster_slots.get(&key) {
                slot
            } else {
                let slot = clusters.len();
                cluster_slots.insert(key, slot);
                clusters.push((key.into_cluster_id(), Bitmap::new()));
                slot
            };
            clusters[slot].1.add(dense);
        } else {
            unclustered += 1;
        }
    }
    let mut order: Vec<(usize, u64)> = clusters
        .iter()
        .enumerate()
        .map(|(slot, (_, nodes))| (slot, nodes.cardinality()))
        .collect();
    order.sort_unstable_by(|&(left_slot, left_count), &(right_slot, right_count)| {
        right_count
            .cmp(&left_count)
            .then_with(|| clusters[left_slot].0.cmp(&clusters[right_slot].0))
    });
    let selected_count = order.len().min(MAX_CLUSTERS);
    let mut selected = Bitmap::new();
    let mut cluster_by_note = vec![u16::MAX; adjacency.node_count() as usize];
    for (rank, &(slot, _)) in order.iter().take(selected_count).enumerate() {
        let rank_u16 = rank as u16;
        for dense in clusters[slot].1.iter() {
            scan.visit()?;
            selected.add(dense);
            if let Some(cell) = cluster_by_note.get_mut(dense as usize) {
                *cell = rank_u16;
            }
        }
    }
    let mut weights = BTreeMap::<(u16, u16), u64>::new();
    for source in selected.iter() {
        scan.visit()?;
        let from = cluster_by_note[source as usize];
        for target in adjacency.outgoing(source) {
            scan.visit()?;
            let Some(&to) = cluster_by_note.get(target as usize) else {
                continue;
            };
            if to != u16::MAX && to != from {
                *weights.entry((from.min(to), from.max(to))).or_default() += 1;
            }
        }
    }
    let nodes = order
        .iter()
        .take(selected_count)
        .map(|&(slot, count)| GraphNode {
            id: GraphNodeId::Cluster(clusters[slot].0.clone()),
            card: None,
            member_count: count,
        })
        .collect();
    let edges = weights
        .into_iter()
        .map(|((source, target), weight)| GraphEdge {
            source: GraphNodeId::Cluster(clusters[order[source as usize].0].0.clone()),
            target: GraphNodeId::Cluster(clusters[order[target as usize].0].0.clone()),
            weight: weight as f64,
        })
        .collect();
    let capped: u64 = order
        .iter()
        .skip(selected_count)
        .map(|&(_, count)| count)
        .sum();
    Ok(GraphPlan {
        result: GraphResult {
            nodes,
            edges,
            hidden_count: hidden + capped + unclustered,
            truncated: capped != 0,
            cut,
        },
        hydration: Vec::new(),
    })
}

fn lens(
    adjacency: &impl GraphAdjacency,
    cut: SnapshotCut,
    eligible: &Bitmap,
    hidden: u64,
    scan: &mut GraphScan<'_>,
) -> Result<GraphPlan, PortError> {
    let mut best = BinaryHeap::with_capacity(MAX_NOTES + 1);
    for node in eligible.iter() {
        scan.visit()?;
        let mut degree = 0usize;
        for neighbor in adjacency.outgoing(node).chain(adjacency.incoming(node)) {
            scan.visit()?;
            if neighbor != node && eligible.contains(neighbor) {
                degree += 1;
            }
        }
        best.push(Reverse((degree, Reverse(node))));
        if best.len() > MAX_NOTES {
            best.pop();
        }
    }
    let ordered = best
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((_, Reverse(node)))| node)
        .collect::<Vec<_>>();
    let capped = eligible.cardinality() - ordered.len() as u64;
    note_plan(adjacency, cut, ordered, hidden, capped, scan)
}

fn neighborhood(
    adjacency: &impl GraphAdjacency,
    cut: SnapshotCut,
    note: &NoteId,
    hops: u8,
    visible: &Bitmap,
    hidden: u64,
    scan: &mut GraphScan<'_>,
) -> Result<GraphPlan, PortError> {
    if !(1..=2).contains(&hops) {
        return Err(
            DomainError::validation(notarium_core::error::ValidationReason::InvalidLimit).into(),
        );
    }
    let focal = adjacency
        .lookup(note)
        .filter(|&node| visible.contains(node))
        .ok_or(DomainError::ResourceNotFound)?;
    let mut first = Bitmap::new();
    for node in adjacency.outgoing(focal).chain(adjacency.incoming(focal)) {
        scan.visit()?;
        if node != focal && visible.contains(node) {
            first.add(node);
        }
    }
    let mut second = Bitmap::new();
    let mut remaining = visible.cardinality() - 1 - first.cardinality();
    if hops == 2 && remaining > 0 {
        'expand: for node in first.iter() {
            for neighbor in adjacency.outgoing(node).chain(adjacency.incoming(node)) {
                scan.visit()?;
                if neighbor != focal
                    && visible.contains(neighbor)
                    && !first.contains(neighbor)
                    && second.add_checked(neighbor)
                {
                    remaining -= 1;
                    if remaining == 0 {
                        break 'expand;
                    }
                }
            }
        }
    }
    let ordered = std::iter::once(focal)
        .chain(first.iter())
        .chain(second.iter())
        .take(MAX_NOTES)
        .collect::<Vec<_>>();
    let capped = 1 + first.cardinality() + second.cardinality() - ordered.len() as u64;
    note_plan(adjacency, cut, ordered, hidden, capped, scan)
}

fn note_plan(
    adjacency: &impl GraphAdjacency,
    cut: SnapshotCut,
    ordered: Vec<u32>,
    hidden: u64,
    capped: u64,
    scan: &mut GraphScan<'_>,
) -> Result<GraphPlan, PortError> {
    let nodes = ordered
        .iter()
        .map(|&dense| {
            let note = adjacency.note_id(dense).ok_or_else(|| {
                DomainError::validation(notarium_core::error::ValidationReason::InvalidState)
            })?;
            Ok(GraphNode {
                id: GraphNodeId::Note(note),
                card: None,
                member_count: 1,
            })
        })
        .collect::<DomainResult<Vec<_>>>()?;
    let positions: HashMap<u32, usize> = ordered
        .iter()
        .copied()
        .enumerate()
        .map(|(position, dense)| (dense, position))
        .collect();
    let mut edges = Vec::new();
    let mut edge_capped = false;
    'sources: for (position, &source) in ordered.iter().enumerate() {
        for target in adjacency.outgoing(source) {
            scan.visit()?;
            let Some(&target) = positions.get(&target) else {
                continue;
            };
            if edges.len() == MAX_LENS_EDGES {
                edge_capped = true;
                break 'sources;
            }
            edges.push(GraphEdge {
                source: nodes[position].id.clone(),
                target: nodes[target].id.clone(),
                weight: 1.0,
            });
        }
    }
    Ok(GraphPlan {
        result: GraphResult {
            nodes,
            edges,
            hidden_count: hidden + capped,
            truncated: capped != 0 || edge_capped,
            cut,
        },
        hydration: ordered.into_iter().enumerate().collect(),
    })
}

#[cfg(test)]
mod tests {
    use notarium_core::{
        ids::{HistoryIncarnation, ProjectionGeneration, SpaceId, SpaceSeq},
        model::HistoryScope,
        ports::Cancellation,
    };

    use super::*;

    fn cut() -> SnapshotCut {
        SnapshotCut {
            scope: HistoryScope {
                space_id: SpaceId::from_bytes([5; 16]),
                incarnation: HistoryIncarnation::from_bytes([15; 16]),
            },
            generation: ProjectionGeneration::new(1).unwrap(),
            canonical_seq: SpaceSeq::new(3).unwrap(),
            projected_seq: SpaceSeq::new(3).unwrap(),
        }
    }

    fn fixture(count: usize, edges: &[(usize, usize)]) -> (Vec<Option<NoteId>>, GraphSections) {
        let ids = (0..count)
            .map(|dense| Some(NoteId::from_bytes((dense as u128).to_le_bytes())))
            .collect();
        let mut graph = GraphSections {
            outgoing: vec![Vec::new(); count],
            incoming: vec![Vec::new(); count],
            clusters: vec![None; count],
        };
        for &(from, to) in edges {
            graph.outgoing[from].push(to as u32);
            graph.incoming[to].push(from as u32);
        }
        (ids, graph)
    }

    #[test]
    fn neighborhood_uses_both_directions_and_never_crosses_an_invisible_node() {
        let (notes, sections) =
            fixture(7, &[(1, 0), (0, 2), (2, 1), (2, 3), (4, 1), (5, 0), (5, 6)]);
        let graph = GraphBuild {
            notes: &notes,
            sections: &sections,
        };
        let authorized: Bitmap = (0..7).collect();
        let filtered: Bitmap = [0, 1, 2, 3, 4, 6].into_iter().collect();
        let tier = GraphTier::Neighborhood {
            note: notes[0].clone().unwrap(),
            hops: 2,
        };
        let plan =
            plan_graph(&graph, cut(), &tier, &authorized, &filtered, None, || false).unwrap();
        let order: Vec<_> = plan.hydration.iter().map(|&(_, dense)| dense).collect();
        assert_eq!(order, [0, 1, 2, 3, 4]);
        assert_eq!(plan.result.edges.len(), 5);
        assert_eq!(plan.result.hidden_count, 1);
        assert!(!plan.result.truncated);
    }

    #[test]
    fn saturated_first_hop_counts_distinct_authorized_second_hop_nodes() {
        for degree in [1_998, 1_999, 2_000] {
            let mut edges: Vec<_> = (1..=degree).map(|node| (0, node)).collect();
            let tail = degree + 1;
            edges.extend([(1, tail), (tail, 2), (2, tail + 1)]);
            let (notes, sections) = fixture(degree + 3, &edges);
            let graph = GraphBuild {
                notes: &notes,
                sections: &sections,
            };
            let visible = (0..=tail as u32).collect();
            let tier = GraphTier::Neighborhood {
                note: notes[0].clone().unwrap(),
                hops: 2,
            };
            let plan =
                plan_graph(&graph, cut(), &tier, &visible, &visible, None, || false).unwrap();
            let omitted = degree + 2 - MAX_NOTES;
            assert_eq!(plan.result.nodes.len(), MAX_NOTES);
            assert_eq!(plan.result.hidden_count, omitted as u64);
            assert_eq!(plan.result.truncated, omitted > 0);
        }
    }

    #[test]
    fn abandoned_neighborhood_stops_during_wide_second_hop() {
        let degree = 2_000;
        let mut edges: Vec<_> = (1..=degree).map(|node| (0, node)).collect();
        for node in 1..=degree {
            for offset in 1..=100 {
                edges.push((node, 1 + (node - 1 + offset) % degree));
            }
        }
        // The isolated visible note forces an exhaustive second hop, even
        // though the first hop has already filled the presentation window.
        let (notes, sections) = fixture(degree + 2, &edges);
        let visible: Bitmap = (0..notes.len() as u32).collect();
        let graph = GraphBuild {
            notes: &notes,
            sections: &sections,
        };
        let tier = GraphTier::Neighborhood {
            note: notes[0].clone().unwrap(),
            hops: 2,
        };
        let (reply, mut request) = tokio::sync::oneshot::channel::<()>();
        let mut checks = 0;
        let result = plan_graph(&graph, cut(), &tier, &visible, &visible, None, || {
            checks += 1;
            // Beyond both the 2k first hop and the 16k induced edge cap.
            if checks == 64 {
                request.close();
            }
            reply.is_closed()
        });
        assert!(matches!(result, Err(PortError::Cancelled(_))));
        assert_eq!(checks, 64);

        let plan = plan_graph(&graph, cut(), &tier, &visible, &visible, None, || false).unwrap();
        assert_eq!(plan.result.nodes.len(), MAX_NOTES);
        assert_eq!(plan.result.hidden_count, 1);
        assert_eq!(plan.result.edges.len(), MAX_LENS_EDGES);
        assert!(plan.result.truncated);
    }

    #[test]
    fn lens_ranks_visible_induced_degree_before_its_deterministic_tie_break() {
        let (notes, sections) = fixture(6, &[(4, 2), (2, 3), (2, 5), (1, 0), (1, 5)]);
        let graph = GraphBuild {
            notes: &notes,
            sections: &sections,
        };
        let authorized: Bitmap = (0..6).collect();
        let filtered: Bitmap = (0..5).collect();
        let tier = GraphTier::Lens {
            project: None,
            tags: Vec::new(),
            cluster: None,
        };
        let plan =
            plan_graph(&graph, cut(), &tier, &authorized, &filtered, None, || false).unwrap();
        let order: Vec<_> = plan.hydration.iter().map(|&(_, dense)| dense).collect();
        assert_eq!(order, [2, 0, 1, 3, 4]);
        assert_eq!(plan.result.edges.len(), 3);
        assert_eq!(plan.result.hidden_count, 1);
    }

    #[test]
    fn leiden_keeps_connected_communities_and_reuses_ids_by_overlap() {
        let edges = [
            (0, 1),
            (0, 2),
            (0, 3),
            (1, 2),
            (1, 3),
            (2, 3),
            (4, 5),
            (4, 6),
            (4, 7),
            (5, 6),
            (5, 7),
            (6, 7),
        ];
        let (notes, mut graph) = fixture(9, &edges);
        let effective: Bitmap = (0..8).collect();
        let cancel = Cancellation::default();
        let first = LeidenSnapshot::compute(
            &GraphBuild {
                notes: &notes,
                sections: &graph,
            },
            &effective,
            &cancel,
        )
        .unwrap();
        let left = first.cluster(0).unwrap().clone();
        let right = first.cluster(4).unwrap().clone();
        assert_ne!(left, right);
        assert_eq!(first.members[&left].cardinality(), 4);
        assert_eq!(first.members[&right].cardinality(), 4);
        assert!(first.cluster(8).is_none());

        graph.clusters = first.expanded();
        graph.outgoing[3].push(4);
        graph.incoming[4].push(3);
        let next = LeidenSnapshot::compute(
            &GraphBuild {
                notes: &notes,
                sections: &graph,
            },
            &effective,
            &cancel,
        )
        .unwrap();
        assert_eq!(next.cluster(0), Some(&left));
        assert_eq!(next.cluster(4), Some(&right));
        graph.clusters = next.expanded();
        let view = GraphBuild {
            notes: &notes,
            sections: &graph,
        };
        let authorized: Bitmap = (0..8).collect();
        let filtered: Bitmap = [0, 1, 2, 3, 4, 5, 6].into_iter().collect();
        let response = plan_graph(
            &view,
            cut(),
            &GraphTier::Superclusters,
            &authorized,
            &filtered,
            None,
            || false,
        )
        .unwrap();
        assert_eq!(response.result.nodes.len(), 2);
        assert!(response.result.nodes.iter().all(|node| node.card.is_none()));
        assert_eq!(response.result.edges.len(), 1);
        assert_eq!(response.result.edges[0].weight, 1.0);
        assert_eq!(response.result.hidden_count, 1);

        // Unauthorized cluster must return ResourceNotFound instead of empty nodes.
        let left_only: Bitmap = (0..4).collect();
        let err = plan_graph(
            &view,
            cut(),
            &GraphTier::Lens {
                project: None,
                tags: Vec::new(),
                cluster: Some(right),
            },
            &left_only,
            &left_only,
            None,
            || false,
        );
        assert!(matches!(
            err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }
}
