//! W7 control-boundary tests. Kernel is deliberately a test-only dependency;
//! these receipts do not claim real uid/cgroup/PTY execution.
use smithers_machined::{
    broker::{
        control::{self, Controls},
        request::{self, Request},
        sessions::{Kind, User},
    },
    conn::{self, Frame},
    hooks::{self, Hooks},
    lock::LockCx,
    rpc,
};
use std::{
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default)]
struct Kernel {
    calls: Vec<Request>,
    failure: Option<io::ErrorKind>,
    bad_response: bool,
}
impl Controls for Kernel {
    fn freeze(&mut self, _: Duration) -> io::Result<Option<u32>> {
        unreachable!()
    }
    fn thaw(&mut self) -> io::Result<()> {
        unreachable!()
    }
    fn kill(&mut self) -> io::Result<u16> {
        unreachable!()
    }
    fn session(&mut self, request: Request) -> io::Result<Vec<u8>> {
        if let Some(error) = self.failure {
            return Err(error.into());
        }
        let fields = match &request {
            Request::Open { .. } | Request::Tcp(_) => vec![conn::field(1, 7u32.to_be_bytes())],
            Request::KillUser(_) | Request::KillRun(_) => vec![conn::field(1, 2u16.to_be_bytes())],
            Request::Attach { .. } => vec![conn::field(1, 123u64.to_be_bytes())],
            _ => vec![],
        };
        self.calls.push(request);
        Ok(if self.bad_response {
            vec![]
        } else {
            conn::structure_bytes(&fields)
        })
    }
}
struct Bridge(Mutex<Kernel>);
impl hooks::Sessions for Bridge {
    fn call(&self, method: u8, args: &[u8]) -> hooks::Result<Vec<u8>> {
        let response =
            control::handle(&packet(method, args), &mut *self.0.lock().unwrap()).unwrap();
        if response[4] == 255 {
            let fields = conn::fields("error", &response[5..]).unwrap();
            Err(hooks::Error {
                code: fields[0].1[0],
                ..hooks::Error::unsupported()
            })
        } else {
            Ok(response[5..].to_vec())
        }
    }
}
impl hooks::Broker for Bridge {
    fn set_roster(&self, members: &[User]) -> hooks::Result<()> {
        hooks::Sessions::call(self, 16, &request::roster_bytes(members).unwrap()).map(|_| ())
    }
}
fn packet(method: u8, args: &[u8]) -> Vec<u8> {
    [9u32.to_be_bytes().as_slice(), &[method], args].concat()
}
fn string(value: &str) -> Vec<u8> {
    [
        (value.len() as u16).to_be_bytes().as_slice(),
        value.as_bytes(),
    ]
    .concat()
}
fn user(login: &str, uid: u32) -> Vec<u8> {
    conn::structure_bytes(&[
        conn::field(1, string(login)),
        conn::field(2, uid.to_be_bytes()),
    ])
}
fn open(login: &str, uid: u32, kind: u8, argv: &[&str], size: Option<(u16, u16)>) -> Vec<u8> {
    let mut fields = vec![conn::field(1, user(login, uid)), conn::field(2, [kind])];
    if !argv.is_empty() {
        let mut list = (argv.len() as u16).to_be_bytes().to_vec();
        for arg in argv {
            list.extend(string(arg));
        }
        fields.push(conn::field(3, list));
    }
    if let Some((rows, cols)) = size {
        fields.push(conn::field(
            4,
            conn::structure_bytes(&[
                conn::field(1, rows.to_be_bytes()),
                conn::field(2, cols.to_be_bytes()),
            ]),
        ));
    }
    conn::structure_bytes(&fields)
}
fn invoke(cx: &mut LockCx, method: u8, args: &[u8]) -> Frame {
    let frame = Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 9u32.to_be_bytes()),
                conn::field(2, [&[method], args].concat()),
            ],
        ),
    };
    let mut output = vec![];
    rpc::serve_one(&mut frame.encode().unwrap().as_slice(), &mut output, cx).unwrap();
    Frame::decode(&output).unwrap()
}
fn result(frame: &Frame) -> Vec<u8> {
    conn::fields("response", &frame.payload[1..]).unwrap()[1]
        .1
        .to_vec()
}
#[test]
fn session_controls_cross_production_rpc_and_root_dispatch() {
    let bridge = Arc::new(Bridge(Mutex::new(Kernel::default())));
    let mut cx = LockCx::new(Hooks {
        sessions: bridge.clone(),
        broker: bridge.clone(),
        ..Hooks::default()
    });
    let roster = request::roster_bytes(&[User {
        login: "ben".into(),
        uid: 20001,
    }])
    .unwrap();
    assert_eq!(result(&invoke(&mut cx, 16, &roster)), [16, 0, 0, 0, 0]);
    assert_eq!(
        result(&invoke(
            &mut cx,
            6,
            &open("ben", 20001, 2, &["/bin/sh", "-c", "exit 7"], None)
        )),
        [6, 0, 0, 0, 5, 1, 0, 0, 0, 7]
    );
    invoke(&mut cx, 6, &open("agent", 19999, 1, &[], Some((24, 80))));
    invoke(&mut cx, 6, &open("ben", 20001, 3, &[], None));
    invoke(
        &mut cx,
        7,
        &conn::structure_bytes(&[conn::field(1, 8080u16.to_be_bytes())]),
    );
    invoke(
        &mut cx,
        10,
        &conn::structure_bytes(&[
            conn::field(1, string("run-1")),
            conn::field(2, 7u32.to_be_bytes()),
        ]),
    );
    assert_eq!(
        result(&invoke(
            &mut cx,
            15,
            &conn::structure_bytes(&[
                conn::field(1, 7u32.to_be_bytes()),
                conn::field(2, 456u64.to_be_bytes())
            ])
        )),
        [15, 0, 0, 0, 9, 1, 0, 0, 0, 0, 0, 0, 0, 123]
    );
    invoke(
        &mut cx,
        8,
        &conn::structure_bytes(&[conn::field(1, 7u32.to_be_bytes())]),
    );
    for target in [
        conn::tagged(1, &[conn::field(1, user("ben", 20001))]),
        conn::tagged(2, &[conn::field(1, string("run-1"))]),
    ] {
        assert_eq!(
            result(&invoke(
                &mut cx,
                9,
                &conn::structure_bytes(&[conn::field(1, target)])
            )),
            [9, 0, 0, 0, 3, 1, 0, 2]
        );
    }
    let kernel = bridge.0.lock().unwrap();
    assert_eq!(kernel.calls.len(), 10);
    assert_eq!(
        kernel.calls[1],
        Request::Open {
            user: User {
                login: "ben".into(),
                uid: 20001
            },
            kind: Kind::Exec,
            argv: vec!["/bin/sh".into(), "-c".into(), "exit 7".into()],
            size: None
        }
    );
    assert_eq!(
        kernel.calls[6],
        Request::Attach {
            session: 7,
            received: 456
        }
    );
}
#[test]
fn root_validation_refuses_before_provider_effects() {
    let mut kernel = Kernel::default();
    let mut cases = vec![];
    for (login, uid) in [
        ("root", 0),
        ("root", 20001),
        ("agent", 20001),
        ("ben", 19999),
        ("../ben", 20001),
        ("ben\0x", 20001),
    ] {
        cases.push((6, open(login, uid, 1, &[], None)));
    }
    for (kind, argv, size) in [
        (2, vec![], None),
        (2, vec![""], None),
        (3, vec!["/workspace/server"], None),
        (2, vec!["sh"], Some((24, 80))),
        (1, vec![], Some((0, 80))),
        (1, vec!["a\0b"], None),
    ] {
        cases.push((6, open("ben", 20001, kind, &argv, size)));
    }
    cases.push((
        7,
        conn::structure_bytes(&[conn::field(1, 0u16.to_be_bytes())]),
    ));
    for id in [0u32, 0x80000000, u32::MAX] {
        cases.push((
            8,
            conn::structure_bytes(&[conn::field(1, id.to_be_bytes())]),
        ));
        cases.push((
            15,
            conn::structure_bytes(&[
                conn::field(1, id.to_be_bytes()),
                conn::field(2, 0u64.to_be_bytes()),
            ]),
        ));
    }
    cases.push((
        10,
        conn::structure_bytes(&[
            conn::field(1, string("")),
            conn::field(2, 1u32.to_be_bytes()),
        ]),
    ));
    for (method, args) in cases {
        let bytes = control::handle(&packet(method, &args), &mut kernel).unwrap();
        assert_eq!(bytes[4], 255, "method {method}");
        assert_eq!(conn::fields("error", &bytes[5..]).unwrap()[0].1, [1]);
    }
    assert!(kernel.calls.is_empty());
    let valid = packet(6, &open("ben", 20001, 2, &["true"], None));
    for n in 0..valid.len() {
        if let Ok(response) = control::handle(&valid[..n], &mut kernel) {
            assert_eq!(response[4], 255);
        }
    }
    assert!(kernel.calls.is_empty());
    for members in [
        vec![User {
            login: "agent".into(),
            uid: 19999,
        }],
        vec![
            User {
                login: "ben".into(),
                uid: 20001
            };
            2
        ],
        vec![
            User {
                login: "ben".into(),
                uid: 20001,
            },
            User {
                login: "ben".into(),
                uid: 20002,
            },
        ],
    ] {
        assert!(request::roster_bytes(&members).is_err());
    }
}
#[test]
fn missing_providers_and_cleanup_failures_remain_typed() {
    let bridge = Arc::new(Bridge(Mutex::new(Kernel::default())));
    let mut cx = LockCx::new(Hooks {
        sessions: bridge.clone(),
        ..Hooks::default()
    });
    for (failure, code) in [
        (io::ErrorKind::Unsupported, 2),
        (io::ErrorKind::PermissionDenied, 11),
        (io::ErrorKind::NotFound, 5),
        (io::ErrorKind::TimedOut, 9),
    ] {
        bridge.0.lock().unwrap().failure = Some(failure);
        let response = result(&invoke(
            &mut cx,
            8,
            &conn::structure_bytes(&[conn::field(1, 7u32.to_be_bytes())]),
        ));
        assert_eq!(response[0], 255);
        assert_eq!(conn::fields("error", &response[1..]).unwrap()[0].1, [code]);
    }
    bridge.0.lock().unwrap().failure = None;
    bridge.0.lock().unwrap().bad_response = true;
    let response = result(&invoke(&mut cx, 6, &open("ben", 20001, 1, &[], None)));
    assert_eq!(conn::fields("error", &response[1..]).unwrap()[0].1, [12]);
    let mut disabled = LockCx::new(Hooks::default());
    let response = result(&invoke(&mut disabled, 6, &open("ben", 20001, 1, &[], None)));
    assert_eq!(conn::fields("error", &response[1..]).unwrap()[0].1, [2]);
}

