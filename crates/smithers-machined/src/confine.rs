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

/// Probe the required kernel primitives as machined, never as the root broker.
/// Probe files are exclusive, daemon-named and removed on every normal exit.
pub fn probe(workspace: &File) -> io::Result<()> {
    use rustix::fs::{AtFlags, RenameFlags};
    if rustix::process::geteuid().as_raw() != 19998 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| io::Error::other("random source unavailable"))?;
    let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let first = format!(".smithers-probe-{nonce}-a");
    let second = format!(".smithers-probe-{nonce}-b");
    let a = open(
        workspace,
        &first,
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o600),
    )?;
    let mut created_b = false;
    let result = (|| {
        let b = open(
            workspace,
            &second,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o600),
        )?;
        created_b = true;
        a.sync_all()?;
        b.sync_all()?;
        fs::renameat_with(workspace, &first, workspace, &second, RenameFlags::EXCHANGE)?;
        workspace.sync_all()
    })();
    let clean_a = fs::unlinkat(workspace, &first, AtFlags::empty());
    let clean_b = if created_b {
        fs::unlinkat(workspace, &second, AtFlags::empty())
    } else {
        Ok(())
    };
    result?;
    clean_a?;
    clean_b?;
    workspace.sync_all()
}
