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
                text: "{\"a\":1}".into()
            },
            Record {
                generation: 1,
                start: 8,
                end: 16,
                text: "partial".into()
            },
            Record {
                generation: 2,
                start: 0,
                end: 3,
                text: "{}".into()
            },
            Record {
                generation: 3,
                start: 0,
                end: 2,
                text: "x".into()
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

#[test]
fn missing_source_reconciles_and_malformed_source_stops() {
    let fixture = Fixture::new();
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let now = Instant::now();
    assert_eq!(tail.poll(now, |_| panic!()).unwrap(), 0);
    fixture.write("session.jsonl", b"\xff\n");
    assert!(tail
        .poll(now + Duration::from_secs(1), |_| panic!())
        .is_err());
    fixture.write("session.jsonl", b"{}\n");
    assert!(tail
        .poll(now + Duration::from_secs(2), |_| panic!())
        .is_err());
}

#[test]
fn valid_record_before_malformed_record_is_persisted() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", b"{}\n\xff\n");
    let mut tail = fixture.tail("session.jsonl").unwrap();
    let mut records = vec![];
    assert!(tail
        .poll(Instant::now(), |r| {
            records.push(r.clone());
            Ok(())
        })
        .is_err());
    assert_eq!(
        records,
        vec![Record {
            generation: 1,
            start: 0,
            end: 3,
            text: "{}".into()
        }]
    );
    assert!(tail.poll(Instant::now(), |_| panic!()).is_err());
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
            text: "new".into()
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
            text: "replacement".into()
        }]
    );
}
