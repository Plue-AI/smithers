//! Root-side session lifetime ownership. Transport admission belongs to the daemon.
#[cfg(target_os = "linux")]
pub mod cgroups;
pub mod sessions;

pub mod control;
pub mod lifecycle;
#[cfg(target_os = "linux")]
pub mod process;

pub mod request;

pub mod supervisor;

#[cfg(target_os = "linux")]
pub mod spawn;

#[cfg(target_os = "linux")]
pub mod process_identity;

#[cfg(all(test, target_os = "linux"))]
mod ssh_acceptance;
