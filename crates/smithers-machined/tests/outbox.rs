use smithers_machined::{
    conn::{self, Frame},
    hooks::Oid,
    objects::BundleSender,
    outbox::{self, Outbox, Refs},
    outbox_store::Store,
};
use std::{
    collections::BTreeMap,
    io::{self, Cursor},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct State {
    pins: BTreeMap<[u8; 16], Oid>,
    ack: Option<Oid>,
}
#[derive(Clone, Default)]
struct Repo(Arc<Mutex<State>>);
impl Refs for Repo {
    fn pin_and_sync(&mut self, id: [u8; 16], oid: Oid) -> io::Result<()> {
        self.0.lock().unwrap().pins.insert(id, oid);
        Ok(())
    }
    fn acknowledge_and_sync(&mut self, head: Oid) -> io::Result<()> {
        self.0.lock().unwrap().ack = Some(head);
        Ok(())
    }
    fn unpin(&mut self, id: [u8; 16]) -> io::Result<()> {
        self.0.lock().unwrap().pins.remove(&id);
        Ok(())
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        Ok(self.0.lock().unwrap().pins.keys().copied().collect())
    }
}
struct Fixture {
    path: PathBuf,
    owner: u32,
    repo: Repo,
}
impl Fixture {
    fn new() -> Self {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("w2-outbox-{id:x?}"));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(path.join("outbox")).unwrap();
        std::fs::set_permissions(path.join("outbox"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let owner = std::fs::metadata(&path).unwrap().uid();
        Self {
            path,
            owner,
            repo: Repo::default(),
        }
    }
    fn open(&self) -> Outbox<Repo> {
        Outbox::open(
            Store::open(&self.path.join("outbox"), self.owner).unwrap(),
            self.owner,
            self.repo.clone(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}
fn ack(seq: u64, outcome: u8) -> Frame {
    Frame {
        kind: 2,
        stream: 0,
        payload: conn::tagged(
            3,
            &[conn::field(1, seq.to_be_bytes()), conn::field(2, [outcome])],
        ),
    }
}
#[test]
fn restart_and_lost_ack_replay_same_identity_ten_times() {
    for _ in 0..10 {
        let f = Fixture::new();
        let mut o = f.open();
        let (seq, id) = o
            .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
            .unwrap();
        assert!(o.acknowledge(&ack(seq, 1)).is_err()); // unsent receipts refused
        drop(o);
        let mut o = f.open(); // K3 component: persisted append replay
        assert_eq!(o.front().unwrap().unwrap().id, id);
        let first = o.after_bundle(seq).unwrap();
        o.reconnect(); // K4/K4b component: host receipt/reply lost
        assert_eq!(o.after_bundle(seq).unwrap(), first);
        o.acknowledge(&ack(seq, 2)).unwrap(); // duplicate receipt is durable success
        assert!(o.front().unwrap().is_none());
        assert_eq!(f.repo.0.lock().unwrap().ack, Some([1; 20]));
        assert!(f.repo.0.lock().unwrap().pins.is_empty());
        drop(o);
        assert!(f.open().front().unwrap().is_none());
    }
}
#[test]
fn stale_and_rejected_never_advance_ack_head() {
    for outcome in [4, 5] {
        let f = Fixture::new();
        let mut o = f.open();
        let (seq, _) = o
            .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
            .unwrap();
        o.after_bundle(seq).unwrap();
        o.acknowledge(&ack(seq, outcome)).unwrap();
        assert_eq!(f.repo.0.lock().unwrap().ack, None);
        assert!(o.front().unwrap().is_none());
        assert_eq!(
            std::fs::read_dir(f.path.join("outbox/dead"))
                .unwrap()
                .count(),
            usize::from(outcome == 4)
        );
    }
}
#[test]
fn missing_objects_retains_pin_and_rewinds_sender() {
    let f = Fixture::new();
    let mut o = f.open();
    let (seq, _) = o
        .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
        .unwrap();
    let first = o.after_bundle(seq).unwrap();
    o.acknowledge(&ack(seq, 3)).unwrap();
    assert_eq!(f.repo.0.lock().unwrap().pins.len(), 1);
    assert_eq!(o.after_bundle(seq).unwrap(), first);
}
#[test]
fn bundle_larger_than_credit_requires_windows_and_peer_close() {
    let bytes = vec![71; 1_048_577];
    let mut s = BundleSender::new(2, Cursor::new(&bytes)).unwrap();
    let mut received = vec![];
    for _ in 0..4 {
        let f = s.next_frame().unwrap().unwrap();
        received.extend_from_slice(&f.payload[2..]);
    }
    assert!(s.next_frame().unwrap().is_none());
    assert_eq!(received.len(), 262144);
    assert!(s
        .receive(&Frame {
            kind: 6,
            stream: 2,
            payload: vec![7]
        })
        .is_err());
    let mut consumed = 262144u32;
    loop {
        let mut p = vec![6];
        p.extend(consumed.to_be_bytes());
        s.receive(&Frame {
            kind: 6,
            stream: 2,
            payload: p,
        })
        .unwrap();
        let f = s.next_frame().unwrap().unwrap();
        if f.payload[0] == 2 {
            break;
        }
        received.extend_from_slice(&f.payload[2..]);
        consumed = (f.payload.len() - 2) as u32;
    }
    assert_eq!(received, bytes);
    assert!(!s.verified());
    s.receive(&Frame {
        kind: 6,
        stream: 2,
        payload: vec![7],
    })
    .unwrap();
    assert!(s.verified());
}

struct Bundles(Vec<([u8; 16], Vec<Oid>)>);
impl smithers_machined::objects::Bundles for Bundles {
    type Source = Cursor<Vec<u8>>;
    fn export(&mut self, event: &conn::Durable, haves: &[Oid]) -> io::Result<Self::Source> {
        self.0.push((event.id, haves.to_vec()));
        Ok(Cursor::new(vec![19; 300_001]))
    }
}

// Pass both directions through the production codec, including the bundle's
// flow-control windows. Dropping a receipt must never lose the event or its pin.
#[test]
fn delivery_waits_for_import_and_replays_after_disconnect_ten_times() {
    use smithers_machined::objects::Delivery;
    for _ in 0..10 {
        let f = Fixture::new();
        let mut outbox = f.open();
        let (seq, id) = outbox
            .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
            .unwrap();
        let mut pump = Delivery::new(Bundles(vec![]));
        assert!(pump.begin(&outbox, 0x8000_0000).is_err());
        for stream in [1, 2] {
            assert!(pump.begin(&outbox, stream).unwrap());
            assert!(pump.begin(&outbox, stream + 1).is_err());
            assert!(pump.receive(&mut outbox, &ack(seq, 1)).is_err());
            let mut bytes = vec![];
            loop {
                let frame = pump.next_frame().unwrap().unwrap();
                let frame = Frame::decode(&frame.encode().unwrap()).unwrap();
                assert_eq!(frame.kind, 6);
                if frame.payload[0] == 2 {
                    break;
                }
                bytes.extend_from_slice(&frame.payload[2..]);
                let mut window = vec![6];
                window.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
                assert!(pump
                    .receive(
                        &mut outbox,
                        &Frame {
                            kind: 6,
                            stream,
                            payload: window
                        }
                    )
                    .unwrap()
                    .is_none());
            }
            assert_eq!(bytes, vec![19; 300_001]);
            assert!(pump.next_frame().unwrap().is_none());
            let event = pump
                .receive(
                    &mut outbox,
                    &Frame {
                        kind: 6,
                        stream,
                        payload: vec![7],
                    },
                )
                .unwrap()
                .unwrap();
            let event = Frame::decode(&event.encode().unwrap()).unwrap();
            assert_eq!(conn::Durable::decode(&event.payload).unwrap().id, id);
            assert!(pump.next_frame().unwrap().is_none());
            if stream == 1 {
                pump.reconnect(&mut outbox);
                assert_eq!(f.repo.0.lock().unwrap().pins.len(), 1);
            } else {
                pump.receive(&mut outbox, &ack(seq, 2)).unwrap();
            }
        }
        assert!(!pump.begin(&outbox, 3).unwrap());
        assert!(outbox.front().unwrap().is_none());
        assert_eq!(f.repo.0.lock().unwrap().ack, Some([1; 20]));
    }
}

#[test]
fn delivery_rebuilds_missing_objects_against_peer_haves() {
    use smithers_machined::objects::{Bundles, Delivery};
    struct Export(Arc<Mutex<Vec<Vec<Oid>>>>);
    impl Bundles for Export {
        type Source = Cursor<Vec<u8>>;
        fn export(&mut self, _: &conn::Durable, haves: &[Oid]) -> io::Result<Self::Source> {
            self.0.lock().unwrap().push(haves.to_vec());
            Ok(Cursor::new(vec![]))
        }
    }
    let f = Fixture::new();
    let mut outbox = f.open();
    let (seq, id) = outbox
        .append(&outbox::captured([1; 20], [2; 20], [3; 20]), Some([1; 20]))
        .unwrap();
    let exports = Arc::new(Mutex::new(vec![]));
    let mut pump = Delivery::new(Export(exports.clone()));
    let mut missing = ack(seq, 3);
    let mut haves = 1u16.to_be_bytes().to_vec();
    haves.extend([7; 20]);
    missing.payload = conn::tagged(
        3,
        &[
            conn::field(1, seq.to_be_bytes()),
            conn::field(2, [3]),
            conn::field(5, haves),
        ],
    );
    for stream in [1, 2] {
        assert!(pump.begin(&outbox, stream).unwrap());
        assert_eq!(pump.next_frame().unwrap().unwrap().payload, [2, 0]);
        let event = pump
            .receive(
                &mut outbox,
                &Frame {
                    kind: 6,
                    stream,
                    payload: vec![7],
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(conn::Durable::decode(&event.payload).unwrap().id, id);
        let receipt = if stream == 1 { &missing } else { &ack(seq, 1) };
        pump.receive(&mut outbox, receipt).unwrap();
    }
    assert_eq!(*exports.lock().unwrap(), vec![vec![], vec![[7; 20]]]);
    assert!(outbox.front().unwrap().is_none());
}

fn install_fixture(f: &Fixture, layout: &str) {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/outbox")
        .join(layout);
    for file in std::fs::read_dir(source).unwrap() {
        let file = file.unwrap();
        let path = f.path.join("outbox").join(file.file_name());
        std::fs::copy(file.path(), &path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    for seq in [3, 4] {
        f.repo.0.lock().unwrap().pins.insert([seq; 16], [seq; 20]);
    }
}

fn deliver_fixture(f: &Fixture) {
    use smithers_machined::objects::Delivery;
    let mut outbox = f.open();
    assert_eq!(f.repo.0.lock().unwrap().pins.len(), 2);
    let mut delivery = Delivery::new(Bundles(vec![]));
    let mut sent = Vec::new();
    for seq in [3, 4] {
        assert!(delivery.begin(&outbox, seq as u32).unwrap());
        loop {
            let frame = delivery.next_frame().unwrap().unwrap();
            if frame.payload[0] == 2 {
                break;
            }
            let mut credit = vec![6];
            credit.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
            delivery
                .receive(
                    &mut outbox,
                    &Frame {
                        kind: 6,
                        stream: seq as u32,
                        payload: credit,
                    },
                )
                .unwrap();
        }
        let frame = delivery
            .receive(
                &mut outbox,
                &Frame {
                    kind: 6,
                    stream: seq as u32,
                    payload: vec![7],
                },
            )
            .unwrap()
            .unwrap();
        let decoded = Frame::decode(&frame.encode().unwrap()).unwrap();
        let event = conn::Durable::decode(&decoded.payload).unwrap();
        sent.push((event.seq, event.id));
        assert_eq!(
            event.event,
            outbox::captured([seq as u8; 20], [2; 20], [1; 20])
        );
        delivery.receive(&mut outbox, &ack(seq, 1)).unwrap();
    }
    assert_eq!(sent, vec![(3, [3; 16]), (4, [4; 16])]);
    assert!(!delivery.begin(&outbox, 5).unwrap());
    assert!(f.repo.0.lock().unwrap().pins.is_empty());
    drop(outbox);
    let reopened = f.open();
    assert!(reopened.front().unwrap().is_none());
    assert_eq!(reopened.next_sequence().unwrap(), 5);
}

#[test]
fn literal_previous_and_current_release_deliver_once_with_same_ids_and_pins() {
    for layout in ["legacy", "v1"] {
        let f = Fixture::new();
        install_fixture(&f, layout);
        deliver_fixture(&f);
        assert_eq!(
            std::fs::read(f.path.join("outbox/FORMAT")).unwrap(),
            include_bytes!("data/outbox/v1/FORMAT")
        );
    }
}

#[cfg(all(feature = "killpoints", debug_assertions))]
#[test]
fn migration_crash_child() {
    let Ok(path) = std::env::var("OUTBOX_MIGRATION_FIXTURE") else {
        return;
    };
    let path = PathBuf::from(path);
    let owner = std::fs::metadata(&path).unwrap().uid();
    let _ = Store::open(&path.join("outbox"), owner).unwrap();
    panic!("migration killpoint did not run");
}

#[cfg(all(feature = "killpoints", debug_assertions))]
#[test]
fn migration_crash_before_and_after_header_rename_replays_without_loss() {
    for point in ["OUTBOX_FORMAT_SYNCED", "OUTBOX_FORMAT_RENAMED"] {
        let f = Fixture::new();
        install_fixture(&f, "legacy");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "migration_crash_child"])
            .env("OUTBOX_MIGRATION_FIXTURE", &f.path)
            .env("SMITHERS_MACHINED_KILL_AT", point)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73));
        assert_eq!(
            f.path.join("outbox/FORMAT").exists(),
            point == "OUTBOX_FORMAT_RENAMED"
        );
        assert_eq!(
            std::fs::read(f.path.join("outbox/00000000000000000003.ev")).unwrap(),
            include_bytes!("data/outbox/legacy/00000000000000000003.ev")
        );
        assert_eq!(
            std::fs::read(f.path.join("outbox/00000000000000000004.ev")).unwrap(),
            include_bytes!("data/outbox/legacy/00000000000000000004.ev")
        );
        deliver_fixture(&f);
        assert!(!f.path.join("outbox/FORMAT.tmp").exists());
    }
}

#[test]
fn unsupported_headers_leave_every_byte_and_pin_untouched_and_status_reachable() {
    use smithers_machined::{daemon, link};
    use std::net::{TcpListener, TcpStream};
    fn hello(variant: u8, fields: &[Vec<u8>]) -> Frame {
        Frame {
            kind: 0,
            stream: 0,
            payload: conn::tagged(variant, fields),
        }
    }
    for header in [
        include_bytes!("data/outbox/newer.header").as_slice(),
        include_bytes!("data/outbox/corrupt.header").as_slice(),
        b"",
        b"WRONG-MAGIC\0\0\0\0\x01",
    ] {
        let f = Fixture::new();
        install_fixture(&f, "v1");
        std::fs::write(f.path.join("outbox/FORMAT"), header).unwrap();
        // These would be removed by ordinary recovery. Refusal must not touch them.
        std::fs::write(f.path.join("outbox/FORMAT.tmp"), b"partial").unwrap();
        std::fs::write(f.path.join("outbox/SEQ.tmp"), b"99").unwrap();
        let snapshot = || -> BTreeMap<_, _> {
            std::fs::read_dir(f.path.join("outbox"))
                .unwrap()
                .map(|file| {
                    let file = file.unwrap();
                    (file.file_name(), std::fs::read(file.path()).unwrap())
                })
                .collect()
        };
        let before = snapshot();
        let error = match Store::open(&f.path.join("outbox"), f.owner) {
            Ok(_) => panic!("unsupported format admitted"),
            Err(error) => error,
        };
        assert!(smithers_machined::outbox_store::format_unsupported(&error));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let identity =
                link::Identity::new([4; 16], [9; 32], b"machine-token".to_vec()).unwrap();
            let auth = link::authenticate(socket, &identity, 1, &[]).unwrap();
            assert!(daemon::serve_outbox_refused(auth).is_err());
        });
        let mut host = TcpStream::connect(address).unwrap();
        host.set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let challenge = Frame::read(&mut host).unwrap();
        let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
        let nonce = fields[3].1.try_into().unwrap();
        hello(
            2,
            &[
                conn::field(1, conn::PROTOCOL.to_be_bytes()),
                conn::field(
                    2,
                    conn::host_mac(&[9; 32], conn::PROTOCOL, &[4; 16], &nonce),
                ),
            ],
        )
        .write(&mut host)
        .unwrap();
        assert_eq!(Frame::read(&mut host).unwrap().payload[0], 3);
        hello(4, &[]).write(&mut host).unwrap();
        // Status remains callable; capture is refused too. Only RPC replies can
        // arrive: any outbox event or bundle would fail the frame-kind assertion.
        for (id, method) in [(1u32, 1u8), (2, 4), (3, 1)] {
            Frame {
                kind: 1,
                stream: 0,
                payload: conn::tagged(
                    1,
                    &[
                        conn::field(1, id.to_be_bytes()),
                        conn::field(2, conn::tagged(method, &[])),
                    ],
                ),
            }
            .write(&mut host)
            .unwrap();
            let response = Frame::read(&mut host).unwrap();
            assert_eq!(response.kind, 1);
            let fields = conn::fields("response", &response.payload[1..]).unwrap();
            assert_eq!(fields[0].1, id.to_be_bytes());
            assert_eq!(fields[1].1, include_bytes!("data/outbox/refusal.result"));
            let error = conn::fields("error", &fields[1].1[1..]).unwrap();
            assert_eq!(error[0].1, [2]);
            assert_eq!(&error[1].1[2..], b"outbox_format_unsupported");
        }
        host.set_read_timeout(Some(std::time::Duration::from_millis(100)))
            .unwrap();
        use std::io::Read;
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err(), "unsolicited durable frame");
        drop(host);
        worker.join().unwrap();
        assert_eq!(snapshot(), before);
        assert_eq!(f.repo.0.lock().unwrap().pins.len(), 2);
    }
}
