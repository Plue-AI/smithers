//! One OS thread drains mutations in enqueue order. Dropping a receipt does not
//! cancel an already admitted mutation; shutdown drains admitted jobs.
use crate::hooks::Hooks;
use std::sync::mpsc::{self, Sender};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::oneshot;
pub struct LockCx {
    pub hooks: Hooks,
    pub completed: u64,
    pub maintenance_ready: bool,
    pub cadence: crate::capture::Cadence,
    burst_generation: u64,
    last_maintenance: std::time::Instant,
    pub rewrite_pending: bool,
    pub epoch: Arc<AtomicU64>,
    pub last_rewrite_was_return: bool,
    pub return_epoch: u64,
    journal: Option<crate::rewrite_journal::Journal>,
    pub last_hold: Option<(&'static str, Duration)>,
}
impl LockCx {
    pub fn new(hooks: Hooks) -> Self {
        let now = hooks.clock.mono();
        Self {
            cadence: crate::capture::Cadence::new(now),
            maintenance_ready: false,
            burst_generation: 0,
            last_maintenance: now,
            hooks,
            completed: 0,
            rewrite_pending: false,
            epoch: Arc::new(AtomicU64::new(0)),
            last_rewrite_was_return: false,
            return_epoch: 0,
            journal: None,
            last_hold: None,
        }
    }
    /// Runs even with a busy RPC queue and after a host disconnect. Only a
    /// completed wake authorizes snapshots; failed captures remain due.
    fn tick(&mut self) {
        let hooks = self.hooks.clone();
        let _ = hooks.documents.tick(self);
        if !self.maintenance_ready || self.rewrite_pending {
            return;
        }
        if hooks.watcher.drain(self).is_err() {
            return;
        }
        // Qualification requests an ordinary local capture while the host
        // transport is absent. It closes real watcher bursts and pins/queues
        // their real objects; it never fabricates a burst or an ACK.
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::qualification_capture(|| hooks.core.capture_local(self));
        let generation = hooks.events.burst_generation();
        if generation != self.burst_generation {
            self.cadence.burst_closed();
            self.burst_generation = generation;
        }
        let now = hooks.clock.mono();
        if self.cadence.due(now) && hooks.core.call(self, 4, &[]).is_ok() {
            self.cadence.captured(now);
            self.burst_generation = hooks.events.burst_generation();
        }
        if now.saturating_duration_since(self.last_maintenance) >= Duration::from_secs(60) {
            // Retry failed cleanup on the next minute, without starving controls.
            self.last_maintenance = now;
            let _ = hooks.core.maintain(self);
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
        self.begin_rewrite_for(false)
    }
    pub(crate) fn begin_rewrite_for(&mut self, returning: bool) -> crate::hooks::Result<()> {
        // Set first: an IO failure can have persisted the marker, so both this
        // process and its successor must refuse mutations until restore.
        self.rewrite_pending = true;
        self.last_rewrite_was_return = returning;
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        if self.last_rewrite_was_return {
            self.return_epoch = epoch;
        }
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
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        if self.last_rewrite_was_return {
            self.return_epoch = epoch;
        }
        Ok(())
    }
}
type Job = Box<dyn FnOnce(&mut LockCx) + Send>;
#[derive(Clone)]
pub struct Lock {
    tx: Arc<Sender<(&'static str, bool, Job)>>,
    epoch: Arc<AtomicU64>,
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
        let epoch = cx.epoch.clone();
        let (tx, rx) = mpsc::channel::<(&'static str, bool, Job)>();
        let tx = Arc::new(tx);
        // Scheduling must use the same queue as callers. A weak producer lets
        // shutdown disconnect and drain without a timer retaining its own queue.
        let background = Arc::downgrade(&tx);
        let worker = thread::Builder::new()
            .name("machined-lock".into())
            .spawn(move || {
                let mut last_tick = cx.hooks.clock.mono();
                let tick_pending = Arc::new(AtomicBool::new(false));
                loop {
                    let now = cx.hooks.clock.mono();
                    if now.saturating_duration_since(last_tick) >= Duration::from_millis(25)
                        && !tick_pending.load(Ordering::Acquire)
                    {
                        if let Some(producer) = background.upgrade() {
                            let pending = tick_pending.clone();
                            pending.store(true, Ordering::Release);
                            let _ = producer.send((
                                "maintenance",
                                false,
                                Box::new(move |cx| {
                                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                                        || cx.tick(),
                                    ));
                                    pending.store(false, Ordering::Release);
                                }),
                            ));
                        }
                        last_tick = now;
                    }
                    let (name, counted, job) = match rx.recv_timeout(Duration::from_millis(25)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            continue;
                        }
                    };
                    let start = cx.hooks.clock.mono();
                    job(&mut cx);
                    if counted {
                        cx.completed += 1;
                        let end = cx.hooks.clock.mono();
                        cx.last_hold = Some((name, end.saturating_duration_since(start)));
                        if matches!(name, "rebase" | "return_to_item") {
                            crate::freeze::record_hold(name, start, end);
                        }
                    }
                }
            })?;
        Ok(Self {
            lock: Lock { tx, epoch },
            worker: Some(worker),
        })
    }
    pub fn shutdown(mut self) -> thread::Result<()> {
        drop(self.lock);
        self.worker.take().unwrap().join()
    }
}
impl Lock {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    pub fn enqueue<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<Receipt<T>, LockError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send((
                name,
                true,
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
