//! Dark seam for T-COL-03a; no side effect is admitted before its owner lands.
use crate::msg::Error;
pub fn run() -> Result<(), Error> {
    Err(Error::unsupported())
}
