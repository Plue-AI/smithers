use smithers_machined::{
    client,
    conn::{self, Frame},
    hooks::Actor,
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}
#[test]
fn client_write_refusal_over_local_socket_and_actor_from_admission() {
    let request = client::request(
        &args(&["write-file", "a", "--base", "absent"]),
        &mut &b"new"[..],
    )
    .unwrap();
    let (_, method, body) = request.request().unwrap();
    assert_eq!(method, 3);
    let write = conn::local_write_args(body, [7; 16]).unwrap();
    assert_eq!(write.actor, Actor::Principal(vec![7; 16]));
    assert_eq!(write.content, b"new");
    let (mut caller, mut server) = UnixStream::pair().unwrap();
    let expected = request.encode_local().unwrap();
    let thread = std::thread::spawn(move || {
        let mut bytes = vec![0; expected.len()];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, expected);
        let response = smithers_machined::daemon::refused(
            1,
            smithers_machined::hooks::Error {
                code: 4,
                current_digest: Some([9; 32]),
                ..smithers_machined::hooks::Error::unsupported()
            },
        );
        response.write(&mut server).unwrap();
    });
    let mut output = vec![];
    assert!(!client::exchange(&mut caller, &request, &mut output).unwrap());
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!(
            "{{\"error\":{{\"code\":\"stale\",\"current_digest\":\"{}\"}}}}\n",
            "09".repeat(32)
        )
    );
    thread.join().unwrap();
}
#[test]
fn forged_actor_refused_before_write() {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/req_write_file.bin"
    ))
    .to_vec();
    assert_eq!(
        Frame::decode_local(&bytes),
        Err(conn::ProtocolError::UnknownField)
    );
    let frame = Frame::decode(&bytes).unwrap();
    assert!(conn::local_write_args(frame.request().unwrap().2, [7; 16]).is_err());
}
#[test]
fn client_read_binary_and_rejects_bad_arguments() {
    for values in [
        &["read-file", "../escape"][..],
        &["write-file", "a"][..],
        &["write-file", "a", "--base", "bad"][..],
    ] {
        assert!(client::request(&args(values), &mut &b""[..]).is_err());
    }
    let request = client::request(&args(&["read-file", "a"]), &mut &b""[..]).unwrap();
    let (mut caller, mut server) = UnixStream::pair().unwrap();
    let expected = request.encode_local().unwrap();
    let thread = std::thread::spawn(move || {
        let mut bytes = vec![0; expected.len()];
        server.read_exact(&mut bytes).unwrap();
        let response = smithers_machined::daemon::response(
            1,
            2,
            conn::structure_bytes(&[
                conn::field(1, [0, 0, 0, 4, 0, 255, 1, 128]),
                conn::field(2, [7; 32]),
                conn::field(3, 420u32.to_be_bytes()),
            ]),
        );
        server.write_all(&response.encode().unwrap()).unwrap();
    });
    let mut output = vec![];
    assert!(client::exchange(&mut caller, &request, &mut output).unwrap());
    let json: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(json["content_b64"], "AP8BgA==");
    assert_eq!(json["mode"], 420);
    thread.join().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn kernel_peer_must_be_agent_in_a_registered_cgroup() {
    struct Runs;
    impl smithers_machined::hooks::Sessions for Runs {
        fn admission_of_cgroup(
            &self,
            path: &str,
        ) -> Option<smithers_machined::broker::sessions::Admission> {
            (path == "/smithers/sessions/7").then(|| {
                smithers_machined::broker::sessions::Admission {
                    principal: [7; 16],
                    run: Some("run-7".into()),
                }
            })
        }
    }
    use smithers_machined::local::admission_for_peer;
    assert_eq!(
        admission_for_peer(19999, "0::/smithers/sessions/7\n", &Runs)
            .unwrap()
            .run
            .unwrap(),
        "run-7"
    );
    for (uid, groups) in [
        (0, "0::/smithers/sessions/7"),
        (20001, "0::/smithers/sessions/7"),
        (19999, "0::/smithers/sessions/8"),
        (19999, "0::/other/7"),
        (19999, "0::/smithers/sessions/7\n0::/smithers/sessions/8"),
    ] {
        assert_eq!(admission_for_peer(uid, groups, &Runs).unwrap_err().code, 11);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn local_open_refuses_identity_and_kind_selection() {
    use smithers_machined::local::validate_open;
    fn string(s: &str) -> Vec<u8> {
        [(s.len() as u16).to_be_bytes().as_slice(), s.as_bytes()].concat()
    }
    for (login, uid, kind, allowed) in [
        ("agent", 19999u32, 1u8, true),
        ("agent", 19999, 2, false),
        ("agent", 19999, 3, false),
        ("ben", 20001, 1, false),
        ("root", 0, 1, false),
        ("agent", 20001, 1, false),
    ] {
        let body = conn::structure_bytes(&[
            conn::field(
                1,
                conn::structure_bytes(&[
                    conn::field(1, string(login)),
                    conn::field(2, uid.to_be_bytes()),
                ]),
            ),
            conn::field(2, [kind]),
        ]);
        assert_eq!(
            validate_open(&body).is_ok(),
            allowed,
            "{login}:{uid} kind {kind}"
        );
    }
    for bytes in [vec![], vec![0; 65_537]] {
        assert!(validate_open(&bytes).is_err());
    }
}

#[test]
fn local_pty_stream_delivers_input_controls_and_output_without_host_poll() {
    use smithers_machined::{
        hooks::{Hooks, Sessions},
        local_stream,
        lock::Executor,
    };
    use std::sync::{Arc, Mutex};
    struct Pty(Mutex<Vec<Frame>>);
    impl Sessions for Pty {
        fn call(&self, method: u8, args: &[u8]) -> smithers_machined::hooks::Result<Vec<u8>> {
            assert_eq!(method, 8);
            assert_eq!(args, &[0, 0, 0, 5, 1, 0, 0, 0, 17]);
            Ok(vec![0, 0])
        }
        fn frame_local(&self, f: &Frame) -> smithers_machined::hooks::Result<Option<Frame>> {
            self.0.lock().unwrap().push(f.clone());
            Ok(Some(Frame {
                kind: 5,
                stream: 17,
                payload: vec![6, 0, 0, 0, 3],
            }))
        }
        fn poll(&self) -> smithers_machined::hooks::Result<Vec<Frame>> {
            panic!("local socket must never drain host output")
        }
        fn poll_local(&self, session: u32) -> smithers_machined::hooks::Result<Vec<Frame>> {
            assert_eq!(session, 17);
            if self.0.lock().unwrap().len() == 2 {
                Ok(vec![
                    Frame {
                        kind: 5,
                        stream: 17,
                        payload: vec![1, 1, b'o', b'k'],
                    },
                    Frame {
                        kind: 5,
                        stream: 17,
                        payload: vec![5, 0, 0, 0, 0, 7],
                    },
                ])
            } else {
                Ok(vec![])
            }
        }
    }
    let pty = Arc::new(Pty(Mutex::new(vec![])));
    let executor = Executor::start(Hooks {
        sessions: pty.clone(),
        ..Hooks::default()
    })
    .unwrap();
    let (mut caller, server) = UnixStream::pair().unwrap();
    caller
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    let lock = executor.lock.clone();
    let worker =
        std::thread::spawn(move || local_stream::serve(server, 17, lock, Arc::new(|_| true)));
    for payload in [vec![1, 0, b'a', b'b', b'c'], vec![2, 0]] {
        Frame {
            kind: 5,
            stream: 17,
            payload,
        }
        .write(&mut caller)
        .unwrap();
        assert_eq!(Frame::read(&mut caller).unwrap().payload, [6, 0, 0, 0, 3]);
    }
    assert_eq!(
        Frame::read(&mut caller).unwrap().payload,
        [1, 1, b'o', b'k']
    );
    assert_eq!(
        Frame::read(&mut caller).unwrap().payload,
        [5, 0, 0, 0, 0, 7]
    );
    worker.join().unwrap().unwrap();
    assert_eq!(pty.0.lock().unwrap().len(), 2);
    executor.shutdown().unwrap();
}

#[test]
fn local_pty_foreign_stream_and_revocation_interrupt_idle_reader() {
    use smithers_machined::{
        hooks::{Hooks, Sessions},
        local_stream,
        lock::Executor,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct Pty;
    impl Sessions for Pty {
        fn call(&self, method: u8, args: &[u8]) -> smithers_machined::hooks::Result<Vec<u8>> {
            assert_eq!(method, 8);
            assert_eq!(args, &[0, 0, 0, 5, 1, 0, 0, 0, 17]);
            Ok(vec![0, 0])
        }
        fn frame_local(&self, _: &Frame) -> smithers_machined::hooks::Result<Option<Frame>> {
            panic!("foreign input reached session provider")
        }
        fn poll_local(&self, _: u32) -> smithers_machined::hooks::Result<Vec<Frame>> {
            Ok(vec![])
        }
    }
    for revoked in [false, true] {
        let executor = Executor::start(Hooks {
            sessions: Arc::new(Pty),
            ..Hooks::default()
        })
        .unwrap();
        let (mut caller, server) = UnixStream::pair().unwrap();
        caller
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let allowed = Arc::new(AtomicBool::new(true));
        let check = allowed.clone();
        let lock = executor.lock.clone();
        let worker = std::thread::spawn(move || {
            local_stream::serve(
                server,
                17,
                lock,
                Arc::new(move |_| check.load(Ordering::Acquire)),
            )
        });
        if revoked {
            allowed.store(false, Ordering::Release);
        } else {
            Frame {
                kind: 5,
                stream: 18,
                payload: vec![1, 0, b'x'],
            }
            .write(&mut caller)
            .unwrap();
        }
        let mut byte = [0];
        assert_eq!(caller.read(&mut byte).unwrap(), 0);
        assert!(worker.join().unwrap().is_err());
        executor.shutdown().unwrap();
    }
}

#[test]
fn local_batch_binds_one_committed_principal_and_rejects_body_actor() {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/local_write_files.bin"
    ));
    let frame = Frame::decode_local(bytes).unwrap();
    let (_, method, args) = frame.request().unwrap();
    assert_eq!(method, 17);
    let (changes, actor) = conn::local_batch_write_args(args, [7; 16]).unwrap();
    assert_eq!(actor, Actor::Principal(vec![7; 16]));
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].path, "a");
    assert_eq!(changes[0].base, smithers_machined::hooks::Base::Absent);
    assert_eq!(changes[0].content.as_deref(), Some(b"x".as_slice()));
    assert_eq!(changes[1].path, "b");
    assert_eq!(changes[1].content.as_deref(), Some(b"y".as_slice()));
    assert!(conn::local_batch_write_args(args, [0; 16]).is_err());
    let forged = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/local_write_files_actor.bin"
    ));
    assert_eq!(
        Frame::decode_local(forged),
        Err(conn::ProtocolError::UnknownField)
    );
}

