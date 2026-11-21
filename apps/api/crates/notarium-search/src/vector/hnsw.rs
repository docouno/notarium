use super::{M, M0, MAX_LEVEL, SearchBudget, VectorChunk, VectorError, simd::Dot};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BinaryHeap, HashSet},
};

const EF_CONSTRUCTION: usize = 128;

pub(super) trait Graph {
    fn vector(&self, node: u32) -> (&[i8], f32);
    fn neighbors(&self, node: u32, level: u8) -> impl Iterator<Item = u32> + '_;
}

#[derive(Clone, Copy, Debug)]
pub struct Neighbor {
    pub slot: u32,
    pub score: f32,
}

impl PartialEq for Neighbor {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Neighbor {}
impl PartialOrd for Neighbor {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Neighbor {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score
            .total_cmp(&other.score)
            .then_with(|| other.slot.cmp(&self.slot))
    }
}

pub(super) struct ExactNeighbor<'a> {
    pub hit: Neighbor,
    pub note: &'a [u8],
    pub span: usize,
    pub key: &'a [u8],
}

impl PartialEq for ExactNeighbor<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for ExactNeighbor<'_> {}
impl PartialOrd for ExactNeighbor<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ExactNeighbor<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.hit
            .score
            .total_cmp(&other.hit.score)
            .then_with(|| {
                (other.note, other.span, other.key).cmp(&(self.note, self.span, self.key))
            })
            .then_with(|| other.hit.slot.cmp(&self.hit.slot))
    }
}

#[derive(Clone, Copy)]
pub(super) struct Similarity<'a> {
    dot: Dot<'a>,
    scale: f32,
}
impl<'a> Similarity<'a> {
    pub fn new(query: &'a [i8], scale: f32) -> Result<Self, VectorError> {
        Ok(Self {
            dot: Dot::new(query).ok_or(VectorError::InvalidDimension)?,
            scale,
        })
    }

    pub fn score(self, slot: u32, vector: &[i8], scale: f32) -> Neighbor {
        let dots = self
            .dot
            .dot(vector)
            .expect("graph and query dimensions are checked");
        Neighbor {
            slot,
            score: dots as f32 * self.scale * scale,
        }
    }

    fn score_node(self, graph: &impl Graph, node: u32) -> Neighbor {
        let (vector, scale) = graph.vector(node);
        self.score(node, vector, scale)
    }
}

fn greedily_descend(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entry: u32,
    levels: impl Iterator<Item = u8>,
) -> Neighbor {
    let mut nearest = scorer.score_node(graph, entry);
    for level in levels {
        loop {
            let next = graph
                .neighbors(nearest.slot, level)
                .map(|node| scorer.score_node(graph, node))
                .max();
            match next {
                Some(next) if next > nearest => nearest = next,
                _ => break,
            }
        }
    }
    nearest
}

pub(super) struct Exploration<'a> {
    pub level: u8,
    pub result_capacity: usize,
    pub max_evaluations: usize,
    pub budget: Option<SearchBudget<'a>>,
}

pub(super) struct Explored {
    pub neighbors: Vec<Neighbor>,
    pub evaluations: usize,
}

pub(super) fn explore(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entries: impl IntoIterator<Item = Neighbor>,
    config: Exploration<'_>,
    eligible: impl Fn(u32) -> bool,
    mut visit: impl FnMut(u32) -> bool,
) -> Result<Explored, VectorError> {
    let mut wave = BinaryHeap::new();
    let mut best = BinaryHeap::with_capacity(config.result_capacity + 1);
    let mut evaluations = 0usize;
    for entry in entries {
        if visit(entry.slot) {
            evaluations += 1;
            wave.push(entry);
            if eligible(entry.slot) {
                keep_best(&mut best, entry, config.result_capacity);
            }
        }
    }
    'walk: while let Some(candidate) = wave.pop() {
        if best.len() == config.result_capacity
            && best.peek().is_some_and(|worst| candidate < worst.0)
        {
            break;
        }
        for slot in graph.neighbors(candidate.slot, config.level) {
            if !visit(slot) {
                continue;
            }
            if evaluations >= config.max_evaluations {
                break 'walk;
            }
            if evaluations.is_multiple_of(64)
                && let Some(budget) = config.budget
            {
                budget.check()?;
            }
            evaluations += 1;
            let next = scorer.score_node(graph, slot);
            if best.len() < config.result_capacity
                || best.peek().is_some_and(|worst| next > worst.0)
            {
                wave.push(next);
                if eligible(slot) {
                    keep_best(&mut best, next, config.result_capacity);
                }
            }
        }
    }
    if let Some(budget) = config.budget {
        budget.check()?;
    }
    Ok(Explored {
        neighbors: finish(best),
        evaluations,
    })
}

