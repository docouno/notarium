use super::*;
use yrs::sync::awareness::AwarenessUpdateEntry;
use yrs::sync::{Awareness, DefaultProtocol, Protocol};
use yrs::updates::encoder::{Encoder, EncoderV1};
use yrs::{Doc, OffsetKind, Options};

fn message(tag: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut frame = vec![tag];
    frame.write_buf(payload);
    frame
}

#[test]
fn first_message_is_exactly_one_hello_and_preserves_incarnation_bytes() {
    assert_eq!(LineageHello::Fresh.encode(), [100, 2, 1, 0]);
    let incarnation = HistoryIncarnation::from_bytes([0x80; 16]);
    let epoch = LineageEpoch::new(200).unwrap();
    let base = RevisionId::parse("Abcd0123_Z-z").unwrap();
    let expected_payload = [
        &[1, 1][..],
        incarnation.as_bytes(),
        &[0xc8, 1, 1, 12],
        base.as_str().as_bytes(),
    ]
    .concat();
    let reconnect = LineageHello::Reconnect {
        client_history_incarnation: incarnation,
        client_lineage_epoch: epoch,
        client_base_rev_id: Some(base),
    };

    let frame = reconnect.encode();
    assert_eq!(
        Message::decode_v1(&frame).unwrap(),
        Message::Custom(LINEAGE_HELLO, expected_payload)
    );
    assert_eq!(decode_hello(&frame).unwrap(), reconnect);
    assert!(matches!(
        decode_frame(&frame, PeerRole::Editor, &[]),
        Err(FrameError::Protocol)
    ));
    for frame in [
        vec![],
        vec![MSG_QUERY_AWARENESS],
        vec![100, 2, 2, 0],
        vec![100, 2, 1, 2],
        vec![100, 3, 1, 0, 0],
        vec![100, 2, 1, 0, MSG_QUERY_AWARENESS],
        vec![100, 2, 1],
    ] {
        assert_eq!(decode_hello(&frame), Err(FrameError::Protocol));
    }
}

#[test]
fn server_control_frames_use_documented_field_order() {
    let history_incarnation = HistoryIncarnation::from_bytes([0x33; 16]);
    let current_rev_id = RevisionId::parse("Abcd0123_Z-z").unwrap();
    let lease_epoch = LeaseEpoch::new(130).unwrap();
    let lineage_epoch = LineageEpoch::new(9).unwrap();
    let ready = LineageReady {
        history_incarnation,
        lineage_epoch,
        current_rev_id: current_rev_id.clone(),
        lease_epoch,
        role: PeerRole::Editor,
        fm_writable: false,
    };
    let expected_ready = [
        &[1][..],
        history_incarnation.as_bytes(),
        &[9, 12],
        current_rev_id.as_str().as_bytes(),
        &[0x82, 1, 1, 0],
    ]
    .concat();
    assert_eq!(
        Message::decode_v1(&ready.encode()).unwrap(),
        Message::Custom(LINEAGE_READY, expected_ready)
    );

    let mismatch = LineageMismatch {
        current_history_incarnation: history_incarnation,
        current_rev_id: current_rev_id.clone(),
        current_lineage_epoch: lineage_epoch,
        verified_base_rev_id: None,
    };
    let expected_mismatch = [
        &[1][..],
        history_incarnation.as_bytes(),
        &[12],
        current_rev_id.as_str().as_bytes(),
        &[9, 0],
    ]
    .concat();
    assert_eq!(
        Message::decode_v1(&mismatch.encode()).unwrap(),
        Message::Custom(LINEAGE_MISMATCH, expected_mismatch)
    );

    let ack = ServerAckWatermark {
        lease_epoch,
        peer_write_seq: 1,
        room_update_seq: 1300,
    };
    assert_eq!(ack.encode(), [103, 6, 1, 0x82, 1, 1, 0x94, 10]);

    let rejection = encode_policy_rejected(PolicyRejectReason::FrontmatterKeyDeleted);
    let Message::Custom(POLICY_REJECTED, payload) = Message::decode_v1(&rejection).unwrap() else {
        panic!("invalid rejection envelope");
    };
    let mut cursor = Cursor::new(&payload);
    assert_eq!(cursor.byte().unwrap(), 1);
    assert_eq!(cursor.byte().unwrap(), 6);
    assert!(!cursor.string().unwrap().is_empty());
    assert!(cursor.is_empty());
}

