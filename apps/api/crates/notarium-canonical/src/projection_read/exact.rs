use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, SpaceSeq},
    model::HistoryScope,
    ports::MaintenanceContext,
    receipt::{
        MutationEffect, MutationReceiptToken, OverlayRowVersion, ReceiptSet, TrustedMutationEffect,
    },
};

use crate::{
    CanonicalStore, changes::resolve_receipt_effect_tx, domain::common::note_rank_version_digest,
    runtime::load_space_record,
};

use super::{
    ProjectionNote, ProjectionRank, note_at,
    ranks::{rank_anchor, target_ranks},
    validate_cut,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionOverlaySelection {
    pub version: OverlayRowVersion,
    pub receipt: MutationReceiptToken,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionOverlayNote {
    pub receipt: MutationReceiptToken,
    pub note: ProjectionNote,
    pub ranks: Vec<ProjectionRank>,
}

impl CanonicalStore {
    /// Resolves exact receipt hints under the projection reader's SQL and caller budget.
    pub async fn resolve_projection_receipt_effects(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        receipts: &ReceiptSet,
    ) -> Result<Vec<TrustedMutationEffect>, PortError> {
        let relevant: Vec<_> = receipts.for_scope(scope)?.into_iter().cloned().collect();
        let scope = scope.clone();
        self.with_projection_read(ctx, |tx| {
            Box::pin(async move {
                let current = load_space_record(tx, &scope.space_id).await?;
                current.scope.check(&scope)?;
                let mut effects = Vec::with_capacity(relevant.len());
                for receipt in relevant {
                    let (_, effect) = resolve_receipt_effect_tx(tx, &scope, receipt.seq()).await?;
                    effects.push(TrustedMutationEffect { receipt, effect });
                }
                Ok(effects)
            })
        })
        .await
    }

    /// Resolves bounded receipt selections as exact note and rank states.
    /// An unprovable row makes the whole overlay unavailable.
    pub async fn read_projection_overlay_notes(
        &self,
        ctx: &MaintenanceContext,
        scope: &HistoryScope,
        selections: &[ProjectionOverlaySelection],
    ) -> Result<Option<Vec<ProjectionOverlayNote>>, PortError> {
        if selections.len() > ReceiptSet::LIMIT {
            return Err(DomainError::validation(ValidationReason::ReceiptLimitExceeded).into());
        }
        let scope = scope.clone();
        let selections = selections.to_vec();
        let result = self
            .with_projection_read(ctx, |tx| {
                Box::pin(async move {
                    let space = load_space_record(tx, &scope.space_id).await?;
                    space.scope.check(&scope)?;
                    let anchor = rank_anchor(tx, &scope).await?;
                    let mut commands = BTreeMap::new();
                    let mut seen_notes = BTreeSet::new();
                    let mut out = Vec::with_capacity(selections.len());

                    for selection in selections {
                        scope.check(selection.receipt.scope())?;
                        let cutoff = selection.receipt.seq();
                        if cutoff < anchor || !seen_notes.insert(selection.version.note_id.clone())
                        {
                            return Ok(None);
                        }
                        if let std::collections::btree_map::Entry::Vacant(command) =
                            commands.entry(cutoff)
                        {
                            validate_cut(tx, &space, cutoff).await?;
                            command.insert(resolve_receipt_effect_tx(tx, &scope, cutoff).await?);
                        }
                        let (Some(kind), MutationEffect::Notes { versions, .. }) =
                            &commands[&cutoff]
                        else {
                            return Ok(None);
                        };
                        if !versions.contains(&selection.version) {
                            return Ok(None);
                        }

                        let Some(mut note) =
                            note_at(tx, &scope, cutoff, &selection.version.note_id).await?
                        else {
                            return Ok(None);
                        };
                        if note.revision_id != selection.version.revision {
                            return Ok(None);
                        }
                        let Some(ranks) =
                            target_ranks(tx, &scope, anchor, cutoff, &note.metadata.note_id)
                                .await?
                        else {
                            return Ok(None);
                        };
                        if !matches_rank_version(
                            kind,
                            cutoff,
                            &note,
                            &ranks,
                            selection.version.rank_version,
                        ) {
                            return Ok(None);
                        }
                        note.rank_version = selection.version.rank_version;
                        out.push(ProjectionOverlayNote {
                            receipt: selection.receipt,
                            note,
                            ranks,
                        });
                    }
                    Ok(Some(out))
                })
            })
            .await;

        match result {
            Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                if matches!(
                    diagnostic.reason,
                    ValidationReason::CursorStale
                        | ValidationReason::InvalidCutoff
                        | ValidationReason::PurgeResync
                ) =>
            {
                Ok(None)
            }
            other => other,
        }
    }
}

fn matches_rank_version(
    command_kind: &str,
    cutoff: SpaceSeq,
    note: &ProjectionNote,
    ranks: &[ProjectionRank],
    version: ContentDigest,
) -> bool {
    match command_kind {
        "move_board_card" => ranks.iter().any(|rank| {
            if rank.visibility_seq != cutoff {
                return false;
            }
            let key = format!(
                "{}:{}:{}",
                rank.metadata.view_note_id, rank.metadata.view_key, rank.revision_id
            );
            note_rank_version_digest(&note.revision_id, Some(&key)) == version
        }),
        "publish_ability_package" => {
            note.rank_version == version && note.metadata.ability_id.is_some()
        }
        _ => note_rank_version_digest(&note.revision_id, None) == version,
    }
}