pub(super) fn keep_best<T: Ord>(heap: &mut BinaryHeap<Reverse<T>>, item: T, limit: usize) {
    if heap.len() < limit {
        heap.push(Reverse(item));
    } else if heap.peek().is_some_and(|lowest| item > lowest.0) {
        *heap.peek_mut().expect("heap already has a minimum") = Reverse(item);
    }
}

pub(super) fn finish<T: Ord>(heap: BinaryHeap<Reverse<T>>) -> Vec<T> {
    heap.into_sorted_vec()
        .into_iter()
        .map(|item| item.0)
        .collect()
}

pub(super) fn query_graph(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entry: u32,
    max_level: u8,
    top_k: usize,
    budget: SearchBudget<'_>,
    eligible: impl Fn(u32) -> bool,
) -> Result<Explored, VectorError> {
    let width = top_k.saturating_mul(2).clamp(64, 256);
    let mut visited = HashSet::with_capacity(width * 8);
    // Carry several upper-layer candidates into layer zero. A single
    // greedy entry can settle in a nearby dense cluster and miss the target.
    const UPPER_WIDTH: usize = 12;
    let mut anchors = vec![scorer.score_node(graph, entry)];
    let mut upper_evaluations = 0;
    for level in (1..=max_level).rev() {
        visited.clear();
        let explored = explore(
            graph,
            scorer,
            anchors,
            Exploration {
                level,
                result_capacity: UPPER_WIDTH,
                max_evaluations: UPPER_WIDTH * 32,
                budget: Some(budget),
            },
            |_| true,
            |slot| visited.insert(slot),
        )?;
        upper_evaluations += explored.evaluations;
        anchors = explored.neighbors;
    }
    visited.clear();
    let mut explored = explore(
        graph,
        scorer,
        anchors,
        Exploration {
            level: 0,
            // Oversampling can request more hits than the capped exploration width.
            result_capacity: width.max(top_k),
            max_evaluations: width * 48,
            budget: Some(budget),
        },
        eligible,
        |slot| visited.insert(slot),
    )?;
    explored.evaluations += upper_evaluations;
    explored.neighbors.truncate(top_k);
    Ok(explored)
}

pub(super) struct Node {
    pub chunk: VectorChunk,
    pub edges: Vec<Vec<u32>>,
}

pub(super) struct BuilderGraph {
    pub nodes: Vec<Node>,
    pub entry: u32,
    pub max_level: u8,
    visits: VisitEpochs,
}

struct NodeView<'a>(&'a [Node]);
impl Graph for NodeView<'_> {
    fn vector(&self, node: u32) -> (&[i8], f32) {
        let vector = &self.0[node as usize].chunk.vector;
        (vector.values(), vector.scale())
    }
    fn neighbors(&self, node: u32, level: u8) -> impl Iterator<Item = u32> + '_ {
        self.0[node as usize]
            .edges
            .get(usize::from(level))
            .into_iter()
            .flatten()
            .copied()
    }
}

