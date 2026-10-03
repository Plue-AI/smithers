//! Objects-only import seam; durable guest spooling belongs to A3.
use crate::{lock::LockCx, msg::Error};
pub fn import(_: &mut LockCx<'_>, _: &[u8]) -> Result<(), Error> {
    Err(Error::unsupported())
}