#[test]
fn local_delete_is_absent_content_and_actor_only_comes_from_admission() {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/local_delete_files.bin"
    ));
    let frame = Frame::decode_local(bytes).unwrap();
    let (_, method, args) = frame.request().unwrap();
    assert_eq!(method, 17);
    let (changes, actor) = conn::local_batch_write_args(args, [7; 16]).unwrap();
    assert_eq!(actor, Actor::Principal(vec![7; 16]));
    assert_eq!(changes.len(), 1);
    assert!(changes[0].content.is_none());
    let host = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/backend/internal/compose/testdata/cocontracts/req_delete_files.bin"
    ));
    assert_eq!(
        Frame::decode_local(host),
        Err(conn::ProtocolError::UnknownField)
    );
}
/// ADR 0004 §durable session admission: the local socket decodes open_session
/// tags 5/6 but refuses a local request carrying them. Corpus bytes, not
/// test-built ones.
#[test]
fn local_open_refuses_admission_fields_from_corpus() {
    use smithers_machined::local::validate_open;
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/backend/internal/compose/testdata/cocontracts");
    for (name, allowed) in [
        ("local_open_session", true),
        ("local_open_session_admitted", false),
    ] {
        let frame = Frame::decode_local(&std::fs::read(root.join(format!("{name}.bin"))).unwrap())
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let (_, method, args) = frame.request().unwrap();
        assert_eq!(method, 6, "{name}");
        assert_eq!(validate_open(args).is_ok(), allowed, "{name}");
    }
}

