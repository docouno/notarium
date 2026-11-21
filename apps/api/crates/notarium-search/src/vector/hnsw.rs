use super::{
    GLOBAL_EVAL_BUDGET, M, M0, MAX_LEVEL, SearchBudget, VectorChunk, VectorError, simd::Dot,
};
use crate::vector::QuantizedVector;
use notarium_core::{
    classes::DocClass,
    ids::{ContentDigest, NoteId},
    ports::Cancellation,
};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BinaryHeap, HashMap, HashSet},
};

const EF_CONSTRUCTION: usize = 128;

pub(super) trait Graph {
    fn vector(&self, node: u32) -> Result<(&[i8], f32), VectorError>;
    fn neighbors(
        &self,
        node: u32,
        level: u8,
    ) -> Result<impl Iterator<Item = u32> + '_, VectorError>;
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

    fn score_node(self, graph: &impl Graph, node: u32) -> Result<Neighbor, VectorError> {
        let (vector, scale) = graph.vector(node)?;
        Ok(self.score(node, vector, scale))
    }
}

fn greedily_descend(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entry: u32,
    levels: impl Iterator<Item = u8>,
) -> Result<Neighbor, VectorError> {
    let mut nearest = scorer.score_node(graph, entry)?;
    for level in levels {
        loop {
            let mut best: Option<Neighbor> = None;
            for node in graph.neighbors(nearest.slot, level)? {
                let scored = scorer.score_node(graph, node)?;
                if best.is_none_or(|current| scored > current) {
                    best = Some(scored);
                }
            }
            match best {
                Some(next) if next > nearest => nearest = next,
                _ => break,
            }
        }
    }
    Ok(nearest)
}

#[derive(Clone, Copy)]
pub(super) enum StopCheck<'a> {
    None,
    Cancel(&'a Cancellation),
    Budget(SearchBudget<'a>),
}

impl StopCheck<'_> {
    pub(super) fn check(self) -> Result<(), VectorError> {
        match self {
            Self::None => Ok(()),
            Self::Cancel(cancel) => {
                if cancel.is_cancelled() {
                    Err(VectorError::Cancelled)
                } else {
                    Ok(())
                }
            }
            Self::Budget(budget) => budget.check(),
        }
    }
}

pub(super) struct Exploration<'a> {
    pub level: u8,
    pub result_capacity: usize,
    pub max_evaluations: usize,
    pub stop: StopCheck<'a>,
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
    mut eligible: impl FnMut(u32) -> Result<bool, VectorError>,
    mut visit: impl FnMut(u32) -> bool,
) -> Result<Explored, VectorError> {
    let mut wave = BinaryHeap::new();
    let mut best = BinaryHeap::with_capacity(config.result_capacity + 1);
    let mut evaluations = 0usize;
    for entry in entries {
        if visit(entry.slot) {
            evaluations += 1;
            wave.push(entry);
            if eligible(entry.slot)? {
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
        for slot in graph.neighbors(candidate.slot, config.level)? {
            if !visit(slot) {
                continue;
            }
            if evaluations >= config.max_evaluations {
                break 'walk;
            }
            if evaluations.is_multiple_of(64) {
                config.stop.check()?;
            }
            evaluations += 1;
            let next = scorer.score_node(graph, slot)?;
            if best.len() < config.result_capacity
                || best.peek().is_some_and(|worst| next > worst.0)
            {
                wave.push(next);
                if eligible(slot)? {
                    keep_best(&mut best, next, config.result_capacity);
                }
            }
        }
    }
    config.stop.check()?;
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

#[allow(clippy::too_many_arguments)]
pub(super) fn query_graph(
    graph: &impl Graph,
    scorer: Similarity<'_>,
    entry: u32,
    max_level: u8,
    top_k: usize,
    active_segments: usize,
    budget: SearchBudget<'_>,
    eligible: impl FnMut(u32) -> Result<bool, VectorError>,
) -> Result<Explored, VectorError> {
    let active = active_segments.max(1);
    let width = if active <= 2 {
        top_k.saturating_mul(2).clamp(64, 256)
    } else {
        top_k.clamp(64, 160)
    };
    let max_evaluations = (GLOBAL_EVAL_BUDGET / active).clamp(1_500, 9_600);
    let mut visited = HashSet::with_capacity(width * 8);
    // Carry several upper-layer candidates into layer zero. A single
    // greedy entry can settle in a nearby dense cluster and miss the target.
    const UPPER_WIDTH: usize = 12;
    let mut anchors = vec![scorer.score_node(graph, entry)?];
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
                stop: StopCheck::Budget(budget),
            },
            |_| Ok(true),
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
            max_evaluations,
            stop: StopCheck::Budget(budget),
        },
        eligible,
        |slot| visited.insert(slot),
    )?;
    explored.evaluations += upper_evaluations;
    explored.neighbors.truncate(top_k);
    Ok(explored)
}

