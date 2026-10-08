//! Stable discriminants used by hook implementations; the sole codec is conn.
pub use crate::hooks::{Actor, Base, Digest, Error, Oid};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Method {
    Status = 1,
    ReadFile,
    WriteFile,
    Capture,
    WakeReconcile,
    OpenSession,
    TcpConnect,
    CloseSession,
    KillSessions,
    RegisterRun,
    Rebase,
    ReturnToItem,
    OpenDoc,
    CloseDoc,
    AttachSession,
    SetRoster,
    WriteFiles,
    InspectConflict,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ErrorCode {
    Malformed = 1,
    Unsupported,
    NotReady,
    Stale,
    NotFound,
    InvalidPath,
    NotRegular,
    TooLarge,
    Busy,
    MovedOff,
    Unauthorized,
    Internal,
}
