//! One OS thread drains mutations in enqueue order. Dropping a receipt does not
//! cancel an already admitted mutation; shutdown drains admitted jobs.
use crate::hooks::Hooks;
use std::sync::mpsc::{self, Sender};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, PoisonError,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
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
    running: Arc<Running>,
}
/// One executor job that held the queue past the watchdog bound. Every host
/// frame, local client and session stream waits behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stall {
    pub job: &'static str,
    /// How long the job has held the executor, sampled by the watchdog.
    pub held: Duration,
    /// Jobs admitted behind it and not yet started.
    pub waiting: u64,
    /// The executor thread's kernel id (0 where unavailable), for /proc/<pid>/task.
    pub thread: u32,
    /// False while the job still holds the executor; true once it returned.
    pub released: bool,
}
/// The stall watchdog: report a job that holds the executor for `bound`, then
/// every `repeat` while it still holds it, and once more when it returns.
#[derive(Clone)]
pub struct Watchdog {
    pub bound: Duration,
    pub repeat: Duration,
    pub report: Arc<dyn Fn(&Stall) + Send + Sync>,
}
impl Default for Watchdog {
    /// The daemon's link budget for a roster push is 3 s; name the job first.
    fn default() -> Self {
        Self {
            bound: Duration::from_secs(2),
            repeat: Duration::from_secs(10),
            report: Arc::new(report_stall),
        }
    }
}
/// Daemon stderr has no sink in the installed guest, so stalls also land in
/// the daemon's private state directory, readable as root.
fn report_stall(stall: &Stall) {
    let record = serde_json::json!({
        "event": if stall.released { "executor_stall_released" } else { "executor_stall" },
        "job": stall.job,
        "held_ms": stall.held.as_millis() as u64,
        "waiting": stall.waiting,
        "thread": stall.thread,
    })
    .to_string();
    eprintln!("{record}");
    let _ = crate::freeze::append_hold(
        std::path::Path::new("/var/lib/smithers-machined/executor-stalls.jsonl"),
        &record,
    );
}
/// The job holding the executor, readable while it runs. The watchdog copies
/// it out and reports without holding this mutex.
#[derive(Default)]
struct Running {
    job: Mutex<Option<(u64, &'static str, Instant)>>,
    admitted: AtomicU64,
    started: AtomicU64,
    thread: std::sync::atomic::AtomicU32,
    stopped: AtomicBool,
}
impl Running {
    fn current(&self) -> Option<(u64, &'static str, Instant)> {
        *self.job.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn set(&self, job: Option<(u64, &'static str, Instant)>) {
        *self.job.lock().unwrap_or_else(PoisonError::into_inner) = job;
    }
    fn waiting(&self) -> u64 {
        self.admitted
            .load(Ordering::Acquire)
            .saturating_sub(self.started.load(Ordering::Acquire))
    }
}
fn watch(running: Arc<Running>, watchdog: Watchdog) {
    let poll = (watchdog.bound / 4).clamp(Duration::from_millis(1), Duration::from_millis(250));
    // (job id, name, start, last report)
    let mut reported: Option<(u64, &'static str, Instant, Instant)> = None;
    while !running.stopped.load(Ordering::Acquire) {
        thread::sleep(poll);
        let current = running.current();
        let thread = running.thread.load(Ordering::Acquire);
        if let Some((id, job, start, _)) = reported {
            if current.map(|(current, ..)| current) != Some(id) {
                (watchdog.report)(&Stall {
                    job,
                    held: start.elapsed(),
                    waiting: running.waiting(),
                    thread,
                    released: true,
                });
                reported = None;
            }
        }
        let Some((id, job, start)) = current else {
            continue;
        };
        let now = Instant::now();
        let held = now.saturating_duration_since(start);
        let due = match reported {
            Some((_, _, _, last)) => now.saturating_duration_since(last) >= watchdog.repeat,
            None => held >= watchdog.bound,
        };
        if due {
            (watchdog.report)(&Stall {
                job,
                held,
                waiting: running.waiting(),
                thread,
                released: false,
            });
            reported = Some((id, job, start, now));
        }
    }
}
pub struct Executor {
    pub lock: Lock,
    worker: Option<JoinHandle<()>>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum LockError {
    Stopped,
    Panicked,
    /// A job waited on its own executor. Its job could never start, so the
    /// wait is refused instead of parking every host frame and local client.
    Reentrant,
}
thread_local! {
    /// The executor (its `Running` address) whose job this thread runs.
    static EXECUTING: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn executor_id(running: &Arc<Running>) -> usize {
    Arc::as_ptr(running) as usize
}
/// Refuse a wait for `job` from inside a job of the same executor.
fn refuse_reentrant(
    running: &Arc<Running>,
    job: &'static str,
) -> std::result::Result<(), LockError> {
    if EXECUTING.with(|executing| executing.get()) != executor_id(running) {
        return Ok(());
    }
    let within = running.current().map_or("", |(_, name, _)| name);
    let record = serde_json::json!({"event": "executor_reentrant", "job": job, "within": within})
        .to_string();
    eprintln!("{record}");
    let _ = crate::freeze::append_hold(
        std::path::Path::new("/var/lib/smithers-machined/executor-stalls.jsonl"),
        &record,
    );
    Err(LockError::Reentrant)
}
pub struct Receipt<T> {
    receiver: oneshot::Receiver<std::result::Result<T, LockError>>,
    running: Arc<Running>,
    job: &'static str,
}
impl<T> Receipt<T> {
    pub fn wait(self) -> std::result::Result<T, LockError> {
        refuse_reentrant(&self.running, self.job)?;
        self.receiver
            .blocking_recv()
            .map_err(|_| LockError::Stopped)?
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
    fn start_context(cx: LockCx) -> std::io::Result<Self> {
        Self::start_watched(cx, Watchdog::default())
    }
    /// Start with an explicit stall watchdog. Production uses the default.
    pub fn start_with_watchdog(hooks: Hooks, watchdog: Watchdog) -> std::io::Result<Self> {
        Self::start_watched(LockCx::new(hooks), watchdog)
    }
    fn start_watched(mut cx: LockCx, watchdog: Watchdog) -> std::io::Result<Self> {
        let epoch = cx.epoch.clone();
        let running = Arc::new(Running::default());
        let executing = running.clone();
        let (tx, rx) = mpsc::channel::<(&'static str, bool, Job)>();
        let tx = Arc::new(tx);
        // Scheduling must use the same queue as callers. A weak producer lets
        // shutdown disconnect and drain without a timer retaining its own queue.
        let background = Arc::downgrade(&tx);
        let worker = thread::Builder::new()
            .name("machined-lock".into())
            .spawn(move || {
                #[cfg(any(target_os = "linux", target_os = "android"))]
                executing.thread.store(
                    rustix::thread::gettid().as_raw_nonzero().get() as u32,
                    Ordering::Release,
                );
                EXECUTING.with(|current| current.set(executor_id(&executing)));
                let mut next = 0u64;
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
                            executing.admitted.fetch_add(1, Ordering::AcqRel);
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
                    executing.started.fetch_add(1, Ordering::AcqRel);
                    next += 1;
                    executing.set(Some((next, name, Instant::now())));
                    let start = cx.hooks.clock.mono();
                    job(&mut cx);
                    executing.set(None);
                    if counted {
                        cx.completed += 1;
                        let end = cx.hooks.clock.mono();
                        cx.last_hold = Some((name, end.saturating_duration_since(start)));
                        if matches!(name, "rebase" | "return_to_item") {
                            crate::freeze::record_hold(name, start, end);
                        }
                    }
                }
                executing.stopped.store(true, Ordering::Release);
            })?;
        let watched = running.clone();
        if let Err(error) = thread::Builder::new()
            .name("machined-watchdog".into())
            .spawn(move || watch(watched, watchdog))
        {
            drop(tx);
            let _ = worker.join();
            return Err(error);
        }
        Ok(Self {
            lock: Lock { tx, epoch, running },
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
        self.running.admitted.fetch_add(1, Ordering::AcqRel);
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
            .map_err(|_| {
                self.running.admitted.fetch_sub(1, Ordering::AcqRel);
                LockError::Stopped
            })?;
        Ok(Receipt {
            receiver: rx,
            running: self.running.clone(),
            job: name,
        })
    }
    /// Never call this from inside a job: the job would wait for its own
    /// queue. Such a call is refused with `LockError::Reentrant` before the
    /// job is admitted.
    pub fn run_blocking<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<T, LockError> {
        refuse_reentrant(&self.running, name)?;
        self.enqueue(name, f)?.wait()
    }
}

impl Lock {
    pub async fn run<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> std::result::Result<T, LockError> {
        refuse_reentrant(&self.running, name)?;
        self.enqueue(name, f)?
            .receiver
            .await
            .map_err(|_| LockError::Stopped)?
    }
}

#[cfg(test)]
mod watchdog_tests {
    use super::*;
    fn watched(bound: Duration, repeat: Duration) -> (Executor, mpsc::Receiver<Stall>) {
        let (sink, stalls) = mpsc::channel();
        let sink = Mutex::new(sink);
        let executor = Executor::start_with_watchdog(
            Hooks::default(),
            Watchdog {
                bound,
                repeat,
                report: Arc::new(move |stall| {
                    let _ = sink.lock().unwrap().send(stall.clone());
                }),
            },
        )
        .unwrap();
        (executor, stalls)
    }
    #[test]
    fn a_job_that_blocks_the_executor_is_named_while_it_holds_and_when_it_returns() {
        let (executor, stalls) = watched(Duration::from_millis(100), Duration::from_millis(300));
        let (release, blocked) = mpsc::channel::<()>();
        let held = executor
            .lock
            .enqueue("blocked_job", move |_| blocked.recv().is_ok())
            .unwrap();
        // Two host frames queue behind it, as a roster push and its retry would.
        let behind = [
            executor.lock.enqueue("host_rpc", |_| ()).unwrap(),
            executor.lock.enqueue("host_rpc", |_| ()).unwrap(),
        ];
        let first = stalls.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first.job, "blocked_job");
        assert!(!first.released);
        assert!(first.held >= Duration::from_millis(100), "{first:?}");
        assert!(first.waiting >= 2, "{first:?}");
        #[cfg(target_os = "linux")]
        assert_ne!(first.thread, 0);
        // It repeats while the job still holds the executor.
        let again = stalls.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!((again.job, again.released), ("blocked_job", false));
        assert!(
            again.held >= first.held + Duration::from_millis(250),
            "{again:?}"
        );
        release.send(()).unwrap();
        assert_eq!(held.wait(), Ok(true));
        for receipt in behind {
            assert_eq!(receipt.wait(), Ok(()));
        }
        let released = stalls.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!((released.job, released.released), ("blocked_job", true));
        assert!(released.held >= again.held, "{released:?}");
        executor.shutdown().unwrap();
        // Nothing else is reported: the maintenance tick and the queued frames
        // returned within the bound.
        assert!(stalls.recv_timeout(Duration::from_millis(300)).is_err());
    }
    #[test]
    fn a_job_that_waits_on_its_own_executor_is_refused_and_the_executor_keeps_serving() {
        let (executor, stalls) = watched(Duration::from_millis(100), Duration::from_secs(10));
        let inner = executor.lock.clone();
        let (refused, waited, awaited, took) = executor
            .lock
            .run_blocking("outer", move |_| {
                let started = Instant::now();
                let refused = inner.run_blocking("inner", |_| ());
                let waited = inner.enqueue("queued", |_| 7).unwrap().wait();
                let awaited = pollster::block_on(inner.run("awaited", |_| ()));
                (refused, waited, awaited, started.elapsed())
            })
            .unwrap();
        assert_eq!(refused, Err(LockError::Reentrant));
        assert_eq!(waited, Err(LockError::Reentrant));
        assert_eq!(awaited, Err(LockError::Reentrant));
        assert!(took < Duration::from_millis(100), "{took:?}");
        assert_eq!(executor.lock.run_blocking("after", |_| 1), Ok(1));
        // A job of one executor may still wait on another executor.
        let other = Executor::start(Hooks::default()).unwrap();
        let lock = executor.lock.clone();
        assert_eq!(
            other
                .lock
                .run_blocking("other", move |_| lock.run_blocking("cross", |_| 3)),
            Ok(Ok(3))
        );
        other.shutdown().unwrap();
        executor.shutdown().unwrap();
        assert!(stalls.try_recv().is_err());
    }
    #[test]
    fn jobs_within_the_bound_are_never_reported() {
        let (executor, stalls) = watched(Duration::from_millis(200), Duration::from_millis(200));
        for _ in 0..20 {
            executor
                .lock
                .run_blocking("quick", |_| thread::sleep(Duration::from_millis(5)))
                .unwrap();
        }
        thread::sleep(Duration::from_millis(400));
        executor.shutdown().unwrap();
        assert!(stalls.try_recv().is_err());
    }
}
