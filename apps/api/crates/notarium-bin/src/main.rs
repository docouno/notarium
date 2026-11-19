#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == [notarium_jobs::SQLITE_VERIFIER_ARGUMENT] {
        return notarium_jobs::run_sqlite_verifier().map_err(std::io::Error::other);
    }
    if args == ["--help"] {
        println!(
            "notariumd — bootstrap HTTP daemon\nUsage: notariumd [--help]\nPORT defaults to 3000. Product services are not implemented yet."
        );
        return Ok(());
    }
    if !args.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unknown arguments; use --help",
        ));
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(notarium_bin::serve())
}
