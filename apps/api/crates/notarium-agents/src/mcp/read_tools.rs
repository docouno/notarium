mod cursor;
mod directory;
mod predicates;
mod recent;
mod retrieval;
mod scope;

pub(super) use cursor::NoteCursors;

use super::{ToolCallContext, ToolName, invalid};
use notarium_core::error::{PortError, ValidationReason};
use serde_json::Value;

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::ListNotes => directory::list(call, args).await,
        ToolName::RecentActivity => recent::recent(call, args).await,
        ToolName::Search | ToolName::Recall => retrieval::retrieve(call, name, args).await,
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}
