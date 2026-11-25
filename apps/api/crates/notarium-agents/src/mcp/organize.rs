mod folders;
pub(super) mod links;

use notarium_core::{DomainError, error::PortError};
use serde_json::Value;

pub(super) use links::{
    LinkArgs, ProposalLink as LinkPlan, apply_links, authorize_link_source_owner, describe_links,
    format_link_line, is_valid_link_item, plan_links, resolve_target, validate_link_args,
    validate_link_proposal_input,
};

use super::{ToolCallContext, ToolName};

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::MoveFolder | ToolName::RenameFolder | ToolName::RenameProject => {
            Box::pin(folders::handle(call, name, args)).await
        }
        ToolName::Link | ToolName::LinkMany => Box::pin(links::handle(call, name, args)).await,
        _ => Err(DomainError::ResourceNotFound.into()),
    }
}
