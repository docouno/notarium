use super::{Recall, align::Overlay, ranking::Candidate};
use crate::{
    embed::RemoteConservativeTokenizerBudget,
    engine::{Clock, SearchEngine, internal},
    lexical::{HitKey, LexicalHit},
    model::chunks_for,
};
use notarium_core::{
    classes::{ClassEgressFence, ContentPart, SearchContent, SearchPart},
    error::PortError,
    ids::NoteId,
    model::SnapshotCut,
    ports::{ChatSearchHit, NoteCard, PageLimit, SearchHit, SpaceContext},
};
use notarium_syntax::chunk::TokenizerBudget;
use std::collections::{BTreeMap, HashSet};

pub(super) struct Hydration<'a> {
    pub context: &'a SpaceContext,
    pub clock: &'a Clock,
    pub cut: &'a SnapshotCut,
    pub overlay: &'a Overlay,
    pub candidates: Vec<Candidate>,
    pub tokenizer: &'a (dyn TokenizerBudget + Send + Sync),
    pub top_k: usize,
    pub recall: Option<Recall>,
}

impl SearchEngine {
    pub(super) async fn hydrate_notes(
        &self,
        task: Hydration<'_>,
    ) -> Result<(Vec<SearchHit>, bool), PortError> {
        let Hydration {
            context,
            clock,
            cut,
            overlay,
            candidates,
            tokenizer,
            top_k,
            recall,
        } = task;
        let structural = &self.services.deps.structural;
        let mut selected = Vec::with_capacity(top_k);
        let mut truncated = false;
        for candidate in candidates {
            clock.remaining()?;
            if overlay.get(&candidate.note).is_some_and(Option::is_none)
                || !structural.is_live_visible(context, &candidate.note)?
            {
                continue;
            }
            if selected.len() == top_k {
                truncated = true;
                break;
            }
            selected.push(candidate);
        }
        if selected.is_empty() {
            return Ok((Vec::new(), truncated));
        }

        let projected: Vec<_> = selected
            .iter()
            .filter(|candidate| !overlay.contains_key(&candidate.note))
            .map(|candidate| candidate.note.clone())
            .collect();
        let mut ctx = context.clone();
        let mut cards: BTreeMap<NoteId, NoteCard> = BTreeMap::new();
        if !projected.is_empty() {
            ctx.budget = clock.remaining()?;
            let hydrated = structural
                .hydrate(ctx.clone(), cut.clone(), projected.clone())
                .await?;
            if hydrated.len() != projected.len() {
                return Err(internal("projection_search_batch"));
            }
            for (id, card) in projected.into_iter().zip(hydrated) {
                let Some(card) = card else { continue };
                if card.document.provenance().reference().note_id != id
                    || card.document.provenance().reference().space_id != cut.scope.space_id
                {
                    return Err(internal("projection_search_identity"));
                }
                cards.insert(id, card);
            }
        }
        for candidate in &selected {
            let Some(Some(row)) = overlay.get(&candidate.note) else {
                continue;
            };
            let Ok(document) =
                ClassEgressFence::search_metadata(row.document.metadata(), context.auth())
            else {
                continue;
            };
            cards.insert(
                candidate.note.clone(),
                NoteCard {
                    document,
                    title: row.title.clone(),
                    path: row.path.clone(),
                    preview: row.preview.clone(),
                },
            );
        }
        let mut ordered: Vec<_> = selected
            .into_iter()
            .filter_map(|candidate| cards.remove(&candidate.note).map(|card| (candidate, card)))
            .collect();
        if ordered.is_empty() {
            return Ok((Vec::new(), truncated));
        }
        let targets = ordered
            .iter()
            .map(|(candidate, card)| {
                (
                    candidate.note.clone(),
                    card.document.provenance().revision().clone(),
                )
            })
            .collect();
        ctx.budget = clock.remaining()?;
        // Authenticate the exact carrier chosen for each card, including any
        // receipt-bound revision. This rereads live canonical egress facts.
        let documents = self
            .services
            .deps
            .carriers
            .read_authorized_documents_for_search(ctx, targets)
            .await?;
        if documents.len() != ordered.len() {
            return Err(internal("canonical_search_batch"));
        }
        let mut hits = Vec::new();
        for ((candidate, card), document) in ordered.drain(..).zip(documents) {
            clock.remaining()?;
            let Some(document) = document else { continue };
            if document.reference().note_id != candidate.note
                || document.reference().space_id != cut.scope.space_id
                || document.revision() != card.document.provenance().revision()
                || document.digest() != card.document.provenance().digest()
            {
                return Err(internal("canonical_search_identity"));
            }
            let Ok(content) = ClassEgressFence::search(document.as_ref().clone(), context.auth())
            else {
                continue;
            };
            let descriptors = hit_chunks(&candidate, &content, tokenizer)?;
            let maximum = if recall.is_some() { usize::MAX } else { 3 };
            let chunks = descriptors
                .into_iter()
                .take(maximum)
                .filter_map(|descriptor| {
                    let part = ContentPart::from_chunk(document.clone(), descriptor).ok()?;
                    ClassEgressFence::search_part(part, context.auth()).ok()
                })
                .collect();
            hits.push(SearchHit {
                card,
                score: candidate.score,
                chunks,
            });
        }
        Ok((hits, truncated))
    }

