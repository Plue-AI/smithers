//! Private watcher recovery data. Restoring goes through the existing burst and
//! checkpoint validators; malformed files never select an empty checkpoint.
use crate::{
    burst::{Burst, Bursts, Key},
    events::Checkpoint,
    hooks::{Actor, Oid},
    versions::{Objects, Version},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 64 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    pin: Oid,
    recorded: BTreeMap<String, Version<Oid>>,
    bursts: Vec<Burst<Actor, Version<Oid>>>,
    identities: Vec<(Key<Actor>, [u8; 16])>,
    renames: BTreeMap<String, String>,
}
fn invalid(e: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}
pub struct Store {
    directory: PathBuf,
    owner: u32,
}
impl Store {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let owner = rustix::process::geteuid().as_raw();
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.uid() != owner || metadata.mode() & 0o7777 != 0o700 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(Self {
            directory: directory.into(),
            owner,
        })
    }
    fn stored(&self) -> io::Result<Option<Stored>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(
                rustix::fs::OFlags::NOFOLLOW.bits() as i32
                    | rustix::fs::OFlags::NONBLOCK.bits() as i32,
            )
            .open(self.directory.join("watcher.json"))
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let m = file.metadata()?;
        if !m.is_file()
            || m.nlink() != 1
            || m.uid() != self.owner
            || m.mode() & 0o7777 != 0o600
            || m.len() > LIMIT
        {
            return Err(invalid("unsafe watcher checkpoint"));
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("watcher checkpoint too large"));
        }
        let stored: Stored = serde_json::from_slice(&bytes).map_err(invalid)?;
        if stored.version != 1 {
            return Err(invalid("unsupported watcher checkpoint"));
        }
        Ok(Some(stored))
    }
    fn restore(stored: Stored) -> io::Result<Checkpoint<Actor, Oid>> {
        let versions = stored
            .recorded
            .values()
            .chain(stored.bursts.iter().flat_map(|b| {
                b.files
                    .values()
                    .flat_map(|f| f.before.iter().chain(f.after.iter()))
            }));
        if versions
            .into_iter()
            .any(|v| ![0o100644, 0o100755].contains(&v.mode))
        {
            return Err(invalid("invalid version mode"));
        }
        let now = stored.bursts.iter().map(|b| b.last_ms).max().unwrap_or(0);
        let bursts = Bursts::restore(stored.bursts, now).map_err(invalid)?;
        Checkpoint::restore(stored.recorded, bursts, stored.identities, stored.renames)
    }
    pub fn load(&self) -> io::Result<Checkpoint<Actor, Oid>> {
        self.stored()?
            .map(Self::restore)
            .transpose()
            .map(|checkpoint| checkpoint.unwrap_or_default())
    }
    pub fn save(
        &self,
        state: &Checkpoint<Actor, Oid>,
        repository: &mut crate::git::Repository,
    ) -> io::Result<()> {
        let previous = self.stored()?;
        // Validate the current disk checkpoint before replacing any refs.
        if let Some(previous) = &previous {
            Self::restore(Stored {
                version: previous.version,
                pin: previous.pin,
                recorded: previous.recorded.clone(),
                bursts: previous.bursts.clone(),
                identities: previous.identities.clone(),
                renames: previous.renames.clone(),
            })?;
        }
        // Refuse invalid new state before the first repository or disk write.
        Self::restore(Stored {
            version: 1,
            pin: [0; 20],
            recorded: state.recorded.clone(),
            bursts: state.bursts.pending().to_vec(),
            identities: state.identities(),
            renames: state.renames().clone(),
        })?;
        let mut tree = BTreeMap::new();
        for v in state
            .recorded
            .values()
            .chain(state.bursts.pending().iter().flat_map(|b| {
                b.files
                    .values()
                    .flat_map(|f| f.before.iter().chain(f.after.iter()))
            }))
        {
            let name: String = v.blob.iter().map(|b| format!("{b:02x}")).collect();
            tree.insert(name, (v.blob, 0o100644));
        }
        let pin = repository.parentless(&tree)?;
        repository.retain_checkpoint(pin, previous.as_ref().map(|s| s.pin))?;
        let stored = Stored {
            version: 1,
            pin,
            recorded: state.recorded.clone(),
            bursts: state.bursts.pending().to_vec(),
            identities: state.identities(),
            renames: state.renames().clone(),
        };
        Self::restore(Stored {
            version: 1,
            pin,
            recorded: stored.recorded.clone(),
            bursts: stored.bursts.clone(),
            identities: stored.identities.clone(),
            renames: stored.renames.clone(),
        })?;
        let bytes = serde_json::to_vec(&stored).map_err(invalid)?;
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("watcher checkpoint too large"));
        }
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(invalid)?;
        let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = self.directory.join(format!(".watcher-{name}"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&path, self.directory.join("watcher.json"))?;
            File::open(&self.directory)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&path);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, Store) {
        let d = tempfile::tempdir().unwrap();
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let s = Store::open(d.path()).unwrap();
        (d, s)
    }
    fn write(s: &Store, data: &[u8]) {
        let path = s.directory.join("watcher.json");
        fs::write(&path, data).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn missing_checkpoint_is_empty_but_corruption_and_foreign_versions_refuse() {
        let (_d, s) = fixture();
        assert!(s.load().unwrap().recorded.is_empty());
        write(&s, b"broken");
        assert!(s.load().is_err());
        let mut state = Stored {
            version: 1,
            pin: [0; 20],
            recorded: BTreeMap::new(),
            bursts: vec![],
            identities: vec![],
            renames: BTreeMap::new(),
        };
        state.recorded.insert(
            "../escape".into(),
            Version {
                blob: [1; 20],
                post_digest: [2; 32],
                mode: 0o100644,
            },
        );
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert!(s.load().is_err());
        state.recorded.clear();
        state.recorded.insert(
            "file".into(),
            Version {
                blob: [1; 20],
                post_digest: [2; 32],
                mode: 0o100644,
            },
        );
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert_eq!(s.load().unwrap().recorded["file"].blob, [1; 20]);
        state.recorded.get_mut("file").unwrap().mode = 0o1004755;
        write(&s, &serde_json::to_vec(&state).unwrap());
        assert!(s.load().is_err());
    }
    #[test]
    fn symlinks_hardlinks_and_shared_modes_never_reset_history() {
        for kind in ["symlink", "hardlink", "mode"] {
            let (_d, s) = fixture();
            let target = s.directory.join("target");
            fs::write(&target, b"keep").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
            let path = s.directory.join("watcher.json");
            match kind {
                "symlink" => std::os::unix::fs::symlink(&target, &path).unwrap(),
                "hardlink" => fs::hard_link(&target, &path).unwrap(),
                _ => {
                    fs::write(&path, b"{}").unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                }
            }
            assert!(s.load().is_err());
            assert_eq!(fs::read(&target).unwrap(), b"keep");
        }
    }
}
