use super::*;
use notarium_core::receipt::MutationReceiptToken;
use serde_json::{Value, json};
use std::io::{BufWriter, Write};

const TEMPLATE: &str = include_str!("field-notes.md");

struct Note {
    id: NoteId,
    rev: RevisionId,
    receipt: MutationReceiptToken,
    carrier: String,
    slot: usize,
    body: usize,
    iteration: u64,
}

#[derive(Debug, Serialize)]
struct Fault {
    code: String,
    detail: String,
}

impl From<PortError> for Fault {
    fn from(e: PortError) -> Self {
        Self {
            code: e.code().into(),
            detail: format!("{e:?}"),
        }
    }
}

fn mismatch(msg: &str) -> Fault {
    Fault {
        code: "oracle".into(),
        detail: msg.into(),
    }
}

async fn read(
    store: &CanonicalStore,
    auth: &EngineAuthContext,
    scope: &HistoryScope,
    note: &Note,
) -> Result<(), Fault> {
    let snap = store
        .get_note(
            fast_space_ctx(auth, scope),
            GetNote {
                note: note.id.clone(),
                revision: None,
                causal: CausalBasis::Exact(
                    ReceiptSet::new([note.receipt.clone()]).expect("receipt"),
                ),
            },
        )
        .await?;
    let bytes = snap.document.explicit_read(auth).map_err(PortError::from)?;
    if snap.document.reference().space_id != scope.space_id
        || snap.document.reference().note_id != note.id
        || snap.document.revision() != &note.rev
        || snap.byte_size != CARRIER_TARGET_BYTES as u64
        || bytes != note.carrier
    {
        return Err(mismatch(
            "full carrier, reference, size or head revision differed",
        ));
    }
    Ok(())
}

async fn save(
    store: &CanonicalStore,
    auth: &EngineAuthContext,
    scope: &HistoryScope,
    actor: &PrincipalId,
    note: &mut Note,
) -> Result<(), Fault> {
    let next = format!("{:016x}", note.iteration + 1);
    let body = ByteSpan::new(note.body, note.carrier.len()).expect("valid Markdown body");
    let edited = ByteSpan::new(note.slot, note.slot + 16).expect("edit byte span");
    let utf16 = Utf16Span::new(note.slot, note.slot + 16).expect("ASCII UTF-16 edit span");
    let plan = CarrierPatchPlan {
        base_content_hash: notarium_syntax::content_digest(&note.carrier),
        body_range: body,
        edits: vec![CarrierSplice {
            origin: CarrierEditOrigin::Body,
            bytes: CarrierByteSpan(edited),
            utf16: CarrierUtf16Span(utf16),
            replacement: next.clone(),
            replacement_utf16_len: 16,
        }],
    };
    let mut cmd = next_mutation(
        scope,
        actor,
        EditNote {
            note: note.id.clone(),
            plan,
        },
    );
    cmd.preconditions.revision = Some(note.rev.clone());
    let ack = store.edit_note(fast_space_ctx(auth, scope), cmd).await?;
    if ack.receipt.scope() != scope
        || ack.receipt.seq() <= note.receipt.seq()
        || ack.value.note != note.id
        || ack.value.revision == note.rev
    {
        return Err(mismatch(
            "edit receipt failed scope, increasing sequence or new revision",
        ));
    }
    note.rev = ack.value.revision;
    note.receipt = ack.receipt;
    note.carrier.replace_range(note.slot..note.slot + 16, &next);
    note.iteration += 1;
    Ok(())
}

