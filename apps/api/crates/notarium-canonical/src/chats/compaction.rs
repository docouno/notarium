//! A prefix checkpoint changes the prompt view while leaving the audit DAG alone.
use notarium_core::classes::ProviderOrigin;
use notarium_core::ports::PageLimit;

use super::*;

pub(super) async fn context(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ChatRead,
) -> Result<ChatBranch, PortError> {
    let mut branch = store.read_chat(ctx.clone(), request).await?;
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
    let keeper = match ctx.auth().kind() {
        PrincipalKind::Keeper(run) => Some(run.clone()),
        _ => None,
    };
    let branch = context(
        store,
        ctx,
        ChatRead {
            thread: input.thread.clone(),
            leaf: input.parent,
            before: None,
            max_entries: PageLimit::new(200)?,
        },
    )
    .await?;

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
    let complete = branch.next_ancestor.is_none()
        || keeper
            .as_ref()
            .is_some_and(|run| entries.iter().any(|entry| entry.run.as_ref() != Some(run)));
    if !complete {
        return Err(DomainError::validation(ValidationReason::BudgetExceeded).into());
    }
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
