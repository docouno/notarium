fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "notarium-migrate — offline migration scaffold\nUsage: notarium-migrate --help\nData migration is not implemented yet."
        );
        return std::process::ExitCode::SUCCESS;
    }
    eprintln!("notarium-migrate is a scaffold; use --help");
    std::process::ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scaffold_has_the_expected_package_identity() {
        assert_eq!(env!("CARGO_PKG_NAME"), "notarium-migrate");
    }
}
