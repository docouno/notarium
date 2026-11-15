use super::*;
use std::{io, time::Instant};

async fn wait_count(value: &AtomicUsize, count: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while value.load(Ordering::SeqCst) < count {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}
async fn settled(setup: &mut Setup, count: i64) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_call_log WHERE delivery_state='settled'")
            .await
            < count
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}
async fn lifecycle(pg: bool) {
    let _serial = AUTH_TEST_LOCK.lock().await;
    let _network = crate::TEST_RESOURCE_LOCK.lock().await;
    let entered = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicU8::new(0));
    let (seen, finished, response_mode) = (entered.clone(), closed.clone(), mode.clone());
    let server = HttpsFixture::start_io(move |_, stream| {
        seen.fetch_add(1, Ordering::SeqCst);
        let mode = response_mode.load(Ordering::SeqCst);
        if mode != 2 {
            write!(
                stream,
                "HTTP/1.1 200 Fixture\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            )?;
            let data = if mode == 0 {
                completion_reply(ProviderWireKind::OpenaiCompatible, 0).body
            } else {
                format!("data: {}\n\n",json!({"model":"fixture-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})).into_bytes()
            };
            write!(stream, "{:x}\r\n", data.len())?;
            stream.write_all(&data)?;
            stream.write_all(b"\r\n")?;
            stream.flush()?;
        }
        // Neither terminal HTTP chunk nor TCP EOF is sent by this fixture.
        // DONE or cancellation must actively close the client's request.
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                ) => {}
            result => panic!("provider socket did not close: {result:?}"),
        }
        finished.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let mut setup = Setup::new(
        pg,
        "dispatch_lifecycle",
        ProviderWireKind::OpenaiCompatible,
        &server,
    )
    .await;
    let events = tokio::time::timeout(
        Duration::from_secs(1),
        complete(&setup.provider, setup.space.clone(), setup.completion(30)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(events.last(), Some(CompletionEvent::Finished(_))));
    wait_count(&closed, 1).await;
    mode.store(1, Ordering::SeqCst);
    let parent = setup.space.budget.cancellation.clone();
    let mut stream = setup
        .provider
        .complete(setup.space.clone(), setup.completion(31))
        .await
        .unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(CompletionEvent::Text(_))
    ));
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 1);
    drop(stream);
    wait_count(&closed, 2).await;
    settled(&mut setup, 2).await;
    assert!(
        !parent.is_cancelled(),
        "dropping one operation must not cancel its shared parent"
    );
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_budget_buckets WHERE tpm_reserved=8224")
            .await,
        3
    );
    // Mutation in the independent SQL pool cancels the active registration and
    // waits for shutdown without deadlocking on the audit finalizer's SQL.
    let mut stream = setup
        .provider
        .complete(setup.space.clone(), setup.completion(32))
        .await
        .unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(CompletionEvent::Text(_))
    ));
    let change = setup.other.update_credential(
        setup.ctx.clone(),
        AccountMutation {
            identity: command(
                setup.ctx.auth().principal(),
                setup.ctx.auth().principal(),
                32,
                setup.revision,
            ),
            input: UpdateProviderCredential {
                id: setup.credential.id.clone(),
                expected: setup.credential.revision,
                name: "Rotated".into(),
                injection: setup.credential.injection.clone(),
                secret: Some(SecretString::new("replacement".into())),
                limits: ProviderLimits::default(),
                disabled: false,
            },
        },
    );
    let changed = tokio::time::timeout(Duration::from_secs(1), change)
        .await
        .unwrap()
        .unwrap();
    setup.revision = changed.revision;
    setup.credential = changed.value;
    assert!(stream.next().await.is_err());
    assert!(stream.next().await.unwrap().is_none());
    wait_count(&closed, 3).await;
    settled(&mut setup, 3).await;
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    // A canonical metadata mutation uses the same cancellation/drain contract.
    let mut stream = setup
        .provider
        .complete(setup.space.clone(), setup.completion(33))
        .await
        .unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(CompletionEvent::Text(_))
    ));
    setup
        .egress
        .cancellations
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .cancel();
    assert!(stream.next().await.is_err());
    wait_count(&closed, 4).await;
    settled(&mut setup, 4).await;
    assert_eq!(setup.egress.active.load(Ordering::SeqCst), 0);
    // An abandoned unary future before response headers also owns shutdown and
    // a recoverable/settled audit; it cannot leave a detached paid request.
    mode.store(2, Ordering::SeqCst);
    let call = CheckProviderConnection {
        resource: setup.selection.provider.clone(),
        intent: CommandKey::from_bytes([34; 16]),
    };
    let mut pending = Box::pin(setup.provider.check_connection(setup.ctx.clone(), call));
    tokio::select! {biased;
        result=&mut pending=>panic!("unexpected completed probe: {result:?}"),
        _=wait_count(&entered,5)=>{},
    }
    drop(pending);
    wait_count(&closed, 5).await;
    settled(&mut setup, 5).await;
    assert_eq!(setup.fixture.observer.count("SELECT COUNT(*) FROM provider_call_log WHERE model_id IS NULL AND outcome='cancelled' AND usage_source='unknown'").await,1);
    // Expiring consent closes the stream even without a caller cancellation.
    mode.store(1, Ordering::SeqCst);
    setup
        .fixture
        .observer
        .execute("UPDATE provider_attachments SET expires_at=1700000000150")
        .await;
    let start = Instant::now();
    let mut stream = setup
        .provider
        .complete(setup.space.clone(), setup.completion(35))
        .await
        .unwrap();
    assert!(matches!(
        stream.next().await.unwrap(),
        Some(CompletionEvent::Text(_))
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    wait_count(&closed, 6).await;
    settled(&mut setup, 6).await;
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_call_log WHERE usage_source='unknown'")
            .await,
        5
    );
    assert_eq!(
        setup
            .fixture
            .observer
            .count("SELECT COUNT(*) FROM provider_budget_buckets WHERE tpm_reserved=32896")
            .await,
        3
    );
    setup.close().await;
}
#[tokio::test]
async fn sqlite_owned_shutdown_and_revocation() {
    lifecycle(false).await;
}
#[tokio::test]
async fn postgres_owned_shutdown_and_revocation() {
    lifecycle(true).await;
}
