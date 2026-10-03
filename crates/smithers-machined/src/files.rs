//! Typed file seams; descriptor confinement and atomic writes belong to A2.
use crate::{lock::LockCx, msg::*};
pub fn read_file(_: &LockCx<'_>, _: &ReadFile) -> Result<FileContent, Error> {
    Err(Error::unsupported())
}
pub fn write_file(_: &mut LockCx<'_>, _: &WriteFile) -> Result<Written, Error> {
    Err(Error::unsupported())
}
