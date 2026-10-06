//! One OS thread drains mutations in enqueue order. Dropping a receipt does not
//! cancel an already admitted mutation; shutdown drains admitted jobs.
use crate::hooks::Hooks;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::oneshot;
pub struct LockCx {
    pub hooks: Hooks,
    pub completed: u64,
    pub rewrite_pending: bool,
    pub last_hold: Option<(&'static str, Duration)>,
}
impl LockCx {
    pub fn new(hooks: Hooks) -> Self {
        Self {
            hooks,
            completed: 0,
            rewrite_pending: false,
            last_hold: None,
        }
    }
}
type Job = Box<dyn FnOnce(&mut LockCx) + Send>;
#[derive(Clone)]
pub struct Lock {
    tx: Sender<(&'static str, Job)>,
}
pub struct Executor {
    pub lock: Lock,
    worker: Option<JoinHandle<()>>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    Stopped,
    Panicked,
}
pub struct Receipt<T>(oneshot::Receiver<std::result::Result<T, LockError>>);
impl<T> Receipt<T> {
    pub fn wait(self) -> std::result::Result<T, LockError> {
        self.0.blocking_recv().map_err(|_| LockError::Stopped)?
    }
}
impl Executor {
    pub fn start(hooks: Hooks) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<(&'static str, Job)>();
        let worker = thread::Builder::new()
            .name("machined-lock".into())
            .spawn(move || {
                let mut cx = LockCx::new(hooks);
                while let Ok((name, job)) = rx.recv() {
                    let start = cx.hooks.clock.mono();
                    job(&mut cx);
                    cx.completed += 1;
                    cx.last_hold =
                        Some((name, cx.hooks.clock.mono().saturating_duration_since(start)));
                }
            })?;
        Ok(Self {
            lock: Lock { tx },
            worker: Some(worker),
        })
    }
    pub fn shutdown(mut self) -> thread::Result<()> {
        drop(self.lock);
        self.worker.take().unwrap().join()
    }
}
impl Lock {
    pub fn enqueue<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<Receipt<T>, LockError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send((
                name,
                Box::new(move |cx| {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(cx)))
                        .map_err(|_| LockError::Panicked);
                    let _ = tx.send(result);
                }),
            ))
            .map_err(|_| LockError::Stopped)?;
        Ok(Receipt(rx))
    }
    pub fn run_blocking<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<T, LockError> {
        self.enqueue(name, f)?.wait()
    }
}

impl Lock {
    pub async fn run<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<T, LockError> {
        self.enqueue(name, f)?
            .0
            .await
            .map_err(|_| LockError::Stopped)?
    }
}
