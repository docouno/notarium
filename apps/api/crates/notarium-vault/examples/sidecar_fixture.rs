#![forbid(unsafe_code)]

#[path = "sidecar_fixture/support.rs"]
mod support;

use notarium_core::epoch::DataRoot;
use notarium_vault::sidecar::SidecarOrigin;
use std::{env, path::PathBuf, process::ExitCode};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let [mode, origin_flag, origin] = args.as_slice() else {
        eprintln!("expected --token-stdin --allowed-origin ORIGIN");
        return ExitCode::FAILURE;
    };
    if mode != "--token-stdin" || origin_flag != "--allowed-origin" {
        eprintln!("expected --token-stdin --allowed-origin ORIGIN");
        return ExitCode::FAILURE;
    }
    let Ok(origin) = SidecarOrigin::try_from(origin.as_str()) else {
        eprintln!("unsupported origin");
        return ExitCode::FAILURE;
    };
    let Some(root) = env::var_os("NOTARIUM_SIDECAR_FIXTURE_DATA_ROOT") else {
        eprintln!("NOTARIUM_SIDECAR_FIXTURE_DATA_ROOT is required for the sidecar test fixture");
        return ExitCode::FAILURE;
    };
    let root = DataRoot::new(PathBuf::from(root));
    match support::launch(root, origin, false).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error:?}");
            ExitCode::FAILURE
        }
    }
}
