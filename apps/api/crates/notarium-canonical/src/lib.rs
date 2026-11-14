//! Reserved for the canonical subsystem. Domain behavior is added in later waves.

#[cfg(test)]
mod tests {
    // A compile smoke test for the initial scaffold, not domain certification.
    #[test]
    fn scaffold_has_the_expected_package_identity() {
        assert_eq!(env!("CARGO_PKG_NAME"), "notarium-canonical");
    }
}
