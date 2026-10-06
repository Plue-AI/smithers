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