#[cfg(target_os = "linux")]
#[test]
fn production_socketpair_session_calls_and_roster() {
    use rustix::net::{socketpair, AddressFamily, SocketFlags, SocketType};
    let (parent, child) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let worker = std::thread::spawn(move || {
        let mut kernel = Kernel::default();
        control::serve(&parent, &mut kernel).unwrap();
        kernel.calls
    });
    let bridge = Arc::new(control::SocketpairBroker::new(child).unwrap());
    let mut cx = LockCx::new(Hooks {
        sessions: bridge.clone(),
        broker: bridge.clone(),
        ..Hooks::default()
    });
    let roster = request::roster_bytes(&[User {
        login: "ben".into(),
        uid: 20001,
    }])
    .unwrap();
    assert_eq!(result(&invoke(&mut cx, 16, &roster)), [16, 0, 0, 0, 0]);
    assert_eq!(
        result(&invoke(
            &mut cx,
            6,
            &open("ben", 20001, 2, &["/bin/sh", "-c", "exit 7"], None)
        )),
        [6, 0, 0, 0, 5, 1, 0, 0, 0, 7]
    );
    let response = result(&invoke(&mut cx, 6, &open("root", 0, 1, &[], None)));
    assert_eq!(conn::fields("error", &response[1..]).unwrap()[0].1, [1]);
    assert!(
        hooks::Sessions::ready(&*bridge).is_err(),
        "transport alone is not a ready supervisor"
    );
    drop(cx);
    drop(bridge);
    assert_eq!(worker.join().unwrap().len(), 2);
}

