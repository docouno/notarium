//! Rebuildable search indexes over canonical document and chat history.

pub mod config;
pub mod embed;
pub mod layout;
pub mod lexical;
pub mod ports;
pub mod vector;

#[cfg(test)]
mod tests {
    // A compile smoke test for the initial scaffold, not domain certification.
    #[test]
    fn scaffold_has_the_expected_package_identity() {
        assert_eq!(env!("CARGO_PKG_NAME"), "notarium-search");
    }
}
