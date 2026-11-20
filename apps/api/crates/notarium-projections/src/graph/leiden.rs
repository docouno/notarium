use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet, VecDeque},
};

use croaring::{Bitmap, Portable};
use notarium_canonical::codec::cancelled_not_committed;
use notarium_core::{
    DomainError, DomainResult,
    error::{PortError, ValidationReason},
    ids::ClusterId,
    model::HistoryScope,
    ports::Cancellation,
};

use super::GraphAdjacency;

const MAX_LEVELS: usize = 32;
const MAX_LOCAL_PASSES: usize = 32;
const CANCEL_CHECK_STRIDE: usize = 1024;

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
        cancel: &Cancellation,
    ) -> Result<Self, PortError> {
        check_cancel(cancel)?;
        let mut compact = vec![u32::MAX; adjacency.node_count() as usize];
        let mut originals = Vec::with_capacity(effective.cardinality() as usize);
        for node in effective.iter() {
            let position = compact
                .get_mut(node as usize)
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            *position = originals.len() as u32;
            originals.push(node);
        }

        // Build symmetric undirected weighted CSR directly without N BTreeMaps.
        let n = originals.len();
        let mut directed_edges = Vec::new();
        for (source, &dense) in originals.iter().enumerate() {
            if source & (CANCEL_CHECK_STRIDE - 1) == 0 {
                check_cancel(cancel)?;
            }
            for target in adjacency.outgoing(dense) {
                let Some(&target) = compact.get(target as usize) else {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                };
                if target != u32::MAX && target as usize != source {
                    directed_edges.push((source as u32, target, 1u64));
                    directed_edges.push((target, source as u32, 1u64));
                }
            }
        }
        let graph = WeightedGraph::from_edges(n, directed_edges);
        let partition = partition(graph, cancel)?;
        check_cancel(cancel)?;

        let mut anchors = BTreeMap::<usize, &str>::new();
        let mut prev_keys = std::collections::HashMap::<crate::index::ClusterKey<'_>, usize>::new();
        let mut prev_ids = Vec::<ClusterId>::new();
        let mut raw_overlaps = std::collections::HashMap::<(usize, usize), u32>::new();
        for (idx, (&dense, &community)) in originals.iter().zip(&partition).enumerate() {
            if idx & (CANCEL_CHECK_STRIDE - 1) == 0 {
                check_cancel(cancel)?;
            }
            let note = adjacency
                .note_id_str(dense)
                .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
            let anchor = anchors.entry(community).or_insert(note);
            *anchor = (*anchor).min(note);
            if let Some(previous) = adjacency.cluster_key(dense) {
                let prev_slot = if let Some(&slot) = prev_keys.get(&previous) {
                    slot
                } else {
                    let slot = prev_ids.len();
                    prev_keys.insert(previous, slot);
                    prev_ids.push(previous.into_cluster_id());
                    slot
                };
                *raw_overlaps.entry((community, prev_slot)).or_insert(0u32) += 1;
            }
        }
        let previously_used: BTreeSet<ClusterId> = prev_ids.iter().cloned().collect();
        let overlaps: BTreeMap<(usize, ClusterId), u32> = raw_overlaps
            .into_iter()
            .map(|((community, slot), count)| ((community, prev_ids[slot].clone()), count))
            .collect();
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
                .map(|members| 256 + members.get_serialized_size_in_bytes::<Portable>() * 2)
                .sum::<usize>()
    }
}

fn check_cancel(cancel: &Cancellation) -> Result<(), PortError> {
    if cancel.is_cancelled() {
        Err(cancelled_not_committed(
            "projection_leiden",
            "graph settlement cancelled",
        ))
    } else {
        Ok(())
    }
}

