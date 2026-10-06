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
                conn::field(1, cols.to_be_bytes()),
                conn::field(2, rows.to_be_bytes()),
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
            &request::roster_bytes(std::slice::from_ref(&ben)).unwrap()
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

mod descriptor_stream {
    use super::*;
    use smithers_machined::session_stream::{Exit, Input, Pipe};
    use std::{
        io::{Read, Write},
        process::{ChildStdin, Command, Stdio},
    };

    struct Stdin(Option<ChildStdin>);
    impl Write for Stdin {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .as_mut()
                .ok_or(io::ErrorKind::BrokenPipe)?
                .write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Input for Stdin {
        fn eof(&mut self) -> io::Result<()> {
            self.0.take();
            Ok(())
        }
        fn close(&mut self) -> io::Result<()> {
            self.eof()
        }
        fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
            Err(io::ErrorKind::Unsupported.into())
        }
        fn signal(&mut self, _: u8) -> io::Result<()> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
    fn frame(payload: Vec<u8>) -> Frame {
        Frame {
            kind: 5,
            stream: 17,
            payload,
        }
    }
    fn data(bytes: &[u8]) -> Frame {
        frame([&[1, 0], bytes].concat())
    }
    fn window(bytes: u32) -> Frame {
        frame([&[6], bytes.to_be_bytes().as_slice()].concat())
    }

    // Test-only wiring of the descriptor module into the production RPC boundary.
    // Child processes inherit this test's unprivileged uid; this is not a root
    // broker or an install-activation receipt.
    struct Provider(Mutex<Pipe<Stdin>>);
    impl hooks::Sessions for Provider {
        fn frame(&self, frame: &Frame) -> hooks::Result<Option<Frame>> {
            let mut pipe = self.0.lock().unwrap();
            pipe.accept(frame)
                .and_then(|()| pipe.flush())
                .map_err(|_| hooks::Error {
                    code: 1,
                    ..hooks::Error::unsupported()
                })
        }
    }
    fn dispatch(cx: &mut LockCx, frame: Frame) -> Frame {
        let mut out = Vec::new();
        rpc::serve_one(&mut frame.encode().unwrap().as_slice(), &mut out, cx).unwrap();
        Frame::decode(&out).unwrap()
    }

