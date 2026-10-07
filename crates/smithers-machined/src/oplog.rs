//! Daily operation retention; pending Git refs remain roots during GC.
use crate::hooks::Result;
use std::time::{Duration, SystemTime};
pub const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
pub const SIZE_LIMIT: u64 = 1024 * 1024 * 1024;
pub const KEEP_NEWEST: usize = 100;
pub struct Operation {
    pub id: String,
    pub ended: SystemTime,
}
pub trait Repository {
    fn last_run(&mut self) -> Result<Option<SystemTime>>;
    fn size_bytes(&mut self) -> Result<u64>;
    /// Reverse topological order (newest first), excluding the root operation.
    fn operations(&mut self) -> Result<Vec<Operation>>;
    fn abandon_ancestors(&mut self, newest_old: &str) -> Result<()>;
    fn gc(&mut self) -> Result<()>;
    /// Atomic fsync + rename + directory fsync. Failed gc never advances this.
    fn record_run(&mut self, now: SystemTime) -> Result<()>;
}
pub fn run(repo: &mut impl Repository, now: SystemTime) -> Result<bool> {
    if let Some(last) = repo.last_run()? {
        if now.duration_since(last).unwrap_or_default() < RETENTION
            && repo.size_bytes()? < SIZE_LIMIT
        {
            return Ok(false);
        }
    }
    let Some(cutoff) = now.checked_sub(RETENTION) else {
        return Ok(false);
    };
    let operations = repo.operations()?;
    // Keep the newest 100 even when all are expired. Retain newer ancestors
    // too: abandoning an ancestor range must never discard a recent operation.
    let keep = operations
        .iter()
        .rposition(|op| op.ended >= cutoff)
        .map_or(KEEP_NEWEST, |i| KEEP_NEWEST.max(i + 1));
    if let Some(old) = operations.get(keep) {
        repo.abandon_ancestors(&old.id)?;
    }
    repo.gc()?;
    repo.record_run(now)?;
    Ok(true)
}
