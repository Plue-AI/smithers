use smithers_document_component::{
    authors, core,
    disk::{Disk, Displaced, Recovery},
    gone::Gone,
    host::{Gates, Host, Notice},
    merge, reconcile,
    state::{digest, Digest, Record},
    Error, Result,
};
use std::collections::BTreeMap;
use yrs::{Doc, GetString, Map, Text, Transact};

// Unit-only disk model: no Linux confinement/durability evidence is claimed.
#[derive(Default, Clone)]
struct Model {
    files: BTreeMap<String, Vec<u8>>,
    records: BTreeMap<Digest, Vec<u8>>,
    displaced: BTreeMap<u64, Vec<u8>>,
    versions: Vec<Vec<u8>>,
    log: Vec<&'static str>,
    fail: Option<&'static str>,
    next: u64,
    bases: BTreeMap<u64, Record>,
}
impl Model {
    fn with(text: &str) -> Self {
        let mut s = Self::default();
        s.files.insert("a.rs".into(), text.as_bytes().to_vec());
        s
    }
    fn step(&mut self, step: &'static str) -> Result<()> {
        self.log.push(step);
        if self.fail == Some(step) {
            Err(Error::Io(step.into()))
        } else {
            Ok(())
        }
    }
}
impl Disk for Model {
    fn read(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        self.step("read")?;
        Ok(self.files.get(path).cloned())
    }
    fn load_record(&mut self, key: Digest) -> Result<Option<Record>> {
        self.step("load")?;
        Ok(self
            .records
            .get(&key)
            .and_then(|bytes| Record::decode(bytes).ok()))
    }
    fn store_record(&mut self, key: Digest, record: &Record) -> Result<()> {
        self.step("record")?;
        self.records.insert(key, record.encode()?);
        Ok(())
    }
    fn swap_text(&mut self, path: &str, _: Digest, bytes: &[u8]) -> Result<Option<Displaced>> {
        self.step("swap")?;
        let old = self.files.insert(path.into(), bytes.to_vec());
        Ok(old.map(|old| {
            self.next += 1;
            self.displaced.insert(self.next, old);
            self.bases.insert(
                self.next,
                Record::decode(&self.records[&digest(path.as_bytes())]).unwrap(),
            );
            self.next
        }))
    }
    fn recover_temps(&mut self, _: &str, _: Digest) -> Result<Vec<Recovery>> {
        Ok(self
            .displaced
            .keys()
            .map(|token| Recovery {
                token: *token,
                record: self.bases[token].clone(),
            })
            .collect())
    }
    fn read_displaced(&mut self, token: u64) -> Result<Vec<u8>> {
        self.step("displaced")?;
        self.displaced.get(&token).cloned().ok_or(Error::Invalid)
    }
    fn remove_displaced(&mut self, token: u64) -> Result<()> {
        self.step("remove")?;
        self.displaced.remove(&token);
        self.bases.remove(&token);
        Ok(())
    }
    fn record_outside(&mut self, _: &str, bytes: &[u8], _: &str) -> Result<String> {
        self.step("version")?;
        self.versions.push(bytes.to_vec());
        Ok(format!("v{}", self.versions.len()))
    }
    fn own_write(&mut self, _: &str, _: Digest) {
        self.log.push("own");
    }
}
fn gates() -> Gates {
    Gates {
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
    }
}
fn ids() -> impl FnMut() -> Result<u32> {
    let mut next = 1;
    move || {
        let id = next;
        next += 1;
        Ok(id)
    }
}
fn host(text: &str) -> (Host<Model>, u32) {
    let mut host = Host::new(Model::with(text), gates(), ids());
    let stream = host.open("a.rs", [7; 16], 0).unwrap();
    (host, stream)
}
fn editor(state: &[u8], id: u64) -> Doc {
    let doc = core::document(Some(id));
    doc.get_or_insert_text("content");
    doc.get_or_insert_map("authors");
    core::apply(&doc, core::decode(state).unwrap()).unwrap();
    doc
}
fn edit(host: &mut Host<Model>, stream: u32, text: &str, now: u64) {
    let id = host.client(stream, "alice", now).unwrap();
    let doc = editor(&host.state(stream).unwrap(), id);
    let update = reconcile::replace(&doc, text, id).unwrap();
    host.update(stream, [7; 16], "alice", &update, now).unwrap();
}
fn random(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    *seed
}
fn random_text(seed: &mut u64) -> String {
    let count = (random(seed) % 18) as usize;
    (0..count)
        .map(|_| ["x\n", "🦀\n", "é\n", "\n", "z", "🐙\n"][random(seed) as usize % 6])
        .collect()
}

