//! Filesystem seam for the existing descriptor-confined Workspace and mutation lock.
//! No host paths, privileged fallback or production fixture implementation.
use super::{
    state::{Digest, Record},
    Result,
};

/// A token names an open displaced inode, never an RPC-controlled pathname.
pub type Displaced = u64;
pub struct Recovery {
    pub token: Displaced,
    pub record: Record,
}

/// Calls which mutate disk must run inside T-COL-03r's LockCx job. The adapter
/// is supplied by production confinement; absence refuses before any open.
pub trait Disk: Send {
    /// openat2 BENEATH|NO_MAGICLINKS|NO_XDEV, O_NONBLOCK, regular-file fstat.
    /// Return at most 1 MiB + 1; binary/oversize opens are read-only.
    fn read(&mut self, path: &str) -> Result<Option<Vec<u8>>>;
    /// Only a missing/unreadable record returns None, never a workspace read error.
    fn load_record(&mut self, key: Digest) -> Result<Option<Record>>;
    /// Daemon-controlled store dirfd: exclusive temp, fsync, rename, dir fsync.
    fn store_record(&mut self, key: Digest, record: &Record) -> Result<()>;
    /// .smithers-doc-<digest>-<random>, preserve mode/group; fsync, exchange
    /// (NOREPLACE if absent), directory fsync. Retain displaced inode open.
    /// Owner is the executing machined uid, never chown to a privileged uid.
    fn swap_text(&mut self, path: &str, key: Digest, text: &[u8]) -> Result<Option<Displaced>>;
    /// Leftover temps survive restart and are returned as retained open inodes.
    fn recover_temps(&mut self, path: &str, key: Digest) -> Result<Vec<Recovery>>;
    fn read_displaced(&mut self, token: Displaced) -> Result<Vec<u8>>;
    /// Unlink only after unchanged digest or durable outside-version receipt.
    fn remove_displaced(&mut self, token: Displaced) -> Result<()>;
    /// Persist exact outside bytes as this burst's after version before deletion.
    fn record_outside(&mut self, path: &str, text: &[u8], actor: &str) -> Result<String>;
    /// Exclude watcher events by path and post-write digest, never inotify pid.
    fn own_write(&mut self, path: &str, post_digest: Digest);
}

/// Lexical validation supplements, never replaces, descriptor confinement.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{LinuxDisk, Versions};
