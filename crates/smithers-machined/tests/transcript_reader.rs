#![cfg(target_os = "linux")]
use smithers_machined::transcript::{
    reader::{Reader, Startup},
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

#[test]
fn child_socketpair_outbox_checkpoint_restart_and_revoke() {
    let fixture = Fixture::new();
    let (socket, _child) = spawn();
    let mut startup = fixture.startup();
    let mut reader = Reader::connect(socket, &startup).unwrap();
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
    let mut reader = Reader::connect(socket, &startup).unwrap();
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
    let mut reader = Reader::connect(socket, &startup).unwrap();
    assert!(reader
        .poll(
            || Ok(()),
            |_| Err(io::ErrorKind::StorageFull.into()),
            |_| panic!("checkpoint before outbox")
        )
        .is_err());
    drop(reader);
    let (socket, _retry) = spawn();
    let mut reader = Reader::connect(socket, &startup).unwrap();
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
        assert!(Reader::connect(socket, &startup).is_err());
    }
    assert_eq!(
        fs::read(fixture.root.join("session.jsonl")).unwrap(),
        b"{\"a\":1}\npartial"
    );
}

#[test]
fn malformed_and_oversized_socketpair_requests_terminate_child() {
    for packet in [
        vec![0, 0, 128, 0, 1],
        vec![1, 0, 0, 0, 0],
        vec![0, 0, 0, 0, 1, b'{'],
    ] {
        let (mut socket, _child) = spawn();
        socket.write_all(&packet).unwrap();
        let mut byte = [0];
        assert_eq!(socket.read(&mut byte).unwrap(), 0);
    }
}

#[test]
fn checkpoint_failure_and_mid_poll_revocation_disconnect_reader() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("session.jsonl"), b"first\nsecond\n").unwrap();
    for revoke in [false, true] {
        let (socket, mut child) = spawn();
        let mut reader = Reader::connect(socket, &fixture.startup()).unwrap();
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
    let mut reader = Reader::connect(socket, &fixture.startup()).unwrap();
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
    let mut reader = Reader::connect(socket, &startup).unwrap();
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
    let mut reader = Reader::connect(socket, &startup).unwrap();
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
