//! In-process agent services for MCP, chats and scheduled maintenance.

#![forbid(unsafe_code)]

pub mod abilities;
pub mod chats;
mod completion;
pub mod keepers;
pub mod mcp;
pub mod revocation;
