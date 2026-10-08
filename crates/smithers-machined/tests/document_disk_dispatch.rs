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
    io::Write as _,
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
struct Receipts(
    Arc<Mutex<Vec<Vec<u8>>>>,
    Arc<Mutex<Vec<(String, [u8; 32], Option<String>)>>>,
    Arc<Mutex<Vec<(String, Option<String>)>>>,
);
impl Versions for Receipts {
    fn own_delete(
        &mut self,
        path: &str,
        actor: Option<&str>,
    ) -> smithers_machined::doc::Result<()> {
        self.2
            .lock()
            .unwrap()
            .push((path.into(), actor.map(str::to_owned)));
        Ok(())
    }

    fn outside(
        &mut self,
        _: &str,
        bytes: &[u8],
        _: &str,
    ) -> smithers_machined::doc::Result<String> {
        self.0.lock().unwrap().push(bytes.to_vec());
        Ok(format!("fixture:{}", self.0.lock().unwrap().len()))
    }
    fn before_write(&mut self, _: &str, _: Option<&str>) -> smithers_machined::doc::Result<()> {
        Ok(()) // controlled version recorder; production watcher tested separately
    }
    fn own_write(
        &mut self,
        path: &str,
        bytes: &[u8],
        _: u32,
        actor: Option<&str>,
    ) -> smithers_machined::doc::Result<()> {
        self.1
            .lock()
            .unwrap()
            .push((path.into(), digest(bytes), actor.map(str::to_owned)));
        Ok(())
    }
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
// This document/disk suite fixes item admission so it can exercise save
// semantics independently. Native item/moved-off admission is covered by the
// native and composed-install suites; this port grants no machine qualification.
struct AdmittedItem;
impl hooks::Core for AdmittedItem {
    fn validate_coding_write(&self) -> hooks::Result<()> {
        Ok(())
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
        self.with_versions(self.receipts.clone())
    }
    fn with_versions<V: Versions + 'static>(
        &self,
        versions: V,
    ) -> (Arc<Service<LinuxDisk<V>>>, LockCx) {
        let disk = LinuxDisk::new(
            File::open(self.root.join("workspace")).unwrap(),
            File::open(self.root.join("store")).unwrap(),
            versions,
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
            Arc::new(AdmittedItem),
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
        assert_eq!(saved.mode() & 0o7777, 0o660);
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
    assert_eq!(
        *f.receipts.1.lock().unwrap(),
        vec![("a.rs".into(), digest("β abc α".as_bytes()), None)]
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

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn authenticated_file_write_retains_save_author_across_disk_adapter() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    assert_eq!(write(&mut cx, "a.rs", digest(b"abc"))[0], 3);
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"new");
    assert_eq!(
        *f.receipts.1.lock().unwrap(),
        vec![(
            "a.rs".into(),
            digest(b"new"),
            Some("00ff800102030405060708090a0b0c0d".to_owned())
        )]
    );
    // Stale refusal cannot create another attributed save.
    assert_eq!(write(&mut cx, "a.rs", digest(b"abc"))[0], 255);
    assert_eq!(f.receipts.1.lock().unwrap().len(), 1);
    drop(cx);
    drop(service);
    let (service, mut cx) = f.service();
    let id = stream(&open(&mut cx, "a.rs"));
    let doc = replica(&mut cx, id, 101);
    assert_eq!(
        doc.get_or_insert_text("content")
            .get_string(&doc.transact()),
        "new"
    );
    service.flush_all(&mut cx).unwrap();
    // Reopening cannot reuse a previous save's author merely because its
    // historical CRDT client is still present.
    for (_, _, actor) in f.receipts.1.lock().unwrap().iter().skip(1) {
        assert_eq!(actor, &None);
    }
}

#[path = "document_watcher/mod.rs"]
mod watcher;

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn refused_file_write_does_not_create_an_empty_file_on_a_later_timer() {
    for path in ["new.rs", "a.rs"] {
        let f = Fixture::new();
        let (service, mut cx) = f.service();
        let base = if path == "a.rs" {
            hooks::Base::Digest(digest(b"abc"))
        } else {
            hooks::Base::Absent
        };
        let error = service
            .write_through(
                &mut cx,
                path,
                &base,
                b"refused",
                &hooks::Actor::Principal(vec![]),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, 1);
        for now in [200, 2000, 60_001] {
            f.clock.0.store(now, Ordering::Relaxed);
            assert!(service.poll(&mut cx).unwrap().is_empty());
            assert_eq!(service.flush_all(&mut cx).unwrap(), 0);
        }
        assert!(!f.root.join("workspace/new.rs").exists());
        assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
        assert_eq!(fs::read_dir(f.root.join("store")).unwrap().count(), 0);
        assert!(service.projections(&mut cx).unwrap().is_empty());
        assert!(f.receipts.0.lock().unwrap().is_empty());
        assert!(f.receipts.1.lock().unwrap().is_empty());
    }
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn stale_recovery_comparison_leaves_real_file_and_record_unchanged() {
    use smithers_machined::doc::disk::Disk;
    let f = Fixture::new();
    let mut disk = LinuxDisk::new(
        File::open(f.root.join("workspace")).unwrap(),
        File::open(f.root.join("store")).unwrap(),
        f.receipts.clone(),
    )
    .unwrap();
    let doc = core::document(None);
    doc.get_or_insert_map("authors");
    let client = authors::allocate(&doc, "original").unwrap();
    doc.get_or_insert_text("content");
    let update = smithers_machined::doc::reconcile::replace(&doc, "pending", client).unwrap();
    core::apply(&doc, core::decode(&update).unwrap()).unwrap();
    let record = Record {
        epoch: [7; 16],
        previous: Some(digest(b"abc")),
        deleted_path: None,
        previous_text: "abc".into(),
        text: "pending".into(),
        state: core::state(&doc),
        retired_clients: Default::default(),
    };
    let key = digest(b"a.rs");
    disk.store_record(key, &record).unwrap();
    let before = disk.load_record(key).unwrap().unwrap().encode().unwrap();
    let inode = fs::metadata(f.root.join("workspace/a.rs")).unwrap().ino();
    let (service, mut cx) = f.service();
    let response = write(&mut cx, "a.rs", digest(b"abc"));
    assert_eq!(response[0], 255);
    for now in [200, 2000, 60_001] {
        f.clock.0.store(now, Ordering::Relaxed);
        assert!(service.poll(&mut cx).unwrap().is_empty());
        assert_eq!(service.flush_all(&mut cx).unwrap(), 0);
    }
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
    assert_eq!(
        fs::metadata(f.root.join("workspace/a.rs")).unwrap().ino(),
        inode
    );
    assert_eq!(
        disk.load_record(key).unwrap().unwrap().encode().unwrap(),
        before
    );
    assert!(service.projections(&mut cx).unwrap().is_empty());
    assert!(f.receipts.0.lock().unwrap().is_empty());
    assert!(f.receipts.1.lock().unwrap().is_empty());
    // A later explicit open must still recover that exact persisted intent.
    let id = stream(&open(&mut cx, "a.rs"));
    let frames = service.poll(&mut cx).unwrap();
    assert!(frames
        .iter()
        .any(|f| Document::decode_v2(&f.payload).unwrap().epoch == [7; 16]));
    service.flush_all(&mut cx).unwrap();
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"pending");
    service.close(id).unwrap();
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn accepted_outside_snapshot_is_not_reported_again_as_a_swap_race() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    open(&mut cx, "a.rs");
    service.flush_all(&mut cx).unwrap();
    f.clock.0.store(200, Ordering::Relaxed);
    service.poll(&mut cx).unwrap();
    drop(cx);
    drop(service);
    fs::write(f.root.join("workspace/a.rs"), b"outside").unwrap();
    let (service, mut cx) = f.service();
    let written = write(&mut cx, "a.rs", digest(b"outside"));
    assert_eq!(written[0], 3);
    let fields = conn::fields("result3", &written[1..]).unwrap();
    assert_eq!(
        fields.len(),
        1,
        "already accepted bytes are not a raced write"
    );
    assert_eq!(fields[0].1, digest(b"new"));
    assert_eq!(*f.receipts.0.lock().unwrap(), vec![b"outside".to_vec()]);
    service.take_notices(&mut cx).unwrap();
    for now in [400, 2000, 60_201] {
        f.clock.0.store(now, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
    }
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"new");
    assert_eq!(*f.receipts.0.lock().unwrap(), vec![b"outside".to_vec()]);
    assert!(!service
        .take_notices(&mut cx)
        .unwrap()
        .iter()
        .any(|n| matches!(n, smithers_machined::doc::host::Notice::Outside { .. })));
}

fn batch(cx: &mut LockCx, changes: &[(&str, Option<&[u8]>, &[u8])]) -> Vec<u8> {
    mutations(
        cx,
        &changes
            .iter()
            .map(|(p, b, c)| (*p, *b, Some(*c)))
            .collect::<Vec<_>>(),
    )
}
fn mutations(cx: &mut LockCx, changes: &[(&str, Option<&[u8]>, Option<&[u8]>)]) -> Vec<u8> {
    let mut values = (changes.len() as u16).to_be_bytes().to_vec();
    for (path, base, content) in changes {
        let base = base
            .map(|b| conn::tagged(1, &[conn::field(1, digest(b))]))
            .unwrap_or_else(|| conn::tagged(2, &[]));
        let mut fields = vec![conn::field(1, string(path)), conn::field(2, base)];
        if let Some(content) = content {
            let mut bytes = (content.len() as u32).to_be_bytes().to_vec();
            bytes.extend(*content);
            fields.push(conn::field(3, bytes));
        }
        values.extend(conn::structure_bytes(&fields));
    }
    result(
        &rpc::dispatch(
            &request(
                17,
                &[
                    conn::field(1, values),
                    conn::field(
                        2,
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
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn batch_stale_later_file_leaves_earlier_file_absent_even_after_timers() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let response = batch(
        &mut cx,
        &[("new.rs", None, b"new"), ("a.rs", Some(b"stale"), b"bad")],
    );
    assert_eq!(response[0], 17);
    let fields = conn::fields("result17", &response[1..]).unwrap();
    assert_eq!(fields[0].1, [0, 0]);
    let failure = conn::fields("batch_failure", fields[1].1).unwrap();
    assert_eq!(failure[0].1, [0, 1]);
    assert_eq!(failure[1].1, [1]);
    assert_eq!(conn::fields("error", failure[2].1).unwrap()[0].1, [4]);
    for now in [200, 2000, 60_001] {
        f.clock.0.store(now, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
    }
    assert!(!f.root.join("workspace/new.rs").exists());
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
    assert_eq!(fs::read_dir(f.root.join("store")).unwrap().count(), 0);
    assert!(service.projections(&mut cx).unwrap().is_empty());
}
#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn cached_batch_stale_refusal_preserves_files_records_and_outside_receipts() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let first = batch(&mut cx, &[("a.rs", Some(b"abc"), b"saved")]);
    assert_eq!(first[0], 17, "{first:?}");
    f.clock.0.store(200, Ordering::Relaxed);
    service.poll(&mut cx).unwrap();
    fs::write(f.root.join("workspace/a.rs"), b"outside").unwrap();
    let records: Vec<_> = fs::read_dir(f.root.join("store"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (path.clone(), fs::read(path).unwrap())
        })
        .collect();
    let versions = f.receipts.0.lock().unwrap().clone();
    let own = f.receipts.1.lock().unwrap().clone();
    for (base, index) in [(b"saved".as_slice(), 0u16), (b"outside".as_slice(), 1u16)] {
        let response = batch(
            &mut cx,
            &[
                ("a.rs", Some(base), b"bad"),
                ("missing", Some(b"stale"), b"bad"),
            ],
        );
        let fields = conn::fields("result17", &response[1..]).unwrap();
        assert_eq!(fields[0].1, [0, 0]);
        let failure = conn::fields("batch_failure", fields[1].1).unwrap();
        assert_eq!(failure[0].1, index.to_be_bytes());
        assert_eq!(failure[1].1, [1]);
        assert_eq!(conn::fields("error", failure[2].1).unwrap()[0].1, [4]);
        assert_eq!(*f.receipts.0.lock().unwrap(), versions);
        assert_eq!(*f.receipts.1.lock().unwrap(), own);
        for (path, bytes) in &records {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
    }
    for now in [2000, 60_001] {
        f.clock.0.store(now, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
    }
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"outside");
    assert!(!f.root.join("workspace/missing").exists());
    assert_eq!(*f.receipts.0.lock().unwrap(), versions);
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn batch_io_error_preserves_applied_receipts_and_never_calls_it_stale() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("workspace/locked")).unwrap();
    fs::write(f.root.join("workspace/locked/b"), b"before").unwrap();
    fs::set_permissions(
        f.root.join("workspace/locked"),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    let (_service, mut cx) = f.service();
    let response = batch(
        &mut cx,
        &[
            ("a.rs", Some(b"abc"), b"after"),
            ("locked/b", Some(b"before"), b"bad"),
            ("not-started", None, b"must not exist"),
        ],
    );
    fs::set_permissions(
        f.root.join("workspace/locked"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(!f.root.join("workspace/not-started").exists());
    assert_eq!(response[0], 17);
    let fields = conn::fields("result17", &response[1..]).unwrap();
    assert_eq!(&fields[0].1[..2], [0, 1]);
    let receipt = conn::fields("mutation_result", &fields[0].1[2..]).unwrap();
    assert_eq!(
        conn::fields("digest_base", &receipt[0].1[1..]).unwrap()[0].1,
        digest(b"after")
    );
    let failure = conn::fields("batch_failure", fields[1].1).unwrap();
    assert_eq!(failure[0].1, [0, 1]);
    assert_eq!(failure[1].1, [0]);
    assert_eq!(conn::fields("error", failure[2].1).unwrap()[0].1, [12]);
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"after");
    assert_eq!(
        fs::read(f.root.join("workspace/locked/b")).unwrap(),
        b"before"
    );
}
#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn batch_retains_outside_edit_to_later_file_after_all_bases_were_compared() {
    struct Race {
        receipts: Receipts,
        workspace: PathBuf,
    }
    impl Versions for Race {
        fn outside(
            &mut self,
            path: &str,
            bytes: &[u8],
            actor: &str,
        ) -> smithers_machined::doc::Result<String> {
            self.receipts.outside(path, bytes, actor)
        }
        fn before_write(
            &mut self,
            path: &str,
            _: Option<&str>,
        ) -> smithers_machined::doc::Result<()> {
            if path == "a.rs" {
                fs::write(self.workspace.join("b.rs"), b"late outside")?;
            }
            Ok(())
        }
        fn own_write(
            &mut self,
            path: &str,
            bytes: &[u8],
            mode: u32,
            actor: Option<&str>,
        ) -> smithers_machined::doc::Result<()> {
            self.receipts.own_write(path, bytes, mode, actor)
        }
    }
    let f = Fixture::new();
    fs::write(f.root.join("workspace/b.rs"), b"before").unwrap();
    let (_service, mut cx) = f.with_versions(Race {
        receipts: f.receipts.clone(),
        workspace: f.root.join("workspace"),
    });
    let response = batch(
        &mut cx,
        &[
            ("a.rs", Some(b"abc"), b"one"),
            ("b.rs", Some(b"before"), b"two"),
        ],
    );
    assert_eq!(response[0], 17);
    let fields = conn::fields("result17", &response[1..]).unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(&fields[0].1[..2], [0, 2]);
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"one");
    assert_eq!(fs::read(f.root.join("workspace/b.rs")).unwrap(), b"two");
    assert!(f
        .receipts
        .0
        .lock()
        .unwrap()
        .contains(&b"late outside".to_vec()));
    let first_size = 4 + u32::from_be_bytes(fields[0].1[2..6].try_into().unwrap()) as usize;
    let second = conn::fields("mutation_result", &fields[0].1[2 + first_size..]).unwrap();
    assert_eq!(
        conn::fields("raced", second[1].1).unwrap()[1].1,
        digest(b"late outside")
    );
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn create_reports_empty_outside_file_as_a_race_including_empty_output() {
    struct CreateEmpty {
        receipts: Receipts,
        workspace: PathBuf,
    }
    impl Versions for CreateEmpty {
        fn outside(
            &mut self,
            path: &str,
            bytes: &[u8],
            actor: &str,
        ) -> smithers_machined::doc::Result<String> {
            self.receipts.outside(path, bytes, actor)
        }
        fn before_write(
            &mut self,
            path: &str,
            _: Option<&str>,
        ) -> smithers_machined::doc::Result<()> {
            assert_eq!(path, "new.rs");
            fs::write(self.workspace.join(path), b"")?;
            Ok(())
        }
        fn own_write(
            &mut self,
            path: &str,
            bytes: &[u8],
            mode: u32,
            actor: Option<&str>,
        ) -> smithers_machined::doc::Result<()> {
            self.receipts.own_write(path, bytes, mode, actor)
        }
    }
    for content in [b"ours".as_slice(), b"".as_slice()] {
        let f = Fixture::new();
        let (_service, mut cx) = f.with_versions(CreateEmpty {
            receipts: f.receipts.clone(),
            workspace: f.root.join("workspace"),
        });
        let response = batch(&mut cx, &[("new.rs", None, content)]);
        assert_eq!(response[0], 17);
        let fields = conn::fields("result17", &response[1..]).unwrap();
        assert_eq!(fields.len(), 1);
        let receipt = conn::fields("mutation_result", &fields[0].1[2..]).unwrap();
        assert_eq!(
            conn::fields("digest_base", &receipt[0].1[1..]).unwrap()[0].1,
            digest(content)
        );
        let raced = conn::fields("raced", receipt[1].1).unwrap();
        assert_eq!(&raced[0].1[2..], b"new.rs");
        assert_eq!(raced[1].1, digest(b""));
        assert_eq!(fs::read(f.root.join("workspace/new.rs")).unwrap(), content);
        assert_eq!(*f.receipts.0.lock().unwrap(), vec![Vec::<u8>::new()]);
        assert_eq!(
            f.receipts.1.lock().unwrap()[0].2.as_deref(),
            Some("00ff800102030405060708090a0b0c0d")
        );
    }
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn reopened_creation_record_distinguishes_empty_outside_file_from_interrupted_update() {
    use smithers_machined::doc::disk::Disk;
    for previous in [None, Some(digest(b""))] {
        let f = Fixture::new();
        fs::write(f.root.join("workspace/new.rs"), b"").unwrap();
        let mut disk = LinuxDisk::new(
            File::open(f.root.join("workspace")).unwrap(),
            File::open(f.root.join("store")).unwrap(),
            f.receipts.clone(),
        )
        .unwrap();
        let doc = core::document(None);
        doc.get_or_insert_map("authors");
        let author = authors::allocate(&doc, "original").unwrap();
        doc.get_or_insert_text("content");
        let update = smithers_machined::doc::reconcile::replace(&doc, "pending", author).unwrap();
        core::apply(&doc, core::decode(&update).unwrap()).unwrap();
        let record = Record {
            epoch: [7; 16],
            previous,
            deleted_path: None,
            previous_text: String::new(),
            text: "pending".into(),
            state: core::state(&doc),
            retired_clients: Default::default(),
        };
        let key = digest(b"new.rs");
        disk.store_record(key, &record).unwrap();
        drop(disk);
        let (service, mut cx) = f.service();
        let response = batch(&mut cx, &[("new.rs", Some(b""), b"next")]);
        assert_eq!(response[0], 17);
        let fields = conn::fields("result17", &response[1..]).unwrap();
        if previous.is_none() {
            assert_eq!(fields.len(), 1);
            assert_eq!(fs::read(f.root.join("workspace/new.rs")).unwrap(), b"next");
            assert_eq!(*f.receipts.0.lock().unwrap(), vec![Vec::<u8>::new()]);
        } else {
            assert_eq!(&fields[0].1[..2], [0, 0]);
            let failure = conn::fields("batch_failure", fields[1].1).unwrap();
            assert_eq!(failure[1].1, [1]);
            assert_eq!(conn::fields("error", failure[2].1).unwrap()[0].1, [4]);
            f.clock.0.store(60_001, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
            assert_eq!(fs::read(f.root.join("workspace/new.rs")).unwrap(), b"");
            assert!(f.receipts.0.lock().unwrap().is_empty());
        }
    }
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn real_move_has_absent_source_and_digest_destination_and_stale_is_a_noop() {
    for stale in [None, Some(0), Some(1)] {
        let f = Fixture::new();
        let (service, mut cx) = f.service();
        let changes = [
            (
                "a.rs",
                Some(if stale == Some(0) {
                    &b"wrong"[..]
                } else {
                    &b"abc"[..]
                }),
                None,
            ),
            (
                "b.rs",
                if stale == Some(1) {
                    Some(&b"wrong"[..])
                } else {
                    None
                },
                Some(&b"abc"[..]),
            ),
        ];
        let reply = mutations(&mut cx, &changes);
        assert_eq!(reply[0], 17);
        let fields = conn::fields("result17", &reply[1..]).unwrap();
        if let Some(index) = stale {
            assert_eq!(fields[0].1, 0u16.to_be_bytes());
            let failure = conn::fields("batch_failure", fields[1].1).unwrap();
            assert_eq!(failure[0].1, (index as u16).to_be_bytes());
            assert_eq!(failure[1].1, [1]);
            assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
            assert!(!f.root.join("workspace/b.rs").exists());
            assert_eq!(fs::read_dir(f.root.join("store")).unwrap().count(), 0);
        } else {
            let first = conn::structure_bytes(&[conn::field(1, conn::tagged(2, &[]))]);
            assert_eq!(&fields[0].1[..2], 2u16.to_be_bytes());
            assert!(fields[0].1[2..].starts_with(&first));
            assert!(!f.root.join("workspace/a.rs").exists());
            assert_eq!(fs::read(f.root.join("workspace/b.rs")).unwrap(), b"abc");
            assert_eq!(
                *f.receipts.2.lock().unwrap(),
                vec![(
                    "a.rs".into(),
                    Some(MEMBER.iter().map(|b| format!("{b:02x}")).collect())
                )]
            );
        }
        for now in [200, 2000, 60_001] {
            f.clock.0.store(now, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
        }
        assert_eq!(f.root.join("workspace/a.rs").exists(), stale.is_some());
    }
}
#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn deleted_open_inode_late_write_is_versioned_after_restart_without_reopening_path() {
    use std::io::{Seek, SeekFrom, Write};
    for recreate in [false, true] {
        let f = Fixture::new();
        let mut outside = fs::OpenOptions::new()
            .write(true)
            .open(f.root.join("workspace/a.rs"))
            .unwrap();
        let (service, mut cx) = f.service();
        let reply = mutations(&mut cx, &[("a.rs", Some(b"abc"), None)]);
        assert_eq!(conn::fields("result17", &reply[1..]).unwrap().len(), 1);
        assert!(!f.root.join("workspace/a.rs").exists());
        drop(cx);
        drop(service);
        if recreate {
            fs::write(f.root.join("workspace/a.rs"), b"recreated").unwrap();
        }
        outside.seek(SeekFrom::Start(0)).unwrap();
        outside.set_len(0).unwrap();
        outside.write_all(b"late writer").unwrap();
        outside.sync_all().unwrap();
        let (service, mut cx) = f.service();
        service.poll(&mut cx).unwrap();
        f.clock.0.store(200, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        assert_eq!(*f.receipts.0.lock().unwrap(), vec![b"late writer".to_vec()]);
        if recreate {
            assert_eq!(
                fs::read(f.root.join("workspace/a.rs")).unwrap(),
                b"recreated"
            );
        } else {
            assert!(!f.root.join("workspace/a.rs").exists());
        }
        assert!(!fs::read_dir(f.root.join("workspace")).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".smithers-doc-")));
    }
}
#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn restore_after_delete_compares_physical_absence_and_late_inode_cannot_overwrite_restore() {
    use std::io::Write;
    let f = Fixture::new();
    let mut old = fs::OpenOptions::new()
        .write(true)
        .open(f.root.join("workspace/a.rs"))
        .unwrap();
    let (service, mut cx) = f.service();
    open(&mut cx, "a.rs");
    let deleted = mutations(&mut cx, &[("a.rs", Some(b"abc"), None)]);
    assert_eq!(conn::fields("result17", &deleted[1..]).unwrap().len(), 1);
    fs::write(f.root.join("workspace/a.rs"), b"new outside").unwrap();
    let stale = mutations(&mut cx, &[("a.rs", None, Some(b"restored"))]);
    assert_eq!(
        conn::fields("result17", &stale[1..]).unwrap()[0].1,
        0u16.to_be_bytes()
    );
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        b"new outside"
    );
    fs::remove_file(f.root.join("workspace/a.rs")).unwrap();
    let restored = mutations(&mut cx, &[("a.rs", None, Some(b"restored"))]);
    assert_eq!(conn::fields("result17", &restored[1..]).unwrap().len(), 1);
    old.set_len(0).unwrap();
    old.write_all(b"late after restore").unwrap();
    old.sync_all().unwrap();
    for now in [100, 300, 2000] {
        f.clock.0.store(now, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
    }
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        b"restored"
    );
    assert!(f
        .receipts
        .0
        .lock()
        .unwrap()
        .contains(&b"late after restore".to_vec()));
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn failed_delete_intent_never_unlinks_later_file_after_restart() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    fs::set_permissions(f.root.join("workspace"), fs::Permissions::from_mode(0o555)).unwrap();
    let reply = mutations(&mut cx, &[("a.rs", Some(b"abc"), None)]);
    let fields = conn::fields("result17", &reply[1..]).unwrap();
    assert_eq!(fields[0].1, 0u16.to_be_bytes());
    assert_eq!(
        conn::fields("batch_failure", fields[1].1).unwrap()[1].1,
        [0]
    );
    assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
    drop(cx);
    drop(service);
    fs::set_permissions(f.root.join("workspace"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(f.root.join("workspace/a.rs"), b"later outside").unwrap();
    let (service, mut cx) = f.service();
    open(&mut cx, "a.rs");
    service.flush_all(&mut cx).unwrap();
    for now in [200, 2000] {
        f.clock.0.store(now, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
    }
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        b"later outside"
    );
    assert!(f.receipts.2.lock().unwrap().is_empty());
}
#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn corrupted_deletion_metadata_refuses_recovery_without_touching_recreated_file() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    let reply = mutations(&mut cx, &[("a.rs", Some(b"abc"), None)]);
    assert_eq!(conn::fields("result17", &reply[1..]).unwrap().len(), 1);
    drop(cx);
    drop(service);
    let metadata = fs::read_dir(f.root.join("store"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("displaced-")
        })
        .unwrap();
    let mut record = Record::decode(&fs::read(&metadata).unwrap()).unwrap();
    record.deleted_path = Some("other.rs".into());
    fs::write(metadata, record.encode().unwrap()).unwrap();
    fs::write(f.root.join("workspace/a.rs"), b"recreated").unwrap();
    let (service, mut cx) = f.service();
    assert!(service.ready().is_err());
    assert!(service.poll(&mut cx).is_err());
    assert_eq!(
        fs::read(f.root.join("workspace/a.rs")).unwrap(),
        b"recreated"
    );
    assert!(!f.root.join("workspace/other.rs").exists());
    assert!(fs::read_dir(f.root.join("workspace")).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".smithers-doc-")));
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn new_files_and_replacements_are_group_writable() {
    let f = Fixture::new();
    fs::write(f.root.join("workspace/script"), b"before").unwrap();
    fs::set_permissions(
        f.root.join("workspace/script"),
        fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    let sentinel = fs::metadata(f.root.join("sentinel")).unwrap();
    let (_service, mut cx) = f.service();
    let reply = batch(
        &mut cx,
        &[
            ("new", None, b""),
            ("a.rs", Some(b"abc"), b"changed"),
            ("script", Some(b"before"), b"after"),
        ],
    );
    assert_eq!(conn::fields("result17", &reply[1..]).unwrap().len(), 1);
    for (path, mode) in [("new", 0o664), ("a.rs", 0o660), ("script", 0o771)] {
        assert_eq!(
            fs::metadata(f.root.join("workspace").join(path))
                .unwrap()
                .mode()
                & 0o7777,
            mode,
            "{path}"
        );
        let file = f.root.join("workspace").join(path);
        assert_eq!(
            fs::metadata(&file).unwrap().gid(),
            rustix::process::getgid().as_raw()
        );
        let inode = fs::metadata(&file).unwrap().ino();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .write_all(b"in place")
            .unwrap();
        assert_eq!(fs::metadata(&file).unwrap().ino(), inode);
        assert_eq!(fs::read(&file).unwrap(), b"in place");
    }
    assert_eq!(
        fs::metadata(f.root.join("sentinel")).unwrap().mode(),
        sentinel.mode()
    );
    assert_eq!(
        fs::read(f.root.join("sentinel")).unwrap(),
        b"outside unchanged"
    );
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn nested_batch_create_reads_back_and_inherits_directory_group_and_setgid() {
    let f = Fixture::new();
    let workspace = f.root.join("workspace");
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o2775)).unwrap();
    let (_service, mut cx) = f.service();
    for path in ["nested/fixture.txt", "deep/one/two/three/file.txt"] {
        let reply = batch(&mut cx, &[(path, None, b"nested bytes")]);
        assert_eq!(reply[0], 17);
        assert_eq!(conn::fields("result17", &reply[1..]).unwrap().len(), 1);
        let reply =
            result(&rpc::dispatch(&request(2, &[conn::field(1, string(path))]), &mut cx).unwrap());
        assert_eq!(reply[0], 2);
        assert_eq!(
            &conn::fields("result2", &reply[1..]).unwrap()[0].1[4..],
            b"nested bytes"
        );
        assert_eq!(fs::read(workspace.join(path)).unwrap(), b"nested bytes");
        let gid = fs::metadata(&workspace).unwrap().gid();
        let metadata = fs::metadata(workspace.join(path)).unwrap();
        assert_eq!(metadata.gid(), gid);
        assert_eq!(metadata.mode() & 0o7777, 0o664);
        let mut parent = workspace.join(path);
        while parent.pop() && parent != workspace {
            let metadata = fs::metadata(&parent).unwrap();
            assert_eq!(metadata.gid(), gid);
            assert_eq!(metadata.mode() & 0o7777, 0o2775);
        }
        let refused = batch(&mut cx, &[(path, None, b"overwrite")]);
        let fields = conn::fields("result17", &refused[1..]).unwrap();
        assert_eq!(fields[0].1, [0, 0]);
        assert_eq!(
            conn::fields("batch_failure", fields[1].1).unwrap()[1].1,
            [1]
        );
        assert_eq!(fs::read(workspace.join(path)).unwrap(), b"nested bytes");
    }
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn missing_parents_are_absent_for_read_recovery_and_removal() {
    use smithers_machined::doc::disk::Disk;
    let f = Fixture::new();
    let mut disk = LinuxDisk::new(
        File::open(f.root.join("workspace")).unwrap(),
        File::open(f.root.join("store")).unwrap(),
        f.receipts.clone(),
    )
    .unwrap();
    let path = "missing/deep/file.txt";
    assert_eq!(disk.read(path).unwrap(), None);
    assert!(disk
        .recover_temps(path, digest(path.as_bytes()))
        .unwrap()
        .is_empty());
    let removed = disk
        .remove_file(path, digest(path.as_bytes()), None)
        .unwrap();
    assert!(removed.displaced.is_none());
    assert!(removed.error.is_none());
    assert!(!f.root.join("workspace/missing").exists());
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn nested_preflight_refuses_symlinks_and_workspace_escape_without_creating_directories() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("workspace/real")).unwrap();
    symlink("real", f.root.join("workspace/link")).unwrap();
    symlink("..", f.root.join("workspace/outside")).unwrap();
    let (_service, mut cx) = f.service();
    for path in [
        "link/new/file",
        "outside/new/file",
        "../new/file",
        "/new/file",
    ] {
        let reply = batch(&mut cx, &[(path, None, b"refused")]);
        if !smithers_machined::doc::disk::valid_path(path) {
            // Invalid syntax is refused by RPC decoding before batch admission.
            assert_eq!(reply[0], 255, "{path}");
            continue;
        }
        assert_eq!(reply[0], 17, "{path}");
        let fields = conn::fields("result17", &reply[1..]).unwrap();
        assert_eq!(fields[0].1, [0, 0], "{path}");
        assert_eq!(
            conn::fields("batch_failure", fields[1].1).unwrap()[1].1,
            [1]
        );
    }
    assert!(!f.root.join("workspace/real/new").exists());
    assert!(!f.root.join("new").exists());
    assert_eq!(
        fs::read(f.root.join("sentinel")).unwrap(),
        b"outside unchanged"
    );
}

#[test]
#[ignore = "requires Linux uid19998 and confined real filesystem"]
fn nested_batch_refused_preflight_leaves_no_directories_or_records() {
    let f = Fixture::new();
    let (service, mut cx) = f.service();
    for changes in [
        vec![
            ("nested/fixture.txt", None, &b"new"[..]),
            ("a.rs", None, &b"bad"[..]),
        ],
        vec![("nested/fixture.txt", Some(&b"stale"[..]), &b"new"[..])],
    ] {
        let reply = batch(&mut cx, &changes);
        let fields = conn::fields("result17", &reply[1..]).unwrap();
        assert_eq!(fields[0].1, [0, 0]);
        assert_eq!(
            conn::fields("batch_failure", fields[1].1).unwrap()[1].1,
            [1]
        );
        for now in [200, 2000, 60_001] {
            f.clock.0.store(now, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
        }
        assert!(!f.root.join("workspace/nested").exists());
        assert_eq!(fs::read(f.root.join("workspace/a.rs")).unwrap(), b"abc");
        assert_eq!(fs::read_dir(f.root.join("store")).unwrap().count(), 0);
    }
}

#[test]
fn daemon_file_permissions_in_user_namespace() {
    let executable = std::env::current_exe().unwrap();
    let result = std::process::Command::new("bwrap")
        .args([
            "--tmpfs",
            "/",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--symlink",
            "usr/bin",
            "/bin",
            "--ro-bind",
            "/etc",
            "/etc",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--unshare-user",
            "--uid",
            "19998",
            "--gid",
            "20000",
            "--die-with-parent",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
        ])
        .arg(&executable)
        .arg(&executable)
        .arg("--")
        .arg(&executable)
        .args([
            "--exact",
            "new_files_and_replacements_are_group_writable",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .expect("bubblewrap is required for the daemon file permission regression");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );
}
