use smithers_machined::{
    conn::{self, Frame},
    outbox::{Codec, WireCodec},
};
use std::path::PathBuf;
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/backend/internal/compose/testdata/cocontracts")
            .join(format!("{name}.bin")),
    )
    .unwrap()
}
#[test]
fn durable_inspection_uses_independent_golden_bytes_and_rejects_other_frames() {
    let bytes = fixture("ev_captured");
    let entry = WireCodec.inspect(7, &bytes);
    // Fixture sequence is independently specified, never inferred from codec.
    assert!(entry.is_err());
    let entry = WireCodec.inspect(8, &bytes).unwrap();
    assert_eq!(entry.seq, 8);
    assert_eq!(entry.event_id, [0x44; 16]);
    assert_eq!(entry.captured_head, Some("11".repeat(20)));
    assert_eq!(entry.pin, entry.captured_head);
    assert_eq!(entry.pin, Some("11".repeat(20)));
    let burst = WireCodec.inspect(7, &fixture("ev_burst")).unwrap();
    assert_eq!(burst.pin, Some("11".repeat(20)));
    assert_eq!(burst.captured_head, None);
    for name in ["req_capture", "ack_applied", "hint_file_written"] {
        assert!(WireCodec.inspect(7, &fixture(name)).is_err());
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(WireCodec.inspect(7, &trailing).is_err());
    let mut changed = Frame::decode(&bytes).unwrap();
    changed.payload[5] = 9;
    assert!(WireCodec
        .inspect(7, &changed.encode().unwrap_or_default())
        .is_err());
}
#[test]
fn schema_field_inspection_refuses_missing_unknown_and_trailing_fields() {
    assert!(conn::fields("unknown", &[0; 4]).is_err());
    assert!(conn::fields("captured", &[0; 4]).is_err());
    assert!(conn::fields("empty", &[0, 0, 0, 1, 9]).is_err());
    assert!(conn::fields("empty", &[0, 0, 0, 0, 0]).is_err());
    assert_eq!(conn::fields("empty", &[0; 4]).unwrap().len(), 0);
}

#[test]
fn real_event_hook_pins_before_append_and_receipts_preserve_stale_head() {
    use smithers_machined::{
        hooks::EventSink,
        outbox::{DurableEvents, Objects, Outbox},
        outbox_store::Store,
    };
    use std::{
        collections::BTreeSet,
        fs, io,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::{Arc, Mutex},
    };
    #[derive(Clone, Default)]
    struct Pins {
        ids: Arc<Mutex<BTreeSet<[u8; 16]>>>,
        log: Arc<Mutex<Vec<String>>>,
    }
    impl Objects for Pins {
        fn pin(&mut self, id: [u8; 16], oid: &str) -> io::Result<()> {
            self.ids.lock().unwrap().insert(id);
            self.log.lock().unwrap().push(format!("pin:{oid}"));
            Ok(())
        }
        fn sync(&mut self) -> io::Result<()> {
            self.log.lock().unwrap().push("sync".into());
            Ok(())
        }
        fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
            Ok(self.ids.lock().unwrap().iter().copied().collect())
        }
        fn unpin(&mut self, id: [u8; 16]) -> io::Result<()> {
            self.ids.lock().unwrap().remove(&id);
            self.log.lock().unwrap().push("unpin".into());
            Ok(())
        }
        fn ack_head(&mut self, oid: &str) -> io::Result<()> {
            self.log.lock().unwrap().push(format!("head:{oid}"));
            Ok(())
        }
    }
    let state = std::env::temp_dir().join(format!("wire-outbox-{}", std::process::id()));
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(state.join("outbox")).unwrap();
    fs::set_permissions(state.join("outbox"), fs::Permissions::from_mode(0o700)).unwrap();
    let owner = fs::metadata(&state).unwrap().uid();
    let pins = Pins::default();
    let sink = DurableEvents::new(
        Outbox::open(
            Store::open(&state.join("outbox"), owner).unwrap(),
            WireCodec,
            pins.clone(),
            owner,
        )
        .unwrap(),
    );
    let head = [0x11; 20];
    let tree = [0x22; 20];
    let event = conn::tagged(
        2,
        &[
            conn::field(1, head),
            conn::field(2, tree),
            conn::field(3, head),
        ],
    );
    assert!(sink.append(&event, Some(tree)).is_err());
    assert!(pins.log.lock().unwrap().is_empty());
    let (seq, id) = sink.append(&event, Some(head)).unwrap();
    assert_eq!(seq, 1);
    assert_eq!(
        *pins.log.lock().unwrap(),
        [format!("pin:{}", "11".repeat(20)), "sync".into()]
    );
    let (entry, bytes) = sink.oldest().unwrap().unwrap();
    assert_eq!(entry.event_id, id);
    assert_eq!(Frame::decode(&bytes).unwrap().kind, 2);
    assert!(sink
        .receipt(&Frame::decode(&fixture("req_capture")).unwrap())
        .is_err());
    let ack = |seq: u64, outcome: u8| Frame {
        kind: 2,
        stream: 0,
        payload: conn::tagged(
            3,
            &[conn::field(1, seq.to_be_bytes()), conn::field(2, [outcome])],
        ),
    };
    assert!(sink.receipt(&ack(2, 1)).is_err());
    sink.receipt(&ack(1, 3)).unwrap();
    assert_eq!(sink.oldest().unwrap().unwrap().1, bytes);
    sink.receipt(&ack(1, 5)).unwrap();
    assert!(sink.oldest().unwrap().is_none());
    assert!(pins.ids.lock().unwrap().is_empty());
    assert!(!pins
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.starts_with("head:")));
    let (seq, _) = sink.append(&event, Some(head)).unwrap();
    assert_eq!(seq, 2);
    sink.receipt(&ack(2, 2)).unwrap();
    assert_eq!(
        &pins.log.lock().unwrap()[5..],
        [format!("head:{}", "11".repeat(20)), "unpin".into()]
    );
    drop(sink);
    fs::remove_dir_all(state).unwrap();
}
