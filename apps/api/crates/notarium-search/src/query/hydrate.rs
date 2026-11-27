use super::{
    Eligible, QueryDelivery, Recall, align::Overlay, lexical_work_with_retry, ranking::Candidate,
};
use crate::{
    embed::RemoteConservativeTokenizerBudget,
    engine::{Clock, Published, SearchEngine, internal},
    lexical::{ChatCursor, ChunkRelevance, HitKey, LexicalFilter, RankedLexical},
    model::chunks_for,
    ports::SearchDocumentTarget,
};
use notarium_core::{
    classes::{ClassEgressFence, ClassifiedDocument, ContentPart, SearchContent, SearchPart},
    error::PortError,
    ids::{NoteId, SpaceSeq},
    model::SnapshotCut,
    ports::{
        ChatSearchHit, NoteCard, SearchHit, SearchQuery, SearchRecipient, SpaceContext,
        StructuralSnapshot,
    },
};
use notarium_syntax::chunk::TokenizerBudget;
use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

const MAX_CHAT_PAGES: usize = 8;

pub(super) struct NoteAdmission<'a> {
    pub context: &'a SpaceContext,
    pub clock: &'a Clock,
    pub cut: &'a SnapshotCut,
    pub overlay: &'a Overlay,
    pub recipient: Option<&'a dyn SearchRecipient>,
    /// Recipient decisions made for lexical fallback and graph expansion in this query.
    pub checked: HashMap<NoteId, bool>,
}

impl NoteAdmission<'_> {
    /// Only the admitted weak matches needed to complete the floor contribute
    /// lexical votes and graph seeds. Strict and independent vector votes keep
    /// their original rank.
    pub(super) async fn fill_fallback(
        &mut self,
        engine: &SearchEngine,
        ranked: &mut RankedLexical,
        floor: usize,
    ) -> Result<bool, PortError> {
        let notes = ranked.hits.iter().filter_map(|hit| match &hit.key {
            HitKey::Note(note) => Some(note),
            HitKey::Chat { .. } => None,
        });
        let admitted = self
            .select(engine, notes, |note| *note, floor, true)
            .await?;
        let filled = admitted.len() == floor;
        let mut pos = 0;
        let mut kept_strict = 0;
        let checked = &self.checked;
        ranked.hits.retain(|hit| {
            pos += 1;
            let keep = if pos <= ranked.strict_len {
                !matches!(&hit.key, HitKey::Note(note) if checked.get(note) == Some(&false))
            } else {
                matches!(&hit.key, HitKey::Note(note) if checked.get(note) == Some(&true))
            };
            if keep && pos <= ranked.strict_len {
                kept_strict += 1;
            }
            keep
        });
        ranked.strict_len = kept_strict;
        Ok(filled)
    }

    pub(super) async fn select<T>(
        &mut self,
        engine: &SearchEngine,
        ranked: impl Iterator<Item = T>,
        note: impl Fn(&T) -> &NoteId,
        limit: usize,
        remember: bool,
    ) -> Result<Vec<T>, PortError> {
        let structural = &engine.services.deps.structural;
        let mut unmasked =
            ranked.filter(|item| !self.overlay.get(note(item)).is_some_and(Option::is_none));
        let mut selected = Vec::with_capacity(limit);
        let batch_size = if self.recipient.is_some() {
            limit.clamp(32, 200)
        } else {
            limit.clamp(32, 256)
        };
        loop {
            // A cached rejection cannot contribute to this query. Positive
            // decisions still pass the live visibility check below.
            let batch: Vec<_> = unmasked
                .by_ref()
                .filter(|item| self.checked.get(note(item)) != Some(&false))
                .take(batch_size)
                .collect();
            if batch.is_empty() {
                return Ok(selected);
            }
            let ids: Vec<_> = batch.iter().map(&note).cloned().collect();
            let mut check_ctx = self.context.clone();
            check_ctx.budget = self.clock.remaining()?;
            let flags = structural
                .filter_live_visible_preflight(&check_ctx, &ids)
                .await?;
            if flags.len() != ids.len() {
                return Err(internal("projection_live_batch"));
            }
            let visible: Vec<_> = batch
                .into_iter()
                .zip(flags)
                .filter_map(|(candidate, visible)| visible.then_some(candidate))
                .collect();
            let mut metadata = BTreeMap::new();
            if self.recipient.is_some() {
                let projected: Vec<_> = visible
                    .iter()
                    .map(&note)
                    .filter(|id| !self.overlay.contains_key(*id) && !self.checked.contains_key(*id))
                    .cloned()
                    .collect();
                if !projected.is_empty() {
                    check_ctx.budget = self.clock.remaining()?;
                    metadata = engine
                        .services
                        .deps
                        .canonical
                        .read_search_candidate_metadata(
                            &check_ctx,
                            self.cut.projected_seq,
                            projected,
                        )
                        .await?;
                }
            }
            for candidate in visible {
                if let Some(recipient) = self.recipient {
                    let id = note(&candidate);
                    let allowed = if let Some(allowed) = self.checked.get(id) {
                        *allowed
                    } else {
                        let card = match self.overlay.get(id) {
                            Some(Some(row)) => ClassEgressFence::search_preflight(
                                row.document.metadata(),
                                self.context.auth(),
                            )
                            .ok(),
                            _ => metadata.remove(id),
                        };
                        let allowed = match card {
                            Some(card) => recipient.admit(card.provenance()).await?,
                            None => false,
                        };
                        if remember {
                            self.checked.insert(id.clone(), allowed);
                        }
                        allowed
                    };
                    if !allowed {
                        continue;
                    }
                }
                selected.push(candidate);
                if selected.len() == limit {
                    return Ok(selected);
                }
            }
        }
    }
}