#[test]
fn one_gib_output_stalls_at_credit_then_resumes_without_loss() {
    use smithers_machined::{credit::ReadOutcome, stream::SessionSender};
    use std::io::Read;
    struct Source {
        offset: usize,
    }
    impl Read for Source {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.offset == 1_073_741_824 {
                return Ok(0);
            }
            assert_eq!(bytes.len(), 65_536);
            bytes.fill(((self.offset / 65_536) % 251) as u8);
            self.offset += bytes.len();
            Ok(bytes.len())
        }
    }
    let mut source = Source { offset: 0 };
    let mut sender = SessionSender::default();
    for _ in 0..4 {
        assert!(matches!(
            sender.read(&mut source).unwrap(),
            ReadOutcome::Data(_)
        ));
    }
    for _ in 0..1000 {
        assert_eq!(sender.read(&mut source).unwrap(), ReadOutcome::Blocked);
    }
    assert_eq!(
        source.offset, 262_144,
        "stalled peer must not cause more source reads"
    );
    let replay = sender.attach(0).unwrap();
    assert_eq!(replay.len(), 262_144);
    for (n, chunk) in replay.chunks(65_536).enumerate() {
        assert_eq!(chunk, vec![n as u8; 65_536]);
    }
    drop(replay);
    sender.window(262_144).unwrap();
    let mut received = 262_144;
    loop {
        match sender.read(&mut source).unwrap() {
            ReadOutcome::Data(bytes) => {
                assert_eq!(bytes, vec![((received / 65_536) % 251) as u8; 65_536]);
                received += bytes.len();
                sender.window(bytes.len() as u32).unwrap();
            }
            ReadOutcome::Eof => break,
            ReadOutcome::Blocked => panic!("returned credit did not unblock output"),
        }
    }
    assert_eq!(received, 1_073_741_824);
    assert!(sender.attach(received as u64).unwrap().is_empty());
}

