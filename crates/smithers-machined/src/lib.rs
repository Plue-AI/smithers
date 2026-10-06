//! Guest machine components. Admission and startup must supply authenticated
//! transport and trusted provisioning before mounting privileged operations.
pub mod broker;
pub mod burst;
pub mod credit;
pub mod doc;
pub mod outbox_store;
pub mod stream;

pub mod attrib;
pub mod ignore;
#[cfg(target_os = "linux")]
pub mod watch;