pub(super) struct Hydration<'a> {
    pub admission: NoteAdmission<'a>,
    pub text: &'a str,
    pub selected: Vec<Candidate>,
    pub tokenizer: &'a (dyn TokenizerBudget + Send + Sync),
    pub top_k: usize,
    pub delivery: QueryDelivery<'a>,
}

impl SearchEngine {
    pub(super) async fn hydrate_notes(
        &self,
        task: Hydration<'_>,
    ) -> Result<(Vec<SearchHit>, bool), PortError> {
        let Hydration {
            admission,
            text,
            mut selected,
            tokenizer,
            top_k,
            delivery,
        } = task;
        let truncated = selected.len() > top_k;
        selected.truncate(top_k);
        let NoteAdmission {
            context,
            clock,
            cut,
            overlay,
            ..
        } = admission;
        let structural = &self.services.deps.structural;
        if selected.is_empty() {
            return Ok((Vec::new(), truncated));
        }

        let projected: Vec<_> = selected
            .iter()
            .filter(|candidate| !overlay.contains_key(&candidate.note))
            .map(|candidate| candidate.note.clone())
            .collect();
        let mut ctx = context.with_preflight_taint();
        let hydrate_auth = ctx.auth().clone();
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
                ClassEgressFence::search_metadata(row.document.metadata(), &hydrate_auth)
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
        let mut ordered = Vec::with_capacity(selected.len());
        for candidate in selected {
            let Some(card) = cards.remove(&candidate.note) else {
                continue;
            };
            ordered.push((candidate, card));
        }
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
            let Ok(content) = ClassEgressFence::search(document.as_ref().clone(), &hydrate_auth)
            else {
                continue;
            };
            let descriptors = hit_chunks(&candidate, &content, tokenizer, &mut relevance, clock)?;
            let maximum = if delivery.recall.is_some() {
                usize::MAX
            } else {
                3
            };
            let chunks = descriptors
                .into_iter()
                .take(maximum)
                .filter_map(|descriptor| {
                    let part = ContentPart::from_chunk(document.clone(), descriptor).ok()?;
                    ClassEgressFence::search_part(part, &hydrate_auth).ok()
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
        delivery: QueryDelivery<'_>,
        chats: &mut Vec<ChatSearchHit>,
        mut visibility_head: SpaceSeq,
    ) -> Result<(Vec<SearchHit>, bool), PortError> {
        if hits.is_empty() && chats.is_empty() {
            return Ok((Vec::new(), false));
        }
        let ids: Vec<_> = hits
            .iter()
            .map(|hit| hit.card.document.provenance().reference().note_id.clone())
            .collect();
        let keys: Vec<_> = chats
            .iter()
            .map(|chat| (chat.thread.clone(), chat.entry))
            .collect();
        let mut check_ctx = ctx.with_preflight_taint();
        let canonical = &self.services.deps.canonical;
        let (flags, chat_admission) = loop {
            check_ctx.budget = clock.remaining()?;
            let flags = if ids.is_empty() {
                Vec::new()
            } else {
                self.services
                    .deps
                    .structural
                    .filter_live_visible_preflight(&check_ctx, &ids)
                    .await?
            };
            check_ctx.budget = clock.remaining()?;
            let admission = canonical
                .admit_search_delivery(&self.services.authority, &check_ctx, &keys)
                .await?;
            // A port may read each note separately. An unchanged canonical head
            // proves all flags and chat admissions refer to the same live state.
            if ids.is_empty() || visibility_head == admission.head {
                break (flags, admission);
            }
            visibility_head = admission.head;
        };
        if flags.len() != hits.len() {
            return Err(internal("projection_live_batch"));
        }
        let mut visible: Vec<_> = hits
            .into_iter()
            .zip(flags)
            .filter_map(|(hit, ok)| ok.then_some(hit))
            .collect();
        let truncated = delivery
            .recall
            .is_some_and(|recall| pack(&mut visible, recall, delivery.recipient));
        // Commit cross-space taint onto the caller's live auth ONLY for
        // hits that survived live visibility and recall packing.
        visible.retain(|hit| {
            ClassEgressFence::search_metadata(hit.card.document.provenance().clone(), ctx.auth())
                .is_ok()
        });
        let mut any_tainted = false;
        chats.retain(|chat| {
            if let Some(&tainted) = chat_admission
                .entries
                .get(&(chat.thread.clone(), chat.entry))
            {
                any_tainted |= tainted;
                true
            } else {
                false
            }
        });
        if !chats.is_empty() {
            ctx.auth()
                .mark_chat_read_taint(&chat_admission.space, any_tainted);
        }
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
            .prepare_search_chat_hits(&self.services.authority, &context, &selected, request.top_k)
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

fn pack(
    hits: &mut Vec<SearchHit>,
    recall: Recall,
    recipient: Option<&dyn notarium_core::ports::SearchRecipient>,
) -> bool {
    let had_chunks: Vec<bool> = hits.iter().map(|hit| !hit.chunks.is_empty()).collect();
    let mut remaining = recall.tokens;
    let cap = recall.max_per_source.map_or(remaining, u32::from);
    let mut source_remaining = vec![cap; hits.len()];
    let mut selected: Vec<Vec<bool>> = hits
        .iter()
        .map(|hit| vec![false; hit.chunks.len()])
        .collect();
    let framing = |hit: &SearchHit, first| {
        recipient.map_or(0, |recipient| {
            recipient.framing_tokens(&hit.card.document.provenance().reference().note_id, first)
        })
    };
    let mut truncated = false;
    for ((hit, mask), source) in hits.iter().zip(&mut selected).zip(&mut source_remaining) {
        let mut admitted = false;
        for (idx, part) in hit.chunks.iter().enumerate() {
            if choose(
                part,
                framing(hit, true),
                &mut mask[idx],
                &mut remaining,
                source,
            ) {
                admitted = true;
                break;
            }
            truncated = true;
        }
        if !admitted && !hit.chunks.is_empty() {
            truncated = true;
        }
    }
    let mut tail = Vec::new();
    for (note_rank, hit) in hits.iter().enumerate() {
        for (rank, &chosen) in selected[note_rank].iter().enumerate() {
            if chosen {
                continue;
            }
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
            framing(&hits[note], source_remaining[note] == cap),
            &mut selected[note][rank],
            &mut remaining,
            &mut source_remaining[note],
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

fn choose(
    chunk: &SearchPart,
    framing: u32,
    selected: &mut bool,
    remaining: &mut u32,
    source: &mut u32,
) -> bool {
    let cost = chunk.part().tokens();
    let Some(charge) = cost.checked_add(framing) else {
        return false;
    };
    if cost > *source || charge > *remaining {
        return false;
    }
    *remaining -= charge;
    *source -= cost;
    *selected = true;
    true
}

#[cfg(test)]
mod pack_tests {
    use super::*;
    use notarium_core::{
        auth::{
            EngineAuthContext, ResourceFacts, Space, SpaceGrant, SpaceKind, SpaceLifecycle,
            SpaceRole, VerifiedHuman,
        },
        classes::{ClassifiedMetadata, DocClass},
        document::ChunkDescriptor,
        ids::{ContentDigest, GrantId, ModelProfileId, PrincipalId, RevisionId, SpaceId},
        model::{Lifecycle, NoteRef},
        span::ByteSpan,
    };
    use std::collections::BTreeSet;

    fn make_hit(tag: u8, score: f64, token_sizes: &[u32]) -> SearchHit {
        let space_id = SpaceId::from_bytes([1; 16]);
        let note_id = NoteId::from_bytes([tag; 16]);
        let revision = RevisionId::from_bytes([tag; 16]);
        let reference = NoteRef {
            space_id: space_id.clone(),
            note_id: note_id.clone(),
        };
        let facts = ResourceFacts {
            space: Space {
                id: space_id.clone(),
                kind: SpaceKind::Personal,
                lifecycle: SpaceLifecycle::Active,
            },
            class: DocClass::UserDoc,
            project: None,
            ancestor_folders: vec![],
            folder_write_locked: false,
            ability_package: None,
        };
        let content = "alpha beta gamma delta".to_owned();
        let digest = ContentDigest::from_bytes(*blake3::hash(content.as_bytes()).as_bytes());
        let doc = Arc::new(
            ClassifiedDocument::from_canonical(
                reference.clone(),
                revision.clone(),
                facts.clone(),
                Lifecycle::Active,
                content,
                digest,
            )
            .unwrap(),
        );
        let meta = ClassifiedMetadata::from_canonical(
            reference,
            revision,
            facts,
            Lifecycle::Active,
            digest,
        )
        .unwrap();
        let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
            PrincipalId::from_bytes([9; 16]),
            GrantId::from_bytes([9; 16]),
            BTreeMap::from([(
                space_id,
                SpaceGrant {
                    role: SpaceRole::Owner,
                    read_classes: BTreeSet::from([DocClass::UserDoc]),
                    write_classes: BTreeSet::from([DocClass::UserDoc]),
                    project_root: None,
                },
            )]),
            false,
        ));
        let card = NoteCard {
            document: ClassEgressFence::search_metadata(meta, &auth).unwrap(),
            title: format!("Note {tag}"),
            path: format!("note-{tag}"),
            preview: String::new(),
        };
        let model = ModelProfileId::from_bytes([1; 16]);
        let chunks = token_sizes
            .iter()
            .enumerate()
            .map(|(idx, &tokens)| {
                let part = ContentPart::from_chunk(
                    doc.clone(),
                    ChunkDescriptor {
                        source: digest,
                        model: model.clone(),
                        key: ContentDigest::from_bytes([tag.wrapping_add(idx as u8); 32]),
                        tokens,
                        text: "alpha".into(),
                        context: vec![],
                        spans: vec![ByteSpan::new(0, 5).unwrap()],
                    },
                )
                .unwrap();
                ClassEgressFence::search_part(part, &auth).unwrap()
            })
            .collect();
        SearchHit {
            card,
            score,
            chunks,
        }
    }

    #[test]
    fn pack_pass_one_scans_past_oversized_lead_chunk_and_preserves_title_only_hit() {
        let mut hits = vec![
            make_hit(1, 10.0, &[160]),
            make_hit(2, 9.0, &[180, 40]),
            make_hit(3, 8.0, &[]),
        ];
        let truncated = pack(
            &mut hits,
            Recall {
                graph_depth: 1,
                tokens: 210,
                max_per_source: Some(200),
            },
            None,
        );
        assert!(truncated);
        assert_eq!(
            hits.len(),
            3,
            "title-only hit and fallback chunk hit must survive"
        );
        assert_eq!(hits[0].chunks.len(), 1);
        assert_eq!(hits[0].chunks[0].part().tokens(), 160);
        assert_eq!(hits[1].chunks.len(), 1);
        assert_eq!(
            hits[1].chunks[0].part().tokens(),
            40,
            "Pass 1 must admit second chunk when lead chunk exceeds remaining budget"
        );
        assert!(hits[2].chunks.is_empty());
    }
}
