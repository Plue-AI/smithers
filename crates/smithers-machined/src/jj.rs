//! Typed VCS seam. The dark skeleton never executes repository commands.
//! The production jj/git runner is activated with the core daemon in T-COL-03a.
use crate::msg::Error;
use std::path::PathBuf;
pub struct Vcs {
    pub root: PathBuf,
}
impl Vcs {
    pub fn run(&self, _program: &str, _args: &[&str]) -> Result<Vec<u8>, Error> {
        Err(Error::unsupported())
    }
}