#[test]
fn client_batch_encodes_move_delete_and_empty_without_body_identity() {
    let request = client::request(
        &args(&["write-files"]),
        &mut &br#"[
      {"path":"source","base_digest":"absent","content":null},
      {"path":"dest","base_digest":"absent","content":[]},
      {"path":"binary","base_digest":"absent","content":[0,255]}
    ]"#[..],
    )
    .unwrap();
    Frame::decode_local(&request.encode_local().unwrap()).unwrap();
    let (_, method, raw) = request.request().unwrap();
    assert_eq!(method, 17);
    let (changes, actor) = conn::local_batch_write_args(raw, [7; 16]).unwrap();
    assert_eq!(actor, Actor::Principal(vec![7; 16]));
    assert_eq!(changes[0].content, None);
    assert_eq!(changes[1].content, Some(vec![]));
    assert_eq!(changes[2].content, Some(vec![0, 255]));
    for body in [
        r#"[]"#,
        r#"[{"path":"../escape","base_digest":"absent","content":null}]"#,
        r#"[{"path":"a","base_digest":"bad","content":null}]"#,
        r#"[{"path":"a","base_digest":"absent","content":null,"actor":"forged"}]"#,
        r#"[{"path":"a","base_digest":"absent","content":null},{"path":"a/b","base_digest":"absent","content":null}]"#,
        r#"[{"path":"a","base_digest":"absent","content":null},{"path":"a","base_digest":"absent","content":null}]"#,
    ] {
        assert!(
            client::request(&args(&["write-files"]), &mut body.as_bytes()).is_err(),
            "{body}"
        );
    }
}

