//! Rebuildable search indexes over canonical document and chat history.

#[forbid(unsafe_code)]
pub mod config;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod embed;
#[cfg(not(feature = "test-support"))]
#[allow(dead_code)]
#[forbid(unsafe_code)]
mod embed;
#[forbid(unsafe_code)]
mod engine;
#[forbid(unsafe_code)]
mod indexer;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod layout;
#[cfg(not(feature = "test-support"))]
#[allow(dead_code)]
#[forbid(unsafe_code)]
mod layout;
#[cfg(feature = "test-support")]
#[forbid(unsafe_code)]
pub mod lexical;
#[cfg(not(feature = "test-support"))]
#[allow(dead_code)]
#[forbid(unsafe_code)]
mod lexical;
#[forbid(unsafe_code)]
mod model;
#[forbid(unsafe_code)]
pub mod ports;
#[forbid(unsafe_code)]
mod query;
#[cfg(feature = "test-support")]
pub mod vector;
#[cfg(not(feature = "test-support"))]
#[allow(dead_code)]
mod vector;

pub use engine::{SearchDependencies, SearchEngine};
#[cfg(feature = "test-support")]
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