#[derive(Serialize)]
struct Sample {
    worker: usize,
    attempt: u64,
    measured: bool,
    started_ns: u64,
    open_ns: u64,
    save_ns: Option<u64>,
    readback_ns: Option<u64>,
    cycle_ns: u64,
    error: Option<(&'static str, Fault)>,
}

fn ns(t: Duration) -> u64 {
    u64::try_from(t.as_nanos()).expect("duration fits u64 ns")
}

async fn run_worker(
    worker: usize,
    users: usize,
    store: CanonicalStore,
    auth: EngineAuthContext,
    scope: HistoryScope,
    actor: PrincipalId,
    mut note: Note,
    start: tokio::sync::watch::Receiver<Option<Instant>>,
    warm: Duration,
    timed: Duration,
) -> (Note, Vec<Sample>) {
    let mut start = start;
    start.wait_for(|s| s.is_some()).await.expect("common start");
    let epoch = start.borrow().expect("start");
    let mut samples = Vec::new();
    loop {
        let begin = Instant::now();
        let offset = begin.duration_since(epoch);
        if offset >= warm + timed {
            break;
        }
        let opened = read(&store, &auth, &scope, &note).await;
        let after_open = Instant::now();
        let mut row = Sample {
            worker,
            attempt: samples.len() as u64 + 1,
            measured: offset >= warm,
            started_ns: ns(offset),
            open_ns: ns(after_open.duration_since(begin)),
            save_ns: None,
            readback_ns: None,
            cycle_ns: 0,
            error: None,
        };
        match opened {
            Err(e) => row.error = Some(("open", e)),
            Ok(()) => {
                let t = Instant::now();
                let saved = save(&store, &auth, &scope, &actor, &mut note).await;
                row.save_ns = Some(ns(t.elapsed()));
                match saved {
                    Err(e) => row.error = Some(("save", e)),
                    Ok(()) => {
                        let t = Instant::now();
                        let checked = read(&store, &auth, &scope, &note).await;
                        row.readback_ns = Some(ns(t.elapsed()));
                        if let Err(e) = checked {
                            row.error = Some(("readback", e));
                        }
                    }
                }
            }
        }
        row.cycle_ns = ns(begin.elapsed());
        let failed = row.error.is_some();
        samples.push(row);
        if failed {
            break;
        }
        if users == 8 {
            tokio::time::sleep(Duration::from_millis(100)).await
        }
    }
    (note, samples)
}

fn resources() -> Value {
    let mut stats = BTreeMap::new();
    for p in [
        "/sys/fs/cgroup/cpu.max",
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/cpu.stat",
        "/sys/fs/cgroup/io.stat",
        "/sys/fs/cgroup/io.pressure",
        "/sys/fs/cgroup/cpu.pressure",
    ] {
        stats.insert(p, fs::read_to_string(p).ok());
    }
    json!(stats)
}

fn write_json(path: &Path, val: &Value) {
    fs::write(path, serde_json::to_vec_pretty(val).expect("serialize")).expect("write report");
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
pub(super) async fn series(args: &[String]) {
    assert!(!cfg!(debug_assertions), "release executable required");
    let a = args;
    assert_eq!(a.len(), 4, "expected backend, users, output and data path");
    let users: usize = a[1].parse().unwrap();
    assert!(matches!(users, 1 | 8));
    let out = PathBuf::from(&a[2]);
    let data = PathBuf::from(&a[3]);
    fs::create_dir(&data).expect("new unique data root");
    let (fstype, mount) = verify_non_tmpfs_mount(&data);
    let root = DataRoot::new(&data);
    let mut cfg =
        CanonicalConfig::local_default(InstallationId::from_bytes(random_16()), root.clone());
    let mut pg = None;
    let mut db_settings = json!({});
    let schema = format!("test_user_perf_{}", hex::encode(random_16()));
    if a[0] == "pg16" {
        let fixtures = BenchFixtures::load_required(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(4)
                .expect("checkout root"),
        );
        let opts = fixtures.pg_connect();
        let mut conn = PgConnection::connect_with(&build_pg_connect_options(&opts))
            .await
            .expect("PG16 connection");
        let (version, sync, fsync, fpw, pg_dir): (String,String,String,String,Option<String>) = sqlx::query_as(
            "SELECT current_setting('server_version_num'), current_setting('synchronous_commit'), current_setting('fsync'), current_setting('full_page_writes'), (SELECT setting FROM pg_settings WHERE name='data_directory')"
        ).fetch_one(&mut conn).await.expect("PG durability settings");
        assert!(
            (160000..170000).contains(&version.parse::<u32>().unwrap())
                && sync == "on"
                && fsync == "on"
                && fpw == "on",
            "PG16 durable settings required"
        );
        db_settings = json!({"version_num":version,"synchronous_commit":sync,"fsync":fsync,"full_page_writes":fpw,"server_data_directory":pg_dir,"schema":schema});
        write_json(&out.join("environment.json"), &db_settings);
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA \"{schema}\"")))
            .execute(&mut conn)
            .await
            .expect("reserve unique schema");
        cfg.sql = SqlBackendConfig::postgres_default(opts, &schema);
        let bucket = fixtures.fresh_s3_bucket("interactive");
        let s3_cfg = fixtures.s3_config(bucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure interactive benchmark S3 bucket");
        cfg.blobs = BlobBackendConfig::S3(Box::new(s3_cfg));
        pg = Some(conn);
    } else {
        assert_eq!(a[0], "sqlite")
    }
    let (store, runtime) = CanonicalRuntime::open(cfg.clone())
        .await
        .expect("open series store");
    if a[0] == "sqlite" {
        let (sync, lim) = store
            .sqlite_writer_pragmas_for_bench()
            .await
            .expect("writer settings");
        let conn = rusqlite::Connection::open_with_flags(
            root.canonical(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert!(sync == 2 && mode == "wal", "SQLite FULL WAL required");
        db_settings = json!({"synchronous":sync,"journal_mode":mode,"journal_size_limit":lim});
    }
    write_json(
        &out.join("environment.json"),
        &json!({"backend":a[0],"users":users,"blob_filesystem":fstype,"blob_mount":mount,
        "database":db_settings,"runtime_cgroup_before":resources(),"allocator":"mimalloc","tokio_workers":4,"warmup_s":3,"measurement_s":30,"think_ms":if users==8 {100} else {0}}),
    );
    let actor = PrincipalId::from_bytes(random_16());
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes(random_16()),
            incarnation: HistoryIncarnation::from_bytes(random_16()),
            root_folder_id: FolderId::from_bytes(random_16()),
            slug: "workspace".into(),
            kind: SpaceKind::Personal,
            owner: actor.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("seed space");
    let scope = space.scope;
    let auth = build_owner_auth(&scope, actor.clone());
    let (start, rx) = tokio::sync::watch::channel(None);
    let mut workers = Vec::new();
    for w in 0..users {
        let id = NoteId::from_bytes(random_16());
        let carrier = TEMPLATE.replace("WWWWWWWWWWWWWWWW", &format!("{w:016x}"));
        let body = carrier.find("\n---\n").unwrap() + 5;
        let slot = carrier.find("Edit counter: ").unwrap() + "Edit counter: ".len();
        assert!(slot >= body && carrier.is_ascii() && carrier.len() == CARRIER_TARGET_BYTES);
        let ack = store
            .create_note(
                fast_space_ctx(&auth, &scope),
                next_mutation(
                    &scope,
                    &actor,
                    CreateNote {
                        folder_page: false,
                        note: id.clone(),
                        parent: None,
                        slug: format!("field-notes-{w}"),
                        class: DocClass::UserDoc,
                        carrier: carrier.clone(),
                    },
                ),
            )
            .await
            .expect("seed note");
        assert!(ack.value.note == id && ack.receipt.scope() == &scope);
        let n = Note {
            id,
            rev: ack.value.revision,
            receipt: ack.receipt,
            carrier,
            slot,
            body,
            iteration: 0,
        };
        workers.push(tokio::spawn(run_worker(
            w,
            users,
            store.clone(),
            auth.clone(),
            scope.clone(),
            actor.clone(),
            n,
            rx.clone(),
            Duration::from_secs(3),
            Duration::from_secs(30),
        )));
    }
    start.send(Some(Instant::now())).unwrap();
    let mut final_notes = Vec::new();
    let mut all_samples = Vec::new();
    let mut failed = false;
    // Collect all workers before any report I/O, including writes for an early failed worker.
    let mut completed = Vec::new();
    for w in workers {
        completed.push(w.await);
    }
    write_json(&out.join("runtime-after.json"), &resources());
    let mut raw = BufWriter::new(fs::File::create(out.join("raw.jsonl")).unwrap());
    for (w, r) in completed.into_iter().enumerate() {
        match r {
            Ok((n, samples)) => {
                failed |= !samples.iter().any(|r| r.measured)
                    || samples.iter().any(|r| r.error.is_some());
                for row in &samples {
                    serde_json::to_writer(&mut raw, &row).unwrap();
                    writeln!(raw).unwrap();
                }
                all_samples.extend(samples);
                final_notes.push((w, n));
            }
            Err(e) => {
                eprintln!("worker {w} terminated: {e}");
                failed = true;
            }
        }
    }
    raw.flush().unwrap();
    drop(raw);
    write_json(&out.join("latency.json"), &latency(&all_samples));
    drop(store);
    runtime
        .shutdown()
        .await
        .expect("close before independent reopen");
    let (reopened, runtime) = CanonicalRuntime::open(cfg)
        .await
        .expect("reopen independently");
    let mut audit = Vec::new();
    for (worker, n) in final_notes {
        let checked = read(&reopened, &auth, &scope, &n).await;
        failed |= checked.is_err();
        audit.push(json!({"worker":worker,"note":n.id,"revision":n.rev,"receipt_seq":n.receipt.seq(),"confirmed_edits":n.iteration,
                          "carrier_blake3":blake3::hash(n.carrier.as_bytes()).to_hex().to_string(),"error":checked.err()}));
    }
    failed |= audit.len() != users;
    write_json(
        &out.join("audit.json"),
        &json!({"notes":audit,"valid":!failed}),
    );
    drop(reopened);
    runtime.shutdown().await.expect("close audit store");
    if let Some(mut conn) = pg {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA \"{schema}\" CASCADE"
        )))
        .execute(&mut conn)
        .await
        .expect("drop owned schema");
        conn.close().await.unwrap();
    }
    if failed {
        std::process::exit(1)
    }
}

