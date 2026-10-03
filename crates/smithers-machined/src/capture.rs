//! Local capture seam; snapshot/outbox durability belongs to A3.
use crate::{lock::LockCx, msg::*};
pub fn capture_local(_: &mut LockCx<'_>) -> Result<Captured, Error> {
    Err(Error::unsupported())
}
