use smithers_machined::doc::{
    authors, core,
    disk::{Disk, Recovery, Removal, Swap},
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
    saved_authors: Vec<Option<String>>,
    fail: Option<&'static str>,
    next: u64,
    bases: BTreeMap<u64, Record>,
    swap_race: Option<Vec<u8>>,
}
impl Model {
    fn with(text: &str) -> Self {
        let mut s = Self::default();
        s.files.insert("a.rs".into(), text.as_bytes().to_vec());
        s
    }
    fn step(&mut self, step: &'static str) -> Result<()> {
        self.log.push(step);
        if step == "swap" && matches!(self.fail, Some("metadata" | "other-provider")) {
            return Err(Error::Provider(smithers_machined::hooks::Error {
                code: 3,
                detail: Some(
                    if self.fail == Some("metadata") {
                        "moved-off check required"
                    } else {
                        "another refusal"
                    }
                    .into(),
                ),
                ..smithers_machined::hooks::Error::unsupported()
            }));
        }
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
    fn swap_text(&mut self, path: &str, _: Digest, bytes: &[u8], _: Option<&str>) -> Result<Swap> {
        self.step("swap")?;
        if let Some(outside) = self.swap_race.take() {
            self.files.insert(path.into(), outside);
        }
        let old = self.files.insert(path.into(), bytes.to_vec());
        Ok(Swap {
            displaced: old.map(|old| {
                self.next += 1;
                self.displaced.insert(self.next, old);
                self.bases.insert(
                    self.next,
                    Record::decode(&self.records[&digest(path.as_bytes())]).unwrap(),
                );
                self.next
            }),
            mode: 0o644,
        })
    }
    fn remove_file(&mut self, path: &str, _: Digest, _: Option<&str>) -> Result<Removal> {
        self.step("delete")?;
        if let Some(bytes) = self.swap_race.take() {
            self.files.insert(path.into(), bytes);
        }
        let displaced = self.files.remove(path).map(|old| {
            self.next += 1;
            self.displaced.insert(self.next, old);
            self.bases.insert(
                self.next,
                Record::decode(&self.records[&digest(path.as_bytes())]).unwrap(),
            );
            self.next
        });
        Ok(Removal {
            displaced,
            error: self.step("deleted").err(),
        })
    }
    fn recover_deletions(&mut self) -> Result<Vec<(String, Recovery)>> {
        Ok(self
            .bases
            .iter()
            .filter_map(|(token, record)| {
                record.deleted_path.clone().map(|path| {
                    (
                        path,
                        Recovery {
                            token: *token,
                            record: record.clone(),
                        },
                    )
                })
            })
            .collect())
    }
    fn own_delete(&mut self, _: &str, actor: Option<&str>) -> Result<()> {
        self.step("own_delete")?;
        self.saved_authors.push(actor.map(str::to_owned));
        Ok(())
    }
    fn recover_temps(&mut self, _: &str, _: Digest) -> Result<Vec<Recovery>> {
        Ok(self
            .displaced
            .keys()
            .filter(|token| self.bases[token].deleted_path.is_none())
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
    fn own_write(&mut self, _: &str, _: &[u8], _: u32, actor: Option<&str>) -> Result<()> {
        self.step("own")?;
        self.saved_authors.push(actor.map(str::to_owned));
        Ok(())
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
fn edit<D: Disk>(host: &mut Host<D>, stream: u32, text: &str, now: u64) {
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
    for now in (400..900).step_by(100) {
        edit(&mut h, s, &now.to_string(), now);
        h.tick(now, true).unwrap();
    }
    assert_eq!(h.disk.files["a.rs"], b"b");
    h.tick(900, true).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"800");
}
#[test]
fn saved_notice_follows_record_and_swap_and_failures_never_ack() {
    for fail in ["record", "swap", "displaced", "own"] {
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
    assert_eq!(&bytes[..8], b"SMTHDOC4");
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

#[test]
fn insertions_at_replacement_edges_merge_but_inside_deleted_lines_conflict() {
    for (ours, theirs, expected) in [
        ("A\nb\n", "a\nx\nb\n", "A\nx\nb\n"),
        ("A\nb\n", "x\na\nb\n", "x\nA\nb\n"),
        ("a\nx\nb\n", "A\nb\n", "A\nx\nb\n"),
        ("x\na\nb\n", "A\nb\n", "x\nA\nb\n"),
    ] {
        let merged = merge::merge("a\nb\n", ours, theirs);
        assert!(!merged.overlap);
        assert_eq!(merged.text, expected);
    }
    let merged = merge::merge("a\nb\nc\n", "A\nc\n", "a\nx\nb\nc\n");
    assert!(merged.overlap);
    assert_eq!(merged.text, "A\nc\n");
    assert_eq!(merged.outside, "a\nx\nb\nc\n");
}

#[test]
fn ordinary_and_sticky_permissions_are_preserved_and_set_id_modes_refuse() {
    use smithers_machined::doc::disk::saved_mode;
    assert_eq!(saved_mode(0o100664), Ok(0o664));
    assert_eq!(saved_mode(0o101644), Ok(0o1644));
    for mode in [0o104644, 0o102644, 0o106644] {
        assert_eq!(saved_mode(mode), Err(Error::Unsupported));
    }
}

#[test]
fn rewrite_deletion_pauses_edits_and_capture_until_explicit_restore() {
    let (mut h, s) = host("saved");
    h.flush_all(0).unwrap();
    h.tick(200, true).unwrap();
    h.notices();
    edit(&mut h, s, "unsaved typing", 201);
    h.disk.files.remove("a.rs");
    h.reconcile_all("rebased:Tk", 202).unwrap();
    assert_eq!(h.text(s).unwrap(), "unsaved typing");
    assert_eq!(
        h.projection("a.rs").unwrap().gone,
        Some(Gone::Deleted {
            by: "rebased:Tk".into()
        })
    );
    assert!(matches!(h.notices().last(), Some(Notice::Gone { .. })));
    h.flush_all(203).unwrap();
    h.tick(10000, true).unwrap();
    assert!(!h.disk.files.contains_key("a.rs"));
    h.write_through(
        "a.rs",
        digest(b"unsaved typing"),
        "unsaved typing",
        "alice",
        10001,
    )
    .unwrap();
    h.flush_all(10001).unwrap();
    assert_eq!(h.disk.files["a.rs"], b"unsaved typing");
    assert!(h.projection("a.rs").unwrap().gone.is_none());
}

mod dispatcher {
    use super::*;
    use smithers_machined::{
        conn::{self, Frame},
        doc::service::Service,
        document_payload::Document,
        hooks::{self, Documents},
        lock::LockCx,
        rpc,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };
    use yrs::{
        sync::SyncMessage,
        updates::{decoder::Decode, encoder::Encode},
        ReadTxn,
    };
    #[derive(Clone)]
    struct Shared(Arc<Mutex<Model>>);
    impl Disk for Shared {
        fn read(&mut self, p: &str) -> Result<Option<Vec<u8>>> {
            self.0.lock().unwrap().read(p)
        }
        fn load_record(&mut self, k: Digest) -> Result<Option<Record>> {
            self.0.lock().unwrap().load_record(k)
        }
        fn store_record(&mut self, k: Digest, r: &Record) -> Result<()> {
            self.0.lock().unwrap().store_record(k, r)
        }
        fn swap_text(&mut self, p: &str, k: Digest, b: &[u8], actor: Option<&str>) -> Result<Swap> {
            self.0.lock().unwrap().swap_text(p, k, b, actor)
        }
        fn remove_file(&mut self, p: &str, k: Digest, a: Option<&str>) -> Result<Removal> {
            self.0.lock().unwrap().remove_file(p, k, a)
        }
        fn recover_deletions(&mut self) -> Result<Vec<(String, Recovery)>> {
            self.0.lock().unwrap().recover_deletions()
        }
        fn own_delete(&mut self, p: &str, a: Option<&str>) -> Result<()> {
            self.0.lock().unwrap().own_delete(p, a)
        }
        fn recover_temps(&mut self, p: &str, k: Digest) -> Result<Vec<Recovery>> {
            self.0.lock().unwrap().recover_temps(p, k)
        }
        fn read_displaced(&mut self, t: u64) -> Result<Vec<u8>> {
            self.0.lock().unwrap().read_displaced(t)
        }
        fn remove_displaced(&mut self, t: u64) -> Result<()> {
            self.0.lock().unwrap().remove_displaced(t)
        }
        fn record_outside(&mut self, p: &str, b: &[u8], a: &str) -> Result<String> {
            self.0.lock().unwrap().record_outside(p, b, a)
        }
        fn own_write(
            &mut self,
            p: &str,
            bytes: &[u8],
            mode: u32,
            actor: Option<&str>,
        ) -> Result<()> {
            self.0.lock().unwrap().own_write(p, bytes, mode, actor)
        }
    }
    struct Clock(AtomicU64, std::time::Instant);
    impl hooks::Clock for Clock {
        fn now(&self) -> std::time::SystemTime {
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
        }
        fn mono(&self) -> std::time::Instant {
            self.1 + std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
        }
    }
    fn control(method: u8, fields: &[Vec<u8>]) -> Frame {
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
    fn input(id: u32, seq: u64, actor: &str, message: SyncMessage) -> Frame {
        Frame {
            kind: 4,
            stream: id,
            payload: Document {
                msg: 1,
                seq,
                actor: actor.as_bytes().to_vec(),
                data: message.encode_v1(),
                ..Default::default()
            }
            .encode_v2()
            .unwrap(),
        }
    }
    fn open(cx: &mut LockCx) -> u32 {
        let reply = rpc::dispatch(
            &control(
                13,
                &[
                    conn::field(1, [0, 4, b'a', b'.', b'r', b's']),
                    conn::field(
                        2,
                        conn::actor_bytes(&hooks::Actor::Principal(b"host".to_vec())),
                    ),
                ],
            ),
            cx,
        )
        .unwrap();
        let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
        assert_eq!(result[0], 13);
        u32::from_be_bytes(
            conn::fields("result13", &result[1..]).unwrap()[0]
                .1
                .try_into()
                .unwrap(),
        )
    }
    fn sync(cx: &mut LockCx, id: u32) -> Vec<u8> {
        let reply = rpc::dispatch(
            &input(id, 0, "host", SyncMessage::SyncStep1(Default::default())),
            cx,
        )
        .unwrap();
        let sync = Document::decode_v2(&reply.payload).unwrap();
        let SyncMessage::SyncStep2(state) = SyncMessage::decode_v1(&sync.data).unwrap() else {
            panic!("sync2")
        };
        state
    }
    #[test]
    fn rpc_presence_and_updates_reach_other_document_streams() {
        let (_, _, service, mut cx, id, epoch) = setup();
        let other = open(&mut cx);
        service.poll(&mut cx).unwrap();
        let state = sync(&mut cx, id);
        let doc = core::document(Some(epoch.client_id as u64));
        doc.get_or_insert_text("content");
        doc.get_or_insert_map("authors");
        core::apply(&doc, core::decode(&state).unwrap()).unwrap();
        let sv = doc.transact().state_vector();
        doc.get_or_insert_text("content")
            .insert(&mut doc.transact_mut(), 3, "!");
        let bytes = doc.transact().encode_state_as_update_v1(&sv);
        rpc::dispatch(&input(id, 1, "host", SyncMessage::Update(bytes)), &mut cx).unwrap();
        let frames = service.poll(&mut cx).unwrap();
        assert!(frames
            .iter()
            .any(|f| f.stream == other && Document::decode_v2(&f.payload).unwrap().msg == 3));
        let presence = |clock, json: &str| {
            let update = yrs::sync::AwarenessUpdate {
                clients: [(
                    yrs::ClientID::new(epoch.client_id as u64),
                    yrs::sync::awareness::AwarenessUpdateEntry {
                        clock,
                        json: json.into(),
                    },
                )]
                .into_iter()
                .collect(),
            };
            Frame {
                kind: 4,
                stream: id,
                payload: Document {
                    msg: 2,
                    actor: b"host".to_vec(),
                    data: update.encode_v1(),
                    ..Default::default()
                }
                .encode_v2()
                .unwrap(),
            }
        };
        let json = r##"{"actor":{"id":"686f7374","kind":"person","via":"app"},"colour":"#123456","line":{"path":"a.rs","line":2}}"##;
        let browser = r##"{"actor":{"id":"686f7374","kind":"person","via":"app"},"colour":"#123456","line":2,"anchor":{"tname":"content","item":{"client":7,"clock":1},"assoc":0},"head":{"tname":"content","assoc":0}}"##;
        let accepted_browser = rpc::dispatch(&presence(0, browser), &mut cx).unwrap();
        let frame = Document::decode_v2(&accepted_browser.payload).unwrap();
        let update = yrs::sync::AwarenessUpdate::decode_v1(&frame.data).unwrap();
        assert_eq!(
            update.clients.values().next().unwrap().json.as_ref(),
            browser
        );
        for invalid in [
            browser.replace("\"line\":2", "\"line\":0"),
            browser.replace("\"assoc\":0", "\"sudo\":true"),
            browser.replace("\"client\":7", "\"client\":-1"),
            browser.replace("686f7374", "forged"),
        ] {
            let refused = rpc::dispatch(&presence(1, &invalid), &mut cx).unwrap();
            assert_eq!(refused.payload[0], 255);
        }
        let accepted = rpc::dispatch(&presence(1, json), &mut cx).unwrap();
        assert_eq!(Document::decode_v2(&accepted.payload).unwrap().msg, 4);
        assert_eq!(service.projections(&mut cx).unwrap()[0].editors[0].line, 2);
        assert!(service
            .poll(&mut cx)
            .unwrap()
            .iter()
            .any(|f| f.stream == other && Document::decode_v2(&f.payload).unwrap().msg == 4));
        for invalid in [
            json.replace("686f7374", "616c696365"),
            json.replace("a.rs", "elsewhere.rs"),
            json.replace("\"line\":2", "\"line\":0"),
            json.replace("\"colour\"", "\"cursor\""),
        ] {
            let response = rpc::dispatch(&presence(2, &invalid), &mut cx).unwrap();
            assert_eq!(response.payload[0], 255);
            assert_eq!(service.projections(&mut cx).unwrap()[0].editors[0].line, 2);
        }
        let cleared = rpc::dispatch(&presence(2, "null"), &mut cx).unwrap();
        assert_eq!(Document::decode_v2(&cleared.payload).unwrap().msg, 4);
        assert!(service.projections(&mut cx).unwrap()[0].editors.is_empty());
        assert_eq!(
            Document::decode_v2(&rpc::dispatch(&presence(1, json), &mut cx).unwrap().payload)
                .unwrap()
                .msg,
            4
        );
        assert!(service.projections(&mut cx).unwrap()[0].editors.is_empty());
        rpc::dispatch(&presence(3, json), &mut cx).unwrap();
        service.poll(&mut cx).unwrap();
        let closed =
            rpc::dispatch(&control(14, &[conn::field(1, id.to_be_bytes())]), &mut cx).unwrap();
        assert_ne!(closed.payload[0], 255);
        assert!(service.projections(&mut cx).unwrap()[0].editors.is_empty());
        let frames = service.poll(&mut cx).unwrap();
        assert!(!frames.iter().any(|f| f.stream == id));
        let removals: Vec<_> = frames
            .iter()
            .filter_map(|f| {
                let d = Document::decode_v2(&f.payload).unwrap();
                (f.stream == other && d.msg == 4).then_some(d)
            })
            .collect();
        assert_eq!(removals.len(), 1);
        let removal = yrs::sync::AwarenessUpdate::decode_v1(&removals[0].data).unwrap();
        assert_eq!(removal.clients.len(), 1);
        let entry = &removal.clients[&yrs::ClientID::new(epoch.client_id as u64)];
        assert_eq!(entry.clock, 4);
        assert_eq!(entry.json.as_ref(), "null");
        assert!(service.poll(&mut cx).unwrap().is_empty());
    }

    fn setup() -> (
        Shared,
        Arc<Clock>,
        Arc<Service<Shared>>,
        LockCx,
        u32,
        Document,
    ) {
        let disk = Shared(Arc::new(Mutex::new(Model::with("abc"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Arc::new(Service::new(
            Host::new(disk.clone(), gates(), ids()),
            clock.clone(),
        ));
        let mut cx = LockCx::new(hooks::Hooks {
            documents: service.clone(),
            clock: clock.clone(),
            ..Default::default()
        });
        let id = open(&mut cx);
        let output = service.poll(&mut cx).unwrap();
        let epoch = Document::decode_v2(&output[0].payload).unwrap();
        (disk, clock, service, cx, id, epoch)
    }
    #[test]
    #[allow(non_snake_case)]
    fn DocumentDispatchFailsClosed() {
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
            let disk = Shared(Arc::new(Mutex::new(Model::with("abc"))));
            let mut g = gates();
            disable(&mut g);
            let service = Arc::new(Service::new(
                Host::new(disk.clone(), g, ids()),
                Arc::new(hooks::SystemClock),
            ));
            let mut cx = LockCx::new(hooks::Hooks {
                documents: service.clone(),
                ..Default::default()
            });
            let request = control(
                13,
                &[
                    conn::field(1, [0, 4, b'a', b'.', b'r', b's']),
                    conn::field(
                        2,
                        conn::actor_bytes(&hooks::Actor::Principal(b"host".to_vec())),
                    ),
                ],
            );
            let reply = rpc::dispatch(&request, &mut cx).unwrap();
            let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
            assert_eq!(result, &[255, 0, 0, 0, 2, 1, 2]);
            let reply = rpc::dispatch(
                &input(1, 1, "host", SyncMessage::Update(vec![0, 0])),
                &mut cx,
            )
            .unwrap();
            assert_eq!(reply.payload[0], 255);
            assert_eq!(service.flush_all(&mut cx).unwrap_err().code, 2);
            assert_eq!(
                service
                    .write_through(
                        &mut cx,
                        "a.rs",
                        &hooks::Base::Digest(digest(b"abc")),
                        b"changed",
                        &hooks::Actor::Outside
                    )
                    .unwrap()
                    .unwrap_err()
                    .code,
                2
            );
            assert!(service.poll(&mut cx).is_err());
            let disk = disk.0.lock().unwrap();
            assert!(disk.log.is_empty());
            assert!(disk.records.is_empty());
            assert_eq!(disk.files["a.rs"], b"abc");
        }
    }
    #[test]
    fn metadata_guard_retries_without_losing_stream_or_acknowledging_unsaved_bytes() {
        for fault in ["metadata", "other-provider", "swap"] {
            let (disk, clock, service, mut cx, id, epoch) = setup();
            let peer = editor(&sync(&mut cx, id), epoch.client_id as u64);
            let before = peer.transact().state_vector();
            peer.get_or_insert_text("content")
                .insert(&mut peer.transact_mut(), 3, " pending");
            let update = peer.transact().encode_state_as_update_v1(&before);
            assert_eq!(
                rpc::dispatch(&input(id, 1, "host", SyncMessage::Update(update)), &mut cx)
                    .unwrap()
                    .payload[0],
                3
            );
            disk.0.lock().unwrap().fail = Some(fault);
            clock.0.store(200, Ordering::Relaxed);
            let result = service.poll(&mut cx);
            if fault == "metadata" {
                let frames = result.unwrap();
                assert!(frames
                    .iter()
                    .all(|frame| Document::decode_v2(&frame.payload).unwrap().msg != 6));
                assert!(service.poll(&mut cx).unwrap().is_empty());
            } else {
                assert!(result.is_err(), "other failures must remain visible");
            }
            assert!(!service.all_flushed());
            assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"abc");
            disk.0.lock().unwrap().fail = None;
            let frames = service.poll(&mut cx).unwrap();
            let saved = frames
                .iter()
                .map(|frame| Document::decode_v2(&frame.payload).unwrap())
                .find(|frame| frame.msg == 6)
                .unwrap();
            assert_eq!(saved.through_seq, 1);
            assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"abc pending");
            clock.0.store(400, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
            assert!(service.all_flushed());
        }
    }

    #[test]
    fn dispatch_faults_withhold_receipts_and_restart_recovers_same_epoch() {
        for fault in ["record", "swap", "displaced", "own"] {
            let (disk, clock, service, mut cx, id, epoch) = setup();
            let peer = editor(&sync(&mut cx, id), epoch.client_id as u64);
            let before = peer.transact().state_vector();
            peer.get_or_insert_text("content")
                .insert(&mut peer.transact_mut(), 3, " 🦀");
            let update = peer.transact().encode_state_as_update_v1(&before);
            assert_eq!(
                rpc::dispatch(
                    &input(id, 1, "host", SyncMessage::Update(update.clone())),
                    &mut cx
                )
                .unwrap()
                .payload[0],
                3
            );
            disk.0.lock().unwrap().fail = Some(fault);
            clock.0.store(200, Ordering::Relaxed);
            assert!(service.poll(&mut cx).is_err());
            assert!(!service.all_flushed());
            disk.0.lock().unwrap().fail = None;
            let outputs = service.poll(&mut cx).unwrap();
            let saved = outputs
                .iter()
                .map(|f| Document::decode_v2(&f.payload).unwrap())
                .find(|d| d.msg == 6)
                .unwrap();
            assert_eq!(saved.through_seq, 1);
            assert_eq!(disk.0.lock().unwrap().files["a.rs"], "abc 🦀".as_bytes());
            drop(cx);
            drop(service);
            let recovered = Arc::new(Service::new(Host::new(disk.clone(), gates(), ids()), clock));
            let mut cx = LockCx::new(hooks::Hooks {
                documents: recovered.clone(),
                ..Default::default()
            });
            let id = open(&mut cx);
            let outputs = recovered.poll(&mut cx).unwrap();
            let reopened = Document::decode_v2(&outputs[0].payload).unwrap();
            assert_eq!(reopened.epoch, epoch.epoch);
            assert_eq!(
                rpc::dispatch(&input(id, 1, "host", SyncMessage::Update(update)), &mut cx)
                    .unwrap()
                    .payload[0],
                3
            );
            let doc = editor(&sync(&mut cx, id), 999);
            assert_eq!(
                doc.get_or_insert_text("content")
                    .get_string(&doc.transact()),
                "abc 🦀"
            );
            assert_eq!(
                authors::entries(&doc).unwrap()[&epoch.client_id.to_string()],
                "686f7374"
            );
        }
    }
    #[test]
    fn protocol_five_keeps_retained_text_author_records_without_relabeling() {
        let (mut legacy, stream) = host("abc");
        let original = legacy.client(stream, "686f7374", 0).unwrap();
        legacy.flush_all(0).unwrap();
        // Independent retained-v1 layout: no retired-client trailer existed.
        let raw = legacy.disk.records.get_mut(&digest(b"a.rs")).unwrap();
        raw.truncate(raw.len() - 39); // empty v4 count + presence + path length + checksum
        raw[..8].copy_from_slice(b"SMTHDOC1");
        raw.extend(digest(raw));
        let disk = Shared(Arc::new(Mutex::new(legacy.disk.clone())));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Arc::new(Service::new(
            Host::new(disk.clone(), gates(), ids()),
            clock.clone(),
        ));
        let mut cx = LockCx::new(hooks::Hooks {
            documents: service.clone(),
            clock,
            ..Default::default()
        });
        let id = open(&mut cx);
        let output = service.poll(&mut cx).unwrap();
        let epoch = Document::decode_v2(&output[0].payload).unwrap();
        assert_ne!(u64::from(epoch.client_id), original);
        let doc = editor(&sync(&mut cx, id), 3333);
        let retained = authors::entries(&doc).unwrap();
        assert_eq!(retained[&original.to_string()], "686f7374");
        assert_eq!(retained[&epoch.client_id.to_string()], "686f7374");
        // Matching text from a historical principal must not grant its old
        // client clock to a different principal whose new key has that text.
        let forged = editor(&sync(&mut cx, id), original);
        let before = forged.transact().state_vector();
        forged
            .get_or_insert_text("content")
            .push(&mut forged.transact_mut(), "forged");
        let update = forged.transact().encode_state_as_update_v1(&before);
        assert_eq!(
            rpc::dispatch(
                &input(id, 1, "host", SyncMessage::Update(update.clone())),
                &mut cx
            )
            .unwrap()
            .payload[0],
            255
        );
        service.flush_all(&mut cx).unwrap();
        let persisted = Record::decode(&disk.0.lock().unwrap().records[&digest(b"a.rs")]).unwrap();
        assert!(persisted.retired_clients.contains(&original));
        assert!(!persisted
            .retired_clients
            .contains(&u64::from(epoch.client_id)));
        let mut malformed = persisted.clone();
        malformed.retired_clients.insert(u64::MAX);
        assert!(Record::decode(&malformed.encode().unwrap()).is_err());
        let mut reopened = Host::new(disk.clone(), gates(), ids());
        let reopened_stream = reopened.open("a.rs", [9; 16], 1).unwrap();
        assert_eq!(
            reopened.peer_update(reopened_stream, "686f7374", &update, 1),
            Err(Error::Forged)
        );
        assert_eq!(
            reopened.peer_awareness(
                reopened_stream,
                original,
                "686f7374",
                "#123456",
                Some(("a.rs", 1))
            ),
            Err(Error::Forged)
        );
        let restored = persisted.document().unwrap();
        assert_ne!(
            authors::allocate_current(&restored, "686f7374", &persisted.retired_clients).unwrap(),
            original
        );

        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            "abc"
        );
    }
    #[test]
    fn binary_principal_survives_document_dispatch_and_saved_author_reopen() {
        let (disk, clock, _initial, mut cx, _, _) = setup();
        let principal = vec![0x00, 0xff, 0x80, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
        let service = Arc::new(Service::new(
            Host::new(disk.clone(), gates(), ids()),
            clock.clone(),
        ));
        cx.hooks.documents = service.clone();
        let reply = rpc::dispatch(
            &control(
                13,
                &[
                    conn::field(1, [0, 4, b'a', b'.', b'r', b's']),
                    conn::field(
                        2,
                        conn::actor_bytes(&hooks::Actor::Principal(principal.clone())),
                    ),
                ],
            ),
            &mut cx,
        )
        .unwrap();
        let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
        assert_eq!(result[0], 13);
        let id = u32::from_be_bytes(
            conn::fields("result13", &result[1..]).unwrap()[0]
                .1
                .try_into()
                .unwrap(),
        );
        let output = service.poll(&mut cx).unwrap();
        let epoch = Document::decode_v2(&output[0].payload).unwrap();
        let doc = editor(&sync(&mut cx, id), epoch.client_id as u64);
        let key = "00ff800102030405060708090a0b0c0d";
        assert_eq!(
            authors::entries(&doc).unwrap()[&epoch.client_id.to_string()],
            key
        );
        let before = doc.transact().state_vector();
        doc.get_or_insert_text("content")
            .push(&mut doc.transact_mut(), "!");
        let update = doc.transact().encode_state_as_update_v1(&before);
        let packet = |by: Vec<u8>| Frame {
            kind: 4,
            stream: id,
            payload: Document {
                msg: 1,
                seq: 1,
                actor: by,
                data: SyncMessage::Update(update.clone()).encode_v1(),
                ..Default::default()
            }
            .encode_v2()
            .unwrap(),
        };
        // Distinct invalid UTF-8 references cannot collapse into a replacement
        // character and acquire one another's CRDT client id.
        let mut other = principal.clone();
        other[1] = 0xfe;
        assert_eq!(
            rpc::dispatch(&packet(other), &mut cx).unwrap().payload[0],
            255
        );
        assert_eq!(
            rpc::dispatch(&packet(principal), &mut cx).unwrap().payload[0],
            3
        );
        service.flush_all(&mut cx).unwrap();
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"abc!");
        let recovered = Arc::new(Service::new(Host::new(disk, gates(), ids()), clock));
        cx.hooks.documents = recovered.clone();
        let next = open(&mut cx);
        let saved = editor(&sync(&mut cx, next), 8888);
        assert_eq!(
            authors::entries(&saved).unwrap()[&epoch.client_id.to_string()],
            key
        );
    }
    #[test]
    fn yjs_two_clients_converge_through_dispatch_after_1000_concurrent_edits() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let (disk, _clock, service, mut cx, id, epoch) = setup();
        let host = editor(&sync(&mut cx, id), epoch.client_id as u64);
        for (seq, (client, actor, key)) in [(4242, "alice", "616c696365"), (4243, "bob", "626f62")]
            .into_iter()
            .enumerate()
        {
            let before = host.transact().state_vector();
            host.get_or_insert_map("authors").insert(
                &mut host.transact_mut(),
                client.to_string(),
                key,
            );
            let update = host.transact().encode_state_as_update_v1(&before);
            assert_eq!(
                rpc::dispatch(
                    &input(id, seq as u64 + 1, actor, SyncMessage::Update(update)),
                    &mut cx
                )
                .unwrap()
                .payload[0],
                3
            );
        }
        service.flush_all(&mut cx).unwrap();
        service.poll(&mut cx).unwrap();
        let mut child = Command::new("bun")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/yjs-interop.ts"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Bun and app Yjs dependency required");
        let mut to_client = child.stdin.take().unwrap();
        writeln!(
            to_client,
            "{}",
            serde_json::json!({"state": STANDARD.encode(sync(&mut cx, id))})
        )
        .unwrap();
        let from_client = BufReader::new(child.stdout.take().unwrap());
        let mut updates = 0;
        let mut done = false;
        for line in from_client.lines() {
            let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            if request["done"].as_u64() == Some(1000) {
                assert_eq!(
                    request["text"].as_str().unwrap().as_bytes(),
                    disk.0.lock().unwrap().files["a.rs"]
                );
                done = true;
                break;
            }
            let seq = request["seq"].as_u64().unwrap();
            let actor = request["actor"].as_str().unwrap();
            let update = STANDARD
                .decode(request["update"].as_str().unwrap())
                .unwrap();
            let reply = rpc::dispatch(&input(id, seq, actor, SyncMessage::Update(update)), &mut cx)
                .unwrap();
            assert_eq!(reply.payload[0], 3, "interop update {seq}");
            service.flush_all(&mut cx).unwrap();
            let frames = service.poll(&mut cx).unwrap();
            let saved = frames
                .iter()
                .map(|f| Document::decode_v2(&f.payload).unwrap())
                .find(|d| d.msg == 6)
                .unwrap();
            assert_eq!(saved.through_seq, seq);
            let text = String::from_utf8(disk.0.lock().unwrap().files["a.rs"].clone()).unwrap();
            writeln!(to_client, "{}", serde_json::json!({"state": STANDARD.encode(sync(&mut cx, id)), "text": text, "saved": saved.through_seq})).unwrap();
            updates += 1;
        }
        assert!(child.wait().unwrap().success());
        assert!(done);
        assert_eq!(updates, 1020); // 1,000 edits + 20 transport retries.
    }
    #[test]
    fn oversized_outside_event_never_records_a_bounded_prefix_as_a_version() {
        let (disk, _, service, mut cx, id, _) = setup();
        service.flush_all(&mut cx).unwrap();
        service.poll(&mut cx).unwrap();
        disk.0
            .lock()
            .unwrap()
            .files
            .insert("a.rs".into(), vec![b'x'; (1 << 20) + 1]);
        assert_eq!(
            service
                .completed_write(&mut cx, "a.rs", &hooks::Actor::Outside)
                .unwrap_err()
                .code,
            7
        );
        assert!(disk.0.lock().unwrap().versions.is_empty());
        let doc = editor(&sync(&mut cx, id), 999);
        assert_eq!(
            doc.get_or_insert_text("content")
                .get_string(&doc.transact()),
            "abc"
        );
        assert_eq!(disk.0.lock().unwrap().files["a.rs"].len(), (1 << 20) + 1);
    }
    #[test]
    fn dispatcher_rewrites_flush_typing_then_reconcile_disk_before_thaw() {
        struct Rewrite {
            disk: Shared,
            calls: Mutex<Vec<&'static str>>,
        }
        impl hooks::Watcher for Rewrite {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
            fn drain(&self, _: &mut LockCx) -> hooks::Result<()> {
                self.calls.lock().unwrap().push("drain");
                Ok(())
            }
            fn close_bursts(&self, _: &mut LockCx) -> hooks::Result<()> {
                self.calls.lock().unwrap().push("bursts");
                Ok(())
            }
        }
        impl hooks::Broker for Rewrite {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
            fn freeze(&self, _: std::time::Duration) -> hooks::Result<Option<u32>> {
                self.calls.lock().unwrap().push("freeze");
                Ok(None)
            }
            fn thaw(&self) -> hooks::Result<()> {
                self.calls.lock().unwrap().push("thaw");
                Ok(())
            }
        }
        impl hooks::Core for Rewrite {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
            fn validate_rebase(&self, onto: [u8; 20]) -> hooks::Result<()> {
                assert_eq!(onto, [17; 20]);
                Ok(())
            }
            fn validate_return_to_item(&self) -> hooks::Result<()> {
                Ok(())
            }
            fn return_to_item(&self, cx: &mut LockCx) -> hooks::Result<[u8; 20]> {
                self.rebase(cx, [17; 20])
            }
            fn capture_local(&self, _: &mut LockCx) -> hooks::Result<()> {
                assert_eq!(self.disk.0.lock().unwrap().files["a.rs"], b"abc typing");
                self.calls.lock().unwrap().push("capture");
                Ok(())
            }
            fn rebase(&self, _: &mut LockCx, _: [u8; 20]) -> hooks::Result<[u8; 20]> {
                self.calls.lock().unwrap().push("rewrite");
                self.disk
                    .0
                    .lock()
                    .unwrap()
                    .files
                    .insert("a.rs".into(), b"abc typing\nrebased\n".to_vec());
                Ok([34; 20])
            }
        }
        // Return now rechecks the full provider set before freezing. These
        // are explicit component-test providers, never installed readiness
        // or confinement evidence; their unused operations remain unsupported.
        impl hooks::Sessions for Rewrite {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
        }
        impl hooks::EventSink for Rewrite {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
        }
        for method in [11, 12] {
            let (disk, _, service, mut cx, id, epoch) = setup();
            let peer = editor(&sync(&mut cx, id), epoch.client_id as u64);
            let before = peer.transact().state_vector();
            peer.get_or_insert_text("content")
                .insert(&mut peer.transact_mut(), 3, " typing");
            assert_eq!(
                rpc::dispatch(
                    &input(
                        id,
                        1,
                        "host",
                        SyncMessage::Update(peer.transact().encode_state_as_update_v1(&before))
                    ),
                    &mut cx
                )
                .unwrap()
                .payload[0],
                3
            );
            let rewrite = Arc::new(Rewrite {
                disk: disk.clone(),
                calls: Mutex::new(vec![]),
            });
            cx.hooks.watcher = rewrite.clone();
            cx.hooks.core = rewrite.clone();
            cx.hooks.broker = rewrite.clone();
            let mut fields = vec![];
            if method == 11 {
                fields.push(conn::field(1, [17; 20]));
            }
            fields.push(conn::field(
                if method == 11 { 2 } else { 1 },
                conn::actor_bytes(&hooks::Actor::Principal(b"Rebased onto T2".to_vec())),
            ));
            if method == 12 {
                let refused = rpc::dispatch(&control(method, &fields), &mut cx).unwrap();
                let result = conn::fields("response", &refused.payload[1..]).unwrap()[1].1;
                assert_eq!(result[0], 255, "missing session/event providers refuse Return");
                assert!(rewrite.calls.lock().unwrap().is_empty());
                assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"abc");
            }
            cx.hooks.sessions = rewrite.clone();
            cx.hooks.events = rewrite.clone();
            let reply = rpc::dispatch(&control(method, &fields), &mut cx).unwrap();
            let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
            assert_eq!(result[0], method);
            assert_eq!(
                *rewrite.calls.lock().unwrap(),
                ["freeze", "drain", "bursts", "capture", "rewrite", "thaw"]
            );
            assert!(!cx.rewrite_pending);
            let doc = editor(&sync(&mut cx, id), 999);
            assert_eq!(
                doc.get_or_insert_text("content")
                    .get_string(&doc.transact()),
                "abc typing\nrebased\n"
            );
            assert!(authors::entries(&doc)
                .unwrap()
                .values()
                .any(|actor| actor == "52656261736564206f6e746f205432"));
            let frames = service.poll(&mut cx).unwrap();
            assert!(frames
                .iter()
                .any(|frame| Document::decode_v2(&frame.payload).unwrap().msg == 3));
            service.flush_all(&mut cx).unwrap();
            assert_eq!(
                disk.0.lock().unwrap().files["a.rs"],
                b"abc typing\nrebased\n"
            );
        }
    }
    #[test]
    fn stream_receipts_do_not_consume_branch_file_saved_or_gone_notices() {
        let (disk, clock, service, mut cx, _, _) = setup();
        clock.0.store(200, Ordering::Relaxed);
        let frames = service.poll(&mut cx).unwrap();
        assert!(frames
            .iter()
            .any(|f| Document::decode_v2(&f.payload).unwrap().msg == 6));
        let projection = service.projections(&mut cx).unwrap();
        assert_eq!(projection.len(), 1);
        assert_eq!(projection[0].saved_digest, digest(b"abc"));
        assert_eq!(projection[0].saved_at_ms, Some(200));
        assert!(service.take_notices(&mut cx).unwrap().iter().any(|n| matches!(n, Notice::Saved { path, digest: value, .. } if path == "a.rs" && *value == digest(b"abc"))));
        assert!(service.take_notices(&mut cx).unwrap().is_empty());
        disk.0.lock().unwrap().files.remove("a.rs");
        service
            .completed_write(&mut cx, "a.rs", &hooks::Actor::Outside)
            .unwrap();
        assert!(service
            .poll(&mut cx)
            .unwrap()
            .iter()
            .any(|f| Document::decode_v2(&f.payload).unwrap().gone_kind == 1));
        assert!(matches!(
            service.projections(&mut cx).unwrap()[0].gone,
            Some(Gone::Deleted { .. })
        ));
        assert!(service
            .take_notices(&mut cx)
            .unwrap()
            .iter()
            .any(|n| matches!(n, Notice::Gone { .. })));
    }
    #[test]
    fn unopened_text_write_compares_creates_and_reports_displaced_bytes() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock);
        let mut cx = LockCx::new(Default::default());
        let stale = service
            .write_through(
                &mut cx,
                "a.rs",
                &hooks::Base::Digest(digest(b"stale")),
                b"tool",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(stale.code, 4);
        assert_eq!(stale.current_digest, Some(digest(b"before")));
        assert!(disk.0.lock().unwrap().records.is_empty());
        disk.0.lock().unwrap().swap_race = Some(b"outside in swap".to_vec());
        let applied = service
            .write_through(
                &mut cx,
                "a.rs",
                &hooks::Base::Digest(digest(b"before")),
                b"tool",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap();
        assert_eq!(applied.digest, Some(digest(b"tool")));
        assert_eq!(applied.raced, Some(digest(b"outside in swap")));
        assert!(disk
            .0
            .lock()
            .unwrap()
            .versions
            .contains(&b"outside in swap".to_vec()));
        let created = service
            .write_through(
                &mut cx,
                "new.rs",
                &hooks::Base::Absent,
                b"new",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap();
        assert_eq!(created.digest, Some(digest(b"new")));
        assert_eq!(created.raced, None);
        assert_eq!(disk.0.lock().unwrap().files["new.rs"], b"new");
        let bad = service
            .write_through(
                &mut cx,
                "../escape",
                &hooks::Base::Absent,
                b"new",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(bad.code, 1);
        assert!(!disk.0.lock().unwrap().files.contains_key("../escape"));
    }
    #[test]
    fn refused_actor_never_admits_a_document_or_creates_a_file_later() {
        for path in ["a.rs", "new.rs"] {
            for actor_bytes in [vec![], vec![7; 1025]] {
                let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
                let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
                let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
                let mut cx = LockCx::new(Default::default());
                let base = if path == "a.rs" {
                    hooks::Base::Digest(digest(b"before"))
                } else {
                    hooks::Base::Absent
                };
                let error = service
                    .write_through(
                        &mut cx,
                        path,
                        &base,
                        b"refused",
                        &hooks::Actor::Principal(actor_bytes),
                    )
                    .unwrap()
                    .unwrap_err();
                assert_eq!(error.code, 1);
                for now in [200, 2000, 60_001] {
                    clock.0.store(now, Ordering::Relaxed);
                    assert!(service.poll(&mut cx).unwrap().is_empty());
                    assert_eq!(service.flush_all(&mut cx).unwrap(), 0);
                }
                assert!(service.projections(&mut cx).unwrap().is_empty());
                assert!(service.take_notices(&mut cx).unwrap().is_empty());
                let disk = disk.0.lock().unwrap();
                assert_eq!(disk.files, Model::with("before").files);
                assert!(disk.records.is_empty());
                assert!(disk.versions.is_empty());
                assert!(
                    disk.log.is_empty(),
                    "identity must fail before disk admission"
                );
            }
        }
    }

    #[test]
    fn stale_interrupted_save_refusal_does_not_start_background_recovery() {
        let (mut host, stream) = host("before");
        edit(&mut host, stream, "previous pending save", 0);
        host.disk.fail = Some("swap");
        assert!(host.flush_all(1).is_err());
        host.disk.fail = None;
        let records = host.disk.records.clone();
        let disk = Shared(Arc::new(Mutex::new(host.disk)));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let error = service
            .write_through(
                &mut cx,
                "a.rs",
                &hooks::Base::Digest(digest(b"before")),
                b"refused",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, 4);
        assert_eq!(error.current_digest, Some(digest(b"previous pending save")));
        for now in [200, 2000, 60_001] {
            clock.0.store(now, Ordering::Relaxed);
            assert!(service.poll(&mut cx).unwrap().is_empty());
            assert_eq!(service.flush_all(&mut cx).unwrap(), 0);
        }
        assert!(service.projections(&mut cx).unwrap().is_empty());
        assert!(service.take_notices(&mut cx).unwrap().is_empty());
        {
            let disk = disk.0.lock().unwrap();
            assert_eq!(disk.files["a.rs"], b"before");
            assert_eq!(disk.records, records);
            assert!(disk.versions.is_empty());
        }
        // The refusal must not discard durable recovery. An explicit document
        // open recovers the previous intent, with its original epoch intact.
        let stream = service.open_authenticated("a.rs", b"host").unwrap();
        service.flush_all(&mut cx).unwrap();
        assert_eq!(
            disk.0.lock().unwrap().files["a.rs"],
            b"previous pending save"
        );
        service.close(stream).unwrap();
    }

    #[test]
    fn refused_binary_or_oversize_write_does_not_admit_a_readonly_document() {
        for bytes in [
            vec![255, 0],
            vec![b'x'; 1 + smithers_machined::doc::MAX_TEXT_BYTES],
        ] {
            let mut model = Model::default();
            model.files.insert("a.rs".into(), bytes.clone());
            let disk = Shared(Arc::new(Mutex::new(model)));
            let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
            let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
            let mut cx = LockCx::new(Default::default());
            let error = service
                .write_through(
                    &mut cx,
                    "a.rs",
                    &hooks::Base::Digest(digest(&bytes)),
                    b"refused",
                    &hooks::Actor::Outside,
                )
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, 7);
            clock.0.store(60_001, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
            assert!(service.projections(&mut cx).unwrap().is_empty());
            let disk = disk.0.lock().unwrap();
            assert_eq!(disk.files["a.rs"], bytes);
            assert!(disk.records.is_empty());
            assert!(disk.versions.is_empty());
        }
    }

    #[test]
    fn closed_document_with_a_completed_outside_save_remains_writable() {
        let (mut host, _) = host("before");
        host.flush_all(0).unwrap();
        host.tick(200, true).unwrap();
        host.disk.files.insert("a.rs".into(), b"outside".to_vec());
        let disk = Shared(Arc::new(Mutex::new(host.disk)));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let written = service
            .write_through(
                &mut cx,
                "a.rs",
                &hooks::Base::Digest(digest(b"outside")),
                b"tool",
                &hooks::Actor::Outside,
            )
            .unwrap()
            .unwrap();
        assert_eq!(written.digest, Some(digest(b"tool")));
        assert_eq!(written.raced, None);
        service.take_notices(&mut cx).unwrap();
        let versions = disk.0.lock().unwrap().versions.clone();
        for now in [200, 2000, 60_001] {
            clock.0.store(now, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
        }
        assert!(!service
            .take_notices(&mut cx)
            .unwrap()
            .iter()
            .any(|n| matches!(n, Notice::Outside { .. })));
        let disk = disk.0.lock().unwrap();
        assert_eq!(disk.files["a.rs"], b"tool");
        assert!(disk.versions.contains(&b"outside".to_vec()));
        assert_eq!(disk.versions, versions);
    }

    fn change(path: &str, base: Option<&[u8]>, content: &[u8]) -> hooks::FileWrite {
        hooks::FileWrite {
            path: path.into(),
            base: base
                .map(|b| hooks::Base::Digest(digest(b)))
                .unwrap_or(hooks::Base::Absent),
            content: Some(content.into()),
        }
    }
    fn deletion(path: &str, base: Option<&[u8]>) -> hooks::FileWrite {
        let mut request = change(path, base, b"");
        request.content = None;
        request
    }
    #[test]
    fn moves_compare_both_paths_before_deleting_or_creating() {
        for stale in 0..2 {
            let disk = Shared(Arc::new(Mutex::new(Model::with("source"))));
            let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
            let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
            let mut cx = LockCx::new(Default::default());
            let mut changes = vec![
                deletion("a.rs", Some(b"source")),
                change("b.rs", None, b"source"),
            ];
            changes[stale].base = hooks::Base::Digest(digest(b"stale"));
            let result = service
                .write_batch(&mut cx, &changes, &hooks::Actor::Outside)
                .unwrap();
            assert!(result.writes.is_empty());
            let failure = result.failure.unwrap();
            assert_eq!(
                (failure.index, failure.preflight, failure.error.code),
                (stale, true, 4)
            );
            clock.0.store(60_001, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
            let model = disk.0.lock().unwrap();
            assert_eq!(model.files, Model::with("source").files);
            assert!(
                model.records.is_empty() && model.displaced.is_empty() && model.versions.is_empty()
            );
        }
    }
    #[test]
    fn move_delete_and_empty_create_have_distinct_durable_receipts() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("source"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let result = service
            .write_batch(
                &mut cx,
                &[
                    deletion("a.rs", Some(b"source")),
                    change("b.rs", None, b"source"),
                    change("empty", None, b""),
                ],
                &hooks::Actor::Principal(b"alice".to_vec()),
            )
            .unwrap();
        assert!(result.failure.is_none());
        assert_eq!(
            result.writes.iter().map(|r| r.digest).collect::<Vec<_>>(),
            vec![None, Some(digest(b"source")), Some(digest(b""))]
        );
        for now in [200, 2000, 60_001] {
            clock.0.store(now, Ordering::Relaxed);
            service.poll(&mut cx).unwrap();
        }
        let model = disk.0.lock().unwrap();
        assert!(!model.files.contains_key("a.rs"));
        assert_eq!(model.files["b.rs"], b"source");
        assert_eq!(model.files["empty"], b"");
        assert_eq!(model.saved_authors, vec![Some("616c696365".into()); 3]);
        assert!(model.displaced.is_empty());
    }
    #[test]
    fn batch_stale_at_every_position_leaves_all_files_records_and_timers_unchanged() {
        for stale in 0..3 {
            let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
            let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
            let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
            let mut cx = LockCx::new(Default::default());
            let mut changes = vec![
                change("a.rs", Some(b"before"), b"after"),
                change("b.rs", None, b"b"),
                change("c.rs", None, b"c"),
            ];
            changes[stale].base = hooks::Base::Digest(digest(b"wrong"));
            let result = service
                .write_batch(&mut cx, &changes, &hooks::Actor::Outside)
                .unwrap();
            assert!(result.writes.is_empty());
            let failure = result.failure.unwrap();
            assert_eq!(
                (failure.index, failure.preflight, failure.error.code),
                (stale, true, 4)
            );
            for now in [200, 2000, 60_001] {
                clock.0.store(now, Ordering::Relaxed);
                service.poll(&mut cx).unwrap();
            }
            assert!(service.projections(&mut cx).unwrap().is_empty());
            let disk = disk.0.lock().unwrap();
            assert_eq!(disk.files, Model::with("before").files);
            assert!(disk.records.is_empty());
            assert!(disk.versions.is_empty());
        }
    }
    #[test]
    fn closed_file_save_compares_completed_outside_bytes_before_cached_text() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let first = service
            .write_batch(
                &mut cx,
                &[change("a.rs", Some(b"before"), b"saved")],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(first.failure.is_none());
        assert_eq!(first.writes[0].digest, Some(digest(b"saved")));
        // No open_doc and no watcher delivery: a completed outside save is
        // already authoritative for the next file request's compare.
        disk.0
            .lock()
            .unwrap()
            .files
            .insert("a.rs".into(), b"outside".to_vec());
        let stale = service
            .write_batch(
                &mut cx,
                &[change("a.rs", Some(b"saved"), b"must not land")],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(stale.writes.is_empty());
        let failure = stale.failure.unwrap();
        assert!(failure.preflight);
        assert_eq!(failure.error.code, 4);
        assert_eq!(failure.error.current_digest, Some(digest(b"outside")));
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"outside");
        // A stale compare observes an outside save; it must not enqueue an
        // automatic swap which clobbers the next completed outside edit.
        disk.0
            .lock()
            .unwrap()
            .files
            .insert("a.rs".into(), b"next outside".to_vec());
        clock.0.store(1000, Ordering::Relaxed);
        service.tick(&mut cx).unwrap();
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"next outside");
        disk.0
            .lock()
            .unwrap()
            .files
            .insert("a.rs".into(), b"outside".to_vec());
        let retry = service
            .write_batch(
                &mut cx,
                &[change("a.rs", Some(b"outside"), b"retry")],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(retry.failure.is_none());
        assert_eq!(retry.writes[0].digest, Some(digest(b"retry")));
        let disk = disk.0.lock().unwrap();
        assert_eq!(disk.files["a.rs"], b"retry");
        assert!(disk.versions.iter().any(|bytes| bytes == b"outside"));
    }

    #[test]
    fn cached_batch_preflight_never_reconciles_before_all_bases_pass() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        service
            .write_batch(
                &mut cx,
                &[change("a.rs", Some(b"before"), b"saved")],
                &hooks::Actor::Outside,
            )
            .unwrap();
        clock.0.store(200, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        disk.0
            .lock()
            .unwrap()
            .files
            .insert("a.rs".into(), b"outside".to_vec());
        let records = disk.0.lock().unwrap().records.clone();
        let versions = disk.0.lock().unwrap().versions.clone();
        for base in [b"saved".as_slice(), b"outside".as_slice()] {
            let result = service
                .write_batch(
                    &mut cx,
                    &[
                        change("a.rs", Some(base), b"must not land"),
                        change("missing", Some(b"stale"), b"bad"),
                    ],
                    &hooks::Actor::Outside,
                )
                .unwrap();
            assert!(result.writes.is_empty());
            let failure = result.failure.unwrap();
            assert!(failure.preflight);
            assert_eq!(failure.index, if base == b"saved" { 0 } else { 1 });
            assert_eq!(disk.0.lock().unwrap().records, records);
            assert_eq!(disk.0.lock().unwrap().versions, versions);
            assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"outside");
        }
        clock.0.store(60_001, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        assert_eq!(disk.0.lock().unwrap().records, records);
        assert_eq!(disk.0.lock().unwrap().versions, versions);
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"outside");
    }

    #[test]
    fn batch_validation_finishes_before_preparing_any_file() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock);
        let mut cx = LockCx::new(Default::default());
        for changes in [
            vec![],
            vec![change("x", None, b"a"); 257],
            vec![change("a", None, b"a"), change("a", None, b"b")],
            vec![change("a/z", None, b"a"), change("a", None, b"b")],
            vec![
                change("safe", None, b"ok"),
                change("../escape", None, b"bad"),
            ],
            vec![change("safe", None, b"ok"), change("a", None, &[255])],
            vec![
                change("safe", None, b"ok"),
                change("large", None, &vec![b'x'; 1 << 20]),
            ],
        ] {
            assert!(service
                .write_batch(&mut cx, &changes, &hooks::Actor::Outside)
                .is_err());
            assert!(disk.0.lock().unwrap().log.is_empty());
            assert!(service.projections(&mut cx).unwrap().is_empty());
        }
    }
    #[test]
    fn batch_uses_unsaved_document_text_and_preserves_live_edits_on_stale() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("disk"))));
        let mut h = Host::new(disk.clone(), gates(), ids());
        let _id = h.open("a.rs", [7; 16], 0).unwrap();
        h.write_through("a.rs", digest(b"disk"), "unsaved", "alice", 0)
            .unwrap();
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(h, clock);
        let mut cx = LockCx::new(Default::default());
        let result = service
            .write_batch(
                &mut cx,
                &[
                    change("new", None, b"new"),
                    change("a.rs", Some(b"disk"), b"bad"),
                ],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(result.writes.is_empty());
        assert_eq!(
            result.failure.unwrap().error.current_digest,
            Some(digest(b"unsaved"))
        );
        assert!(!disk.0.lock().unwrap().files.contains_key("new"));
        let result = service
            .write_batch(
                &mut cx,
                &[
                    change("new", None, b"new"),
                    change("a.rs", Some(b"unsaved"), b"accepted"),
                ],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(result.failure.is_none());
        assert_eq!(result.writes.len(), 2);
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"accepted");
    }
    #[test]
    fn batch_can_create_empty_files_and_apply_the_maximum_number_of_text_writes() {
        let disk = Shared(Arc::new(Mutex::new(Model::default())));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let changes: Vec<_> = (0..256)
            .map(|i| {
                change(
                    &format!("file-{i}"),
                    None,
                    if i == 0 { b"" } else { b"text" },
                )
            })
            .collect();
        let result = service
            .write_batch(&mut cx, &changes, &hooks::Actor::Outside)
            .unwrap();
        assert!(result.failure.is_none());
        assert_eq!(result.writes.len(), 256);
        assert_eq!(result.writes[0].digest, Some(digest(b"")));
        clock.0.store(60_001, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        assert!(service.projections(&mut cx).unwrap().is_empty());
        let disk = disk.0.lock().unwrap();
        assert_eq!(disk.files.len(), 256);
        for change in changes {
            assert_eq!(disk.files[&change.path], *change.content.as_ref().unwrap());
        }
    }
    #[test]
    fn batch_preparation_does_not_publish_outside_versions_before_a_later_stale_refusal() {
        let (mut h, _) = host("saved");
        h.flush_all(0).unwrap();
        h.tick(200, true).unwrap();
        h.disk.files.insert("a.rs".into(), b"outside".to_vec());
        let records = h.disk.records.clone();
        let versions = h.disk.versions.clone();
        let disk = Shared(Arc::new(Mutex::new(h.disk)));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let result = service
            .write_batch(
                &mut cx,
                &[
                    change("a.rs", Some(b"outside"), b"new"),
                    change("missing", Some(b"stale"), b"new"),
                ],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(result.writes.is_empty());
        assert_eq!(result.failure.unwrap().index, 1);
        clock.0.store(60_001, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        assert!(service.projections(&mut cx).unwrap().is_empty());
        let disk = disk.0.lock().unwrap();
        assert_eq!(disk.files["a.rs"], b"outside");
        assert_eq!(disk.records, records);
        assert_eq!(disk.versions, versions);
    }
    #[test]
    fn batch_snapshot_budget_refuses_without_activating_any_documents() {
        let mut model = Model::default();
        let bytes = vec![b'a'; 1 << 20];
        for i in 0..4 {
            model.files.insert(format!("file-{i}"), bytes.clone());
        }
        let disk = Shared(Arc::new(Mutex::new(model)));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock.clone());
        let mut cx = LockCx::new(Default::default());
        let changes: Vec<_> = (0..4)
            .map(|i| change(&format!("file-{i}"), Some(&bytes), b"new"))
            .collect();
        let refusal = service
            .write_batch(&mut cx, &changes, &hooks::Actor::Outside)
            .unwrap_err();
        assert_eq!(refusal.code, 8);
        assert_eq!(
            refusal.limit,
            Some(smithers_machined::doc::MAX_STATE_BYTES as u32)
        );
        clock.0.store(60_001, Ordering::Relaxed);
        service.poll(&mut cx).unwrap();
        assert!(service.projections(&mut cx).unwrap().is_empty());
        let disk = disk.0.lock().unwrap();
        assert!(disk.records.is_empty());
        assert!(disk.versions.is_empty());
        for b in disk.files.values() {
            assert_eq!(*b, bytes);
        }
    }
    #[test]
    fn absent_creation_retains_even_an_empty_outside_file() {
        for bytes in [b"ours".as_slice(), b"".as_slice()] {
            let mut model = Model::default();
            model.swap_race = Some(vec![]);
            let disk = Shared(Arc::new(Mutex::new(model)));
            let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
            let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock);
            let mut cx = LockCx::new(Default::default());
            let result = service
                .write_batch(
                    &mut cx,
                    &[change("new", None, bytes)],
                    &hooks::Actor::Outside,
                )
                .unwrap();
            assert!(result.failure.is_none());
            assert_eq!(result.writes[0].raced, Some(digest(b"")));
            {
                let disk = disk.0.lock().unwrap();
                assert_eq!(disk.files["new"], bytes);
                assert_eq!(disk.versions, vec![Vec::<u8>::new()]);
                assert_eq!(
                    Record::decode(&disk.records[&digest(b"new")])
                        .unwrap()
                        .previous,
                    None
                );
            }
            let result = service
                .write_batch(
                    &mut cx,
                    &[change("new", Some(bytes), b"next")],
                    &hooks::Actor::Outside,
                )
                .unwrap();
            assert!(result.failure.is_none());
            let disk = disk.0.lock().unwrap();
            assert_eq!(
                Record::decode(&disk.records[&digest(b"new")])
                    .unwrap()
                    .previous,
                Some(digest(bytes))
            );
        }
    }
    #[test]
    fn empty_file_creation_keeps_the_authenticated_author() {
        let disk = Shared(Arc::new(Mutex::new(Model::default())));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock);
        let mut cx = LockCx::new(Default::default());
        let result = service
            .write_batch(
                &mut cx,
                &[change("new", None, b"")],
                &hooks::Actor::Principal(vec![7; 16]),
            )
            .unwrap();
        assert!(result.failure.is_none());
        let disk = disk.0.lock().unwrap();
        assert_eq!(disk.files["new"], b"");
        assert_eq!(
            disk.saved_authors,
            [Some("07070707070707070707070707070707".into())]
        );
    }
    #[test]
    fn interrupted_create_does_not_recover_over_a_later_empty_outside_file() {
        let mut model = Model::default();
        model.fail = Some("swap");
        let disk = Shared(Arc::new(Mutex::new(model)));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Service::new(Host::new(disk.clone(), gates(), ids()), clock);
        let mut cx = LockCx::new(Default::default());
        let result = service
            .write_batch(
                &mut cx,
                &[change("new", None, b"uncommitted")],
                &hooks::Actor::Outside,
            )
            .unwrap();
        assert!(!result.failure.unwrap().preflight);
        assert!(!disk.0.lock().unwrap().files.contains_key("new"));
        drop(service);
        let mut model = disk.0.lock().unwrap().clone();
        model.fail = None;
        model.files.insert("new".into(), vec![]);
        let mut recovered = Host::new(model, gates(), ids());
        let id = recovered.open("new", [8; 16], 1).unwrap();
        assert_eq!(recovered.text(id).unwrap(), "");
        recovered.flush_all(2).unwrap();
        assert_eq!(recovered.disk.files["new"], b"");
        assert_eq!(recovered.disk.versions, vec![Vec::<u8>::new()]);
    }
    #[test]
    fn mutation_executor_saves_without_a_connected_host() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("before"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let mut host = Host::new(disk.clone(), gates(), ids());
        let id = host.open("a.rs", [7; 16], 0).unwrap();
        edit(&mut host, id, "after disconnect", 0);
        let service = Arc::new(Service::new(host, clock.clone()));
        let executor = smithers_machined::lock::Executor::start(hooks::Hooks {
            documents: service.clone(),
            clock: clock.clone(),
            ..Default::default()
        })
        .unwrap();
        // Initialize the worker at time zero before advancing the frozen clock.
        // Otherwise it may start at 200 ms and never observe a timer interval.
        executor.lock.run_blocking("started", |_| ()).unwrap();
        clock.0.store(200, Ordering::Relaxed);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while disk.0.lock().unwrap().files["a.rs"] != b"after disconnect" {
            assert!(
                std::time::Instant::now() < deadline,
                "disconnected save missed deadline"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"after disconnect");
        executor.shutdown().unwrap();
    }
    #[test]
    fn rpc_peer_delete_only_receipt_waits_for_disk_and_replay_cannot_reuse_sequence() {
        let disk = Shared(Arc::new(Mutex::new(Model::with("abc"))));
        let clock = Arc::new(Clock(AtomicU64::new(0), std::time::Instant::now()));
        let service = Arc::new(Service::new(
            Host::new(disk.clone(), gates(), ids()),
            clock.clone(),
        ));
        let mut cx = LockCx::new(hooks::Hooks {
            documents: service.clone(),
            clock: clock.clone(),
            ..Default::default()
        });
        let reply = rpc::dispatch(
            &control(
                13,
                &[
                    conn::field(1, [0, 4, b'a', b'.', b'r', b's']),
                    conn::field(
                        2,
                        conn::actor_bytes(&hooks::Actor::Principal(b"host".to_vec())),
                    ),
                ],
            ),
            &mut cx,
        )
        .unwrap();
        let result = conn::fields("response", &reply.payload[1..]).unwrap()[1].1;
        assert_eq!(result[0], 13);
        let id = u32::from_be_bytes(
            conn::fields("result13", &result[1..]).unwrap()[0]
                .1
                .try_into()
                .unwrap(),
        );
        let output = service.poll(&mut cx).unwrap();
        let epoch = Document::decode_v2(&output[0].payload).unwrap();
        assert_eq!(epoch.msg, 5);
        let reply = rpc::dispatch(
            &input(id, 0, "host", SyncMessage::SyncStep1(Default::default())),
            &mut cx,
        )
        .unwrap();
        let sync = Document::decode_v2(&reply.payload).unwrap();
        let SyncMessage::SyncStep2(state) = SyncMessage::decode_v1(&sync.data).unwrap() else {
            panic!("sync2")
        };
        let peer = editor(&state, epoch.client_id as u64);
        // Host registers a browser's client id before forwarding its edits.
        let before = peer.transact().state_vector();
        peer.get_or_insert_map("authors")
            .insert(&mut peer.transact_mut(), "4242", "616c696365");
        let register = peer.transact().encode_state_as_update_v1(&before);
        let reply = rpc::dispatch(
            &input(id, 1, "alice", SyncMessage::Update(register)),
            &mut cx,
        )
        .unwrap();
        assert_eq!(reply.payload[0], 3);
        service.flush_all(&mut cx).unwrap();
        service.poll(&mut cx).unwrap();
        let browser = editor(&core::state(&peer), 4242);
        let before = browser.transact().state_vector();
        browser
            .get_or_insert_text("content")
            .remove_range(&mut browser.transact_mut(), 1, 1);
        assert_eq!(
            browser.transact().state_vector(),
            before,
            "delete-only has no new clock"
        );
        let deletion = browser.transact().encode_state_as_update_v1(&before);
        let request = input(id, 2, "alice", SyncMessage::Update(deletion));
        let reply = rpc::dispatch(&request, &mut cx).unwrap();
        assert_eq!(reply.payload[0], 3);
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"abc");
        clock.0.store(199, Ordering::Relaxed);
        assert!(service.poll(&mut cx).unwrap().is_empty());
        clock.0.store(200, Ordering::Relaxed);
        let output = service.poll(&mut cx).unwrap();
        assert_eq!(disk.0.lock().unwrap().files["a.rs"], b"ac");
        let saved = output
            .iter()
            .map(|f| Document::decode_v2(&f.payload).unwrap())
            .find(|d| d.msg == 6)
            .unwrap();
        assert_eq!(saved.through_seq, 2);
        assert_eq!(rpc::dispatch(&request, &mut cx).unwrap().payload[0], 3);
        let forged = input(id, 2, "alice", SyncMessage::Update(vec![0, 0]));
        assert_eq!(rpc::dispatch(&forged, &mut cx).unwrap().payload[0], 255);
        disk.0.lock().unwrap().files.remove("a.rs");
        service
            .reconcile_all(&mut cx, &hooks::Actor::Outside)
            .unwrap();
        let output = service.poll(&mut cx).unwrap();
        assert!(output
            .iter()
            .any(|f| Document::decode_v2(&f.payload).unwrap().gone_kind == 1));
        service.flush_all(&mut cx).unwrap();
        assert!(!disk.0.lock().unwrap().files.contains_key("a.rs"));
    }
}

#[test]
fn compare_swap_race_keeps_displaced_and_later_outside_save_without_rollback() {
    for round in 0..40 {
        let (mut h, stream) = host("base");
        h.flush_all(0).unwrap();
        h.tick(200, true).unwrap();
        h.disk.swap_race = Some(format!("outside-{round}").into_bytes());
        let (post, raced) = h
            .write_saved("a.rs", digest(b"base"), "tool", "alice", 201)
            .unwrap()
            .unwrap();
        assert_eq!(post, digest(b"tool"));
        assert_eq!(raced, Some(digest(format!("outside-{round}").as_bytes())));
        assert!(h
            .disk
            .versions
            .contains(&format!("outside-{round}").into_bytes()));
        // ADR 0003: a save after exchange must never be swapped into a temp
        // and deleted by a rollback of the preceding write.
        h.disk
            .files
            .insert("a.rs".into(), b"latest outside".to_vec());
        h.completed_write("a.rs", "ben", 202).unwrap();
        h.tick(2201, true).unwrap();
        assert!(h.disk.versions.contains(&b"latest outside".to_vec()));
        assert!(h
            .disk
            .versions
            .contains(&format!("outside-{round}").into_bytes()));
        assert_eq!(h.text(stream).unwrap().as_bytes(), h.disk.files["a.rs"]);
    }
}

#[test]
fn stale_write_does_not_modify_document_record_or_file() {
    let (mut h, stream) = host("current");
    h.flush_all(0).unwrap();
    h.tick(200, true).unwrap();
    let records = h.disk.records.clone();
    let log = h.disk.log.clone();
    assert_eq!(
        h.write_saved("a.rs", digest(b"old"), "new", "alice", 201),
        Err(Error::Stale)
    );
    assert_eq!(h.text(stream).unwrap(), "current");
    assert_eq!(h.disk.files["a.rs"], b"current");
    assert_eq!(h.disk.records, records);
    assert_eq!(h.disk.log, log);
}

#[test]
fn host_author_registration_cannot_smuggle_deleted_foreign_text_or_reassign_authors() {
    use yrs::ReadTxn;
    let (mut h, stream) = host("original");
    let client = h.client(stream, "host", 0).unwrap();
    let initial = h.state(stream).unwrap();
    let peer = editor(&initial, client);
    let before = peer.transact().state_vector();
    peer.get_or_insert_map("authors")
        .insert(&mut peer.transact_mut(), "4242", "616c696365");
    // Visible text is unchanged, but the update introduces a hidden clock.
    let text = peer.get_or_insert_text("content");
    text.insert(&mut peer.transact_mut(), 0, "hidden");
    text.remove_range(&mut peer.transact_mut(), 0, 6);
    let mixed = peer.transact().encode_state_as_update_v1(&before);
    assert_eq!(
        h.peer_update(stream, "alice", &mixed, 1),
        Err(Error::Forged)
    );
    assert_eq!(h.state(stream).unwrap(), initial);
    let peer = editor(&initial, client);
    peer.get_or_insert_map("authors")
        .insert(&mut peer.transact_mut(), client.to_string(), "alice");
    let changed = peer.transact().encode_state_as_update_v1(&before);
    assert_eq!(
        h.peer_update(stream, "alice", &changed, 1),
        Err(Error::Forged)
    );
    assert_eq!(h.state(stream).unwrap(), initial);
}

#[test]
fn saves_attribute_only_edits_since_the_previous_successful_save() {
    let (mut h, s) = host("abc");
    edit(&mut h, s, "alice", 1);
    h.flush_all(2).unwrap();
    assert_eq!(h.disk.saved_authors, [Some("alice".into())]);
    // Previous authors remain in CRDT history and recent presence. Neither
    // makes Alice a contributor to Bob's following save.
    h.write_saved("a.rs", digest(b"alice"), "bob", "bob", 3)
        .unwrap();
    assert_eq!(
        h.disk.saved_authors,
        [Some("alice".into()), Some("bob".into())]
    );
    h.write_through("a.rs", digest(b"bob"), "alice again", "alice", 4)
        .unwrap();
    h.write_through("a.rs", digest(b"alice again"), "both", "bob", 5)
        .unwrap();
    h.flush_all(6).unwrap();
    assert_eq!(h.disk.saved_authors.last(), Some(&None));
    h.write_saved("a.rs", digest(b"both"), "bob only", "bob", 7)
        .unwrap();
    assert_eq!(h.disk.saved_authors.last(), Some(&Some("bob".into())));
}

#[test]
fn save_failure_retains_contributors_and_never_announces_success() {
    for step in ["record", "swap", "own"] {
        let (mut h, s) = host("abc");
        edit(&mut h, s, "alice", 1);
        h.disk.fail = Some(step);
        assert!(h.flush_all(2).is_err());
        assert!(h.disk.saved_authors.is_empty());
        h.disk.fail = None;
        h.flush_all(3).unwrap();
        assert_eq!(h.disk.saved_authors, [Some("alice".into())]);
    }
}

#[test]
fn allocating_another_authors_client_does_not_claim_their_edit() {
    let (mut h, s) = host("abc");
    h.client(s, "bob", 1).unwrap();
    edit(&mut h, s, "alice", 2);
    h.flush_all(3).unwrap();
    assert_eq!(h.disk.saved_authors, [Some("alice".into())]);
    h.require_receipt(s, 4).unwrap();
    h.flush_all(5).unwrap();
    assert_eq!(h.disk.saved_authors.last(), Some(&None));
}

#[test]
fn outside_merge_is_not_attributed_to_the_only_connected_editor() {
    let (mut h, s) = host("abc");
    edit(&mut h, s, "alice", 1);
    h.flush_all(2).unwrap();
    h.disk.files.insert("a.rs".into(), b"outside".to_vec());
    h.completed_write("a.rs", "outside", 3).unwrap();
    h.flush_all(4).unwrap();
    assert_eq!(h.disk.saved_authors.last(), Some(&Some("outside".into())));
}

#[test]
fn interrupted_save_cannot_claim_a_new_editors_identity_after_recovery() {
    let (mut h, s) = host("abc");
    edit(&mut h, s, "alice", 1);
    h.disk.fail = Some("swap");
    assert!(h.flush_all(2).is_err());
    let mut disk = h.disk;
    disk.fail = None;
    let mut recovered = Host::new(disk, gates(), ids());
    recovered.open("a.rs", [8; 16], 3).unwrap();
    recovered
        .write_saved("a.rs", digest(b"alice"), "bob", "bob", 4)
        .unwrap();
    assert_eq!(recovered.disk.saved_authors, [None]);
}

#[test]
fn record_predecessor_presence_is_canonical_and_legacy_empty_stays_present() {
    let (mut h, _) = host("");
    h.flush_all(0).unwrap();
    let mut record = Record::decode(&h.disk.records[&digest(b"a.rs")]).unwrap();
    assert_eq!(record.previous, Some(digest(b"")));
    for version in [1, 2, 3] {
        let mut raw = record.encode().unwrap();
        raw.truncate(
            raw.len()
                - match version {
                    1 => 39,
                    2 => 35,
                    _ => 34,
                },
        );
        raw[..8].copy_from_slice(match version {
            1 => b"SMTHDOC1",
            2 => b"SMTHDOC2",
            _ => b"SMTHDOC3",
        });
        raw.extend(digest(&raw));
        assert_eq!(Record::decode(&raw).unwrap().previous, Some(digest(b"")));
    }
    record.previous = None;
    let raw = record.encode().unwrap();
    assert_eq!(Record::decode(&raw).unwrap().previous, None);
    for flag in [2, 255] {
        let mut corrupt = raw[..raw.len() - 32].to_vec();
        let at = corrupt.len() - 3;
        corrupt[at] = flag;
        corrupt.extend(digest(&corrupt));
        assert!(Record::decode(&corrupt).is_err());
    }
    record.previous_text = "not absent".into();
    assert!(record.encode().is_err());
    // A recomputed checksum cannot turn a nonempty predecessor into absent.
    record.previous = Some(digest(b"not absent"));
    let mut forged = record.encode().unwrap();
    forged.truncate(forged.len() - 32);
    let at = forged.len() - 3;
    forged[at] = 0;
    forged.extend(digest(&forged));
    assert!(Record::decode(&forged).is_err());
}

#[test]
fn deletion_failures_before_and_after_rename_never_fake_success_or_resurrect() {
    for step in ["record", "delete", "deleted", "displaced", "own_delete"] {
        let (mut h, _) = host("before");
        h.disk.fail = Some(step);
        assert!(h.delete_saved("a.rs", "alice", 0).is_err(), "{step}");
        let renamed = !matches!(step, "record" | "delete");
        assert_eq!(!h.disk.files.contains_key("a.rs"), renamed, "{step}");
        h.disk.fail = None;
        for now in [200, 2000, 60_001] {
            h.tick(now, true).unwrap();
        }
        assert_eq!(!h.disk.files.contains_key("a.rs"), renamed, "{step}");
        let mut recovered = Host::new(h.disk, gates(), ids());
        recovered.tick(0, true).unwrap();
        recovered.tick(2000, true).unwrap();
        assert_eq!(
            !recovered.disk.files.contains_key("a.rs"),
            renamed,
            "{step}"
        );
        if !renamed {
            let id = recovered.open("a.rs", [9; 16], 2001).unwrap();
            assert_eq!(recovered.text(id).unwrap(), "before");
        }
    }
}
#[test]
fn late_deleted_inode_writes_survive_restart_without_recreating_or_overwriting_path() {
    for restart in [false, true] {
        for recreate in [false, true] {
            let (mut h, _) = host("before");
            assert_eq!(h.delete_saved("a.rs", "alice", 0).unwrap(), None);
            let token = *h.disk.displaced.keys().next().unwrap();
            if recreate {
                h.disk.files.insert("a.rs".into(), b"recreated".to_vec());
            }
            if restart {
                h = Host::new(h.disk, gates(), ids());
            }
            h.tick(100, true).unwrap();
            h.disk.displaced.insert(token, b"late writer".to_vec());
            h.tick(200, true).unwrap();
            h.disk.fail = Some("version");
            assert!(h.tick(400, true).is_err());
            assert_eq!(h.disk.displaced[&token], b"late writer");
            h.disk.fail = None;
            h.tick(401, true).unwrap();
            assert!(h.disk.versions.contains(&b"late writer".to_vec()));
            assert!(h.disk.displaced.is_empty());
            assert_eq!(
                h.disk.files.get("a.rs"),
                recreate.then_some(&b"recreated".to_vec())
            );
        }
    }
}
#[test]
fn raced_delete_records_displaced_bytes_and_pending_swap_requires_settling() {
    let (mut h, _) = host("before");
    h.disk.swap_race = Some(b"outside".to_vec());
    assert_eq!(
        h.delete_saved("a.rs", "alice", 0).unwrap(),
        Some(digest(b"outside"))
    );
    assert_eq!(h.disk.versions, vec![b"outside".to_vec()]);
    h.tick(200, true).unwrap();
    assert_eq!(h.disk.versions.len(), 1);
    assert!(!h.disk.files.contains_key("a.rs"));

    let (mut h, _) = host("before");
    h.write_saved("a.rs", digest(b"before"), "saved", "alice", 0)
        .unwrap();
    assert!(matches!(h.delete_saved("a.rs", "alice", 1), Err(Error::Provider(e)) if e.code == 9));
    assert_eq!(h.disk.files["a.rs"], b"saved");
    h.tick(200, true).unwrap();
    h.delete_saved("a.rs", "alice", 201).unwrap();
    assert!(!h.disk.files.contains_key("a.rs"));
}
#[test]
fn deletion_record_paths_are_bounded_confined_and_checksummed() {
    let (mut h, _) = host("before");
    h.delete_saved("a.rs", "alice", 0).unwrap();
    let bytes = &h.disk.records[&digest(b"a.rs")];
    let mut record = Record::decode(bytes).unwrap();
    assert_eq!(record.deleted_path.as_deref(), Some("a.rs"));
    for path in ["", "/escape", "../escape", "a/../escape", "a//b", "a\0b"] {
        record.deleted_path = Some(path.into());
        assert!(record.encode().is_err(), "{path}");
    }
    record.deleted_path = Some("x".repeat(4097));
    assert!(record.encode().is_err());
    for at in bytes.len() - 38..bytes.len() {
        let mut corrupt = bytes.clone();
        corrupt[at] ^= 1;
        assert!(Record::decode(&corrupt).is_err());
    }
}
