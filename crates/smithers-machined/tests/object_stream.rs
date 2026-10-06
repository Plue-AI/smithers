use smithers_machined::{
    conn::Frame,
    stream::{ObjectReceiver, ObjectSender},
};
use std::io::{self, Cursor, Read};
struct NoRead;
impl Read for NoRead {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        panic!("source read without credit")
    }
}
#[test]
fn encoded_objects_stop_source_at_zero_credit_then_resume_without_exceeding_window() {
    for id in [1, 2] {
        let source: Vec<_> = (0..700_001).map(|n| (n * 97) as u8).collect();
        let mut input = Cursor::new(&source);
        let mut sender = ObjectSender::new(id).unwrap();
        let mut receiver = ObjectReceiver::new(id).unwrap();
        let mut output = vec![];
        let mut frames = vec![];
        for _ in 0..4 {
            frames.push(sender.next(&mut input).unwrap().unwrap());
        }
        assert_eq!(input.position(), 262_144);
        assert_eq!(sender.outstanding(), 262_144);
        assert_eq!(sender.next(&mut NoRead).unwrap(), None);
        for frame in frames {
            let wire = Frame::decode(&frame.encode().unwrap()).unwrap();
            let window = receiver.receive(&wire, &mut output).unwrap().unwrap();
            sender
                .peer(&Frame::decode(&window.encode().unwrap()).unwrap())
                .unwrap();
        }
        loop {
            let frame = sender.next(&mut input).unwrap().unwrap();
            let wire = Frame::decode(&frame.encode().unwrap()).unwrap();
            let window = receiver.receive(&wire, &mut output).unwrap();
            assert!(sender.outstanding() <= 262_144);
            if let Some(window) = window {
                sender.peer(&window).unwrap();
            } else {
                break;
            }
        }
        assert_eq!(output, source);
        assert_eq!(sender.next(&mut NoRead).unwrap(), None);
        let close = receiver.verified_close().unwrap();
        sender.peer(&close).unwrap();
        assert!(receiver.verified_close().is_err());
    }
}
#[test]
fn refused_and_wrong_streams_never_poll_source_or_return_unearned_credit() {
    assert!(ObjectSender::new(0).is_err());
    assert!(ObjectReceiver::new(0).is_err());
    for payload in [
        vec![7],
        smithers_machined::conn::tagged(255, &[smithers_machined::conn::field(1, [2])]),
    ] {
        let mut sender = ObjectSender::new(1).unwrap();
        let mut receiver = ObjectReceiver::new(1).unwrap();
        assert!(receiver.verified_close().is_err());
        let mut frame = Frame {
            kind: 6,
            stream: 2,
            payload,
        };
        assert!(sender.peer(&frame).is_err());
        frame.stream = 1;
        sender.peer(&frame).unwrap();
        assert!(sender.next(&mut NoRead).is_err());
        receiver.receive(&frame, &mut vec![]).unwrap();
        assert!(receiver.verified_close().is_err());
    }
    let mut sender = ObjectSender::new(1).unwrap();
    let extra = Frame {
        kind: 6,
        stream: 1,
        payload: vec![6, 0, 0, 0, 1],
    };
    assert!(sender.peer(&extra).is_err());
}
#[test]
fn failed_consumer_closes_without_credit_and_eof_waits_for_explicit_import() {
    struct Fails;
    impl std::io::Write for Fails {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::WriteZero.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut receiver = ObjectReceiver::new(1).unwrap();
    let frame = Frame {
        kind: 6,
        stream: 1,
        payload: vec![1, 0, 3],
    };
    assert!(receiver.receive(&frame, &mut Fails).is_err());
    assert!(receiver.receive(&frame, &mut vec![]).is_err());
    assert!(receiver.verified_close().is_err());
    let mut receiver = ObjectReceiver::new(1).unwrap();
    assert_eq!(
        receiver
            .receive(
                &Frame {
                    kind: 6,
                    stream: 1,
                    payload: vec![2, 0]
                },
                &mut vec![]
            )
            .unwrap(),
        None
    );
    assert!(receiver.receive(&frame, &mut vec![]).is_err());
    assert_eq!(receiver.verified_close().unwrap().payload, vec![7]);
}
