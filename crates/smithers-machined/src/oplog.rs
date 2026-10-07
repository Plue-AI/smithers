//! Weekly retention; the repository provider preserves all pending Git refs.
use crate::hooks::Result;
use std::time::{Duration, SystemTime};
pub const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub struct Operation {
    pub id: String,
    pub ended: SystemTime,
}
pub trait Repository {
    fn last_run(&mut self) -> Result<Option<SystemTime>>;
    fn operations(&mut self) -> Result<Vec<Operation>>;
    fn abandon_ancestors(&mut self, newest_old: &str) -> Result<()>;
    fn gc(&mut self) -> Result<()>;
    /// Atomic fsync + rename + directory fsync. Failed gc never advances this.
    fn record_run(&mut self, now: SystemTime) -> Result<()>;
}
pub fn run(repo: &mut impl Repository, now: SystemTime) -> Result<bool> {
    if let Some(last) = repo.last_run()? {
        if now.duration_since(last).unwrap_or_default() < RETENTION {
            return Ok(false);
        }
    }
    let Some(cutoff) = now.checked_sub(RETENTION) else {
        return Ok(false);
    };
    if let Some(old) = repo
        .operations()?
        .into_iter()
        .filter(|op| op.ended < cutoff)
        .max_by_key(|op| op.ended)
    {
        repo.abandon_ancestors(&old.id)?;
    }
    repo.gc()?;
    repo.record_run(now)?;
    Ok(true)
}
