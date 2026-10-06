//! Durable admission barrier. The core retains the native operation checkpoint;
//! this record prevents a restarted lock from accepting a half-applied tree.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
pub struct Journal {
    directory: PathBuf,
}
impl Journal {
    pub fn open(directory: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(Self {
            directory: directory.into(),
        })
    }
    pub fn pending(&self) -> io::Result<bool> {
        let path = self.directory.join("rewrite.pending");
        let file = match rustix::fs::open(
            &path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o600
            || metadata.len() != 1
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = vec![];
        file.take(2).read_to_end(&mut bytes)?;
        if bytes != b"1" {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(true)
    }
    pub fn begin(&self) -> io::Result<()> {
        // An incomplete marker refuses restart admission too. Never truncate
        // an earlier checkpoint or follow a branch-controlled path entry.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.directory.join("rewrite.pending"))?;
        file.write_all(b"1")?;
        file.sync_all()?;
        File::open(&self.directory)?.sync_all()
    }
    pub fn settled(&self) -> io::Result<()> {
        fs::remove_file(self.directory.join("rewrite.pending"))?;
        File::open(&self.directory)?.sync_all()
    }
}
