use super::{Eligible, Recall, align::Overlay, lexical_work_with_retry, ranking::Candidate};
use crate::{
    embed::RemoteConservativeTokenizerBudget,
    engine::{Clock, Published, SearchEngine, internal},
    lexical::{ChatCursor, ChunkRelevance, HitKey, LexicalFilter},
    model::chunks_for,
    ports::SearchDocumentTarget,
};
use notarium_core::{
    DomainError,
    auth::SpaceLifecycle,
    classes::{ClassEgressFence, ClassifiedDocument, ContentPart, SearchContent, SearchPart},
    error::PortError,
    ids::{NoteId, SpaceSeq},
    model::SnapshotCut,
    ports::{ChatSearchHit, NoteCard, SearchHit, SearchQuery, SpaceContext, StructuralSnapshot},
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

const MAX_CHAT_PAGES: usize = 8;

pub(super) struct Hydration<'a> {
    pub context: &'a SpaceContext,
    pub text: &'a str,
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
            text,
            clock,
            cut,
            overlay,
            candidates,
            tokenizer,
            top_k,
            recall,
        } = task;
        let structural = &self.services.deps.structural;
        let mut unmasked: Vec<Option<Candidate>> = candidates
            .into_iter()
            .filter(|candidate| !overlay.get(&candidate.note).is_some_and(Option::is_none))
            .map(Some)
            .collect();
        let mut selected_indices = Vec::with_capacity(top_k);
        let mut truncated = false;
        let batch_size = (top_k.saturating_add(1)).clamp(32, 256);
        let mut cursor = 0;
        while cursor < unmasked.len() && !truncated {
            let end = (cursor + batch_size).min(unmasked.len());
            let ids: Vec<NoteId> = unmasked[cursor..end]
                .iter()
                .filter_map(|slot| slot.as_ref().map(|candidate| candidate.note.clone()))
                .collect();
            let mut check_ctx = context.clone();
            check_ctx.budget = clock.remaining()?;
            let flags = structural.filter_live_visible(&check_ctx, &ids).await?;
            if flags.len() != ids.len() {
                return Err(internal("projection_live_batch"));
            }
            for (offset, visible) in flags.into_iter().enumerate() {
                if !visible {
                    continue;
                }
                if selected_indices.len() == top_k {
                    truncated = true;
                    break;
                }
                selected_indices.push(cursor + offset);
            }
            cursor = end;
        }
        let selected: Vec<Candidate> = selected_indices
            .into_iter()
            .filter_map(|index| unmasked[index].take())
            .collect();
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
        let ordered: Vec<_> = selected
            .into_iter()
            .filter_map(|candidate| cards.remove(&candidate.note).map(|card| (candidate, card)))
            .collect();
        if ordered.is_empty() {
            return Ok((Vec::new(), truncated));
        }

        // Only read CAS carriers for projected notes; overlay rows already carry
        // their authorized receipt-bound document and passed live visibility.
        let mut projected_ids = Vec::new();
        let mut projected_targets = Vec::new();
        for (candidate, card) in &ordered {
            if !overlay.contains_key(&candidate.note) {
                projected_ids.push(candidate.note.clone());
                projected_targets.push(SearchDocumentTarget {
                    note_id: candidate.note.clone(),
                    revision: card.document.provenance().revision().clone(),
                    projected_at: Some(cut.projected_seq),
                });
            }
        }
        let mut docs: HashMap<NoteId, Arc<ClassifiedDocument>> = HashMap::new();
        if !projected_targets.is_empty() {
            ctx.budget = clock.remaining()?;
            let documents = self
                .services
                .deps
                .carriers
                .read_authorized_documents_for_search(ctx, projected_targets)
                .await?;
            if documents.len() != projected_ids.len() {
                return Err(internal("canonical_search_batch"));
            }
            for (note_id, document) in projected_ids.into_iter().zip(documents) {
                if let Some(document) = document {
                    docs.insert(note_id, document);
                }
            }
        }
        for (candidate, _) in &ordered {
            if let Some(Some(row)) = overlay.get(&candidate.note) {
                docs.insert(candidate.note.clone(), Arc::new(row.document.clone()));
            }
        }

        let mut hits = Vec::new();
        let mut relevance = ChunkRelevance::new(text);
        for (candidate, card) in ordered {
            clock.remaining()?;
            let Some(document) = docs.remove(&candidate.note) else {
                continue;
            };
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
            let descriptors = hit_chunks(&candidate, &content, tokenizer, &mut relevance, clock)?;
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

    pub(super) async fn finish_hits(
        &self,
        ctx: &SpaceContext,
        clock: &Clock,
        hits: Vec<SearchHit>,
        recall: Option<Recall>,
        chats: &mut Vec<ChatSearchHit>,
        mut chat_head: Option<SpaceSeq>,
    ) -> Result<(Vec<SearchHit>, bool), PortError> {
        if hits.is_empty() {
            return Ok((Vec::new(), false));
        }
        let ids: Vec<NoteId> = hits
            .iter()
            .map(|hit| hit.card.document.provenance().reference().note_id.clone())
            .collect();
        let mut check_ctx = ctx.clone();
        let flags = loop {
            check_ctx.budget = clock.remaining()?;
            let flags = self
                .services
                .deps
                .structural
                .filter_live_visible(&check_ctx, &ids)
                .await?;
            if chats.is_empty() {
                break flags;
            }
            // The canonical head covers both note visibility and chat branch/redaction
            // changes. Recheck only the selected chat keys if it changed since
            // their admission, then verify the notes at the same head.
            let current = self
                .services
                .deps
                .canonical
                .read_space(&ctx.scope().space_id)
                .await?;
            ctx.check_current(&current.scope)?;
            if current.space.lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            if chat_head == Some(current.last_seq) {
                break flags;
            }
            chat_head = Some(current.last_seq);
            let keys: Vec<_> = chats
                .iter()
                .map(|chat| (chat.thread.clone(), chat.entry))
                .collect();
            check_ctx.budget = clock.remaining()?;
            let admitted: HashSet<_> = self
                .services
                .deps
                .carriers
                .visible_chat_hit_keys(&check_ctx, &keys)
                .await?
                .into_iter()
                .collect();
            chats.retain(|chat| admitted.contains(&(chat.thread.clone(), chat.entry)));
        };
        if flags.len() != hits.len() {
            return Err(internal("projection_live_batch"));
        }
        let mut visible: Vec<_> = hits
            .into_iter()
            .zip(flags)
            .filter_map(|(hit, ok)| ok.then_some(hit))
            .collect();
        let truncated = recall.is_some_and(|recall| pack(&mut visible, recall.tokens));
        Ok((visible, truncated))
    }

    pub(super) async fn search_chats(
        &self,
        ctx: &SpaceContext,
        clock: &Clock,
        request: &SearchQuery,
        snapshot: Arc<dyn StructuralSnapshot>,
        state: Arc<Published>,
        eligible: Arc<Eligible>,
    ) -> Result<(Vec<ChatSearchHit>, bool), PortError> {
        let limit = usize::from(request.top_k.get());
        let mut page_size = (limit * 2).clamp(16, 200);
        let mut selected = Vec::with_capacity(limit + 1);
        let mut scores = BTreeMap::new();
        let mut cursor = ChatCursor::default();
        let mut context = ctx.clone();
        let mut pages = 0usize;
        let mut page_capped = false;
        loop {
            let state_page = state.clone();
            let eligible_page = eligible.clone();
            let snapshot_page = snapshot.clone();
            let text_page = request.text.clone();
            let (hits, next) = lexical_work_with_retry(clock, &snapshot, move |budget| {
                let mut filter = LexicalFilter::new(
                    snapshot_page.as_ref(),
                    eligible_page.chat_folders.clone(),
                    None,
                    [],
                    true,
                )
                .within(budget);
                if let Some(viewer) = eligible_page.chat_viewer.as_ref() {
                    filter = filter.visible_chats_for(viewer);
                }
                state_page.lexical.chat_page(
                    &state_page.searcher,
                    &text_page,
                    &filter,
                    page_size,
                    cursor,
                )
            })
            .await?;
            pages += 1;
            let mut keys = Vec::with_capacity(hits.len());
            let mut page_scores = BTreeMap::new();
            for hit in hits {
                if let HitKey::Chat { thread, entry, .. } = hit.key {
                    let key = (thread, entry);
                    page_scores.insert(key.clone(), f64::from(hit.score));
                    keys.push(key);
                }
            }
            // An isolated page can go directly through the final live fence.
            // Otherwise admit keys without reading content or marking branch taint.
            if next.is_none() && selected.is_empty() {
                selected = keys;
                scores = page_scores;
                break;
            }
            context.budget = clock.remaining()?;
            keys = self
                .services
                .deps
                .carriers
                .visible_chat_hit_keys(&context, &keys)
                .await?;
            for key in keys.into_iter().take(limit + 1 - selected.len()) {
                let score = page_scores
                    .remove(&key)
                    .ok_or_else(|| internal("chat_search_identity"))?;
                scores.insert(key.clone(), score);
                selected.push(key);
            }
            if selected.len() > limit {
                break;
            }
            let Some(next) = next else { break };
            if !cursor.relaxed
                && next.relaxed
                && selected.len() >= limit.min(crate::lexical::MAX_FALLBACK_FLOOR)
            {
                break;
            }
            if pages >= MAX_CHAT_PAGES {
                page_capped = true;
                break;
            }
            cursor = next;
            page_size = 200;
        }
        if selected.is_empty() {
            return Ok((Vec::new(), page_capped));
        }
        context.budget = clock.remaining()?;
        let (rows, truncated) = self
            .services
            .deps
            .carriers
            .hydrate_live_visible_chat_hits(&context, &selected, request.top_k)
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
        Ok((hits, truncated || page_capped))
    }
}

fn hit_chunks(
    candidate: &Candidate,
    content: &SearchContent,
    tokenizer: &dyn TokenizerBudget,
    relevance: &mut ChunkRelevance,
    clock: &Clock,
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
    let chunks = chunks_for(content, tokenizer).or_else(|_| {
        chunks_for(
            content,
            &RemoteConservativeTokenizerBudget::lexical_fallback(),
        )
    })?;
    if chunks.len() <= 1 || relevance.is_empty() {
        return Ok(chunks);
    }
    let mut ranked = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        clock.remaining()?;
        ranked.push((Reverse(relevance.score(&chunk.text)), chunk));
    }
    ranked.sort_by_key(|(score, _)| *score);
    Ok(ranked.into_iter().map(|(_, chunk)| chunk).collect())
}

fn pack(hits: &mut Vec<SearchHit>, tokens: u32) -> bool {
    let had_chunks: Vec<bool> = hits.iter().map(|hit| !hit.chunks.is_empty()).collect();
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
    // Preserve title-only notes that started without chunks while dropping
    // notes whose chunks were all excluded by the token budget.
    let mut had = had_chunks.into_iter();
    hits.retain(|hit| !had.next().unwrap_or(false) || !hit.chunks.is_empty());
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