fn latency(samples: &[Sample]) -> Value {
    let mut stages = BTreeMap::new();
    let measured: Vec<_> = samples.iter().filter(|s| s.measured).collect();
    let pct = |ns: Vec<u64>| (!ns.is_empty()).then(|| compute_percentiles_from_ns(ns));
    for name in ["open", "save", "readback", "cycle"] {
        let mut all = Vec::new();
        let mut successes = Vec::new();
        for s in &measured {
            let t = match name {
                "open" => Some(s.open_ns),
                "save" => s.save_ns,
                "readback" => s.readback_ns,
                _ => Some(s.cycle_ns),
            };
            if let Some(ns) = t {
                all.push(ns);
                if s.error
                    .as_ref()
                    .is_none_or(|(stage, _)| name != "cycle" && *stage != name)
                {
                    successes.push(ns);
                }
            }
        }
        stages.insert(name, json!({
            "attempted":all.len(), "failed":all.len()-successes.len(), "not_reached":measured.len()-all.len(),
            "strictly_below_5ms":all.iter().filter(|n| **n < 5_000_000).count(),
            "all_attempts_us":pct(all), "successful_us":pct(successes),
        }));
    }
    json!({"warmup_attempts":samples.len()-measured.len(), "measured_attempts":measured.len(),
        "warmup_errors":samples.iter().filter(|s| !s.measured && s.error.is_some()).count(),
        "measured_errors":measured.iter().filter(|s| s.error.is_some()).count(), "stages":stages})
}

