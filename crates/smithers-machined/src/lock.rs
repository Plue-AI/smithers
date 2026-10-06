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
    journal: Option<crate::rewrite_journal::Journal>,
    pub last_hold: Option<(&'static str, Duration)>,
}
impl LockCx {
    pub fn new(hooks: Hooks) -> Self {
        Self {
            hooks,
            completed: 0,
            rewrite_pending: false,
            journal: None,
            last_hold: None,
        }
    }
    pub fn recovering(
        hooks: Hooks,
        journal: crate::rewrite_journal::Journal,
    ) -> std::io::Result<Self> {
        let mut cx = Self::new(hooks);
        cx.rewrite_pending = journal.pending()?;
        cx.journal = Some(journal);
        Ok(cx)
    }
    pub fn begin_rewrite(&mut self) -> crate::hooks::Result<()> {
        // Set first: an IO failure can have persisted the marker, so both this
        // process and its successor must refuse mutations until restore.
        self.rewrite_pending = true;
        if let Some(journal) = &self.journal {
            journal
                .begin()
                .map_err(|_| crate::freeze::pending_error())?;
        }
        Ok(())
    }
    pub fn settle_rewrite(&mut self) -> crate::hooks::Result<()> {
        if let Some(journal) = &self.journal {
            journal
                .settled()
                .map_err(|_| crate::freeze::pending_error())?;
        }
        self.rewrite_pending = false;
        Ok(())
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
        Self::start_context(LockCx::new(hooks))
    }
    pub fn start_persistent(hooks: Hooks, state: &std::path::Path) -> std::io::Result<Self> {
        Self::start_context(LockCx::recovering(
            hooks,
            crate::rewrite_journal::Journal::open(state)?,
        )?)
    }
    fn start_context(mut cx: LockCx) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<(&'static str, Job)>();
        let worker = thread::Builder::new()
            .name("machined-lock".into())
            .spawn(move || {
                let mut cx = LockCx::new(hooks);
                loop {
                    let (name, job) = match rx.recv_timeout(Duration::from_millis(25)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // A failed save stays dirty and retries; never emit a
                            // success receipt for a failed persistence attempt.
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                cx.hooks.documents.clone().tick(&mut cx)
                            }));
                            continue;
                        }
                    };
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