#[test]
fn valid_y_sync_batch_retains_order_and_viewer_skips_opaque_writes() {
    let state: StateVector = [(ClientID::new(MAX_CLIENT_ID), MAX_CLOCK)]
        .into_iter()
        .collect();
    let awareness = AwarenessUpdate {
        clients: [(
            ClientID::new(7),
            AwarenessUpdateEntry {
                clock: 13,
                json: "{\"cursor\":\"🦀\"}".into(),
            },
        )]
        .into_iter()
        .collect(),
    };
    let bytes = [
        encode_sync_step2(&[0xff]),
        encode_sync_step1(state.clone()),
        encode_update(&[0xfe]),
        encode_awareness(&awareness),
        vec![MSG_QUERY_AWARENESS],
    ]
    .concat();

    let mut editor = decode_frame(&bytes, PeerRole::Editor, &[]).unwrap();
    assert!(matches!(
        editor.next(),
        Some(InboundMessage::SyncStep2(&[0xff]))
    ));
    assert!(matches!(editor.next(), Some(InboundMessage::SyncStep1(_))));
    assert!(matches!(
        editor.next(),
        Some(InboundMessage::Update(&[0xfe]))
    ));
    assert!(matches!(editor.next(), Some(InboundMessage::Awareness(_))));
    assert!(matches!(
        editor.next(),
        Some(InboundMessage::AwarenessQuery)
    ));
    assert!(editor.next().is_none());

    let mut viewer = decode_frame(&bytes, PeerRole::Viewer, &[]).unwrap();
    let Some(InboundMessage::SyncStep1(wrapped_state)) = viewer.next() else {
        panic!("missing state vector");
    };
    assert_eq!(wrapped_state.decode().unwrap(), state);
    let Some(InboundMessage::Awareness(wrapped_awareness)) = viewer.next() else {
        panic!("missing awareness");
    };
    assert_eq!(wrapped_awareness.decode().unwrap(), awareness);
    assert!(matches!(
        viewer.next(),
        Some(InboundMessage::AwarenessQuery)
    ));
    assert!(viewer.next().is_none());

    // The envelope pass and iterator can scan the skipped frames with no
    // allocations even if their update payloads are malformed.
    let allocations = allocation_counter::measure(|| {
        assert_eq!(
            decode_frame(&bytes, PeerRole::Viewer, &[]).unwrap().count(),
            3
        );
    });
    assert_eq!(allocations.count_total, 0);
}

#[test]
fn reads_the_compound_start_emitted_by_the_standard_protocol() {
    let mut options = Options::with_client_id(ClientID::new(7));
    options.offset_kind = OffsetKind::Utf16;
    let mut awareness = Awareness::new(Doc::with_options(options));
    awareness.set_local_state_raw("{}");
    let mut encoder = EncoderV1::new();
    DefaultProtocol.start(&awareness, &mut encoder).unwrap();
    let frame = encoder.to_vec();

    let mut messages = decode_frame(&frame, PeerRole::Editor, &[]).unwrap();
    let Some(InboundMessage::SyncStep1(state)) = messages.next() else {
        panic!("missing state vector");
    };
    assert_eq!(state.decode().unwrap(), StateVector::default());
    let Some(InboundMessage::Awareness(presence)) = messages.next() else {
        panic!("missing awareness");
    };
    assert_eq!(presence.decode().unwrap(), awareness.update().unwrap());
    assert!(messages.next().is_none());
}

#[test]
fn reads_an_independent_yjs_and_lib0_packet() {
    // lib0 encodes the envelope around the Yjs state vector for a document
    // with client ID 7 and the body "# Архитектура 🚀".
    let frame = [
        &[0, 0, 3, 1, 7, 16, 1, 21, 1, 7, 13, 17][..],
        "{\"cursor\":\"🦀\"}".as_bytes(),
    ]
    .concat();
    let mut messages = decode_frame(&frame, PeerRole::Viewer, &[]).unwrap();
    let Some(InboundMessage::SyncStep1(state)) = messages.next() else {
        panic!("missing state vector");
    };
    let id = ClientID::new(7);
    assert_eq!(state.decode().unwrap().get(&id), 16);
    let Some(InboundMessage::Awareness(presence)) = messages.next() else {
        panic!("missing awareness");
    };
    let entry = &presence.decode().unwrap().clients[&id];
    assert_eq!(entry.clock, 13);
    assert_eq!(entry.json.as_ref(), "{\"cursor\":\"🦀\"}");
    assert!(messages.next().is_none());
}