pub(super) fn campaign(args: &[String]) {
    let arg = |name: &str| &args[args.iter().position(|a| a == name).expect(name) + 1];
    let output = Path::new(arg("--output"));
    let evidence = output.parent().expect("evidence directory");
    let scratch = Path::new(arg("--work-root"));
    let binary = env::current_exe().expect("current release example");
    let plans = [
        [("sqlite", 1), ("pg16", 1), ("sqlite", 8), ("pg16", 8)],
        [("pg16", 8), ("sqlite", 8), ("pg16", 1), ("sqlite", 1)],
        [("sqlite", 8), ("pg16", 8), ("sqlite", 1), ("pg16", 1)],
    ];
    let mut results = Vec::new();
    let mut passed = true;
    let mut manifest = json!({"git_base_commit":arg("--git-base"),"git_tree":arg("--git-tree"),
        "executable_sha256":arg("--elf-sha256"), "plan":plans,"complete":false,"series":[],
        "caller_cpu_quota":arg("--caller-cgroup-cpu"),"caller_memory_limit":arg("--caller-cgroup-memory")});
    write_json(output, &manifest);
    for (repetition, pairs) in plans.into_iter().enumerate() {
        for (backend, users) in pairs {
            let tag = format!("{}-{backend}-{users}", repetition + 1);
            let dir = evidence.join(&tag);
            let data = scratch.join(&tag);
            fs::create_dir(&dir).expect("fresh series directory");
            let status = std::process::Command::new(&binary)
                .args(["--interaction-series", backend, &users.to_string()])
                .arg(&dir)
                .arg(&data)
                .status()
                .expect("start release series");
            let read_json = |name| {
                fs::read(dir.join(name))
                    .ok()
                    .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            };
            let ok = status.success()
                && read_json("audit.json").and_then(|v| v["valid"].as_bool()) == Some(true);
            passed &= ok;
            results.push(json!({"backend":backend,"users":users,"series":repetition+1,"directory":tag,
                "status":if ok {"valid"} else {"failed_or_incomplete"},"exit":status.code(),"latency":read_json("latency.json")}));
            manifest["series"] = json!(&results);
            manifest["complete"] = json!(results.len() == 12);
            manifest["all_valid"] = json!(passed && results.len() == 12);
            write_json(output, &manifest);
            if data.is_dir() {
                fs::remove_dir_all(data).expect("remove owned temporary data root");
            }
        }
    }
    if !passed {
        std::process::exit(1)
    }
}
