//! Rebuildable structural indexes, declarative note views and knowledge graphs.

mod board;
#[cfg(feature = "test-support")]
pub mod derived;
#[cfg(not(feature = "test-support"))]
mod derived;
mod graph;
#[cfg(feature = "test-support")]
pub mod index;
#[cfg(not(feature = "test-support"))]
mod index;
mod links;
mod mmap;
pub mod nota;
mod query;
mod runtime;

#[cfg(feature = "test-support")]
#[doc(hidden)]
pub mod benchmark_planner {
    pub use crate::query::{
        WindowInput, plan_view, select_window, structural_universe, view_source_candidates,
    };
}

pub use notarium_core::ports::{
    ChatBacklink, ChatBacklinkCursor, ChatBacklinkPage, LinkReadPort, NoteLink, NoteLinkCursor,
    NoteLinkDirection, NoteLinkPage,
};
pub use runtime::{
    BacklinkOwnerEndpoint, BacklinkOwnerResolver, ProjectedNoteReadPort, ProjectionConfig,
    ProjectionEngine, ProjectorRuntime, SpaceEventBus,
};
#[cfg(feature = "test-support")]
pub use runtime::{BenchmarkCheckpoint, BenchmarkMappedCheckpoint, ProjectionPause};
