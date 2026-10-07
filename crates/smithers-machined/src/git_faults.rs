// Process crashes through the production authenticated connection and writer.
use super::*;
use crate::hooks::{self, EventSink};
use std::{
    net::{TcpListener, TcpStream},
    sync::Arc,
    time::Duration,
};
struct Ready;
macro_rules! ready {
    ($name:ident) => {
        impl hooks::$name for Ready {
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
        }
    };
}
ready!(Watcher);
ready!(Documents);
ready!(Sessions);
ready!(Broker);
ready!(Core);

#[test]
fn delivery_crash_child() {
    let Some(root) = std::env::var_os("MACHINED_DELIVERY_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let repository = Repository::checked(
        Path::new("/usr/bin/git"),
        &root.join("repo"),
        &root.join("spool"),
    )
    .unwrap();
    let fixture = Fixture { root, repository };
    let events = Arc::new(
        crate::event_service::Events::new(fixture.outbox(), fixture.repository.clone(), || Ok(1))
            .unwrap(),
    );
    let daemon = crate::daemon::Daemon::new(hooks::Hooks {
        watcher: Arc::new(Ready),
        documents: Arc::new(Ready),
        sessions: Arc::new(Ready),
        broker: Arc::new(Ready),
        core: Arc::new(Ready),
        events,
        ..Default::default()
    })
    .unwrap();
    let stream = TcpStream::connect(std::env::var("MACHINED_DELIVERY_ADDR").unwrap()).unwrap();
    let identity =
        crate::link::Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap();
    let auth = crate::link::authenticate(stream, &identity, 2, &[]).unwrap();
    daemon.serve(auth).unwrap();
    panic!("fault point did not terminate the process");
}

fn authenticate(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let challenge = Frame::read(stream).unwrap();
    let fields = conn::fields("challenge", &challenge.payload[1..]).unwrap();
    let boot = fields[2].1.try_into().unwrap();
    let nonce = fields[3].1.try_into().unwrap();
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(
            2,
            &[
                conn::field(1, conn::PROTOCOL.to_be_bytes()),
                conn::field(2, conn::host_mac(&[9; 32], conn::PROTOCOL, &boot, &nonce)),
            ],
        ),
    }
    .write(stream)
    .unwrap();
    assert_eq!(Frame::read(stream).unwrap().payload[0], 3);
    Frame {
        kind: 0,
        stream: 0,
        payload: conn::tagged(4, &[]),
    }
    .write(stream)
    .unwrap();
}

#[test]
fn k3b_k5b_k5c_replay_pinned_capture_after_process_crash_ten_times_each() {
    for point in ["K3b", "K5b", "K5c"] {
        for _ in 0..10 {
            let source = Fixture::new();
            let destination = Fixture::new();
            let head = source.commit();
            let (seq, event_id) = source
                .outbox()
                .append(&outbox::captured(head, [2; 20], [3; 20]), Some(head))
                .unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "git::tests::faults::delivery_crash_child",
                    "--nocapture",
                ])
                .env("MACHINED_DELIVERY_ROOT", &source.root)
                .env(
                    "MACHINED_DELIVERY_ADDR",
                    listener.local_addr().unwrap().to_string(),
                )
                .env("SMITHERS_MACHINED_KILL_AT", point)
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let (mut socket, _) = listener.accept().unwrap();
            authenticate(&mut socket);
            let mut bundle = Vec::new();
            loop {
                let frame = Frame::read(&mut socket).unwrap();
                assert_eq!((frame.kind, frame.stream), (6, 1));
                if frame.payload[0] == 2 {
                    break;
                }
                assert_eq!(&frame.payload[..2], &[1, 0]);
                bundle.extend_from_slice(&frame.payload[2..]);
                if point == "K5b" {
                    break;
                }
                let mut window = vec![6];
                window.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
                Frame {
                    kind: 6,
                    stream: 1,
                    payload: window,
                }
                .write(&mut socket)
                .unwrap();
            }
            if point == "K5c" {
                let spool = destination
                    .repository
                    .receive(&bundle[..], 4 * 1024 * 1024)
                    .unwrap();
                destination.repository.import(&spool, head).unwrap();
                Frame {
                    kind: 6,
                    stream: 1,
                    payload: vec![7],
                }
                .write(&mut socket)
                .unwrap();
                let sent =
                    conn::Durable::decode(&Frame::read(&mut socket).unwrap().payload).unwrap();
                assert_eq!(
                    (sent.seq, sent.id, sent.captured_head()),
                    (seq, event_id, Some(head))
                );
            }
            assert_eq!(child.wait().unwrap().code(), Some(73), "{point}");
            assert!(Frame::read(&mut socket).is_err());
            let recovered = source.outbox().front().unwrap().unwrap();
            assert_eq!(
                (recovered.seq, recovered.id, recovered.captured_head()),
                (seq, event_id, Some(head))
            );
            assert_eq!(source.repository.clone().pending().unwrap(), [event_id]);
            assert_eq!(source.repository.acknowledged().unwrap(), None);
            // Reopen the production delivery state, import a freshly exported
            // bundle, and certify it before sending a literal successful receipt.
            let events = crate::event_service::Events::new(
                source.outbox(),
                source.repository.clone(),
                || Ok(2),
            )
            .unwrap();
            let mut replay = vec![];
            loop {
                let frame = events.poll().unwrap().remove(0);
                if frame.payload[0] == 2 {
                    break;
                }
                replay.extend_from_slice(&frame.payload[2..]);
                let mut window = vec![6];
                window.extend(((frame.payload.len() - 2) as u32).to_be_bytes());
                events
                    .frame(&Frame {
                        kind: 6,
                        stream: 2,
                        payload: window,
                    })
                    .unwrap();
            }
            let spool = destination
                .repository
                .receive(&replay[..], 4 * 1024 * 1024)
                .unwrap();
            destination.repository.import(&spool, head).unwrap();
            assert!(destination.repository.contains(head).unwrap());
            let event = events
                .frame(&Frame {
                    kind: 6,
                    stream: 2,
                    payload: vec![7],
                })
                .unwrap()
                .unwrap();
            let event = conn::Durable::decode(&event.payload).unwrap();
            assert_eq!((event.seq, event.id), (seq, event_id));
            events
                .frame(&Frame {
                    kind: 2,
                    stream: 0,
                    payload: conn::tagged(
                        3,
                        &[conn::field(1, seq.to_be_bytes()), conn::field(2, [1])],
                    ),
                })
                .unwrap();
            assert!(events.drained().unwrap());
            assert_eq!(source.repository.acknowledged().unwrap(), Some(head));
            assert!(source.repository.clone().pending().unwrap().is_empty());
        }
    }
}