#[test]
fn client_batch_validates_success_and_partial_receipts() {
    let request = client::request(
        &args(&["write-files"]),
        &mut &br#"[
      {"path":"source","base_digest":"absent","content":null},
      {"path":"dest","base_digest":"absent","content":[120]}
    ]"#[..],
    )
    .unwrap();
    for (count, failure, correct, expected) in [
        (2, false, true, Some(true)),
        (1, true, true, Some(false)),
        (1, false, true, None),
        (2, false, false, None),
    ] {
        let (mut caller, mut server) = UnixStream::pair().unwrap();
        let encoded = request.encode_local().unwrap();
        let thread = std::thread::spawn(move || {
            let mut input = vec![0; encoded.len()];
            server.read_exact(&mut input).unwrap();
            let mut receipts = (count as u16).to_be_bytes().to_vec();
            receipts.extend(conn::structure_bytes(&[conn::field(
                1,
                conn::tagged(2, &[]),
            )]));
            if count == 2 {
                use sha2::{Digest, Sha256};
                let digest = if correct {
                    Sha256::digest(b"x").to_vec()
                } else {
                    vec![0; 32]
                };
                receipts.extend(conn::structure_bytes(&[conn::field(
                    1,
                    conn::tagged(1, &[conn::field(1, digest)]),
                )]));
            }
            let mut fields = vec![conn::field(1, receipts)];
            if failure {
                fields.push(conn::field(
                    2,
                    conn::structure_bytes(&[
                        conn::field(1, 1u16.to_be_bytes()),
                        conn::field(2, [0]),
                        conn::field(
                            3,
                            conn::structure_bytes(
                                &smithers_machined::hooks::Error::unsupported().fields(),
                            ),
                        ),
                    ]),
                ));
            }
            smithers_machined::daemon::response(1, 17, conn::structure_bytes(&fields))
                .write(&mut server)
                .unwrap();
        });
        let mut output = vec![];
        let result = client::exchange(&mut caller, &request, &mut output);
        match expected {
            Some(ok) => {
                assert_eq!(result.unwrap(), ok);
                let json: serde_json::Value = serde_json::from_slice(&output).unwrap();
                assert_eq!(json["writes"][0]["post_digest"], "absent");
                if failure {
                    assert_eq!(json["failure"]["index"], 1);
                }
            }
            None => assert!(result.is_err()),
        }
        thread.join().unwrap();
    }
}