pub(super) struct CompactMeta {
    pub note_ord: u32,
    pub key: ContentDigest,
    pub source: ContentDigest,
    pub folder: u32,
    pub class: DocClass,
    pub tokens: u16,
    pub span_start: u32,
    pub context_len: u16,
    pub spans_len: u8,
}

pub(super) struct BuilderGraph {
    pub dimension: usize,
    pub stride: usize,
    pub scales: Vec<f32>,
    pub vectors: Vec<i8>,
    pub base_edges: Vec<[u32; M0]>,
    pub base_lens: Vec<u8>,
    pub upper_edges: Vec<Option<Box<[Vec<u32>]>>>,
    pub metas: Vec<CompactMeta>,
    pub spans: Vec<(u32, u32)>,
    pub notes: Vec<NoteId>,
    pub note_lookup: HashMap<NoteId, u32>,
    pub entry: u32,
    pub max_level: u8,
    visits: VisitEpochs,
}

struct BuilderView<'a> {
    stride: usize,
    scales: &'a [f32],
    vectors: &'a [i8],
    base_edges: &'a [[u32; M0]],
    base_lens: &'a [u8],
    upper_edges: &'a [Option<Box<[Vec<u32>]>>],
}

impl Graph for BuilderView<'_> {
    fn vector(&self, node: u32) -> Result<(&[i8], f32), VectorError> {
        let index = node as usize;
        let start = index * self.stride;
        Ok((
            &self.vectors[start..start + self.stride],
            self.scales[index],
        ))
    }

    fn neighbors(
        &self,
        node: u32,
        level: u8,
    ) -> Result<impl Iterator<Item = u32> + '_, VectorError> {
        let index = node as usize;
        let slice: &[u32] = if level == 0 {
            &self.base_edges[index][..usize::from(self.base_lens[index])]
        } else {
            self.upper_edges[index]
                .as_deref()
                .and_then(|layers| layers.get(usize::from(level) - 1))
                .map(Vec::as_slice)
                .unwrap_or(&[])
        };
        Ok(slice.iter().copied())
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
    pub fn new(dimension: usize) -> Self {
        Self {
            dimension,
            stride: dimension.next_multiple_of(64),
            scales: Vec::new(),
            vectors: Vec::new(),
            base_edges: Vec::new(),
            base_lens: Vec::new(),
            upper_edges: Vec::new(),
            metas: Vec::new(),
            spans: Vec::new(),
            notes: Vec::new(),
            note_lookup: HashMap::new(),
            entry: 0,
            max_level: 0,
            visits: VisitEpochs::default(),
        }
    }

    pub fn len(&self) -> usize {
        self.metas.len()
    }

    pub fn is_empty(&self) -> bool {
        self.metas.is_empty()
    }

    pub fn vector_at(&self, slot: usize) -> QuantizedVector {
        let start = slot * self.stride;
        QuantizedVector::from_parts(
            self.scales[slot],
            self.vectors[start..start + self.stride].to_vec(),
            self.dimension,
        )
        .expect("builder vector already validated")
    }

    pub fn node_level_at(&self, slot: usize) -> u8 {
        self.upper_edges[slot]
            .as_deref()
            .map_or(0, |layers| layers.len() as u8)
    }

    fn view(&self) -> BuilderView<'_> {
        BuilderView {
            stride: self.stride,
            scales: &self.scales,
            vectors: &self.vectors,
            base_edges: &self.base_edges,
            base_lens: &self.base_lens,
            upper_edges: &self.upper_edges,
        }
    }

    pub(super) fn append_node_data(
        &mut self,
        chunk: VectorChunk,
        base_row: [u32; M0],
        base_len: u8,
        upper: Option<Box<[Vec<u32>]>>,
    ) -> Result<(), VectorError> {
        let span_start = u32::try_from(self.spans.len()).map_err(|_| VectorError::BufferFull)?;
        let total_spans = chunk.metadata.context.len() + chunk.metadata.spans.len();
        if self
            .spans
            .len()
            .checked_add(total_spans)
            .is_none_or(|count| count > u32::MAX as usize)
        {
            return Err(VectorError::BufferFull);
        }
        let note_ord = if let Some(&ord) = self.note_lookup.get(&chunk.metadata.note) {
            ord
        } else {
            let ord = u32::try_from(self.notes.len()).map_err(|_| VectorError::BufferFull)?;
            self.notes.push(chunk.metadata.note.clone());
            self.note_lookup.insert(chunk.metadata.note, ord);
            ord
        };
        for span in chunk.metadata.context.iter().chain(&chunk.metadata.spans) {
            self.spans.push((span.start() as u32, span.end() as u32));
        }
        self.scales.push(chunk.vector.scale());
        self.vectors.extend_from_slice(chunk.vector.values());
        self.base_edges.push(base_row);
        self.base_lens.push(base_len);
        self.upper_edges.push(upper);
        self.metas.push(CompactMeta {
            note_ord,
            key: chunk.metadata.key,
            source: chunk.metadata.source,
            folder: chunk.metadata.folder,
            class: chunk.metadata.class,
            tokens: chunk.metadata.tokens,
            span_start,
            context_len: chunk.metadata.context.len() as u16,
            spans_len: chunk.metadata.spans.len() as u8,
        });
        Ok(())
    }

    pub fn push(
        &mut self,
        chunk: VectorChunk,
        cancel: Option<&Cancellation>,
    ) -> Result<(), VectorError> {
        let stop = cancel.map_or(StopCheck::None, StopCheck::Cancel);
        stop.check()?;
        let slot = u32::try_from(self.len()).map_err(|_| VectorError::BufferFull)?;
        if slot == u32::MAX {
            return Err(VectorError::BufferFull);
        }
        let level = node_level(chunk.metadata.key.as_bytes(), slot);
        if self.is_empty() {
            let upper =
                (level > 0).then(|| vec![Vec::new(); usize::from(level)].into_boxed_slice());
            self.append_node_data(chunk, [0; M0], 0, upper)?;
            self.entry = slot;
            self.max_level = level;
            return Ok(());
        }
        let scorer = Similarity::new(chunk.vector.values(), chunk.vector.scale())?;
        let mut neighbors_by_level = vec![Vec::new(); usize::from(level) + 1];
        {
            let view = BuilderView {
                stride: self.stride,
                scales: &self.scales,
                vectors: &self.vectors,
                base_edges: &self.base_edges,
                base_lens: &self.base_lens,
                upper_edges: &self.upper_edges,
            };
            let mut anchor = greedily_descend(
                &view,
                scorer,
                self.entry,
                (level.saturating_add(1)..=self.max_level).rev(),
            )?;
            let node_count = self.metas.len();
            for layer in (0..=self.max_level.min(level)).rev() {
                self.visits.next(node_count);
                let explored = explore(
                    &view,
                    scorer,
                    [anchor],
                    Exploration {
                        level: layer,
                        result_capacity: EF_CONSTRUCTION,
                        max_evaluations: usize::MAX,
                        stop,
                    },
                    |_| Ok(true),
                    |candidate| self.visits.visit(candidate),
                )?;
                if let Some(nearest) = explored.neighbors.first() {
                    anchor = *nearest;
                }
                neighbors_by_level[usize::from(layer)] =
                    diversify(&view, explored.neighbors, degree(layer))?;
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
        let mut base_row = [0u32; M0];
        base_row[..base.len()].copy_from_slice(base);
        let base_len = base.len() as u8;
        let upper = (level > 0).then(|| neighbors_by_level[1..].to_vec().into_boxed_slice());
        self.append_node_data(chunk, base_row, base_len, upper)?;
        let attach_top = self.max_level.min(level);
        for (layer, attached) in neighbors_by_level
            .into_iter()
            .enumerate()
            .take(usize::from(attach_top) + 1)
        {
            for neighbor in attached {
                self.add_reverse_edge(neighbor, layer as u8, slot, cancel)?;
            }
        }
        if level > self.max_level {
            self.entry = slot;
            self.max_level = level;
        }
        Ok(())
    }

    fn add_reverse_edge(
        &mut self,
        node: u32,
        layer: u8,
        other: u32,
        cancel: Option<&Cancellation>,
    ) -> Result<(), VectorError> {
        if cancel.is_some_and(Cancellation::is_cancelled) {
            return Err(VectorError::Cancelled);
        }
        let index = node as usize;
        if layer == 0 {
            let len = usize::from(self.base_lens[index]);
            if len < M0 {
                self.base_edges[index][len] = other;
                self.base_lens[index] = (len + 1) as u8;
                return Ok(());
            }
            let mut slots = Vec::with_capacity(M0 + 1);
            slots.extend_from_slice(&self.base_edges[index][..M0]);
            slots.push(other);
            let chosen = self.prune_neighbors(node, 0, slots)?;
            self.base_edges[index].fill(0);
            self.base_edges[index][..chosen.len()].copy_from_slice(&chosen);
            self.base_lens[index] = chosen.len() as u8;
            return Ok(());
        }
        let upper_index = usize::from(layer) - 1;
        let edges = &mut self.upper_edges[index]
            .as_mut()
            .expect("node with reverse upper edge has upper layers")[upper_index];
        edges.push(other);
        if edges.len() <= M {
            return Ok(());
        }
        let slots = std::mem::take(edges);
        let chosen = self.prune_neighbors(node, layer, slots)?;
        self.upper_edges[index]
            .as_mut()
            .expect("node with reverse upper edge has upper layers")[upper_index] = chosen;
        Ok(())
    }

    fn prune_neighbors(
        &self,
        node: u32,
        layer: u8,
        slots: Vec<u32>,
    ) -> Result<Vec<u32>, VectorError> {
        let view = self.view();
        let (query, scale) = view.vector(node)?;
        let scorer = Similarity::new(query, scale)?;
        let mut candidates: Vec<_> = slots
            .into_iter()
            .map(|candidate| scorer.score_node(&view, candidate))
            .collect::<Result<_, _>>()?;
        candidates.sort_unstable_by(|left, right| right.cmp(left));
        let (required, candidates): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .partition(|candidate| layer == 0 && linked_at_base(node, candidate.slot));
        let mut chosen = diversify(
            &view,
            candidates,
            degree(layer).saturating_sub(required.len()),
        )?;
        chosen.extend(required.into_iter().map(|candidate| candidate.slot));
        Ok(chosen)
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
    let (first, scale) = graph.vector(candidates[0].slot)?;
    let mut all_equal = true;
    for candidate in &candidates[1..] {
        let (vector, candidate_scale) = graph.vector(candidate.slot)?;
        if candidate_scale.to_bits() != scale.to_bits() || vector != first {
            all_equal = false;
            break;
        }
    }
    if all_equal {
        return Ok(candidates
            .into_iter()
            .take(limit)
            .map(|candidate| candidate.slot)
            .collect());
    }
    let mut keep = Vec::with_capacity(limit);
    let mut near_duplicates = Vec::new();
    for candidate in candidates {
        let (query, scale) = graph.vector(candidate.slot)?;
        let scorer = Similarity::new(query, scale)?;
        let mut dominated = false;
        for &other in &keep {
            if scorer.score_node(graph, other)?.score > candidate.score {
                dominated = true;
                break;
            }
        }
        if dominated {
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
        fn vector(&self, node: u32) -> Result<(&[i8], f32), VectorError> {
            let vector = self.0.get(node as usize).ok_or(VectorError::CorruptIndex)?;
            Ok((vector.values(), vector.scale()))
        }

        fn neighbors(
            &self,
            node: u32,
            level: u8,
        ) -> Result<impl Iterator<Item = u32> + '_, VectorError> {
            let edges: &[u32] = match (level, node) {
                (1, 0) => &[1, 2],
                (1, 1) => &[0],
                (1, 2) => &[0, 3],
                (1, 3) => &[2],
                (0, 3) => &[4],
                (0, 4) => &[3],
                _ => &[],
            };
            Ok(edges.iter().copied())
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
        assert_eq!(
            greedily_descend(&graph, scorer, 0, [1].into_iter())
                .unwrap()
                .slot,
            1
        );
        let cancellation = Cancellation::default();
        let budget = SearchBudget {
            cancellation: &cancellation,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        let nearest = query_graph(&graph, scorer, 0, 1, 1, 1, budget, |_| Ok(true)).unwrap();
        assert_eq!(nearest.neighbors[0].slot, 4);
    }
}
