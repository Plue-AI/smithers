//! A completed native wake is rolled forward, never restored behind its event
//! or acknowledged head. The identity is persisted before either side effect.
use crate::hooks::Oid;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settlement {
    version: u8,
    pub event_id: [u8; 16],
    pub old: Oid,
    pub head: Oid,
    pub result: Oid,
}
impl Settlement {
    pub fn new(old: Oid, head: Oid, result: Oid) -> io::Result<Self> {
        let mut event_id = [0; 16];
        getrandom::fill(&mut event_id).map_err(|e| io::Error::other(e.to_string()))?;
        let value = Self {
            version: 1,
            event_id,
            old,
            head,
            result,
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> io::Result<()> {
        if self.version != 1
            || self.event_id == [0; 16]
            || self.old == self.head
            || [self.old, self.head, self.result].contains(&[0; 20])
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    }
}
pub(crate) struct Journal(PathBuf);
impl Journal {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let meta = fs::symlink_metadata(directory)?;
        if !meta.is_dir()
            || meta.uid() != rustix::process::geteuid().as_raw()
            || meta.mode() & 0o7777 != 0o700
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(Self(directory.into()))
    }
    fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        let file = match rustix::fs::open(
            self.0.join(name),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let meta = file.metadata()?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != rustix::process::geteuid().as_raw()
            || meta.mode() & 0o7777 != 0o600
            || meta.len() > 1024
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = vec![];
        file.take(1025).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Some(bytes))
    }
    pub fn pending(&self) -> io::Result<Option<Settlement>> {
        self.read("wake.settlement")?
            .map(|bytes| {
                let value: Settlement = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                value.validate()?;
                Ok(value)
            })
            .transpose()
    }
    fn remove(&self, name: &str) -> io::Result<()> {
        if self.read(name)?.is_some() {
            fs::remove_file(self.0.join(name))?;
        }
        Ok(())
    }
    pub fn save(&self, value: &Settlement) -> io::Result<()> {
        value.validate()?;
        if self.pending()?.is_some() {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        // A pre-rename temporary file has published no event or acknowledgement.
        // It can be discarded after the ordinary native checkpoint restores.
        self.remove("wake.settlement.tmp")?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.0.join("wake.settlement.tmp"))?;
        file.write_all(&serde_json::to_vec(value).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(
            self.0.join("wake.settlement.tmp"),
            self.0.join("wake.settlement"),
        )?;
        File::open(&self.0)?.sync_all()
    }
    pub fn clear(&self) -> io::Result<()> {
        // Malformed authority is never silently discarded.
        self.pending()?;
        self.remove("wake.settlement.tmp")?;
        self.remove("wake.settlement")?;
        File::open(&self.0)?.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, Journal, Settlement) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let value = Settlement::new([1; 20], [2; 20], [3; 20]).unwrap();
        (dir, journal, value)
    }
    fn private(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }
    #[test]
    fn settlement_reopens_without_replacing_identity_and_cleans_partial_prepare() {
        let (dir, journal, value) = fixture();
        private(&dir.path().join("wake.settlement.tmp"), b"{interrupted");
        journal.save(&value).unwrap();
        assert_eq!(
            Journal::open(dir.path()).unwrap().pending().unwrap(),
            Some(value.clone())
        );
        assert!(journal
            .save(&Settlement::new([4; 20], [5; 20], [6; 20]).unwrap())
            .is_err());
        assert_eq!(journal.pending().unwrap(), Some(value));
        journal.clear().unwrap();
        journal.clear().unwrap();
        assert_eq!(journal.pending().unwrap(), None);
        assert!(!dir.path().join("wake.settlement.tmp").exists());
    }
    #[test]
    fn malformed_or_untrusted_settlement_is_never_discarded() {
        for case in [
            "json",
            "large",
            "version",
            "unknown",
            "zero",
            "equal",
            "mode",
            "symlink",
            "hardlink",
            "directory",
        ] {
            let (dir, journal, value) = fixture();
            let file = dir.path().join("wake.settlement");
            let mut json = serde_json::to_value(&value).unwrap();
            match case {
                "version" => json["version"] = 2.into(),
                "unknown" => json["extra"] = true.into(),
                "zero" => json["event_id"] = serde_json::to_value([0u8; 16]).unwrap(),
                "equal" => json["head"] = json["old"].clone(),
                _ => (),
            }
            let raw = match case {
                "json" => b"{".to_vec(),
                "large" => vec![b'x'; 1025],
                _ => serde_json::to_vec(&json).unwrap(),
            };
            match case {
                "symlink" => {
                    private(&dir.path().join("target"), &raw);
                    symlink("target", &file).unwrap();
                }
                "directory" => fs::create_dir(&file).unwrap(),
                _ => private(&file, &raw),
            }
            if case == "mode" {
                fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
            }
            if case == "hardlink" {
                fs::hard_link(&file, dir.path().join("link")).unwrap();
            }
            assert!(journal.pending().is_err(), "{case}");
            assert!(journal.clear().is_err(), "{case}");
            assert!(fs::symlink_metadata(&file).is_ok(), "{case}");
        }
    }
    #[test]
    fn untrusted_temporary_entry_cannot_replace_a_record() {
        let (dir, journal, value) = fixture();
        private(&dir.path().join("target"), b"keep");
        symlink("target", dir.path().join("wake.settlement.tmp")).unwrap();
        assert!(journal.save(&value).is_err());
        assert_eq!(fs::read(dir.path().join("target")).unwrap(), b"keep");
        assert_eq!(journal.pending().unwrap(), None);
    }
}
