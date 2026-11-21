//! Rebuildable structural indexes, declarative note views and knowledge graphs.

#[forbid(unsafe_code)]
mod board;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod derived;
#[cfg(not(feature = "test-support"))]
#[forbid(unsafe_code)]
mod derived;
#[forbid(unsafe_code)]
mod graph;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod index;
#[cfg(not(feature = "test-support"))]
#[forbid(unsafe_code)]
mod index;
#[forbid(unsafe_code)]
mod links;
mod mmap;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod nota;
#[cfg(not(feature = "test-support"))]
#[forbid(unsafe_code)]
mod nota;
#[forbid(unsafe_code)]
mod query;
#[forbid(unsafe_code)]
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
    BacklinkOwnerEndpoint, BacklinkOwnerResolver, PostgresProjectionCache, ProjectedNoteReadPort,
    ProjectionConfig, ProjectionEngine, ProjectorRuntime, SpaceEventBus,
};
#[cfg(feature = "test-support")]
pub use runtime::{BenchmarkCheckpoint, BenchmarkMappedCheckpoint, ProjectionPause};
