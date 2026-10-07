//! Real authenticated sockets and durable outbox; repository/broker are fixtures.
use super::*;
use smithers_machined::{
    daemon::Daemon,
    hooks::{self, EventSink, Hooks},
};
use std::sync::atomic::AtomicBool;

#[test]
fn boot_replays_before_wake_or_roster() {
    super::capture_delivery_case("recovery-boot");
}
#[test]
fn conflict_delivers_without_admitting_mutations() {
    super::capture_delivery_case("recovery-conflict");
}
#[test]
fn failed_roster_does_not_block_receipts() {
    super::capture_delivery_case("recovery-roster");
}
#[test]
fn rewrite_barrier_does_not_block_receipts() {
    super::capture_delivery_case("recovery-pending");
}
#[test]
fn reconnect_replays_unacknowledged_recovery() {
    super::capture_delivery_case("recovery-reconnect");
}
#[test]
fn wrong_ack_cannot_discard_recovery() {
    super::capture_delivery_case("recovery-wrong-ack");
}
#[test]
fn wrong_stream_cannot_certify_recovery_bundle() {
    super::capture_delivery_case("recovery-wrong-stream");
}

pub(super) fn request(id: u32, method: u8, fields: &[Vec<u8>]) -> Frame {
    Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, id.to_be_bytes()),
                conn::field(2, conn::tagged(method, fields)),
            ],
        ),
    }
}
fn ack(seq: u64) -> Frame {
    Frame {
        kind: 2,
        stream: 0,
        payload: conn::tagged(3, &[conn::field(1, seq.to_be_bytes()), conn::field(2, [1])]),
    }
}
fn object_receipt(frame: &Frame) -> Frame {
    Frame {
        kind: 6,
        stream: frame.stream,
        payload: match frame.payload[0] {
            1 => [
                vec![6],
                ((frame.payload.len() - 2) as u32).to_be_bytes().to_vec(),
            ]
            .concat(),
            2 => vec![7],
            _ => panic!("unexpected object frame"),
        },
    }
}
struct RecoveryCore {
    events: Arc<dyn EventSink>,
    mode: String,
}
impl hooks::Core for RecoveryCore {
    fn ready(&self) -> hooks::Result<()> {
        Ok(())
    }
    fn call(
        &self,
        cx: &mut smithers_machined::lock::LockCx,
        method: u8,
        args: &[u8],
    ) -> hooks::Result<Vec<u8>> {
        if method == 5 && self.mode == "pending" {
            cx.begin_rewrite()?;
            return Err(smithers_machined::freeze::pending_error());
        }
        if method == 5 && self.mode == "conflict" {
            let paths = b"\0\x01\0\x05a.txt";
            self.events.append(
                &conn::tagged(
                    3,
                    &[
                        conn::field(1, [8; 20]),
                        conn::field(2, [10; 20]),
                        conn::field(3, [2]),
                        conn::field(4, paths),
                    ],
                ),
                None,
            )?;
            return Ok(conn::structure_bytes(&[conn::field(
                1,
                conn::tagged(3, &[conn::field(1, paths)]),
            )]));
        }
        hooks::Core::call(&Reconciler, cx, method, args)
    }
}
struct ClosedSessions;
impl hooks::Sessions for ClosedSessions {
    fn ready(&self) -> hooks::Result<()> {
        Ok(())
    }
    fn poll(&self) -> hooks::Result<Vec<Frame>> {
        panic!("session output before admission")
    }
    fn call(&self, _: u8, _: &[u8]) -> hooks::Result<Vec<u8>> {
        panic!("session RPC before admission")
    }
    fn frame(&self, _: &Frame) -> hooks::Result<Option<Frame>> {
        panic!("session input before admission")
    }
}

