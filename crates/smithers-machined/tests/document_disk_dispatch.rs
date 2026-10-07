//! Run on the preprovisioned Linux machine as machined (uid 19998):
//! cargo test -p smithers-machined --test document_disk_dispatch -- --ignored
//! No broker, privilege transition or fixture disk implementation is used.
#![cfg(target_os = "linux")]
use smithers_machined::{
    conn::{self, Frame},
    doc::{
        authors, core,
        disk::{LinuxDisk, Versions},
        host::{Gates, Host},
        service::Service,
        state::{digest, Record},
    },
    document_payload::Document,
    files::Files,
    hooks::{self, Documents},
    lock::LockCx,
    rpc,
};
use std::{
    fs::{self, File},
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use yrs::{
    sync::SyncMessage,
    updates::{decoder::Decode, encoder::Encode},
    GetString, ReadTxn, Text, Transact,
};
const MEMBER: &[u8] = &[0, 255, 128, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

#[derive(Clone, Default)]
struct Receipts(Arc<Mutex<Vec<Vec<u8>>>>);
impl Versions for Receipts {
    fn outside(
        &mut self,
        _: &str,
        bytes: &[u8],
        _: &str,
    ) -> smithers_machined::doc::Result<String> {
        self.0.lock().unwrap().push(bytes.to_vec());
        Ok(format!("fixture:{}", self.0.lock().unwrap().len()))
    }
    fn own_write(&mut self, _: &str, _: [u8; 32]) {}
}
struct Clock(AtomicU64, Instant);
impl hooks::Clock for Clock {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
    fn mono(&self) -> Instant {
        self.1 + std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}
struct Fixture {
    root: PathBuf,
    clock: Arc<Clock>,
    receipts: Receipts,
}
impl Fixture {
    fn new() -> Self {
        assert_eq!(
            rustix::process::getuid().as_raw(),
            19998,
            "requires preprovisioned machined identity; no privilege fallback"
        );
        assert_eq!(rustix::process::geteuid().as_raw(), 19998);
        eprintln!(
            "DocumentDispatch: uid=19998 machine={}",
            fs::read_to_string("/etc/machine-id").unwrap().trim()
        );
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!(
            "document-dispatch-{:x}",
            u128::from_be_bytes(nonce)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        fs::create_dir(root.join("store")).unwrap();
        fs::set_permissions(root.join("store"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("workspace/a.rs"), b"abc").unwrap();
        fs::set_permissions(
            root.join("workspace/a.rs"),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        fs::write(root.join("sentinel"), b"outside unchanged").unwrap();
        Self {
            root,
            clock: Arc::new(Clock(AtomicU64::new(0), Instant::now())),
            receipts: Receipts::default(),
        }
    }
    fn service(&self) -> (Arc<Service<LinuxDisk<Receipts>>>, LockCx) {
        let disk = LinuxDisk::new(
            File::open(self.root.join("workspace")).unwrap(),
            File::open(self.root.join("store")).unwrap(),
            self.receipts.clone(),
        )
        .unwrap();
        let gates = Gates {
            codec: true,
            dispatcher: true,
            envelopes: true,
            saved_epoch: true,
            authenticated_machine: true,
            mutation_lock: true,
            capture_rewrite: true,
            attribution: true,
            versions: true,
            topology: true,
            kernel: true,
            non_root_machine: true,
        };
        let mut next = 0;
        let service = Arc::new(Service::new(
            Host::new(disk, gates, move || {
                next += 1;
                Ok(next)
            }),
            self.clock.clone(),
        ));
        let files = Files::new(
            File::open(self.root.join("workspace")).unwrap(),
            Arc::new(hooks::Disabled),
        )
        .unwrap();
        let cx = LockCx::new(hooks::Hooks {
            documents: service.clone(),
            core: Arc::new(files),
            clock: self.clock.clone(),
            ..Default::default()
        });
        (service, cx)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for dir in ["workspace", "store"] {
            let _ = fs::set_permissions(self.root.join(dir), fs::Permissions::from_mode(0o700));
        }
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn string(s: &str) -> Vec<u8> {
    let mut b = (s.len() as u16).to_be_bytes().to_vec();
    b.extend(s.as_bytes());
    b
}
fn request(method: u8, fields: &[Vec<u8>]) -> Frame {
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 1u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, fields)),
            ],
        ),
    }
}
fn result(reply: &Frame) -> Vec<u8> {
    conn::fields("response", &reply.payload[1..]).unwrap()[1]
        .1
        .to_vec()
}
fn open(cx: &mut LockCx, path: &str) -> Vec<u8> {
    open_as(cx, path, MEMBER)
}
fn open_as(cx: &mut LockCx, path: &str, actor: &[u8]) -> Vec<u8> {
    result(
        &rpc::dispatch(
            &request(
                13,
                &[
                    conn::field(1, string(path)),
                    conn::field(
                        2,
                        conn::actor_bytes(&hooks::Actor::Principal(actor.to_vec())),
                    ),
                ],
            ),
            cx,
        )
        .unwrap(),
    )
}
fn stream(result: &[u8]) -> u32 {
    assert_eq!(result[0], 13);
    u32::from_be_bytes(
        conn::fields("result13", &result[1..]).unwrap()[0]
            .1
            .try_into()
            .unwrap(),
    )
}
fn update(cx: &mut LockCx, id: u32, seq: u64, data: SyncMessage) -> Frame {
    update_as(cx, id, seq, data, MEMBER)
}
fn update_as(cx: &mut LockCx, id: u32, seq: u64, data: SyncMessage, actor: &[u8]) -> Frame {
    rpc::dispatch(
        &Frame {
            kind: 4,
            stream: id,
            payload: Document {
                msg: 1,
                actor: actor.to_vec(),
                seq,
                data: data.encode_v1(),
                ..Default::default()
            }
            .encode_v2()
            .unwrap(),
        },
        cx,
    )
    .unwrap()
}
fn replica(cx: &mut LockCx, id: u32, client: u32) -> yrs::Doc {
    replica_as(cx, id, client, MEMBER)
}
fn replica_as(cx: &mut LockCx, id: u32, client: u32, actor: &[u8]) -> yrs::Doc {
    let response = update_as(cx, id, 0, SyncMessage::SyncStep1(Default::default()), actor);
    let d = Document::decode_v2(&response.payload).unwrap();
    let SyncMessage::SyncStep2(bytes) = SyncMessage::decode_v1(&d.data).unwrap() else {
        panic!("sync2")
    };
    let doc = core::document(Some(client as u64));
    core::apply(&doc, core::decode(&bytes).unwrap()).unwrap();
    doc
}
fn type_text(cx: &mut LockCx, id: u32, client: u32) -> Frame {
    let doc = replica(cx, id, client);
    let before = doc.transact().state_vector();
    doc.get_or_insert_text("content")
        .insert(&mut doc.transact_mut(), 3, " 🦀");
    let bytes = doc.transact().encode_state_as_update_v1(&before);
    update(cx, id, 1, SyncMessage::Update(bytes))
}
fn write(cx: &mut LockCx, path: &str, base: [u8; 32]) -> Vec<u8> {
    result(
        &rpc::dispatch(
            &request(
                3,
                &[
                    conn::field(1, string(path)),
                    conn::field(2, conn::tagged(1, &[conn::field(1, base)])),
                    conn::field(3, [0, 0, 0, 3, b'n', b'e', b'w']),
                    conn::field(
                        4,
                        conn::actor_bytes(&hooks::Actor::Principal(MEMBER.to_vec())),
                    ),
                ],
            ),
            cx,
        )
        .unwrap(),
    )
}
#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
#[allow(non_snake_case)]
fn DocumentDispatchConfinement() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    symlink("../sentinel", f.root.join("workspace/link")).unwrap();
    symlink(&f.root, f.root.join("workspace/escape")).unwrap();
    fs::create_dir(f.root.join("workspace/dir")).unwrap();
    rustix::fs::mknodat(
        rustix::fs::CWD,
        f.root.join("workspace/fifo"),
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::from_raw_mode(0o600),
        0,
    )
    .unwrap();
    for path in [
        "../sentinel",
        "/etc/passwd",
        "escape/sentinel",
        "link",
        "dir",
        "fifo",
    ] {
        assert_eq!(open(&mut cx, path)[0], 255, "{path}");
        assert_eq!(
            write(&mut cx, path, digest(b"outside unchanged"))[0],
            255,
            "{path}"
        );
    }
    let id = stream(&open(&mut cx, "a.rs"));
    let epoch = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
    for payload in [
        vec![1],
        vec![2],
        Document {
            msg: 3,
            data: vec![0, 0],
            ..Default::default()
        }
        .encode_v2()
        .unwrap(),
    ] {
        assert_eq!(
            rpc::dispatch(
                &Frame {
                    kind: 4,
                    stream: id,
                    payload
                },
                &mut cx
            )
            .unwrap()
            .payload[0],
            255
        );
    }
    assert_eq!(
        type_text(&mut cx, id, 424242).payload[0],
        255,
        "forged client"
    );
    assert_eq!(type_text(&mut cx, id, epoch.client_id).payload[0], 3);
    fs::rename(
        f.root.join("workspace/a.rs"),
        f.root.join("workspace/parked"),
    )
    .unwrap();
    symlink("../sentinel", f.root.join("workspace/a.rs")).unwrap();
    f.clock.0.store(200, Ordering::Relaxed);
    assert!(
        service.poll(&mut cx).is_err(),
        "no saved after symlink substitution"
    );
    assert_eq!(write(&mut cx, "a.rs", digest("abc 🦀".as_bytes()))[0], 255);
    assert_eq!(
        fs::read(f.root.join("sentinel")).unwrap(),
        b"outside unchanged"
    );
    assert_eq!(fs::read(f.root.join("workspace/parked")).unwrap(), b"abc");
}
#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
fn durable_record_restart_and_real_permission_faults() {
    for directory in ["store", "workspace"] {
        let f = Fixture::new();
        let (service, mut cx) = f.service();
        let original = fs::metadata(f.root.join("workspace/a.rs")).unwrap();
        let id = stream(&open(&mut cx, "a.rs"));
        let epoch = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
        assert_eq!(type_text(&mut cx, id, epoch.client_id).payload[0], 3);
        fs::set_permissions(f.root.join(directory), fs::Permissions::from_mode(0o500)).unwrap();
        f.clock.0.store(200, Ordering::Relaxed);
        assert!(service.poll(&mut cx).is_err());
        assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
        fs::set_permissions(f.root.join(directory), fs::Permissions::from_mode(0o700)).unwrap();
        let output = service.poll(&mut cx).unwrap();
        assert!(output
            .iter()
            .any(|frame| Document::decode_v2(&frame.payload).unwrap().through_seq == 1));
        assert_eq!(
            fs::read(f.root.join("workspace/a.rs")).unwrap(),
            "abc 🦀".as_bytes()
        );
        let saved = fs::metadata(f.root.join("workspace/a.rs")).unwrap();
        assert_eq!(saved.mode() & 0o7777, 0o640);
        assert_eq!(saved.gid(), original.gid());
        assert_eq!(saved.uid(), 19998);
        let key: String = digest(b"a.rs").iter().map(|b| format!("{b:02x}")).collect();
        let record = Record::decode(&fs::read(f.root.join("store").join(key)).unwrap()).unwrap();
        assert_eq!(record.epoch, epoch.epoch);
        assert_eq!(record.text, "abc 🦀");
        drop(cx);
        drop(service);
        let (recovered, mut cx) = f.service();
        let id = stream(&open(&mut cx, "a.rs"));
        let reopened = Document::decode_v2(&recovered.poll(&mut cx).unwrap()[0].payload).unwrap();
        assert_eq!(reopened.epoch, epoch.epoch);
        let doc = replica(&mut cx, id, reopened.client_id);
        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            "abc 🦀"
        );
        assert_eq!(write(&mut cx, "a.rs", digest("abc 🦀".as_bytes()))[0], 3);
        assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"new");
    }
}

