#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == [notarium_jobs::SQLITE_VERIFIER_ARGUMENT] {
        return if notarium_jobs::run_sqlite_verifier().is_ok() {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::FAILURE
        };
    }
    if args == ["--help"] {
        println!(
            "notarium-sidecar — desktop scaffold\nUsage: notarium-sidecar --help\nThe protected desktop lifecycle is not implemented yet."
        );
        return std::process::ExitCode::SUCCESS;
    }
    eprintln!("notarium-sidecar is a scaffold; use --help");
    std::process::ExitCode::from(2)
}
