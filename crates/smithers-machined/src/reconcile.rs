//! Wake reconciliation seam; no head moves until A5 supplies the implementation.
use crate::{lock::LockCx, msg::*};
pub fn wake_reconcile(_: &mut LockCx<'_>, _: Oid) -> Result<Reconciled, Error> {
    Err(Error::unsupported())
}