#[derive(Default)]
struct VisitEpochs {
    seen: Vec<u32>,
    epoch: u32,
}
impl VisitEpochs {
    fn next(&mut self, nodes: usize) {
        if self.epoch == u32::MAX {
            self.seen.fill(0);
            self.epoch = 1;
        } else {
            self.epoch += 1;
        }
        self.seen.resize(nodes, 0);
    }
    fn visit(&mut self, slot: u32) -> bool {
        let marked = &mut self.seen[slot as usize];
        if *marked == self.epoch {
            return false;
        }
        *marked = self.epoch;
        true
    }
}

impl BuilderGraph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            entry: 0,
            max_level: 0,
            visits: VisitEpochs::default(),
        }
    }

    pub fn push(&mut self, chunk: VectorChunk) -> Result<(), VectorError> {
        let slot = u32::try_from(self.nodes.len()).map_err(|_| VectorError::BufferFull)?;
        if slot == u32::MAX {
            return Err(VectorError::BufferFull);
        }
        let level = node_level(chunk.metadata.key.as_bytes(), slot);
        if self.nodes.is_empty() {
            self.entry = slot;
            self.max_level = level;
            self.nodes.push(Node {
                chunk,
                edges: vec![Vec::new(); usize::from(level) + 1],
            });
            return Ok(());
        }
        let scorer = Similarity::new(chunk.vector.values(), chunk.vector.scale())?;
        let mut neighbors_by_level = vec![Vec::new(); usize::from(level) + 1];
        {
            let graph = NodeView(&self.nodes);
            let mut anchor = greedily_descend(
                &graph,
                scorer,
                self.entry,
                (level.saturating_add(1)..=self.max_level).rev(),
            );
            for layer in (0..=self.max_level.min(level)).rev() {
                self.visits.next(self.nodes.len());
                let explored = explore(
                    &graph,
                    scorer,
                    [anchor],
                    Exploration {
                        level: layer,
                        result_capacity: EF_CONSTRUCTION,
                        max_evaluations: usize::MAX,
                        budget: None,
                    },
                    |_| true,
                    |candidate| self.visits.visit(candidate),
                )?;
                if let Some(nearest) = explored.neighbors.first() {
                    anchor = *nearest;
                }
                neighbors_by_level[usize::from(layer)] =
                    diversify(&graph, explored.neighbors, degree(layer))?;
            }
        }
        // Keep a bounded spanning tree at layer zero. Equal vectors can otherwise
        // make every full reverse list prefer earlier slots over a new node.
        let parent = (slot - 1) / 2;
        let base = &mut neighbors_by_level[0];
        if !base.contains(&parent) {
            base.truncate(M0 - 1);
            base.push(parent);
        }
        self.nodes.push(Node {
            chunk,
            edges: neighbors_by_level,
        });
        for layer in 0..=self.max_level.min(level) {
            let attached = self.nodes[slot as usize].edges[usize::from(layer)].clone();
            for neighbor in attached {
                self.add_reverse_edge(neighbor, layer, slot)?;
            }
        }
        if level > self.max_level {
            self.entry = slot;
            self.max_level = level;
        }
        Ok(())
    }

    fn add_reverse_edge(&mut self, node: u32, layer: u8, other: u32) -> Result<(), VectorError> {
        let edges = &mut self.nodes[node as usize].edges[usize::from(layer)];
        edges.push(other);
        if edges.len() <= degree(layer) {
            return Ok(());
        }
        let graph = NodeView(&self.nodes);
        let (query, scale) = graph.vector(node);
        let scorer = Similarity::new(query, scale)?;
        let mut candidates: Vec<_> = graph
            .neighbors(node, layer)
            .map(|candidate| scorer.score_node(&graph, candidate))
            .collect();
        candidates.sort_unstable_by(|left, right| right.cmp(left));
        let (required, candidates): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .partition(|candidate| layer == 0 && linked_at_base(node, candidate.slot));
        let mut chosen = diversify(&graph, candidates, degree(layer) - required.len())?;
        chosen.extend(required.into_iter().map(|candidate| candidate.slot));
        self.nodes[node as usize].edges[usize::from(layer)] = chosen;
        Ok(())
    }
}

