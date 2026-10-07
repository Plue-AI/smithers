#![cfg(target_os = "linux")]
use rustix::net::{socketpair, AddressFamily, SocketFlags, SocketType};
use smithers_machined::{
    broker::control::{self, Controls, SocketpairBroker},
    hooks::Sessions,
};
use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Host(Arc<Mutex<Vec<u32>>>);
impl Controls for Host {
    fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
        match op {
            25 => {
                let entries: Vec<_> = self
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|id| smithers_machined::broker::sessions::Entry {
                        id: *id,
                        user: smithers_machined::broker::sessions::User {
                            login: "maya".into(),
                            uid: 20001,
                        },
                        kind: smithers_machined::broker::sessions::Kind::Pty,
                        run: None,
                        principal: [7; 16],
                        closed: false,
                        exited: false,
                        process: None,
                    })
                    .collect();
                serde_json::to_vec(&entries).map_err(io::Error::other)
            }
            18 | 22 | 23 => Ok(vec![]),
            21 => Ok(self
                .0
                .lock()
                .unwrap()
                .iter()
                .flat_map(|id| id.to_be_bytes())
                .collect()),
            _ => Err(io::ErrorKind::Unsupported.into()),
        }
    }
    fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn thaw(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn kill(&mut self) -> io::Result<u16> {
        Err(io::ErrorKind::Unsupported.into())
    }
}
fn broker(
    ids: Vec<u32>,
) -> (
    SocketpairBroker,
    Arc<Mutex<Vec<u32>>>,
    std::thread::JoinHandle<()>,
) {
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let ids = Arc::new(Mutex::new(ids));
    let host = ids.clone();
    let worker = std::thread::spawn(move || control::serve(&parent, &mut Host(host)).unwrap());
    (SocketpairBroker::new(child).unwrap(), ids, worker)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[test]
fn authenticated_snapshot_last_write_heartbeat_close_and_reconnect() {
    let (broker, ids, worker) = broker(vec![2, 1]);
    broker.ready().unwrap();
    broker.where_file(1, "a").unwrap();
    let now = Instant::now();
    let first = broker.poll_presence(now).unwrap().unwrap();
    // Committed ADR 0004 row-4 fixture; no encoder builds the oracle.
    assert_eq!(
        hex(&first.payload),
        "010000001901000200000009010000000102000161000000050100000002"
    );
    assert_eq!((first.kind, first.stream), (3, 0));
    assert!(broker
        .poll_presence(now + Duration::from_millis(9999))
        .unwrap()
        .is_none());
    assert_eq!(
        broker
            .poll_presence(now + Duration::from_secs(10))
            .unwrap()
            .unwrap(),
        first
    );
    broker.where_file(1, "retry.ts").unwrap();
    let moved = broker
        .poll_presence(now + Duration::from_secs(11))
        .unwrap()
        .unwrap();
    assert!(moved.payload.windows(8).any(|p| p == b"retry.ts"));
    // There is no outside-write path: only an attributed live session can move.
    assert_eq!(broker.where_file(77, "outside.ts").unwrap_err().code, 11);
    assert_eq!(broker.last_path(1).as_deref(), Some("retry.ts"));
    ids.lock().unwrap().retain(|id| *id != 1);
    let closed = broker
        .poll_presence(now + Duration::from_millis(11250))
        .unwrap()
        .unwrap();
    assert_eq!(hex(&closed.payload), "010000000c010001000000050100000002");
    assert_eq!(broker.last_path(1), None);
    broker.reset_presence().unwrap();
    assert_eq!(
        broker
            .poll_presence(now + Duration::from_millis(11250))
            .unwrap()
            .unwrap(),
        closed
    );
    ids.lock().unwrap().clear();
    assert_eq!(
        hex(&broker
            .poll_presence(now + Duration::from_millis(11500))
            .unwrap()
            .unwrap()
            .payload),
        "0100000003010000"
    );
    drop(broker);
    worker.join().unwrap();
}
#[test]
fn production_session_poll_carries_presence_and_preserves_stream_polling() {
    let (broker, _, worker) = broker(vec![9]);
    let frames = broker.poll().unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(
        hex(&frames[0].payload),
        "010000000c010001000000050100000009"
    );
    assert!(broker.poll().unwrap().is_empty());
    assert!(broker.poll_local(9).unwrap().is_empty());
    drop(broker);
    worker.join().unwrap();
}
#[test]
fn malformed_or_unavailable_broker_never_publishes_empty_presence() {
    for invalid in [vec![0], vec![0x80000000], vec![1, 1], vec![1; 513]] {
        let (broker, _, worker) = broker(invalid);
        assert_eq!(broker.poll_presence(Instant::now()).unwrap_err().code, 12);
        drop(broker);
        worker.join().unwrap();
    }
}
#[test]
fn invalid_paths_do_not_replace_last_attributed_location() {
    let (broker, _, worker) = broker(vec![1]);
    broker.where_file(1, "retry.ts").unwrap();
    for path in ["", "/secret", "../secret", "a\0b"] {
        assert_eq!(broker.where_file(1, path).unwrap_err().code, 1);
    }
    assert_eq!(broker.where_file(1, &"x".repeat(4097)).unwrap_err().code, 1);
    assert_eq!(broker.last_path(1).as_deref(), Some("retry.ts"));
    drop(broker);
    worker.join().unwrap();
}

#[test]
fn session_moves_coalesce_to_four_snapshots_per_second_and_keep_last_path() {
    let (broker, _, worker) = broker(vec![1]);
    let now = Instant::now();
    let mut count = 0;
    for i in 0..100 {
        broker.where_file(1, &format!("file-{i}.ts")).unwrap();
        if broker
            .poll_presence(now + Duration::from_millis(i * 10))
            .unwrap()
            .is_some()
        {
            count += 1;
        }
    }
    assert_eq!(count, 4);
    let last = broker
        .poll_presence(now + Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert!(last.payload.windows(10).any(|p| p == b"file-99.ts"));
    drop(broker);
    worker.join().unwrap();
}

#[test]
fn lost_broker_connection_is_unknown_on_every_retry() {
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let broker = SocketpairBroker::new(child).unwrap();
    drop(parent);
    for _ in 0..2 {
        assert_eq!(broker.poll_presence(Instant::now()).unwrap_err().code, 12);
    }
}

#[test]
fn snapshot_excludes_forwarding_ended_and_unregistered_agent_sessions() {
    use smithers_machined::broker::sessions::{Entry, Kind, User};
    struct RegistryHost(Vec<Entry>);
    impl Controls for RegistryHost {
        fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
            match op {
                18 | 22 | 23 => Ok(vec![]),
                25 => serde_json::to_vec(&self.0).map_err(io::Error::other),
                _ => Err(io::ErrorKind::Unsupported.into()),
            }
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn thaw(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn kill(&mut self) -> io::Result<u16> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
    let person = User {
        login: "maya".into(),
        uid: 20001,
    };
    let agent = User {
        login: "agent".into(),
        uid: 19999,
    };
    let entries = vec![
        Entry {
            id: 1,
            user: person.clone(),
            kind: Kind::Pty,
            run: None,
            principal: [7; 16],
            closed: false,
            exited: false,
            process: None,
        },
        Entry {
            id: 2,
            user: agent.clone(),
            kind: Kind::Tcp,
            run: None,
            principal: [7; 16],
            closed: false,
            exited: false,
            process: None,
        },
        Entry {
            id: 3,
            user: agent.clone(),
            kind: Kind::Exec,
            run: None,
            principal: [7; 16],
            closed: false,
            exited: false,
            process: None,
        },
        Entry {
            id: 4,
            user: person.clone(),
            kind: Kind::Pty,
            run: None,
            principal: [7; 16],
            closed: true,
            exited: false,
            process: None,
        },
        Entry {
            id: 5,
            user: person,
            kind: Kind::Pty,
            run: None,
            principal: [7; 16],
            closed: false,
            exited: true,
            process: None,
        },
        Entry {
            id: 6,
            user: agent,
            kind: Kind::Exec,
            run: Some("run-6".into()),
            principal: [7; 16],
            closed: false,
            exited: false,
            process: None,
        },
    ];
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker =
        std::thread::spawn(move || control::serve(&parent, &mut RegistryHost(entries)).unwrap());
    let broker = SocketpairBroker::new(child).unwrap();
    assert!(broker.where_file(3, "bad.ts").is_err());
    assert!(broker.where_file(2, "bad.ts").is_err());
    let frame = broker.poll_presence(Instant::now()).unwrap().unwrap();
    // Literal snapshot count and session ids, independent of production encoders.
    assert_eq!(
        hex(&frame.payload),
        "0100000015010002000000050100000001000000050100000006"
    );
    drop(broker);
    worker.join().unwrap();
}

#[test]
fn registry_socketpair_validates_retained_process_owner_before_presence() {
    use smithers_machined::broker::sessions::{Entry, Kind, ProcessIdentity, User};
    struct RegistryHost(Entry);
    impl Controls for RegistryHost {
        fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
            if op == 25 {
                serde_json::to_vec(&vec![self.0.clone()]).map_err(io::Error::other)
            } else {
                Err(io::ErrorKind::Unsupported.into())
            }
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn thaw(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn kill(&mut self) -> io::Result<u16> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
    for valid in [true, false] {
        let process = ProcessIdentity {
            pid: 123,
            start_ticks: 456,
            gid: 20001,
            groups: vec![20000],
            home: if valid { "/home/maya" } else { "/home/ben" }.into(),
        };
        let entry = Entry {
            id: 1,
            user: User {
                login: "maya".into(),
                uid: 20001,
            },
            kind: Kind::Pty,
            run: None,
            principal: [7; 16],
            closed: false,
            exited: false,
            process: Some(process.clone()),
        };
        let (parent, child) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let worker =
            std::thread::spawn(move || control::serve(&parent, &mut RegistryHost(entry)).unwrap());
        let broker = SocketpairBroker::new(child).unwrap();
        if valid {
            let entries = broker.registry().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].process.as_ref(), Some(&process));
            assert!(broker.poll_presence(Instant::now()).unwrap().is_some());
        } else {
            assert!(broker.registry().is_err());
            assert!(broker.poll_presence(Instant::now()).is_err());
        }
        drop(broker);
        worker.join().unwrap();
    }
}

#[test]
fn full_registry_with_process_bindings_uses_bounded_private_packets() {
    use smithers_machined::broker::sessions::{Entry, Kind, ProcessIdentity, User};
    struct RegistryHost(Vec<Entry>);
    impl Controls for RegistryHost {
        fn stream(&mut self, op: u8, _: &[u8]) -> io::Result<Vec<u8>> {
            if op == 25 {
                serde_json::to_vec(&self.0).map_err(io::Error::other)
            } else {
                Err(io::ErrorKind::Unsupported.into())
            }
        }
        fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn thaw(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn kill(&mut self) -> io::Result<u16> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
    let entries: Vec<_> = (1..=512)
        .map(|id| Entry {
            id,
            user: User {
                login: "agent".into(),
                uid: 19999,
            },
            kind: Kind::Pty,
            run: Some("r".repeat(4096)),
            principal: [7; 16],
            closed: false,
            exited: false,
            process: Some(ProcessIdentity {
                pid: id,
                start_ticks: 456,
                gid: 19999,
                groups: vec![20000],
                home: "/home/agent".into(),
            }),
        })
        .collect();
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker =
        std::thread::spawn(move || control::serve(&parent, &mut RegistryHost(entries)).unwrap());
    let broker = SocketpairBroker::new(child).unwrap();
    let actual = broker.registry().unwrap();
    assert_eq!(actual.len(), 512);
    assert_eq!(actual[0].process.as_ref().unwrap().pid, 1);
    assert_eq!(actual[511].process.as_ref().unwrap().pid, 512);
    assert_eq!(actual[511].run.as_ref().unwrap().len(), 4096);
    drop(broker);
    worker.join().unwrap();
}

#[test]
fn malformed_registry_packet_lengths_and_identities_poison_the_private_connection() {
    use rustix::net::{recv, send, RecvFlags, SendFlags};
    for response in [
        vec![0, 0, 0, 1, 25, 1, 0, 0, 1], // declared size exceeds 16 MiB
        vec![0, 0, 0, 2, 25, 0, 0, 0, 2, b'[', b']'], // foreign request id
        vec![0, 0, 0, 1, 25, 0, 0, 0, 1, b'[', b']'], // body exceeds declaration
        vec![0, 0, 0, 1, 25, 0, 0, 0, 3, b'[', b']'], // EOF before declared end
        vec![0, 0, 0, 1, 25, 0, 0, 0],    // incomplete length
    ] {
        let (parent, child) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = [0; 32];
            let (n, _) = recv(&parent, &mut request, RecvFlags::empty()).unwrap();
            assert_eq!(&request[..n], &[0, 0, 0, 1, 25]);
            assert_eq!(
                send(&parent, &response, SendFlags::NOSIGNAL).unwrap(),
                response.len()
            );
        });
        let broker = SocketpairBroker::new(child).unwrap();
        assert!(broker.registry().is_err());
        assert!(broker.registry().is_err());
        drop(broker);
        worker.join().unwrap();
    }
}
