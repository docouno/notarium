mod folders;
pub(super) mod links;

use notarium_core::{DomainError, error::PortError};
use serde_json::Value;

pub(super) use links::{LinkArgs, format_link_line, resolve_target};

use super::{ToolCallContext, ToolName};

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::MoveFolder | ToolName::RenameFolder | ToolName::RenameProject => {
            folders::handle(call, name, args).await
        }
        ToolName::Link | ToolName::LinkMany => links::handle(call, name, args).await,
        _ => Err(DomainError::ResourceNotFound.into()),
    }
}
