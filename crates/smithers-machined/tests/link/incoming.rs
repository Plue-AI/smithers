use super::*;
use smithers_machined::{
    hooks::{EventSink, Hooks},
    incoming::{Bundle, Store},
};
use std::{
    io::{self, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Mutex,
    },
};

#[test]
fn authenticated_import_leaves_control_responsive_and_admission_closed() {
    super::capture_delivery_case("incoming-import");
}
#[test]
fn authenticated_disconnect_drops_incomplete_bundle() {
    super::capture_delivery_case("incoming-disconnect");
}
struct Storage {
    gate: Mutex<Option<mpsc::Receiver<()>>>,
    drops: Arc<AtomicUsize>,
}
struct Spool {
    gate: mpsc::Receiver<()>,
    drops: Arc<AtomicUsize>,
}
impl Write for Spool {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for Spool {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}
impl Bundle for Spool {
    fn finish(self: Box<Self>, _: u32) -> io::Result<()> {
        self.gate
            .recv_timeout(Duration::from_secs(5))
            .map_err(io::Error::other)
    }
}
impl Store for Storage {
    fn begin(&self) -> io::Result<Box<dyn Bundle>> {
        Ok(Box::new(Spool {
            gate: self.gate.lock().unwrap().take().unwrap(),
            drops: self.drops.clone(),
        }))
    }
}
pub(super) fn run(mode: &str, make: impl FnOnce(Arc<dyn Store>) -> Arc<dyn EventSink>) {
    let (gate, rx) = mpsc::channel();
    let drops = Arc::new(AtomicUsize::new(0));
    let events = make(Arc::new(Storage {
        gate: Mutex::new(Some(rx)),
        drops: drops.clone(),
    }));
    let daemon = Arc::new(
        smithers_machined::daemon::Daemon::new(Hooks {
            core: Arc::new(Reconciler),
            events,
            broker: Arc::new(Roster(Default::default())),
            watcher: Arc::new(Ready),
            documents: Arc::new(Ready),
            sessions: Arc::new(Ready),
            ..Default::default()
        })
        .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let d = daemon.clone();
    let worker = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let identity = Identity::new([4; 16], [9; 32], b"fixture-machine-token".to_vec()).unwrap();
        let auth = link::authenticate(socket, &identity, 7, &[]).unwrap();
        let _ = d.serve(auth);
    });
    let mut socket = TcpStream::connect(address).unwrap();
    host(&mut socket, &[9; 32], true);
    let stream = 0x8000_0000;
    Frame {
        kind: 6,
        stream,
        payload: vec![1, 0, 42],
    }
    .write(&mut socket)
    .unwrap();
    let window = Frame::read(&mut socket).unwrap();
    assert_eq!(
        (window.kind, window.stream, window.payload),
        (6, stream, vec![6, 0, 0, 0, 1])
    );
    if mode == "import" {
        Frame {
            kind: 6,
            stream,
            payload: vec![2, 0],
        }
        .write(&mut socket)
        .unwrap();
        // The import is deliberately unresolved, yet both status and roster
        // must finish on this same connection before its release channel fires.
        let status = call(&mut socket, 1, 1, &[]);
        let result = conn::fields("response", &status.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result1", &result[1..]).unwrap()[0].1, [2]);
        call(&mut socket, 2, 16, &[conn::field(1, 0u16.to_be_bytes())]);
        let refused = call(&mut socket, 3, 4, &[]);
        let result = conn::fields("response", &refused.payload[1..]).unwrap()[1].1;
        assert_eq!(result[0], 255);
        assert!(!daemon.ready());
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        gate.send(()).unwrap();
        let close = Frame::read(&mut socket).unwrap();
        assert_eq!(
            (close.kind, close.stream, close.payload),
            (6, stream, vec![7])
        );
        assert!(!daemon.ready(), "import must not grant session admission");
        call(&mut socket, 4, 5, &[conn::field(1, [8; 20])]);
        assert!(daemon.ready());
    }
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    worker.join().unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
