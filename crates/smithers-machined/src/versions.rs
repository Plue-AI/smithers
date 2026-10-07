//! Per-file versions and parentless a/ + b/ trees. Object creation and refs use
//! the shared core provider, not a second git repository, capture or outbox.
use crate::burst::File;
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeMap, io};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version<B> {
    pub blob: B,
    pub post_digest: [u8; 32],
    pub mode: u32,
}
pub type Files<B> = BTreeMap<String, File<Version<B>>>;
pub trait Objects {
    type Blob: Clone + Eq;
    type Commit: Clone;
    fn blob(&mut self, bytes: &[u8]) -> io::Result<Self::Blob>;
    /// Build a parentless commit. Every key is a git tree path, not a disk path.
    fn parentless(
        &mut self,
        tree: &BTreeMap<String, (Self::Blob, u32)>,
    ) -> io::Result<Self::Commit>;
}
pub fn record<S: Objects>(store: &mut S, bytes: &[u8], mode: u32) -> io::Result<Version<S::Blob>> {
    if ![0o100644, 0o100755].contains(&mode) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(Version {
        blob: store.blob(bytes)?,
        post_digest: Sha256::digest(bytes).into(),
        mode,
    })
}
pub fn commit<S: Objects>(store: &mut S, files: &Files<S::Blob>) -> io::Result<S::Commit> {
    let mut tree = BTreeMap::new();
    for (path, file) in files {
        if !crate::ignore::relative(std::path::Path::new(path)) || path.contains('\0') {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        for (side, version) in [("a", &file.before), ("b", &file.after)] {
            if let Some(v) = version {
                tree.insert(format!("{side}/{path}"), (v.blob.clone(), v.mode));
            }
        }
    }
    store.parentless(&tree)
}
