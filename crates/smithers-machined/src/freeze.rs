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
    hooks.watcher.settle_rewrite(cx)?;
    hooks.broker.thaw()?;
    cx.settle_rewrite()?;
    Ok(())
}

pub fn freeze_then<T>(
    cx: &mut LockCx,
    actor: &Actor,
    rewrite: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    freeze_for(cx, actor, false, rewrite)
}
pub fn freeze_return<T>(
    cx: &mut LockCx,
    actor: &Actor,
    rewrite: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    freeze_for(cx, actor, true, rewrite)
}
fn freeze_for<T>(
    cx: &mut LockCx,
    actor: &Actor,
    returning: bool,
    rewrite: impl FnOnce(&mut LockCx) -> Result<T>,
) -> Result<T> {
    if cx.rewrite_pending {
        return Err(pending_error());
    }
    let hooks = cx.hooks.clone();
    #[cfg(all(feature = "killpoints", debug_assertions))]
    crate::events::killpoint("freeze-start");
    // Even a partial freeze must be unwound if no rewrite has begun.
    let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let blocker = hooks.broker.freeze(Duration::from_secs(1))?;
        // Fault builds exercise the real timeout unwind, RPC and host retry
        // without substituting the daemon. This is not kernel-freeze evidence.
        #[cfg(all(feature = "killpoints", debug_assertions))]
        let blocker = blocker.or_else(qualification_timeout);
        if let Some(session) = blocker {
            return Err(Error {
                code: 9,
                session: Some(session),
                ..Error::unsupported()
            });
        }
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::killpoint("frozen");
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
    cx.begin_rewrite_for(returning)?;
    let output = match rewrite(cx) {
        Ok(output) => output,
        Err(error) => {
            let _ = restore(cx, actor);
            return Err(error);
        }
    };
    hooks.documents.reconcile_all(cx, actor)?;
    if returning {
        hooks.core.returned_by(actor)?;
    }
    hooks.watcher.settle_rewrite(cx)?;
    hooks.broker.thaw()?;
    cx.settle_rewrite()?;
    Ok(output)
}

/// Inspect one retained conflict while every broker writer is frozen. This is
/// not a rewrite checkpoint; every outcome thaws the writers.
pub fn inspect_then<T>(cx: &mut LockCx, inspect: impl FnOnce(&mut LockCx) -> Result<T>) -> Result<T> {
    if cx.rewrite_pending { return Err(pending_error()); }
    let broker = cx.hooks.broker.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(session) = broker.freeze(Duration::from_secs(1))? {
            return Err(Error { code:9, session:Some(session), ..Error::unsupported() });
        }
        let documents = cx.hooks.documents.clone();
        documents.flush_all(cx)?;
        inspect(cx)
    }));
    let thawed = broker.thaw();
    match result {
        Ok(result) => { thawed?; result }
        Err(panic) => { let _ = thawed; std::panic::resume_unwind(panic) }
    }
}

// Consume the executor's existing job interval, never time the freeze twice.
// A bounded, nonblocking handoff keeps telemetry IO outside the mutation queue.
// Missing samples fail the qualification count instead of delaying a rewrite.
pub(crate) fn record_hold(operation: &'static str, start: std::time::Instant, end: std::time::Instant) {
    type Sample = (&'static str, std::time::Instant, std::time::Instant);
    static SENDER: std::sync::OnceLock<Option<std::sync::mpsc::SyncSender<Sample>>> = std::sync::OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, samples) = std::sync::mpsc::sync_channel::<Sample>(1024);
        std::thread::Builder::new().name("machined-holds".into()).spawn(move || {
            let mut origin = None;
            for (operation, start, end) in samples {
                let origin = *origin.get_or_insert(start);
                let record = serde_json::json!({
                    "event": "mutation_hold", "operation": operation,
                    "start_ns": start.saturating_duration_since(origin).as_nanos(),
                    "end_ns": end.saturating_duration_since(origin).as_nanos(),
                    "hold_ns": end.saturating_duration_since(start).as_nanos()
                });
                eprintln!("{record}");
                // The installed broker has no inherited stderr sink.
                let _ = append_hold(std::path::Path::new("/var/lib/smithers-machined/mutation-holds.jsonl"), &record.to_string());
            }
        }).ok().map(|_| sender)
    });
    if let Some(sender) = sender { let _ = sender.try_send((operation, start, end)); }
}

// This runs only as the daemon, in its private state directory. Opening a leaf
// must not follow links or block on a special file; refusals preserve its bytes.
pub(crate) fn append_hold(path: &std::path::Path, record: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new().append(true).create(true)
        .mode(0o600)
        // rustix has these on every platform; libc is a Linux-only dependency.
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)?;
    let info = file.metadata()?;
    let limit = 1 << 20;
    if !info.is_file() || info.uid() != rustix::process::geteuid().as_raw() || info.nlink() != 1
        || info.mode() & 0o077 != 0 || info.len() + record.len() as u64 + 1 > limit {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsafe or full hold log"));
    }
    writeln!(file, "{record}")
}

#[cfg(test)]
mod hold_tests {
    use super::append_hold;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn hold_receipts_append_and_refuse_unsafe_or_full_destinations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("holds");
        append_hold(&path, "first").unwrap();
        append_hold(&path, "second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first\nsecond\n");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let link = dir.path().join("alias");
        symlink(&path, &link).unwrap();
        assert!(append_hold(&link, "symlink must not write").is_err());
        std::fs::remove_file(&link).unwrap();
        std::fs::hard_link(&path, &link).unwrap();
        assert!(append_hold(&path, "hardlink must not write").is_err());
        std::fs::remove_file(&link).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(append_hold(&path, "shared must not write").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"first\nsecond\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, vec![b'x'; (1 << 20)-2]).unwrap();
        append_hold(&path, "x").unwrap();
        assert!(append_hold(&path, "overflow").is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 1 << 20);
        assert!(append_hold(dir.path(), "directory must not write").is_err());
    }
}

#[cfg(all(feature = "killpoints", debug_assertions))]
fn qualification_timeout() -> Option<u32> {
    let path = "/var/lib/smithers-machined/qualification-freeze-timeout.arm";
    let session = std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()?;
    if session == 0 {
        return None;
    }
    std::thread::sleep(Duration::from_secs(1));
    Some(session)
}