pub(super) fn run(events: Arc<dyn EventSink>, mode: &str) {
    if mode != "conflict" {
        events
            .append(
                &smithers_machined::outbox::captured([10; 20], [9; 20], [8; 20]),
                Some([10; 20]),
            )
            .unwrap();
    }
    let daemon = Arc::new(
        Daemon::new(Hooks {
            core: Arc::new(RecoveryCore {
                events: events.clone(),
                mode: mode.into(),
            }),
            events: events.clone(),
            broker: Arc::new(Roster(AtomicBool::new(mode == "roster"))),
            watcher: Arc::new(Ready),
            documents: Arc::new(Ready),
            sessions: Arc::new(ClosedSessions),
            ..Default::default()
        })
        .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let reconnect = matches!(mode, "reconnect" | "wrong-ack" | "wrong-stream");
    let d = daemon.clone();
    let worker = thread::spawn(move || {
        let identity = Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap();
        for _ in 0..if reconnect { 2 } else { 1 } {
            let (stream, _) = listener.accept().unwrap();
            let authenticated = link::authenticate(stream, &identity, 7, &[]).unwrap();
            let _ = d.serve(authenticated);
        }
    });
    let mut retained = None;
    let mut retained_bytes = None;
    for attempt in 0..if reconnect { 2 } else { 1 } {
        let mut stream = TcpStream::connect(address).unwrap();
        host(&mut stream, &[9; 32], true);
        let setup = matches!(mode, "conflict" | "pending" | "roster");
        if setup {
            request(1, 5, &[conn::field(1, [10; 20])])
                .write(&mut stream)
                .unwrap();
            request(2, 16, &[conn::field(1, 0u16.to_be_bytes())])
                .write(&mut stream)
                .unwrap();
        }
        request(3, 4, &[]).write(&mut stream).unwrap();
        request(4, 1, &[]).write(&mut stream).unwrap();
        let mut responses = std::collections::BTreeSet::new();
        let mut event = None;
        let mut bytes = Vec::new();
        let mut invalid_stream = false;
        while event.is_none() || responses.len() < if setup { 4 } else { 2 } {
            let frame = Frame::read(&mut stream).expect("recovery must progress before readiness");
            match frame.kind {
                6 => {
                    if frame.payload[0] == 1 {
                        bytes.extend_from_slice(&frame.payload[2..]);
                    }
                    let mut reply = object_receipt(&frame);
                    if mode == "wrong-stream" && attempt == 0 {
                        reply.stream += 1;
                        reply.write(&mut stream).unwrap();
                        // Earlier status responses may already be buffered.
                        while let Ok(next) = Frame::read(&mut stream) {
                            assert!(
                                matches!(next.kind, 1 | 6),
                                "invalid stream certified bundle delivery"
                            );
                        }
                        assert!(!events.drained().unwrap());
                        invalid_stream = true;
                        break;
                    }
                    reply.write(&mut stream).unwrap();
                }
                2 => {
                    let durable = conn::Durable::decode(&frame.payload).unwrap();
                    assert_eq!(bytes, vec![b'x'; 300_000], "incomplete recovery bundle");
                    assert_eq!(durable.event[0], if mode == "conflict" { 3 } else { 2 });
                    if let Some(identity) = retained {
                        assert_eq!((durable.seq, durable.id), identity);
                    }
                    if let Some(old) = &retained_bytes {
                        assert_eq!(&bytes, old);
                    }
                    retained = Some((durable.seq, durable.id));
                    retained_bytes = Some(bytes.clone());
                    event = Some(durable);
                }
                1 => {
                    let fields = conn::fields("response", &frame.payload[1..]).unwrap();
                    let id = u32::from_be_bytes(fields[0].1.try_into().unwrap());
                    let result = fields[1].1;
                    assert!(responses.insert(id), "duplicate response");
                    match id {
                        1 if mode == "pending" => assert_eq!(result[0], 255),
                        1 => {
                            assert_eq!(result[0], 5);
                            let outcome = conn::fields("result5", &result[1..]).unwrap()[0].1[0];
                            assert_eq!(outcome, if mode == "conflict" { 3 } else { 1 });
                        }
                        2 => assert_eq!(result[0], if mode == "roster" { 255 } else { 16 }),
                        3 => {
                            assert_eq!(result[0], 255);
                            assert_eq!(conn::fields("error", &result[1..]).unwrap()[0].1, [3]);
                        }
                        4 => assert_eq!(conn::fields("result1", &result[1..]).unwrap()[0].1, [2]),
                        _ => panic!("unexpected RPC response"),
                    }
                }
                _ => panic!("unexpected frame"),
            }
        }
        assert!(!daemon.ready());
        assert!(!events.drained().unwrap());
        if invalid_stream {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            continue;
        }
        let event = event.unwrap();
        if reconnect && attempt == 0 {
            if mode == "wrong-ack" {
                ack(event.seq + 1).write(&mut stream).unwrap();
                assert!(Frame::read(&mut stream).is_err(), "wrong ACK accepted");
                assert!(!events.drained().unwrap());
            }
            let _ = stream.shutdown(std::net::Shutdown::Both);
            continue;
        }
        ack(event.seq).write(&mut stream).unwrap();
        // This ordered status reply proves the ACK was consumed.
        let status = call(&mut stream, 5, 1, &[]);
        let result = conn::fields("response", &status.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result1", &result[1..]).unwrap()[0].1, [2]);
        assert!(events.drained().unwrap());
        assert!(!daemon.ready(), "delivery must not grant admission");
        // Draining recovery does not authorize opening a session/document or
        // changing a file. These are valid requests from the shared wire corpus.
        for bytes in [
            &include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"),
                "/../../packages/backend/internal/compose/testdata/cocontracts/req_open_session.bin"))[..],
            &include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"),
                "/../../packages/backend/internal/compose/testdata/cocontracts/req_open_doc_s3.bin"))[..],
            &include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"),
                "/../../packages/backend/internal/compose/testdata/cocontracts/req_write_file.bin"))[..],
        ] {
            Frame::read(&mut &bytes[..]).unwrap().write(&mut stream).unwrap();
            let refused = Frame::read(&mut stream).unwrap();
            let result = conn::fields("response", &refused.payload[1..]).unwrap()[1].1;
            assert_eq!(result[0], 255);
            assert_eq!(conn::fields("error", &result[1..]).unwrap()[0].1, [3]);
        }
        // Valid session and document frames remain barred after recovery drains.
        for frame in
            [
                Frame {
                    kind: 5,
                    stream: 17,
                    payload: vec![1, 0, b'x'],
                },
                Frame::read(
                    &mut &include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"),
                "/../../packages/backend/internal/compose/testdata/cocontracts/doc-input.bin"))[..],
                )
                .unwrap(),
            ]
        {
            frame.write(&mut stream).unwrap();
            let refused = Frame::read(&mut stream).unwrap();
            assert_eq!((refused.kind, refused.stream), (frame.kind, frame.stream));
            assert_eq!(refused.payload[0], 255);
            assert_eq!(
                conn::fields("error", &refused.payload[1..]).unwrap()[0].1,
                [3]
            );
        }
        stream.shutdown(std::net::Shutdown::Both).unwrap();
    }
    worker.join().unwrap();
    assert!(!daemon.ready());
    assert!(events.drained().unwrap());
    // No session poll or input hook was invoked (ClosedSessions panics).
}
