use super::*;

const FOREGROUND_PAIRS: usize = 4;

pub(super) async fn capture_under_load(
    canonical: &CanonicalStore,
    control: &ControlBackup,
    root: &Path,
    scope: &HistoryScope,
    owner: &PrincipalId,
    backend: &'static str,
) {
    let Ok(count) = std::env::var("NOTARIUM_PAIRED_ARCHIVE_CAPTURES") else {
        return;
    };
    let captures: usize = count.parse().unwrap();
    assert!((1..=1000).contains(&captures));
    let tier = std::env::var("NOTARIUM_ARCHIVE_BENCH_TIER").unwrap_or_else(|_| "unrated".into());
    assert!(matches!(tier.as_str(), "high" | "medium" | "unrated"));
    if tier != "unrated" {
        assert_eq!(captures, 1000);
    }

    let mut targets = vec![write_target(canonical, scope.clone(), owner).await];
    for spaces in [1, 64] {
        if spaces > 1 {
            for ordinal in 1..spaces {
                let space = canonical
                    .create_space(CreateSpaceSpec {
                        space_id: SpaceId::from_bytes(codec::ordered_id_16().unwrap()),
                        incarnation: HistoryIncarnation::from_bytes(
                            codec::ordered_id_16().unwrap(),
                        ),
                        root_folder_id: FolderId::from_bytes(codec::ordered_id_16().unwrap()),
                        slug: format!("paired-load-{ordinal}"),
                        kind: SpaceKind::Shared,
                        owner: owner.clone(),
                        active_epoch: LeaseEpoch::new(1).unwrap(),
                        initial_last_seq: SpaceSeq::ZERO,
                        created_at: None,
                    })
                    .await
                    .unwrap();
                targets.push(write_target(canonical, space.scope, owner).await);
            }
        }
        let mut confirmed = Vec::with_capacity(captures);
        let mut drained = Vec::with_capacity(captures);
        let mut total = Vec::with_capacity(captures);
        for iteration in 0..=captures {
            let path = root.join(format!("{backend}-{spaces}-{iteration}.zip"));
            // Keep offered workload independent of archive length. An
            // unlimited loop grows retained history fastest in slow samples.
            let capture = async {
                let started = std::time::Instant::now();
                let result = run_backup(
                    authority(ServicePurpose::Backup),
                    canonical,
                    control,
                    &path,
                    BackupOptions::default(),
                )
                .await;
                (result, started.elapsed())
            };
            let ((result, elapsed), ()) = tokio::join!(
                capture,
                foreground(canonical, owner, &mut targets, iteration * FOREGROUND_PAIRS,)
            );
            if let Err(err) = &result {
                eprintln!("paired capture {iteration} of {backend}/{spaces} failed: {err:?}");
            }
            let backup = result.unwrap();
            if iteration > 0 {
                confirmed.push(backup.pause.confirmed.as_nanos() as u64);
                drained.push(backup.pause.including_drain.as_nanos() as u64);
                total.push(elapsed.as_nanos() as u64);
            }
            fs::remove_file(path).unwrap();
        }
        if tier != "unrated" {
            assert!(
                targets
                    .iter()
                    .all(|target| target.leaf > ThreadEntrySeq::ZERO)
            );
        }
        let confirmed = percentiles(confirmed);
        eprintln!(
            "{}",
            serde_json::json!({
                "backend": backend, "tier": tier, "spaces": spaces, "captures": captures,
                "foreground_writes": (captures + 1) * FOREGROUND_PAIRS * 2, "confirmed_ns": confirmed,
                "including_drain_ns": percentiles(drained), "full_backup_ns": percentiles(total),
            })
        );
        if tier != "unrated" {
            let limit = if backend == "postgres" && tier == "medium" {
                2_500_000
            } else {
                1_000_000
            };
            assert!(confirmed["p95"].as_u64().unwrap() < limit);
        }
    }
}

async fn foreground(
    canonical: &CanonicalStore,
    owner: &PrincipalId,
    targets: &mut [WriteTarget],
    first_pair: usize,
) {
    for pair in first_pair..first_pair + FOREGROUND_PAIRS {
        if pair != first_pair {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let index = pair % targets.len();
        let target = &mut targets[index];
        let scope = &target.scope;
        let note = NoteId::from_bytes(codec::ordered_id_16().unwrap());
        let slug = format!("load-{pair}-{}", note.as_str());
        canonical
            .create_note(
                auth(scope, owner),
                command(
                    scope,
                    owner,
                    CreateNote {
                        note,
                        parent: None,
                        slug,
                        class: DocClass::UserDoc,
                        carrier: "# Foreground save\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let appended = canonical
            .append_chat(
                auth(scope, owner),
                command(
                    scope,
                    owner,
                    AppendChat {
                        thread: target.thread.clone(),
                        parent: target.leaf,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text("Foreground append".into()),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap();
        target.leaf = appended.value.seq;
    }
}

struct WriteTarget {
    scope: HistoryScope,
    thread: ChatThreadId,
    leaf: ThreadEntrySeq,
}

async fn write_target(
    canonical: &CanonicalStore,
    scope: HistoryScope,
    owner: &PrincipalId,
) -> WriteTarget {
    let thread = ChatThreadId::from_bytes(codec::ordered_id_16().unwrap());
    canonical
        .create_chat(
            auth(&scope, owner),
            command(
                &scope,
                owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.clone(),
                    project_folder: None,
                    title: "Foreground backup workload".into(),
                },
            ),
        )
        .await
        .unwrap();
    WriteTarget {
        scope,
        thread,
        leaf: ThreadEntrySeq::ZERO,
    }
}

fn command<T>(scope: &HistoryScope, owner: &PrincipalId, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: owner.clone(),
            key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
            hash: ContentDigest::from_bytes([0; 32]),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

pub(super) fn percentiles(mut samples: Vec<u64>) -> serde_json::Value {
    samples.sort_unstable();
    let rank = |percent: usize| samples[(samples.len() * percent).div_ceil(100).saturating_sub(1)];
    serde_json::json!({
        "p50": rank(50), "p95": rank(95), "p99": rank(99), "max": samples.last(),
    })
}
