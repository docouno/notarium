use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
};

use croaring::{Bitmap, Portable};
use notarium_core::{
    DomainError, DomainResult,
    error::ValidationReason,
    ids::{ClusterId, NoteId},
    model::HistoryScope,
};

use super::GraphAdjacency;

const MAX_LEVELS: usize = 32;
const MAX_LOCAL_PASSES: usize = 32;

pub(crate) struct LeidenSnapshot {
    assignments: Vec<u32>,
    pub members: BTreeMap<ClusterId, Bitmap>,
    ids: Vec<ClusterId>,
}

const NO_COMMUNITY: u32 = u32::MAX;

impl LeidenSnapshot {
    pub fn compute(
        adjacency: &impl GraphAdjacency,
        scope: &HistoryScope,
        effective: &Bitmap,
    ) -> DomainResult<Self> {
        let mut compact = vec![u32::MAX; adjacency.node_count() as usize];
        let mut originals = Vec::with_capacity(effective.cardinality() as usize);
        for node in effective.iter() {
            let position = compact
                .get_mut(node as usize)
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            *position = originals.len() as u32;
            originals.push(node);
        }
        let mut weights = vec![BTreeMap::new(); originals.len()];
        for (source, &dense) in originals.iter().enumerate() {
            for target in adjacency.outgoing(dense) {
                let Some(&target) = compact.get(target as usize) else {
                    return Err(DomainError::validation(ValidationReason::InvalidState));
                };
                if target != u32::MAX && target as usize != source {
                    *weights[source].entry(target as usize).or_default() += 1;
                    *weights[target as usize].entry(source).or_default() += 1;
                }
            }
        }
        let graph = WeightedGraph::new(weights);
        let partition = partition(graph);

        let mut anchors = BTreeMap::<usize, &NoteId>::new();
        let mut overlaps = BTreeMap::new();
        let mut previously_used = BTreeSet::new();
        for (&dense, &community) in originals.iter().zip(&partition) {
            let note = adjacency
                .note_id(dense)
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            let anchor = anchors.entry(community).or_insert(note);
            *anchor = (*anchor).min(note);
            if let Some(previous) = adjacency.cluster(dense) {
                previously_used.insert(previous.clone());
                *overlaps.entry((community, previous)).or_insert(0u32) += 1;
            }
        }
        let ids_by_community = stable_ids(scope, &anchors, overlaps, previously_used);
        let mut ids = Vec::with_capacity(ids_by_community.len());
        let mut id_slots = BTreeMap::new();
        for (community, id) in ids_by_community {
            id_slots.insert(community, ids.len() as u32);
            ids.push(id);
        }

        let mut assignments = vec![NO_COMMUNITY; adjacency.node_count() as usize];
        let mut members = BTreeMap::<_, Bitmap>::new();
        for (dense, community) in originals.into_iter().zip(partition) {
            let slot = id_slots[&community];
            assignments[dense as usize] = slot;
            members
                .entry(ids[slot as usize].clone())
                .or_default()
                .add(dense);
        }
        Ok(Self {
            assignments,
            members,
            ids,
        })
    }

    pub fn cluster(&self, node: u32) -> Option<&ClusterId> {
        self.assignments
            .get(node as usize)
            .and_then(|&slot| self.ids.get(slot as usize))
    }

    pub fn expanded(&self) -> Vec<Option<ClusterId>> {
        self.assignments
            .iter()
            .map(|&slot| self.ids.get(slot as usize).cloned())
            .collect()
    }

    pub fn from_members(
        node_count: u32,
        members: BTreeMap<ClusterId, Bitmap>,
    ) -> DomainResult<Self> {
        let mut assignments = vec![NO_COMMUNITY; node_count as usize];
        let mut ids = Vec::with_capacity(members.len());
        for (id, nodes) in &members {
            if nodes.is_empty() {
                return Err(DomainError::validation(ValidationReason::InvalidState));
            }
            let slot = ids.len() as u32;
            ids.push(id.clone());
            for node in nodes.iter() {
                let position = assignments
                    .get_mut(node as usize)
                    .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
                if *position != NO_COMMUNITY {
                    return Err(DomainError::validation(ValidationReason::InvalidState));
                }
                *position = slot;
            }
        }
        Ok(Self {
            assignments,
            members,
            ids,
        })
    }