#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
fn outside_save_ordering_and_held_inode_are_never_lost_200_runs() {
    use std::io::{Seek, SeekFrom, Write};
    for round in 0..200 {
        let f = Fixture::new();
        let (service, mut cx) = f.service();
        let id = stream(&open(&mut cx, "a.rs"));
        let epoch = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
        assert_eq!(type_text(&mut cx, id, epoch.client_id).payload[0], 3);
        let path = f.root.join("workspace/a.rs");
        let outside = format!("outside-{round}");
        match round % 3 {
            0 => {
                // Completed outside save precedes debounce; watcher delayed.
                fs::write(&path, outside.as_bytes()).unwrap();
            }
            1 => {
                // A writer keeps the old inode open across RENAME_EXCHANGE.
                let mut writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
                f.clock.0.store(200, Ordering::Relaxed);
                service.poll(&mut cx).unwrap();
                writer.set_len(0).unwrap();
                writer.seek(SeekFrom::Start(0)).unwrap();
                writer.write_all(outside.as_bytes()).unwrap();
                writer.sync_all().unwrap();
            }
            _ => {
                f.clock.0.store(200, Ordering::Relaxed);
                service.poll(&mut cx).unwrap();
                fs::write(&path, outside.as_bytes()).unwrap();
                service
                    .completed_write(&mut cx, "a.rs", &hooks::Actor::Session(7))
                    .unwrap();
            }
        }
        for now in [200, 400, 600, 800, 2000] {
            f.clock.0.store(now, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
        }
        // §9.2.3: once the live edit has been flushed, base equals ours.
        // A later completed outside save has no overlap and must apply. The
        // pre-flush and held-old-inode cases still overlap the unsaved edit.
        let expected = if round % 3 == 2 {
            outside.as_str()
        } else {
            "abc 🦀"
        };
        assert!(
            f.receipts
                .0
                .lock()
                .unwrap()
                .contains(&outside.as_bytes().to_vec()),
            "round {round}"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            expected.as_bytes(),
            "round {round}"
        );
        let doc = replica(&mut cx, id, epoch.client_id);
        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            expected
        );
        assert_eq!(
            service
                .take_notices(&mut cx)
                .unwrap()
                .iter()
                .any(|notice| matches!(
                    notice,
                    smithers_machined::doc::host::Notice::Outside { .. }
                )),
            round % 3 != 2,
            "conflict notice round {round}"
        );
        assert!(authors::entries(&doc)
            .unwrap()
            .values()
            .any(|by| by == "00ff800102030405060708090a0b0c0d"));
        drop(cx);
        drop(service);
        let (recovered, mut cx) = f.service();
        let id = stream(&open(&mut cx, "a.rs"));
        let reopened = Document::decode_v2(&recovered.poll(&mut cx).unwrap()[0].payload).unwrap();
        assert_eq!(reopened.epoch, epoch.epoch);
        let restarted = replica(&mut cx, id, reopened.client_id);
        assert_eq!(
            restarted
                .get_or_insert_text("content")
                .get_string(&restarted.transact()),
            expected,
            "restart round {round}"
        );
        assert!(authors::entries(&restarted)
            .unwrap()
            .values()
            .any(|by| by == "00ff800102030405060708090a0b0c0d"));
    }
}

