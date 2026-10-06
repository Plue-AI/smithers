//! Capture's local phase runs under the mutation lock; delivery waits outside it.
use crate::{
    hooks::{Oid, Result},
    lock::LockCx,
    outbox,
};
use std::time::{Duration, Instant};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub head: Oid,
    pub tree: Oid,
    pub flushed: u16,
}
pub trait Repository {
    /// One native jj snapshot operation. Must persist before returning.
    fn snapshot(&mut self) -> Result<(Oid, Oid)>;
    fn base(&mut self) -> Result<Oid>;
    fn acknowledged(&mut self) -> Result<Option<Oid>>;
    fn queued(&mut self, head: Oid) -> Result<bool>;
}
pub fn local(cx: &mut LockCx, repository: &mut impl Repository) -> Result<Captured> {
    if cx.rewrite_pending {
        return Err(crate::freeze::pending_error());
    }
    let hooks = cx.hooks.clone();
    let flushed = hooks.documents.flush_all(cx)?;
    hooks.watcher.drain(cx)?;
    hooks.watcher.close_bursts(cx)?;
    let (head, tree) = repository.snapshot()?;
    #[cfg(all(feature = "killpoints", debug_assertions))]
    crate::events::killpoint("K5a");
    if repository.acknowledged()? != Some(head) && !repository.queued(head)? {
        let base = repository.base()?;
        hooks
            .events
            .append(&outbox::captured(head, tree, base), Some(head))?;
    }
    Ok(Captured {
        head,
        tree,
        flushed,
    })
}
/// Only the transport owner can certify drain. An empty local phase is not a
/// sleep receipt: previously queued bursts and captures must also be committed.
pub trait Delivery {
    fn wait_empty(&self) -> Result<()>;
}
/// The transport starts this on its request worker, never on the lock thread.
/// Local work is FIFO; waiting for host receipts does not block later mutations.
pub fn request(
    lock: &crate::lock::Lock,
    snapshot: impl FnOnce(&mut LockCx) -> Result<Captured> + Send + 'static,
    delivery: &impl Delivery,
) -> Result<Captured> {
    let captured = lock
        .run_blocking("capture", snapshot)
        .map_err(|_| crate::hooks::Error {
            code: 12,
            detail: Some("capture executor failed".into()),
            ..crate::hooks::Error::unsupported()
        })??;
    delivery.wait_empty()?;
    Ok(captured)
}
pub struct Cadence {
    last: Instant,
    dirty: bool,
}
impl Cadence {
    pub fn new(now: Instant) -> Self {
        Self {
            last: now,
            dirty: false,
        }
    }
    pub fn burst_closed(&mut self) {
        self.dirty = true;
    }
    pub fn due(&self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last);
        elapsed >= Duration::from_secs(300) || (self.dirty && elapsed >= Duration::from_secs(5))
    }
    /// Advance only after successful local capture; failed jobs remain due.
    pub fn captured(&mut self, now: Instant) {
        self.last = now;
        self.dirty = false;
    }
}