#[test]
fn ten_thousand_unicode_replacements_preserve_exact_text() {
    let mut seed = 23;
    for _ in 0..10_000 {
        let old = random_text(&mut seed);
        let new = random_text(&mut seed);
        let doc = core::document(Some(90));
        doc.get_or_insert_map("authors");
        doc.get_or_insert_text("content")
            .insert(&mut doc.transact_mut(), 0, &old);
        let update = reconcile::replace(&doc, &new, 12).unwrap();
        core::apply(&doc, core::decode(&update).unwrap()).unwrap();
        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            new,
            "old={old:?}, hunks={:?}",
            reconcile::hunks(&old, &new)
        );
    }
}
#[test]
fn unchanged_lines_keep_item_ids() {
    assert_eq!(
        reconcile::hunks("a\nb\n🦀\nd\n", "a\nB\n🦀\nD\n"),
        vec![
            reconcile::Hunk {
                start: 1,
                end: 2,
                text: "B\n".into()
            },
            reconcile::Hunk {
                start: 3,
                end: 4,
                text: "D\n".into()
            }
        ]
    );
}
#[test]
fn ten_thousand_merges_keep_disjoint_edits_and_snapshot_overlaps() {
    let mut seed = 84;
    for _ in 0..10_000 {
        let a = random(&mut seed);
        let b = random(&mut seed);
        let ours = format!("A{a}\nb\nc\n");
        let theirs = format!("a\nb\nC{b}\n");
        let merged = merge::merge("a\nb\nc\n", &ours, &theirs);
        assert!(!merged.overlap);
        assert_eq!(merged.text, format!("A{a}\nb\nC{b}\n"));
        assert_eq!(merged.outside, theirs);
        let theirs = format!("T{b}\nb\nC{b}\n");
        let merged = merge::merge("a\nb\nc\n", &ours, &theirs);
        assert!(merged.overlap);
        assert_eq!(merged.text, format!("A{a}\nb\nC{b}\n"));
        assert_eq!(merged.outside, theirs);
    }
}
#[test]
fn merge_boundaries_insertions_deletions_and_identical_changes() {
    for (base, ours, theirs, expected, overlap) in [
        ("", "a", "b", "a", true),
        ("a\nb\n", "b\n", "a\nB\n", "B\n", false),
        ("a\n", "A\n", "A\n", "A\n", false),
        ("a\nb\n", "x\na\nb\n", "a\nb\ny\n", "x\na\nb\ny\n", false),
        ("a\nb\n", "a\n", "a\nB\n", "a\n", true),
    ] {
        let m = merge::merge(base, ours, theirs);
        assert_eq!(m.text, expected);
        assert_eq!(m.overlap, overlap);
    }
}
#[test]
fn authors_survive_record_reopen_and_reject_forged_id_or_map() {
    let (mut h, s) = host("start\n");
    let id = h.client(s, "alice", 0).unwrap();
    edit(&mut h, s, "alice\n", 1);
    h.flush_all(1).unwrap();
    let disk = h.disk.clone();
    let mut recovered = Host::new(disk, gates(), ids());
    let s = recovered.open("a.rs", [8; 16], 2).unwrap();
    assert_eq!(recovered.epoch(s).unwrap(), [7; 16]);
    let authors = authors::entries(&editor(&recovered.state(s).unwrap(), 123)).unwrap();
    assert_eq!(authors.get(&id.to_string()).unwrap(), "alice");
    let id = recovered.client(s, "alice", 2).unwrap();
    let live = editor(&recovered.state(s).unwrap(), id);
    let forged = editor(&recovered.state(s).unwrap(), 777);
    let t = forged.get_or_insert_text("content");
    let u = {
        let mut txn = forged.transact_mut();
        t.insert(&mut txn, 0, "forged");
        txn.encode_update_v1()
    };
    assert_eq!(authors::checked_update(&live, &u, id), Err(Error::Forged));
    let m = live.get_or_insert_map("authors");
    let u = {
        let mut txn = live.transact_mut();
        m.insert(&mut txn, "777", "bob");
        txn.encode_update_v1()
    };
    let clean = editor(&recovered.state(s).unwrap(), id);
    assert_eq!(authors::checked_update(&clean, &u, id), Err(Error::Forged));
    assert_eq!(recovered.text(s).unwrap(), "alice\n");
}
#[test]
fn root_validation_keeps_wiki_single_root_and_code_roots() {
    let doc = core::document(None);
    doc.get_or_insert_text("markdown");
    assert!(core::validate(&doc, "markdown", false).is_ok());
    doc.get_or_insert_map("authors");
    assert!(core::validate(&doc, "markdown", false).is_err());
    assert!(core::validate(&doc, "markdown", true).is_ok());
    doc.get_or_insert_text("rogue");
    assert!(core::validate(&doc, "markdown", true).is_err());
}
#[test]
fn every_gate_refuses_before_disk_access() {
    let fields: [fn(&mut Gates); 12] = [
        |g| g.codec = false,
        |g| g.dispatcher = false,
        |g| g.envelopes = false,
        |g| g.saved_epoch = false,
        |g| g.authenticated_machine = false,
        |g| g.mutation_lock = false,
        |g| g.capture_rewrite = false,
        |g| g.attribution = false,
        |g| g.versions = false,
        |g| g.topology = false,
        |g| g.kernel = false,
        |g| g.non_root_machine = false,
    ];
    for disable in fields {
        let mut g = gates();
        disable(&mut g);
        let mut h = Host::new(Model::with("a"), g, ids());
        assert_eq!(h.open("a.rs", [1; 16], 0), Err(Error::Unsupported));
        assert!(h.disk.log.is_empty());
        assert!(h.notices().is_empty());
    }
}
#[test]
fn escaping_paths_refuse_before_disk_access() {
    for path in ["", "/tmp/x", "../x", "a/../x", "a//x", "./a", "a/", "a\0b"] {
        let mut h = Host::new(Model::default(), gates(), ids());
        assert_eq!(h.open(path, [1; 16], 0), Err(Error::Invalid));
        assert!(h.disk.log.is_empty());
    }
}
#[test]
fn debounce_and_continuous_typing_deadline_are_inclusive() {
    let (mut h, s) = host("a");
    h.flush_all(0).unwrap();
    h.notices();
    edit(&mut h, s, "b", 100);
    h.tick(299, true).unwrap();
    assert!(h.notices().is_empty());
    h.tick(300, true).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"b");
    assert!(matches!(
        h.notices().last(),
        Some(Notice::Saved { at_ms: 300, .. })
    ));
    for now in (400..1400).step_by(100) {
        edit(&mut h, s, &now.to_string(), now);
        h.tick(now, true).unwrap();
    }
    assert_eq!(h.disk.files["a.rs"], b"b");
    h.tick(1400, true).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"1300");
}
#[test]
fn saved_notice_follows_record_and_swap_and_failures_never_ack() {
    for fail in ["record", "swap", "displaced"] {
        let (mut h, s) = host("a");
        edit(&mut h, s, "b", 0);
        h.disk.fail = Some(fail);
        assert!(h.flush_all(0).is_err());
        assert!(h.notices().is_empty());
        assert!(!h.all_flushed());
        h.disk.fail = None;
        h.flush_all(1).unwrap();
        assert!(matches!(h.notices().last(), Some(Notice::Saved { .. })));
        assert_eq!(h.disk.files["a.rs"], b"b");
    }
    let (mut h, _) = host("a");
    h.flush_all(0).unwrap();
    assert_eq!(
        &h.disk.log[h.disk.log.len() - 4..],
        &["record", "swap", "displaced", "own"]
    );
}
#[test]
fn outside_nonoverlap_and_overlap_preserve_exact_version() {
    let (mut h, s) = host("a\nb\nc\n");
    h.flush_all(0).unwrap();
    edit(&mut h, s, "A\nb\nc\n", 10);
    h.disk.files.insert("a.rs".into(), b"a\nb\nC\n".to_vec());
    h.completed_write("a.rs", "session:3", 20).unwrap();
    assert_eq!(h.text(s).unwrap(), "A\nb\nC\n");
    assert_eq!(h.disk.versions.last().unwrap(), b"a\nb\nC\n");
    h.flush_all(20).unwrap();
    h.notices();
    edit(&mut h, s, "AA\nb\nC\n", 30);
    h.disk.files.insert("a.rs".into(), b"OUT\nb\nC\n".to_vec());
    h.completed_write("a.rs", "session:3", 40).unwrap();
    h.flush_all(40).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"AA\nb\nC\n");
    assert_eq!(h.disk.versions.last().unwrap(), b"OUT\nb\nC\n");
    assert!(h
        .notices()
        .iter()
        .any(|n| matches!(n,Notice::Outside { by,.. } if by=="session:3")));
}
#[test]
fn saved_restart_interrupted_swap_and_closed_outside_write() {
    let (mut h, s) = host("a\nb\n");
    edit(&mut h, s, "A\nb\n", 10);
    h.flush_all(10).unwrap();
    let saved = Record::decode(&h.disk.records[&digest(b"a.rs")]).unwrap();
    let mut restart = Host::new(h.disk.clone(), gates(), ids());
    let s = restart.open("a.rs", [9; 16], 20).unwrap();
    assert_eq!(restart.text(s).unwrap(), "A\nb\n");
    assert_eq!(restart.epoch(s).unwrap(), [7; 16]);
    let mut disk = h.disk.clone();
    disk.displaced.clear();
    disk.files.insert("a.rs".into(), b"a\nb\n".to_vec());
    let mut interrupted = Host::new(disk, gates(), ids());
    let s = interrupted.open("a.rs", [9; 16], 20).unwrap();
    interrupted.flush_all(20).unwrap();
    assert_eq!(interrupted.text(s).unwrap(), "A\nb\n");
    assert_eq!(interrupted.disk.files["a.rs"], b"A\nb\n");
    let mut disk = h.disk;
    disk.displaced.clear();
    disk.files.insert("a.rs".into(), b"A\nB\n".to_vec());
    let mut closed = Host::new(disk, gates(), ids());
    let s = closed.open("a.rs", [9; 16], 20).unwrap();
    assert_eq!(closed.text(s).unwrap(), "A\nB\n");
    let before = authors::entries(&saved.document().unwrap()).unwrap();
    let after = authors::entries(&editor(&closed.state(s).unwrap(), 123)).unwrap();
    for (id, actor) in before {
        assert_eq!(after.get(&id), Some(&actor));
    }
}
#[test]
fn late_inplace_writer_is_retained_until_quiet_and_versioned() {
    let (mut h, s) = host("a\nb\n");
    edit(&mut h, s, "A\nb\n", 0);
    h.flush_all(0).unwrap();
    let token = *h.disk.displaced.keys().next().unwrap();
    h.disk.displaced.insert(token, b"a\nB".to_vec());
    h.tick(199, false).unwrap();
    assert!(h.disk.versions.is_empty());
    h.disk.displaced.insert(token, b"a\nB\n".to_vec());
    h.tick(200, false).unwrap();
    h.tick(399, false).unwrap();
    assert!(h.disk.versions.is_empty());
    h.tick(400, false).unwrap();
    assert_eq!(h.text(s).unwrap(), "A\nB\n");
    assert_eq!(h.disk.versions, vec![b"a\nB\n".to_vec()]);
    assert!(!h.disk.displaced.contains_key(&token));
}
#[test]
fn no_op_outside_events_and_tool_writes_do_not_transact() {
    let (mut h, s) = host("a");
    h.flush_all(0).unwrap();
    let state = h.state(s).unwrap();
    h.completed_write("a.rs", "outside", 1).unwrap();
    assert!(h.disk.versions.is_empty());
    assert_eq!(h.state(s).unwrap(), state);
    assert!(h
        .write_through("a.rs", digest(b"a"), "a", "alice", 1)
        .unwrap());
    assert_eq!(h.state(s).unwrap(), state);
    assert_eq!(
        h.write_through("a.rs", digest(b"stale"), "b", "alice", 1),
        Err(Error::Stale)
    );
}
#[test]
fn epoch_mismatch_and_forgery_do_not_mutate() {
    let (mut h, s) = host("a");
    let id = h.client(s, "alice", 0).unwrap();
    let state = h.state(s).unwrap();
    let doc = editor(&state, id);
    let update = reconcile::replace(&doc, "b", id).unwrap();
    assert_eq!(h.update(s, [8; 16], "alice", &update, 0), Err(Error::Epoch));
    assert_eq!(h.state(s).unwrap(), state);
    assert_eq!(h.update(s, [7; 16], "bob", &update, 0), Err(Error::Forged));
    assert_eq!(h.state(s).unwrap(), state);
    h.update(s, [7; 16], "alice", &update, 0).unwrap();
    h.update(s, [7; 16], "alice", &update, 1).unwrap();
    assert_eq!(h.text(s).unwrap(), "b");
}
#[test]
fn delete_restore_rename_follow_and_close_timer() {
    let (mut h, s) = host("a");
    h.flush_all(0).unwrap();
    h.disk.files.remove("a.rs");
    h.gone(
        "a.rs",
        Gone::Deleted {
            by: "outside".into(),
        },
    )
    .unwrap();
    assert_eq!(h.update(s, [7; 16], "alice", &[0, 0], 0), Err(Error::Gone));
    assert!(h
        .write_through("a.rs", digest(b"a"), "a", "alice", 1)
        .unwrap());
    h.flush_all(1).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"a");
    h.disk.files.insert("b.rs".into(), b"a".to_vec());
    h.gone(
        "a.rs",
        Gone::Renamed {
            to: "b.rs".into(),
            by: "outside".into(),
        },
    )
    .unwrap();
    h.close(s, 10).unwrap();
    assert_eq!(h.text(s), Err(Error::Invalid));
    let followed = h.open("b.rs", [3; 16], 10).unwrap();
    assert_eq!(h.text(followed).unwrap(), "a");
    let (mut h, s) = host("a");
    h.close(s, 0).unwrap();
    h.tick(59_999, true).unwrap();
    let s = h.open("a.rs", [8; 16], 59_999).unwrap();
    assert_eq!(h.epoch(s).unwrap(), [7; 16]);
    h.close(s, 60_000).unwrap();
    h.tick(120_000, true).unwrap();
    h.tick(120_200, true).unwrap();
    let s = h.open("a.rs", [9; 16], 120_201).unwrap();
    assert_eq!(h.epoch(s).unwrap(), [7; 16]);
    assert_eq!(h.text(s).unwrap(), "a");
}
#[test]
fn binary_and_two_mib_files_refuse_edits_and_never_save() {
    for bytes in [vec![b'x'; 2 * 1024 * 1024], vec![0xff, 0xfe]] {
        let mut disk = Model::default();
        disk.files.insert("a.rs".into(), bytes.clone());
        let mut h = Host::new(disk, gates(), ids());
        let s = h.open("a.rs", [2; 16], 0).unwrap();
        assert_eq!(h.client(s, "alice", 0), Err(Error::ReadOnly));
        assert_eq!(
            h.update(s, [2; 16], "alice", &[0, 0], 0),
            Err(Error::ReadOnly)
        );
        h.flush_all(0).unwrap();
        assert!(h.notices().is_empty());
        assert_eq!(h.disk.files["a.rs"], bytes);
    }
}
#[test]
fn typing_keeps_applying_while_rewrite_holds_saves() {
    let (mut h, s) = host("a\nb\n");
    h.flush_all(0).unwrap();
    h.tick(200, true).unwrap();
    h.notices();
    edit(&mut h, s, "A\nb\n", 300);
    h.tick(1500, false).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"a\nb\n");
    h.disk.files.insert("a.rs".into(), b"a\nB\n".to_vec());
    h.reconcile_all("rebased:Tk", 1500).unwrap();
    assert_eq!(h.text(s).unwrap(), "A\nB\n");
    h.flush_all(1500).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"A\nB\n");
}
#[test]
fn per_editor_activity_waits_two_seconds_of_idle() {
    let (mut h, s) = host("a");
    edit(&mut h, s, "b", 10);
    edit(&mut h, s, "c", 1000);
    h.tick(2999, true).unwrap();
    assert!(!h
        .notices()
        .iter()
        .any(|n| matches!(n, Notice::Activity { .. })));
    h.tick(3000, true).unwrap();
    assert_eq!(
        h.notices()
            .iter()
            .filter(|n| matches!(n,Notice::Activity { actor,.. } if actor=="alice"))
            .count(),
        1
    );
    h.tick(6000, true).unwrap();
    assert!(!h
        .notices()
        .iter()
        .any(|n| matches!(n, Notice::Activity { .. })));
}
#[test]
fn record_checksum_bounds_and_state_text_consistency() {
    let (mut h, _) = host("🦀");
    h.flush_all(0).unwrap();
    let bytes = h.disk.records[&digest(b"a.rs")].clone();
    assert_eq!(&bytes[..8], b"SMTHDOC1");
    assert_eq!(Record::decode(&bytes).unwrap().text, "🦀");
    for at in 0..bytes.len() {
        let mut bad = bytes.clone();
        bad[at] ^= 1;
        assert!(Record::decode(&bad).is_err());
    }
    for len in 0..bytes.len() {
        assert!(Record::decode(&bytes[..len]).is_err());
    }
    let mut rec = Record::decode(&bytes).unwrap();
    rec.text = "wrong".into();
    assert!(Record::decode(&rec.encode().unwrap()).is_err());
}