#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
fn oversized_displaced_file_is_retained_whole_without_a_receipt() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let id = stream(&open(&mut cx, "a.rs"));
    let epoch = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
    assert_eq!(type_text(&mut cx, id, epoch.client_id).payload[0], 3);
    let outside = vec![b'z'; 2 << 20];
    fs::write(f.root.join("workspace/a.rs"), &outside).unwrap();
    f.clock.0.store(200, Ordering::Relaxed);
    assert!(service.poll(&mut cx).is_err());
    assert!(f.receipts.0.lock().unwrap().is_empty());
    let displaced: Vec<_> = fs::read_dir(f.root.join("workspace"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".smithers-doc-")
        })
        .collect();
    assert_eq!(displaced.len(), 1);
    assert_eq!(fs::read(&displaced[0]).unwrap(), outside);
    assert!(!service.all_flushed());
}

#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
fn foreign_actor_cannot_reuse_author_clock_on_real_disk() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let id = stream(&open(&mut cx, "a.rs"));
    let epoch = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
    let doc = replica(&mut cx, id, epoch.client_id);
    let authors_before = authors::entries(&doc).unwrap();
    let before = doc.transact().state_vector();
    doc.get_or_insert_text("content")
        .insert(&mut doc.transact_mut(), 3, " 🦀");
    let bytes = doc.transact().encode_state_as_update_v1(&before);
    let refused = update_as(
        &mut cx,
        id,
        1,
        SyncMessage::Update(bytes.clone()),
        &[17; 16],
    );
    assert_eq!(refused.payload[0], 255);
    let fields = conn::fields("error", &refused.payload[1..]).unwrap();
    assert_eq!(fields[0], (1, &[11][..]), "forged_actor refusal");
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
    let unchanged = replica(&mut cx, id, epoch.client_id);
    assert_eq!(
        unchanged
            .get_or_insert_text("content")
            .get_string(&unchanged.transact()),
        "abc"
    );
    assert_eq!(authors::entries(&unchanged).unwrap(), authors_before);
    assert_eq!(
        update(&mut cx, id, 1, SyncMessage::Update(bytes.clone())).payload[0],
        3
    );
    assert_eq!(
        update(&mut cx, id, 1, SyncMessage::Update(bytes)).payload[0],
        3
    );
    f.clock.0.store(200, Ordering::Relaxed);
    let saved = service.poll(&mut cx).unwrap();
    assert!(saved
        .iter()
        .any(|frame| Document::decode_v2(&frame.payload).unwrap().through_seq == 1));
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        "abc 🦀".as_bytes()
    );
}

