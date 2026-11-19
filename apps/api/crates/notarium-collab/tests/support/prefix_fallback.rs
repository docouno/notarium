use std::time::Duration;

use notarium_canonical::CanonicalStore;
use notarium_collab::{
    CollabConfig, CollabHub, CollabPeerSession,
    wire::{self, LineageHello, PolicyRejectReason},
};
use notarium_core::{
    auth::SpaceRole,
    ids::PrincipalId,
    ports::{Cancellation, SpaceContext},
};
use notarium_syntax::carrier::Carrier;
use tokio::time::timeout;
use yrs::{
    Map, Text, Transact, Update,
    sync::{Message, SyncMessage},
    updates::{decoder::Decode, encoder::Encode},
};

use super::support::{
    Client, WAIT, close_code, context, create_note, custom, decode_ack, note_head,
    pause_wal_admission, synced_client, test_auth, wait_until,
};

async fn enqueue_before_release(peer: &CollabPeerSession, frame: Vec<u8>) {
    peer.send(frame).await.unwrap();

    // The transport's ingress holds eight frames. Accepting ten total
    // requires two dequeues, and forwarding the leading frame to the room
    // happens before the second dequeue. The three groups of ten all fit
    // in the 32-slot room mailbox while its current write is paused.
    // No presence is registered here, so the queries produce no output.
    for _ in 0..9 {
        peer.send(Message::AwarenessQuery.encode_v1())
            .await
            .unwrap();
    }
}

pub async fn check(store: &CanonicalStore, owner: &SpaceContext) {
    let initial = "Original recovery body.\n";
    let independent = "Independent prefix. 🧭\n";
    let note = create_note(store, owner, 94, initial, None).await.note;
    let hub = CollabHub::new(
        store.clone(),
        CollabConfig {
            // Consume the queued frames without an elapsed-time cutoff.
            intercept_coalesce: Duration::ZERO,
            idle_checkpoint: Duration::from_millis(100),
            ..CollabConfig::default()
        },
    )
    .unwrap();
    let (mut first, _) = synced_client(&hub, owner, &note, 420).await;
    let (mut observer, _) = synced_client(&hub, owner, &note, 421).await;
    let cancellation = Cancellation::default();
    let second_context = context(
        owner.scope(),
        PrincipalId::from_bytes([94; 16]),
        SpaceRole::Editor,
        None,
    );
    let mut second = Client::new(
        hub.connect(second_context, note.clone(), test_auth(&cancellation, None))
            .await
            .unwrap(),
        422,
    );
    second.ready(LineageHello::Fresh).await;
    second.sync().await;

    let first_prefix = first.update(|txn| first.body.insert(txn, 0, independent));
    let second_predecessor = second.append("Revoked predecessor.\n");
    let (suffix_author, _) = synced_client(&hub, owner, &note, 423).await;
    let independent_suffix = suffix_author.append("Later independently valid update.\n");
    drop(suffix_author);
    // Share B's update directly with A before the server sees it. Appending
    // after B's text gives A's next update an origin in B's clock range.
    first
        .doc
        .transact_mut()
        .apply_update(Update::decode_v1(&second_predecessor).unwrap())
        .unwrap();
    let mut first_tail = wire::encode_update(&first.append("Dependent update.\n"));
    first_tail.extend(wire::encode_update(&independent_suffix));

    let (warmup_posted, release_warmup) = pause_wal_admission(store);
    let warmup = observer.update(|txn| {
        observer.fields.insert(txn, "warmup", true);
    });
    observer.send_update(&warmup).await;
    timeout(WAIT, warmup_posted).await.unwrap().unwrap();
    timeout(WAIT, async {
        enqueue_before_release(&first.peer, wire::encode_update(&first_prefix)).await;
        enqueue_before_release(&second.peer, wire::encode_update(&second_predecessor)).await;
        enqueue_before_release(&first.peer, first_tail).await;
    })
    .await
    .expect("all four updates reached the paused room mailbox");

    let (batch_posted, release_batch) = pause_wal_admission(store);
    release_warmup.send(()).unwrap();
    timeout(WAIT, batch_posted).await.unwrap().unwrap();
    assert_eq!(observer.ack().await.room_update_seq, 1);
    cancellation.cancel();
    assert_eq!(close_code(&mut second.peer).await, 1008);
    release_batch.send(()).unwrap();

    // A sync on the healthy peer proves fallback for the entire WAL batch
    // finished before A reads its outgoing frames. A3 may not overwrite the
    // queued ACK for A1 or the policy frame for A2.
    observer.sync().await;
    first
        .until(|message| matches!(message, Message::Sync(SyncMessage::Update(bytes)) if bytes == &first_prefix))
        .await;
    let ack = decode_ack(&custom(&mut first.peer, wire::SERVER_ACK_WATERMARK).await);
    assert_eq!(ack.peer_write_seq, 1);
    assert_eq!(ack.room_update_seq, 2);
    let policy = custom(&mut first.peer, wire::POLICY_REJECTED).await;
    assert_eq!(policy[1], PolicyRejectReason::PendingClockGap as u8);
    assert_eq!(close_code(&mut first.peer).await, 1008);

    let expected = format!("{independent}{initial}");
    assert_eq!(observer.text(), expected);
    wait_until(async || {
        let stored = store
            .read_collab_session(None, owner.scope(), &note)
            .await
            .unwrap()
            .unwrap();
        !stored.session.carrier_dirty && stored.updates.is_empty()
    })
    .await;
    let (_, persisted) = note_head(store, owner, &note).await;
    assert_eq!(
        Carrier::scan(&persisted)
            .unwrap()
            .body
            .slice(&persisted)
            .unwrap(),
        expected
    );
}
