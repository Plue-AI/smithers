// Standalone unit harness until the owning daemon crate lands. This does not
// execute the pending root/cgroup integration acceptance checks.
#[path = "../src/credit.rs"]
mod credit;
#[path = "../src/stream.rs"]
mod stream;
