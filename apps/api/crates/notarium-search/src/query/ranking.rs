use super::{Eligible, hydrate::NoteAdmission, retry_snapshot};
use crate::{
    engine::{Clock, SearchEngine, internal},
    lexical::{HitKey, LexicalHit},
    vector::{ChunkMetadata, VectorHit},
};
use notarium_core::{
    DomainError, DomainResult,
    error::PortError,
    ids::NoteId,
    model::DenseNodeId,
    ports::{PageLimit, RecallQuery, StructuralSnapshot},
    query::Predicate,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
};

const GRAPH_SEEDS: usize = 16;
const GRAPH_FANOUT: u16 = 64;
// All hops share the same maximum work as two fully populated hops.
const MAX_GRAPH_PAGES: usize = GRAPH_SEEDS * (1 + GRAPH_FANOUT as usize);
const HOP_WEIGHTS: [f64; RecallQuery::MAX_GRAPH_DEPTH as usize] = [0.25, 0.10, 0.04];

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

// Each collector was asked for limit + 1. Vector results contain both the
// leading chunks and a representative per distinct note; only another note
// witnesses an unfinished note window.
pub(crate) fn trim_vector_window(vectors: &mut Vec<VectorHit>, limit: usize) -> bool {
    if vectors.len() <= limit {
        return false;
    }
    let mut notes = HashSet::new();
    let mut rank = 0;
    vectors.retain(|hit| {
        rank += 1;
        let first = notes.insert(hit.metadata.note.clone());
        rank <= limit || (first && notes.len() <= limit)
    });
    notes.len() > limit
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

pub(super) async fn expand(
    candidates: &mut Vec<Candidate>,
    snapshot: &dyn StructuralSnapshot,
    engine: &SearchEngine,
    admission: &mut NoteAdmission<'_>,
    eligible: &Eligible,
    predicate: &Predicate,
    depth: u8,
) -> Result<bool, PortError> {
    let clock = admission.clock;
    let generation = snapshot.cut().generation;
    let filtered = admission.recipient.is_some();
    let seed_window = if filtered {
        candidates.len()
    } else {
        candidates.len().min(GRAPH_SEEDS)
    };
    let mut live_cache = HashMap::<NoteId, bool>::new();
    struct SeedState {
        score: f64,
        seen: HashSet<u32>,
        frontier: Vec<DenseNodeId>,
    }
    let mut states = Vec::new();
    // The fused note window is already bounded. Missing projection nodes and
    // recipient rejections do not consume one of the 16 provider graph seeds.
    let mut seed_notes_left = seed_window;
    for batch in candidates[..seed_window].chunks(GRAPH_SEEDS) {
        let mut entries = Vec::new();
        for seed in batch {
            let node = retry_snapshot(snapshot, clock, || match snapshot.lookup(&seed.note) {
                Ok(node) => Ok(node),
                Err(DomainError::ResourceNotFound) => Ok(None),
                Err(error) => Err(error),
            })
            .await?;
            if let Some(node) = node {
                entries.push((seed, node));
            }
        }
        resolve_graph_notes(
            engine,
            admission,
            &mut live_cache,
            entries.iter().map(|(seed, _)| &seed.note),
            &mut seed_notes_left,
        )
        .await?;
        for (seed, node) in entries {
            if live_cache.get(&seed.note) == Some(&true) {
                states.push(SeedState {
                    score: seed.score,
                    seen: HashSet::from([node.index(generation)?]),
                    frontier: vec![node],
                });
                if states.len() == GRAPH_SEEDS {
                    break;
                }
            }
        }
        if states.len() == GRAPH_SEEDS {
            break;
        }
    }
    if states.is_empty() {
        return Ok(false);
    }

    let mut boosts = BTreeMap::<NoteId, f64>::new();
    let mut pages_left = MAX_GRAPH_PAGES;
    // Provider metadata reads share a distinct-neighbor budget across all
    // visits and hops, including neighbors that the recipient rejects.
    let mut new_notes_left = if filtered {
        MAX_GRAPH_PAGES
    } else {
        usize::MAX
    };
    let mut truncated = false;
    for weight in HOP_WEIGHTS.into_iter().take(usize::from(depth)) {
        let mut layer_edges: Vec<(DenseNodeId, NoteId)> = Vec::new();
        let mut visits = Vec::new();
        'frontier: for (seed_idx, state) in states.iter_mut().enumerate() {
            let frontier = std::mem::take(&mut state.frontier);
            for via in frontier {
                if pages_left == 0 {
                    truncated = true;
                    break 'frontier;
                }
                pages_left -= 1;
                let nbrs = match neighbors(snapshot, via, clock, filtered).await {
                    Ok(neighbors) => neighbors,
                    Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                    Err(error) => return Err(error),
                };
                let degree = nbrs.len();
                let start = layer_edges.len();
                for neighbor in nbrs {
                    if !filtered && !state.seen.insert(neighbor.index(generation)?) {
                        continue;
                    }
                    let Some(note) =
                        retry_snapshot(snapshot, clock, || match snapshot.note_id(neighbor) {
                            Ok(note) => Ok(Some(note)),
                            Err(DomainError::ResourceNotFound) => Ok(None),
                            Err(error) => Err(error),
                        })
                        .await?
                    else {
                        continue;
                    };
                    let eligible = match admission.overlay.get(&note) {
                        Some(None) => false,
                        Some(Some(row)) => eligible.overlay_allowed(predicate, row),
                        None => {
                            retry_snapshot(snapshot, clock, || {
                                match eligible.node_allowed(snapshot, neighbor) {
                                    Ok(allowed) => Ok(allowed),
                                    Err(DomainError::ResourceNotFound) => Ok(false),
                                    Err(error) => Err(error),
                                }
                            })
                            .await?
                        }
                    };
                    if eligible {
                        layer_edges.push((neighbor, note));
                    }
                }
                visits.push((seed_idx, degree, start..layer_edges.len()));
            }
        }
        if layer_edges.is_empty() {
            break;
        }
        truncated |= if filtered {
            resolve_recipient_visits(
                engine,
                admission,
                &mut live_cache,
                visits
                    .iter()
                    .map(|(_, _, range)| &layer_edges[range.clone()]),
                &mut new_notes_left,
            )
            .await?
        } else {
            resolve_graph_notes(
                engine,
                admission,
                &mut live_cache,
                layer_edges.iter().map(|(_, note)| note),
                &mut new_notes_left,
            )
            .await?
        };
        for (seed_idx, raw_degree, range) in visits {
            let admitted = layer_edges[range]
                .iter()
                .filter(|(_, note)| live_cache.get(note) == Some(&true))
                .take(usize::from(GRAPH_FANOUT));
            let degree = if filtered {
                admitted.clone().count()
            } else {
                raw_degree
            };
            let state = &mut states[seed_idx];
            let delta = state.score * weight / (1.0 + (1.0 + degree as f64).ln());
            for (neighbor, note) in admitted {
                if filtered && !state.seen.insert(neighbor.index(generation)?) {
                    continue;
                }
                *boosts.entry(note.clone()).or_default() += delta;
                state.frontier.push(*neighbor);
            }
        }
        if truncated {
            break;
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
    Ok(truncated)
}

async fn resolve_recipient_visits<'a>(
    engine: &SearchEngine,
    admission: &mut NoteAdmission<'_>,
    cache: &mut HashMap<NoteId, bool>,
    pages: impl Iterator<Item = &'a [(DenseNodeId, NoteId)]>,
    remaining: &mut usize,
) -> Result<bool, PortError> {
    // All visits get a first pass before any visit can spend the shared
    // metadata budget on its second half. Keep the unexamined slice and the
    // number of admitted neighbors still needed for each visit.
    let mut pending: Vec<_> = pages
        .filter(|page| !page.is_empty())
        .map(|page| (page, usize::from(GRAPH_FANOUT)))
        .collect();
    let mut truncated = false;
    fn edge_note(edge: &(DenseNodeId, NoteId)) -> &NoteId {
        &edge.1
    }
    while !pending.is_empty() {
        let notes = pending
            .iter()
            .flat_map(|(page, slots)| page.iter().take(*slots).map(edge_note));
        truncated |= resolve_graph_notes(engine, admission, cache, notes, remaining).await?;
        pending.retain_mut(|(page, slots)| {
            let (checked, rest) = page.split_at(page.len().min(*slots));
            if rest.is_empty() {
                return false;
            }
            let accepted = checked
                .iter()
                .filter(|(_, id)| cache.get(id) == Some(&true))
                .count();
            *slots -= accepted;
            *page = rest;
            *slots != 0
        });
    }
    Ok(truncated)
}

async fn resolve_graph_notes<'a>(
    engine: &SearchEngine,
    admission: &mut NoteAdmission<'_>,
    cache: &mut HashMap<NoteId, bool>,
    notes: impl Iterator<Item = &'a NoteId>,
    remaining: &mut usize,
) -> Result<bool, PortError> {
    let mut missing = Vec::new();
    let mut truncated = false;
    for note in notes {
        if cache.contains_key(note) {
            continue;
        }
        if *remaining == 0 {
            truncated = true;
            continue;
        }
        *remaining -= 1;
        cache.insert(note.clone(), false);
        missing.push(note.clone());
    }
    if missing.is_empty() {
        return Ok(truncated);
    }
    if admission.recipient.is_some() {
        let count = missing.len();
        for id in admission
            .select(engine, missing.into_iter(), |id| id, count, true)
            .await?
        {
            cache.insert(id, true);
        }
    } else {
        let mut ctx = admission.context.clone();
        ctx.budget = admission.clock.remaining()?;
        let flags = engine
            .services
            .deps
            .structural
            .filter_live_visible(&ctx, &missing)
            .await?;
        if flags.len() != missing.len() {
            return Err(internal("projection_live_batch"));
        }
        for (note, visible) in missing.into_iter().zip(flags) {
            cache.insert(note, visible);
        }
    }
    Ok(truncated)
}

async fn neighbors(
    snapshot: &dyn StructuralSnapshot,
    node: DenseNodeId,
    clock: &Clock,
    filtered: bool,
) -> Result<Vec<DenseNodeId>, PortError> {
    let generation = snapshot.cut().generation;
    let source = node.index(generation)?;
    let page = loop {
        match clock
            .within(snapshot.neighbor_page(node, PageLimit::new(GRAPH_FANOUT)?))
            .await
        {
            Err(PortError::Domain(error)) if super::is_not_ready(&error) => {
                clock.within(snapshot.wait_ready()).await?;
            }
            result => break result?,
        }
    };
    let mut positions = page
        .into_iter()
        .map(|neighbor| neighbor.index(generation))
        .collect::<DomainResult<Vec<_>>>()?;
    positions.retain(|&position| position != source);
    positions.sort_unstable();
    positions.dedup();
    Ok(positions
        .into_iter()
        .take(usize::from(GRAPH_FANOUT) * if filtered { 2 } else { 1 })
        .map(|position| DenseNodeId::new(generation, position))
        .collect())
}
