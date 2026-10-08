#![cfg(target_os = "linux")]
use smithers_machined::transcript::{Record, Tail};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::symlink,
    path::PathBuf,
    time::{Duration, Instant},
};

struct Fixture(PathBuf);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "smithers-transcript-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn tail(&self, source: &str) -> io::Result<Tail> {
        Tail::new(
            File::open(&self.0).unwrap(),
            source,
            rustix::process::getuid().as_raw(),
        )
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.0.join(name), bytes).unwrap();
    }
    fn append(&self, bytes: &[u8]) {
        OpenOptions::new()
            .append(true)
            .open(self.0.join("session.jsonl"))
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn real_inotify_partial_replacement_truncation_and_revoke() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", b"{\"a\":1}\npart");
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    let mut records = vec![];
    let mut collect = |r: &Record| {
        records.push(r.clone());
        Ok(())
    };
    assert_eq!(tail.poll(now, &mut collect).unwrap(), 1);
    fixture.append(b"ial\n");
    assert_eq!(tail.poll(now, &mut collect).unwrap(), 1); // no 1s wait: real inotify
    fixture.write("new", b"{}\n");
    fs::rename(fixture.0.join("new"), fixture.0.join("session.jsonl")).unwrap();
    assert_eq!(
        tail.poll(now + Duration::from_secs(1), &mut collect)
            .unwrap(),
        1
    );
    fixture.write("session.jsonl", b"x\n");
    assert_eq!(
        tail.poll(now + Duration::from_secs(2), &mut collect)
            .unwrap(),
        1
    );
    assert_eq!(
        records,
        vec![
            Record {
                generation: 1,
                start: 0,
                end: 8,
                text: "{\"a\":1}".into(),
                skipped: None,
            },
            Record {
                generation: 1,
                start: 8,
                end: 16,
                text: "partial".into(),
                skipped: None,
            },
            Record {
                generation: 2,
                start: 0,
                end: 3,
                text: "{}".into(),
                skipped: None,
            },
            Record {
                generation: 3,
                start: 0,
                end: 2,
                text: "x".into(),
                skipped: None,
            },
        ]
    );
    tail.revoke();
    fixture.append(b"{}\n");
    assert_eq!(
        tail.poll(now + Duration::from_secs(3), |_| panic!(
            "revoked source published"
        ))
        .unwrap_err()
        .kind(),
        io::ErrorKind::PermissionDenied
    );
}

#[test]
fn failed_outbox_append_replays_identical_ranges() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", b"one\ntwo\n");
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    let mut attempted = vec![];
    assert!(tail
        .poll(now, |r| {
            attempted.push(r.clone());
            if r.start == 4 {
                Err(io::Error::other("outbox fsync failed"))
            } else {
                Ok(())
            }
        })
        .is_err());
    let mut replay = vec![];
    assert_eq!(
        tail.poll(now, |r| {
            replay.push(r.clone());
            Ok(())
        })
        .unwrap(),
        2
    );
    assert_eq!(attempted, replay);
    assert_eq!(
        tail.poll(now + Duration::from_secs(1), |_| panic!(
            "duplicate after persistence"
        ))
        .unwrap(),
        0
    );
}

#[test]
fn confined_open_refuses_symlinks_hardlinks_and_special_files() {
    let fixture = Fixture::new();
    fixture.write("sentinel", b"outside secret\n");
    symlink("sentinel", fixture.0.join("link")).unwrap();
    fs::create_dir(fixture.0.join("dir")).unwrap();
    symlink("dir", fixture.0.join("dirlink")).unwrap();
    fixture.write("dir/source", b"secret\n");
    fs::hard_link(fixture.0.join("sentinel"), fixture.0.join("hard")).unwrap();
    rustix::fs::mknodat(
        rustix::fs::CWD,
        fixture.0.join("fifo"),
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        0,
    )
    .unwrap();
    for path in ["link", "dirlink/source", "hard", "dir", "fifo"] {
        let mut tail = fixture.tail(path).unwrap();
        assert!(
            tail.poll(Instant::now(), |_| panic!("unsafe source published"))
                .is_err(),
            "{path}"
        );
    }
    for path in [
        "../sentinel",
        "/etc/passwd",
        "dir/../sentinel",
        "dir//source",
        "",
        "dir/./source",
    ] {
        assert!(fixture.tail(path).is_err(), "{path}");
    }
    assert!(Tail::new(File::open(&fixture.0).unwrap(), "sentinel", 0).is_err());
    assert!(Tail::new(
        File::open(&fixture.0).unwrap(),
        "sentinel",
        rustix::process::getuid().as_raw() + 1
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.0.join("sentinel")).unwrap(),
        b"outside secret\n"
    );
}

