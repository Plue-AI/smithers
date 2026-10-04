//! Unmounted document adapters. Production activation belongs to T-COL-08.
//! Existing wiki serialization has no save cadence, durable records or disk merge.
pub mod authors;
#[path = "../../../smithers-ffi/src/document_core.rs"]
pub mod core;
pub mod disk;
pub mod gone;
pub mod host;
pub mod merge;
pub mod reconcile;
pub mod state;

pub const MAX_TEXT_BYTES: usize = 1 << 20;
pub const MAX_STATE_BYTES: usize = 8 << 20;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Unsupported,
    Invalid,
    Forged,
    Epoch,
    Stale,
    ReadOnly,
    Gone,
    Io(String),
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