    pub(super) fn finish_note_hits(
        &self,
        ctx: &SpaceContext,
        clock: &Clock,
        hits: Vec<SearchHit>,
        recall: Option<Recall>,
    ) -> Result<(Vec<SearchHit>, bool), PortError> {
        let mut visible = Vec::with_capacity(hits.len());
        let structural = &self.services.deps.structural;
        for hit in hits {
            clock.remaining()?;
            let note = &hit.card.document.provenance().reference().note_id;
            if structural.is_live_visible(ctx, note)? {
                visible.push(hit);
            }
        }
        let truncated = recall.is_some_and(|recall| pack(&mut visible, recall.tokens));
        Ok((visible, truncated))
    }

    pub(super) async fn hydrate_chats(
        &self,
        ctx: &SpaceContext,
        hits: Vec<LexicalHit>,
        limit: PageLimit,
    ) -> Result<(Vec<ChatSearchHit>, bool), PortError> {
        let mut ids = Vec::new();
        let mut scores = BTreeMap::new();
        for hit in hits {
            if let HitKey::Chat { thread, entry, .. } = hit.key {
                let key = (thread, entry);
                if scores.insert(key.clone(), f64::from(hit.score)).is_none() {
                    ids.push(key);
                }
            }
        }
        if ids.is_empty() {
            return Ok((Vec::new(), false));
        }
        let (rows, truncated) = self
            .services
            .deps
            .carriers
            .hydrate_live_visible_chat_hits(ctx, &ids, limit)
            .await?;
        let hits = rows
            .into_iter()
            .filter_map(|chat| {
                let score = scores.remove(&(chat.thread.clone(), chat.entry))?;
                Some(ChatSearchHit {
                    thread: chat.thread,
                    entry: chat.entry,
                    kind: chat.kind,
                    project_folder: chat.project_folder,
                    author: chat.author,
                    snippet: chat.text.chars().take(240).collect(),
                    score,
                })
            })
            .collect();
        Ok((hits, truncated))
    }
}

fn hit_chunks(
    candidate: &Candidate,
    content: &SearchContent,
    tokenizer: &dyn TokenizerBudget,
) -> Result<Vec<notarium_core::document::ChunkDescriptor>, PortError> {
    let profile = tokenizer.profile();
    let mut seen = HashSet::new();
    let descriptors: Vec<_> = candidate
        .chunks
        .iter()
        .filter(|chunk| chunk.source == content.provenance().digest() && seen.insert(chunk.key))
        .filter_map(|chunk| chunk.descriptor(content.text(), profile.clone()).ok())
        .collect();
    if !descriptors.is_empty() {
        return Ok(descriptors);
    }
    match chunks_for(content, tokenizer) {
        Ok(chunks) => Ok(chunks),
        Err(_) => Ok(chunks_for(
            content,
            &RemoteConservativeTokenizerBudget::lexical_fallback(),
        )?),
    }
}

fn pack(hits: &mut Vec<SearchHit>, tokens: u32) -> bool {
    let mut remaining = tokens;
    let mut selected: Vec<Vec<bool>> = hits
        .iter()
        .map(|hit| vec![false; hit.chunks.len()])
        .collect();
    let mut truncated = false;
    for (hit, mask) in hits.iter().zip(&mut selected) {
        if let Some(part) = hit.chunks.first() {
            truncated |= !choose(part, &mut mask[0], &mut remaining);
        }
    }
    let mut tail = Vec::new();
    for (note_rank, hit) in hits.iter().enumerate() {
        for rank in 1..hit.chunks.len() {
            tail.push((hit.score / (rank + 1) as f64, note_rank, rank));
        }
    }
    tail.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| (left.1, left.2).cmp(&(right.1, right.2)))
    });
    for (_, note, rank) in tail {
        truncated |= !choose(
            &hits[note].chunks[rank],
            &mut selected[note][rank],
            &mut remaining,
        );
    }
    for (hit, mask) in hits.iter_mut().zip(selected) {
        let mut keep = mask.into_iter();
        hit.chunks.retain(|_| keep.next().unwrap_or(false));
    }
    hits.retain(|hit| !hit.chunks.is_empty());
    truncated
}

fn choose(chunk: &SearchPart, selected: &mut bool, remaining: &mut u32) -> bool {
    let Some(remainder) = remaining.checked_sub(chunk.part().tokens()) else {
        return false;
    };
    *remaining = remainder;
    *selected = true;
    true
}
