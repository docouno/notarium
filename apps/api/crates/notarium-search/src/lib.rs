//! Rebuildable search indexes over canonical document and chat history.

pub mod config;
pub mod embed;
mod engine;
mod indexer;
pub mod layout;
pub mod lexical;
mod model;
pub mod ports;
mod query;
pub mod vector;

pub use engine::{SearchDependencies, SearchEngine};
#[doc(hidden)]
pub use query::ranking::{Candidate, fuse as fuse_search_candidates};

#[cfg(test)]
mod tests {
    // A compile smoke test for the initial scaffold, not domain certification.
    #[test]
    fn scaffold_has_the_expected_package_identity() {
        assert_eq!(env!("CARGO_PKG_NAME"), "notarium-search");
    }
}