#[test]
fn subscribers_of_one_actor_have_distinct_clients_and_outside_id_is_stable() {
    let (mut h, a) = host("a");
    let b = h.open("a.rs", [99; 16], 0).unwrap();
    let ca = h.client(a, "alice", 0).unwrap();
    let cb = h.client(b, "alice", 0).unwrap();
    assert_ne!(ca, cb);
    assert_eq!(h.client(a, "alice", 1).unwrap(), ca);
    let doc = editor(&h.state(a).unwrap(), 31);
    let outside = authors::allocate(&doc, "session:4").unwrap();
    let state = core::state(&doc);
    let reopened = editor(&state, 32);
    assert_eq!(authors::allocate(&reopened, "session:4").unwrap(), outside);
}

#[test]
fn reconnect_sync_step_two_replays_existing_other_actor_structs_without_duplication() {
    let (mut h, s) = host("a");
    let ca = h.client(s, "alice", 0).unwrap();
    let state = h.state(s).unwrap();
    let doc = editor(&state, ca);
    let update = reconcile::replace(&doc, "A", ca).unwrap();
    core::apply(&doc, core::decode(&update).unwrap()).unwrap();
    h.update(s, [7; 16], "alice", &update, 0).unwrap();
    h.flush_all(0).unwrap();
    let mut reopened = Host::new(h.disk.clone(), gates(), ids());
    let stream = reopened.open("a.rs", [9; 16], 1).unwrap();
    reopened.client(stream, "alice", 1).unwrap();
    reopened
        .sync_message(
            stream,
            [7; 16],
            "alice",
            yrs::sync::SyncMessage::SyncStep2(core::state(&doc)),
            1,
        )
        .unwrap();
    assert_eq!(reopened.text(stream).unwrap(), "A");
    let response = reopened
        .sync_message(
            stream,
            [7; 16],
            "alice",
            yrs::sync::SyncMessage::SyncStep1(yrs::StateVector::default()),
            1,
        )
        .unwrap();
    assert!(matches!(
        &response[..],
        [
            yrs::sync::SyncMessage::SyncStep2(_),
            yrs::sync::SyncMessage::SyncStep1(_)
        ]
    ));
}

