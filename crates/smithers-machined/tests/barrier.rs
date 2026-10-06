use smithers_machined::{
    broker::control::{self, Controls, SocketpairBroker},
    freeze::{self, LocalCapture, Producers},
    hooks::{Broker, Error, Hooks, Result},
    lock::{Executor, LockCx, LockError},
};
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Clone)]
struct State {
    log: Arc<Mutex<Vec<&'static str>>>,
    failure: Option<&'static str>,
}
impl State {
    fn step(&self, name: &'static str) -> io::Result<()> {
        self.log.lock().unwrap().push(name);
        if self.failure == Some(name) {
            Err(io::ErrorKind::TimedOut.into())
        } else {
            Ok(())
        }
    }
}
impl Controls for State {
    fn freeze(&mut self, timeout: Duration) -> io::Result<Option<u32>> {
        assert!(timeout <= Duration::from_secs(1));
        self.step("freeze")?;
        Ok(None)
    }
    fn thaw(&mut self) -> io::Result<()> {
        self.step("thaw")
    }
    fn kill(&mut self) -> io::Result<u16> {
        self.step("kill")?;
        Ok(2)
    }
}
impl LocalCapture for State {
    fn capture_local(&self, _: &mut LockCx) -> Result<()> {
        self.step("pin-and-queue").map_err(|_| Error {
            code: 12,
            ..Error::unsupported()
        })
    }
}
fn pair(
    state: State,
) -> (
    Arc<SocketpairBroker>,
    std::thread::JoinHandle<io::Result<()>>,
) {
    let (client, mut server) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || control::serve(&mut server, &mut state.clone()));
    (Arc::new(SocketpairBroker::new(client).unwrap()), worker)
}
#[test]
fn production_socketpair_freeze_local_capture_rewrite_thaw_then_fifo() {
    let state = State {
        log: Arc::default(),
        failure: None,
    };
    let (broker, worker) = pair(state.clone());
    let executor = Executor::start(Hooks {
        broker: broker.clone(),
        ..Hooks::default()
    })
    .unwrap();
    let capture = state.clone();
    let receipt = executor
        .lock
        .enqueue("rewrite", move |cx| {
            freeze::rewrite(cx, Producers::default(), &capture, |_| {
                capture.step("rewrite").unwrap();
                Ok(7)
            })
        })
        .unwrap();
    let later = state.clone();
    let queued = executor
        .lock
        .enqueue("write", move |_| later.step("queued-write"))
        .unwrap();
    assert_eq!(receipt.wait().unwrap(), Ok(7));
    queued.wait().unwrap().unwrap();
    assert_eq!(
        *state.log.lock().unwrap(),
        ["freeze", "pin-and-queue", "rewrite", "thaw", "queued-write"]
    );
    executor.shutdown().unwrap();
    assert_eq!(broker.kill_sessions(None), Ok(2));
    assert_eq!(broker.kill_sessions(Some(&[1])), Err(Error::unsupported()));
    drop(broker);
    worker.join().unwrap().unwrap();
    assert_eq!(state.log.lock().unwrap().last(), Some(&"thaw"));
}
#[test]
fn timeout_hook_failure_and_panic_always_thaw_and_fifo_continues() {
    for failure in [Some("freeze"), Some("pin-and-queue"), None] {
        let state = State {
            log: Arc::default(),
            failure,
        };
        let (broker, worker) = pair(state.clone());
        let executor = Executor::start(Hooks {
            broker: broker.clone(),
            ..Hooks::default()
        })
        .unwrap();
        let capture = state.clone();
        let r = executor.lock.run_blocking("rewrite", move |cx| {
            freeze::rewrite::<()>(cx, Producers::default(), &capture, |_| {
                panic!("rewrite crash")
            })
        });
        match failure {
            None => assert_eq!(r, Err(LockError::Panicked)),
            Some("freeze") => assert_eq!(r.unwrap().unwrap_err().code, 9),
            _ => assert_eq!(r.unwrap().unwrap_err().code, 12),
        }
        assert_eq!(state.log.lock().unwrap().last(), Some(&"thaw"));
        assert_eq!(
            executor.lock.run_blocking("later", |cx| cx.completed),
            Ok(1)
        );
        executor.shutdown().unwrap();
        drop(broker);
        worker.join().unwrap().unwrap();
    }
}
#[test]
fn enabled_producer_with_missing_hook_refuses_before_capture_and_thaws() {
    for producers in [
        Producers {
            documents: true,
            bursts: false,
        },
        Producers {
            documents: false,
            bursts: true,
        },
    ] {
        let state = State {
            log: Arc::default(),
            failure: None,
        };
        let (broker, worker) = pair(state.clone());
        let executor = Executor::start(Hooks {
            broker: broker.clone(),
            ..Hooks::default()
        })
        .unwrap();
        let capture = state.clone();
        assert_eq!(
            executor
                .lock
                .run_blocking("rewrite", move |cx| freeze::rewrite(
                    cx,
                    producers,
                    &capture,
                    |_| Ok(())
                ))
                .unwrap(),
            Err(Error::unsupported())
        );
        assert_eq!(*state.log.lock().unwrap(), ["freeze", "thaw"]);
        executor.shutdown().unwrap();
        drop(broker);
        worker.join().unwrap().unwrap();
    }
}
#[test]
fn malformed_root_requests_have_no_privileged_side_effect() {
    let state = State {
        log: Arc::default(),
        failure: None,
    };
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let clone = state.clone();
    let worker = std::thread::spawn(move || control::serve(&mut server, &mut clone.clone()));
    for command in [
        [1, 0, 0, 0, 0],
        [1, 0, 0, 3, 233],
        [2, 0, 0, 0, 1],
        [3, 0, 0, 0, 1],
        [255, 0, 0, 0, 0],
    ] {
        client.write_all(&command).unwrap();
        let mut response = [0; 5];
        client.read_exact(&mut response).unwrap();
        assert_eq!(response, [1, 0, 0, 0, 0]);
        assert!(state.log.lock().unwrap().is_empty());
    }
    // Truncated input must close, never become a root operation.
    client.write_all(&[1, 0]).unwrap();
    drop(client);
    worker.join().unwrap().unwrap();
    assert_eq!(*state.log.lock().unwrap(), ["thaw"]);
}
