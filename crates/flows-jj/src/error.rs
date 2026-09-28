//! Error type for the flows `Jj` ops and its classification onto the frozen
//! `JjErrorCode` set.
//!
//! The `code` values mirror `JjErrorCode` in `packages/jj/src/Jj.ts` minus
//! `not_installed`, which only the TypeScript side can produce (it means "no
//! wasm module was provided"). The codes are a STABLE public contract — they
//! round-trip through journals and step keys — so never repurpose one.

use jj_lib::working_copy::CheckoutError;
use serde::Serialize;
use thiserror::Error;

/// The subset of the frozen `JjErrorCode` set that the wasm side produces.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// A merge/tree conflict or a concurrent working-copy operation.
    Conflict,
    /// An unknown, malformed, ambiguous, or divergent revision.
    InvalidRef,
    /// Anything else.
    Unknown,
}

/// An operation failure carrying one of the frozen error codes.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct OpError {
    pub code: ErrorCode,
    pub message: String,
}

impl OpError {
    /// A `conflict` failure.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Conflict,
            message: message.into(),
        }
    }

    /// An `invalid_ref` failure.
    pub fn invalid_ref(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::InvalidRef,
            message: message.into(),
        }
    }

    /// An `unknown` failure.
    pub fn unknown(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Unknown,
            message: message.into(),
        }
    }

    /// An `unknown` failure formatted from an error and its source chain, so
    /// that the jj-lib detail (`NoSuchWorkspace`, errno text, ...) survives
    /// into the human-readable message.
    pub fn unknown_source(err: impl std::error::Error) -> Self {
        Self::unknown(error_chain(&err))
    }
}

/// Formats an error with its `source()` chain as `"a: b: c"`, the same shape
/// `jj` prints on stderr.
pub fn error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(err) = source {
        message.push_str(": ");
        message.push_str(&err.to_string());
        source = err.source();
    }
    message
}

impl From<CheckoutError> for OpError {
    fn from(err: CheckoutError) -> Self {
        match err {
            CheckoutError::ConcurrentCheckout => Self::conflict(error_chain(&err)),
            _ => Self::unknown_source(err),
        }
    }
}

/// Everything else maps to `unknown`: the remaining jj-lib error types carry
/// no signal that the frozen codes distinguish. `invalid_ref` is produced by
/// revision resolution and `conflict` by `CheckoutError` above.
macro_rules! impl_from_unknown {
    ($($ty:ty),* $(,)?) => {$(
        impl From<$ty> for OpError {
            fn from(err: $ty) -> Self {
                Self::unknown_source(err)
            }
        }
    )*};
}

impl_from_unknown!(
    jj_lib::backend::BackendError,
    jj_lib::config::ConfigGetError,
    jj_lib::config::ConfigLoadError,
    jj_lib::diff_presentation::unified::UnifiedDiffError,
    jj_lib::file_util::PathError,
    jj_lib::index::IndexError,
    jj_lib::op_store::OpStoreError,
    jj_lib::repo::EditCommitError,
    jj_lib::repo::RepoLoaderError,
    jj_lib::repo::RewriteRootCommit,
    jj_lib::transaction::TransactionCommitError,
    jj_lib::working_copy::SnapshotError,
    jj_lib::working_copy::WorkingCopyStateError,
    jj_lib::workspace::WorkspaceInitError,
    jj_lib::workspace::WorkspaceLoadError,
    jj_lib::workspace_store::WorkspaceStoreError,
    std::io::Error,
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[derive(Debug, thiserror::Error)]
    #[error("outer")]
    struct Outer {
        #[source]
        source: Middle,
    }

    #[derive(Debug, thiserror::Error)]
    #[error("middle")]
    struct Middle {
        #[source]
        source: io::Error,
    }

    #[test]
    fn constructors_preserve_code_message_and_display() {
        for (error, code, message) in [
            (OpError::conflict("busy"), ErrorCode::Conflict, "busy"),
            (
                OpError::invalid_ref("bad 雪"),
                ErrorCode::InvalidRef,
                "bad 雪",
            ),
            (
                OpError::unknown("disk failed"),
                ErrorCode::Unknown,
                "disk failed",
            ),
        ] {
            assert_eq!(error.code, code);
            assert_eq!(error.message, message);
            assert_eq!(error.to_string(), message);
        }
        assert_eq!(
            serde_json::to_string(&ErrorCode::Conflict).unwrap(),
            "\"conflict\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::InvalidRef).unwrap(),
            "\"invalid_ref\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::Unknown).unwrap(),
            "\"unknown\""
        );
    }

    #[test]
    fn source_chain_preserves_each_cause_in_order() {
        let outer = Outer {
            source: Middle {
                source: io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
            },
        };
        assert_eq!(error_chain(&outer), "outer: middle: denied");
        let op = OpError::unknown_source(outer);
        assert_eq!(op.code, ErrorCode::Unknown);
        assert_eq!(op.message, "outer: middle: denied");
    }

    #[test]
    fn checkout_classifies_concurrency_and_other_failures() {
        let concurrent = OpError::from(CheckoutError::ConcurrentCheckout);
        assert_eq!(concurrent.code, ErrorCode::Conflict);
        assert_eq!(concurrent.message, "Concurrent checkout");

        let missing = OpError::from(CheckoutError::SourceNotFound {
            source: Box::new(io::Error::new(io::ErrorKind::NotFound, "gone")),
        });
        assert_eq!(missing.code, ErrorCode::Unknown);
        assert_eq!(
            missing.message,
            "Current working-copy commit not found: gone"
        );

        let io_error = OpError::from(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
        assert_eq!(io_error.code, ErrorCode::Unknown);
        assert_eq!(io_error.message, "denied");
    }
}