    pub fn estimated_bytes(&self) -> usize {
        self.assignments.capacity() * size_of::<u32>()
            + self
                .members
                .values()
                .map(|members| {
                    // The serializers include container metadata. Reserve extra
                    // room for allocated containers and the ordered lookup tables.
                    256 + members.get_serialized_size_in_bytes::<Portable>() * 2
                })
                .sum::<usize>()
    }
}

fn stable_ids(
    scope: &HistoryScope,
    anchors: &BTreeMap<usize, &NoteId>,
    overlaps: BTreeMap<(usize, ClusterId), u32>,
    mut reserved: BTreeSet<ClusterId>,
) -> BTreeMap<usize, ClusterId> {
    let mut pairs = overlaps
        .into_iter()
        .map(|((community, old), overlap)| (Reverse(overlap), old, anchors[&community], community))
        .collect::<Vec<_>>();
    pairs.sort_unstable();
    let mut used = BTreeSet::new();
    let mut result = BTreeMap::new();
    for (_, old, _, community) in pairs {
        if !result.contains_key(&community) && used.insert(old.clone()) {
            result.insert(community, old);
        }
    }
    for (&community, &anchor) in anchors {
        result.entry(community).or_insert_with(|| {
            for salt in 0u64.. {
                let mut digest = blake3::Hasher::new();
                digest.update(b"notarium.leiden.cluster.v1\0");
                digest.update(scope.incarnation.as_bytes());
                digest.update(scope.space_id.as_str().as_bytes());
                digest.update(b"\0");
                digest.update(anchor.as_str().as_bytes());
                digest.update(&salt.to_le_bytes());
                let mut bytes = [0; 16];
                bytes.copy_from_slice(&digest.finalize().as_bytes()[..16]);
                let id = ClusterId::from_bytes(bytes);
                if reserved.insert(id.clone()) {
                    return id;
                }
            }
            unreachable!("the cluster identity namespace is larger than a dense graph");
        });
    }
    result
}

type Neighbors = Vec<(usize, u64)>;

/// Directed rows hold both ends of each undirected edge. Aggregated loops
/// therefore contribute twice their weight to degree, as required by modularity.
struct WeightedGraph {
    neighbors: Vec<Neighbors>,
    degree: Vec<u64>,
    mass: u64,
}

impl WeightedGraph {
    fn new(rows: Vec<BTreeMap<usize, u64>>) -> Self {
        let degree: Vec<_> = rows.iter().map(|row| row.values().sum()).collect();
        let mass = degree.iter().sum();
        let neighbors = rows
            .into_iter()
            .map(|row| row.into_iter().collect())
            .collect();
        Self {
            neighbors,
            degree,
            mass,
        }
    }

    fn len(&self) -> usize {
        self.neighbors.len()
    }

    fn aggregate(&self, parties: &[usize], count: usize) -> Self {
        let mut rows = vec![BTreeMap::new(); count];
        for (node, neighbors) in self.neighbors.iter().enumerate() {
            for &(other, weight) in neighbors {
                *rows[parties[node]].entry(parties[other]).or_default() += weight;
            }
        }
        Self::new(rows)
    }

    fn neighbor_weights(&self, node: usize, labels: &[usize]) -> BTreeMap<usize, u64> {
        let mut weights = BTreeMap::new();
        for &(other, weight) in &self.neighbors[node] {
            if other != node {
                *weights.entry(labels[other]).or_default() += weight;
            }
        }
        weights
    }

    fn gain(&self, degree: u64, community_degree: u64, edges: u64) -> i128 {
        i128::from(edges) * i128::from(self.mass)
            - i128::from(degree) * i128::from(community_degree)
    }
}

/// Leiden local movement, connected refinement and aggregation. Candidate
/// selection maximizes modularity gain with a stable tie-break, so identical
/// input has identical output without a dependency on process RNG state.
fn partition(mut graph: WeightedGraph) -> Vec<usize> {
    let mut original_to_level = (0..graph.len()).collect::<Vec<_>>();
    let mut coarse = original_to_level.clone();
    for level in 0..MAX_LEVELS {
        local_move(&graph, &mut coarse);
        coarse = connected_components(&graph, &coarse);
        if level + 1 == MAX_LEVELS || graph.mass == 0 {
            break;
        }
        let refined = refine(&graph, &coarse);
        let (refined, refined_count) = compact_labels(&refined);
        if refined_count == graph.len() {
            break;
        }
        let mut next_coarse = vec![0; refined_count];
        for (&subcommunity, &community) in refined.iter().zip(&coarse) {
            next_coarse[subcommunity] = community;
        }
        (coarse, _) = compact_labels(&next_coarse);
        for node in &mut original_to_level {
            *node = refined[*node];
        }
        graph = graph.aggregate(&refined, refined_count);
    }
    original_to_level
        .into_iter()
        .map(|node| coarse[node])
        .collect()
}

