use super::{Eligible, align::Overlay, retry_snapshot};
use crate::{
    engine::{Clock, internal},
    lexical::{HitKey, LexicalHit},
    vector::ChunkMetadata,
};
use notarium_core::{
    DomainResult,
    error::PortError,
    ids::NoteId,
    model::DenseNodeId,
    ports::{SpaceContext, StructuralReadPort, StructuralSnapshot},
    query::Predicate,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
};

#[doc(hidden)]
pub struct Candidate {
    pub note: NoteId,
    pub score: f64,
    pub chunks: Vec<ChunkMetadata>,
    best_rank: usize,
}

impl Candidate {
    fn new(note: NoteId) -> Self {
        Self {
            note,
            score: 0.0,
            chunks: Vec::new(),
            best_rank: usize::MAX,
        }
    }

    fn branch(&mut self, rank: usize) {
        self.score += 1.0 / (60.0 + rank as f64);
        self.best_rank = self.best_rank.min(rank);
    }
}

#[doc(hidden)]
pub fn fuse(
    lexical: Vec<LexicalHit>,
    vectors: Vec<crate::vector::VectorHit>,
    browse: bool,
) -> Vec<Candidate> {
    let mut rows = BTreeMap::new();
    for (index, hit) in lexical.into_iter().enumerate() {
        if let HitKey::Note(note) = hit.key {
            let row = rows
                .entry(note.clone())
                .or_insert_with(|| Candidate::new(note));
            if browse {
                row.score = 1.0;
            } else {
                row.branch(index + 1);
            }
        }
    }
    let mut distinct = 0;
    for hit in vectors {
        let note = &hit.metadata.note;
        let row = rows
            .entry(note.clone())
            .or_insert_with(|| Candidate::new(note.clone()));
        if row.chunks.is_empty() {
            distinct += 1;
            row.branch(distinct);
        }
        row.chunks.push(hit.metadata);
    }
    let mut ranked: Vec<_> = rows.into_values().collect();
    ranked.sort_by(order);
    ranked
}

fn order(left: &Candidate, right: &Candidate) -> Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| left.best_rank.cmp(&right.best_rank))
        .then_with(|| left.note.cmp(&right.note))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn expand(
    candidates: &mut Vec<Candidate>,
    snapshot: &dyn StructuralSnapshot,
    structural: &dyn StructuralReadPort,
    ctx: &SpaceContext,
    clock: &Clock,
    eligible: &Eligible,
    predicate: &Predicate,
    overlay: &Overlay,
    depth: u8,
) -> Result<(), PortError> {
    let generation = snapshot.cut().generation;
    let mut seed_entries = Vec::new();
    let mut seed_notes = Vec::new();
    for seed in candidates.iter().take(16) {
        if let Some(node) = retry_snapshot(snapshot, clock, || snapshot.lookup(&seed.note)).await? {
            seed_notes.push(seed.note.clone());
            seed_entries.push((seed.note.clone(), seed.score, node));
        }
    }
    if seed_entries.is_empty() {
        return Ok(());
    }

    let mut live_cache = HashMap::<NoteId, bool>::new();
    resolve_live(structural, ctx, clock, &mut live_cache, &seed_notes).await?;

    struct SeedState {
        score: f64,
        seen: HashSet<u32>,
        frontier: Vec<DenseNodeId>,
    }
    let mut states = Vec::new();
    for (note, score, node) in seed_entries {
        if live_cache.get(&note).copied().unwrap_or(false) {
            states.push(SeedState {
                score,
                seen: HashSet::from([node.index(generation)?]),
                frontier: vec![node],
            });
        }
    }
    if states.is_empty() {
        return Ok(());
    }

    let mut boosts = BTreeMap::<NoteId, f64>::new();
    for weight in [0.25, 0.10].into_iter().take(usize::from(depth)) {
        let mut layer_edges: Vec<(usize, DenseNodeId, NoteId, f64)> = Vec::new();
        let mut layer_notes: Vec<NoteId> = Vec::new();
        for (seed_idx, state) in states.iter_mut().enumerate() {
            let frontier = std::mem::take(&mut state.frontier);
            for via in frontier {
                let nbrs = retry_snapshot(snapshot, clock, || neighbors(snapshot, via)).await?;
                let penalty = 1.0 + (1.0 + nbrs.len() as f64).ln();
                for neighbor in nbrs {
                    let pos = neighbor.index(generation)?;
                    if !state.seen.insert(pos) {
                        continue;
                    }
                    let note =
                        retry_snapshot(snapshot, clock, || snapshot.note_id(neighbor)).await?;
                    let admitted = match overlay.get(&note) {
                        Some(None) => false,
                        Some(Some(row)) => eligible.overlay_allowed(predicate, row),
                        None => {
                            retry_snapshot(snapshot, clock, || {
                                eligible.node_allowed(snapshot, neighbor)
                            })
                            .await?
                        }
                    };
                    if !admitted {
                        continue;
                    }
                    if !live_cache.contains_key(&note) {
                        layer_notes.push(note.clone());
                    }
                    layer_edges.push((seed_idx, neighbor, note, state.score * weight / penalty));
                }
            }
        }
        if layer_edges.is_empty() {
            break;
        }
        resolve_live(structural, ctx, clock, &mut live_cache, &layer_notes).await?;
        for (seed_idx, neighbor, note, delta) in layer_edges {
            if !live_cache.get(&note).copied().unwrap_or(false) {
                continue;
            }
            *boosts.entry(note).or_default() += delta;
            states[seed_idx].frontier.push(neighbor);
        }
    }

    for candidate in candidates.iter_mut() {
        candidate.score += boosts.remove(&candidate.note).unwrap_or(0.0);
    }
    candidates.extend(boosts.into_iter().map(|(note, score)| Candidate {
        score,
        ..Candidate::new(note)
    }));
    candidates.sort_by(order);
    Ok(())
}

async fn resolve_live(
    structural: &dyn StructuralReadPort,
    ctx: &SpaceContext,
    clock: &Clock,
    cache: &mut HashMap<NoteId, bool>,
    notes: &[NoteId],
) -> Result<(), PortError> {
    let mut missing = Vec::new();
    let mut queued = HashSet::new();
    for note in notes {
        if !cache.contains_key(note) && queued.insert(note) {
            missing.push(note.clone());
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let mut check_ctx = ctx.clone();
    check_ctx.budget = clock.remaining()?;
    let flags = structural.filter_live_visible(&check_ctx, &missing).await?;
    if flags.len() != missing.len() {
        return Err(internal("projection_live_batch"));
    }
    for (note, visible) in missing.into_iter().zip(flags) {
        cache.insert(note, visible);
    }
    Ok(())
}

fn neighbors(
    snapshot: &dyn StructuralSnapshot,
    node: DenseNodeId,
) -> DomainResult<Vec<DenseNodeId>> {
    let generation = snapshot.cut().generation;
    let source = node.index(generation)?;
    let mut positions = snapshot
        .outgoing(node)?
        .take(64)
        .chain(snapshot.incoming(node)?.take(64))
        .map(|neighbor| neighbor.index(generation))
        .collect::<DomainResult<Vec<_>>>()?;
    positions.retain(|&position| position != source);
    positions.sort_unstable();
    positions.dedup();
    Ok(positions
        .into_iter()
        .take(64)
        .map(|position| DenseNodeId::new(generation, position))
        .collect())
}
