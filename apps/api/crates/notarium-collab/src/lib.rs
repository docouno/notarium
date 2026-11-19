//! Durable, transport-independent collaboration on canonical Markdown notes.
#![forbid(unsafe_code)]

mod carrier;
mod crdt;
mod hub;
mod interceptor;
mod presence;
mod room;
mod session;
pub mod wire;

pub use hub::{CollabConfig, CollabHub};
pub use session::{
    CollabPeerSession, CollabSessionAuth, SessionClose, SessionClosed, SessionEvent,
};
