#![cfg(target_os = "linux")]
use smithers_machined::transcript::{
    reader::{self, Reader, Startup},
    wire::Source,
};
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixStream,
    },
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Fixture {
    root: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "smithers-reader-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("session.jsonl"), b"{\"a\":1}\npartial").unwrap();
        Self { root }
    }
    fn startup(&self) -> Startup {
        Startup {
            uid: rustix::process::getuid().as_raw(),
            gid: rustix::process::getgid().as_raw(),
            groups: rustix::process::getgroups()
                .unwrap()
                .iter()
                .map(|g| g.as_raw())
                .collect(),
            root: self.root.to_str().unwrap().into(),
            path: "session.jsonl".into(),
            source: Source {
                session: 1,
                participant: [1; 16],
                lifetime: [2; 16],
                profile: "claude-code/2.1.0".into(),
            },
            checkpoint: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
struct Process {
    child: Child,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn spawn() -> (UnixStream, Process) {
    let (socket, child_socket) = UnixStream::pair().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let input: std::os::fd::OwnedFd = child_socket.try_clone().unwrap().into();
    let output: std::os::fd::OwnedFd = child_socket.into();
    let child = Command::new(env!("CARGO_BIN_EXE_smithers-machined"))
        .arg("transcript-reader")
        .env_clear()
        .stdin(Stdio::from(input))
        .stdout(Stdio::from(output))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    (socket, Process { child })
}

/// What the broker does before it hands a reader's socket to the daemon, then
/// what the daemon does with it.
fn connect(mut socket: UnixStream, startup: &Startup) -> io::Result<Reader> {
    let _ = reader::bind(
        &mut socket,
        &Startup {
            checkpoint: None,
            ..startup.clone()
        },
    );
    Reader::connect(socket, startup)
}

#[test]
fn the_daemon_reads_only_what_the_broker_bound_the_child_to() {
    let fixture = Fixture::new();
    let secret = fixture.root.join("secret.jsonl");
    fs::write(&secret, b"{\"secret\":1}\n").unwrap();
    let honest = fixture.startup();
    let mut other_source = honest.clone();
    other_source.source.lifetime = [3; 16];
    let mut other_session = honest.clone();
    other_session.source.session = 2;
    let mut other_participant = honest.clone();
    other_participant.source.participant = [4; 16];
    let mut other_profile = honest.clone();
    other_profile.source.profile = "codex-rollout/0.160".into();
    let inner = fixture.root.join("inner");
    fs::create_dir(&inner).unwrap();
    fs::write(inner.join("session.jsonl"), b"{\"inner\":1}\n").unwrap();
    // Each asks the owner's child for something the broker did not bind it to.
    for (name, asked) in [
        (
            "another file beneath the same root",
            Startup {
                path: "secret.jsonl".into(),
                ..honest.clone()
            },
        ),
        (
            "another root of the same owner",
            Startup {
                root: inner.to_str().unwrap().into(),
                ..honest.clone()
            },
        ),
        ("another source lifetime", other_source),
        ("another session", other_session),
        ("another participant", other_participant),
        ("another profile", other_profile),
        (
            "fewer groups",
            Startup {
                groups: vec![],
                ..honest.clone()
            },
        ),
    ] {
        let (mut socket, mut child) = spawn();
        reader::bind(&mut socket, &honest).unwrap();
        assert!(Reader::connect(socket, &asked).is_err(), "{name}");
        assert!(!child.child.wait().unwrap().success(), "{name}");
    }
    // A startup with no binding before it, a second binding, and a binding
    // that carries a checkpoint are each refused; the child exits unread.
    let (socket, mut child) = spawn();
    assert!(Reader::connect(socket, &honest).is_err());
    assert!(!child.child.wait().unwrap().success());
    let (mut socket, mut child) = spawn();
    reader::bind(&mut socket, &honest).unwrap();
    reader::bind(&mut socket, &honest).unwrap();
    assert!(Reader::connect(socket, &honest).is_err());
    assert!(!child.child.wait().unwrap().success());
    let mut socket = UnixStream::pair().unwrap().0;
    let carried = Startup {
        checkpoint: Some("{}".into()),
        ..honest.clone()
    };
    assert!(reader::bind(&mut socket, &carried).is_err());
    // The bound request still reads, and only the bound file.
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &honest).unwrap();
    let mut texts = vec![];
    reader
        .poll(
            || Ok(()),
            |event| {
                texts.push(Source::decode(event).unwrap().1.text);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(texts, ["{\"a\":1}"]);
    assert_eq!(fs::read(&secret).unwrap(), b"{\"secret\":1}\n");
}

#[test]
fn slow_persistence_is_the_daemons_time_and_does_not_fail_the_poll() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("session.jsonl"),
        b"{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n{\"n\":4}\n{\"n\":5}\n",
    )
    .unwrap();
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &fixture.startup()).unwrap();
    // Five outbox appends and a checkpoint, slower together than the two
    // seconds a reader is given to answer: the reader is not at fault.
    let began = std::time::Instant::now();
    let mut texts = vec![];
    let read = reader.poll(
        || Ok(()),
        |event| {
            std::thread::sleep(Duration::from_millis(450));
            texts.push(Source::decode(event).unwrap().1.text);
            Ok(())
        },
        |_| {
            std::thread::sleep(Duration::from_millis(450));
            Ok(())
        },
    );
    assert!(began.elapsed() > Duration::from_millis(2500));
    assert_eq!(read.unwrap(), 5);
    assert_eq!(texts.len(), 5);
    // The same reader keeps working afterwards.
    assert_eq!(reader.poll(|| Ok(()), |_| Ok(()), |_| Ok(())).unwrap(), 0);
}

#[test]
fn child_socketpair_outbox_checkpoint_restart_and_revoke() {
    let fixture = Fixture::new();
    let (socket, _child) = spawn();
    let mut startup = fixture.startup();
    let mut reader = connect(socket, &startup).unwrap();
    let outbox_dir = fixture.root.join("outbox");
    fs::create_dir(&outbox_dir).unwrap();
    fs::set_permissions(&outbox_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let mut outbox =
        smithers_machined::outbox_store::Store::open(&outbox_dir, startup.uid).unwrap();
    let mut checkpoint = vec![];
    let mut events = vec![];
    assert_eq!(
        reader
            .poll(
                || Ok(()),
                |event| {
                    outbox.append(|seq| {
                        Ok(smithers_machined::conn::Durable {
                            seq,
                            id: [3; 16],
                            event: event.to_vec(),
                        }
                        .frame()
                        .payload)
                    })?;
                    events.push(event.to_vec());
                    Ok(())
                },
                |bytes| {
                    checkpoint = bytes.to_vec();
                    Ok(())
                }
            )
            .unwrap(),
        1
    );
    drop(outbox);
    let outbox = smithers_machined::outbox_store::Store::open(&outbox_dir, startup.uid).unwrap();
    let stored =
        smithers_machined::conn::Durable::decode(&outbox.read(1, startup.uid).unwrap()).unwrap();
    assert_eq!(stored.seq, 1);
    assert_eq!(stored.event, events[0]);
    let (_, record) = Source::decode(&events[0]).unwrap();
    assert_eq!(
        (record.start, record.end, record.text.as_str()),
        (0, 8, "{\"a\":1}")
    );
    drop(reader);
    startup.checkpoint = Some(String::from_utf8(checkpoint).unwrap());
    fs::OpenOptions::new()
        .append(true)
        .open(fixture.root.join("session.jsonl"))
        .unwrap()
        .write_all(b"done\n")
        .unwrap();
    let (socket, _restarted) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    assert_eq!(
        reader
            .poll(
                || Ok(()),
                |event| {
                    events.push(event.to_vec());
                    Ok(())
                },
                |_| Ok(())
            )
            .unwrap(),
        1
    );
    let (_, record) = Source::decode(&events[1]).unwrap();
    assert_eq!(
        (record.start, record.end, record.text.as_str()),
        (8, 20, "partialdone")
    );
    assert_eq!(
        reader
            .poll(
                || Err(io::ErrorKind::PermissionDenied.into()),
                |_| panic!("revoked persistence"),
                |_| panic!("revoked checkpoint")
            )
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(reader
        .poll(
            || Ok(()),
            |_| panic!("poisoned persistence"),
            |_| panic!("poisoned checkpoint")
        )
        .is_err());
}

#[test]
fn failed_persistence_leaves_record_replayable() {
    let fixture = Fixture::new();
    let startup = fixture.startup();
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    assert!(reader
        .poll(
            || Ok(()),
            |_| Err(io::ErrorKind::StorageFull.into()),
            |_| panic!("checkpoint before outbox")
        )
        .is_err());
    drop(reader);
    let (socket, _retry) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    assert_eq!(reader.poll(|| Ok(()), |_| Ok(()), |_| Ok(())).unwrap(), 1);
}

#[test]
fn child_refuses_identity_and_symlink_roots_before_reading() {
    let fixture = Fixture::new();
    for change in 0..5 {
        let mut startup = fixture.startup();
        match change {
            0 => startup.uid = 0,
            1 => startup.gid += 1,
            2 => startup.groups.push(0),
            3 => startup.source.lifetime = [0; 16],
            _ => {
                symlink(&fixture.root, fixture.root.join("linked")).unwrap();
                startup.root = fixture.root.join("linked").to_str().unwrap().into();
            }
        }
        let (socket, _child) = spawn();
        assert!(connect(socket, &startup).is_err());
    }
    assert_eq!(
        fs::read(fixture.root.join("session.jsonl")).unwrap(),
        b"{\"a\":1}\npartial"
    );
}

#[test]
fn malformed_and_oversized_socketpair_requests_terminate_child() {
    let fixture = Fixture::new();
    // In place of the broker's binding, then in place of the daemon's startup.
    for bound in [false, true] {
        for packet in [
            vec![0, 0, 128, 0, 1],
            vec![7, 0, 128, 0, 1],
            vec![1, 0, 0, 0, 0],
            vec![0, 0, 0, 0, 1, b'{'],
            vec![7, 0, 0, 0, 1, b'{'],
        ] {
            let (mut socket, _child) = spawn();
            if bound {
                reader::bind(&mut socket, &fixture.startup()).unwrap();
            }
            socket.write_all(&packet).unwrap();
            let mut byte = [0];
            assert_eq!(socket.read(&mut byte).unwrap(), 0, "{bound} {packet:?}");
        }
    }
}

#[test]
fn checkpoint_failure_and_mid_poll_revocation_disconnect_reader() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("session.jsonl"), b"first\nsecond\n").unwrap();
    for revoke in [false, true] {
        let (socket, mut child) = spawn();
        let mut reader = connect(socket, &fixture.startup()).unwrap();
        let calls = std::cell::Cell::new(0);
        let mut records = vec![];
        let mut saves = 0;
        assert!(reader
            .poll(
                || {
                    let count = calls.get();
                    calls.set(count + 1);
                    if revoke && count >= 2 {
                        Err(io::ErrorKind::PermissionDenied.into())
                    } else {
                        Ok(())
                    }
                },
                |bytes| {
                    records.push(Source::decode(bytes).unwrap().1.text);
                    Ok(())
                },
                |_| {
                    saves += 1;
                    Err(io::ErrorKind::StorageFull.into())
                }
            )
            .is_err());
        assert_eq!(
            records,
            if revoke {
                vec!["first"]
            } else {
                vec!["first", "second"]
            }
        );
        assert_eq!(saves, if revoke { 0 } else { 1 });
        // Keep the poisoned parent alive: its socket shutdown must still end
        // the child, so callers cannot accidentally keep a revoked watch alive.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if child.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "reader survived refusal"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let (socket, _retry) = spawn();
    let mut reader = connect(socket, &fixture.startup()).unwrap();
    let mut replay = vec![];
    assert_eq!(
        reader
            .poll(
                || Ok(()),
                |bytes| {
                    replay.push(Source::decode(bytes).unwrap().1.text);
                    Ok(())
                },
                |_| Ok(())
            )
            .unwrap(),
        2
    );
    assert_eq!(replay, vec!["first", "second"]);
}

#[test]
fn parent_refuses_forged_source_and_out_of_order_checkpoint_protocol() {
    let fixture = Fixture::new();
    for forged in [false, true] {
        let startup = fixture.startup();
        let (socket, mut peer) = UnixStream::pair().unwrap();
        let mut source = startup.source.clone();
        source.lifetime = [9; 16];
        let thread = std::thread::spawn(move || {
            fn frame(socket: &mut UnixStream, tag: u8, body: &[u8]) {
                socket.write_all(&[tag]).unwrap();
                socket
                    .write_all(&(body.len() as u32).to_be_bytes())
                    .unwrap();
                socket.write_all(body).unwrap();
            }
            let mut header = [0; 5];
            peer.read_exact(&mut header).unwrap();
            let mut body = vec![0; u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];
            peer.read_exact(&mut body).unwrap();
            frame(&mut peer, 4, &[]);
            peer.read_exact(&mut header).unwrap();
            assert_eq!(header, [1, 0, 0, 0, 0]);
            if forged {
                let event = source
                    .event(&smithers_machined::transcript::Record {
                        generation: 1,
                        start: 0,
                        end: 2,
                        text: "x".into(),
                        skipped: None,
                    })
                    .unwrap();
                frame(&mut peer, 2, &event);
            } else {
                frame(&mut peer, 4, &0u32.to_be_bytes());
            }
            let mut byte = [0];
            assert_eq!(peer.read(&mut byte).unwrap(), 0);
        });
        let mut reader = Reader::connect(socket, &startup).unwrap();
        assert!(reader
            .poll(
                || Ok(()),
                |_| panic!("forged event persisted"),
                |_| panic!("invalid checkpoint persisted")
            )
            .is_err());
        thread.join().unwrap();
    }
}

#[test]
fn maximum_partial_record_checkpoint_crosses_socketpair_and_restarts() {
    let fixture = Fixture::new();
    let size = smithers_machined::transcript::MAX_RECORD_BYTES;
    fs::write(fixture.root.join("session.jsonl"), vec![b'x'; size]).unwrap();
    let mut startup = fixture.startup();
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    let mut checkpoint = vec![];
    for _ in 0..size / smithers_machined::transcript::READ_BYTES {
        assert_eq!(
            reader
                .poll(
                    || Ok(()),
                    |_| panic!("partial record emitted"),
                    |bytes| {
                        checkpoint = bytes.to_vec();
                        Ok(())
                    }
                )
                .unwrap(),
            0
        );
    }
    drop(reader);
    startup.checkpoint = Some(String::from_utf8(checkpoint).unwrap());
    fs::OpenOptions::new()
        .append(true)
        .open(fixture.root.join("session.jsonl"))
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    let (socket, _retry) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    assert_eq!(
        reader
            .poll(
                || Ok(()),
                |bytes| {
                    let (_, record) = Source::decode(bytes).unwrap();
                    assert_eq!((record.start, record.end), (0, 1_048_577));
                    assert_eq!(record.text.len(), 1_048_576);
                    assert!(record.text.bytes().all(|b| b == b'x'));
                    Ok(())
                },
                |_| Ok(())
            )
            .unwrap(),
        1
    );
}

#[test]
fn trickling_peer_cannot_extend_poll_deadline_or_persist_partial_ipc() {
    let fixture = Fixture::new();
    let (socket, mut peer) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || {
        let mut header = [0; 5];
        peer.read_exact(&mut header).unwrap();
        let mut startup = vec![0; u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];
        peer.read_exact(&mut startup).unwrap();
        peer.write_all(&[4, 0, 0, 0, 0]).unwrap();
        peer.read_exact(&mut header).unwrap();
        assert_eq!(header, [1, 0, 0, 0, 0]);
        // An EVENT header plus an incomplete body: none of these bytes may be
        // acknowledged. Each byte arrives well within the syscall timeout.
        peer.write_all(&[2, 0, 0, 0, 100]).unwrap();
        for _ in 0..20 {
            if peer.write_all(&[b'x']).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    let mut reader = Reader::connect(socket, &fixture.startup()).unwrap();
    let start = std::time::Instant::now();
    let error = reader
        .poll(
            || Ok(()),
            |_| panic!("partial event persisted"),
            |_| panic!("partial checkpoint persisted"),
        )
        .unwrap_err();
    assert!(
        matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ),
        "{error}"
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(reader
        .poll(
            || panic!("poisoned reader checked registry"),
            |_| Ok(()),
            |_| Ok(())
        )
        .is_err());
    worker.join().unwrap();
}

#[test]
fn parent_refuses_foreign_or_malformed_checkpoints_before_save_and_ack() {
    let fixture = Fixture::new();
    let mut startup = fixture.startup();
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    let mut checkpoint = Vec::new();
    reader
        .poll(
            || Ok(()),
            |_| Ok(()),
            |bytes| {
                checkpoint = bytes.to_vec();
                Ok(())
            },
        )
        .unwrap();
    drop(reader);
    startup.checkpoint = Some(String::from_utf8(checkpoint.clone()).unwrap());
    for fault in 0..11 {
        let mut state: serde_json::Value = serde_json::from_slice(&checkpoint).unwrap();
        match fault {
            0 => state["owner"] = 0.into(),
            1 => state["owner"] = (startup.uid + 1).into(),
            2 => state["path"] = "unrelated.jsonl".into(),
            3 => state["source"]["session"] = 2.into(),
            4 => state["source"]["profile"] = "codex-rollout/0.160".into(),
            5 => state["source"] = serde_json::Value::Null,
            6 => state["version"] = 2.into(),
            7 => state["framer"]["pending"] = serde_json::json!([10]),
            8 => state["framer"]["generation"] = 0.into(),
            9 => state["framer"]["failed"] = true.into(),
            _ => state["root"] = serde_json::json!([1, 2]),
        }
        let body = serde_json::to_vec(&state).unwrap();
        let (socket, mut peer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let mut header = [0; 5];
            peer.read_exact(&mut header).unwrap();
            let mut request = vec![0; u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];
            peer.read_exact(&mut request).unwrap();
            peer.write_all(&[4, 0, 0, 0, 0]).unwrap();
            peer.read_exact(&mut header).unwrap();
            assert_eq!(header, [1, 0, 0, 0, 0]);
            peer.write_all(&[3]).unwrap();
            peer.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
            peer.write_all(&body).unwrap();
            let mut byte = [0];
            assert_eq!(
                peer.read(&mut byte).unwrap(),
                0,
                "forged checkpoint acknowledged"
            );
        });
        let mut reader = Reader::connect(socket, &startup).unwrap();
        assert!(
            reader
                .poll(
                    || Ok(()),
                    |_| panic!("unexpected event"),
                    |_| panic!("forged checkpoint saved")
                )
                .is_err(),
            "fault {fault}"
        );
        assert!(reader
            .poll(|| panic!("poisoned reader reused"), |_| Ok(()), |_| Ok(()))
            .is_err());
        worker.join().unwrap();
    }
}

#[test]
fn restarted_child_refuses_checkpoint_for_another_process_source_at_startup() {
    let fixture = Fixture::new();
    let mut startup = fixture.startup();
    let (socket, _child) = spawn();
    let mut reader = connect(socket, &startup).unwrap();
    let mut checkpoint = Vec::new();
    reader
        .poll(
            || Ok(()),
            |_| Ok(()),
            |bytes| {
                checkpoint = bytes.to_vec();
                Ok(())
            },
        )
        .unwrap();
    drop(reader);
    startup.checkpoint = Some(String::from_utf8(checkpoint).unwrap());
    startup.source.lifetime = [9; 16];
    let (socket, _restarted) = spawn();
    assert!(connect(socket, &startup).is_err());
    assert_eq!(
        fs::read(fixture.root.join("session.jsonl")).unwrap(),
        b"{\"a\":1}\npartial"
    );
}
