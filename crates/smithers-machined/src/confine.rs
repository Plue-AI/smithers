//! Workspace seam; descriptor confinement is supplied by T-COL-03a A2.
use crate::msg::Error;
use std::path::{Path, PathBuf};
pub struct Workspace {
    root: PathBuf,
}
impl Workspace {
    pub fn open(_: impl AsRef<Path>) -> Result<Self, Error> {
        Err(Error::unsupported())
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    #[cfg(any(test, feature = "testing"))]
    pub fn fixture(root: PathBuf) -> Self {
        Self { root }
    }
}
