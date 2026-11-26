use super::{
    super::{EgressTarget, ToolCallContext, corpus, decode, invalid, session},
    scope::targets,
};
use notarium_core::{
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{EpisodeId, NoteId, SpaceSeq},
    model::{FolderRef, Lifecycle},
    ports::{
        Change, ChangeKind, ChangeRead, ChangeReadResult, EntityId, GetNote, PageLimit,
        SpaceContext,
    },
    receipt::{CausalBasis, ChangeCursor},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const SPACE_WINDOW: u16 = 200;
const MAX_CANDIDATES: usize = 200;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    project: Option<String>,
    session: Option<EpisodeId>,
    limit: Option<u16>,
}

pub(super) async fn recent(
    call: &mut ToolCallContext<'_>,
    args: Value,
) -> Result<Value, PortError> {
    let args: Args = decode(args)?;
    let limit = usize::from(PageLimit::new(args.limit.unwrap_or(20))?.get());
    let resolved = targets(call, args.project.as_deref(), args.session.as_ref(), true).await?;
    let targets = resolved.targets;
    let targeted_project = resolved.targeted_project;
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let mut candidates = Vec::new();
    let mut prepared_scopes: Vec<Option<SpaceContext>> = vec![None; targets.len()];
    let mut truncated = false;
    let mut observed_foreign = false;
    for (index, target) in targets.iter().enumerate() {
        let mut read_scope = call.space(target.scope.clone())?;
        let foreign_space = !external
            && read_scope
                .auth()
                .pinned_write_space()
                .is_some_and(|pin| pin != &target.scope.space_id);
        if !external {
            let selection = match call
                .provider_selection(&read_scope, target.project.clone())
                .await
            {
                Ok(selection) => selection,
                Err(error) if corpus::hidden(&error) => continue,
                Err(error) => return Err(error),
            };
            if let Some(sel) = selection {
                if let Some(required) = sel.project_only {
                    read_scope = match read_scope.restrict_to_project(&required) {
                        Ok(narrowed) => narrowed,
                        Err(_) => continue,
                    };
                }
                if foreign_space && targeted_project {
                    // Targeting a consented foreign project observes that Space even
                    // when allowed classes leave no readable classes.
                    call.auth.taint().mark_external_read();
                }
                read_scope = read_scope.restrict_read_classes(&sel.policy.allowed_classes)?;
                if read_scope
                    .auth()
                    .spaces()
                    .get(&target.scope.space_id)
                    .is_none_or(|grant| grant.read_classes.is_empty())
                {
                    continue;
                }
            }
        }
        if let Some(project) = &target.project {
            read_scope = match read_scope.restrict_to_project(project) {
                Ok(narrowed) => narrowed,
                Err(_) => continue,
            };
        }
        if foreign_space && targeted_project {
            // Targeting a consented foreign project (explicitly or via episode
            // project_hint) observes that Space even when its recent activity list is empty.
            call.auth.taint().mark_external_read();
            observed_foreign = true;
        }
        observed_foreign |= foreign_space;
        if target.last_seq == SpaceSeq::ZERO {
            continue;
        }
        prepared_scopes[index] = Some(read_scope.clone());
        let after = SpaceSeq::new(
            target
                .last_seq
                .get()
                .saturating_sub(u64::from(SPACE_WINDOW)),
        )?;
        let page = call
            .registry
            .engine
            .recent_activity(
                if external {
                    read_scope
                } else {
                    read_scope.with_preflight_taint()
                },
                ChangeRead::Log {
                    after: ChangeCursor {
                        scope: target.scope.clone(),
                        after,
                    },
                    through: target.last_seq,
                    limit: PageLimit::new(SPACE_WINDOW)?,
                },
            )
            .await
            .inspect_err(|error| {
                if observed_foreign
                    && !matches!(
                        error,
                        PortError::Domain(notarium_core::DomainError::ResourceNotFound)
                    )
                {
                    call.commit_external_read();
                }
            })?;
        let ChangeReadResult::Log(page) = page else {
            if observed_foreign {
                call.commit_external_read();
            }
            return Err(invalid(ValidationReason::InvalidState));
        };
        if let Err(error) = target.scope.check(&page.next.scope) {
            if observed_foreign {
                call.commit_external_read();
            }
            return Err(error.into());
        }
        if page.cutoff != target.last_seq || page.changes.len() > usize::from(SPACE_WINDOW) {
            if observed_foreign {
                call.commit_external_read();
            }
            return Err(invalid(ValidationReason::InvalidState));
        }
        truncated |= after > SpaceSeq::ZERO || !page.complete;
        for change in page.changes {
            let EntityId::Note(_) = &change.entity else {
                continue;
            };
            change.cursor.scope.check(&target.scope)?;
            if change.class == Some(DocClass::EncryptedNote)
                || target.project.as_ref().is_some_and(|project| {
                    change
                        .provenance
                        .as_ref()
                        .and_then(|facts| facts.project.as_ref())
                        != Some(&project.folder_id)
                })
            {
                continue;
            }
            if change.provenance.is_none() {
                // Rank-only revisions and purged rows have no authored note metadata.
                continue;
            }
            candidates.push(Candidate { index, change });
        }
        if external && candidates.len() > MAX_CANDIDATES {
            candidates.sort_by(rank);
            candidates.truncate(MAX_CANDIDATES);
            truncated = true;
        }
    }
    candidates.sort_by(rank);
    let mut items = Vec::new();
    let mut handles = BTreeMap::<_, Option<String>>::new();
    let mut inactive_notes = BTreeSet::<(usize, NoteId)>::new();
    for Candidate { index, change } in candidates {
        if items.len() == limit {
            truncated = true;
            break;
        }
        let EntityId::Note(id) = change.entity else {
            if observed_foreign {
                call.commit_external_read();
            }
            return Err(invalid(ValidationReason::InvalidState));
        };
        if inactive_notes.contains(&(index, id.clone())) {
            continue;
        }
        let target = &targets[index];
        let Some(base_scope) = prepared_scopes[index].as_ref() else {
            continue;
        };
        if change.class.is_some_and(|class| {
            !base_scope
                .auth()
                .spaces()
                .get(&target.scope.space_id)
                .is_some_and(|grant| grant.read_classes.contains(&class))
        }) {
            continue;
        }
        let facts = {
            let mut scope = base_scope.clone();
            scope.budget = call.budget();
            let snapshot = match call
                .registry
                .engine
                .get_note_metadata(
                    if external {
                        scope.clone()
                    } else {
                        scope.with_preflight_taint()
                    },
                    GetNote {
                        note: id.clone(),
                        revision: Some(change.revision.clone()),
                        causal: CausalBasis::Await(Default::default()),
                    },
                )
                .await
            {
                Ok(value) => value,
                Err(error) if corpus::hidden(&error) => continue,
                Err(error) => {
                    if observed_foreign {
                        call.commit_external_read();
                    }
                    return Err(error);
                }
            };
            let metadata = &snapshot.metadata;
            if metadata.reference().note_id != id || metadata.revision() != &change.revision {
                if observed_foreign {
                    call.commit_external_read();
                }
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if metadata.current_lifecycle() != Lifecycle::Active
                || metadata.current_class() == DocClass::EncryptedNote
            {
                inactive_notes.insert((index, id));
                continue;
            }
            if metadata.class() == DocClass::EncryptedNote {
                continue;
            }
            let Some(facts) = snapshot.provenance else {
                if observed_foreign {
                    call.commit_external_read();
                }
                return Err(invalid(ValidationReason::SourceMismatch));
            };
            if target
                .project
                .as_ref()
                .is_some_and(|project| !metadata.in_project(project))
            {
                continue;
            }
            match corpus::note_metadata(call, &scope, metadata).await {
                Ok(()) => (),
                Err(error) if corpus::hidden(&error) => continue,
                Err(error) => {
                    if observed_foreign {
                        call.commit_external_read();
                    }
                    return Err(error);
                }
            }
            facts
        };
        let project = if external {
            if let Some(id) = &facts.project {
                let project = FolderRef {
                    space_id: target.scope.space_id.clone(),
                    folder_id: id.clone(),
                };
                let key = (target.scope.space_id.clone(), id.clone());
                match handles.get(&key) {
                    Some(handle) => handle.clone(),
                    None => {
                        let handle = match session::project_for_folder(call, &project).await {
                            Ok(info) => Some(format!("{}/{}", target.slug, info.project_slug)),
                            Err(error) if corpus::hidden(&error) => None,
                            Err(error) => return Err(error),
                        };
                        handles.insert(key, handle.clone());
                        handle
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        items.push(json!({
            "noteId": id,
            "spaceId": target.scope.space_id,
            "kind": kind(change.kind),
            "revision": change.revision,
            "title": facts.title,
            "principal": facts.principal,
            "projectId": facts.project,
            "project": project,
            "path": facts.path,
            "modifiedAt": facts.modified_at,
        }));
    }
    let mut result = json!({ "items": items });
    if external {
        result["truncated"] = json!(truncated);
    }
    Ok(result)
}

struct Candidate {
    index: usize,
    change: Change,
}

fn rank(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    let order = |change: &Change| change.provenance.as_ref().map(|facts| facts.modified_at);
    order(&right.change)
        .cmp(&order(&left.change))
        .then_with(|| {
            left.change
                .cursor
                .scope
                .space_id
                .cmp(&right.change.cursor.scope.space_id)
        })
        .then_with(|| right.change.cursor.after.cmp(&left.change.cursor.after))
}

fn kind(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Create => "create",
        ChangeKind::Edit => "edit",
        ChangeKind::Move => "move",
        ChangeKind::Rename => "rename",
        ChangeKind::Trash => "trash",
        ChangeKind::Restore => "restore",
        ChangeKind::Purge => "purge",
        ChangeKind::Redact => "redact",
    }
}
