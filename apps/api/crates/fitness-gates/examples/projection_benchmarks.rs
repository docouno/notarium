#![forbid(unsafe_code)]

//! Runs only with the checkout's PostgreSQL fixture and host-supplied Git witnesses.

#[path = "projection_benchmarks/fixture.rs"]
mod fixture;
#[path = "projection_benchmarks/micro.rs"]
mod micro;
#[path = "projection_benchmarks/observations.rs"]
mod observations;
#[path = "projection_benchmarks/report.rs"]
mod report;
#[path = "projection_benchmarks/workloads.rs"]
mod workloads;

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use fixture::PgFixture;
use report::{Backend, CgroupValue, Environment, ProjectionReport, REPORT_VERSION};

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() {
    if cfg!(debug_assertions) {
        panic!("run the release projection benchmark via the fixture launcher");
    }
    tracing_subscriber::fmt()
        .with_max_level(tracing_subscriber::filter::LevelFilter::WARN)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let mut arguments = parse_arguments();
    let work_root = PathBuf::from(required(&mut arguments, "--work-root"));
    let output = PathBuf::from(required(&mut arguments, "--output"));
    let head_commit = required(&mut arguments, "--git-base");
    let head_tree = required(&mut arguments, "--head-tree");
    let source_tree = required(&mut arguments, "--git-tree");
    let caller_cpu_max = required(&mut arguments, "--caller-cgroup-cpu");
    let caller_memory_max = required(&mut arguments, "--caller-cgroup-memory");
    assert!(
        arguments.is_empty(),
        "unrecognized projection benchmark arguments"
    );
    assert!(
        work_root.exists(),
        "fixture launcher must create the isolated work directory"
    );
    assert_eq!(
        output.parent(),
        Some(work_root.as_path()),
        "write the report inside the fixture work directory"
    );

    let volume = verify_non_tmpfs_mount(&work_root);
    let fixture = PgFixture::read();
    let pool = fixture.open_pool().await;
    let (postgres_version, unix_socket, fsync_on, synchronous_commit): (
        String,
        bool,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT current_setting('server_version'), inet_server_addr() IS NULL,
                               current_setting('fsync'), current_setting('synchronous_commit')",
    )
    .fetch_one(&pool)
    .await
    .expect("inspect live PostgreSQL fixture");
    assert!(postgres_version.starts_with("16."));
    assert!(unix_socket);
    assert_eq!(fsync_on, "on");
    assert_eq!(synchronous_commit, "on");

    let cpu_max = read_cgroup("cpu.max", &caller_cpu_max);
    let memory_max = read_cgroup("memory.max", &caller_memory_max);
    let environment = Environment {
        head_commit,
        head_tree,
        source_tree,
        rust_profile: "release".into(),
        allocator: "mimalloc".into(),
        filesystem: volume.0,
        mount_point: volume.1,
        caller_cpu_max,
        caller_memory_max,
        cpu_max,
        memory_max,
        generated_at_unix_s: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        kernel_release: read_setting("/proc/sys/kernel/osrelease"),
        postgres_version,
        postgres_unix_socket: unix_socket,
        postgres_fsync: fsync_on == "on",
        postgres_synchronous_commit: synchronous_commit == "on",
    };
    let sqlite =
        workloads::backend_profile(Backend::Sqlite, &work_root.join("sqlite"), &fixture, &pool)
            .await;
    let postgres = workloads::backend_profile(
        Backend::Postgres,
        &work_root.join("postgres"),
        &fixture,
        &pool,
    )
    .await;
    let microprofile = micro::run(&work_root.join("million")).await;
    pool.close().await;
    let process_vm_hwm_bytes = read_vm_hwm_bytes();
    eprintln!(
        "projection benchmark process VmHWM: {} MiB ({process_vm_hwm_bytes} bytes)",
        process_vm_hwm_bytes / (1024 * 1024)
    );

    let report = ProjectionReport {
        version: REPORT_VERSION,
        environment,
        process_vm_hwm_bytes,
        backends: [sqlite, postgres],
        microprofile,
    };
    fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .expect("write projection evidence");
    let git = (
        &report.environment.head_commit,
        &report.environment.head_tree,
        &report.environment.source_tree,
    );
    for failure in report.failures((git.0, git.1, git.2)) {
        eprintln!("projection sample outside budget: {failure}");
    }
}

fn parse_arguments() -> BTreeMap<String, String> {
    let mut parsed = BTreeMap::new();
    let mut arguments = env::args().skip(1);
    while let Some(arg) = arguments.next() {
        let value = arguments
            .next()
            .unwrap_or_else(|| panic!("missing value for {arg}"));
        assert!(
            parsed.insert(arg, value).is_none(),
            "duplicate projection benchmark argument"
        );
    }
    parsed
}

fn required(arguments: &mut BTreeMap<String, String>, key: &str) -> String {
    arguments
        .remove(key)
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn read_vm_hwm_bytes() -> u64 {
    let status = fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    let kb: u64 = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|num| num.parse().ok())
        .expect("parse VmHWM kB from /proc/self/status");
    kb.saturating_mul(1024)
}

fn read_setting(path: &str) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{path}: {error}"))
        .trim()
        .to_owned()
}

fn read_cgroup(setting: &str, caller: &str) -> CgroupValue {
    let path = Path::new("/sys/fs/cgroup").join(setting);
    let value = CgroupValue::from_read(fs::read_to_string(&path), caller)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    eprintln!(
        "projection benchmark cgroup {setting}: {} ({:?}; caller {caller})",
        value.value, value.source
    );
    value
}

fn verify_non_tmpfs_mount(path: &Path) -> (String, String) {
    let path = fs::canonicalize(path).expect("resolve the benchmark work directory");
    let mount_info =
        fs::read_to_string("/proc/self/mountinfo").expect("read Linux mount information");
    let (mount, filesystem) = mount_info
        .lines()
        .filter_map(|line| {
            let (mount, filesystem) = line.split_once(" - ")?;
            let encoded = mount.split_whitespace().nth(4)?;
            let mount = encoded
                .replace("\\040", " ")
                .replace("\\011", "\t")
                .replace("\\012", "\n")
                .replace("\\134", "\\");
            let filesystem = filesystem.split_whitespace().next()?;
            path.starts_with(&mount).then_some((mount, filesystem))
        })
        .max_by_key(|(mount, _)| mount.len())
        .expect("find the mount containing benchmark data");
    assert!(
        !matches!(filesystem, "tmpfs" | "ramfs"),
        "benchmark work directory must use an on-disk filesystem"
    );
    (filesystem.to_owned(), mount)
}
