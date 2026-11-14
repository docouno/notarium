#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
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
    notarium_bin::serve().await
}
