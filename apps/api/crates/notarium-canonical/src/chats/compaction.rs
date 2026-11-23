//! A prefix checkpoint changes the prompt view while leaving the audit DAG alone.
use notarium_core::classes::ProviderOrigin;
use notarium_core::ports::PageLimit;

use super::*;

// Historical empty human entries remain readable in the audit branch. Omit them
// from both live prompts and compaction proofs before hydration adds group attribution.
fn empty_human(entry: &ChatEntry) -> bool {
    entry.kind == ChatEntryKind::Human
        && matches!(&entry.body, ChatBody::Inline(text) if text.is_empty())
}

pub(super) async fn context(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<ChatBranch, PortError> {
    let mut branch = store.read_chat(ctx.clone(), request).await?;
    branch.entries.retain(|entry| !empty_human(entry));
    let Some(index) = branch
        .entries
        .iter()
        .rposition(|e| e.kind == ChatEntryKind::Compaction)
    else {
        return Ok(branch);
    };
    let through =
        content::checkpoint_boundary(store, &ctx, &branch.thread, branch.entries[index].seq)
            .await?;
    if let Some(through) = through {
        let checkpoint = branch.entries.remove(index);
        branch
            .entries
            .retain(|entry| entry.seq > through && entry.kind != ChatEntryKind::Compaction);
        branch.entries.insert(0, checkpoint);
        branch.next_ancestor = branch.next_ancestor.filter(|next| *next > through);
    } else {
        // Historical checkpoints represented the whole prior context.
        branch.entries.drain(..index);
        branch.next_ancestor = None;
    }
    Ok(branch)
}

// A thread may accumulate more than a prompt window between AI activations.
// Walk only its parent chain. Keep the oldest page of live entries after the
// latest checkpoint and remember the page on which each body was authorized.
struct PrefixWindow {
    branch: ChatBranch,
    reads: Vec<ChatContentRead>,
    has_tail: bool,
}

async fn oldest_prefix(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: ChatRead,
) -> Result<PrefixWindow, PortError> {
    use std::collections::{BTreeMap, VecDeque};

    if request.before.is_some() || request.leaf == ThreadEntrySeq::ZERO {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "chat_prompt_prefix");
    let limit = usize::from(request.max_entries.get());
    let mut page = store.read_chat(ctx.clone(), request.clone()).await?;
    let thread = page.thread.clone();
    let keeper = match ctx.auth().kind() {
        PrincipalKind::Keeper(run) => Some(run.clone()),
        _ => None,
    };
    let mut page_tip = request.leaf;
    let mut retained = VecDeque::with_capacity(limit);
    let mut checkpoint = None;
    let mut through = ThreadEntrySeq::ZERO;
    let mut has_tail = false;
    'pages: loop {
        if page.thread.revision != thread.revision {
            return Err(DomainError::RevisionConflict {
                current: page.thread.revision,
                lineage: None,
            }
            .into());
        }
        for entry in page.entries.into_iter().rev() {
            if entry.seq <= through
                || keeper
                    .as_ref()
                    .is_some_and(|run| entry.run.as_ref() != Some(run))
            {
                break 'pages;
            }
            if entry.kind == ChatEntryKind::Compaction {
                if checkpoint.is_none() {
                    ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
                    through = content::checkpoint_boundary(store, &ctx, &thread, entry.seq)
                        .await?
                        .unwrap_or(entry.seq);
                    checkpoint = Some((page_tip, entry));
                }
            } else if entry.kind != ChatEntryKind::Redacted && !empty_human(&entry) {
                retained.push_front((page_tip, entry));
                if retained.len() > limit {
                    retained.pop_back();
                    has_tail = true;
                }
            }
        }
        let Some(next) = page.next_ancestor.filter(|next| *next > through) else {
            break;
        };
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        page_tip = next;
        page = store
            .read_chat(
                ctx.clone(),
                ChatRead {
                    thread: request.thread.clone(),
                    leaf: page_tip,
                    before: None,
                    max_entries: PageLimit::new(200)?,
                },
            )
            .await?;
    }
    if let Some(checkpoint) = checkpoint {
        retained.push_front(checkpoint);
        if retained.len() > limit {
            retained.pop_back();
            has_tail = true;
        }
    }
    let mut pages = BTreeMap::<_, Vec<_>>::new();
    let mut entries = Vec::with_capacity(retained.len());
    for (tip, entry) in retained {
        pages.entry(tip).or_default().push(entry.seq);
        entries.push(entry);
    }
    let reads = pages
        .into_iter()
        .map(|(leaf, entries)| ChatContentRead {
            thread: request.thread.clone(),
            leaf,
            entries,
        })
        .collect();
    Ok(PrefixWindow {
        branch: ChatBranch {
            thread,
            entries,
            next_ancestor: None,
        },
        reads,
        has_tail,
    })
}

