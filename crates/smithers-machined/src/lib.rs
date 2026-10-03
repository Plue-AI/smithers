//! Machine daemon contracts and dark component seams (ADR 0004).
pub mod broker;
pub mod brokerproto;
pub mod capture;
pub mod client;
pub mod confine;
pub mod conn;
pub mod daemon;
pub mod files;
pub mod freeze;
pub mod hooks;
pub mod jj;
pub mod killpoint;
pub mod link;
pub mod local;
pub mod lock;
pub mod msg;
pub mod objects;
pub mod oplog;
pub mod outbox;
pub mod reconcile;
pub mod rpc;
pub mod stream;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
pub mod wiring;