#[test]
fn pending_predecessor_survives_code_record_reopen() {
    let (mut h, s) = host("");
    let client = h.client(s, "alice", 0).unwrap();
    let doc = editor(&h.state(s).unwrap(), client);
    let text = doc.get_or_insert_text("content");
    let first = {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "first");
        txn.encode_update_v1()
    };
    let second = {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 5, " second");
        txn.encode_update_v1()
    };
    h.update(s, [7; 16], "alice", &second, 0).unwrap();
    assert_eq!(h.text(s).unwrap(), "");
    h.flush_all(0).unwrap();
    let mut restarted = Host::new(h.disk, gates(), ids());
    let s = restarted.open("a.rs", [8; 16], 1).unwrap();
    restarted.client(s, "alice", 1).unwrap();
    restarted.update(s, [7; 16], "alice", &first, 1).unwrap();
    assert_eq!(restarted.text(s).unwrap(), "first second");
}

#[test]
fn corrupt_record_makes_new_epoch_and_refuses_old_epoch_edits() {
    let (mut h, s) = host("a");
    let client = h.client(s, "alice", 0).unwrap();
    let doc = editor(&h.state(s).unwrap(), client);
    let update = reconcile::replace(&doc, "unsaved", client).unwrap();
    h.flush_all(0).unwrap();
    let key = digest(b"a.rs");
    h.disk.records.get_mut(&key).unwrap()[0] ^= 1;
    let mut restarted = Host::new(h.disk, gates(), ids());
    let s = restarted.open("a.rs", [8; 16], 1).unwrap();
    restarted.client(s, "alice", 1).unwrap();
    assert_eq!(restarted.epoch(s).unwrap(), [8; 16]);
    assert_eq!(
        restarted.update(s, [7; 16], "alice", &update, 1),
        Err(Error::Epoch)
    );
    assert_eq!(restarted.text(s).unwrap(), "a");
}

