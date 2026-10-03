//! Literal byte oracles transcribed from ADR 0004, framing and control tables.
use smithers_machined::{
    conn::*,
    msg::*,
    rpc::{Rpc, State},
    stream::FrameTx,
    wiring,
};
fn rpc(state: State) -> Rpc {
    let (out, _) = FrameTx::channel();
    Rpc {
        state,
        hooks: wiring::hooks(out),
    }
}
fn request(call: Call) -> Frame {
    Message::Control(Control::Request(Request { req_id: 7, call }))
        .frame(0, Direction::HostToDaemon)
        .unwrap()
}
#[test]
fn literal_ack_and_header_order() {
    // ADR 0004 acknowledgements: the printed seq 7 applied byte table.
    let bytes = [
        0, 0, 0, 16, 2, 0, 0, 0, 0, 3, 0, 0, 0, 11, 1, 0, 0, 0, 0, 0, 0, 0, 7, 2, 1,
    ];
    let expected = Message::Events(Events::Ack(Ack {
        seq: 7,
        outcome: 1,
        oids: None,
        error: None,
        haves: None,
    }));
    let frame = Frame::decode(&bytes).unwrap();
    assert_eq!(
        Message::decode(&frame, Direction::HostToDaemon).unwrap(),
        expected
    );
    assert_eq!(
        expected
            .frame(0, Direction::HostToDaemon)
            .unwrap()
            .encode()
            .unwrap(),
        bytes
    );
    // Framing checks: header, kind, stream, bound, payload, trailing.
    for (b, e) in [
        (vec![0; 8], ProtocolError::Truncated),
        (
            vec![255, 255, 255, 255, 9, 0, 0, 0, 1],
            ProtocolError::UnknownKind,
        ),
        (
            vec![255, 255, 255, 255, 1, 0, 0, 0, 1],
            ProtocolError::BadStream,
        ),
        (
            vec![255, 255, 255, 255, 1, 0, 0, 0, 0],
            ProtocolError::FrameTooLarge,
        ),
        (vec![0, 0, 0, 1, 1, 0, 0, 0, 0], ProtocolError::Truncated),
        (
            vec![0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
            ProtocolError::TrailingBytes,
        ),
    ] {
        assert_eq!(Frame::decode(&b), Err(e));
    }
}
#[test]
fn bounds_are_checked_before_payload_is_read() {
    struct HeaderOnly {
        cursor: std::io::Cursor<Vec<u8>>,
    }
    impl std::io::Read for HeaderOnly {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            assert!(
                self.cursor.position() < 9,
                "oversized payload must never be read"
            );
            std::io::Read::read(&mut self.cursor, b)
        }
    }
    let mut reader = HeaderOnly {
        cursor: std::io::Cursor::new(vec![255, 255, 255, 255, 1, 0, 0, 0, 0]),
    };
    assert_eq!(Frame::read(&mut reader), Err(ProtocolError::FrameTooLarge));
    for (kind, limit) in [
        (Kind::Hello, 8192),
        (Kind::Control, 1114112),
        (Kind::Events, 4194304),
        (Kind::Presence, 65536),
        (Kind::Documents, 4194304),
        (Kind::Sessions, 65552),
        (Kind::Objects, 65552),
    ] {
        assert_eq!(kind.limit(), limit);
        let stream = if kind as u8 <= 3 { 0 } else { 1 };
        let f = Frame {
            kind,
            stream,
            payload: vec![0; limit],
        };
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
        assert_eq!(
            Frame {
                payload: vec![0; limit + 1],
                ..f
            }
            .encode(),
            Err(ProtocolError::FrameTooLarge)
        );
    }
    assert_eq!(MAX_FILE_BYTES, 1_048_576);
    assert_eq!(INITIAL_CREDIT, 262_144);
}
#[test]
fn wire_refusals() {
    // Actor principal {blob}, tag 2 is forbidden (branch, uid, machine all unknown).
    let nested = [1, 0, 0, 0, 7, 1, 0, 0, 0, 0, 2, 0];
    assert_eq!(Actor::from_bytes(&nested), Err(ProtocolError::UnknownField));
    // ADR write_file required base tag2: path, content and actor cannot replace it.
    let missing_base = [
        0, 0, 0, 20, 1, 0, 1, b'a', 3, 0, 0, 0, 0, 4, 1, 0, 0, 0, 5, 1, 0, 0, 0, 0,
    ];
    assert_eq!(
        WriteFile::from_bytes(&missing_base),
        Err(ProtocolError::MissingField)
    );
    assert_eq!(
        ReadFile::from_bytes(&[0, 0, 0, 0]),
        Err(ProtocolError::MissingField)
    );
    assert_eq!(
        ReadFile::from_bytes(&[0, 0, 0, 8, 1, 0, 1, b'a', 1, 0, 1, b'b']),
        Err(ProtocolError::UnorderedField)
    );
    assert_eq!(
        ReadFile::from_bytes(&[0, 0, 0, 4, 1, 0, 1, 0]),
        Err(ProtocolError::BadUtf8)
    );
    assert_eq!(
        ReadFile::from_bytes(&[0, 0, 0, 4, 1, 0, 1, 255]),
        Err(ProtocolError::BadUtf8)
    );
    assert_eq!(
        Empty::from_bytes(&[0, 0, 0, 0, 0]),
        Err(ProtocolError::TrailingBytes)
    );
    assert_eq!(
        Control::from_bytes(&[9]),
        Err(ProtocolError::UnknownMessage)
    );
    assert_eq!(Call::from_bytes(&[99]), Err(ProtocolError::UnknownMethod));
}
#[test]
fn unknown_uid_is_correlated_malformed_and_actor_is_host_only() {
    let mut frame = request(Call::WriteFile(WriteFile {
        path: "a".into(),
        base: Base::Absent(Empty {}),
        content: Bytes(vec![]),
        actor: Actor::Principal(Principal {
            blob: Bytes(vec![]),
        }),
    }));
    // Append tag 9 uid to the Call struct, adjust Request and Call body lengths.
    frame.payload.extend_from_slice(&[9, 0, 0, 0, 1]);
    for offset in [1, 12] {
        let len = u32::from_be_bytes(frame.payload[offset..offset + 4].try_into().unwrap());
        frame.payload[offset..offset + 4].copy_from_slice(&(len + 5).to_be_bytes());
    }
    assert_eq!(
        Message::decode(&frame, Direction::HostToDaemon),
        Err(ProtocolError::UnknownField)
    );
    let response = rpc(State::Ready).frame(&frame).unwrap();
    assert_eq!(
        Message::decode(&response, Direction::DaemonToHost).unwrap(),
        Message::Control(Control::Response(Response {
            req_id: 7,
            result: CallResult::Error(Error::malformed(ProtocolError::UnknownField))
        }))
    );
    let bad = Call::WriteFile(WriteFile {
        path: "a".into(),
        base: Base::Absent(Empty {}),
        content: Bytes(vec![]),
        actor: Actor::Run(RunActor {
            run: "forged".into(),
        }),
    });
    assert_eq!(
        Message::Control(Control::Request(Request {
            req_id: 7,
            call: bad
        }))
        .frame(0, Direction::HostToDaemon),
        Err(ProtocolError::BadValue)
    );
}
#[test]
fn daemon_cannot_send_a_user_claim() {
    let call = Call::OpenSession(OpenSession {
        user: User {
            login: "agent".into(),
            uid: 19999,
        },
        kind: 2,
        argv: None,
        size: None,
    });
    let f = request(call.clone());
    assert!(Message::decode(&f, Direction::HostToDaemon).is_ok());
    assert_eq!(
        Message::decode(&f, Direction::DaemonToHost),
        Err(ProtocolError::BadValue)
    );
    let kill = request(Call::KillSessions(KillSessions {
        target: KillTarget::User(UserTarget {
            user: User {
                login: "member".into(),
                uid: 20000,
            },
        }),
    }));
    assert_eq!(
        Message::decode(&kill, Direction::DaemonToHost),
        Err(ProtocolError::BadValue)
    );
}
#[test]
fn local_actor_is_refused_and_valid_write_is_run_attributed() {
    let w = LocalWriteFile {
        path: "a".into(),
        base: Base::Absent(Empty {}),
        content: Bytes(vec![42]),
    };
    let mut call = vec![3];
    w.encode(&mut call).unwrap();
    let mut body = vec![1];
    7u32.encode(&mut body).unwrap();
    body.push(2);
    body.extend(call);
    let mut payload = vec![1];
    structure(body, &mut payload).unwrap();
    let frame = Frame {
        kind: Kind::Control,
        stream: 0,
        payload,
    };
    let r = local_request(&frame, "coding-run-1").unwrap();
    assert!(
        matches!(r.call,Call::WriteFile(WriteFile{actor:Actor::Run(RunActor{run}),..})if run=="coding-run-1")
    );
    let forged = request(Call::WriteFile(WriteFile {
        path: "a".into(),
        base: Base::Absent(Empty {}),
        content: Bytes(vec![]),
        actor: Actor::Principal(Principal {
            blob: Bytes(vec![]),
        }),
    }));
    assert_eq!(
        local_request(&forged, "coding-run-1"),
        Err(ProtocolError::UnknownField)
    );
}
#[test]
fn readiness_stubs_and_reserved_streams() {
    for state in [State::Booting, State::Reconciling, State::Ready] {
        let r = rpc(state);
        let status = r.dispatch(Request {
            req_id: 5,
            call: Call::Status(Empty {}),
        });
        assert!(matches!(status.result,CallResult::Status(Status{state:s,..})if s==state as u8));
        for call in [
            Call::Capture(Empty {}),
            Call::OpenDoc(OpenDoc { path: "a".into() }),
            Call::CloseDoc(StreamId { stream: 1 }),
            Call::Rebase(Rebase {
                onto: [0; 20],
                actor: Actor::Principal(Principal {
                    blob: Bytes(vec![]),
                }),
            }),
        ] {
            let res = r.dispatch(Request { req_id: 5, call });
            assert_eq!(res.req_id, 5);
            assert_eq!(
                res.result,
                CallResult::Error(Error::new(if state == State::Ready { 2 } else { 3 }))
            );
        }
        assert_eq!(
            r.dispatch(Request {
                req_id: 5,
                call: Call::WakeReconcile(Head { head: [1; 20] })
            })
            .result,
            CallResult::Error(Error::unsupported())
        );
    }
    for kind in [Kind::Documents, Kind::Sessions, Kind::Objects] {
        let f = Frame {
            kind,
            stream: 1,
            payload: vec![1, 0, 42],
        };
        let r = rpc(State::Ready).frame(&f).unwrap();
        assert_eq!(r.kind, kind);
        assert_eq!(r.stream, 1);
        assert_eq!(r.payload, vec![255, 0, 0, 0, 2, 1, 2]);
    }
}
#[test]
fn session_fixed_layout_and_object_restrictions() {
    // ADR stream table, literal oracles independent of codec.
    for (bytes, value) in [
        (
            vec![1, 2, 0, 255],
            StreamFrame::Data {
                fd: 2,
                bytes: vec![0, 255],
            },
        ),
        (vec![2, 0], StreamFrame::Eof { fd: 0 }),
        (
            vec![3, 0, 80, 0, 24],
            StreamFrame::Resize(Size { cols: 80, rows: 24 }),
        ),
        (vec![4, 1], StreamFrame::Signal(1)),
        (vec![5, 0, 255, 255, 255, 254], StreamFrame::ExitCode(-2)),
        (
            vec![5, 1, 4, 1],
            StreamFrame::ExitSignal { sig: 4, core: true },
        ),
        (vec![6, 0, 4, 0, 0], StreamFrame::Window(262144)),
        (vec![7], StreamFrame::Close),
    ] {
        assert_eq!(StreamFrame::decode(&bytes, false).unwrap(), value);
        assert_eq!(value.encode(false).unwrap(), bytes);
    }
    for b in [vec![3], vec![4], vec![5], vec![1, 1], vec![2, 2]] {
        assert_eq!(StreamFrame::decode(&b, true), Err(ProtocolError::BadValue));
    }
    assert_eq!(
        StreamFrame::decode(&[5, 1, 1, 2], false),
        Err(ProtocolError::BadValue)
    );
    assert_eq!(
        StreamFrame::decode(&[7, 0], false),
        Err(ProtocolError::TrailingBytes)
    );
    assert_eq!(
        StreamFrame::decode(&[1], false),
        Err(ProtocolError::Truncated)
    );
    assert_eq!(
        StreamFrame::decode(&[4, 8], false),
        Err(ProtocolError::BadValue)
    );
    assert_eq!(
        StreamFrame::Data {
            fd: 0,
            bytes: vec![0; 65537]
        }
        .encode(false),
        Err(ProtocolError::BadValue)
    );
}
#[test]
fn random_bytes_never_panic() {
    let mut seed = 0x471cdd152u64;
    for len in 0..256 {
        for _ in 0..20 {
            let bytes: Vec<_> = (0..len)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    seed as u8
                })
                .collect();
            let _ = Frame::decode(&bytes);
            let _ = Control::from_bytes(&bytes);
            let _ = Events::from_bytes(&bytes);
            let _ = Hello::from_bytes(&bytes);
            let _ = StreamFrame::decode(&bytes, false);
        }
    }
}

