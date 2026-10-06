//! Guest machine components and the shared ADR 0004 contract.
//! Admission and trusted startup remain required before privileged composition.
pub mod broker;
pub mod burst;
pub mod conn;
pub mod credit;
pub mod doc;
pub mod hooks;
pub mod lock;
pub mod msg;
pub mod outbox_store;
pub mod outbox;
pub mod objects;
pub mod rpc;
pub mod stream;

pub mod attrib;
pub mod events;
pub mod ignore;
#[cfg(target_os = "linux")]
pub mod resync;
pub mod session;
pub mod versions;
#[cfg(target_os = "linux")]
pub mod watch;
pub mod freeze;
