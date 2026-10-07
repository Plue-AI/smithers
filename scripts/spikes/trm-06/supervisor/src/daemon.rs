//! Installed-provider daemon loop. No executable entrypoint accepts a branch
//! address or credential. The provider authenticates before control dispatch.
use crate::control::{self, Supervisor};
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

type Worker = (TcpStream, JoinHandle<()>);

/// Only call after installed provenance/receipts, fixed account setup and the
/// startup barrier. The listener and authenticator belong to that provider.
/// A timer closes expired streams independently of incoming relay traffic.
pub fn serve(
    listener: TcpListener,
    supervisor: Arc<Mutex<Supervisor>>,
    authenticate: impl Fn(&mut TcpStream) -> io::Result<()> + Send + Sync + 'static,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    let dispatch_supervisor = supervisor.clone();
    let maintenance_supervisor = supervisor.clone();
    run(
        listener,
        move |mut stream| {
            authenticate(&mut stream)?;
            control::serve(stream, dispatch_supervisor.clone())
        },
        move || {
            maintenance_supervisor
                .lock()
                .map_err(|_| io::Error::other("supervisor poisoned"))?
                .maintain(Instant::now())
        },
        move || {
            supervisor
                .lock()
                .map_err(|_| io::Error::other("supervisor poisoned"))?
                .shutdown()
        },
        stop,
    )
}

fn run(
    listener: TcpListener,
    dispatch: impl Fn(TcpStream) -> io::Result<()> + Send + Sync + 'static,
    mut maintain: impl FnMut() -> io::Result<()>,
    cleanup: impl FnOnce() -> io::Result<()>,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    listener.set_nonblocking(true)?;
    let dispatch = Arc::new(dispatch);
    let mut workers: Vec<Worker> = Vec::new();
    let result = (|| {
        let mut next_maintenance = Instant::now();
        while !stop.load(Ordering::Acquire) {
            let mut index = 0;
            while index < workers.len() {
                if workers[index].1.is_finished() {
                    let (_, worker) = workers.swap_remove(index);
                    worker
                        .join()
                        .map_err(|_| io::Error::other("relay worker panicked"))?;
                } else {
                    index += 1;
                }
            }
            let now = Instant::now();
            if now >= next_maintenance {
                maintain()?;
                next_maintenance = now + Duration::from_millis(100);
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    if workers.len() >= 128 {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    // The deadline owns unauthenticated connections too.
                    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
                    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
                    let owned = stream.try_clone()?;
                    let dispatch = dispatch.clone();
                    workers.push((
                        owned,
                        thread::spawn(move || {
                            // Invalid peers are isolated; maintenance errors stop admission.
                            let _ = dispatch(stream);
                        }),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })();
    // Stop accepting first, terminate every owned transport, then drain all
    // session cgroups even on timer/listener failure. Never lose a drain error.
    drop(listener);
    for (stream, _) in &workers {
        let _ = stream.shutdown(Shutdown::Both);
    }
    let drained = cleanup();
    for (_, worker) in workers {
        let _ = worker.join();
    }
    drained?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn idle_listener_maintains_grace_and_shutdown_owns_stalled_peers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let ticks = Arc::new(AtomicUsize::new(0));
        let cleaned = Arc::new(AtomicBool::new(false));
        let tick_count = ticks.clone();
        let cleanup_done = cleaned.clone();
        let worker_stop = stop.clone();
        let server = thread::spawn(move || {
            run(
                listener,
                |mut stream| {
                    // Literal unprivileged transport fixture, not root validation.
                    stream.write_all(b"ready")?;
                    let mut byte = [0];
                    stream.read_exact(&mut byte)
                },
                move || {
                    tick_count.fetch_add(1, Ordering::Release);
                    Ok(())
                },
                move || {
                    cleanup_done.store(true, Ordering::Release);
                    Ok(())
                },
                worker_stop,
            )
        });
        let mut peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut ready = [0; 5];
        peer.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        let deadline = Instant::now() + Duration::from_secs(2);
        while ticks.load(Ordering::Acquire) < 2 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        stop.store(true, Ordering::Release);
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        server.join().unwrap().unwrap();
        assert!(cleaned.load(Ordering::Acquire));
    }

    #[test]
    fn failed_maintenance_stops_admission_and_preserves_drain_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        // Hold a connection to this exact listener. A new connect after close
        // can hit another parallel test that reused the ephemeral port.
        let mut peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let error = run(
            listener,
            |_| panic!("admitted after maintenance failure"),
            || Err(io::Error::other("timer failure")),
            || Err(io::Error::other("drain failure")),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "drain failure");
        match peer.read(&mut [0]) {
            Ok(0) => (),
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => (),
            result => panic!("failed listener retained its queued connection: {result:?}"),
        }
    }
}
