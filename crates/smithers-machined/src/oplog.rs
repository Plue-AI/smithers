//! Retention seam; no operation is abandoned before A5 lands.
use crate::{lock::LockCx, msg::Error};
pub fn run(_: &mut LockCx<'_>) -> Result<(), Error> {
    Err(Error::unsupported())
}