#[test]
fn unchanged_characters_within_changed_line_keep_original_author() {
    let (mut h, s) = host("Alice 🦀 end\n");
    let client = h.client(s, "alice", 0).unwrap();
    let original = editor(&h.state(s).unwrap(), client);
    let update = reconcile::replace(&original, "Alice 🐙 end\n", client).unwrap();
    // This transaction inserts only the changed astral character (two UTF-16
    // units), preserving both the prefix and suffix's CRDT item identities.
    let decoded = core::decode(&update).unwrap();
    assert_eq!(decoded.state_vector().get(&yrs::ClientID::new(client)), 2);
    h.update(s, [7; 16], "alice", &update, 0).unwrap();
    assert_eq!(h.text(s).unwrap(), "Alice 🐙 end\n");
}

#[test]
fn recovered_displaced_previous_save_does_not_revert_acknowledged_edits() {
    let (mut h, s) = host("a\nb\n");
    edit(&mut h, s, "A\nb\n", 0);
    h.flush_all(0).unwrap();
    let mut restarted = Host::new(h.disk, gates(), ids());
    let s = restarted.open("a.rs", [9; 16], 1).unwrap();
    restarted.tick(201, true).unwrap();
    assert_eq!(restarted.text(s).unwrap(), "A\nb\n");
    assert!(restarted.disk.versions.is_empty());
    assert!(!restarted
        .notices()
        .iter()
        .any(|n| matches!(n, Notice::Outside { .. })));
}

