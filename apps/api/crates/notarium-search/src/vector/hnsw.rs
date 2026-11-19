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

pub(super) fn greedily_descend(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entry: u32,
    levels: impl Iterator<Item = u8>,
    budget: Option<SearchBudget<'_>>,
) -> Result<Neighbor, VectorError> {
    let mut nearest = scorer.score_node(graph, entry);
    for level in levels {
        loop {
            if let Some(budget) = budget {
                budget.check()?;
            }
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
    Ok(nearest)
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
    entry: Neighbor,
    config: Exploration<'_>,
    eligible: impl Fn(u32) -> bool,
    mut visit: impl FnMut(u32) -> bool,
) -> Result<Explored, VectorError> {
    let mut wave = BinaryHeap::new();
    let mut best = BinaryHeap::with_capacity(config.result_capacity + 1);
    let mut evaluations = 1;
    visit(entry.slot);
    wave.push(entry);
    if eligible(entry.slot) {
        best.push(Reverse(entry));
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

pub(super) fn keep_best(heap: &mut BinaryHeap<Reverse<Neighbor>>, item: Neighbor, limit: usize) {
    if heap.len() < limit {
        heap.push(Reverse(item));
    } else if let Some(mut lowest) = heap.peek_mut()
        && item > lowest.0
    {
        *lowest = Reverse(item);
    }
}

pub(super) fn finish(heap: BinaryHeap<Reverse<Neighbor>>) -> Vec<Neighbor> {
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
    let anchor = greedily_descend(graph, scorer, entry, (1..=max_level).rev(), Some(budget))?;
    let mut visited = HashSet::with_capacity(width * 8);
    let mut explored = explore(
        graph,
        scorer,
        anchor,
        Exploration {
            level: 0,
            result_capacity: width,
            max_evaluations: width * 48,
            budget: Some(budget),
        },
        eligible,
        |slot| visited.insert(slot),
    )?;
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
                None,
            )?;
            for layer in (0..=self.max_level.min(level)).rev() {
                self.visits.next(self.nodes.len());
                let explored = explore(
                    &graph,
                    scorer,
                    anchor,
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
        self.nodes[node as usize].edges[usize::from(layer)] =
            diversify(&graph, candidates, degree(layer))?;
        Ok(())
    }
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

fn node_level(key: &[u8; 32], slot: u32) -> u8 {
    let mut hasher = blake3::Hasher::new();
    hasher.update(key);
    hasher.update(&slot.to_le_bytes());
    let hash = hasher.finalize();
    let sample = u64::from_le_bytes(hash.as_bytes()[..8].try_into().expect("eight bytes"));
    // Each additional layer occurs with probability 1 / M. With M=16 this
    // is the geometric distribution of leading groups of four zero bits.
    (sample.leading_zeros() as u8 / 4).min(MAX_LEVEL)
}
