use super::super::{EgressTarget, ToolCallContext, corpus, invalid, session};
use notarium_core::{
    error::{PortError, ValidationReason},
    ids::{EpisodeId, SpaceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    ports::ControlPageRequest,
    receipt::{AwaitWatermarks, CausalBasis},
};

const MAX_PROJECT_CANDIDATES: usize = 4096;
const PROJECT_PAGE_LIMIT: u16 = 100;

pub(super) struct ReadTarget {
    pub scope: HistoryScope,
    pub slug: String,
    pub project: Option<FolderRef>,
    pub last_seq: SpaceSeq,
}

impl ReadTarget {
    pub(super) fn causal(&self) -> CausalBasis {
        CausalBasis::Await(AwaitWatermarks::at(self.scope.clone(), self.last_seq))
    }
}

pub(super) struct ReadTargets {
    pub targets: Vec<ReadTarget>,
    pub targeted_project: bool,
}

pub(super) async fn targets(
    call: &ToolCallContext<'_>,
    project: Option<&str>,
    episode: Option<&EpisodeId>,
    all_spaces: bool,
) -> Result<ReadTargets, PortError> {
    let target = session::selected_project(call, project, episode).await?;
    if let Some(project) = target {
        session::project_for_folder(call, &project).await?;
        return Ok(ReadTargets {
            targets: vec![one(call, &project.space_id, Some(project.clone())).await?],
            targeted_project: true,
        });
    }
    if all_spaces {
        let in_app = matches!(call.target, EgressTarget::InAppProvider { .. });
        let mut out = Vec::new();
        let mut scanned_projects = 0usize;
        for space in session::readable_spaces(call).await?.into_values() {
            let grant_project = call
                .auth
                .spaces()
                .get(&space.space.id)
                .and_then(|grant| grant.project_root.as_ref())
                .map(|root| FolderRef {
                    space_id: space.space.id.clone(),
                    folder_id: root.clone(),
                });
            if !in_app {
                out.push(ReadTarget {
                    scope: space.history,
                    slug: space.slug,
                    project: grant_project,
                    last_seq: space.last_seq,
                });
                continue;
            }
            // For in-app provider calls, exclude unconsented Spaces before
            // running search/recent queries so they cannot leak degradation,
            // truncation, or cross-space BranchTaint side channels.
            let scope = call.space(space.history.clone())?;
            if let Some(project) = grant_project {
                match call.provider_selection(&scope, Some(project.clone())).await {
                    Ok(Some(sel))
                        if sel.project_only.as_ref().is_none_or(|req| req == &project) =>
                    {
                        out.push(ReadTarget {
                            scope: space.history,
                            slug: space.slug,
                            project: Some(project),
                            last_seq: space.last_seq,
                        });
                    }
                    Ok(_) => (),
                    Err(error) if corpus::hidden(&error) => (),
                    Err(error) => return Err(error),
                }
                continue;
            }
            match call.provider_selection(&scope, None).await {
                Ok(Some(sel)) => {
                    out.push(ReadTarget {
                        scope: space.history,
                        slug: space.slug,
                        project: sel.project_only,
                        last_seq: space.last_seq,
                    });
                }
                Ok(None) => {
                    out.push(ReadTarget {
                        scope: space.history,
                        slug: space.slug,
                        project: None,
                        last_seq: space.last_seq,
                    });
                }
                Err(error) if corpus::hidden(&error) => {
                    // No Space-wide consent; emit targets only for individually
                    // consented projects in this Space, enforcing the same global
                    // project-candidate budget and cursor-progress checks used by
                    // ordinary project traversal.
                    let mut continuation: Option<String> = None;
                    for _ in 0..=MAX_PROJECT_CANDIDATES {
                        let page = call
                            .registry
                            .catalog
                            .projects(
                                scope.clone(),
                                ControlPageRequest::new(PROJECT_PAGE_LIMIT, continuation.clone())?,
                            )
                            .await?;
                        if page.items.len() > usize::from(PROJECT_PAGE_LIMIT) {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                        scanned_projects = scanned_projects.saturating_add(page.items.len());
                        if scanned_projects > MAX_PROJECT_CANDIDATES {
                            return Err(invalid(ValidationReason::BudgetExceeded));
                        }
                        for item in page.items {
                            match call
                                .provider_selection(&scope, Some(item.folder.clone()))
                                .await
                            {
                                Ok(Some(sel))
                                    if sel
                                        .project_only
                                        .as_ref()
                                        .is_none_or(|req| req == &item.folder) =>
                                {
                                    out.push(ReadTarget {
                                        scope: space.history.clone(),
                                        slug: space.slug.clone(),
                                        project: Some(item.folder),
                                        last_seq: space.last_seq,
                                    });
                                }
                                Ok(_) => (),
                                Err(err) if corpus::hidden(&err) => (),
                                Err(err) => return Err(err),
                            }
                        }
                        match page.continuation {
                            Some(next) => {
                                if continuation.as_ref() == Some(&next) {
                                    return Err(invalid(ValidationReason::InvalidState));
                                }
                                continuation = Some(next);
                            }
                            None => {
                                continuation = None;
                                break;
                            }
                        }
                    }
                    if continuation.is_some() {
                        return Err(invalid(ValidationReason::BudgetExceeded));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(ReadTargets {
            targets: out,
            targeted_project: false,
        })
    } else {
        let id = if let Some(id) = call.auth.pinned_write_space() {
            Some(id.clone())
        } else {
            call.registry
                .control
                .whoami(call.account())
                .await?
                .personal_space
        };
        let Some(id) = id else {
            return Ok(ReadTargets {
                targets: Vec::new(),
                targeted_project: false,
            });
        };
        let project = call
            .auth
            .spaces()
            .get(&id)
            .and_then(|grant| grant.project_root.as_ref())
            .map(|root| FolderRef {
                space_id: id.clone(),
                folder_id: root.clone(),
            });
        Ok(ReadTargets {
            targets: vec![one(call, &id, project).await?],
            targeted_project: false,
        })
    }
}

async fn one(
    call: &ToolCallContext<'_>,
    id: &SpaceId,
    project: Option<FolderRef>,
) -> Result<ReadTarget, PortError> {
    let space = session::readable_space(call, id).await?;
    Ok(ReadTarget {
        scope: space.history,
        slug: space.slug,
        project,
        last_seq: space.last_seq,
    })
}