/// T-TRM-05: the coding host's Bash binding hands `client pty` its planned
/// invocation. The local open names only the fixed runner as `agent`.
#[cfg(target_os = "linux")]
#[test]
fn client_pty_opens_the_fixed_runner_as_the_agent_terminal() {
    use smithers_machined::{agent_run, broker::request::Request, local::validate_open};
    let input = br#"{"argv":["/bin/sh","-c","pnpm test"],"cwd":"web","env":{"FOO":"1"},"display":"pnpm test"}"#;
    let (request, echo) = client::pty_request(&mut &input[..]).unwrap();
    assert_eq!(echo, b"$ pnpm test");
    let (id, method, body) = request.request().unwrap();
    assert_eq!((id, method), (1, 6));
    validate_open(body).unwrap();
    let Request::Open {
        user,
        argv,
        admission,
        ..
    } = Request::decode(6, body).unwrap()
    else {
        panic!("not an open");
    };
    assert_eq!((user.login.as_str(), user.uid), ("agent", 19999));
    assert_eq!(
        admission, None,
        "the run comes from the kernel peer, never the request"
    );
    assert_eq!(&argv[..2], [agent_run::RUNNER, agent_run::VERB]);
    let spec = agent_run::Spec::from_args(&argv[2..]).unwrap();
    assert_eq!(spec.argv, ["/bin/sh", "-c", "pnpm test"]);
    assert_eq!(spec.cwd.as_deref(), Some("web"));
    assert_eq!(spec.env["FOO"], "1");
    assert_eq!(spec.echo, "$ pnpm test");
    // A command line becomes one printable echo row; control bytes cannot
    // paint the watcher's terminal.
    let (_, echo) = client::pty_request(
        &mut &br#"{"argv":["/bin/sh","-c","x"],"display":"printf '\u001b[2J'\nrm -rf x"}"#[..],
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(echo).unwrap(),
        "$ printf '\u{FFFD}[2J'⏎rm -rf x"
    );
    for bad in [
        &br#"{"argv":[],"display":"x"}"#[..],
        br#"{"argv":["sh"],"display":"x","actor":"run"}"#,
        br#"{"argv":["sh"],"display":"x","env":{"A=B":"c"}}"#,
        br#"{"argv":["sh"]}"#,
        b"not json",
    ] {
        assert!(client::pty_request(&mut &bad[..]).is_err());
    }
    let huge = format!(
        r#"{{"argv":["sh"],"display":"x","stdin":"{}"}}"#,
        "y".repeat(70_000)
    );
    assert!(client::pty_request(&mut huge.as_bytes()).is_err());
}

