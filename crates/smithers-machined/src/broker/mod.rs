//! Root-side session lifetime ownership. Transport admission belongs to the daemon.
#[cfg(target_os = "linux")]
pub mod cgroups;
pub mod sessions;

pub mod control;
pub mod lifecycle;
#[cfg(target_os = "linux")]
pub mod process;
