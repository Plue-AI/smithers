//! Rewrite barrier on the sole FIFO executor. Capture here must only pin and
//! enqueue locally; delivery and host acknowledgement happen outside the lock.
use crate::{
    hooks::{Broker, Error, Result},
    lock::LockCx,
};
use std::{sync::Arc, time::Duration};

/// Explicit producer admission: unavailable hooks are allowed only when their
/// producers are disabled. A newly enabled producer must supply its hook.
#[derive(Clone, Copy, Default)]
pub struct Producers {
    pub documents: bool,
    pub bursts: bool,
}
pub trait LocalCapture {
    fn capture_local(&self, cx: &mut LockCx) -> Result<()>;
}
struct Thaw(Option<Arc<dyn Broker>>);
impl Drop for Thaw {
    fn drop(&mut self) {
        if let Some(broker) = &self.0 {
            let _ = broker.thaw();
        }
    }
}
pub fn rewrite<T>(
    cx: &mut LockCx,
    producers: Producers,
    capture: &dyn LocalCapture,
    operation: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    let hooks = cx.hooks.clone();
    // Install cleanup before freeze: timeout and failed/partial writes thaw too.
    let mut guard = Thaw(Some(hooks.broker.clone()));
    if let Some(session) = hooks.broker.freeze(Duration::from_secs(1))? {
        let mut error = Error::unsupported();
        error.code = 9;
        error.session = Some(session);
        return Err(error);
    }
    if producers.documents {
        hooks.documents.flush_all(cx)?;
    }
    if producers.bursts {
        hooks.watcher.drain(cx)?;
        hooks.watcher.close_bursts(cx)?;
        if hooks.watcher.burst_open() {
            let mut error = Error::unsupported();
            error.code = 9;
            return Err(error);
        }
    }
    if producers.documents && !hooks.documents.all_flushed() {
        let mut error = Error::unsupported();
        error.code = 9;
        return Err(error);
    }
    capture.capture_local(cx)?;
    let result = operation(cx);
    // Propagate a thaw failure even when the rewrite succeeded. Drop retries
    // thaw when this call fails, and also handles an unwind from any hook.
    hooks.broker.thaw()?;
    guard.0.take();
    result
}