#[test]
fn complete_outer_prevalidation_precedes_delivery() {
    let valid = encode_update(&[0, 0]);
    for tail in [
        vec![MSG_SYNC, MSG_SYNC_UPDATE, 6, 1, 2],
        vec![MSG_SYNC, 3, 0],
        vec![2],
        vec![0xff],
        vec![LINEAGE_HELLO, 2, 1, 0],
    ] {
        let frame = [valid.as_slice(), &tail].concat();
        assert!(matches!(
            decode_frame(&frame, PeerRole::Editor, &[]),
            Err(FrameError::Protocol)
        ));
    }
    let exact_cap = vec![MSG_QUERY_AWARENESS; MAX_FRAME_BYTES];
    assert!(decode_frame(&exact_cap, PeerRole::Viewer, &[]).is_ok());
    let too_large = vec![0xff; MAX_FRAME_BYTES + 1];
    assert!(matches!(
        decode_frame(&too_large, PeerRole::Viewer, &[]),
        Err(FrameError::MessageTooBig)
    ));
    assert_eq!(decode_hello(&too_large), Err(FrameError::MessageTooBig));
}

#[test]
fn validates_state_vector_counts_clocks_ids_and_exact_end() {
    let mut bad_count = Vec::new();
    bad_count.write_var(u32::MAX);
    let mut bad_id = vec![1];
    bad_id.write_var(MAX_CLIENT_ID + 1);
    bad_id.write_var(0_u32);

    let mut bad_clock = vec![1, 1];
    bad_clock.write_var(MAX_CLOCK + 1);

    for data in [bad_count, bad_id, bad_clock, vec![0, 0], vec![]] {
        let frame = encode_sync_bytes(MSG_SYNC_STEP_1, &data);
        assert!(matches!(
            decode_frame(&frame, PeerRole::Editor, &[]),
            Err(FrameError::Protocol)
        ));
    }
}

fn awareness_bytes(client_id: u64, clock: u64, json: &[u8]) -> Vec<u8> {
    let mut buf = vec![1];
    buf.write_var(client_id);
    buf.write_var(clock);
    buf.write_buf(json);
    buf
}

#[test]
fn validates_awareness_counts_clocks_ids_and_json_bounds() {
    let mut bad_count = Vec::new();
    bad_count.write_var(u64::MAX);
    let over_limit = {
        let single = awareness_bytes(1, 1, b"{}");
        let mut bytes = Vec::new();
        bytes.write_var(MAX_AWARENESS_CLIENTS + 1);
        for _ in 0..=MAX_AWARENESS_CLIENTS {
            bytes.extend_from_slice(&single[1..]);
        }
        bytes
    };
    for data in [
        bad_count,
        over_limit,
        awareness_bytes(MAX_CLIENT_ID + 1, 1, b"null"),
        awareness_bytes(1, u64::from(MAX_CLOCK) + 1, b"null"),
        awareness_bytes(1, 1, &[0xff]),
        awareness_bytes(1, 1, &vec![b'a'; MAX_AWARENESS_JSON_BYTES + 1]),
        vec![0, 0],
        vec![],
    ] {
        let frame = message(MSG_AWARENESS, data);
        assert!(matches!(
            decode_frame(&frame, PeerRole::Viewer, &[]),
            Err(FrameError::Protocol)
        ));
    }

    let reserved = message(MSG_AWARENESS, awareness_bytes(7, 1, b"null"));
    assert!(matches!(
        decode_frame(&reserved, PeerRole::Viewer, &[ClientID::new(7)]),
        Err(FrameError::Protocol)
    ));

    let invalid_json = message(MSG_AWARENESS, awareness_bytes(7, 1, b"{oops"));
    let mut messages = decode_frame(&invalid_json, PeerRole::Viewer, &[]).unwrap();
    let Some(InboundMessage::Awareness(wrapped)) = messages.next() else {
        panic!("missing awareness");
    };
    assert_eq!(wrapped.decode(), Err(FrameError::Protocol));
}

#[test]
fn cursor_rejects_overflow_without_wrapping_and_checks_signed_magnitude() {
    let mut encoded = Vec::new();
    encoded.write_var(u64::MAX);
    assert_eq!(Cursor::new(&encoded).var_u64().unwrap(), u64::MAX);
    assert_eq!(Cursor::new(&encoded).var_u32(), Err(FrameError::Protocol));

    let mut overflowing = [0xff; 10];
    overflowing[9] = 2;
    assert_eq!(
        Cursor::new(&overflowing).var_u64(),
        Err(FrameError::Protocol)
    );
    assert_eq!(
        Cursor::new(&[0x80; 11]).var_u64(),
        Err(FrameError::Protocol)
    );

    for value in [-i64::MAX, -1000, -63, 0, 63, 1000, i64::MAX] {
        let mut encoded = Vec::new();
        encoded.write_var(value);
        assert_eq!(Cursor::new(&encoded).var_i64().unwrap(), value);
    }
    let mut signed_minimum = [0x80; 10];
    signed_minimum[0] = 0xc0;
    signed_minimum[9] = 2;
    assert_eq!(
        Cursor::new(&signed_minimum).var_i64(),
        Err(FrameError::Protocol)
    );
}
