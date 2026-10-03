#![cfg(feature = "testing")]
//! Real stream and git fixtures exercise the host without a guest kernel.
use smithers_machined::{
    conn::*,
    link::*,
    msg::*,
    rpc::{Rpc, State},
    stream::FrameTx,
    testing::{fake_host::*, fixtures},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
async fn read(s: &mut tokio::net::TcpStream) -> Frame {
    let mut hdr = [0; 9];
    s.read_exact(&mut hdr).await.unwrap();
    let (_, _, len) = decode_header(&hdr).unwrap();
    let mut b = hdr.to_vec();
    b.resize(9 + len, 0);
    s.read_exact(&mut b[9..]).await.unwrap();
    Frame::decode(&b).unwrap()
}
async fn send(s: &mut tokio::net::TcpStream, msg: Message) {
    s.write_all(
        &msg.frame(0, Direction::DaemonToHost)
            .unwrap()
            .encode()
            .unwrap(),
    )
    .await
    .unwrap();
}
#[tokio::test(flavor = "current_thread")]
async fn real_stream_mutual_handshake_and_fixture_status() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let daemon = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut auth = DaemonProof::with_nonce([7; 32], [1; 16], [2; 32]);
        send(&mut s, Message::Hello(Hello::Challenge(auth.challenge()))).await;
        let p = match Message::decode(&read(&mut s).await, Direction::HostToDaemon).unwrap() {
            Message::Hello(Hello::HostProof(p)) => p,
            _ => panic!("host proof"),
        };
        auth.accept(&p).unwrap();
        send(
            &mut s,
            Message::Hello(Hello::Machine(
                auth.machine(b"machine-boot-1".to_vec(), [3; 16], 7, vec![])
                    .unwrap(),
            )),
        )
        .await;
        assert_eq!(
            Message::decode(&read(&mut s).await, Direction::HostToDaemon).unwrap(),
            Message::Hello(Hello::Welcome(Empty {}))
        );
        let (out, _) = FrameTx::channel();
        let daemon = smithers_machined::daemon::Daemon::new(fixtures::hooks(out));
        let response = daemon.frame(&read(&mut s).await).unwrap();
        s.write_all(&response.encode().unwrap()).await.unwrap();
    });
    let mut host = FakeHost::relay(addr).await.unwrap();
    assert_eq!(host.handshake().await.unwrap().next_seq, 7);
    let status = host.call(Call::Status(Empty {})).await.unwrap();
    assert!(matches!(
        status,
        CallResult::Status(Status { state: 1, .. })
    ));
    daemon.await.unwrap();
}
#[test]
fn reserved_document_unsupported() {
    let host = FakeHost::new().unwrap();
    let (out, _) = FrameTx::channel();
    let rpc = Rpc {
        state: State::Ready,
        hooks: fixtures::hooks(out),
    };
    // ADR 0004: doc msg 1 opaque; refusal has Error {tag1 code2} on the same stream.
    let request = [0, 0, 0, 2, 4, 0, 0, 0, 7, 1, 42];
    let refusal = [0, 0, 0, 7, 4, 0, 0, 0, 7, 255, 0, 0, 0, 2, 1, 2];
    host.replay(&rpc, &request, &refusal).unwrap();
    assert_eq!(
        Message::decode(&Frame::decode(&refusal).unwrap(), Direction::DaemonToHost).unwrap(),
        Message::Document(DocumentFrame::Refused(Error::unsupported()))
    );
    let mut wrong = refusal;
    wrong[15] = 3;
    assert_eq!(
        host.replay(&rpc, &request, &wrong),
        Err(ProtocolError::BadValue)
    );
}
fn bundle() -> (tempfile::TempDir, Vec<u8>, Oid) {
    let source = tempfile::tempdir().unwrap();
    git(source.path(), &["init", "--bare", "--quiet"], None).unwrap();
    let tree = String::from_utf8(git(source.path(), &["mktree"], Some(b"")).unwrap()).unwrap();
    // commit-tree takes identity from per-command config, no user git config required.
    let commit = String::from_utf8(
        git(
            source.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit-tree",
                tree.trim(),
            ],
            Some(b"fixture\n"),
        )
        .unwrap(),
    )
    .unwrap();
    let oid = unhex(commit.trim()).unwrap();
    git(
        source.path(),
        &["update-ref", "refs/heads/foreign-main", commit.trim()],
        None,
    )
    .unwrap();
    let path = source.path().join("transfer.bundle");
    git(
        source.path(),
        &["bundle", "create", path.to_str().unwrap(), "--all"],
        None,
    )
    .unwrap();
    let bytes = std::fs::read(path).unwrap();
    (source, bytes, oid)
}
#[test]
fn foreign_ref_bundle_never_changes_host_refs() {
    let (_source, bytes, oid) = bundle();
    let mut host = FakeHost::new().unwrap();
    let before = git(host.store.path(), &["show-ref"], None).unwrap_or_default();
    host.import_bundle(&bytes).unwrap();
    assert!(host.has_object(&oid));
    assert_eq!(
        git(host.store.path(), &["show-ref"], None).unwrap_or_default(),
        before
    );
    assert!(git(
        host.store.path(),
        &["rev-parse", "--verify", "refs/heads/foreign-main"],
        None
    )
    .is_err());
}
#[test]
fn bundle_prerequisites_quota_and_corruption_are_fail_closed() {
    let (_source, bytes, oid) = bundle();
    let mut host = FakeHost::new().unwrap();
    host.bundle_cap = bytes.len() - 1;
    assert!(host
        .import_bundle(&bytes)
        .unwrap_err()
        .to_string()
        .contains("quota"));
    assert!(!host.has_object(&oid));
    host.bundle_cap = bytes.len();
    host.quota = bytes.len() - 1;
    assert!(host.import_bundle(&bytes).is_err());
    assert!(!host.has_object(&oid));
    host.quota = bytes.len();
    let mut corrupt = bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(host.import_bundle(&corrupt).is_err());
    assert!(!host.has_object(&oid));
    let end = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let mut prerequisite = bytes.clone();
    prerequisite.splice(
        end..end,
        format!("-{} prerequisite\n", hex(&oid))
            .as_bytes()
            .iter()
            .copied(),
    );
    host.bundle_cap = prerequisite.len();
    host.quota = prerequisite.len();
    assert!(host
        .import_bundle(&prerequisite)
        .unwrap_err()
        .to_string()
        .contains("foreign prerequisite"));
    assert!(!host.has_object(&oid));
    host.quota = bytes.len();
    host.import_bundle(&bytes).unwrap();
    assert!(host.import_bundle(&bytes).is_err());
}
#[test]
fn actual_receipts_duplicate_missing_objects_and_reconnect_order() {
    let (_source, bytes, head) = bundle();
    let mut host = FakeHost::new().unwrap();
    let tree = git(
        _source.path(),
        &["rev-parse", &format!("{}^{{tree}}", hex(&head))],
        None,
    )
    .unwrap();
    let tree = unhex(std::str::from_utf8(&tree).unwrap().trim()).unwrap();
    let event = Durable {
        seq: 7,
        event_id: [7; 16],
        event: Event::Captured(CapturedEvent {
            head,
            tree,
            base: head,
        }),
    };
    let missing = host.apply(event.clone()).unwrap();
    assert_eq!(missing.outcome, 3);
    assert!(!host.receipts.contains(&[7; 16]));
    host.import_bundle(&bytes).unwrap();
    assert_eq!(host.apply(event.clone()).unwrap().outcome, 1);
    assert_eq!(host.heads, Some(head));
    assert_eq!(host.apply(event).unwrap().outcome, 2);
    assert!(host
        .apply(Durable {
            seq: 9,
            event_id: [9; 16],
            event: Event::Captured(CapturedEvent {
                head,
                tree,
                base: head
            })
        })
        .is_err());
    assert_eq!(
        host.apply(Durable {
            seq: 8,
            event_id: [8; 16],
            event: Event::Captured(CapturedEvent {
                head,
                tree,
                base: head
            })
        })
        .unwrap()
        .outcome,
        1
    );
    assert_eq!(host.receipts.len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn pump_retries_missing_objects_and_deduplicates_real_receipts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (_source, bundle, head) = bundle();
    let tree = git(
        _source.path(),
        &["rev-parse", &format!("{}^{{tree}}", hex(&head))],
        None,
    )
    .unwrap();
    let tree = unhex(std::str::from_utf8(&tree).unwrap().trim()).unwrap();
    let daemon = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let d = Message::Events(Events::Durable(Durable {
            seq: 7,
            event_id: [7; 16],
            event: Event::Captured(CapturedEvent {
                head,
                tree,
                base: head,
            }),
        }));
        for expected in [3, 1, 2] {
            send(&mut s, d.clone()).await;
            let ack = Message::decode(&read(&mut s).await, Direction::HostToDaemon).unwrap();
            assert!(
                matches!(ack,Message::Events(Events::Ack(Ack{seq:7,outcome,..}))if outcome==expected)
            );
        }
    });
    let mut host = FakeHost::relay(addr).await.unwrap();
    host.import_bundle(&bundle).unwrap();
    host.script
        .faults
        .push(Fault::MissingObjects { seq: 7, times: 1 });
    let events = host.pump(Until::Frames(3)).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(host.receipts.len(), 1);
    daemon.await.unwrap();
}
#[tokio::test(flavor = "current_thread")]
async fn send_head_waits_for_objects_close_before_reconcile() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (_source, bundle, head) = bundle();
    let daemon = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut bundle = Vec::new();
        let stream = loop {
            let frame = read(&mut s).await;
            assert!(frame.stream >= 0x80000000);
            match Message::decode(&frame, Direction::HostToDaemon).unwrap() {
                Message::Object(StreamFrame::Data { bytes, .. }) => bundle.extend(bytes),
                Message::Object(StreamFrame::Eof { fd: 0 }) => break frame.stream,
                _ => panic!("object transfer"),
            }
        };
        assert!(bundle.starts_with(b"# v2 git bundle\n"));
        let mut byte = [0];
        assert!(matches!(s.try_read(&mut byte),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock));
        s.write_all(
            &Message::Object(StreamFrame::Close)
                .frame(stream, Direction::DaemonToHost)
                .unwrap()
                .encode()
                .unwrap(),
        )
        .await
        .unwrap();
        let r = match Message::decode(&read(&mut s).await, Direction::HostToDaemon).unwrap() {
            Message::Control(Control::Request(r)) => r,
            _ => panic!("reconcile"),
        };
        assert_eq!(r.call, Call::WakeReconcile(Head { head }));
        send(
            &mut s,
            Message::Control(Control::Response(Response {
                req_id: r.req_id,
                result: CallResult::WakeReconcile(Reconciled {
                    outcome: ReconcileOutcome::Unchanged(Empty {}),
                }),
            })),
        )
        .await;
    });
    let mut host = FakeHost::relay(addr).await.unwrap();
    host.import_bundle(&bundle).unwrap();
    host.send_head(head).await.unwrap();
    assert!(host.sent_prerequisites.contains(&head));
    daemon.await.unwrap();
}

#[test]
fn unimplemented_hook_unsupported() {
    let (out, _) = FrameTx::channel();
    let rpc = Rpc {
        state: State::Ready,
        hooks: smithers_machined::wiring::hooks(out),
    };
    let host = FakeHost::new().unwrap();
    // ADR 0004 open_doc req7 path "a"; unsupported response req7.
    let request = [
        0, 0, 0, 20, 1, 0, 0, 0, 0, 1, 0, 0, 0, 15, 1, 0, 0, 0, 7, 2, 13, 0, 0, 0, 4, 1, 0, 1, b'a',
    ];
    let expected = [
        0, 0, 0, 18, 1, 0, 0, 0, 0, 2, 0, 0, 0, 13, 1, 0, 0, 0, 7, 2, 255, 0, 0, 0, 2, 1, 2,
    ];
    host.replay(&rpc, &request, &expected).unwrap();
    assert!(host.receipts.is_empty());
    assert_eq!(host.heads, None);
}
