#[path = "../examples/projection_benchmarks/report.rs"]
mod report;

use std::{env, fs, io, path::Path};

use report::{CgroupSource, CgroupValue, MINIMUM_SAMPLES, ProjectionReport, Timing};

#[test]
fn measured_projection_samples_meet_the_budget_for_the_requested_tree() {
    if env::var("NOTARIUM_REQUIRE_PROJECTION_SAMPLES").as_deref() != Ok("1") {
        return;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .unwrap();
    let path = root.join(".artifacts/5-projections-graph/metrics.json");
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let report: ProjectionReport =
        serde_json::from_slice(&bytes).expect("projection benchmark report");
    let commit = env::var("NOTARIUM_PROJECTION_GIT_COMMIT").expect("host-supplied Git commit");
    let head_tree = env::var("NOTARIUM_PROJECTION_HEAD_TREE").expect("host-supplied HEAD tree");
    let source_tree =
        env::var("NOTARIUM_PROJECTION_SOURCE_TREE").expect("host-supplied source tree");
    let failures = report.failures((&commit, &head_tree, &source_tree));
    assert!(
        failures.is_empty(),
        "{}\n{}",
        path.display(),
        failures.join("\n")
    );
}

#[test]
fn projection_latency_reports_use_nearest_rank_percentiles() {
    let samples: Vec<u64> = (1..=MINIMUM_SAMPLES as u64).rev().collect();
    let timing = Timing::from_samples(samples);
    assert_eq!(timing.samples, MINIMUM_SAMPLES);
    assert_eq!((timing.p50_ns, timing.p95_ns, timing.p99_ns), (20, 38, 40));
}

#[test]
fn missing_nested_controller_uses_attributed_caller_limit() {
    let caller = "17179869184";
    let direct = CgroupValue::from_read(Ok("8589934592\n".into()), caller).unwrap();
    assert_eq!(direct.value, "8589934592");
    assert_eq!(direct.source, CgroupSource::Container);

    let fallback = CgroupValue::from_read(Err(io::ErrorKind::NotFound.into()), caller).unwrap();
    assert_eq!(fallback.value, caller);
    assert_eq!(fallback.source, CgroupSource::CallerFallback);

    let denied = CgroupValue::from_read(Err(io::ErrorKind::PermissionDenied.into()), caller);
    assert_eq!(denied.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}