    #[test]
    fn one_mib_half_close_reaches_real_wc_through_rpc() {
        let mut child = Command::new("/usr/bin/wc")
            .arg("-c")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let provider = Arc::new(Provider(Mutex::new(
            Pipe::new(17, Stdin(child.stdin.take()), false).unwrap(),
        )));
        let mut cx = LockCx::new(Hooks {
            sessions: provider.clone(),
            ..Hooks::default()
        });
        for _ in 0..16 {
            assert_eq!(
                dispatch(&mut cx, data(&vec![b'x'; 65_536])).payload,
                [6, 0, 1, 0, 0]
            );
        }
        let mut pipe = provider.0.lock().unwrap();
        pipe.accept(&frame(vec![2, 0])).unwrap();
        assert_eq!(pipe.flush().unwrap(), None);
        let stdout = child.stdout.as_mut().unwrap();
        let mut output = Vec::new();
        loop {
            let f = pipe.poll(1, stdout).unwrap().unwrap();
            if f.payload == [2, 1] {
                break;
            }
            output.extend_from_slice(&f.payload[2..]);
            pipe.accept(&window((f.payload.len() - 2) as u32)).unwrap();
        }
        assert_eq!(String::from_utf8(output).unwrap().trim(), "1048576");
        assert_eq!(pipe.received(), 1_048_576);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn real_exit_status_waits_for_both_output_eofs() {
        use std::os::unix::process::ExitStatusExt;
        for (script, expected) in [
            ("printf out; printf err >&2; exit 7", Exit::Code(7)),
            (
                "printf out; printf err >&2; kill -TERM $$",
                Exit::Signal {
                    signal: 2,
                    core: false,
                },
            ),
        ] {
            let mut child = Command::new("/bin/sh")
                .args(["-c", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut pipe = Pipe::new(17, Stdin(child.stdin.take()), true).unwrap();
            let status = child.wait().unwrap();
            let exit = if let Some(code) = status.code() {
                Exit::Code(code)
            } else {
                assert_eq!(status.signal(), Some(15));
                Exit::Signal {
                    signal: 2,
                    core: status.core_dumped(),
                }
            };
            assert_eq!(exit, expected);
            pipe.exited(exit).unwrap();
            assert!(pipe.poll_exit().is_none());
            let mut stdout = child.stdout.take().unwrap();
            assert_eq!(
                pipe.poll(1, &mut stdout).unwrap().unwrap().payload,
                b"\x01\x01out"
            );
            assert_eq!(pipe.poll(1, &mut stdout).unwrap().unwrap().payload, [2, 1]);
            assert!(pipe.poll_exit().is_none());
            let mut stderr = child.stderr.take().unwrap();
            assert_eq!(
                pipe.poll(2, &mut stderr).unwrap().unwrap().payload,
                b"\x01\x02err"
            );
            assert_eq!(pipe.poll(2, &mut stderr).unwrap().unwrap().payload, [2, 2]);
            let exit = pipe.poll_exit().unwrap();
            assert_eq!(
                exit.payload,
                if expected == Exit::Code(7) {
                    vec![5, 0, 0, 0, 0, 7]
                } else {
                    vec![5, 1, 2, 0]
                }
            );
            Frame::decode(&exit.encode().unwrap()).unwrap();
            assert!(pipe.poll_exit().is_none());
            let replay = pipe.attach(6).unwrap().1;
            assert_eq!(
                replay.iter().map(|f| f.payload.clone()).collect::<Vec<_>>(),
                [vec![2, 1], vec![2, 2], exit.payload]
            );
        }
    }

    #[derive(Default)]
    struct Slow {
        bytes: Vec<u8>,
        calls: usize,
        eof: bool,
        closed: bool,
        controls: Vec<String>,
    }
    impl Write for Slow {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.calls += 1;
            match self.calls {
                1 => {
                    self.bytes.extend_from_slice(&bytes[..2]);
                    Ok(2)
                }
                2 => Err(io::ErrorKind::Interrupted.into()),
                3 => Err(io::ErrorKind::WouldBlock.into()),
                _ => {
                    self.bytes.extend_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Input for Slow {
        fn eof(&mut self) -> io::Result<()> {
            self.eof = true;
            Ok(())
        }
        fn close(&mut self) -> io::Result<()> {
            self.closed = true;
            Ok(())
        }
        fn resize(&mut self, rows: u16, cols: u16) -> io::Result<()> {
            self.controls.push(format!("{rows}x{cols}"));
            Ok(())
        }
        fn signal(&mut self, signal: u8) -> io::Result<()> {
            self.controls.push(format!("signal:{signal}"));
            Ok(())
        }
    }
    #[test]
    fn partial_stdin_delivery_defers_eof_and_returns_only_consumed_credit() {
        let mut pipe = Pipe::new(17, Slow::default(), false).unwrap();
        pipe.accept(&data(b"abcdef")).unwrap();
        pipe.accept(&frame(vec![2, 0])).unwrap();
        assert!(pipe.accept(&data(b"later")).is_err());
        assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 0, 0, 2]);
        assert_eq!(pipe.received(), 2);
        assert_eq!(pipe.buffered_input(), 4);
        assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 0, 0, 4]);
        assert_eq!(pipe.received(), 6);
        assert_eq!(pipe.flush().unwrap(), None);
        assert!(pipe.attach(1).is_err());
        assert_eq!(pipe.attach(0).unwrap().0, 6);
    }
    #[test]
    fn shared_credit_and_fd_replay_remain_bounded() {
        use std::io::Cursor;
        struct NoRead;
        impl Read for NoRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                panic!("read at zero credit");
            }
        }
        let mut pipe = Pipe::new(17, Slow::default(), true).unwrap();
        for fd in [1, 2, 1, 2] {
            assert_eq!(
                pipe.poll(fd, &mut Cursor::new(vec![fd; 65_536]))
                    .unwrap()
                    .unwrap()
                    .payload
                    .len(),
                65_538
            );
        }
        assert_eq!(pipe.poll(1, &mut NoRead).unwrap(), None);
        assert_eq!(pipe.poll(2, &mut NoRead).unwrap(), None);
        assert!(pipe.attach(262_145).is_err());
        let (_, replay) = pipe.attach(65_537).unwrap();
        assert_eq!(
            replay.iter().map(|f| f.payload.len() - 2).sum::<usize>(),
            196_607
        );
        assert_eq!(
            replay.iter().map(|f| f.payload[1]).collect::<Vec<_>>(),
            [2, 1, 2]
        );
        assert_eq!(
            replay[0].payload,
            [&[1, 2], vec![2; 65_535].as_slice()].concat()
        );
        assert_eq!(pipe.attach(65_537).unwrap().1, replay);
        assert!(pipe.attach(65_536).is_err());
        pipe.accept(&window(196_607)).unwrap();
        assert!(pipe.attach(262_144).unwrap().1.is_empty());
        assert_eq!(
            pipe.poll(1, &mut Cursor::new(b"resume"))
                .unwrap()
                .unwrap()
                .payload,
            b"\x01\x01resume"
        );
    }
    #[test]
    fn wrong_direction_and_malformed_controls_have_no_effect() {
        let mut pipe = Pipe::new(17, Slow::default(), false).unwrap();
        for payload in [
            vec![1, 1, 5],
            vec![2, 2],
            vec![3, 0, 0, 0, 80],
            vec![3, 0, 24, 0, 0],
            vec![4, 8],
            vec![5, 0, 0, 0, 0, 7],
            vec![255, 0, 0, 0, 0],
        ] {
            assert!(pipe.accept(&frame(payload)).is_err());
        }
        let mut wrong = data(b"wrong");
        wrong.stream = 18;
        assert!(pipe.accept(&wrong).is_err());
        assert_eq!(pipe.received(), 0);
        assert_eq!(pipe.buffered_input(), 0);
        pipe.accept(&frame(vec![3, 0, 24, 0, 80])).unwrap();
        pipe.accept(&frame(vec![4, 1])).unwrap();
        pipe.accept(&frame(vec![7])).unwrap();
        pipe.close().unwrap();
        assert!(pipe.accept(&data(b"after close")).is_err());
        assert!(pipe.attach(0).is_err());
        assert!(pipe.flush().is_err());
        assert!(pipe.poll(1, &mut b"output".as_slice()).is_err());
        assert!(pipe.exited(Exit::Code(0)).is_err());
    }
    #[test]
    fn real_one_gib_writer_stalls_then_delivers_with_bounded_rss() {
        fn rss() -> usize {
            let output = Command::new("/bin/ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout)
                .unwrap()
                .trim()
                .parse()
                .unwrap()
        }
        let baseline_rss_kib = rss();
        let mut child = Command::new("/usr/bin/head")
            .args(["-c", "1073741824", "/dev/zero"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut pipe = Pipe::new(17, Stdin(child.stdin.take()), false).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut received = 0usize;
        while received < 262_144 {
            let f = pipe.poll(1, &mut stdout).unwrap().unwrap();
            assert_eq!(&f.payload[..2], [1, 1]);
            assert!(f.payload[2..].iter().all(|b| *b == 0));
            received += f.payload.len() - 2;
        }
        // Kernel pipe fills while the reader is deliberately stalled. Credit
        // prevents any further descriptor reads, regardless of writer size.
        assert_eq!(pipe.poll(1, &mut stdout).unwrap(), None);
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none());
        let stalled_rss_kib = rss();
        assert!(
            stalled_rss_kib <= baseline_rss_kib + 16_384,
            "stalled RSS grew beyond 16 MiB: {baseline_rss_kib} -> {stalled_rss_kib} KiB"
        );
        eprintln!("descriptor test RSS baseline={baseline_rss_kib} stalled={stalled_rss_kib} KiB");
        let (_, replay) = pipe.attach(0).unwrap();
        assert_eq!(
            replay.iter().map(|f| f.payload.len() - 2).sum::<usize>(),
            262_144
        );
        assert!(replay
            .iter()
            .all(|f| f.payload[2..].iter().all(|b| *b == 0)));
        drop(replay);
        pipe.accept(&window(262_144)).unwrap();
        loop {
            let f = pipe.poll(1, &mut stdout).unwrap().unwrap();
            if f.payload == [2, 1] {
                break;
            }
            assert_eq!(&f.payload[..2], [1, 1]);
            assert!(f.payload[2..].iter().all(|b| *b == 0));
            let count = f.payload.len() - 2;
            received += count;
            pipe.accept(&window(count as u32)).unwrap();
        }
        assert_eq!(received, 1_073_741_824);
        assert_eq!(
            pipe.attach(received as u64)
                .unwrap()
                .1
                .iter()
                .map(|f| f.payload.clone())
                .collect::<Vec<_>>(),
            [vec![2, 1]]
        );
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn real_ten_second_detach_replays_missing_stdout_and_stderr() {
        use smithers_machined::broker::sessions::{Controls as LifetimeControls, Sessions};
        use std::time::Instant;
        struct Lifetime;
        impl LifetimeControls for Lifetime {
            fn close(&mut self, _: u32, _: Kind) -> io::Result<()> {
                Ok(())
            }
            fn kill(&mut self, _: u32, _: Instant) -> io::Result<()> {
                Ok(())
            }
        }
        let mut registry = Sessions::new(Lifetime);
        let ben = User {
            login: "ben".into(),
            uid: 20001,
        };
        registry.set_roster(std::slice::from_ref(&ben), Instant::now()).unwrap();
        registry.insert(17, ben, Kind::Exec).unwrap();
        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf abcdef; printf ghijkl >&2"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut pipe = Pipe::new(17, Stdin(child.stdin.take()), true).unwrap();
        let out = pipe
            .poll(1, child.stdout.as_mut().unwrap())
            .unwrap()
            .unwrap();
        let err = pipe
            .poll(2, child.stderr.as_mut().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(out.payload, b"\x01\x01abcdef");
        assert_eq!(err.payload, b"\x01\x02ghijkl");
        // The peer received only the first three bytes, and lost its window.
        registry.disconnected(Instant::now());
        let disconnected = Instant::now();
        std::thread::sleep(Duration::from_secs(10));
        assert!(disconnected.elapsed() >= Duration::from_secs(10));
        registry.attach(17, Instant::now()).unwrap();
        let (input_received, replay) = pipe.attach(3).unwrap();
        assert_eq!(input_received, 0);
        assert_eq!(
            replay.iter().map(|f| f.payload.clone()).collect::<Vec<_>>(),
            [b"\x01\x01def".to_vec(), b"\x01\x02ghijkl".to_vec()]
        );
        pipe.accept(&window(9)).unwrap();
        assert!(pipe.attach(12).unwrap().1.is_empty());
        assert!(child.wait().unwrap().success());
    }
    #[test]
    fn invalid_frames_and_over_credit_preserve_descriptor_state() {
        #[derive(Default)]
        struct Probe(Arc<Mutex<Vec<String>>>);
        impl Write for Probe {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0
                    .lock()
                    .unwrap()
                    .push(format!("write:{}", bytes.len()));
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Input for Probe {
            fn eof(&mut self) -> io::Result<()> {
                self.0.lock().unwrap().push("eof".into());
                Ok(())
            }
            fn close(&mut self) -> io::Result<()> {
                self.0.lock().unwrap().push("close".into());
                Ok(())
            }
            fn resize(&mut self, rows: u16, cols: u16) -> io::Result<()> {
                self.0.lock().unwrap().push(format!("{rows}x{cols}"));
                Ok(())
            }
            fn signal(&mut self, signal: u8) -> io::Result<()> {
                self.0.lock().unwrap().push(format!("signal:{signal}"));
                Ok(())
            }
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut pipe = Pipe::new(17, Probe(calls.clone()), false).unwrap();
        for id in [0, 0x80000000, u32::MAX] {
            assert!(Pipe::new(id, Probe::default(), false).is_err());
        }
        for payload in [
            vec![1, 1, 5],
            vec![2, 1],
            vec![3, 0, 0, 0, 80],
            vec![4, 0],
            vec![5, 0, 0, 0, 0, 7],
        ] {
            assert!(pipe.accept(&frame(payload)).is_err());
        }
        assert!(calls.lock().unwrap().is_empty());
        // Wire resize is columns then rows, while the OS adapter takes rows/cols.
        pipe.accept(&frame(vec![3, 0, 80, 0, 24])).unwrap();
        for signal in 1..=7 {
            pipe.accept(&frame(vec![4, signal])).unwrap();
        }
        assert_eq!(calls.lock().unwrap()[0], "24x80");
        assert_eq!(calls.lock().unwrap().len(), 8);
        for _ in 0..4 {
            pipe.accept(&data(&vec![1; 65_536])).unwrap();
        }
        assert!(pipe.accept(&data(b"over credit")).is_err());
        assert_eq!(pipe.buffered_input(), 262_144);
        pipe.accept(&frame(vec![2, 0])).unwrap();
        assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 4, 0, 0]);
        assert_eq!(pipe.buffered_input(), 0);
        assert_eq!(pipe.received(), 262_144);
        assert_eq!(calls.lock().unwrap().last().unwrap(), "eof");
        let count = calls.lock().unwrap().len();
        assert_eq!(pipe.flush().unwrap(), None);
        assert_eq!(calls.lock().unwrap().len(), count, "EOF delivered once");
        pipe.close().unwrap();
        pipe.close().unwrap();
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.as_str() == "close")
                .count(),
            1
        );
    }

    #[test]
    fn descriptor_errors_preserve_delivered_offsets_and_pending_bytes() {
        struct Broken {
            first: bool,
            kind: io::ErrorKind,
        }
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                if self.first {
                    self.first = false;
                    return Ok(2);
                }
                if self.kind == io::ErrorKind::WriteZero {
                    Ok(0)
                } else {
                    Err(self.kind.into())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Input for Broken {
            fn eof(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn close(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::Other.into())
            }
            fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
                Err(io::ErrorKind::Unsupported.into())
            }
            fn signal(&mut self, _: u8) -> io::Result<()> {
                Err(io::ErrorKind::Unsupported.into())
            }
        }
        for kind in [
            io::ErrorKind::WriteZero,
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::WouldBlock,
        ] {
            let mut pipe = Pipe::new(17, Broken { first: true, kind }, false).unwrap();
            pipe.accept(&data(b"abcdef")).unwrap();
            assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 0, 0, 2]);
            assert_eq!(pipe.received(), 2);
            assert_eq!(pipe.buffered_input(), 4);
            if kind == io::ErrorKind::WouldBlock {
                assert_eq!(pipe.flush().unwrap(), None);
            } else {
                assert_eq!(pipe.flush().unwrap_err().kind(), kind);
            }
            assert_eq!(pipe.received(), 2);
            assert_eq!(pipe.buffered_input(), 4);
            assert!(pipe.accept(&frame(vec![3, 0, 80, 0, 24])).is_err());
            assert!(pipe.accept(&frame(vec![4, 1])).is_err());
            assert!(pipe.close().is_err());
            assert_eq!(pipe.buffered_input(), 4, "failed close retains retry state");
            assert!(pipe
                .exited(Exit::Signal {
                    signal: 0,
                    core: false
                })
                .is_err());
            pipe.exited(Exit::Code(7)).unwrap();
            assert!(pipe.exited(Exit::Code(8)).is_err());
            assert!(pipe.poll(0, &mut b"x".as_slice()).is_err());
            assert!(pipe.poll(2, &mut b"x".as_slice()).is_err());
        }
        struct BadRead;
        impl Read for BadRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::Other.into())
            }
        }
        let mut pipe = Pipe::new(17, Slow::default(), false).unwrap();
        assert!(pipe.poll(1, &mut BadRead).is_err());
        assert!(pipe.attach(0).unwrap().1.is_empty());
        let mut blocked = Broken {
            first: false,
            kind: io::ErrorKind::WouldBlock,
        };
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(self.kind.into())
            }
        }
        assert_eq!(pipe.poll(1, &mut blocked).unwrap(), None);
    }
    #[test]
    fn reattach_discards_only_undelivered_stdin_before_peer_replay() {
        struct Trickle {
            calls: usize,
            delivered: Arc<Mutex<Vec<u8>>>,
            eof: Arc<Mutex<usize>>,
        }
        impl Write for Trickle {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.calls += 1;
                if self.calls == 2 {
                    return Err(io::ErrorKind::WouldBlock.into());
                }
                let n = if self.calls == 1 { 2 } else { bytes.len() };
                self.delivered
                    .lock()
                    .unwrap()
                    .extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Input for Trickle {
            fn eof(&mut self) -> io::Result<()> {
                *self.eof.lock().unwrap() += 1;
                Ok(())
            }
            fn close(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
                Ok(())
            }
            fn signal(&mut self, _: u8) -> io::Result<()> {
                Ok(())
            }
        }
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let eofs = Arc::new(Mutex::new(0));
        let mut pipe = Pipe::new(
            17,
            Trickle {
                calls: 0,
                delivered: delivered.clone(),
                eof: eofs.clone(),
            },
            false,
        )
        .unwrap();
        pipe.accept(&data(b"abcdef")).unwrap();
        pipe.accept(&frame(vec![2, 0])).unwrap();
        assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 0, 0, 2]);
        assert_eq!(pipe.received(), 2);
        assert_eq!(pipe.buffered_input(), 4);
        assert!(pipe.attach(1).is_err()); // invalid output offset is atomic
        assert_eq!(pipe.buffered_input(), 4);
        assert_eq!(pipe.attach(0).unwrap().0, 2);
        assert_eq!(pipe.buffered_input(), 0);
        assert_eq!(*eofs.lock().unwrap(), 0);
        // Host resumes from the broker's actual delivery offset, including EOF.
        pipe.accept(&data(b"cdef")).unwrap();
        pipe.accept(&frame(vec![2, 0])).unwrap();
        assert_eq!(pipe.flush().unwrap().unwrap().payload, [6, 0, 0, 0, 4]);
        assert_eq!(delivered.lock().unwrap().as_slice(), b"abcdef");
        assert_eq!(*eofs.lock().unwrap(), 1);
        assert_eq!(pipe.attach(0).unwrap().0, 6);
        assert!(pipe.accept(&data(b"after eof")).is_err());
        pipe.accept(&frame(vec![2, 0])).unwrap();
        pipe.flush().unwrap();
        assert_eq!(
            *eofs.lock().unwrap(),
            1,
            "lost EOF control may be replayed safely"
        );
    }
}
