use smithers_machined::{
    capture::{self, Captured, Repository},
    hooks::*,
    lock::LockCx,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Default)]
struct Fixture {
    calls: Mutex<Vec<&'static str>>,
    fail: Mutex<&'static str>,
}
impl Fixture {
    fn step(&self, name: &'static str) -> Result<()> {
        self.calls.lock().unwrap().push(name);
        if *self.fail.lock().unwrap() == name {
            Err(Error::unsupported())
        } else {
            Ok(())
        }
    }
}
impl Documents for Fixture {
    fn flush_all(&self, _: &mut LockCx) -> Result<u16> {
        self.step("flush")?;
        Ok(2)
    }
}
impl Watcher for Fixture {
    fn drain(&self, _: &mut LockCx) -> Result<()> {
        self.step("drain")
    }
    fn close_bursts(&self, _: &mut LockCx) -> Result<()> {
        self.step("close")
    }
}
impl EventSink for Fixture {
    fn append(&self, event: &[u8], pin: Option<Oid>) -> Result<(u64, [u8; 16])> {
        assert_eq!(event[0], 2);
        assert_eq!(pin, Some([1; 20]));
        self.step("append")?;
        Ok((1, [1; 16]))
    }
}
struct Repo {
    f: Arc<Fixture>,
    acked: bool,
    queued: bool,
}
impl Repository for Repo {
    fn snapshot(&mut self) -> Result<(Oid, Oid)> {
        self.f.step("snapshot")?;
        Ok(([1; 20], [2; 20]))
    }
    fn base(&mut self) -> Result<Oid> {
        Ok([3; 20])
    }
    fn acknowledged(&mut self) -> Result<Option<Oid>> {
        Ok(self.acked.then_some([1; 20]))
    }
    fn queued(&mut self, _: Oid) -> Result<bool> {
        Ok(self.queued)
    }
}
#[test]
fn ordered_local_capture_deduplicates_and_fails_closed() {
    for (acked, queued) in [(false, false), (true, false), (false, true)] {
        let f = Arc::new(Fixture::default());
        let mut repo = Repo {
            f: f.clone(),
            acked,
            queued,
        };
        let mut cx = LockCx::new(Hooks {
            documents: f.clone(),
            watcher: f.clone(),
            events: f.clone(),
            ..Hooks::default()
        });
        assert_eq!(
            capture::local(&mut cx, &mut repo).unwrap(),
            Captured {
                head: [1; 20],
                tree: [2; 20],
                flushed: 2
            }
        );
        let mut calls = vec!["flush", "drain", "close", "snapshot"];
        if !acked && !queued {
            calls.push("append");
        }
        assert_eq!(*f.calls.lock().unwrap(), calls);
    }
    for fail in ["flush", "drain", "close", "snapshot", "append"] {
        let f = Arc::new(Fixture::default());
        *f.fail.lock().unwrap() = fail;
        let mut repo = Repo {
            f: f.clone(),
            acked: false,
            queued: false,
        };
        let mut cx = LockCx::new(Hooks {
            documents: f.clone(),
            watcher: f.clone(),
            events: f.clone(),
            ..Hooks::default()
        });
        assert!(capture::local(&mut cx, &mut repo).is_err());
        assert_eq!(f.calls.lock().unwrap().last(), Some(&fail));
    }
}
#[test]
fn unavailable_hooks_refuse_without_snapshot() {
    let f = Arc::new(Fixture::default());
    let mut r = Repo {
        f: f.clone(),
        acked: false,
        queued: false,
    };
    assert!(capture::local(&mut LockCx::new(Hooks::default()), &mut r).is_err());
    assert!(f.calls.lock().unwrap().is_empty());
}
#[test]
fn cadence_boundaries_and_failed_attempt_remain_due() {
    let now = Instant::now();
    let mut c = capture::Cadence::new(now);
    assert!(!c.due(now + Duration::from_secs(299)));
    assert!(c.due(now + Duration::from_secs(300)));
    c.burst_closed();
    assert!(!c.due(now + Duration::from_millis(4999)));
    assert!(c.due(now + Duration::from_secs(5)));
    assert!(c.due(now + Duration::from_secs(6)));
    c.captured(now + Duration::from_secs(6));
    assert!(!c.due(now + Duration::from_secs(7)));
}

#[test]
fn capture_waits_for_receipt_without_holding_mutation_lock() {
    use std::sync::mpsc;
    struct Drain {
        waiting: mpsc::Sender<()>,
        receipt: Mutex<mpsc::Receiver<()>>,
    }
    impl capture::Delivery for Drain {
        fn wait_empty(&self) -> Result<()> {
            self.waiting.send(()).unwrap();
            self.receipt.lock().unwrap().recv().unwrap();
            Ok(())
        }
    }
    let executor = smithers_machined::lock::Executor::start(Hooks::default()).unwrap();
    let lock = executor.lock.clone();
    let (waiting, wait) = mpsc::channel();
    let (receipt, received) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let output = capture::request(
            &lock,
            |_| {
                Ok(Captured {
                    head: [1; 20],
                    tree: [2; 20],
                    flushed: 1,
                })
            },
            &Drain {
                waiting,
                receipt: Mutex::new(received),
            },
        );
        finished.send(output).unwrap();
    });
    wait.recv_timeout(Duration::from_secs(2)).unwrap();
    let writer = executor.lock.enqueue("next writer", |_| 71).unwrap();
    assert_eq!(writer.wait().unwrap(), 71);
    assert!(result.try_recv().is_err());
    receipt.send(()).unwrap();
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .head,
        [1; 20]
    );
    worker.join().unwrap();
    executor.shutdown().unwrap();
}
