//! The §9.4.2 rewrite barrier, called on the shared mutation lock thread.
//! The broker receives only a fixed deadline, never repository input.
use crate::hooks::{Actor, Broker, Error, Result};
use crate::lock::LockCx;
use std::sync::Arc;
use std::time::Duration;

struct Thaw {
    broker: Arc<dyn Broker>,
    armed: bool,
}
impl Thaw {
    fn finish(&mut self) -> Result<()> {
        self.broker.thaw()?;
        self.armed = false;
        Ok(())
    }
}
impl Drop for Thaw {
    fn drop(&mut self) {
        if self.armed {
            // The lock executor catches a panicking provider. Thaw before that
            // catch allows the next queued mutation to run.
            let _ = self.broker.thaw();
        }
    }
}

pub fn freeze_then<T>(
    cx: &mut LockCx,
    actor: &Actor,
    rewrite: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    let hooks = cx.hooks.clone();
    let mut thaw = Thaw {
        broker: hooks.broker.clone(),
        armed: true,
    };
    let result = (|| {
        if let Some(session) = hooks.broker.freeze(Duration::from_secs(1))? {
            return Err(Error {
                code: 9,
                session: Some(session),
                ..Error::unsupported()
            });
        }
        hooks.watcher.drain(cx)?;
        hooks.watcher.close_bursts(cx)?;
        hooks.core.capture_local(cx)?;
        let output = rewrite(cx)?;
        hooks.documents.reconcile_all(cx, actor)?;
        Ok(output)
    })();
    // A successful rewrite with failed thaw is not a successful operation.
    let thawed = thaw.finish();
    result.and_then(|output| thawed.map(|()| output))
}
