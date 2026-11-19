use std::io;

use serde::{Deserialize, Serialize};

pub(crate) const REPORT_VERSION: u8 = 3;
pub(crate) const MICROPROFILE_SCOPE: &str =
    "synthetic_checkpoint_planner_and_50_row_sqlite_hydration";
pub(crate) const CORPUS_NOTES: usize = 100_000;
pub(crate) const LINKS_PER_NOTE: usize = 5;
pub(crate) const FIELDS_PER_NOTE: usize = 5;
pub(crate) const TAIL_NOTES: usize = 1_000;
pub(crate) const LAGGED_BATCH_NOTES: usize = 10_000;
pub(crate) const MICROPROFILE_NOTES: usize = 1_000_000;
pub(crate) const MINIMUM_SAMPLES: usize = 40;
const MS: u64 = 1_000_000;
const MIB: u64 = 1_048_576;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectionReport {
    pub version: u8,
    pub environment: Environment,
    pub backends: [BackendMeasurements; 2],
    pub microprofile: Microprofile,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Environment {
    pub head_commit: String,
    pub head_tree: String,
    pub source_tree: String,
    pub rust_profile: String,
    pub allocator: String,
    pub filesystem: String,
    pub mount_point: String,
    pub caller_cpu_max: String,
    pub caller_memory_max: String,
    pub cpu_max: CgroupValue,
    pub memory_max: CgroupValue,
    pub generated_at_unix_s: u64,
    pub kernel_release: String,
    pub postgres_version: String,
    pub postgres_unix_socket: bool,
    pub postgres_fsync: bool,
    pub postgres_synchronous_commit: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CgroupValue {
    pub value: String,
    pub source: CgroupSource,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CgroupSource {
    Container,
    CallerFallback,
}

impl CgroupValue {
    pub fn from_read(contents: io::Result<String>, caller: &str) -> io::Result<Self> {
        match contents {
            Ok(contents) => Ok(Self {
                value: contents.trim().to_owned(),
                source: CgroupSource::Container,
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self {
                value: caller.to_owned(),
                source: CgroupSource::CallerFallback,
            }),
            Err(error) => Err(error),
        }
    }

    fn validates(&self, caller: &str, check: fn(&str) -> bool) -> bool {
        check(caller)
            && check(&self.value)
            && (self.source == CgroupSource::Container || self.value == caller)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BackendMeasurements {
    pub backend: Backend,
    pub corpus_notes: usize,
    pub corpus_links: usize,
    pub fields_per_note: usize,
    pub cold_checkpoint_open: Timing,
    pub warm_board: Timing,
    pub cold_board: Timing,
    pub neighborhood: Timing,
    pub replayed_tail_notes: usize,
    pub tail_replay_ns: u64,
    pub lagged_batch_notes: usize,
    pub ryow_frames: usize,
    pub stale_frames: usize,
    pub rebuild_ns: u64,
    pub max_rebuild_read_ns: u64,
    pub rebuild_sqlite_busy: u64,
    pub identical_rebuild: bool,
    pub unqualified_move_rewrites: usize,
    pub candidate_move_rewrites: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Backend {
    Sqlite,
    Postgres,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Microprofile {
    pub scope: String,
    pub indexed_notes: usize,
    pub hydration_table_rows: usize,
    pub checkpoint_bytes: u64,
    pub cold_checkpoint_open: Timing,
    pub warm_board: Timing,
    pub fence: [FenceSample; 4],
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FenceSample {
    pub phase: FencePhase,
    pub private_steady_bytes: u64,
    pub private_peak_bytes: u64,
    pub shared_file_bytes: u64,
    pub shared_overlay_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FencePhase {
    Hydrated,
    Lagged,
    Compacted,
    Evicted,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Timing {
    pub samples: usize,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
}

impl Timing {
    pub fn from_samples(mut observations_ns: Vec<u64>) -> Self {
        assert!(!observations_ns.is_empty(), "empty duration sample");
        observations_ns.sort_unstable();
        let quantile =
            |percent: usize| observations_ns[(percent * observations_ns.len()).div_ceil(100) - 1];
        Self {
            samples: observations_ns.len(),
            p50_ns: quantile(50),
            p95_ns: quantile(95),
            p99_ns: quantile(99),
        }
    }

    fn check(&self, name: &str, limit_ns: u64, inclusive: bool, failures: &mut Vec<String>) {
        if self.samples < MINIMUM_SAMPLES
            || self.p50_ns == 0
            || self.p50_ns > self.p95_ns
            || self.p95_ns > self.p99_ns
        {
            failures.push(format!(
                "{name} has malformed or insufficient samples: {self:?}"
            ));
        }
        if self.p95_ns > limit_ns || (!inclusive && self.p95_ns == limit_ns) {
            let inequality = if inclusive { "<=" } else { "<" };
            failures.push(format!(
                "{name} p95 {} ns must be {inequality} {limit_ns} ns",
                self.p95_ns
            ));
        }
    }
}

fn expect(condition: bool, failures: &mut Vec<String>, reason: String) {
    if !condition {
        failures.push(reason);
    }
}

impl ProjectionReport {
    pub fn failures(&self, expected_git: (&str, &str, &str)) -> Vec<String> {
        let mut failures = Vec::new();
        let env = &self.environment;
        let actual_git = (
            env.head_commit.as_str(),
            env.head_tree.as_str(),
            env.source_tree.as_str(),
        );
        expect(
            self.version == REPORT_VERSION
                && expected_git == actual_git
                && is_git_id(actual_git.0)
                && is_git_id(actual_git.1)
                && is_git_id(actual_git.2),
            &mut failures,
            format!(
                "report is for {actual_git:?}; expected {expected_git:?} and schema {REPORT_VERSION}"
            ),
        );
        expect(
            env.rust_profile == "release"
                && env.allocator == "mimalloc"
                && !matches!(env.filesystem.as_str(), "" | "tmpfs" | "ramfs")
                && env.mount_point.starts_with('/')
                && !env.kernel_release.is_empty()
                && env.generated_at_unix_s > 0
                && env.postgres_unix_socket
                && env.postgres_version.starts_with("16.")
                && env.postgres_fsync
                && env.postgres_synchronous_commit,
            &mut failures,
            "release environment, on-disk filesystem and PostgreSQL 16 Unix socket are required"
                .into(),
        );
        expect(
            env.cpu_max.validates(&env.caller_cpu_max, valid_cpu_limit),
            &mut failures,
            "invalid cpu.max measurement or caller fallback".into(),
        );
        expect(
            env.memory_max
                .validates(&env.caller_memory_max, valid_cgroup_amount),
            &mut failures,
            "invalid memory.max measurement or caller fallback".into(),
        );
        let [sqlite, postgres] = &self.backends;
        expect(
            sqlite.backend == Backend::Sqlite && postgres.backend == Backend::Postgres,
            &mut failures,
            "report must contain SQLite and PostgreSQL profiles in order".into(),
        );
        for profile in &self.backends {
            profile.check(&mut failures);
        }
        self.microprofile.check(&mut failures);
        failures
    }
}

fn valid_cgroup_amount(value: &str) -> bool {
    value == "max" || value.parse::<u64>().is_ok_and(|amount| amount > 0)
}

fn valid_cpu_limit(value: &str) -> bool {
    let mut fields = value.split_whitespace();
    let (Some(quota), Some(period), None) = (fields.next(), fields.next(), fields.next()) else {
        return false;
    };
    valid_cgroup_amount(quota) && period.parse::<u64>().is_ok_and(|amount| amount > 0)
}

fn is_git_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

impl BackendMeasurements {
    fn check(&self, failures: &mut Vec<String>) {
        let label = match self.backend {
            Backend::Sqlite => "SQLite",
            Backend::Postgres => "PostgreSQL",
        };
        let cohort = self.corpus_notes == CORPUS_NOTES
            && self.corpus_links == CORPUS_NOTES * LINKS_PER_NOTE
            && self.fields_per_note == FIELDS_PER_NOTE;
        expect(
            cohort,
            failures,
            format!("{label} measured the wrong corpus"),
        );
        for (operation, timing, limit, inclusive) in [
            (
                "cold checkpoint open",
                &self.cold_checkpoint_open,
                5 * MS,
                false,
            ),
            ("warm board", &self.warm_board, 5 * MS, false),
            ("cold board", &self.cold_board, 15 * MS, true),
            ("two-hop neighborhood", &self.neighborhood, MS, false),
        ] {
            timing.check(&format!("{label} {operation}"), limit, inclusive, failures);
        }
        expect(
            self.replayed_tail_notes == TAIL_NOTES && (1..65 * MS).contains(&self.tail_replay_ns),
            failures,
            format!(
                "{label} durable tail replay: {} edits in {} ns",
                self.replayed_tail_notes, self.tail_replay_ns
            ),
        );
        expect(
            self.lagged_batch_notes == LAGGED_BATCH_NOTES
                && self.ryow_frames > 0
                && self.stale_frames == 0,
            failures,
            format!(
                "{label} board race: {} import notes, {} stale frames out of {}",
                self.lagged_batch_notes, self.stale_frames, self.ryow_frames
            ),
        );
        expect(
            (1..=120_000 * MS).contains(&self.rebuild_ns)
                && (1..250 * MS).contains(&self.max_rebuild_read_ns)
                && self.rebuild_sqlite_busy == 0
                && self.identical_rebuild,
            failures,
            format!(
                "{label} rebuild: {} ns elapsed (budget <= 120s), {} ns maximum read, {} busy, equivalent={}",
                self.rebuild_ns,
                self.max_rebuild_read_ns,
                self.rebuild_sqlite_busy,
                self.identical_rebuild
            ),
        );
        expect(
            self.unqualified_move_rewrites == 0,
            failures,
            format!(
                "{label} folder move rewrote {} unqualified links",
                self.unqualified_move_rewrites
            ),
        );
        expect(
            self.candidate_move_rewrites == 0,
            failures,
            format!(
                "{label} folder move rewrote {} link candidates",
                self.candidate_move_rewrites
            ),
        );
    }
}

impl Microprofile {
    fn check(&self, failures: &mut Vec<String>) {
        expect(
            self.scope == MICROPROFILE_SCOPE && self.hydration_table_rows == 50,
            failures,
            format!(
                "million-note microprofile metadata mismatch: scope={}, hydration_table_rows={}",
                self.scope, self.hydration_table_rows
            ),
        );
        expect(
            self.indexed_notes == MICROPROFILE_NOTES
                && (150 * MIB..=180 * MIB).contains(&self.checkpoint_bytes),
            failures,
            format!(
                "million-note checkpoint: {} notes, {} bytes (expected 150–180 MiB)",
                self.indexed_notes, self.checkpoint_bytes
            ),
        );
        self.cold_checkpoint_open.check(
            "million-note cold checkpoint open",
            500 * MS,
            true,
            failures,
        );
        self.warm_board
            .check("million-note warm board", 5 * MS, false, failures);
        for (phase, sample) in [
            FencePhase::Hydrated,
            FencePhase::Lagged,
            FencePhase::Compacted,
            FencePhase::Evicted,
        ]
        .into_iter()
        .zip(&self.fence)
        {
            expect(
                sample.phase == phase
                    && (1..=8 * MIB).contains(&sample.private_steady_bytes)
                    && sample.private_peak_bytes >= sample.private_steady_bytes,
                failures,
                format!(
                    "million-note fence {phase:?}: invalid or over-budget private usage {sample:?}"
                ),
            );
        }
    }
}
