//! Rewrite barrier seam; guest freeze orchestration belongs to A5.
use crate::{lock::LockCx, msg::*};
pub fn freeze_then<T>(
    _: &mut LockCx<'_>,
    _: &Actor,
    _: impl FnOnce(&mut LockCx<'_>) -> Result<T, Error>,
) -> Result<T, Error> {
    Err(Error::unsupported())
}