#[test]
fn failed_roster_rpc_fences_local_run_until_cleanup_receipt() {
    use smithers_machined::broker::sessions::{Controls as SessionControls, Sessions};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;
    struct Cleanup(Arc<AtomicBool>);
    impl SessionControls for Cleanup {
        fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
            Ok(())
        }
        fn kill(&mut self, _: u32, _: Instant) -> io::Result<()> {
            if self.0.load(Ordering::SeqCst) {
                Err(io::Error::other("populated 1"))
            } else {
                Ok(())
            }
        }
    }
    struct Boundary(Mutex<Sessions<Cleanup>>);
    impl hooks::Broker for Boundary {
        fn set_roster(&self, members: &[User]) -> hooks::Result<()> {
            self.0
                .lock()
                .unwrap()
                .set_roster(members, Instant::now())
                .map_err(|_| hooks::Error {
                    code: 12,
                    ..hooks::Error::unsupported()
                })
        }
    }
    impl hooks::Sessions for Boundary {
        fn run_of_cgroup(&self, path: &str) -> Option<String> {
            let id = path.strip_prefix("/smithers/sessions/")?.parse().ok()?;
            self.0
                .lock()
                .unwrap()
                .local_run(19999, id)
                .ok()
                .map(str::to_owned)
        }
    }
    let stalled = Arc::new(AtomicBool::new(false));
    let boundary = Arc::new(Boundary(Mutex::new(Sessions::new(Cleanup(
        stalled.clone(),
    )))));
    let mut cx = LockCx::new(Hooks {
        broker: boundary.clone(),
        sessions: boundary.clone(),
        ..Hooks::default()
    });
    let ben = User {
        login: "ben".into(),
        uid: 20001,
    };
    assert_eq!(
        result(&invoke(
            &mut cx,
            16,
            &request::roster_bytes(&[ben.clone()]).unwrap()
        )),
        [16, 0, 0, 0, 0]
    );
    {
        let mut registry = boundary.0.lock().unwrap();
        registry.insert(1, ben, Kind::Exec).unwrap();
        registry
            .insert(
                2,
                User {
                    login: "agent".into(),
                    uid: 19999,
                },
                Kind::Exec,
            )
            .unwrap();
        registry.register_run(2, "trusted-run").unwrap();
    }
    assert_eq!(
        hooks::Sessions::run_of_cgroup(&*boundary, "/smithers/sessions/2"),
        Some("trusted-run".into())
    );
    stalled.store(true, Ordering::SeqCst);
    assert_eq!(
        result(&invoke(&mut cx, 16, &request::roster_bytes(&[]).unwrap()))[0],
        255
    );
    assert_eq!(
        hooks::Sessions::run_of_cgroup(&*boundary, "/smithers/sessions/2"),
        None
    );
    #[cfg(target_os = "linux")]
    assert_eq!(
        smithers_machined::local::run_for_peer(19999, "0::/smithers/sessions/2\n", &*boundary)
            .unwrap_err()
            .code,
        11
    );
    stalled.store(false, Ordering::SeqCst);
    assert_eq!(
        result(&invoke(&mut cx, 16, &request::roster_bytes(&[]).unwrap())),
        [16, 0, 0, 0, 0]
    );
    assert_eq!(
        hooks::Sessions::run_of_cgroup(&*boundary, "/smithers/sessions/2"),
        Some("trusted-run".into())
    );
    assert_eq!(
        boundary
            .0
            .lock()
            .unwrap()
            .entries()
            .map(|e| e.id)
            .collect::<Vec<_>>(),
        [2]
    );
}
