use smithers_machined::{
    conn::{self, Frame, ProtocolError},
    link::{self, Identity, Live},
};
use std::{
    io::Read,
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
fn hello(variant: u8, fields: &[Vec<u8>]) -> Frame {
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(variant, fields),
    }
}
fn host(stream: &mut TcpStream, secret: &[u8], good: bool) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let challenge = Frame::read(stream).unwrap();
    assert_eq!(challenge.payload[0], 1);
    let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
    let boot: [u8; 16] = fields[2].1.try_into().unwrap();
    let nonce: [u8; 32] = fields[3].1.try_into().unwrap();
    let mac = if good {
        conn::host_mac(secret, &boot, &nonce)
    } else {
        [0; 32]
    };
    hello(
        2,
        &[conn::field(1, 1u16.to_be_bytes()), conn::field(2, mac)],
    )
    .write(stream)
    .unwrap();
    let frame = Frame::read(stream).unwrap();
    if !good {
        assert_eq!(frame.payload, vec![5, 0, 0, 0, 2, 1, 14]);
        return;
    }
    assert_eq!(frame.payload[0], 3);
    let fields = conn::fields("hello", &frame.payload[1..]).unwrap();
    assert_eq!(&fields[0].1[4..], b"fixture-machine-token");
    assert_eq!(fields[2].1, 7u64.to_be_bytes());
    hello(4, &[]).write(stream).unwrap();
}
#[test]
fn proof_failure_preserves_live_and_valid_candidate_replaces_it() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let identity =
        Arc::new(Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap());
    let live = Arc::new(Live::default());
    let worker = thread::spawn(move || {
        let mut retained = Vec::new();
        for expected in [true, false, true] {
            let (socket, _) = listener.accept().unwrap();
            match link::authenticate(socket, &identity, 7, &[]) {
                Ok(auth) => {
                    assert!(expected);
                    live.replace(&auth).unwrap();
                    retained.push(auth);
                }
                Err(error) => {
                    assert!(!expected);
                    assert_eq!(error, ProtocolError::AuthFailed);
                }
            }
        }
        retained
    });
    let mut first = TcpStream::connect(addr).unwrap();
    host(&mut first, &[9; 32], true);
    let mut bad = TcpStream::connect(addr).unwrap();
    host(&mut bad, &[9; 32], false);
    first
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let mut byte = [0];
    assert!(
        first.read(&mut byte).is_err(),
        "bad candidate closed original"
    );
    let start = Instant::now();
    let mut replacement = TcpStream::connect(addr).unwrap();
    host(&mut replacement, &[9; 32], true);
    let retained = worker.join().unwrap();
    first
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(
        Frame::read(&mut first).unwrap().payload,
        vec![5, 0, 0, 0, 2, 1, 15]
    );
    assert_eq!(first.read(&mut byte).unwrap(), 0);
    assert!(start.elapsed() < Duration::from_secs(1));
    drop(retained);
}
#[test]
fn backoff_is_bounded_and_resettable() {
    let mut backoff = link::Backoff::default();
    for ms in [250, 500, 1000, 2000, 4000, 5000, 5000, 5000] {
        assert_eq!(backoff.delay(), Duration::from_millis(ms));
    }
    for _ in 0..300 {
        assert_eq!(backoff.delay(), Duration::from_secs(5));
    }
    backoff.reset();
    assert_eq!(backoff.delay(), Duration::from_millis(250));
}

#[test]
fn handshake_order_refuses_before_credentials_and_welcome_is_required() {
    for welcome_first in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let identity = Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap();
        let worker = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            match link::authenticate(socket, &identity, 7, &[]) {
                Ok(_) => panic!("out-of-order handshake admitted"),
                Err(e) => assert_eq!(e, ProtocolError::HandshakeOrder),
            }
        });
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let challenge = Frame::read(&mut stream).unwrap();
        if !welcome_first {
            let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
            let boot = fields[2].1.try_into().unwrap();
            let nonce = fields[3].1.try_into().unwrap();
            hello(
                2,
                &[
                    conn::field(1, 1u16.to_be_bytes()),
                    conn::field(2, conn::host_mac(&[9; 32], &boot, &nonce)),
                ],
            )
            .write(&mut stream)
            .unwrap();
            assert_eq!(Frame::read(&mut stream).unwrap().payload[0], 3);
        }
        if welcome_first {
            hello(4, &[]).write(&mut stream).unwrap();
        } else {
            Frame {
                kind: 1,
                stream: 0,
                payload: conn::tagged(
                    1,
                    &[
                        conn::field(1, 1u32.to_be_bytes()),
                        conn::field(2, conn::tagged(1, &[])),
                    ],
                ),
            }
            .write(&mut stream)
            .unwrap();
        }
        assert_eq!(
            Frame::read(&mut stream).unwrap().payload,
            vec![5, 0, 0, 0, 2, 1, 16]
        );
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 0);
        worker.join().unwrap();
    }
}

