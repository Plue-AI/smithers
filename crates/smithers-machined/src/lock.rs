//! Design §3: one OS thread drains mutation jobs in enqueue order.
use crate::{
    confine::Workspace,
    hooks::{Clock, EventSink, Hooks},
    jj::Vcs,
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
pub struct LockCx<'a> {
    pub ws: &'a Workspace,
    pub vcs: &'a Vcs,
    pub events: &'a dyn EventSink,
    pub hooks: &'a Hooks,
    pub clock: &'a dyn Clock,
}
pub struct Resources {
    pub ws: Workspace,
    pub vcs: Vcs,
    pub events: Arc<dyn EventSink>,
    pub hooks: Hooks,
    pub clock: Arc<dyn Clock>,
}
type Job = Box<dyn FnOnce(&mut LockCx<'_>) + Send>;
pub type HoldTimes = BTreeMap<&'static str, VecDeque<Duration>>;
#[derive(Clone)]
pub struct Lock {
    tx: mpsc::Sender<(&'static str, Job)>,
    holds: Arc<Mutex<HoldTimes>>,
}
impl Lock {
    pub fn start(resources: Resources) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::channel::<(&'static str, Job)>();
        let holds = Arc::new(Mutex::new(
            BTreeMap::<&'static str, VecDeque<Duration>>::new(),
        ));
        let times = holds.clone();
        std::thread::Builder::new()
            .name("machined-lock".into())
            .spawn(move || {
                let mut cx = LockCx {
                    ws: &resources.ws,
                    vcs: &resources.vcs,
                    events: resources.events.as_ref(),
                    hooks: &resources.hooks,
                    clock: resources.clock.as_ref(),
                };
                for (name, job) in rx {
                    let start = cx.clock.mono();
                    // A panicking caller does not kill the queue or strand later jobs.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut cx)));
                    let elapsed = cx.clock.mono().saturating_duration_since(start);
                    eprintln!("lock_hold{{name:{name}, ms:{}}}", elapsed.as_millis());
                    if let Ok(mut h) = times.lock() {
                        let q = h.entry(name).or_default();
                        if q.len() == 1000 {
                            q.pop_front();
                        }
                        q.push_back(elapsed);
                    }
                }
            })?;
        Ok(Self { tx, holds })
    }
    pub async fn run<T: Send + 'static>(
        &self,
        name: &'static str,
        f: impl FnOnce(&mut LockCx<'_>) -> T + Send + 'static,
    ) -> T {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send((
                name,
                Box::new(move |cx| {
                    let _ = tx.send(f(cx));
                }),
            ))
            .unwrap_or_else(|_| panic!("mutation lock worker stopped"));
        rx.await.expect("mutation lock job panicked")
    }
    pub fn hold_times(&self) -> HoldTimes {
        self.holds.lock().map(|h| h.clone()).unwrap_or_default()
    }
}