pub(super) async fn hydrated_prefix(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: ChatRead,
) -> Result<notarium_core::ports::ChatCompactionPrefix, PortError> {
    let deadline =
        crate::domain::common::CommandDeadline::start(&ctx.budget, "hydrate_prompt_prefix");
    let window = oldest_prefix(store, ctx.clone(), request).await?;
    let mut contents = Vec::with_capacity(window.branch.entries.len());
    for read in window.reads {
        ctx.budget.remaining = deadline.remaining(&ctx.budget)?;
        contents.extend(store.read_chat_contents(ctx.clone(), read).await?);
    }
    Ok(notarium_core::ports::ChatCompactionPrefix {
        branch: window.branch,
        contents,
        has_tail: window.has_tail,
    })
}

pub(super) async fn verify_prefix(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: &Mutation<AppendChat>,
) -> Result<(), PortError> {
    let input = &request.input;
    let Some((proof, through)) = input
        .provenance
        .as_ref()
        .and_then(|proof| proof.compacts_through.map(|through| (proof, through)))
    else {
        return Ok(());
    };
    if through == ThreadEntrySeq::ZERO || through >= input.parent {
        return Err(mismatch());
    }
    #[cfg(feature = "test-support")]
    super::preparation_test::pause().await;
    let keeper = match ctx.auth().kind() {
        PrincipalKind::Keeper(run) => Some(run.clone()),
        _ => None,
    };
    let read = ChatRead {
        thread: input.thread.clone(),
        leaf: input.parent,
        before: None,
        max_entries: PageLimit::new(200)?,
    };
    let mut branch = context(store, ctx.clone(), read.clone()).await?;
    if branch.next_ancestor.is_some()
        && !keeper.as_ref().is_some_and(|run| {
            branch
                .entries
                .iter()
                .any(|entry| entry.run.as_ref() != Some(run))
        })
    {
        branch = oldest_prefix(store, ctx, read).await?.branch;
    }

    // Appending the prefix witness uses the very same revision CAS. A
    // redaction, branch change, or concurrent append invalidates this proof.
    if branch.thread.head != input.parent
        || request.preconditions.revision.as_ref() != Some(&branch.thread.revision)
    {
        return Err(DomainError::RevisionConflict {
            current: branch.thread.revision,
            lineage: None,
        }
        .into());
    }
    let mut entries = branch.entries;
    if let Some(run) = &keeper {
        entries.retain(|entry| entry.run.as_ref() == Some(run));
    }
    // A redaction preserves ancestry but has no body to disclose or cite.
    // Proofs of surviving entries still refer to their original sources.
    entries.retain(|entry| entry.kind != ChatEntryKind::Redacted);
    let cut = entries
        .iter()
        .position(|entry| entry.seq == through && entry.kind != ChatEntryKind::Compaction)
        .filter(|cut| {
            entries
                .get(*cut + 1)
                .is_some_and(|entry| !matches!(entry.kind, ChatEntryKind::Tool { .. }))
        })
        .ok_or_else(mismatch)?;
    let expected = entries[..=cut]
        .iter()
        .map(|entry| {
            let digest = match &entry.body {
                ChatBody::Inline(text) => {
                    ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
                }
                ChatBody::Blob(digest) => *digest,
                ChatBody::Redacted => return Err(mismatch()),
            };
            Ok(ProviderOrigin::Chat {
                space: branch.thread.space.clone(),
                thread: input.thread.clone(),
                entry: entry.seq,
                digest,
                project: branch.thread.project_folder.clone(),
            })
        })
        .collect::<Result<Vec<_>, PortError>>()?;
    let actual: Vec<_> = proof
        .origins
        .iter()
        .filter(|origin| matches!(origin, ProviderOrigin::Chat { .. }))
        .collect();
    if actual.len() != expected.len() || expected.iter().any(|origin| !actual.contains(&origin)) {
        return Err(mismatch());
    }
    Ok(())
}

fn mismatch() -> PortError {
    DomainError::validation(ValidationReason::SourceMismatch).into()
}