/// A line longer than a record can be: the one line a reader cannot frame.
fn too_long() -> Vec<u8> {
    let mut line = vec![b'x'; smithers_machined::transcript::MAX_RECORD_BYTES + 1];
    line.push(b'\n');
    line
}
/// Drain bounded reads, preserving every record including explicit skips.
fn drain(tail: &mut Tail, now: Instant, mut persist: impl FnMut(&Record) -> io::Result<()>) {
    for step in 1..40 {
        tail.poll(now + Duration::from_secs(step), &mut persist)
            .unwrap();
    }
}

#[test]
fn missing_source_reconciles_and_a_line_too_long_is_skipped() {
    let fixture = Fixture::new();
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    assert_eq!(tail.poll(now, |_| panic!()).unwrap(), 0);
    fixture.write("session.jsonl", &too_long());
    let mut records = vec![];
    drain(&mut tail, now, |r| {
        records.push(r.clone());
        Ok(())
    });
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].skipped, Some(1048577));
    fixture.append(b"{}\n");
    drain(&mut tail, now + Duration::from_secs(60), |r| {
        records.push(r.clone());
        Ok(())
    });
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].start, records[0].end);
}

#[test]
fn lines_that_cannot_cross_the_wire_are_read_and_the_source_goes_on() {
    let fixture = Fixture::new();
    // Not UTF-8, a NUL, blank lines: none of them stops the source, and
    // every byte of the file is in one record's range.
    let written: &[u8] = b"{\"a\":\"\xff\"}\n\n{\"b\":\"\0\"}\n\r\n{\"c\":3}\n";
    fixture.write("session.jsonl", written);
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let mut records = vec![];
    let now = Instant::now();
    assert_eq!(
        tail.poll(now, |record| {
            records.push(record.clone());
            Ok(())
        })
        .unwrap(),
        3
    );
    assert_eq!(
        records
            .iter()
            .map(|record| (record.start, record.end, record.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (0, 10, "{\"a\":\"?\"}"),
            (10, 21, " {\"b\":\"?\"}"),
            (21, 31, "\r {\"c\":3}"),
        ]
    );
    assert_eq!(records.last().unwrap().end, written.len() as u64);
    // What the agent writes next is read as before.
    fixture.append(b"{\"d\":4}\n");
    assert_eq!(
        tail.poll(now, |record| {
            records.push(record.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(
        records[3],
        Record {
            generation: 1,
            start: 31,
            end: 39,
            text: "{\"d\":4}".into(),
            skipped: None,
        }
    );
}

#[test]
fn valid_record_before_a_line_too_long_is_persisted() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", &[b"{}\n".as_slice(), &too_long()].concat());
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let mut records = vec![];
    drain(&mut tail, Instant::now(), |r| {
        records.push(r.clone());
        Ok(())
    });
    assert_eq!(
        records[..1],
        vec![Record {
            generation: 1,
            start: 0,
            end: 3,
            text: "{}".into(),
            skipped: None,
        }]
    );
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].skipped, Some(1048577));
    assert_eq!(tail.poll(Instant::now(), |_| panic!()).unwrap(), 0);
}

#[test]
fn persistence_failure_before_a_line_too_long_preserves_replay() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", &[b"{}\n".as_slice(), &too_long()].concat());
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    let mut attempted = vec![];
    assert!(tail
        .poll(now, |r| {
            attempted.push(r.clone());
            Err(io::Error::other("outbox unavailable"))
        })
        .is_err());
    let mut replay = vec![];
    drain(&mut tail, now, |r| {
        replay.push(r.clone());
        Ok(())
    });
    assert_eq!(attempted, replay[..1]);
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[1].skipped, Some(1048577));
    assert_eq!(
        replay[..1],
        vec![Record {
            generation: 1,
            start: 0,
            end: 3,
            text: "{}".into(),
            skipped: None,
        }]
    );
    assert_eq!(tail.poll(now, |_| panic!("duplicate record")).unwrap(), 0);
}

