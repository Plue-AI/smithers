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