#[test]
fn repeated_unicode_diff_regression() {
    let old = "x\n🦀\né\n\né\n🐙\né\n\nz🐙\nz🐙\né\n🦀\nz🐙\nx\n";
    let new = "x\n🦀\né\n🦀\né\n\nx\n\nx\n\nx\n🦀\nz";
    let hs = reconcile::hunks(old, new);
    let lines: Vec<_> = old.split_inclusive('\n').collect();
    let mut out = String::new();
    let mut pos = 0;
    for h in hs {
        out.push_str(&lines[pos..h.start].concat());
        out.push_str(&h.text);
        pos = h.end;
    }
    out.push_str(&lines[pos..].concat());
    assert_eq!(out, new);
}

#[test]
fn awareness_is_bound_to_stream_actor_and_is_removed_on_close() {
    let (mut h, s) = host("a\nb\n");
    assert_eq!(
        h.awareness(s, [7; 16], "alice", "#123456", Some(2)),
        Err(Error::Forged)
    );
    h.client(s, "alice", 0).unwrap();
    assert_eq!(
        h.awareness(s, [8; 16], "alice", "#123456", Some(2)),
        Err(Error::Epoch)
    );
    assert_eq!(
        h.awareness(s, [7; 16], "alice", "#123456", Some(0)),
        Err(Error::Invalid)
    );
    h.awareness(s, [7; 16], "alice", "#123456", Some(2))
        .unwrap();
    let p = h.projection("a.rs").unwrap();
    assert_eq!(p.editors.len(), 1);
    assert_eq!(p.editors[0].path, "a.rs");
    assert_eq!(p.editors[0].line, 2);
    h.awareness(s, [7; 16], "alice", "#123456", None).unwrap();
    assert!(h.projection("a.rs").unwrap().editors.is_empty());
    h.awareness(s, [7; 16], "alice", "#123456", Some(1))
        .unwrap();
    h.close(s, 0).unwrap();
    assert!(h.projection("a.rs").unwrap().editors.is_empty());
}

#[test]
fn shared_stream_allocator_is_required_and_invalid_or_reused_ids_never_open() {
    let mut missing = Host::new(Model::with("a"), gates(), || Err(Error::Unsupported));
    assert_eq!(missing.open("a.rs", [1; 16], 0), Err(Error::Unsupported));
    assert!(missing.disk.log.is_empty());
    for id in [0, 0x8000_0000] {
        let mut invalid = Host::new(Model::with("a"), gates(), move || Ok(id));
        assert_eq!(invalid.open("a.rs", [1; 16], 0), Err(Error::Invalid));
        assert!(invalid.disk.log.is_empty());
    }
    let mut shared = Host::new(Model::with("a"), gates(), || Ok(77));
    assert_eq!(shared.open("a.rs", [1; 16], 0).unwrap(), 77);
    let reads = shared.disk.log.len();
    assert_eq!(shared.open("a.rs", [1; 16], 0), Err(Error::Invalid));
    assert_eq!(shared.disk.log.len(), reads);
}
