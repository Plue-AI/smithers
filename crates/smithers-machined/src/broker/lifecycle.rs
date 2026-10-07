//! Restart sequencing. Cleanup is a barrier, never a best-effort side effect:
//! a daemon cannot be replaced while any old session descendant is alive.
use crate::link::Backoff;
use std::{io, time::Duration};
pub trait Process {
    fn kill_sessions(&mut self) -> io::Result<()>;
    /// Start only the trusted installed daemon, then serve its socketpair and
    /// wait for exit. The duration is observed uptime, never caller-supplied.
    fn run_daemon(&mut self) -> io::Result<(i32, Duration)>;
    fn delay(&mut self, duration: Duration);
}
pub fn supervise(process: &mut impl Process) -> io::Result<()> {
    let mut backoff = Backoff::default();
    loop {
        process.kill_sessions()?;
        let (status, uptime) = process.run_daemon()?;
        // Even permanent startup failure cleans up descendants before exit.
        process.kill_sessions()?;
        if status == 78 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "daemon configuration unavailable",
            ));
        }
        if uptime >= Duration::from_secs(60) {
            backoff.reset();
        }
        process.delay(backoff.delay());
    }
}
