use super::{Eligible, align::Overlay};
use crate::{
    lexical::{HitKey, LexicalHit},
    vector::ChunkMetadata,
};
use notarium_core::{
    DomainResult, error::PortError, ids::NoteId, model::DenseNodeId, ports::StructuralSnapshot,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashSet},
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

pub(super) fn expand(
    candidates: &mut Vec<Candidate>,
    snapshot: &dyn StructuralSnapshot,
    eligible: &Eligible,
    overlay: &Overlay,
    depth: u8,
    live: impl Fn(&NoteId) -> Result<bool, PortError>,
) -> Result<(), PortError> {
    let mut boosts = BTreeMap::<NoteId, f64>::new();
    let generation = snapshot.cut().generation;
    for seed in candidates.iter().take(16) {
        let Some(node) = snapshot.lookup(&seed.note) else {
            continue;
        };
        if !live(&seed.note)? {
            continue;
        }
        let mut seen = HashSet::from([node.index(generation)?]);
        let mut frontier = vec![node];
        for weight in [0.25, 0.10].into_iter().take(usize::from(depth)) {
            let mut next = Vec::new();
            for via in frontier {
                let neighbors = neighbors(snapshot, via)?;
                let penalty = 1.0 + (1.0 + neighbors.len() as f64).ln();
                for neighbor in neighbors {
                    if !seen.insert(neighbor.index(generation)?)
                        || !eligible.node_allowed(snapshot, neighbor)?
                    {
                        continue;
                    }
                    let note = snapshot.note_id(neighbor)?;
                    if overlay.contains_key(&note) || !live(&note)? {
                        continue;
                    }
                    *boosts.entry(note).or_default() += seed.score * weight / penalty;
                    next.push(neighbor);
                }
            }
            frontier = next;
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

fn neighbors(
    snapshot: &dyn StructuralSnapshot,
    node: DenseNodeId,
) -> DomainResult<Vec<DenseNodeId>> {
    let generation = snapshot.cut().generation;
    let mut positions = snapshot
        .outgoing(node)?
        .take(64)
        .chain(snapshot.incoming(node)?.take(64))
        .map(|node| node.index(generation))
        .collect::<DomainResult<Vec<_>>>()?;
    positions.sort_unstable();
    positions.dedup();
    Ok(positions
        .into_iter()
        .take(64)
        .map(|position| DenseNodeId::new(generation, position))
        .collect())
}