fn local_move(graph: &WeightedGraph, labels: &mut [usize]) {
    let mut sizes = vec![0u32; graph.len()];
    let mut degrees = vec![0u64; graph.len()];
    for (node, &label) in labels.iter().enumerate() {
        sizes[label] += 1;
        degrees[label] += graph.degree[node];
    }
    let mut empty = (0..graph.len())
        .filter(|&label| sizes[label] == 0)
        .collect::<BTreeSet<_>>();
    for _ in 0..MAX_LOCAL_PASSES {
        let mut moved = false;
        for node in 0..graph.len() {
            let from = labels[node];
            let degree = graph.degree[node];
            if degree == 0 {
                continue;
            }
            let weights = graph.neighbor_weights(node, labels);
            sizes[from] -= 1;
            degrees[from] -= degree;
            if sizes[from] == 0 {
                empty.insert(from);
            }
            let mut best = from;
            let mut best_gain = graph.gain(
                degree,
                degrees[from],
                weights.get(&from).copied().unwrap_or(0),
            );
            for (&candidate, &edges) in &weights {
                let gain = graph.gain(degree, degrees[candidate], edges);
                if gain > best_gain {
                    best = candidate;
                    best_gain = gain;
                }
            }
            if best_gain < 0
                && let Some(&singleton) = empty.first()
            {
                best = singleton;
            }
            if sizes[best] == 0 {
                empty.remove(&best);
            }
            sizes[best] += 1;
            degrees[best] += degree;
            labels[node] = best;
            moved |= best != from;
        }
        if !moved {
            break;
        }
    }
}

fn connected_components(graph: &WeightedGraph, labels: &[usize]) -> Vec<usize> {
    let mut components = vec![usize::MAX; graph.len()];
    let mut pending = Vec::new();
    for (node, &label) in labels.iter().enumerate() {
        if components[node] != usize::MAX {
            continue;
        }
        components[node] = node;
        pending.push(node);
        while let Some(current) = pending.pop() {
            for &(other, _) in &graph.neighbors[current] {
                if labels[other] == label && components[other] == usize::MAX {
                    components[other] = node;
                    pending.push(other);
                }
            }
        }
    }
    components
}

fn refine(graph: &WeightedGraph, coarse: &[usize]) -> Vec<usize> {
    let mut labels = (0..graph.len()).collect::<Vec<_>>();
    let mut sizes = vec![1u32; graph.len()];
    let mut degrees = graph.degree.clone();
    let mut boundary = vec![0u64; graph.len()];
    let mut coarse_degrees = vec![0u64; graph.len()];
    for (node, neighbors) in graph.neighbors.iter().enumerate() {
        let label = coarse[node];
        coarse_degrees[label] += degrees[node];
        boundary[node] = neighbors
            .iter()
            .filter(|&&(other, _)| other != node && coarse[other] == label)
            .map(|&(_, weight)| weight)
            .sum();
    }
    for (node, &label) in coarse.iter().enumerate() {
        let mass = coarse_degrees[label];
        let degree = graph.degree[node];
        if sizes[node] != 1
            || labels[node] != node
            || graph.gain(degree, mass - degree, boundary[node]) < 0
        {
            continue;
        }
        let mut best = None;
        let mut best_gain = 0;
        for (target, edges) in graph.neighbor_weights(node, &labels) {
            let target_degree = degrees[target];
            if coarse[target] != label
                || graph.gain(target_degree, mass - target_degree, boundary[target]) < 0
            {
                continue;
            }
            let gain = graph.gain(degree, target_degree, edges);
            if gain > best_gain {
                best = Some((target, edges));
                best_gain = gain;
            }
        }
        if let Some((target, edges)) = best {
            labels[node] = target;
            sizes[node] = 0;
            sizes[target] += 1;
            degrees[target] += degree;
            boundary[target] = boundary[target] + boundary[node] - 2 * edges;
        }
    }
    labels
}

fn compact_labels(labels: &[usize]) -> (Vec<usize>, usize) {
    let mut seen = BTreeMap::new();
    let mut compact = Vec::with_capacity(labels.len());
    for &label in labels {
        let count = seen.len();
        compact.push(*seen.entry(label).or_insert(count));
    }
    (compact, seen.len())
}