fn linked_at_base(left: u32, right: u32) -> bool {
    let (early, late) = if left < right {
        (left, right)
    } else {
        (right, left)
    };
    late > early && (late - 1) / 2 == early
}

fn diversify(
    graph: &impl Graph,
    candidates: Vec<Neighbor>,
    limit: usize,
) -> Result<Vec<u32>, VectorError> {
    if candidates.len() <= limit {
        return Ok(candidates
            .into_iter()
            .map(|neighbor| neighbor.slot)
            .collect());
    }
    let (first, scale) = graph.vector(candidates[0].slot);
    if candidates[1..].iter().all(|candidate| {
        let (vector, candidate_scale) = graph.vector(candidate.slot);
        candidate_scale.to_bits() == scale.to_bits() && vector == first
    }) {
        return Ok(candidates
            .into_iter()
            .take(limit)
            .map(|candidate| candidate.slot)
            .collect());
    }
    let mut keep = Vec::with_capacity(limit);
    let mut near_duplicates = Vec::new();
    for candidate in candidates {
        let (query, scale) = graph.vector(candidate.slot);
        let scorer = Similarity::new(query, scale)?;
        if keep
            .iter()
            .any(|&other| scorer.score_node(graph, other).score > candidate.score)
        {
            near_duplicates.push(candidate.slot);
        } else {
            keep.push(candidate.slot);
            if keep.len() == limit {
                return Ok(keep);
            }
        }
    }
    keep.extend(near_duplicates.into_iter().take(limit - keep.len()));
    Ok(keep)
}

fn degree(layer: u8) -> usize {
    if layer == 0 { M0 } else { M }
}

pub(super) fn node_level(key: &[u8; 32], slot: u32) -> u8 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(key);
    hasher.update(&slot.to_le_bytes());
    let hash = hasher.finalize();
    let sample = u64::from_le_bytes(hash.as_bytes()[..8].try_into().expect("eight bytes"));
    // Each additional layer occurs with probability 1 / M. With M=16 this
    // is the geometric distribution of leading groups of four zero bits.
    (sample.leading_zeros() as u8 / 4).min(MAX_LEVEL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector::QuantizedVector;
    use notarium_core::ports::Cancellation;
    use std::time::{Duration, Instant};

    struct TwoBranches(Vec<QuantizedVector>);

    impl Graph for TwoBranches {
        fn vector(&self, node: u32) -> (&[i8], f32) {
            let vector = &self.0[node as usize];
            (vector.values(), vector.scale())
        }

        fn neighbors(&self, node: u32, level: u8) -> impl Iterator<Item = u32> + '_ {
            let edges: &[u32] = match (level, node) {
                (1, 0) => &[1, 2],
                (1, 1) => &[0],
                (1, 2) => &[0, 3],
                (1, 3) => &[2],
                (0, 3) => &[4],
                (0, 4) => &[3],
                _ => &[],
            };
            edges.iter().copied()
        }
    }

    #[test]
    fn query_carries_a_lower_scoring_upper_layer_bridge_into_the_search() {
        let vector = |similarity: f32| {
            let mut components = [0.0f32; 64];
            components[0] = similarity;
            components[1] = (1.0 - similarity.powi(2)).sqrt();
            QuantizedVector::quantize(&components).unwrap()
        };
        let graph = TwoBranches(
            [0.45, 0.8, 0.25, 0.95, 1.0]
                .into_iter()
                .map(vector)
                .collect(),
        );
        let query = vector(1.0);
        let scorer = Similarity::new(query.values(), query.scale()).unwrap();
        assert_eq!(greedily_descend(&graph, scorer, 0, [1].into_iter()).slot, 1);
        let cancellation = Cancellation::default();
        let budget = SearchBudget {
            cancellation: &cancellation,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        let nearest = query_graph(&graph, scorer, 0, 1, 1, budget, |_| true).unwrap();
        assert_eq!(nearest.neighbors[0].slot, 4);
    }
}