#[test]
#[ignore = "requires preprovisioned Linux machine uid 19998; never run as root"]
fn two_members_edits_save_and_reopen_with_both_authors() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let first = stream(&open(&mut cx, "a.rs"));
    let one = Document::decode_v2(&service.poll(&mut cx).unwrap()[0].payload).unwrap();
    let second = stream(&open_as(&mut cx, "a.rs", &[17; 16]));
    let output = service.poll(&mut cx).unwrap();
    let two = output
        .iter()
        .filter(|frame| frame.stream == second)
        .map(|frame| Document::decode_v2(&frame.payload).unwrap())
        .find(|d| d.msg == 5)
        .unwrap();
    assert_ne!(one.client_id, two.client_id);
    assert_eq!(one.epoch, two.epoch);
    let a = replica(&mut cx, first, one.client_id);
    let b = replica_as(&mut cx, second, two.client_id, &[17; 16]);
    let a_before = a.transact().state_vector();
    let b_before = b.transact().state_vector();
    a.get_or_insert_text("content")
        .insert(&mut a.transact_mut(), 3, " α");
    b.get_or_insert_text("content")
        .insert(&mut b.transact_mut(), 0, "β ");
    let a_update = a.transact().encode_state_as_update_v1(&a_before);
    let b_update = b.transact().encode_state_as_update_v1(&b_before);
    assert_eq!(
        update(&mut cx, first, 1, SyncMessage::Update(a_update)).payload[0],
        3
    );
    assert_eq!(
        update_as(&mut cx, second, 1, SyncMessage::Update(b_update), &[17; 16]).payload[0],
        3
    );
    f.clock.0.store(200, Ordering::Relaxed);
    let saved = service.poll(&mut cx).unwrap();
    for stream in [first, second] {
        assert!(saved
            .iter()
            .filter(|frame| frame.stream == stream)
            .any(|frame| Document::decode_v2(&frame.payload).unwrap().through_seq == 1));
    }
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        "β abc α".as_bytes()
    );
    drop(cx);
    drop(service);
    let (recovered, mut cx) = f.service();
    let id = stream(&open(&mut cx, "a.rs"));
    let epoch = Document::decode_v2(&recovered.poll(&mut cx).unwrap()[0].payload).unwrap();
    assert_eq!(epoch.epoch, one.epoch);
    let doc = replica(&mut cx, id, epoch.client_id);
    assert_eq!(
        doc.get_or_insert_text("content")
            .get_string(&doc.transact()),
        "β abc α"
    );
    let authors = authors::entries(&doc).unwrap();
    assert_eq!(
        authors.get(&one.client_id.to_string()).map(String::as_str),
        Some("00ff800102030405060708090a0b0c0d")
    );
    assert_eq!(
        authors.get(&two.client_id.to_string()).map(String::as_str),
        Some("11111111111111111111111111111111")
    );
}