/// A daemon-side script of session frames, then EOF; returns what the client
/// wrote back (credit) and printed.
#[cfg(target_os = "linux")]
fn pty_script(
    session: u32,
    payloads: Vec<Vec<u8>>,
) -> (std::io::Result<client::PtyEnd>, Vec<u8>, u64) {
    use std::sync::Mutex;
    let mut bytes = vec![];
    for payload in payloads {
        Frame {
            kind: 5,
            stream: session,
            payload,
        }
        .write(&mut bytes)
        .unwrap();
    }
    let credit = Mutex::new(Vec::<u8>::new());
    let mut output = vec![];
    let end = client::pty_stream(&mut &bytes[..], &credit, 17, b"$ pnpm test", &mut output);
    let mut returned = 0u64;
    let written = credit.into_inner().unwrap();
    let mut rest = &written[..];
    while !rest.is_empty() {
        let frame = Frame::read(&mut rest).unwrap();
        assert_eq!((frame.kind, frame.stream, frame.payload[0]), (5, 17, 6));
        returned += u32::from_be_bytes(frame.payload[1..5].try_into().unwrap()) as u64;
    }
    (end, output, returned)
}

#[cfg(target_os = "linux")]
#[test]
fn client_pty_strips_only_the_runner_echo_and_takes_status_from_the_exit_frame() {
    use client::PtyEnd;
    let data = |b: &[u8]| [&[1u8, 1], b].concat();
    // The echo may arrive split; only its first, positional copy is removed.
    // Text that looks like a completion marker is ordinary output.
    let second: &[u8] = b"test\r\n\x1b[32mFIRST\x1b[0m\r\n$ pnpm test\r\n\x1b]133;D;0\x07";
    let (end, output, credit) = pty_script(
        17,
        vec![
            data(b"$ pnpm "),
            data(second),
            data(b"LAST"),
            vec![2, 1],
            vec![5, 0, 0, 0, 0, 7],
        ],
    );
    assert_eq!(end.unwrap(), PtyEnd::Exit(7));
    assert_eq!(
        output,
        b"\x1b[32mFIRST\x1b[0m\r\n$ pnpm test\r\n\x1b]133;D;0\x07LAST"
    );
    assert_eq!(
        credit,
        (7 + second.len() + 4) as u64,
        "every byte's credit, after it was written"
    );
    // A terminal without output post-processing ends the echo with LF.
    let (end, output, _) = pty_script(17, vec![data(b"$ pnpm test\nok"), vec![5, 0, 0, 0, 0, 0]]);
    assert_eq!(
        (end.unwrap(), output.as_slice()),
        (PtyEnd::Exit(0), b"ok".as_slice())
    );
    // Signals are the broker's wire enum, reported as POSIX numbers.
    for (wire, posix) in [(1u8, 2), (2, 15), (3, 1), (4, 9), (5, 3), (6, 10), (7, 12)] {
        let (end, _, _) = pty_script(17, vec![data(b"$ pnpm test\r\n"), vec![5, 1, wire, 0]]);
        assert_eq!(end.unwrap(), PtyEnd::Signal(posix));
    }
    // No echo first means the runner failed before the command existed.
    let (end, output, credit) = pty_script(
        17,
        vec![data(b"smithers: oops\r\n"), vec![5, 0, 0, 0, 0, 1]],
    );
    assert_eq!(end.unwrap(), PtyEnd::Runner(Some(1)));
    assert!(output.is_empty());
    assert_eq!(credit, 16);
    let (end, _, _) = pty_script(17, vec![data(b"$ pn"), vec![5, 0, 0, 0, 0, 2]]);
    assert_eq!(end.unwrap(), PtyEnd::Runner(Some(2)));
    // A close before any status is not a completion.
    let (end, output, _) = pty_script(17, vec![data(b"$ pnpm test\r\npartial"), vec![7]]);
    assert_eq!(
        (end.unwrap(), output.as_slice()),
        (PtyEnd::Closed, b"partial".as_slice())
    );
    let (end, _, _) = pty_script(17, vec![]);
    assert_eq!(end.unwrap(), PtyEnd::Closed);
    // Another stream, a refusal or a stdin frame direction is a protocol fault.
    assert!(pty_script(18, vec![data(b"x")]).0.is_err());
    assert!(pty_script(17, vec![vec![255, 0, 0, 0, 2, 1, 11]])
        .0
        .is_err());
    assert!(pty_script(17, vec![vec![1, 0, b'x']]).0.is_err());
}
