//! Rewrites thaw only after the tree and documents settle or restore succeeds.
use crate::hooks::{Actor, Error, Result};
use crate::lock::LockCx;
use std::time::Duration;

pub fn pending_error() -> Error {
    Error {
        code: 12,
        detail: Some("rewrite requires restore".into()),
        ..Error::unsupported()
    }
}

/// Recovery is a mutation-lock job. Failure retains the frozen barrier.
pub fn restore(cx: &mut LockCx, actor: &Actor) -> Result<()> {
    if !cx.rewrite_pending {
        return Ok(());
    }
    let hooks = cx.hooks.clone();
    hooks.core.restore_rewrite(cx)?;
    hooks.documents.reconcile_all(cx, actor)?;
    hooks.broker.thaw()?;
    cx.rewrite_pending = false;
    Ok(())
}

pub fn freeze_then<T>(
    cx: &mut LockCx,
    actor: &Actor,
    rewrite: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    if cx.rewrite_pending {
        return Err(pending_error());
    }
    let hooks = cx.hooks.clone();
    // Even a partial freeze must be unwound if no rewrite has begun.
    let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(session) = hooks.broker.freeze(Duration::from_secs(1))? {
            return Err(Error {
                code: 9,
                session: Some(session),
                ..Error::unsupported()
            });
        }
        hooks.documents.flush_all(cx)?;
        hooks.watcher.drain(cx)?;
        hooks.watcher.close_bursts(cx)?;
        hooks.core.capture_local(cx)
    }));
    match prepared {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            hooks.broker.thaw()?;
            return Err(error);
        }
        Err(panic) => {
            let _ = hooks.broker.thaw();
            std::panic::resume_unwind(panic);
        }
    }
    // Set before calling native code: the executor catches panics, but must
    // never admit another mutation or thaw a possibly half-applied tree.
    cx.rewrite_pending = true;
    let output = match rewrite(cx) {
        Ok(output) => output,
        Err(error) => {
            let _ = restore(cx, actor);
            return Err(error);
        }
    };
    hooks.documents.reconcile_all(cx, actor)?;
    hooks.broker.thaw()?;
    cx.rewrite_pending = false;
    Ok(output)
}
