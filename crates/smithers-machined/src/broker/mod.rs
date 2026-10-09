//! Root-side session lifetime ownership. Transport admission belongs to the daemon.
#[cfg(target_os = "linux")]
pub mod cgroups;
pub mod sessions;

pub mod control;
#[cfg(target_os = "linux")]
pub mod daemon_log;
pub mod lifecycle;
#[cfg(target_os = "linux")]
pub mod process;

pub mod request;

pub mod supervisor;

#[cfg(target_os = "linux")]
pub mod spawn;

#[cfg(target_os = "linux")]
pub mod process_identity;

#[cfg(target_os = "linux")]
pub mod transcripts;

#[cfg(all(
    target_os = "linux",
    any(test, all(feature = "testing", debug_assertions))
))]
mod ssh_acceptance;
