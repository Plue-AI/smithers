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
    cx.cadence.captured(cx.hooks.clock.mono());
    Ok(Captured {
        head,
        tree,
        flushed,
    })
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
