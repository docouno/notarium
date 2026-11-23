use super::super::{ToolCallContext, session};
use notarium_core::{
    error::PortError,
    ids::{EpisodeId, SpaceId, SpaceSeq},
    model::{FolderRef, HistoryScope},
    receipt::{AwaitWatermarks, CausalBasis},
};

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

pub(super) async fn targets(
    call: &ToolCallContext<'_>,
    project: Option<&str>,
    episode: Option<&EpisodeId>,
    all_spaces: bool,
) -> Result<Vec<ReadTarget>, PortError> {
    let target = session::selected_project(call, project, episode).await?;
    if let Some(project) = target {
        session::project_for_folder(call, &project).await?;
        return Ok(vec![
            one(call, &project.space_id, Some(project.clone())).await?,
        ]);
    }
    if all_spaces {
        Ok(session::readable_spaces(call)
            .await?
            .into_values()
            .map(|space| {
                let project = call
                    .auth
                    .spaces()
                    .get(&space.space.id)
                    .and_then(|grant| grant.project_root.as_ref())
                    .map(|root| FolderRef {
                        space_id: space.space.id,
                        folder_id: root.clone(),
                    });
                ReadTarget {
                    scope: space.history,
                    slug: space.slug,
                    project,
                    last_seq: space.last_seq,
                }
            })
            .collect())
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
            return Ok(Vec::new());
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
        Ok(vec![one(call, &id, project).await?])
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