#[test]
fn held_root_survives_path_replacement_without_reading_replacement() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("owner-root")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    fixture.write("owner-root/session.jsonl", b"owner\n");
    fixture.write("outside/session.jsonl", b"sentinel secret\n");
    let mut tail = Tail::new(
        File::open(fixture.0.join("owner-root")).unwrap(),
        "session.jsonl",
        rustix::process::getuid().as_raw(),
    )
    .unwrap();
    fs::rename(
        fixture.0.join("owner-root"),
        fixture.0.join("retained-root"),
    )
    .unwrap();
    symlink("outside", fixture.0.join("owner-root")).unwrap();
    let mut records = vec![];
    assert_eq!(
        tail.poll(Instant::now(), |r| {
            records.push(r.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(
        records,
        vec![Record {
            generation: 1,
            start: 0,
            end: 6,
            text: "owner".into(),
            skipped: None,
        }]
    );
    assert_eq!(
        fs::read(fixture.0.join("outside/session.jsonl")).unwrap(),
        b"sentinel secret\n"
    );
}

#[test]
fn backlog_and_partial_records_do_not_wait_for_reconciliation() {
    let fixture = Fixture::new();
    let mut bytes = vec![b'x'; smithers_machined::transcript::READ_BYTES + 7];
    bytes.extend_from_slice(b"\npartial");
    fixture.write("session.jsonl", &bytes);
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    assert_eq!(tail.poll(now, |_| panic!()).unwrap(), 0);
    let mut records = vec![];
    assert_eq!(
        tail.poll(now, |r| {
            records.push(r.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(records[0].start, 0);
    assert_eq!(records[0].end, 65544);
    assert_eq!(records[0].text.len(), 65543);
    fixture.write("replacement", b"new\n");
    fs::rename(
        fixture.0.join("replacement"),
        fixture.0.join("session.jsonl"),
    )
    .unwrap();
    records.clear();
    assert_eq!(
        tail.poll(now + Duration::from_secs(1), |r| {
            records.push(r.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(
        records,
        vec![Record {
            generation: 2,
            start: 0,
            end: 4,
            text: "new".into(),
            skipped: None,
        }]
    );
}

#[test]
fn truncate_and_regrow_before_poll_starts_new_generation() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", b"old\n");
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    tail.poll(now, |_| Ok(())).unwrap();
    fixture.write("session.jsonl", b"replacement\n");
    let mut records = vec![];
    tail.poll(now + Duration::from_secs(1), |r| {
        records.push(r.clone());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        records,
        vec![Record {
            generation: 2,
            start: 0,
            end: 12,
            text: "replacement".into(),
            skipped: None,
        }]
    );
}

#[derive(Default)]
struct TranscriptRefs;
impl smithers_machined::outbox::Refs for TranscriptRefs {
    fn pin_and_sync(&mut self, _: [u8; 16], _: smithers_machined::hooks::Oid) -> io::Result<()> {
        panic!("transcripts never pin repository objects")
    }
    fn acknowledge_and_sync(&mut self, _: smithers_machined::hooks::Oid) -> io::Result<()> {
        panic!("transcripts never move a repository head")
    }
    fn unpin(&mut self, _: [u8; 16]) -> io::Result<()> {
        panic!("transcripts never unpin repository objects")
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        Ok(vec![])
    }
}
fn source() -> smithers_machined::transcript::wire::Source {
    smithers_machined::transcript::wire::Source {
        session: 1,
        participant: [0x44; 16],
        lifetime: [0x33; 16],
        profile: "claude-code/2.1.0".into(),
    }
}
fn durable(
    f: &Fixture,
) -> (
    smithers_machined::transcript::CheckpointStore,
    smithers_machined::outbox::Outbox<TranscriptRefs>,
) {
    use std::os::unix::fs::PermissionsExt;
    let state = f.0.join("state");
    fs::create_dir_all(state.join("outbox")).unwrap();
    for path in [&state, &state.join("outbox")] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let checkpoints = smithers_machined::transcript::CheckpointStore::new(
        File::open(&state).unwrap(),
        source().lifetime,
    )
    .unwrap();
    let outbox = smithers_machined::outbox::Outbox::open(
        smithers_machined::outbox_store::Store::open(
            &state.join("outbox"),
            rustix::process::geteuid().as_raw(),
        )
        .unwrap(),
        rustix::process::geteuid().as_raw(),
        TranscriptRefs,
    )
    .unwrap();
    (checkpoints, outbox)
}
fn recover(f: &Fixture, checkpoint: &[u8]) -> io::Result<Tail> {
    Tail::resume(
        File::open(&f.0).unwrap(),
        "session.jsonl",
        rustix::process::getuid().as_raw(),
        checkpoint,
    )
}
#[test]
fn durable_restart_preserves_partial_and_replacement_generation() {
    let f = Fixture::new();
    f.write("session.jsonl", b"{}\npar");
    let (checkpoints, mut outbox) = durable(&f);
    let mut tail = f.tail("session.jsonl").unwrap();
    assert_eq!(
        tail.poll_durable(
            Instant::now(),
            &source(),
            |event| outbox.append(event, None).map(|_| ()),
            |state| checkpoints.save(state)
        )
        .unwrap(),
        1
    );
    let original = outbox.front().unwrap().unwrap();
    drop(tail);
    drop(outbox);
    let (_, mut outbox) = durable(&f);
    let recovered = outbox.front().unwrap().unwrap();
    assert_eq!(
        (recovered.seq, recovered.id, recovered.event),
        (original.seq, original.id, original.event)
    );
    let mut tail = recover(&f, &checkpoints.load().unwrap().unwrap()).unwrap();
    f.append(b"tial\n");
    let mut actual = vec![];
    assert_eq!(
        tail.poll(Instant::now(), |record| {
            actual.push(record.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(
        actual,
        vec![Record {
            generation: 1,
            start: 3,
            end: 11,
            text: "partial".into(),
            skipped: None,
        }]
    );
    f.write("new", b"new\n");
    fs::rename(f.0.join("new"), f.0.join("session.jsonl")).unwrap();
    assert_eq!(
        tail.poll_durable(
            Instant::now() + Duration::from_secs(1),
            &source(),
            |event| outbox.append(event, None).map(|_| ()),
            |state| checkpoints.save(state)
        )
        .unwrap(),
        1
    );
    let mut tail = recover(&f, &checkpoints.load().unwrap().unwrap()).unwrap();
    f.append(b"next\n");
    actual.clear();
    assert_eq!(
        tail.poll(Instant::now(), |record| {
            actual.push(record.clone());
            Ok(())
        })
        .unwrap(),
        1
    );
    assert_eq!(
        actual,
        vec![Record {
            generation: 2,
            start: 4,
            end: 9,
            text: "next".into(),
            skipped: None,
        }]
    );
}
#[test]
fn checkpoint_failure_replays_outbox_range_without_advancing_reader() {
    let f = Fixture::new();
    f.write("session.jsonl", b"{}\n");
    let (checkpoints, mut outbox) = durable(&f);
    let mut tail = f.tail("session.jsonl").unwrap();
    let previous = tail.checkpoint().unwrap();
    assert!(tail
        .poll_durable(
            Instant::now(),
            &source(),
            |event| outbox.append(event, None).map(|_| ()),
            |_| Err(io::Error::other("disk full"))
        )
        .is_err());
    assert!(checkpoints.load().unwrap().is_none());
    let first = outbox.front().unwrap().unwrap();
    assert_eq!(first.seq, 1);
    assert_eq!(
        tail.poll_durable(
            Instant::now(),
            &source(),
            |event| outbox.append(event, None).map(|_| ()),
            |state| checkpoints.save(state)
        )
        .unwrap(),
        1
    );
    let mut replay = recover(&f, &previous).unwrap();
    let mut actual = vec![];
    replay
        .poll(Instant::now(), |r| {
            actual.push(r.clone());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        actual,
        vec![Record {
            generation: 1,
            start: 0,
            end: 3,
            text: "{}".into(),
            skipped: None,
        }]
    );
    let (_, persisted) = smithers_machined::transcript::wire::Source::decode(&first.event).unwrap();
    assert_eq!(persisted, actual.remove(0));
    let mut resumed = recover(&f, &checkpoints.load().unwrap().unwrap()).unwrap();
    assert_eq!(
        resumed
            .poll_durable(
                Instant::now(),
                &source(),
                |event| outbox.append(event, None).map(|_| ()),
                |_| Ok(())
            )
            .unwrap(),
        0
    );
}
#[test]
fn checkpoint_confines_root_path_source_and_corrupt_state() {
    let f = Fixture::new();
    f.write("session.jsonl", b"{}\n");
    let other = Fixture::new();
    other.write("session.jsonl", b"sentinel\n");
    let (store, mut outbox) = durable(&f);
    let mut tail = f.tail("session.jsonl").unwrap();
    tail.poll_durable(
        Instant::now(),
        &source(),
        |event| outbox.append(event, None).map(|_| ()),
        |state| store.save(state),
    )
    .unwrap();
    let state = store.load().unwrap().unwrap();
    assert!(recover(&other, &state).is_err());
    assert!(Tail::resume(
        File::open(&f.0).unwrap(),
        "another.jsonl",
        rustix::process::getuid().as_raw(),
        &state
    )
    .is_err());
    for field in ["version", "owner", "root", "framer"] {
        let mut bad: serde_json::Value = serde_json::from_slice(&state).unwrap();
        bad[field] = serde_json::json!(0);
        assert!(recover(&f, &serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for bytes in [b"null".as_slice(), b"{}", b"{"] {
        assert!(recover(&f, bytes).is_err());
    }
    let mut resumed = recover(&f, &state).unwrap();
    let mut impostor = source();
    impostor.lifetime[0] += 1;
    assert!(resumed
        .poll_durable(
            Instant::now(),
            &impostor,
            |event| outbox.append(event, None).map(|_| ()),
            |_| panic!("must refuse before saving")
        )
        .is_err());
    assert_eq!(
        fs::read(other.0.join("session.jsonl")).unwrap(),
        b"sentinel\n"
    );
}
#[test]
fn durable_checkpoint_remains_on_held_directory_and_refuses_links() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let (store, _) = durable(&f);
    assert!(store.load().unwrap().is_none());
    store.save(b"first").unwrap();
    let name = "33333333333333333333333333333333.tail";
    fs::rename(f.0.join("state"), f.0.join("held")).unwrap();
    fs::create_dir(f.0.join("state")).unwrap();
    fs::set_permissions(f.0.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
    f.write("state/sentinel", b"sentinel");
    symlink("sentinel", f.0.join("state").join(name)).unwrap();
    store.save(b"second").unwrap();
    assert_eq!(store.load().unwrap().unwrap(), b"second");
    assert_eq!(fs::read(f.0.join("state/sentinel")).unwrap(), b"sentinel");
    let forged = smithers_machined::transcript::CheckpointStore::new(
        File::open(f.0.join("state")).unwrap(),
        source().lifetime,
    )
    .unwrap();
    assert!(forged.load().is_err());
    fs::remove_file(f.0.join("state").join(name)).unwrap();
    fs::hard_link(f.0.join("state/sentinel"), f.0.join("state").join(name)).unwrap();
    assert!(forged.load().is_err());
}
#[test]
fn checkpoint_preserves_skipped_progress_and_revoked_refusals_after_restart() {
    let f = Fixture::new();
    f.write(
        "session.jsonl",
        &[b"{}\n".as_slice(), &too_long(), b"ignored trailing bytes\n"].concat(),
    );
    let (store, mut outbox) = durable(&f);
    let mut tail = f.tail("session.jsonl").unwrap();
    let now = Instant::now();
    for step in 1..40 {
        tail.poll_durable(
            now + Duration::from_secs(step),
            &source(),
            |event| outbox.append(event, None).map(|_| ()),
            |state| store.save(state),
        )
        .unwrap();
    }
    assert!(outbox.front().unwrap().is_some()); // valid preceding record survives
    let mut restored = recover(&f, &store.load().unwrap().unwrap()).unwrap();
    assert_eq!(
        restored
            .poll(Instant::now(), |_| panic!("duplicate record"))
            .unwrap(),
        0
    );
    let mut tail = f.tail("session.jsonl").unwrap();
    tail.revoke();
    let mut restored = recover(&f, &tail.checkpoint().unwrap()).unwrap();
    assert!(restored
        .poll(Instant::now(), |_| panic!("revoked reader"))
        .is_err());
}
