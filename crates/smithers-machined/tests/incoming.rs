use smithers_machined::{
    conn::Frame,
    incoming::{self, Bundle, Incoming, Store},
};
use std::{
    io::{self, Write},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

struct Storage {
    bytes: Arc<Mutex<Vec<u8>>>,
    gate: Mutex<Option<mpsc::Receiver<bool>>>,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
}
struct Spool {
    bytes: Arc<Mutex<Vec<u8>>>,
    gate: Option<mpsc::Receiver<bool>>,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for Spool {
    fn drop(&mut self) {
        self.dropped
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}
impl Write for Spool {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes.lock().unwrap().extend(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Bundle for Spool {
    fn finish(self: Box<Self>, _: u32) -> io::Result<()> {
        if let Some(gate) = &self.gate {
            if !gate.recv_timeout(Duration::from_secs(2)).unwrap() {
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        Ok(())
    }
}
impl Store for Storage {
    fn begin(&self) -> io::Result<Box<dyn Bundle>> {
        Ok(Box::new(Spool {
            bytes: self.bytes.clone(),
            gate: self.gate.lock().unwrap().take(),
            dropped: self.dropped.clone(),
        }))
    }
}
fn data(stream: u32, bytes: &[u8]) -> Frame {
    Frame {
        kind: 6,
        stream,
        payload: [vec![1, 0], bytes.to_vec()].concat(),
    }
}
fn eof(stream: u32) -> Frame {
    Frame {
        kind: 6,
        stream,
        payload: vec![2, 0],
    }
}
fn fixture() -> (Incoming, Arc<Storage>, mpsc::Sender<bool>) {
    let (tx, rx) = mpsc::channel();
    let store = Arc::new(Storage {
        bytes: Default::default(),
        gate: Mutex::new(Some(rx)),
        dropped: Default::default(),
    });
    (Incoming::new(store.clone()), store, tx)
}
fn completed(incoming: &Incoming) -> Frame {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(frame) = incoming.poll().unwrap() {
            return frame;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn credit_follows_storage_and_close_waits_for_import() {
    let (incoming, store, tx) = fixture();
    let stream = 0x8000_0000;
    let bytes = vec![71; 65_536];
    for _ in 0..5 {
        let window = incoming.frame(&data(stream, &bytes)).unwrap().unwrap();
        assert_eq!(
            window.payload,
            [vec![6], 65_536u32.to_be_bytes().to_vec()].concat()
        );
    }
    assert_eq!(*store.bytes.lock().unwrap(), vec![71; 5 * 65_536]);
    assert!(incoming.frame(&eof(stream)).unwrap().is_none());
    assert!(
        incoming.poll().unwrap().is_none(),
        "spooled bytes are not imported objects"
    );
    assert!(
        incoming.frame(&data(stream + 1, b"overlap")).is_err(),
        "unbounded import workers"
    );
    tx.send(true).unwrap();
    let close = completed(&incoming);
    assert_eq!((close.stream, close.payload), (stream, vec![7]));
    assert!(incoming.frame(&data(stream, b"reused")).is_err());
    assert!(incoming.frame(&data(stream + 1, b"new")).is_ok());
}
#[test]
fn failed_import_never_closes_successfully() {
    let (incoming, _, tx) = fixture();
    incoming.frame(&data(0x8000_0000, b"bad bundle")).unwrap();
    incoming.frame(&eof(0x8000_0000)).unwrap();
    tx.send(false).unwrap();
    assert_eq!(completed(&incoming).payload[0], 255);
}
#[test]
fn disconnect_discards_spool_and_fences_late_completion() {
    let (incoming, store, tx) = fixture();
    incoming.frame(&data(0x8000_0000, b"partial")).unwrap();
    incoming.disconnect().unwrap();
    assert_eq!(store.dropped.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(incoming.frame(&data(0x8000_0000, b"reuse")).is_err());
    incoming.frame(&data(0x8000_0001, b"complete")).unwrap();
    incoming.frame(&eof(0x8000_0001)).unwrap();
    incoming.disconnect().unwrap();
    // The gate belonged to the abandoned spool, so the second import may
    // already be complete. Regardless of timing, it cannot close a new link.
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(incoming.poll().unwrap().is_none());
        if incoming
            .frame(&data(0x8000_0002, b"new generation"))
            .is_ok()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn pending_import_stays_bounded_across_reconnect() {
    let (incoming, _, tx) = fixture();
    incoming.frame(&data(0x8000_0000, b"bundle")).unwrap();
    incoming.frame(&eof(0x8000_0000)).unwrap();
    for _ in 0..10 {
        incoming.disconnect().unwrap();
        assert!(incoming.frame(&data(0x8000_0001, b"new")).is_err());
        assert!(incoming.poll().unwrap().is_none());
    }
    tx.send(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(
            incoming.poll().unwrap().is_none(),
            "stale completion reached successor"
        );
        if incoming.frame(&data(0x8000_0001, b"new")).is_ok() {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn malformed_direction_ids_and_order_never_write() {
    let (incoming, store, _) = fixture();
    for frame in [
        data(1, b"x"),
        data(0, b"x"),
        data(0x8000_0000, b""),
        eof(0x8000_0000),
        Frame {
            kind: 6,
            stream: 0x8000_0000,
            payload: vec![1, 1, 42],
        },
        Frame {
            kind: 6,
            stream: 0x8000_0000,
            payload: vec![7],
        },
    ] {
        assert!(incoming.frame(&frame).is_err());
    }
    assert!(store.bytes.lock().unwrap().is_empty());
    incoming.frame(&data(0xffff_ffff, b"last")).unwrap();
    assert!(incoming.frame(&data(0x8000_0000, b"other")).is_err());
    incoming.disconnect().unwrap();
    assert!(incoming.frame(&data(0xffff_ffff, b"reused")).is_err());
    assert_eq!(*store.bytes.lock().unwrap(), b"last");
}

#[test]
fn store_failure_returns_no_credit() {
    struct Full;
    impl Store for Full {
        fn begin(&self) -> io::Result<Box<dyn Bundle>> {
            Err(io::ErrorKind::StorageFull.into())
        }
    }
    let incoming = Incoming::new(Arc::new(Full));
    let refusal = incoming.frame(&data(0x8000_0000, b"x")).unwrap().unwrap();
    assert_eq!(refusal.payload[0], 255);
    assert!(incoming.poll().unwrap().is_none());
}

#[test]
fn total_bundle_size_is_bounded_independently_of_returned_credit() {
    struct Counting(std::sync::atomic::AtomicU64);
    struct Sink(Arc<Counting>);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                 .0
                .fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::SeqCst);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Bundle for Sink {
        fn finish(self: Box<Self>, _: u32) -> io::Result<()> {
            Ok(())
        }
    }
    struct CountingStore(Arc<Counting>);
    impl Store for CountingStore {
        fn begin(&self) -> io::Result<Box<dyn Bundle>> {
            Ok(Box::new(Sink(self.0.clone())))
        }
    }
    let count = Arc::new(Counting(std::sync::atomic::AtomicU64::new(0)));
    let incoming = Incoming::new(Arc::new(CountingStore(count.clone())));
    let frame = data(0x8000_0000, &vec![0; 65_536]);
    for _ in 0..incoming::LIMIT / 65_536 {
        assert!(incoming.frame(&frame).unwrap().is_some());
    }
    assert!(incoming.frame(&data(0x8000_0000, b"x")).is_err());
    assert_eq!(
        count.0.load(std::sync::atomic::Ordering::SeqCst),
        incoming::LIMIT
    );
    incoming.disconnect().unwrap();
}

#[test]
fn write_and_flush_failures_drop_spool_without_credit_or_close() {
    struct Broken {
        flush: bool,
        dropped: Arc<std::sync::atomic::AtomicUsize>,
    }
    struct BrokenStore(bool, Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Broken {
        fn drop(&mut self) {
            self.dropped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    impl Write for Broken {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if self.flush {
                Ok(b.len())
            } else {
                Err(io::ErrorKind::StorageFull.into())
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::StorageFull.into())
        }
    }
    impl Bundle for Broken {
        fn finish(self: Box<Self>, _: u32) -> io::Result<()> {
            panic!("failed spool must not import")
        }
    }
    impl Store for BrokenStore {
        fn begin(&self) -> io::Result<Box<dyn Bundle>> {
            Ok(Box::new(Broken {
                flush: self.0,
                dropped: self.1.clone(),
            }))
        }
    }
    for flush in [false, true] {
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let incoming = Incoming::new(Arc::new(BrokenStore(flush, dropped.clone())));
        let mut response = incoming.frame(&data(0x8000_0000, b"x")).unwrap().unwrap();
        if flush {
            assert_eq!(response.payload[0], 6);
            response = incoming.frame(&eof(0x8000_0000)).unwrap().unwrap();
        }
        assert_eq!(response.payload[0], 255);
        assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(incoming.poll().unwrap().is_none());
    }
}