fn stable_ids(
    scope: &HistoryScope,
    anchors: &BTreeMap<usize, &str>,
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
                digest.update(anchor.as_bytes());
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

/// Flat CSR undirected weighted graph. Directed rows hold both ends of each
/// undirected edge; aggregated loops therefore contribute twice their weight
/// to degree, as required by modularity.
struct WeightedGraph {
    offsets: Vec<usize>,
    edges: Vec<(usize, u64)>,
    degree: Vec<u64>,
    mass: u64,
}

impl WeightedGraph {
    fn from_edges(node_count: usize, mut raw: Vec<(u32, u32, u64)>) -> Self {
        raw.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let mut offsets = vec![0usize; node_count + 1];
        let mut edges: Vec<(usize, u64)> = Vec::with_capacity(raw.len());
        let mut degree = vec![0u64; node_count];
        let mut mass = 0u64;

        let mut iter = raw.into_iter().peekable();
        for node in 0..node_count {
            offsets[node] = edges.len();
            while let Some(&(src, dst, weight)) = iter.peek() {
                if src as usize != node {
                    break;
                }
                iter.next();
                let dst = dst as usize;
                let has_edge = edges.len() > offsets[node];
                if has_edge
                    && let Some(last) = edges.last_mut()
                    && last.0 == dst
                {
                    last.1 += weight;
                } else {
                    edges.push((dst, weight));
                }
                degree[node] += weight;
                mass += weight;
            }
        }
        offsets[node_count] = edges.len();

        Self {
            offsets,
            edges,
            degree,
            mass,
        }
    }

    fn len(&self) -> usize {
        self.degree.len()
    }

    fn neighbors(&self, node: usize) -> &[(usize, u64)] {
        &self.edges[self.offsets[node]..self.offsets[node + 1]]
    }

    fn aggregate(
        &self,
        parties: &[usize],
        count: usize,
        cancel: &Cancellation,
    ) -> Result<Self, PortError> {
        let mut raw = Vec::with_capacity(self.edges.len());
        for node in 0..self.len() {
            if node & (CANCEL_CHECK_STRIDE - 1) == 0 {
                check_cancel(cancel)?;
            }
            let p_src = parties[node] as u32;
            for &(other, weight) in self.neighbors(node) {
                raw.push((p_src, parties[other] as u32, weight));
            }
        }
        Ok(Self::from_edges(count, raw))
    }

    fn gain(&self, degree: u64, community_degree: u64, edges: u64) -> i128 {
        i128::from(edges) * i128::from(self.mass)
            - i128::from(degree) * i128::from(community_degree)
    }
}

/// Reusable O(1)-reset scratch accumulator for per-node community weights.
struct WeightScratch {
    weights: Vec<u64>,
    touched: Vec<usize>,
}

impl WeightScratch {
    fn new(len: usize) -> Self {
        Self {
            weights: vec![0; len],
            touched: Vec::new(),
        }
    }

    fn accumulate(&mut self, neighbors: &[(usize, u64)], node: usize, labels: &[usize]) {
        for &(other, weight) in neighbors {
            if other != node {
                let comm = labels[other];
                if self.weights[comm] == 0 {
                    self.touched.push(comm);
                }
                self.weights[comm] += weight;
            }
        }
        // Deterministic ascending community order for stable tie-breaking.
        self.touched.sort_unstable();
    }

    fn clear(&mut self) {
        for comm in self.touched.drain(..) {
            self.weights[comm] = 0;
        }
    }
}

/// Leiden fast local movement, connected refinement and aggregation. Candidate
/// selection maximizes modularity gain with a stable tie-break, so identical
/// input has identical output without a dependency on process RNG state.
fn partition(mut graph: WeightedGraph, cancel: &Cancellation) -> Result<Vec<usize>, PortError> {
    let mut original_to_level = (0..graph.len()).collect::<Vec<_>>();
    let mut coarse = original_to_level.clone();
    for level in 0..MAX_LEVELS {
        check_cancel(cancel)?;
        local_move(&graph, &mut coarse, cancel)?;
        coarse = connected_components(&graph, &coarse, cancel)?;
        if level + 1 == MAX_LEVELS || graph.mass == 0 {
            break;
        }
        let refined = refine(&graph, &coarse, cancel)?;
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
        graph = graph.aggregate(&refined, refined_count, cancel)?;
    }
    Ok(original_to_level
        .into_iter()
        .map(|node| coarse[node])
        .collect())
}

fn local_move(
    graph: &WeightedGraph,
    labels: &mut [usize],
    cancel: &Cancellation,
) -> Result<(), PortError> {
    let n = graph.len();
    let mut sizes = vec![0u32; n];
    let mut degrees = vec![0u64; n];
    for (node, &label) in labels.iter().enumerate() {
        sizes[label] += 1;
        degrees[label] += graph.degree[node];
    }
    let mut empty = (0..n)
        .filter(|&label| sizes[label] == 0)
        .collect::<BTreeSet<_>>();
    let mut scratch = WeightScratch::new(n);

    // Fast Local Move queue: seed all nodes in deterministic index order, then
    // re-enqueue only neighbors outside the moved node's new community.
    let mut queue: VecDeque<usize> = (0..n).collect();
    let mut in_queue = vec![true; n];
    let max_pops = n.saturating_mul(MAX_LOCAL_PASSES).max(n);
    let mut pops = 0usize;

    while let Some(node) = queue.pop_front() {
        if pops & (CANCEL_CHECK_STRIDE - 1) == 0 {
            check_cancel(cancel)?;
        }
        pops += 1;
        if pops > max_pops {
            break;
        }
        in_queue[node] = false;
        let from = labels[node];
        let degree = graph.degree[node];
        if degree == 0 {
            continue;
        }
        scratch.accumulate(graph.neighbors(node), node, labels);
        sizes[from] -= 1;
        degrees[from] -= degree;
        if sizes[from] == 0 {
            empty.insert(from);
        }
        let mut best = from;
        let mut best_gain = graph.gain(degree, degrees[from], scratch.weights[from]);
        for &candidate in &scratch.touched {
            let gain = graph.gain(degree, degrees[candidate], scratch.weights[candidate]);
            if gain > best_gain {
                best = candidate;
                best_gain = gain;
            }
        }
        scratch.clear();
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
        if best != from {
            for &(neighbor, _) in graph.neighbors(node) {
                if neighbor != node && labels[neighbor] != best && !in_queue[neighbor] {
                    in_queue[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
    }
    Ok(())
}

fn connected_components(
    graph: &WeightedGraph,
    labels: &[usize],
    cancel: &Cancellation,
) -> Result<Vec<usize>, PortError> {
    let mut components = vec![usize::MAX; graph.len()];
    let mut pending = Vec::new();
    for (node, &label) in labels.iter().enumerate() {
        if node & (CANCEL_CHECK_STRIDE - 1) == 0 {
            check_cancel(cancel)?;
        }
        if components[node] != usize::MAX {
            continue;
        }
        components[node] = node;
        pending.push(node);
        while let Some(current) = pending.pop() {
            for &(other, _) in graph.neighbors(current) {
                if labels[other] == label && components[other] == usize::MAX {
                    components[other] = node;
                    pending.push(other);
                }
            }
        }
    }
    Ok(components)
}

fn refine(
    graph: &WeightedGraph,
    coarse: &[usize],
    cancel: &Cancellation,
) -> Result<Vec<usize>, PortError> {
    let n = graph.len();
    let mut labels = (0..n).collect::<Vec<_>>();
    let mut sizes = vec![1u32; n];
    let mut degrees = graph.degree.clone();
    let mut boundary = vec![0u64; n];
    let mut coarse_degrees = vec![0u64; n];
    for node in 0..n {
        if node & (CANCEL_CHECK_STRIDE - 1) == 0 {
            check_cancel(cancel)?;
        }
        let label = coarse[node];
        coarse_degrees[label] += degrees[node];
        boundary[node] = graph
            .neighbors(node)
            .iter()
            .filter(|&&(other, _)| other != node && coarse[other] == label)
            .map(|&(_, weight)| weight)
            .sum();
    }
    let mut scratch = WeightScratch::new(n);
    for (node, &label) in coarse.iter().enumerate() {
        if node & (CANCEL_CHECK_STRIDE - 1) == 0 {
            check_cancel(cancel)?;
        }
        let mass = coarse_degrees[label];
        let degree = graph.degree[node];
        if sizes[node] != 1
            || labels[node] != node
            || graph.gain(degree, mass - degree, boundary[node]) < 0
        {
            continue;
        }
        scratch.accumulate(graph.neighbors(node), node, &labels);
        let mut best = None;
        let mut best_gain = 0;
        for &target in &scratch.touched {
            let edges = scratch.weights[target];
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
        scratch.clear();
        if let Some((target, edges)) = best {
            labels[node] = target;
            sizes[node] = 0;
            sizes[target] += 1;
            degrees[target] += degree;
            boundary[target] = boundary[target] + boundary[node] - 2 * edges;
        }
    }
    Ok(labels)
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