#[test]
fn every_call_and_result_has_one_typed_round_trip() {
    // ADR 0004 control table: method ids and fields are independently listed here.
    let actor = || {
        Actor::Principal(Principal {
            blob: Bytes(vec![10]),
        })
    };
    let calls = vec![
        Call::Status(Empty {}),
        Call::ReadFile(ReadFile {
            path: "a".into(),
            at: Some([1; 20]),
        }),
        Call::WriteFile(WriteFile {
            path: "a".into(),
            base: Base::Digest(DigestBase { digest: [2; 32] }),
            content: Bytes(vec![0, 255]),
            actor: actor(),
        }),
        Call::Capture(Empty {}),
        Call::WakeReconcile(Head { head: [1; 20] }),
        Call::OpenSession(OpenSession {
            user: User {
                login: "agent".into(),
                uid: 19999,
            },
            kind: 2,
            argv: Some(vec!["echo".into()]),
            size: Some(Size { cols: 80, rows: 24 }),
        }),
        Call::TcpConnect(TcpConnect { port: 3000 }),
        Call::CloseSession(SessionId { session: 1 }),
        Call::KillSessions(KillSessions {
            target: KillTarget::User(UserTarget {
                user: User {
                    login: "ben".into(),
                    uid: 20000,
                },
            }),
        }),
        Call::RegisterRun(RegisterRun {
            run: "coding-1".into(),
            session: 1,
        }),
        Call::Rebase(Rebase {
            onto: [1; 20],
            actor: actor(),
        }),
        Call::ReturnToItem(ReturnToItem { actor: actor() }),
        Call::OpenDoc(OpenDoc { path: "a".into() }),
        Call::CloseDoc(StreamId { stream: 1 }),
        Call::AttachSession(AttachSession {
            session: 1,
            received: 32,
        }),
    ];
    for (id, call) in calls.into_iter().enumerate() {
        assert_eq!(call.method(), id as u8 + 1);
        let frame = request(call.clone());
        assert_eq!(
            Message::decode(&frame, Direction::HostToDaemon).unwrap(),
            Message::Control(Control::Request(Request { req_id: 7, call }))
        );
    }
    let results = vec![
        CallResult::Status(Status {
            state: 3,
            protocol: 1,
            version: "0.1.0".into(),
            outbox_depth: 2,
            acked_head: Some([1; 20]),
            lock_queue: 2,
        }),
        CallResult::ReadFile(FileContent {
            content: Bytes(vec![0, 255]),
            digest: [2; 32],
            mode: 0o100644,
        }),
        CallResult::WriteFile(Written {
            post_digest: [2; 32],
        }),
        CallResult::Capture(Captured {
            head: [1; 20],
            tree: [2; 20],
            flushed_documents: 0,
        }),
        CallResult::WakeReconcile(Reconciled {
            outcome: ReconcileOutcome::Unchanged(Empty {}),
        }),
        CallResult::OpenSession(SessionId { session: 1 }),
        CallResult::TcpConnect(SessionId { session: 1 }),
        CallResult::CloseSession(Empty {}),
        CallResult::KillSessions(Killed { killed: 1 }),
        CallResult::RegisterRun(Empty {}),
        CallResult::Rebase(Head { head: [1; 20] }),
        CallResult::ReturnToItem(Head { head: [1; 20] }),
        CallResult::OpenDoc(StreamId { stream: 1 }),
        CallResult::CloseDoc(Empty {}),
        CallResult::AttachSession(Received { received: 32 }),
        CallResult::WakeReconcile(Reconciled {
            outcome: ReconcileOutcome::Moved(Head { head: [3; 20] }),
        }),
        CallResult::WakeReconcile(Reconciled {
            outcome: ReconcileOutcome::Conflict(Conflict {
                paths: vec!["a".into()],
            }),
        }),
    ];
    for result in results {
        let msg = Message::Control(Control::Response(Response { req_id: 7, result }));
        let f = msg.frame(0, Direction::DaemonToHost).unwrap();
        assert_eq!(Message::decode(&f, Direction::DaemonToHost).unwrap(), msg);
    }
    for code in 1..=12 {
        let mut error = Error::new(code);
        error.current_digest = Some([1; 32]);
        error.session = Some(1);
        error.limit = Some(1_048_576);
        error.protocol = Some(7);
        error.oids = Some(vec![[1; 20]]);
        error.detail = Some("fixture".into());
        assert_eq!(Error::from_bytes(&error.bytes().unwrap()).unwrap(), error);
    }
}
#[test]
fn events_ack_and_presence_round_trip() {
    // ADR event and acknowledgement tables, including rename/delete and parts.
    let burst = Burst {
        burst_id: [1; 16],
        actor: Actor::Run(RunActor {
            run: "coding-1".into(),
        }),
        files: vec![
            BurstFile {
                path: "a".into(),
                change: 4,
                renamed_to: Some("b".into()),
                before_blob: Some([2; 20]),
                after_blob: Some([3; 20]),
                post_digest: Some([4; 32]),
            },
            BurstFile {
                path: "c".into(),
                change: 3,
                renamed_to: None,
                before_blob: Some([2; 20]),
                after_blob: None,
                post_digest: None,
            },
        ],
        versions_commit: [5; 20],
        part: Some(1),
        parts: Some(2),
    };
    for event in [
        Event::Burst(burst),
        Event::Captured(CapturedEvent {
            head: [1; 20],
            tree: [2; 20],
            base: [3; 20],
        }),
        Event::Reconciled(ReconciledEvent {
            from: [1; 20],
            onto: [2; 20],
            outcome: 2,
            paths: Some(vec!["a".into()]),
        }),
        Event::MovedOff(Empty {}),
        Event::Transcript(Empty {}),
        Event::DocEdit(Empty {}),
    ] {
        let msg = Message::Events(Events::Durable(Durable {
            seq: 7,
            event_id: [7; 16],
            event,
        }));
        let f = msg.frame(0, Direction::DaemonToHost).unwrap();
        assert_eq!(Message::decode(&f, Direction::DaemonToHost).unwrap(), msg);
    }
    for outcome in 1..=5 {
        let msg = Message::Events(Events::Ack(Ack {
            seq: 7,
            outcome,
            oids: Some(vec![[1; 20]]),
            error: Some(Error::new(5)),
            haves: Some(vec![[2; 20]]),
        }));
        let f = msg.frame(0, Direction::HostToDaemon).unwrap();
        assert_eq!(Message::decode(&f, Direction::HostToDaemon).unwrap(), msg);
    }
    let hint = Message::Events(Events::Hint(HintMessage {
        hint: Hint::FileWritten(FileWritten {
            path: "a".into(),
            actor: Actor::Outside(Empty {}),
            post_digest: None,
        }),
    }));
    assert_eq!(
        Message::decode(
            &hint.frame(0, Direction::DaemonToHost).unwrap(),
            Direction::DaemonToHost
        )
        .unwrap(),
        hint
    );
    let p = Message::Presence(Presence::Snapshot(Snapshot {
        sessions: vec![
            SessionWhere {
                session: 1,
                path: Some("a".into()),
            },
            SessionWhere {
                session: 2,
                path: None,
            },
        ],
    }));
    assert_eq!(
        Message::decode(
            &p.frame(0, Direction::DaemonToHost).unwrap(),
            Direction::DaemonToHost
        )
        .unwrap(),
        p
    );
}
#[test]
fn payload_value_bounds_and_handshake_directions() {
    assert_eq!("a".repeat(4097).bytes(), Err(ProtocolError::BadValue));
    assert_eq!(String::from_bytes(&[16, 1]), Err(ProtocolError::BadValue));
    assert_eq!(
        Actor::Principal(Principal {
            blob: Bytes(vec![0; 1025])
        })
        .validate(true),
        Err(ProtocolError::BadValue)
    );
    let msg = Message::Hello(Hello::Challenge(Challenge {
        magic: 0x534d4d44,
        protocol: 2,
        boot_id: [1; 16],
        nonce: [2; 32],
    }));
    assert_eq!(
        msg.frame(0, Direction::DaemonToHost),
        Err(ProtocolError::VersionMismatch)
    );
    assert_eq!(
        msg.frame(0, Direction::HostToDaemon),
        Err(ProtocolError::BadValue)
    );
    for error in [Error::new(0), Error::new(13)] {
        assert_eq!(error.validate(), Err(ProtocolError::BadValue));
    }
    let too_big = Call::WriteFile(WriteFile {
        path: "a".into(),
        base: Base::Absent(Empty {}),
        content: Bytes(vec![0; 1_048_577]),
        actor: Actor::Principal(Principal {
            blob: Bytes(vec![]),
        }),
    });
    assert_eq!(too_big.validate(), Err(ProtocolError::BadValue));
}

#[test]
fn wire_content_limit() {
    // ADR 0004 MaxWorkspaceFileBytes: independently fixed 1 MiB and 1 MiB+1.
    for (len, ok) in [(1_048_576, true), (1_048_577, false)] {
        let message = Message::Control(Control::Request(Request {
            req_id: 7,
            call: Call::WriteFile(WriteFile {
                path: "a".into(),
                base: Base::Absent(Empty {}),
                content: Bytes(vec![42; len]),
                actor: Actor::Principal(Principal {
                    blob: Bytes(vec![]),
                }),
            }),
        }));
        if ok {
            let frame = message.frame(0, Direction::HostToDaemon).unwrap();
            assert_eq!(
                Message::decode(&frame, Direction::HostToDaemon).unwrap(),
                message
            );
        } else {
            assert_eq!(
                message.frame(0, Direction::HostToDaemon),
                Err(ProtocolError::BadValue)
            );
        }
    }
}