fn call(stream: &mut TcpStream, id: u32, method: u8, fields: &[Vec<u8>]) -> Frame {
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
    .write(stream)
    .unwrap();
    Frame::read(stream).unwrap()
}
struct Reconciler;
impl smithers_machined::hooks::Core for Reconciler {
    fn ready(&self) -> smithers_machined::hooks::Result<()> {
        Ok(())
    }
    fn call(
        &self,
        _: &mut smithers_machined::lock::LockCx,
        method: u8,
        _: &[u8],
    ) -> smithers_machined::hooks::Result<Vec<u8>> {
        if method == 1 {
            Ok(conn::structure_bytes(&[
                conn::field(1, [3]),
                conn::field(2, 1u16.to_be_bytes()),
                conn::field(3, [0, 1, b'v']),
                conn::field(4, 7u32.to_be_bytes()),
                conn::field(6, 2u16.to_be_bytes()),
            ]))
        } else if method == 5 {
            Ok(conn::structure_bytes(&[conn::field(
                1,
                conn::tagged(1, &[]),
            )]))
        } else {
            Err(smithers_machined::hooks::Error {
                code: 4,
                current_digest: Some([0x33; 32]),
                ..smithers_machined::hooks::Error::unsupported()
            })
        }
    }
}
struct Roster;
impl smithers_machined::hooks::Broker for Roster {
    fn ready(&self) -> smithers_machined::hooks::Result<()> {
        Ok(())
    }
    fn set_roster(
        &self,
        _: &[smithers_machined::broker::sessions::User],
    ) -> smithers_machined::hooks::Result<()> {
        Ok(())
    }
}
struct Ready;
macro_rules! ready {
    ($t:ident) => {
        impl smithers_machined::hooks::$t for Ready {
            fn ready(&self) -> smithers_machined::hooks::Result<()> {
                Ok(())
            }
        }
    };
}
ready!(Watcher);
ready!(Documents);
ready!(Sessions);
ready!(EventSink);
#[test]
fn authenticated_dispatch_requires_reconcile_and_roster_on_every_link() {
    let daemon = Arc::new(
        smithers_machined::daemon::Daemon::new(smithers_machined::hooks::Hooks {
            core: Arc::new(Reconciler),
            broker: Arc::new(Roster),
            watcher: Arc::new(Ready),
            documents: Arc::new(Ready),
            sessions: Arc::new(Ready),
            events: Arc::new(Ready),
            ..Default::default()
        })
        .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let d = daemon.clone();
    let worker = thread::spawn(move || {
        let identity = Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap();
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let authenticated = link::authenticate(stream, &identity, 7, &[]).unwrap();
            let _ = d.serve(authenticated);
        }
    });
    for reconnect in [false, true] {
        let mut stream = TcpStream::connect(addr).unwrap();
        host(&mut stream, &[9; 32], true);
        let status = call(&mut stream, 1, 1, &[]);
        let result = conn::fields("response", &status.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result1", &result[1..]).unwrap()[0].1, &[2]);
        let metrics = conn::fields("result1", &result[1..]).unwrap();
        assert_eq!(metrics[3].1, 7u32.to_be_bytes());
        assert_eq!(metrics[4].1, 2u16.to_be_bytes());
        let refused = call(&mut stream, 2, 4, &[]);
        assert_eq!(
            conn::fields("response", &refused.payload[1..]).unwrap()[1].1[0],
            255
        );
        if !reconnect {
            call(&mut stream, 3, 5, &[conn::field(1, [1; 20])]);
            assert!(
                !daemon.ready(),
                "reconciliation alone must not admit sessions"
            );
        }
        call(&mut stream, 4, 16, &[conn::field(1, 0u16.to_be_bytes())]);
        assert!(daemon.ready());
        let status = call(&mut stream, 5, 1, &[]);
        let result = conn::fields("response", &status.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result1", &result[1..]).unwrap()[0].1, &[3]);
        let fixture = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/backend/internal/compose/testdata/cocontracts/req_write_file.bin"
        ))
        .to_vec();
        use std::io::Write;
        stream.write_all(&fixture).unwrap();
        let stale = Frame::read(&mut stream).unwrap();
        assert_eq!(
            stale.encode().unwrap(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../packages/backend/internal/compose/testdata/cocontracts/err_stale.bin"
            ))
        );
        let result = conn::fields("response", &stale.payload[1..]).unwrap()[1].1;
        assert_eq!(result[0], 255);
        assert_eq!(conn::fields("error", &result[1..]).unwrap()[0].1, &[4]);
        stream.shutdown(std::net::Shutdown::Both).unwrap();
    }
    worker.join().unwrap();
}
