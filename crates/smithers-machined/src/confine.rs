//! The shared working-copy descriptor boundary for files and live documents.
//! Every open is kernel-confined; nonregular files are rejected without waiting.
use rustix::fs::{self, Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};
pub const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
pub fn open(parent: &File, name: &str, flags: OFlags, mode: Mode) -> io::Result<File> {
    Ok(fs::openat2(
        parent,
        name,
        flags | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOFOLLOW,
        mode,
        RESOLVE,
    )?
    .into())
}
pub fn parent(workspace: &File, path: &str) -> io::Result<(File, String)> {
    if !crate::doc::disk::valid_path(path) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let (directory, name) = path.rsplit_once('/').unwrap_or((".", path));
    Ok((
        fs::openat2(
            workspace,
            directory,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            RESOLVE,
        )?
        .into(),
        name.into(),
    ))
}
pub fn regular(file: &File) -> io::Result<()> {
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}
pub fn read(file: &mut File, limit: usize) -> io::Result<Vec<u8>> {
    regular(file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}
