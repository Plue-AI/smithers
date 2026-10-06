// Dependency-free component harness while T-COL-03r owns the crate skeleton.
// Run: rustc --edition 2024 --test crates/smithers-machined/tests/outbox_component.rs
//      -o /tmp/fr-t-col-03a-outbox-tests && /tmp/fr-t-col-03a-outbox-tests
// This is not production RPC, broker, Linux syncfs, or VM acceptance evidence.
#[path = "../src/credit.rs"]
pub mod credit;
#[path = "../src/objects.rs"]
pub mod objects;
#[path = "../src/outbox.rs"]
pub mod outbox;
#[path = "../src/outbox_store.rs"]
pub mod outbox_store;
#[path = "../src/stream.rs"]
pub mod stream;
